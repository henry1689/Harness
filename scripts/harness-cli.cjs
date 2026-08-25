#!/usr/bin/env node
/**
 * harness-cli.cjs — Harness 单一 CLI 通讯入口（v2.11）
 * ======================================================================
 * 不经 Claude Code 对话，直接命令行与 harness 交互，节省 token。
 * 子命令全部复用现有模块/脚本，不重复实现。
 *
 * 用法:
 *   node scripts/harness-cli.cjs status                    # 防线状态
 *   node scripts/harness-cli.cjs exempt list               # 豁免列表
 *   node scripts/harness-cli.cjs exempt add <file> --project <根> --minutes N --reason "..." [--ops a,b] [--relaxed a,b]  # 豁免签发(走密码)
 *   node scripts/harness-cli.cjs unlock status|lock        # harness 自身解锁状态/锁定
 *   node scripts/harness-cli.cjs token verify <file> --project <根>  # token 校验
 *   node scripts/harness-cli.cjs token list                # token 列表
 *   node scripts/harness-cli.cjs check <files...> --project <根> [--stage S4]  # CK 流水线检查
 *   node scripts/harness-cli.cjs dist-verify <path> --project <根>   # dist 校验
 *   node scripts/harness-cli.cjs gate                      # commit 前检查(spawn harness-gate)
 *   node scripts/harness-cli.cjs webui start|stop          # wenstar-cc webui
 *   node scripts/harness-cli.cjs pm2 <start|restart|stop|status> [app]  # harness PM2 操作
 *   node scripts/harness-cli.cjs help
 *
 * 密码安全: exempt add 需 --password（用户输入或 env HARNESS_PASS），不硬编码。
 * 输出: 人读(默认) + --json(脚本友好)。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync, execSync } = require('child_process');

const HARNESS_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(HARNESS_DIR, 'data');
const WENSTAR_CC = process.env.WENSTAR_CC_ROOT || 'D:/tools/wenstar-cc';
const DASHBOARD_PORT = process.env.HARNESS_DASHBOARD_PORT || '8766';

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');

// ════════════════════════════════════════════════════════════════════
// 工具
// ════════════════════════════════════════════════════════════════════

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}
function getFlag(name) { return args.includes(name); }
function print(obj, fallback) {
  if (JSON_OUT) { console.log(JSON.stringify(obj, null, 2)); }
  else if (typeof fallback === 'string') console.log(fallback);
  else console.log(obj);
}
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return null; }
}
function fileAge(file) {
  try { return (Date.now() - fs.statSync(path.join(DATA_DIR, file)).mtimeMs) / 1000; } catch (_) { return Infinity; }
}
function run(cmd, cwd, argsArr, timeoutMs) {
  const r = spawnSync(cmd, argsArr, { cwd, encoding: 'utf-8', timeout: timeoutMs || 60000, shell: false });
  return r;
}

// ════════════════════════════════════════════════════════════════════
// 子命令: status
// ════════════════════════════════════════════════════════════════════

function cmdStatus() {
  // 优先 dashboard API（HTTP，不能 require）
  try {
    const body = JSON.parse(httpGet(`http://127.0.0.1:${DASHBOARD_PORT}/api/status`));
    print(body, 'status: 看板 API');
    return;
  } catch (_) { /* 看板未起，退化读心跳 */ }

  const links = [
    { name: 'MCP', file: 'heartbeat.json', timeout: 120 },
    { name: 'Sentinel', file: 'sentinel-heartbeat.json', timeout: 90 },
    { name: 'Hook', file: 'hook-heartbeat.json', timeout: 1200 },
    { name: 'Watchdog', file: 'watchdog-heartbeat.json', timeout: 120 },
  ];
  const result = {};
  for (const l of links) {
    const age = fileAge(l.file);
    result[l.name] = { age: Math.round(age), status: age <= l.timeout ? 'online' : (age === Infinity ? 'missing' : 'stale') };
  }
  const tokenCount = fs.existsSync(path.join(DATA_DIR, 'tokens')) ? fs.readdirSync(path.join(DATA_DIR, 'tokens')).filter(f => f.endsWith('.json')).length : 0;
  result.tokens = tokenCount;
  result.exemptions = (() => {
    const ec = require('./exemptions-core.cjs');
    const map = ec.loadExemptions();
    const out = [];
    for (const [k, rec] of map) out.push({ file: k, expires_at: ec.getExpiry(rec), reason: rec.reason || '' });
    return out;
  })();
  print(result, `MCP:${result.MCP.status} | Sentinel:${result.Sentinel.status} | Hook:${result.Hook.status} | Watchdog:${result.Watchdog.status} | tokens:${tokenCount} | 豁免:${result.exemptions.length}`);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ════════════════════════════════════════════════════════════════════
// 子命令: exempt
// ════════════════════════════════════════════════════════════════════

function cmdExempt() {
  const ec = require('./exemptions-core.cjs');
  const sub = args[1];

  if (sub === 'list') {
    const map = ec.loadExemptions();
    const list = [];
    for (const [k, rec] of map) list.push({ file: k, expires_at: ec.getExpiry(rec), reason: rec.reason || '' });
    print({ count: list.length, exemptions: list }, list.length === 0 ? '无豁免' : list.map(x => `${x.file} | 至 ${new Date(x.expires_at).toLocaleTimeString('zh-CN')} | ${x.reason || ''}`).join('\n'));
    return;
  }

  if (sub === 'add') {
    const file = args[2];
    const project = getArg('--project') || WENSTAR_CC;
    const minutes = parseInt(getArg('--minutes') || '30', 10) || 30;
    const reason = getArg('--reason') || '';
    const ops = (getArg('--ops') || '').split(',').map(s => s.trim()).filter(Boolean);
    const relaxed = (getArg('--relaxed') || '').split(',').map(s => s.trim()).filter(Boolean);
    const password = getArg('--password') || process.env.HARNESS_PASS || '';

    if (!file || !reason) {
      console.error('❌ 用法: exempt add <file> --project <根> --minutes N --reason "..." [--ops a,b] [--relaxed a,b] --password <密码>');
      process.exit(1);
    }
    if (!password) {
      console.error('❌ 需 --password（走密码门校验，防 Agent 自行豁免）');
      process.exit(1);
    }
    // 走 sentinel --unlock 密码门（校验 verifyPassword）
    const r = run('node', HARNESS_DIR, ['sentinel/sentinel-service.cjs', '--project', project, '--unlock', file, '--minutes', String(minutes), '--password', password, '--reason', reason, ...(ops.length ? ['--ops', ops.join(',')] : []), ...(relaxed.length ? ['--relaxed', relaxed.join(',')] : [])], 30000);
    console.log(r.stdout || r.stderr || '');
    process.exit(r.status === 0 ? 0 : 1);
  }

  console.error('❌ exempt 用法: list | add');
  process.exit(1);
}

// ════════════════════════════════════════════════════════════════════
// 子命令: unlock
// ════════════════════════════════════════════════════════════════════

function cmdUnlock() {
  const hu = require('./harness-unlock.cjs');
  const sub = args[1];
  if (sub === 'status') {
    const st = hu.checkUnlockStatus();
    print(st, st && st.unlocked ? `✅ 已解锁 至 ${new Date(st.expires_at).toLocaleTimeString('zh-CN')}` : '🔒 未解锁');
  } else if (sub === 'lock') {
    hu.lockNow();
    console.log('✅ 已锁定');
  } else {
    console.error('❌ unlock 用法: status | lock');
    process.exit(1);
  }
}

// ════════════════════════════════════════════════════════════════════
// 子命令: token
// ════════════════════════════════════════════════════════════════════

function loadTokenSecret() {
  // token-verify 只读 env HARNESS_TOKEN_SECRET——从 data/.harness-secret 加载
  if (!process.env.HARNESS_TOKEN_SECRET) {
    try {
      const s = fs.readFileSync(path.join(DATA_DIR, '.harness-secret'), 'utf-8').trim();
      if (s && s.length >= 32) process.env.HARNESS_TOKEN_SECRET = s;
    } catch (_) {}
  }
}

function cmdToken() {
  const sub = args[1];
  const tokenDir = path.join(DATA_DIR, 'tokens');
  loadTokenSecret();

  if (sub === 'list') {
    if (!fs.existsSync(tokenDir)) { console.log('无 token 目录'); return; }
    const files = fs.readdirSync(tokenDir).filter(f => f.endsWith('.json'));
    const list = files.map(f => {
      const t = readJSON(path.join(tokenDir, f));
      return t ? { token_id: t.token_id, run_id: t.run_id, file: (t.files || [])[0] || '', consumed: !!t.consumed, expires_at: t.expires_at } : null;
    }).filter(Boolean);
    print({ count: list.length, tokens: list }, list.length === 0 ? '无 token' : list.map(t => `${t.token_id.slice(0, 8)} | ${t.file} | ${t.consumed ? '已消费' : '有效'} | 至 ${new Date(t.expires_at).toLocaleTimeString('zh-CN')}`).join('\n'));
    return;
  }

  if (sub === 'verify') {
    const file = args[2];
    const project = getArg('--project') || WENSTAR_CC;
    if (!file) { console.error('❌ 用法: token verify <file> --project <根>'); process.exit(1); }
    const tv = require('../src/security/token-verify.cjs');
    // 找到该文件的 token（hash 命名）
    const hash = hashCode(file);
    const tp = path.join(tokenDir, hash + '.json');
    if (!fs.existsSync(tp)) {
      // 也试绝对路径 hash
      const absHash = hashCode((project.replace(/\\/g, '/') + '/' + file).replace(/\/+/g, '/'));
      const tp2 = path.join(tokenDir, absHash + '.json');
      if (fs.existsSync(tp2)) return printVerifyResult(tv, readJSON(tp2), file, project);
      print({ allowed: false, reason: '无 token 文件' }, '❌ 无 token');
      return;
    }
    return printVerifyResult(tv, readJSON(tp), file, project);
  }

  console.error('❌ token 用法: list | verify');
  process.exit(1);
}

function printVerifyResult(tv, token, file, project) {
  if (!token) { print({ allowed: false, reason: 'token 读取失败' }, '❌ token 读取失败'); return; }
  const r = tv.verifyTokenV2(token, file, { projectRoot: project });
  print(r, r.allowed ? `✅ token 有效 (${r.reason})` : `❌ token 无效 (${r.reason})`);
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// ════════════════════════════════════════════════════════════════════
// 子命令: check / dist-verify / gate
// ════════════════════════════════════════════════════════════════════

function cmdCheck() {
  // check <files...> --project <根> --stage S4
  const project = getArg('--project') || WENSTAR_CC;
  const stage = getArg('--stage') || 'S4';
  const filesArg = getArg('--files');
  // 位置参数 = 文件列表（排除子命令名和所有 --flag 值）
  const flagNames = new Set(['--project', '--stage', '--files', '--cache-dir', '--json']);
  const files = filesArg ? filesArg.split(',')
    : args.filter((a, i) => i >= 1 && !a.startsWith('--') && !flagNames.has(args[i - 1]) && a !== 'check');
  if (!files.length) { console.error('❌ 用法: check <files...> --project <根> [--stage S4]'); process.exit(1); }
  // shell:false 下 npx 找不到 tsx → 用直接路径
  const tsxCli = path.join(HARNESS_DIR, 'node_modules', 'tsx', 'dist', 'cli.cjs');
  const r = run(process.execPath, HARNESS_DIR, [tsxCli, 'src/main_harness_checker.ts', '--project-root', project, '--files', files.join(','), '--stage', stage], 60000);
  console.log(r.stdout || r.stderr || '');
  process.exit(r.status === 0 ? 0 : 1);
}

function cmdDistVerify() {
  const file = args[1];
  const project = getArg('--project') || WENSTAR_CC;
  if (!file) { console.error('❌ 用法: dist-verify <path> --project <根>'); process.exit(1); }
  const r = run('node', HARNESS_DIR, ['scripts/dist-baseline.cjs', '--verify', file, '--project', project], 60000);
  console.log(r.stdout || r.stderr || '');
  process.exit(r.status === 0 ? 0 : 1);
}

function cmdGate() {
  const r = run('node', process.cwd(), ['scripts/harness-gate.cjs'], 30000);
  console.log(r.stdout || r.stderr || '');
  process.exit(r.status === 0 ? 0 : 1);
}

// ════════════════════════════════════════════════════════════════════
// 子命令: webui / pm2
// ════════════════════════════════════════════════════════════════════

function cmdWebui() {
  const sub = args[1];
  if (sub === 'start') {
    const r = run('node', WENSTAR_CC, ['start.cjs'], 0); // 长驻，不设 timeout
    console.log(r.stdout || r.stderr || '');
  } else if (sub === 'stop') {
    const r = run('taskkill', WENSTAR_CC, ['/IM', 'node.exe', '/FI', `"COMMANDLINE like '%webui/server.ts%'"`, '/F'], 10000);
    console.log(r.stdout || r.stderr || '');
  } else {
    console.error('❌ webui 用法: start | stop');
    process.exit(1);
  }
}

function cmdPm2() {
  const sub = args[1];
  const app = args[2];
  // pm2 全局安装，Windows 下 spawnSync('npx', shell:false) 会 ENOENT（npx 是 .cmd）→ 用 execSync
  // 与 harness 现有模式一致（pm2-recover.cjs / harness-watchdog.cjs 均用 execSync('pm2 ...')）
  let cmd;
  if (sub === 'status') {
    cmd = 'pm2 status';
  } else if (['start', 'restart', 'stop'].includes(sub) && app && /^[a-zA-Z0-9_-]+$/.test(app)) {
    // start 走 ecosystem 范式（pm2 start ecosystem.config.cjs --only <app>），app 白名单防注入
    cmd = sub === 'start' ? `pm2 start ecosystem.config.cjs --only ${app}` : `pm2 ${sub} ${app}`;
  } else {
    console.error('❌ pm2 用法: status | start|restart|stop <app>');
    process.exit(1);
  }
  try {
    const out = execSync(cmd, { encoding: 'utf-8', timeout: 30000, cwd: HARNESS_DIR, windowsHide: true });
    console.log(out);
  } catch (e) {
    console.error((e.stdout || '') + (e.stderr || '') || e.message);
    process.exit(1);
  }
}

// ════════════════════════════════════════════════════════════════════
// help / main
// ════════════════════════════════════════════════════════════════════

function help() {
  console.log(`Harness CLI — 不经 Claude Code 对话直接交互（节省 token）

用法: node scripts/harness-cli.cjs <子命令> [参数]

状态:
  status                             防线状态(看板API→退化心跳)
豁免:
  exempt list                        豁免列表
  exempt add <file> --project <根> --minutes N --reason "..." [--ops a,b] [--relaxed a,b] --password <密码>
解锁:
  unlock status | lock                harness 自身解锁状态/锁定
token:
  token list                          token 列表
  token verify <file> --project <根>   token 校验
流水线检查:
  check <files...> --project <根> [--stage S4]   CK 检查
  dist-verify <path> --project <根>    dist 校验
  gate                                commit 前检查
项目:
  webui start | stop                  wenstar-cc webui
  pm2 status | start|restart|stop <app>
通用: --json 输出 JSON
`);
}

(async () => {
  const cmd = args[0];
  switch (cmd) {
    case 'status': return cmdStatus();
    case 'exempt': return cmdExempt();
    case 'unlock': return cmdUnlock();
    case 'token': return cmdToken();
    case 'check': return cmdCheck();
    case 'dist-verify': return cmdDistVerify();
    case 'gate': return cmdGate();
    case 'webui': return cmdWebui();
    case 'pm2': return cmdPm2();
    case 'help': case '--help': case '-h': return help();
    default:
      help();
      if (cmd) console.error(`\n❌ 未知子命令: ${cmd}`);
      process.exit(1);
  }
})().catch(e => { console.error('❌ CLI 异常:', e.message); process.exit(1); });

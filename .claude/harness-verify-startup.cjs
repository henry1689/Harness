#!/usr/bin/env node
/**
 * harness-verify-startup.cjs — SelfGuard 启动验证脚本
 * =====================================================
 *
 * 会话启动后运行此脚本，验证整套管控体系是否正常加载并工作。
 *
 * 用法:
 *   node D:/AI文件/harness/.claude/harness-verify-startup.cjs
 *
 * 检查项（共 10 项）:
 *   1. 用户级 settings.json hooks 已注册
 *   2. PreToolUse hook 脚本存在且可执行（含绝对路径识别）
 *   3. PostToolUse hook 脚本存在且可执行
 *   4. 数据目录结构完整（tokens/breaker/audit/sessions/sentinel/）
 *   5. self_guard_checker.ts 可执行
 *   6. SelfGuard MCP 配置存在
 *   7. GlobalWatchdog 快照文件正常
 *   8. 模拟完整的 Read → Discipline + Write → DENY 链路（绝对路径+相对路径）
 *   9. 🆕 哨兵三态验证（STANDARD/SENTINEL/LOCKDOWN + 豁免令牌）
 *  10. 🆕 HTTP MCP Server 健康检查 + REST API 端点
 *
 * 退出码:
 *   0 — 全部通过
 *   1 — 存在警告（不影响核心功能）
 *   2 — 存在致命错误（管控失效）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

let errors = 0;
let warnings = 0;
let passed = 0;

// 共享常量
const DATA_DIR = 'D:/AI文件/harness/data';
const PRE_CHECK = 'D:/AI文件/harness/.claude/harness-pre-check.cjs';
const POST_CHECK = 'D:/AI文件/harness/.claude/harness-post-check.cjs';

function ok(msg) { passed++; console.log(`  ${GREEN}✅${RESET} ${msg}`); }
function warn(msg) { warnings++; console.log(`  ${YELLOW}⚠️${RESET}  ${msg}`); }
function fail(msg) { errors++; console.log(`  ${RED}❌${RESET} ${msg}`); }

console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${CYAN}║   🛡️  SelfGuard 启动验证 v1.0                        ║${RESET}`);
console.log(`${BOLD}${CYAN}║   ${new Date().toISOString()}                         ║${RESET}`);
console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════╝${RESET}\n`);

// ═══════════════════════════════════════════════════════════════
// 1. 用户级 settings.json hooks 注册
// ═══════════════════════════════════════════════════════════════
console.log(`${BOLD}[1/8] 用户级 settings.json hooks 注册${RESET}`);

const USER_SETTINGS = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'settings.json');
try {
  const raw = fs.readFileSync(USER_SETTINGS, 'utf-8');
  const settings = JSON.parse(raw);
  const hooks = settings.hooks;

  if (!hooks) {
    fail(`hooks 字段不存在于 ${USER_SETTINGS}`);
  } else {
    const preHooks = hooks.PreToolUse || [];
    const postHooks = hooks.PostToolUse || [];

    if (preHooks.length === 0) {
      fail('PreToolUse hooks 未注册');
    } else {
      const matchers = preHooks.map(h => h.matcher);
      ok(`PreToolUse: ${preHooks.length} 条 (matchers: ${matchers.join(', ')})`);

      // 检查每条 hook 的 hooks 数组结构
      for (let i = 0; i < preHooks.length; i++) {
        const h = preHooks[i];
        if (!h.hooks || !Array.isArray(h.hooks) || h.hooks.length === 0) {
          fail(`PreToolUse[${i}] (matcher: ${h.matcher}): hooks 数组缺失或为空`);
        } else {
          for (let j = 0; j < h.hooks.length; j++) {
            const cmd = h.hooks[j].command;
            if (!cmd) {
              fail(`PreToolUse[${i}].hooks[${j}]: command 缺失`);
            } else {
              ok(`  └─ ${h.matcher} → ${cmd}`);
            }
          }
        }
      }
    }

    if (postHooks.length === 0) {
      warn('PostToolUse hooks 未注册（不影响核心拦截，审计链路缺失）');
    } else {
      ok(`PostToolUse: ${postHooks.length} 条`);
      for (let i = 0; i < postHooks.length; i++) {
        const h = postHooks[i];
        if (h.hooks && h.hooks.length > 0) {
          ok(`  └─ ${h.matcher} → ${h.hooks[0].command}`);
        }
      }
    }
  }
} catch (e) {
  fail(`读取 settings.json 失败: ${e.message}`);
}

// ═══════════════════════════════════════════════════════════════
// 2. PreToolUse hook 脚本
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[2/8] PreToolUse hook 脚本${RESET}`);
if (!fs.existsSync(PRE_CHECK)) {
  fail(`PreToolUse 脚本不存在: ${PRE_CHECK}`);
} else {
  const stat = fs.statSync(PRE_CHECK);
  ok(`harness-pre-check.cjs 存在 (${(stat.size / 1024).toFixed(1)}KB)`);

  // 语法检查
  try {
    execSync(`node --check "${PRE_CHECK}"`, { encoding: 'utf-8', timeout: 5000 });
    ok('  语法检查通过');
  } catch (e) {
    fail(`  语法错误: ${e.stderr || e.message}`);
  }

  // 模拟 Read (无 write 参数 → 应返回 allow)
  const tmpIn = path.join(DATA_DIR, 'tmp_test_input.json');
  try {
    fs.writeFileSync(tmpIn, JSON.stringify({file_path: "src/FlowEngine.ts"}), 'utf-8');
    const result = execSync(`node "${PRE_CHECK}" < "${tmpIn}"`, { encoding: 'utf-8', timeout: 5000, cwd: 'D:/AI文件/harness' });
    const lines = result.trim().split('\n');
    const jsonLine = lines.find(l => l.trim().startsWith('{'));
    const decision = jsonLine ? JSON.parse(jsonLine) : { decision: 'unknown' };
    if (decision.decision === 'allow') {
      ok('  模拟 Read: ✅ ALLOW (纪律令牌自动创建)');
    } else {
      fail(`  模拟 Read: 预期 allow，实际 ${decision.decision}`);
    }
  } catch (e) {
    fail(`  模拟 Read 失败: ${e.message}`);
  }

  // 模拟 Write (有 old_string → 应返回 deny)
  try {
    fs.writeFileSync(tmpIn, JSON.stringify({file_path: "src/FlowEngine.ts", old_string: "a", new_string: "b"}), 'utf-8');
    const result = execSync(`node "${PRE_CHECK}" < "${tmpIn}"`, { encoding: 'utf-8', timeout: 5000, cwd: 'D:/AI文件/harness' });
    const lines = result.trim().split('\n');
    const jsonLine = lines.find(l => l.trim().startsWith('{'));
    const decision = jsonLine ? JSON.parse(jsonLine) : { decision: 'unknown' };
    if (decision.decision === 'deny') {
      ok('  模拟 Write: ✅ DENY (无Token，正确拦截)');
    } else {
      fail(`  模拟 Write: 预期 deny，实际 ${decision.decision || 'parse error'}`);
    }
  } catch (e) {
    fail(`  模拟 Write 失败: ${e.message}`);
  }

  // 模拟保护区 Write (.claude/settings.json → 应返回 deny)
  try {
    fs.writeFileSync(tmpIn, JSON.stringify({file_path: ".claude/settings.json", old_string: "a", new_string: "b"}), 'utf-8');
    const result = execSync(`node "${PRE_CHECK}" < "${tmpIn}"`, { encoding: 'utf-8', timeout: 5000, cwd: 'D:/AI文件/harness' });
    const lines = result.trim().split('\n');
    const jsonLine = lines.find(l => l.trim().startsWith('{'));
    const decision = jsonLine ? JSON.parse(jsonLine) : { decision: 'unknown' };
    if (decision.decision === 'deny' && (decision.reason || '').includes('Protected')) {
      ok('  模拟保护区 Write: ✅ DENY (Protected zone)');
    } else {
      fail(`  模拟保护区 Write: 预期 DENY+Protected，实际 ${decision.decision}: ${(decision.reason||'').slice(0,50)}`);
    }
  } catch (e) {
    fail(`  模拟保护区 Write 失败: ${e.message}`);
  }

  // 清理临时文件
  try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// 3. PostToolUse hook 脚本
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[3/8] PostToolUse hook 脚本${RESET}`);
if (!fs.existsSync(POST_CHECK)) {
  fail(`PostToolUse 脚本不存在: ${POST_CHECK}`);
} else {
  const stat = fs.statSync(POST_CHECK);
  ok(`harness-post-check.cjs 存在 (${(stat.size / 1024).toFixed(1)}KB)`);

  // 语法检查
  try {
    execSync(`node --check "${POST_CHECK}"`, { encoding: 'utf-8', timeout: 5000 });
    ok('  语法检查通过');
  } catch (e) {
    fail(`  语法错误: ${e.stderr || e.message}`);
  }

  // 模拟正常执行
  try {
    const result = execSync(`echo '{"file_path":"src/FlowEngine.ts"}' | node "${POST_CHECK}"`, { encoding: 'utf-8', timeout: 5000 });
    ok(`  模拟执行: 正常 (output: ${result.trim().slice(0, 80)})`);
  } catch (e) {
    fail(`  模拟执行失败: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// 4. 数据目录结构
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[4/8] 数据目录结构${RESET}`);
const requiredDirs = [
  'tokens',
  'breaker',
  'sessions',
  'audit/selfguard',
  'audit/selfguard/discipline_bypass',
];

for (const dir of requiredDirs) {
  const full = path.join(DATA_DIR, dir);
  if (fs.existsSync(full)) {
    ok(`data/${dir}/ 存在`);
  } else {
    // 自动创建
    try {
      fs.mkdirSync(full, { recursive: true });
      ok(`data/${dir}/ 自动创建`);
    } catch (e) {
      fail(`data/${dir}/ 不存在且无法创建: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 5. self_guard_checker.ts
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[5/8] self_guard_checker.ts 本地校验脚本${RESET}`);

const CHECKER_SCRIPT = 'D:/AI文件/SelfGuard/self_guard_checker.ts';
if (!fs.existsSync(CHECKER_SCRIPT)) {
  fail(`checker 脚本不存在: ${CHECKER_SCRIPT}`);
} else {
  const stat = fs.statSync(CHECKER_SCRIPT);
  ok(`self_guard_checker.ts 存在 (${(stat.size / 1024).toFixed(1)}KB)`);

  // 执行 quick 模式测试
  try {
    const result = execSync(`npx tsx "${CHECKER_SCRIPT}" --files "src/config/test.ts" --mode quick --format text --no-cache`, {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: 'D:/AI文件/SelfGuard',
    });
    ok(`quick 模式执行正常 (exit 0 = 全部通过)`);
  } catch (e) {
    // 预期可能 exit 1 (有违规) 但脚本本身运行正常
    if (e.stdout && e.stdout.includes('SelfGuard S4')) {
      ok(`quick 模式执行正常 (exit ${e.status} = 检测到违规，这是预期行为)`);
    } else {
      warn(`quick 模式执行异常: ${e.message.slice(0, 100)}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 6. SelfGuard MCP 配置
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[6/8] SelfGuard MCP 配置${RESET}`);

const MCP_CONFIG = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'mcp.json');
const HARNESS_MCP = 'D:/AI文件/harness/.claude/mcp.json';

for (const cfg of [MCP_CONFIG, HARNESS_MCP]) {
  if (!fs.existsSync(cfg)) {
    warn(`MCP 配置不存在: ${cfg}`);
  } else {
    try {
      const raw = fs.readFileSync(cfg, 'utf-8');
      const config = JSON.parse(raw);
      const servers = config.mcpServers || {};
      const selfguard = servers.selfguard;
      if (selfguard) {
        ok(`${path.basename(path.dirname(cfg))}/${path.basename(cfg)}: selfguard MCP 已配置 → ${selfguard.command} ${(selfguard.args||[]).join(' ')}`);
      } else {
        warn(`${path.basename(path.dirname(cfg))}/${path.basename(cfg)}: selfguard MCP 未配置`);
      }
    } catch (e) {
      fail(`解析 ${cfg} 失败: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 7. GlobalWatchdog
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[7/8] GlobalWatchdog 状态${RESET}`);

const SELFGUARD_DATA = 'D:/AI文件/SelfGuard/data';
const watcherDirs = ['audit', 'breach_alerts'];
for (const dir of watcherDirs) {
  const full = path.join(SELFGUARD_DATA, dir);
  if (fs.existsSync(full)) {
    ok(`SelfGuard/${dir}/ 存在`);
  } else {
    try {
      fs.mkdirSync(full, { recursive: true });
      ok(`SelfGuard/${dir}/ 自动创建`);
    } catch (e) {
      warn(`SelfGuard/${dir}/ 不存在: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 8. 端到端链路验证 — 绝对路径 + 相对路径 + 保护区
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[8/10] 端到端链路验证${RESET}`);

// 清理测试残留
try {
  const breakerDir = path.join(DATA_DIR, 'breaker');
  if (fs.existsSync(breakerDir)) {
    for (const f of fs.readdirSync(breakerDir)) { fs.unlinkSync(path.join(breakerDir, f)); }
  }
  const discFile = path.join(DATA_DIR, 'sessions', 'discipline.json');
  if (fs.existsSync(discFile)) fs.unlinkSync(discFile);
} catch {}

// 测试：绝对路径 Read
const tmpIn = path.join(DATA_DIR, 'tmp_verify.json');
try {
  fs.writeFileSync(tmpIn, JSON.stringify({file_path: "D:/AI文件/harness/src/FlowEngine.ts"}), 'utf-8');
  const result = execSync(`node "${PRE_CHECK}" < "${tmpIn}"`, { encoding: 'utf-8', timeout: 5000, cwd: 'D:/AI文件/harness' });
  if (result.includes('"allow"')) ok('  绝对路径 Read: ✅ ALLOW');
  else if (result.includes('"deny"')) fail('  绝对路径 Read: 错误地返回了 deny');
  else fail('  绝对路径 Read: 无法解析结果');
} catch (e) { fail(`  绝对路径 Read 失败: ${e.message}`); }

// 测试：绝对路径 Write
try {
  fs.writeFileSync(tmpIn, JSON.stringify({file_path: "D:/AI文件/harness/src/StageRunner.ts", old_string:"a", new_string:"b"}), 'utf-8');
  const result = execSync(`node "${PRE_CHECK}" < "${tmpIn}"`, { encoding: 'utf-8', timeout: 5000, cwd: 'D:/AI文件/harness' });
  if (result.includes('"deny"') && result.includes('Pipeline')) ok('  绝对路径 Write: ✅ DENY (无Token)');
  else fail('  绝对路径 Write: 未正确拦截');
} catch (e) { fail(`  绝对路径 Write 失败: ${e.message}`); }

// 测试：保护区绝对路径
try {
  fs.writeFileSync(tmpIn, JSON.stringify({file_path: "D:/AI文件/harness/.claude/settings.json", old_string:"a", new_string:"b"}), 'utf-8');
  const result = execSync(`node "${PRE_CHECK}" < "${tmpIn}"`, { encoding: 'utf-8', timeout: 5000, cwd: 'D:/AI文件/harness' });
  if (result.includes('"deny"') && result.includes('Protected')) ok('  保护区绝对路径: ✅ DENY (Protected)');
  else fail('  保护区绝对路径: 未正确拦截');
} catch (e) { fail(`  保护区绝对路径 失败: ${e.message}`); }

// 测试：非 Harness 文件
try {
  fs.writeFileSync(tmpIn, JSON.stringify({file_path: "C:/Users/henry/test.txt", old_string:"a", new_string:"b"}), 'utf-8');
  const result = execSync(`node "${PRE_CHECK}" < "${tmpIn}"`, { encoding: 'utf-8', timeout: 5000, cwd: 'D:/AI文件/harness' });
  if (result.includes('"allow"')) ok('  非Harness文件: ✅ ALLOW (不拦截)');
  else fail('  非Harness文件: 错误拦截');
} catch (e) { fail(`  非Harness文件 失败: ${e.message}`); }

try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch {}

// 清理残留
try {
  const breakerDir = path.join(DATA_DIR, 'breaker');
  if (fs.existsSync(breakerDir)) {
    for (const f of fs.readdirSync(breakerDir)) { fs.unlinkSync(path.join(breakerDir, f)); }
  }
  const discFile = path.join(DATA_DIR, 'sessions', 'discipline.json');
  if (fs.existsSync(discFile)) fs.unlinkSync(discFile);
} catch {}

// ═══════════════════════════════════════════════════════════════
// 9. 🆕 哨兵三态验证
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[9/10] 哨兵三态验证 (STANDARD → SENTINEL → LOCKDOWN)${RESET}`);

const SENTINEL_DIR = 'D:/AI文件/harness/data/sentinel';
const STATE_FILE = path.join(SENTINEL_DIR, 'state.json');
const OVERRIDE_DIR = path.join(SENTINEL_DIR, 'overrides');

// 重置哨兵状态
try {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  if (!fs.existsSync(SENTINEL_DIR)) fs.mkdirSync(SENTINEL_DIR, { recursive: true });
  if (!fs.existsSync(OVERRIDE_DIR)) fs.mkdirSync(OVERRIDE_DIR, { recursive: true });
} catch {}

// 9a. STANDARD 模式：Read 应自动放行
try {
  fs.writeFileSync(STATE_FILE, JSON.stringify({level:0, mode:0, reason:"验证-STANDARD"}), 'utf-8');
  fs.writeFileSync(tmpIn, JSON.stringify({file_path: "src/FlowEngine.ts"}), 'utf-8');
  const result = execSync(`node "${PRE_CHECK}" < "${tmpIn}"`, { encoding: 'utf-8', timeout: 5000, cwd: 'D:/AI文件/harness' });
  if (result.includes('"allow"')) ok('  STANDARD Read: ✅ ALLOW (自动纪律令牌)');
  else fail('  STANDARD Read: 未放行');
} catch (e) { fail(`  STANDARD Read 失败: ${e.message}`); }

// 9b. SENTINEL 模式：无纪律令牌 Read 应被拒绝
try {
  fs.writeFileSync(STATE_FILE, JSON.stringify({level:1, mode:1, reason:"验证-SENTINEL"}), 'utf-8');
  // 清理纪律令牌
  const discFile = path.join(DATA_DIR, 'sessions', 'discipline.json');
  if (fs.existsSync(discFile)) fs.unlinkSync(discFile);
  fs.writeFileSync(tmpIn, JSON.stringify({file_path: "src/FlowEngine.ts"}), 'utf-8');
  const result = execSync(`node "${PRE_CHECK}" < "${tmpIn}"`, { encoding: 'utf-8', timeout: 5000, cwd: 'D:/AI文件/harness' });
  if (result.includes('"deny"') && result.includes('SENTINEL')) ok('  SENTINEL Read(无令牌): ✅ DENY');
  else fail('  SENTINEL Read(无令牌): 未拦截');
} catch (e) { fail(`  SENTINEL Read 失败: ${e.message}`); }

// 9c. LOCKDOWN 模式：Write 应被封死
try {
  fs.writeFileSync(STATE_FILE, JSON.stringify({level:2, mode:2, reason:"验证-LOCKDOWN"}), 'utf-8');
  fs.writeFileSync(tmpIn, JSON.stringify({file_path: "src/FlowEngine.ts", old_string:"a", new_string:"b"}), 'utf-8');
  const result = execSync(`node "${PRE_CHECK}" < "${tmpIn}"`, { encoding: 'utf-8', timeout: 5000, cwd: 'D:/AI文件/harness' });
  if (result.includes('"deny"') && result.includes('LOCKDOWN')) ok('  LOCKDOWN Write: ✅ DENY');
  else fail('  LOCKDOWN Write: 未封死');
} catch (e) { fail(`  LOCKDOWN Write 失败: ${e.message}`); }

// 9d. LOCKDOWN + 豁免令牌：Read 应被豁免放行
try {
  fs.writeFileSync(path.join(OVERRIDE_DIR, 'verify-ovr.json'), JSON.stringify({
    override_id:'verify-ovr', created_at:new Date().toISOString(), expires_at:new Date(Date.now()+600000).toISOString(),
    files:['src/FlowEngine.ts'], reason:'验证豁免', consumed:false, usage_count:0
  }), 'utf-8');
  fs.writeFileSync(tmpIn, JSON.stringify({file_path: "src/FlowEngine.ts"}), 'utf-8');
  const result = execSync(`node "${PRE_CHECK}" < "${tmpIn}"`, { encoding: 'utf-8', timeout: 5000, cwd: 'D:/AI文件/harness' });
  if (result.includes('"allow"') && result.includes('豁免')) ok('  LOCKDOWN+豁免 Read: ✅ ALLOW');
  else fail('  LOCKDOWN+豁免 Read: 未放行');
} catch (e) { fail(`  LOCKDOWN+豁免 Read 失败: ${e.message}`); }

// 重置为标准模式 + 清理
try {
  fs.writeFileSync(STATE_FILE, JSON.stringify({level:0, mode:0, reason:"验证完成-恢复STANDARD"}), 'utf-8');
  const overrides = path.join(SENTINEL_DIR, 'overrides');
  if (fs.existsSync(overrides)) {
    for (const f of fs.readdirSync(overrides)) { try { fs.unlinkSync(path.join(overrides, f)); } catch {} }
  }
  if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
  if (fs.existsSync(discFile)) fs.unlinkSync(discFile);
  ok('  哨兵状态已恢复 STANDARD');
} catch {}

// ═══════════════════════════════════════════════════════════════
// 10. 🆕 HTTP MCP Server + REST API
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[10/10] HTTP MCP Server 端点验证${RESET}`);

const HTTP_PORT = 18770;
const http = require('http');

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${HTTP_PORT}${path}`, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = http.request(`http://127.0.0.1:${HTTP_PORT}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }, timeout: 3000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

(async () => {
  try {
    const health = await httpGet('/health');
    if (health.status === 200) {
      const j = JSON.parse(health.data);
      ok(`GET /health: ${j.status} (sentinel=${j.sentinel}, v=${j.version})`);
    } else {
      warn(`GET /health: HTTP ${health.status}`);
    }
  } catch (e) {
    warn(`GET /health: 无法连接 (${e.message}) — 确认 SelfGuard MCP Server 已启动`);
  }

  try {
    const status = await httpGet('/sentinel/status');
    if (status.status === 200) {
      const j = JSON.parse(status.data);
      ok(`GET /sentinel/status: mode=${j.mode_name}, level=${j.level}`);
    } else {
      warn(`GET /sentinel/status: HTTP ${status.status}`);
    }
  } catch (e) {
    warn(`GET /sentinel/status: 无法连接`);
  }

  try {
    const rpc = await httpPost('/mcp', { jsonrpc:'2.0', method:'tools/call', params:{ name:'sentinel_status', arguments:{} }, id:1 });
    if (rpc.status === 200) {
      const j = JSON.parse(rpc.data);
      const text = j.result?.content?.[0]?.text || '';
      ok(`POST /mcp (sentinel_status): ${text.includes('STANDARD') ? '✅' : '⚠️'} MCP JSON-RPC 正常`);
    } else {
      warn(`POST /mcp: HTTP ${rpc.status}`);
    }
  } catch (e) {
    warn(`POST /mcp: 无法连接`);
  }

  // 链路追踪
  console.log(`\n  ${CYAN}链路追踪 (v4.0-sentinel):${RESET}`);
  console.log(`  ${CYAN}  ┌─ 哨兵层 (Hook 级)${RESET}`);
  console.log(`  ${CYAN}  │  STANDARD: 读自由(自动令牌) 写锁死(需流水线令牌)${RESET}`);
  console.log(`  ${CYAN}  │  SENTINEL: 读需声明(禁用自动令牌) 写锁死 全量审计${RESET}`);
  console.log(`  ${CYAN}  │  LOCKDOWN: 全禁(读/写均拒绝) 仅限一次性豁免令牌${RESET}`);
  console.log(`  ${CYAN}  ├─ Hook 层 (PreToolUse/PostToolUse)${RESET}`);
  console.log(`  ${CYAN}  │  T1 保护区 → T2 低风险 → T3 哨兵检查 → T4 令牌校验${RESET}`);
  console.log(`  ${CYAN}  │  T5 批量限流(≤3) → T6 OS兜底 → PostToolUse审计${RESET}`);
  console.log(`  ${CYAN}  ├─ MCP 层 (stdio + HTTP 双传输)${RESET}`);
  console.log(`  ${CYAN}  │  10 个 MCP Tools + 6 个 REST API 端点${RESET}`);
  console.log(`  ${CYAN}  │  SSE 事件推送 /events → 外部仪表盘实时订阅${RESET}`);
  console.log(`  ${CYAN}  └─ 监控层 (GlobalWatchdog 10s 旁路扫描)${RESET}`);

  // ── 总结 ──
  console.log(`\n${BOLD}${'═'.repeat(54)}${RESET}`);
  console.log(`${BOLD}  验证结果: ${passed} 通过  ${warnings} 警告  ${errors} 错误${RESET}`);
  console.log(`${BOLD}${'═'.repeat(54)}${RESET}`);

  if (errors > 0) {
    console.log(`\n${RED}${BOLD}🔴 管控体系存在致命缺陷！${RESET}`);
    console.log(`${RED}   请修复以上 ${errors} 个错误后重新运行此脚本。${RESET}`);
    console.log(`${RED}   在错误修复前，Harness 文件可能缺乏强制保护。${RESET}\n`);
    process.exit(2);
  } else if (warnings > 0) {
    console.log(`\n${YELLOW}${BOLD}⚠️  管控体系基本就绪，但存在 ${warnings} 个警告。${RESET}`);
    console.log(`${YELLOW}   核心拦截 + 哨兵功能正常，建议检查警告项。${RESET}\n`);
    process.exit(1);
  } else {
    console.log(`\n${GREEN}${BOLD}✅ 全部 ${passed} 项检查通过。SelfGuard 哨兵管控体系就绪。${RESET}`);
    console.log(`${GREEN}${BOLD}╔════════════════════════════════════════════════════╗${RESET}`);
    console.log(`${GREEN}${BOLD}║  🔒 读自由  │  🔴 写锁死  │  🛡️ 永锁保护区      ║${RESET}`);
    console.log(`${GREEN}${BOLD}║  STANDARD → SENTINEL → LOCKDOWN 哨兵三态     ║${RESET}`);
    console.log(`${GREEN}${BOLD}║  stdio + HTTP MCP 双传输  |  :18770 REST API  ║${RESET}`);
    console.log(`${GREEN}${BOLD}╚════════════════════════════════════════════════════╝${RESET}\n`);
    process.exit(0);
  }
})().catch(e => {
  fail(`验证脚本异常: ${e.message}`);
  process.exit(2);
});

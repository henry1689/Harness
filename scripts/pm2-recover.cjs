#!/usr/bin/env node
/**
 * pm2-recover.cjs — PM2 进程恢复脚本 (P4-AB)
 * ============================================
 * 自动检测并恢复 harness-mcp 和 harness-sentinel 进程。
 *
 * 恢复流程:
 *   1. pm2 ping  →  不可达则 pm2 resurrect
 *   2. 检查目标进程  →  stopped/missing 则按 ecosystem 启动
 *   3. harness-mcp 必须通过 start.cjs 启动 (不绕过编译验证)
 *   4. 输出恢复报告
 *
 * 用法:
 *   node scripts/pm2-recover.cjs             # 仅恢复
 *   node scripts/pm2-recover.cjs --save      # 恢复后保存 PM2 进程列表
 *   node scripts/pm2-recover.cjs --force     # 强制 pm2 kill → resurrect → start
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const HARNESS_ROOT = path.resolve(__dirname, '..');
const ECOSYSTEM_CONFIG = path.join(HARNESS_ROOT, 'ecosystem.config.cjs');
const START_CJS = path.join(HARNESS_ROOT, 'mcp', 'start.cjs');

const RECOVERY_LOG_DIR = path.join(HARNESS_ROOT, 'data', 'reports', 'recovery');
const SAVE = process.argv.includes('--save');
const FORCE = process.argv.includes('--force');

// ── 工具 ──

function cmd(command, opts = {}) {
  try {
    return execSync(command, { ...opts, encoding: 'utf-8', timeout: opts.timeout || 15000 }).trim();
  } catch (e) {
    return null;
  }
}

function log(level, msg) {
  const prefix = { info: '   ', warn: ' ⚠️ ', err: ' ❌ ', ok: ' ✅ ' }[level] || '   ';
  console.log(prefix + msg);
}

// ── 恢复报告 ──

const report = {
  timestamp: new Date().toISOString(),
  actions: [],
  final_state: {},
};

function addAction(action, status, detail = '') {
  report.actions.push({ action, status, detail, time: new Date().toISOString() });
  const icon = status === 'ok' ? '✅' : status === 'skip' ? '⏭️' : '❌';
  console.log(`  ${icon} ${action} ${detail}`);
}

// ── 主逻辑 ──

async function main() {
  console.log('=== Harness PM2 Recovery ===');
  console.log('');

  // 0. 检查 ecosystem config
  if (!fs.existsSync(ECOSYSTEM_CONFIG)) {
    console.log('❌ ecosystem.config.cjs 不存在，无法恢复');
    process.exit(1);
  }
  if (!fs.existsSync(START_CJS)) {
    console.log('❌ mcp/start.cjs 不存在，无法恢复 MCP');
    process.exit(1);
  }

  // 1. PM2 daemon
  const ping = cmd('npx pm2 ping');
  if (!ping || !ping.includes('pong')) {
    addAction('pm2_resurrect', 'ok', 'PM2 daemon 不可达，尝试 resurrect');
    cmd('npx pm2 resurrect');

    const ping2 = cmd('npx pm2 ping');
    if (!ping2 || !ping2.includes('pong')) {
      addAction('pm2_daemon_start', 'fail', 'PM2 daemon 仍然不可达');
      writeReport();
      process.exit(1);
    }
    addAction('pm2_daemon', 'ok', 'PM2 daemon 已恢复');
  } else {
    addAction('pm2_daemon', 'ok', 'alive');
  }

  // 2. Force 模式
  if (FORCE) {
    addAction('force_reset', 'ok', '强制重建所有进程');
    cmd('npx pm2 delete all');
    cmd('npx pm2 start ' + ECOSYSTEM_CONFIG);
    addAction('force_start', 'ok', '全部进程已从 ecosystem 重建');
    if (SAVE) cmd('npx pm2 save');
    writeReport();
    process.exit(0);
  }

  // 3. 获取进程列表
  let pm2List = [];
  try {
    const raw = cmd('npx pm2 jlist', { timeout: 15000 });
    pm2List = JSON.parse(raw);
  } catch (e) {
    addAction('pm2_list', 'fail', e.message);
    writeReport();
    process.exit(1);
  }

  // 4. 检查并恢复 harness-mcp
  const mcp = pm2List.find(p => p.name === 'harness-mcp');
  if (mcp && mcp.pm2_env?.status === 'online') {
    const sp = mcp.pm2_env?.pm_exec_path || '';
    if (sp.includes('start.cjs')) {
      addAction('harness-mcp', 'ok', `online (PID ${mcp.pid}, via start.cjs)`);
    } else {
      addAction('harness-mcp', 'warn', `online 但非 start.cjs (${sp})，重启`);
      cmd('npx pm2 restart harness-mcp');
    }
  } else {
    addAction('harness-mcp', 'ok', '已停止/缺失，从 start.cjs 重新启动');
    // 🔴 通过 start.cjs 启动，确保编译验证
    const startScript = path.relative(HARNESS_ROOT, START_CJS);
    cmd(`npx pm2 start ${startScript} --name harness-mcp --interpreter node -- --root D:/tools/wenstar-cc`);
    addAction('harness-mcp_started', 'ok', '已通过 start.cjs 启动');
  }

  // 5. 检查并恢复 harness-sentinel
  const sentinel = pm2List.find(p => p.name === 'harness-sentinel');
  if (sentinel && sentinel.pm2_env?.status === 'online') {
    addAction('harness-sentinel', 'ok', `online (PID ${sentinel.pid})`);
  } else {
    addAction('harness-sentinel', 'ok', '已停止/缺失，从 ecosystem 重启');
    cmd('npx pm2 start ' + ECOSYSTEM_CONFIG + ' --only harness-sentinel');
    addAction('harness-sentinel_started', 'ok', '已恢复');
  }

  // 6. 保存
  if (SAVE) {
    cmd('npx pm2 save');
    addAction('pm2_save', 'ok', '进程列表已保存');
  }

  // 7. 最终状态
  try {
    const final = cmd('npx pm2 jlist', { timeout: 10000 });
    report.final_state = JSON.parse(final).map(p => ({ name: p.name, status: p.pm2_env?.status, pid: p.pid }));
  } catch (_) {}

  writeReport();

  const allOnline = (report.final_state || []).every(p => p.status === 'online');
  console.log('');
  console.log(`Recovery: ${allOnline ? 'OK' : 'PARTIAL'}`);
  process.exit(allOnline ? 0 : 1);
}

function writeReport() {
  try {
    if (!fs.existsSync(RECOVERY_LOG_DIR)) fs.mkdirSync(RECOVERY_LOG_DIR, { recursive: true });
    const fname = `recovery-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    fs.writeFileSync(path.join(RECOVERY_LOG_DIR, fname), JSON.stringify(report, null, 2), 'utf-8');
  } catch (_) {}
}

main().catch(e => {
  console.error('Recovery failed:', e.message);
  process.exit(1);
});

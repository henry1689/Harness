#!/usr/bin/env node
/**
 * pm2-health.cjs — PM2 进程健康检查 (P4-AB)
 * ==========================================
 * 检查 harness-mcp 和 harness-sentinel 的 PM2 进程状态。
 *
 * 用法:
 *   node scripts/pm2-health.cjs
 *
 * 退出码: 0 = 全部 healthy, 1 = 有异常, 2 = PM2 不可达
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const HARNESS_ROOT = path.resolve(__dirname, '..');
const REQUIRED_PROCESSES = ['harness-mcp', 'harness-sentinel'];

// ── 工具 ──

function cmd(command, opts = {}) {
  try {
    return execSync(command, { ...opts, encoding: 'utf-8', timeout: opts.timeout || 10000 }).trim();
  } catch (e) {
    return null;
  }
}

function log(label, status, detail = '') {
  const icon = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️' : '❌';
  console.log(`  ${icon} [${status}] ${label} ${detail}`);
}

// ── 主逻辑 ──

let exitCode = 0;

console.log('=== Harness PM2 Health Check ===');
console.log('');

// 1. PM2 daemon 可达性
const pingResult = cmd('npx pm2 ping');
if (!pingResult || !pingResult.includes('pong')) {
  log('PM2 daemon', 'FAIL', 'PM2 daemon 不可达');
  process.exit(2);
}
log('PM2 daemon', 'PASS', 'alive');

// 2. PM2 进程列表
let pm2List = [];
try {
  const raw = cmd('npx pm2 jlist', { timeout: 15000 });
  pm2List = JSON.parse(raw);
} catch (e) {
  log('PM2 process list', 'FAIL', e.message);
  exitCode = 1;
}

// 3. 逐进程检查
for (const name of REQUIRED_PROCESSES) {
  const proc = pm2List.find(p => p.name === name);
  if (!proc) {
    log(name, 'FAIL', '进程不存在');
    exitCode = 1;
    continue;
  }

  const status = proc.pm2_env?.status || 'unknown';
  if (status !== 'online') {
    log(name, 'FAIL', `状态: ${status} (PID: ${proc.pid})`);
    exitCode = 1;
    continue;
  }

  // 检查启动脚本路径
  const scriptPath = proc.pm2_env?.pm_exec_path || '';
  if (name === 'harness-mcp' && !scriptPath.includes('start.cjs')) {
    log(name, 'WARN', `在线但非 start.cjs 启动: ${scriptPath}`);
  } else {
    log(name, 'PASS', `online PID ${proc.pid} | restarts: ${proc.pm2_env?.restart_time || 0} | uptime: ${(proc.pm2_env?.pm_uptime ? Math.round((Date.now() - proc.pm2_env.pm_uptime) / 1000) : '?') + 's'}`);
  }
}

console.log('');
console.log(`Exit: ${exitCode === 0 ? 'OK' : 'FAIL'}`);
process.exit(exitCode);

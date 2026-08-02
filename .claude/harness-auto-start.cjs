/**
 * auto-start.cjs — Harness 服务懒启动模块
 * =========================================
 * 供 harness-pre-check.cjs 引用。
 *
 * 当 Hook 检测到 MCP Server 未运行时（中/高风险文件 DENY 之前），
 * 自动 fire-and-forget 拉起 MCP Server + Sentinel，确保下次调用时服务已就绪。
 *
 * 不阻塞 Hook 返回——Hook 必须在 <50ms 内返回，否则卡住 Claude Code 的 Edit/Write。
 */

'use strict';

var net = require('net');
var { spawn, execSync } = require('child_process');
var path = require('path');
var fs = require('fs');

var HARNESS_DIR = path.resolve(__dirname, '..');
var MCP_PORT = parseInt(process.env.HARNESS_MCP_PORT || '8765');

// 启动过的标记（进程级缓存，避免重复 spawn）
var mcpStarted = false;
var sentinelStarted = false;

/**
 * 🔴 同步检查 MCP Server 端口是否在监听（用 execSync 做 TCP 连接探测）。
 * 若未存活 → fire-and-forget 后台拉起。
 * @returns {boolean} 是否已在运行
 */
function ensureMCPServer() {
  if (mcpStarted) return true;
  if (isPortOpenSync(MCP_PORT)) return true;
  startMCPServer();
  return false;
}

/**
 * 🔴 同步检查进程 + 拉起 Sentinel。
 */
function ensureSentinel(projectRoot) {
  if (sentinelStarted) return true;
  try {
    var out = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV 2>nul', {
      encoding: 'utf-8', timeout: 3000, windowsHide: true,
    });
    if (out.toLowerCase().includes('sentinel-service')) return true;
  } catch (_) {}
  startSentinel(projectRoot);
  return false;
}

// ── 同步端口探测（execSync 阻塞，保证返回前知道结果）──

function isPortOpenSync(port) {
  try {
    // 用 execSync 跑一个 node 内联脚本做 TCP 连接
    var result = execSync(
      'node -e "var s=require(\'net\').connect(' + port + ',\'127.0.0.1\',function(){s.destroy();process.exit(0)});s.on(\'error\',function(){process.exit(1)});setTimeout(function(){process.exit(1)},500)"',
      { timeout: 2500, encoding: 'utf-8', windowsHide: true },
    );
    return true; // exit 0 = 端口开放
  } catch (_) {
    return false; // exit 1 / timeout = 端口未开或不可达
  }
}

// ── 内部：拉起服务 ──

function startMCPServer() {
  mcpStarted = true;
  var mcpPath = path.join(HARNESS_DIR, 'mcp', 'server.ts');
  if (!fs.existsSync(mcpPath)) {
    console.error('[harness:auto-start] MCP server.ts 不存在');
    return;
  }

  try {
    // 找到 npx.cmd（Windows 批处理，必须用 shell 执行）
    var npxCmd = findNpxCmd();
    console.error('[harness:auto-start] 使用 npx: ' + npxCmd + ' 启动 MCP Server');

    spawn(npxCmd, ['tsx', mcpPath], {
      cwd: HARNESS_DIR, detached: true, stdio: 'ignore',
      env: Object.assign({}, process.env, { HARNESS_MCP_PORT: String(MCP_PORT) }),
      shell: true,
    }).unref();
    console.error('[harness:auto-start] 🔧 MCP Server 后台拉起中 (port ' + MCP_PORT + ')');
  } catch (e) {
    console.error('[harness:auto-start] MCP 启动失败: ' + e.message);
  }
}

function findNpxCmd() {
  try {
    var out = execSync('where npx.cmd 2>nul', {
      encoding: 'utf-8', timeout: 3000, windowsHide: true,
    }).trim().split('\n')[0];
    if (out && fs.existsSync(out)) return out;
  } catch (_) {}
  return 'npx.cmd'; // fallback
}

function startSentinel(projectRoot) {
  sentinelStarted = true;
  projectRoot = projectRoot || 'D:/tools/wenstar-cc';
  var sentinelPath = path.join(HARNESS_DIR, 'sentinel', 'sentinel-service.cjs');
  if (!fs.existsSync(sentinelPath)) { console.error('[harness:auto-start] Sentinel 脚本不存在'); return; }

  try {
    spawn('node', [sentinelPath, '--project', projectRoot],
      { cwd: HARNESS_DIR, detached: true, stdio: 'ignore', env: process.env },
    ).unref();
    console.error('[harness:auto-start] 🔍 Sentinel 后台拉起中 (监控: ' + projectRoot + ')');
  } catch (e) {
    console.error('[harness:auto-start] Sentinel 启动失败: ' + e.message);
  }
}

module.exports = { ensureMCPServer, ensureSentinel };

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
var crypto = require('crypto');
var { spawn, execSync } = require('child_process');
var path = require('path');
var fs = require('fs');

var HARNESS_DIR = path.resolve(__dirname, '..');
var MCP_PORT = parseInt(process.env.HARNESS_MCP_PORT || '8765');

// ── 🔴 A(v3.1): 单实例锁读取（只读，不写）──
// 背景（2026-09-11 闪屏事故）：本模块与 pm2 各拉起一份 mcp/start.cjs 看守进程，两份
// 抢同一端口、互相 taskkill 对方的 server.ts，形成互杀永动机，控制台窗口每 ~7 秒闪一轮。
// 锁由服务自己（mcp/start.cjs、sentinel-service.cjs）写入并每 15s 刷 mtime；本模块只读。
// 父进程先占锁再 spawn 会让被拉起的子进程误判「已有人」而自杀，故此处严格只读。
var LOCK_DIR = path.join(HARNESS_DIR, 'data', 'mcp-watchdog');
var LOCK_STALE_MS = 60_000;

/** 锁是否新鲜（<60s）。新鲜 = 持有者活着（每 15s 刷 mtime）。 */
function isLockFresh(lockPath) {
  try { return (Date.now() - fs.statSync(lockPath).mtimeMs) < LOCK_STALE_MS; }
  catch (_) { return false; }
}

/** 哨兵锁路径——归一化算法必须与 sentinel/sentinel-service.cjs 完全一致 */
function sentinelLockPath(projectRoot) {
  var norm = path.resolve(projectRoot || '').replace(/\\/g, '/').toLowerCase();
  var h = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
  return path.join(LOCK_DIR, 'sentinel-' + h + '.lock');
}

/**
 * 🔴 同步检查 MCP Server 端口是否在监听（用 execSync 做 TCP 连接探测）。
 * 若未存活 → fire-and-forget 后台拉起。
 * @returns {boolean} 是否已在运行
 */
function ensureMCPServer() {
  if (mcpStarted) return true;
  if (isPortOpenSync(MCP_PORT)) return true;
  // 🔴 A(v3.1): 端口未监听 ≠ 没有实例。mcp/start.cjs 在 fork 之前要跑约 60 秒的 tsc 前置
  // 校验，这段窗口内端口是空的——只看端口会在这 2 分钟内再拉起一份看守，与先到的那份互杀。
  if (isLockFresh(path.join(LOCK_DIR, 'start-' + MCP_PORT + '.lock'))) {
    console.error('[harness:auto-start] MCP 看守进程已在启动中（单实例锁新鲜），跳过拉起');
    return true;
  }
  startMCPServer();
  return false;
}

/**
 * 🔴 同步检查进程 + 拉起 Sentinel。
 */
function ensureSentinel(projectRoot) {
  if (sentinelStarted) return true;
  // 🔴 A(v3.1) 修复：原实现拿 `tasklist /FO CSV` 的输出找 "sentinel-service" 字符串，但
  // tasklist 根本不输出命令行（只列映像名/PID/会话/内存）→ 该守卫恒为假 → 每次调用都会
  // 重复拉起哨兵。改为读取哨兵自己写的单实例锁（与 mcp/start.cjs 同一机制）。
  if (isLockFresh(sentinelLockPath(projectRoot))) return true;
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
      // 防控制台闪窗：detached + 无 windowsHide 时 node.exe 会新开一个窗口
      { cwd: HARNESS_DIR, detached: true, stdio: 'ignore', windowsHide: true, env: process.env },
    ).unref();
    console.error('[harness:auto-start] 🔍 Sentinel 后台拉起中 (监控: ' + projectRoot + ')');
  } catch (e) {
    console.error('[harness:auto-start] Sentinel 启动失败: ' + e.message);
  }
}

module.exports = { ensureMCPServer, ensureSentinel };

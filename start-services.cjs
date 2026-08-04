/**
 * start-services.cjs — Harness 全栈服务一键启动
 * ===============================================
 * 同时启动 MCP Server + Sentinel 哨兵，并做健康检查。
 *
 * 使用:
 *   node start-services.cjs                              # 全默认
 *   node start-services.cjs --port 8765 --mcp-only       # 仅 MCP
 *   node start-services.cjs --sentinel-only              # 仅哨兵
 *   node start-services.cjs --status                     # 仅检查状态
 *
 * 开机自启 (Windows):
 *   按 Win+R → shell:startup → 把 start-services.lnk 放进去
 *   或用 Windows Task Scheduler 创建登录时运行的任务：
 *     schtasks /create /tn HarnessStartup /tr "node D:\AI文件\harness\start-services.cjs" /sc onlogon
 */

'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ── 配置 ──

const HARNESS_DIR = path.resolve(__dirname);
const MCP_PORT = parseInt(process.env.HARNESS_MCP_PORT || '8765');
const WENSTAR_ROOT = 'D:/tools/wenstar-cc';
const MCP_HEALTH_URL = `http://127.0.0.1:${MCP_PORT}/sentinel/health`;

const args = process.argv.slice(2);
const mcpOnly = args.includes('--mcp-only');
const sentinelOnly = args.includes('--sentinel-only');
const statusOnly = args.includes('--status');
const dry = args.includes('--dry');

// ── 状态检查 ──

function checkMCPHealth() {
  return new Promise((resolve) => {
    const req = http.get(MCP_HEALTH_URL, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: true, info: JSON.parse(data) }); }
        catch (_) { resolve({ ok: true, info: { raw: data } }); }
      });
    });
    req.on('error', () => resolve({ ok: false, info: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, info: 'timeout' }); });
  });
}

function isProcessRunning(namePattern) {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq node.exe" /FO CSV 2>nul`, {
      encoding: 'utf-8', timeout: 5000, windowsHide: true,
    });
    return out.toLowerCase().includes(namePattern.toLowerCase());
  } catch (_) { return false; }
}

// ── 服务启动 ──

function startMCP() {
  return new Promise((resolve, reject) => {
    console.log('[launcher] 🚀 启动 MCP Server...');

    // 查找 tsx 路径
    let tsxPath = path.join(HARNESS_DIR, 'node_modules', '.bin', 'tsx.cmd');
    if (!fs.existsSync(tsxPath)) tsxPath = path.join(HARNESS_DIR, 'node_modules', '.bin', 'tsx');
    if (!fs.existsSync(tsxPath)) {
      // 尝试全局 npx
      try { tsxPath = execSync('where npx.cmd', { encoding: 'utf-8', windowsHide: true }).trim().split('\n')[0]; }
      catch (_) { tsxPath = 'npx.cmd'; }
    }

    const child = spawn(tsxPath, [path.join(HARNESS_DIR, 'mcp', 'server.ts')], {
      cwd: HARNESS_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HARNESS_MCP_PORT: String(MCP_PORT) },
      windowsHide: true,
    });

    child.stderr.on('data', (chunk) => {
      const msg = String(chunk);
      if (msg.includes('Streamable HTTP MCP Server')) {
        console.log('[launcher]   ✅ MCP Server 启动成功');
        resolve(child);
      }
    });

    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code !== 0) console.error(`[launcher]   ❌ MCP Server 退出 (code: ${code})`);
    });

    // 超时兜底
    setTimeout(() => {
      resolve(child);
      console.log('[launcher]   ⚠️ MCP Server PID:', child.pid);
    }, 8000);
  });
}

function startSentinel() {
  return new Promise((resolve, reject) => {
    console.log('[launcher] 🔍 启动 Sentinel 哨兵...');
    const sentinelPath = path.join(HARNESS_DIR, 'sentinel', 'sentinel-service.cjs');
    const sentinelArgs = ['--project', WENSTAR_ROOT];
    if (dry) sentinelArgs.push('--dry');

    // P7-A3: 使用 fork 替代 spawn — 子进程退出时自动重启
    const child = require('child_process').fork(sentinelPath, sentinelArgs, {
      cwd: HARNESS_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    });

    let hasStarted = false;
    let sentinelFailCount = 0;

    child.stderr.on('data', (chunk) => {
      const msg = String(chunk);
      if (msg.includes('哨兵已就绪')) {
        console.log('[launcher]   ✅ Sentinel 启动成功');
        if (!hasStarted) {
          hasStarted = true;
          resolve(child);
        }
      }
    });

    child.on('error', (err) => reject(err));
    child.on('exit', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGINT') {
        console.log('[launcher] Sentinel 正常退出，不再重启');
        return;
      }
      sentinelFailCount++;
      const delay = Math.min(1000 * Math.pow(2, Math.min(sentinelFailCount, 5)), 32000);
      console.error(`[launcher] ⚠️ Sentinel 异常退出 (code: ${code}), ${delay/1000}s 后重启 (重试: ${sentinelFailCount})`);
      setTimeout(() => startSentinel(), delay);
    });

    setTimeout(() => {
      if (!hasStarted) {
        resolve(child);
        console.log('[launcher]   ⚠️ Sentinel PID:', child.pid);
      }
    }, 10000);
  });
}

// ── 主入口 ──

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Harness 全栈服务启动器 v2.5             ║');
  console.log(`║  MCP Port: ${MCP_PORT}                       ║`);
  console.log(`║  项目: ${WENSTAR_ROOT.slice(0, 35)}║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // 仅状态检查
  if (statusOnly) {
    const mcpHealth = await checkMCPHealth();
    console.log(`[status] MCP Server:  ${mcpHealth.ok ? '✅ 运行中 ' + JSON.stringify(mcpHealth.info) : '❌ 未启动'}`);
    console.log(`[status] Sentinel:    ${isProcessRunning('sentinel-service') ? '✅ 运行中' : '❌ 未启动'}`);
    console.log(`[status] Hook:        ${fs.existsSync(path.join(HARNESS_DIR, '.claude', 'harness-pre-check.cjs')) ? '✅ 文件存在' : '❌ 缺失'}`);
    process.exit(mcpHealth.ok ? 0 : 1);
  }

  const children = [];

  // 启动 MCP Server
  if (!sentinelOnly) {
    try {
      const mcpHealth = await checkMCPHealth();
      if (mcpHealth.ok) {
        console.log('[launcher] MCP Server 已在运行，跳过启动');
      } else {
        const child = await startMCP();
        children.push(child);
        // 等 MCP 完全就绪
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error('[launcher] MCP Server 启动失败:', err.message);
    }
  }

  // 启动 Sentinel
  if (!mcpOnly) {
    try {
      if (isProcessRunning('sentinel-service')) {
        console.log('[launcher] Sentinel 已在运行，跳过启动');
      } else {
        const child = await startSentinel();
        children.push(child);
      }
    } catch (err) {
      console.error('[launcher] Sentinel 启动失败:', err.message);
    }
  }

  // 最终健康检查
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  启动完成 —— 健康检查');
  console.log('═══════════════════════════════════════════');

  const mcpHealth = await checkMCPHealth();
  console.log(`  MCP Server:      ${mcpHealth.ok ? '✅ http://127.0.0.1:' + MCP_PORT : '❌ 未响应'}`);
  console.log(`  Sentinel:        ${isProcessRunning('sentinel-service') ? '✅ 运行中' : '❌ 未启动'}`);
  console.log(`  Hook (pre-check): ${fs.existsSync(path.join(HARNESS_DIR, '.claude', 'harness-pre-check.cjs')) ? '✅' : '❌'}`);
  console.log(`  Hook (post-check):${fs.existsSync(path.join(HARNESS_DIR, '.claude', 'harness-post-check.cjs')) ? '✅' : '❌'}`);
  console.log(`  Tokens dir:      ${fs.existsSync(path.join(HARNESS_DIR, 'data', 'tokens')) ? '✅' : '❌'}`);
  console.log(`  Breaker dir:     ${fs.existsSync(path.join(HARNESS_DIR, 'data', 'breaker')) ? '✅' : '❌'}`);
  console.log(`  YAML flows:      ${fs.existsSync(path.join(HARNESS_DIR, 'data', 'flows', 'wenstaros_core_repair_flow.yaml')) ? '✅ 主流水线 2个' : '❌'}`);
  console.log('═══════════════════════════════════════════');

  // 保持进程存活
  if (children.length > 0) {
    console.log('');
    console.log('[launcher] ✅ 全部服务已启动。按 Ctrl+C 停止所有服务。');
    process.on('SIGINT', () => {
      console.log('[launcher] 停止所有服务...');
      for (const child of children) child.kill();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      for (const child of children) child.kill();
      process.exit(0);
    });
  } else {
    console.log('');
    console.log('[launcher] ℹ️ 所有服务已在运行中，无需启动。');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('[launcher] 启动失败:', err.message);
  process.exit(1);
});

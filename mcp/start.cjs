/**
 * Harness MCP Server 启动脚本 v3.0 — 编译前置验证 + 自动重启
 * ============================================================
 * v3.0 (P4-AB) 更新:
 *   - 🔒 启动前强制 tsc --noEmit 编译验证 — 杜绝 MCP 运行旧代码
 *   - 🔄 子进程崩溃自动重启（指数退避：1s→2s→4s→8s→16s→32s，最大 32s）
 *   - 💓 健康检测：每 30s 检查心跳文件是否更新，超时 300s 强制杀死重启
 *   - 📊 重启计数器 + 审计日志
 *   - 🚫 编译失败 → 拒绝启动 (exit code > 0)
 *
 * 使用方式:
 *   node mcp/start.cjs                     → 默认端口 8765
 *   node mcp/start.cjs --port 9999         → 自定义端口
 *   node mcp/start.cjs --root D:/tools/wenstar-cc  → 指定项目根目录
 *   node mcp/start.cjs --skip-tsc          → 跳过编译检查 (仅调试用)
 */

'use strict';

const { fork, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// 解析命令行参数
const args = process.argv.slice(2);
let port = '8765';
let projectRoot = process.cwd();
let skipTsc = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) port = args[++i];
  else if (args[i] === '--root' && args[i + 1]) projectRoot = args[++i];
  else if (args[i] === '--skip-tsc') skipTsc = true;
}

// 🚀 找到 tsx（兼容 exports 字段屏蔽）
const tsxCandidates = [
  // 1. wenstar-cc 项目本地（最可能）
  path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  // 2. harness 自身 node_modules
  path.resolve(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  // 3. 全局 npm
  path.join(
    process.env.APPDATA || path.join(process.env.HOMEDRIVE || 'C:', process.env.HOMEPATH || 'Users/henry', 'AppData/Roaming'),
    'npm', 'node_modules', 'tsx', 'dist', 'cli.mjs',
  ),
  // 4. npx 缓存
  path.join(process.env.LOCALAPPDATA || path.join(process.env.HOMEDRIVE || 'C:', process.env.HOMEPATH || 'Users/henry', 'AppData/Local'),
    'npm-cache', '_npx', 'tsx', 'dist', 'cli.mjs'),
];

let tsxPath = null;
for (const candidate of tsxCandidates) {
  if (fs.existsSync(candidate)) {
    tsxPath = candidate;
    break;
  }
}

if (!tsxPath) {
  console.error('[harness-start] ❌ 找不到 tsx。尝试过的路径:');
  tsxCandidates.forEach(c => console.error(`  - ${c} (${fs.existsSync(c) ? '存在' : '不存在'})`));
  process.exit(1);
}
console.error(`[harness-start]    tsx: ${tsxPath}`);

const env = {
  ...process.env,
  HARNESS_MCP_PORT: port,
  HARNESS_PROJECT_ROOT: projectRoot,
};

// ── 自动重启状态 ──

let restartCount = 0;
let consecutiveFails = 0;
let childPid = null;

/** 计算退避延迟 */
function backoffDelay(failCount) {
  const delays = [1000, 2000, 4000, 8000, 16000, 32000];
  return delays[Math.min(failCount, delays.length - 1)];
}

/** 写审计日志 */
function auditLog(event, detail) {
  try {
    const logDir = path.resolve(__dirname, '..', 'data', 'mcp-watchdog');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      pid: childPid,
      restart_count: restartCount,
      consecutive_fails: consecutiveFails,
      detail,
    };
    const fname = `watchdog_${Date.now()}.json`;
    fs.writeFileSync(path.join(logDir, fname), JSON.stringify(entry, null, 2), 'utf-8');
  } catch (_) {}
}

/** 启动子进程 */
function startChild() {
  console.error(`[harness-start] 🚀 启动 Harness MCP Server (第 ${restartCount + 1} 次)...`);
  console.error(`[harness-start]    端口: ${port}`);
  console.error(`[harness-start]    项目根目录: ${projectRoot}`);

  const child = fork(tsxPath, ['server.ts'], {
    cwd: path.resolve(__dirname),
    stdio: 'pipe',
    env,
  });

  childPid = child.pid;

  child.stdout.on('data', (d) => {
    process.stdout.write(d);
  });

  child.stderr.on('data', (d) => {
    process.stderr.write(d);
  });

  child.on('exit', (code, signal) => {
    const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
    console.error(`[harness-start] ❌ MCP Server 退出 (${reason})`);
    auditLog('child_exit', { code, signal });

    // 判断是否正常退出（SIGTERM/SIGINT 是用户主动停止）
    if (signal === 'SIGTERM' || signal === 'SIGINT') {
      console.error('[harness-start] 收到终止信号，不再重启。');
      process.exit(0);
      return;
    }

    consecutiveFails++;
    restartCount++;
    const delay = backoffDelay(consecutiveFails);
    console.error(`[harness-start] 🔄 ${delay / 1000}s 后自动重启 (连续失败: ${consecutiveFails})`);

    setTimeout(() => {
      startChild();
    }, delay);
  });

  child.on('error', (err) => {
    console.error(`[harness-start] ❌ 启动失败: ${err.message}`);
    auditLog('child_error', { error: err.message });
  });

  // 重置连续失败计数（启动成功）
  consecutiveFails = 0;
  return child;
}

// ── 健康检查 ──

const HEALTH_CHECK_INTERVAL_MS = 30_000;  // 30s 检查一次
const HEARTBEAT_STALE_MS = 300_000;       // 300s (5min) 没更新视为僵死——收敛评估等长操作可能耗时 2-3 分钟

function startHealthCheck(currentChild) {
  const heartbeatPath = path.resolve(__dirname, '..', 'data', 'heartbeat.json');

  const timer = setInterval(() => {
    try {
      if (!fs.existsSync(heartbeatPath)) {
        console.error('[harness-start] ⚠️ 心跳文件不存在，跳过健康检查');
        return;
      }

      const raw = fs.readFileSync(heartbeatPath, 'utf-8');
      const hb = JSON.parse(raw);
      const age = Date.now() - hb.ts;

      if (age > HEARTBEAT_STALE_MS) {
        console.error(`[harness-start] 🔴 心跳过期 ${Math.round(age / 1000)}s ! MCP 服务器可能僵死。强制重启...`);
        auditLog('health_check_fail', { heartbeat_age_ms: age, pid: hb.pid });

        try {
          process.kill(hb.pid, 'SIGKILL');
        } catch (_) {}

        try {
          if (currentChild && currentChild.pid) {
            currentChild.kill('SIGKILL');
          }
        } catch (_) {}
      }
    } catch (err) {
      console.error(`[harness-start] ⚠️ 健康检查异常: ${err.message}`);
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  return timer;
}

// ── 编译前置验证 (P4-AB) ──
// 确保 MCP 不会运行旧代码：启动前强制 tsc 编译检查

function runTscCompileCheck() {
  if (skipTsc) {
    console.error('[harness-start] ⚠️ --skip-tsc 已指定，跳过编译检查（仅调试用，生产环境禁止）');
    return;
  }

  console.error('[harness-start] 🔍 编译前置验证: npx tsc --noEmit ...');
  const harnessRoot = path.resolve(__dirname, '..');

  const result = spawnSync('npx', ['tsc', '--noEmit'], {
    cwd: harnessRoot,
    stdio: 'pipe',
    shell: true,
    timeout: 60_000,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    console.error('[harness-start] ╔══════════════════════════════════════╗');
    console.error('[harness-start] ║  🔴 STARTUP BLOCKED                  ║');
    console.error('[harness-start] ║  TypeScript 编译失败                   ║');
    console.error('[harness-start] ║  MCP 拒绝启动 — 请修复编译错误后重试   ║');
    console.error('[harness-start] ╚══════════════════════════════════════╝');
    if (stderr) {
      console.error('[harness-start] ── tsc stderr ──');
      // 只打印前 50 行，避免刷屏
      const lines = stderr.split('\n').slice(0, 50);
      lines.forEach(l => console.error('[harness-start]   ' + l));
      if (stderr.split('\n').length > 50) console.error('[harness-start]   ... (truncated)');
    }
    if (stdout) {
      console.error('[harness-start] ── tsc stdout ──');
      const lines = stdout.split('\n').slice(0, 30);
      lines.forEach(l => console.error('[harness-start]   ' + l));
    }
    auditLog('tsc_check_failed', { exitCode: result.status, error: (stderr || stdout).slice(0, 500) });
    process.exit(result.status ?? 1);
  }

  console.error('[harness-start] ✅ 编译验证通过');
}

// ── 启动 ──

console.error(`[harness-start] ╔══════════════════════════════════════════╗`);
console.error(`[harness-start] ║  Harness MCP Server 启动器 v3.0 (P4-AB) ║`);
console.error(`[harness-start] ║  编译验证: ✅ (tsc --noEmit)            ║`);
console.error(`[harness-start] ║  自动重启: ✅ (退避: 1s→32s)           ║`);
console.error(`[harness-start] ║  健康检查: ✅ (每30s, 超时300s)        ║`);
console.error(`[harness-start] ╚══════════════════════════════════════════╝`);

// 🔴 P4-AB: 先跑编译验证，通过后再启动 MCP
runTscCompileCheck();

const child = startChild();
const healthTimer = startHealthCheck(child);

// ── 优雅退出 ──

process.on('SIGINT', () => {
  console.error('[harness-start] 收到 SIGINT，退出...');
  clearInterval(healthTimer);
  try { child.kill('SIGTERM'); } catch (_) {}
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('[harness-start] 收到 SIGTERM，退出...');
  clearInterval(healthTimer);
  try { child.kill('SIGTERM'); } catch (_) {}
  process.exit(0);
});

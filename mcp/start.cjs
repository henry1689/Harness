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

// P6-SECURITY: 验证 HARNESS_TOKEN_SECRET 是否存在
if (!env.HARNESS_TOKEN_SECRET || Buffer.byteLength(env.HARNESS_TOKEN_SECRET, 'utf8') < 32) {
  console.error('[harness-start] ⚠️  HARNESS_TOKEN_SECRET 未设置或不足 32 字节');
  console.error('[harness-start]    Token v2 HMAC 签名将不可用，所有防线将拒绝令牌');
  console.error('[harness-start]    请设置环境变量: HARNESS_TOKEN_SECRET=<至少32字节的随机字符串>');
  console.error('[harness-start]    生成: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

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

/** 检查端口是否被占用（P9-fix: 防 EADDRINUSE 崩溃弹窗） */
function isPortInUse(p) {
  try {
    const { execSync } = require('child_process');
    const out = execSync(`netstat -ano | findstr :${p} | findstr LISTENING`, { encoding: 'utf-8', timeout: 5000, windowsHide: true });
    return out.trim().length > 0;
  } catch (_) { return false; }
}

// ── 🔴 A: 单实例锁（v3.1）──
// 背景（2026-09-11 闪屏事故）：同一 MCP 被 pm2 与 harness-auto-start.cjs 各拉起一份看守进程，
// 两份都走到下面 startChild() 的「端口清理」分支 → 互相 taskkill /F 对方的 server.ts →
// 各自发现子进程死亡又重启 → 互杀永动机，控制台窗口每 ~7 秒闪一轮。
// 锁在 runTscCompileCheck() 之前获取：既避免重复跑 60 秒 tsc，也让败者在互杀逻辑之前退出。
//
// 判定用「mtime 心跳 + TTL」为主、PID 存活为辅：
//   - 持锁者活着 → 心跳每 15s 刷新 mtime，TTL 60s 内均视为有效 → 后来者退出
//   - 持锁者被 taskkill /F（无退出钩子）→ PID 已死 → 立即接管，不必等满 TTL
//   - 仅凭 PID 判定会被 Windows PID 复用误导，故 PID 只作辅助信号
const LOCK_DIR = path.resolve(__dirname, '..', 'data', 'mcp-watchdog');
const LOCK_FILE = path.join(LOCK_DIR, `start-${port}.lock`);
const LOCK_HEARTBEAT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

let lockHeld = false;
let lockTimer = null;

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; } // EPERM = 存在但不属于本进程
}

/** true = 本进程取得锁可以继续；false = 已有实例，本进程应立即退出 */
function acquireSingleInstanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      let ageMs = Infinity;
      let holderPid = null;
      try {
        ageMs = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
        holderPid = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8')).pid;
      } catch (_) { /* 损坏的锁文件按陈旧处理 */ }
      if (ageMs < LOCK_STALE_MS && isPidAlive(holderPid)) return false;
      console.error(`[harness-start] ♻️ 接管陈旧锁（持锁 PID ${holderPid ?? '未知'} 已不在/锁龄 ${Math.round(ageMs / 1000)}s）`);
    }
    if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
      pid: process.pid, port, root: projectRoot, started_at: new Date().toISOString(),
    }, null, 2), 'utf-8');
    lockHeld = true;
    lockTimer = setInterval(() => {
      try { const t = new Date(); fs.utimesSync(LOCK_FILE, t, t); } catch (_) {}
    }, LOCK_HEARTBEAT_MS);
    lockTimer.unref();
    return true;
  } catch (e) {
    // fail-open：锁机制自身故障时宁可承担闪窗风险，也不能让 MCP 起不来
    console.error(`[harness-start] ⚠️ 单实例锁不可用，继续启动: ${e.message}`);
    return true;
  }
}

function releaseSingleInstanceLock() {
  if (!lockHeld) return;
  lockHeld = false;
  if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
  try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
}

/** 端口清理已完成标记（v2.9.1-fix: 只在首次启动清理一次，避免重启循环中反复杀进程闪屏） */
let portCleanupDone = false;

/** 启动子进程 */
function startChild() {
  // 🔴 P9-fix: 端口被占用时先清理残留，避免 EADDRINUSE 崩溃导致频繁弹窗
  // v2.9.1-fix:
  //   1. 端口清理只在首次启动做一次（portCleanupDone）——否则 exit 后重启会再次触发清理，
  //      若 8765 被自己刚 fork 的 server.ts 瞬占 → taskkill 强杀自己 → exit → 再重启 → 死循环闪屏。
  //   2. taskkill 前排除 childPid（自己 fork 的子进程）——不误杀自己刚起的 server.ts。
  //   3. 清理失败有上限，不无限循环。
  if (!portCleanupDone && isPortInUse(port)) {
    portCleanupDone = true;
    console.error(`[harness-start] ⚠️ 端口 ${port} 被占用，尝试清理残留进程（仅首次）...`);
    try {
      const { execSync } = require('child_process');
      // 找到占用端口的 PID 并杀掉（排除自身 与 自己 fork 的子进程）
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf-8', timeout: 5000, windowsHide: true });
      const pid = (out.match(/\s(\d+)\s*$/) || [])[1];
      const isSelfChild = childPid && pid && (pid === String(childPid) || pid === String(process.pid));
      if (pid && !isSelfChild) {
        execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf-8', timeout: 5000, windowsHide: true });
        console.error(`[harness-start] ✅ 已清理残留进程 PID ${pid}`);
      } else if (pid && isSelfChild) {
        console.error(`[harness-start] ⚠️ 端口 ${port} 被自己子进程占用，不杀，等待其 listen`);
      }
    } catch (e) {
      console.error(`[harness-start] ⚠️ 清理失败: ${e.message}`);
    }
    // 等端口释放（有上限，不无限循环）
    const start = Date.now();
    while (isPortInUse(port) && Date.now() - start < 5000) {
      require('child_process').execSync('ping -n 2 127.0.0.1 >nul', { stdio: 'ignore', windowsHide: true });
    }
  }

  console.error(`[harness-start] 🚀 启动 Harness MCP Server (第 ${restartCount + 1} 次)...`);
  console.error(`[harness-start]    端口: ${port}`);
  console.error(`[harness-start]    项目根目录: ${projectRoot}`);

  const child = fork(tsxPath, ['server.ts'], {
    cwd: path.resolve(__dirname),
    stdio: 'pipe',
    // 防控制台闪窗：pm2 fork 出来的父进程无控制台，spawn 控制台子系统程序会新建窗口
    windowsHide: true,
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

  // P6-FIX: 不在 fork() 返回时立即重置退避计数
  // 退避计数在 health check 确认心跳正常后才重置
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
        // P7-C7: 先确认 PID 仍存活再强杀
        try { process.kill(hb.pid, 0); } catch (_) {
          console.error(`[harness-start] 🔴 心跳过期但 PID ${hb.pid} 已不存在，跳过健康检查`);
          return;
        }

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
      } else {
        // P6-FIX: 心跳正常 → 子进程运行稳定 → 重置退避计数
        if (consecutiveFails > 0) {
          console.error(`[harness-start] ✅ 心跳正常 (${Math.round(age / 1000)}s) → 重置退避计数 (原: ${consecutiveFails})`);
          consecutiveFails = 0;
        }
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
    shell: true, // npx 在 Windows 是 .cmd，必须经 shell 解析
    // 防控制台闪窗：shell:true 会先起 cmd.exe，无 windowsHide 时整棵进程树都会弹窗
    windowsHide: true,
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
console.error(`[harness-start] ║  Harness MCP Server 启动器 v3.1 (A+B) ║`);
console.error(`[harness-start] ║  单实例锁: ✅ (锁文件+心跳, 防互杀)    ║`);
console.error(`[harness-start] ║  编译验证: ✅ (tsc --noEmit)            ║`);
console.error(`[harness-start] ║  自动重启: ✅ (退避: 1s→32s)           ║`);
console.error(`[harness-start] ║  健康检查: ✅ (每30s, 超时300s)        ║`);
console.error(`[harness-start] ╚══════════════════════════════════════════╝`);

// 🔴 A(v3.1): 单实例闸门——先抢锁，败者立即退出，避免与另一份看守互杀
if (!acquireSingleInstanceLock()) {
  console.error(`[harness-start] 🛑 已有 MCP 看守进程在运行（锁 ${LOCK_FILE}），本进程退出。`);
  console.error('[harness-start]    如确认前一份已死，删除该锁文件后重试。');
  process.exit(0);
}
console.error(`[harness-start] 🔐 单实例锁已取得: ${LOCK_FILE}`);

// 🔴 P4-AB: 先跑编译验证，通过后再启动 MCP
runTscCompileCheck();

const child = startChild();
const healthTimer = startHealthCheck(child);

// ── 优雅退出 ──

process.on('SIGINT', () => {
  console.error('[harness-start] 收到 SIGINT，退出...');
  clearInterval(healthTimer);
  releaseSingleInstanceLock();
  try { child.kill('SIGTERM'); } catch (_) {}
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('[harness-start] 收到 SIGTERM，退出...');
  clearInterval(healthTimer);
  releaseSingleInstanceLock();
  try { child.kill('SIGTERM'); } catch (_) {}
  process.exit(0);
});

// 兜底：正常退出路径（含 tsc 校验失败 exit）也要放锁，否则残留锁会挡住下一次启动
process.on('exit', () => { releaseSingleInstanceLock(); });

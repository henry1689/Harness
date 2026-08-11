/**
 * Harness PM2 进程管理配置 (P7-D: 基于环境变量的可移植配置)
 * ==========================================================
 * 管理 MCP Server + Sentinel 哨兵两个核心服务。
 *
 * 环境变量:
 *   HARNESS_ROOT          — Harness 项目根目录 (默认: process.cwd())
 *   WENSTAR_CC_ROOT       — 被管控项目根目录 (默认: D:/tools/wenstar-cc，v2.7 固化防退化)
 *   HARNESS_MCP_PORT      — MCP 服务端口 (默认: 8765)
 *   HARNESS_TOKEN_SECRET  — Token v2 HMAC 密钥 (至少 32 字节)
 *
 * 日常使用:
 *   pm2 start ecosystem.config.cjs      # 启动全部
 *   pm2 stop all                        # 停止全部
 *   pm2 restart all                     # 重启全部
 *   pm2 status                          # 查看状态
 *   pm2 logs                            # 查看日志
 *   pm2 save                            # 保存进程列表(配合 pm2 startup 开机自启)
 */

const path = require('path');
const fs = require('fs');
const HARNESS_ROOT = process.env.HARNESS_ROOT || process.cwd();
const WENSTAR_ROOT = process.env.WENSTAR_CC_ROOT || 'D:/tools/wenstar-cc';

// 🔴 C4-fix: 统一签名 secret——从 data/.harness-secret 读取真实随机 secret。
// 不再使用公开占位符（占位符被 Agent 读到即可伪造签名）。
// 生成: node -e "require('fs').writeFileSync('data/.harness-secret', require('crypto').randomBytes(48).toString('hex'))"
function loadSignSecret() {
  try {
    const f = path.join(HARNESS_ROOT, 'data', '.harness-secret');
    if (fs.existsSync(f)) {
      const s = fs.readFileSync(f, 'utf-8').trim();
      if (s && Buffer.byteLength(s, 'utf8') >= 32) return s;
    }
  } catch (_) {}
  // 无 secret 文件 → MCP 签名工具将 fail-closed（拒绝解锁），比占位符更安全
  return '';
}

module.exports = {
  apps: [
    {
      name: 'harness-mcp',
      script: 'mcp/start.cjs',
      cwd: HARNESS_ROOT,
      args: `--root ${WENSTAR_ROOT}`,
      interpreter: 'node',
      // 崩溃自动重启
      autorestart: true,
      // 最大重启次数(15次/秒内超过3次 → 停止重启，防止死循环)
      max_restarts: 3,
      restart_delay: 2000,
      // 启动后等3秒再判定为"online"
      listen_timeout: 5000,
      // 日志 — P7-D: 基于运行时路径解析
      error_file: path.join(HARNESS_ROOT, 'data', 'logs', 'mcp-error.log'),
      out_file: path.join(HARNESS_ROOT, 'data', 'logs', 'mcp-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      // 环境变量
      env: {
        NODE_ENV: 'production',
        HARNESS_MCP_PORT: '8765',
        // v2.7: 跟随 WENSTAR_ROOT，消除硬编码歧义（会被 start.cjs --root 覆盖，但保持一致）
        HARNESS_PROJECT_ROOT: WENSTAR_ROOT,
        // P6-SECURITY + C4-fix: Token v2 HMAC 签名密钥。
        // 优先系统环境变量（用户设了真实 secret 用它），否则读 data/.harness-secret 文件。
        // 两者都缺 → MCP 解锁工具 fail-closed（拒绝），绝不使用公开占位符。
        HARNESS_TOKEN_SECRET: process.env.HARNESS_TOKEN_SECRET || loadSignSecret(),
      },
      // 进程被杀后延迟重启
      kill_timeout: 5000,
      // Windows 兼容
      kill_retry_time: 100,
    },
    {
      name: 'harness-sentinel',
      script: 'sentinel/sentinel-service.cjs',
      cwd: HARNESS_ROOT,
      args: `--project ${WENSTAR_ROOT}`,
      interpreter: 'node',
      autorestart: true,
      max_restarts: 3,
      restart_delay: 2000,
      listen_timeout: 3000,
      error_file: path.join(HARNESS_ROOT, 'data', 'logs', 'sentinel-error.log'),
      out_file: path.join(HARNESS_ROOT, 'data', 'logs', 'sentinel-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      // MED-7-fix: sentinel 也需要 secret，否则 MCP 不可达时本地降级拒绝所有 v2 令牌 → 合法编辑被回滚
      env: {
        NODE_ENV: 'production',
        HARNESS_TOKEN_SECRET: process.env.HARNESS_TOKEN_SECRET || loadSignSecret(),
      },
      kill_timeout: 5000,
      kill_retry_time: 100,
    },
    {
      // 🔴 M1-fix: Harness 自身监控 — 独立 Sentinel 盯 D:/AI文件/harness
      // 防止 Agent 用 Bash 直接改写防线自身（pre-check/mcp/sentinel/scripts/.claude）而不被回滚。
      // WATCH_ROOTS 覆盖: src/ .claude/ mcp/ sentinel/ scripts/ hooks/ data/flows/
      name: 'harness-self-sentinel',
      script: 'sentinel/sentinel-service.cjs',
      cwd: HARNESS_ROOT,
      args: `--project ${HARNESS_ROOT}`,
      interpreter: 'node',
      autorestart: true,
      max_restarts: 3,
      restart_delay: 2000,
      listen_timeout: 3000,
      error_file: path.join(HARNESS_ROOT, 'data', 'logs', 'self-sentinel-error.log'),
      out_file: path.join(HARNESS_ROOT, 'data', 'logs', 'self-sentinel-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      // MED-7-fix: 同上，self-sentinel 也需 secret 才能验证 harness 自身编辑的 token
      env: {
        NODE_ENV: 'production',
        HARNESS_TOKEN_SECRET: process.env.HARNESS_TOKEN_SECRET || loadSignSecret(),
      },
      kill_timeout: 5000,
      kill_retry_time: 100,
    },
    {
      name: 'harness-dashboard',
      script: 'dashboard/server.cjs',
      cwd: HARNESS_ROOT,
      interpreter: 'node',
      autorestart: true,
      max_restarts: 3,
      restart_delay: 2000,
      listen_timeout: 3000,
      error_file: path.join(HARNESS_ROOT, 'data', 'logs', 'dashboard-error.log'),
      out_file: path.join(HARNESS_ROOT, 'data', 'logs', 'dashboard-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        HARNESS_DASHBOARD_PORT: '8766',
        // v2.7: 显式传给 dashboard，使其读被管控项目路径（dashboard/server.cjs L31 读此 env）
        WENSTAR_CC_ROOT: WENSTAR_ROOT,
      },
      kill_timeout: 3000,
    },
    {
      // 🐶 链路自愈看门狗 — 检测 MCP/Sentinel/Hook 心跳断链并自动重启
      name: 'harness-watchdog',
      script: 'scripts/harness-watchdog.cjs',
      cwd: HARNESS_ROOT,
      interpreter: 'node',
      autorestart: true,
      max_restarts: 5,
      restart_delay: 3000,
      listen_timeout: 3000,
      error_file: path.join(HARNESS_ROOT, 'data', 'logs', 'watchdog-error.log'),
      out_file: path.join(HARNESS_ROOT, 'data', 'logs', 'watchdog-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
      },
      kill_timeout: 3000,
    },
    {
      // 📁 WenStarOS 轻量监控 — 独立盯 WenStarOS 源码目录（非git，只监控+审计）
      name: 'wenstaros-watch',
      script: 'scripts/wenstaros-watch.cjs',
      cwd: HARNESS_ROOT,
      interpreter: 'node',
      autorestart: true,
      max_restarts: 5,
      restart_delay: 3000,
      listen_timeout: 3000,
      error_file: path.join(HARNESS_ROOT, 'data', 'logs', 'wenstaros-watch-error.log'),
      out_file: path.join(HARNESS_ROOT, 'data', 'logs', 'wenstaros-watch-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
      },
      kill_timeout: 3000,
    },
  ],
};

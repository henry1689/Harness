/**
 * Harness PM2 进程管理配置 (P7-D: 基于环境变量的可移植配置)
 * ==========================================================
 * 管理 MCP Server + Sentinel 哨兵两个核心服务。
 *
 * 环境变量:
 *   HARNESS_ROOT          — Harness 项目根目录 (默认: process.cwd())
 *   WENSTAR_CC_ROOT       — 被管控项目根目录 (默认: process.cwd()，或通过 --root 传参)
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
const HARNESS_ROOT = process.env.HARNESS_ROOT || process.cwd();
const WENSTAR_ROOT = process.env.WENSTAR_CC_ROOT || process.cwd();

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
        HARNESS_PROJECT_ROOT: 'D:/tools/wenstar-cc',
        // P6-SECURITY: Token v2 HMAC 签名密钥（至少 32 字节）
        // 生成: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
        HARNESS_TOKEN_SECRET: process.env.HARNESS_TOKEN_SECRET || 'CHANGE_ME__GENERATE_WITH_randomBytes_32',
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
      env: {
        NODE_ENV: 'production',
      },
      kill_timeout: 5000,
      kill_retry_time: 100,
    },
  ],
};

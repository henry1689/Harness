/**
 * Harness MCP Server 启动脚本
 * =============================
 * 使用方式:
 *   node mcp/start.cjs                     → 默认端口 8765
 *   node mcp/start.cjs --port 9999         → 自定义端口
 *   node mcp/start.cjs --root D:/tools/wenstar-cc  → 指定项目根目录
 *
 * 生产环境建议:
 *   - 注册为 Windows Service（sc create HarnessMCP binPath= "node ..."）
 *   - 或使用 pm2: pm2 start mcp/start.cjs --name harness-mcp
 */

'use strict';

const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

// 解析命令行参数
const args = process.argv.slice(2);
let port = '8765';
let projectRoot = process.cwd();

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) port = args[++i];
  else if (args[i] === '--root' && args[i + 1]) projectRoot = args[++i];
}

// 🚀 找到 tsx
// 先尝试项目本地的 tsx，再尝试全局的
let tsxPath;
try {
  tsxPath = require.resolve('tsx/dist/cli.mjs', { paths: [path.resolve(__dirname, '..')] });
} catch (_) {
  // 查找全局 node_modules 中的 tsx
  const homeNodeModules = path.join(
    process.env.APPDATA || path.join(process.env.HOMEDRIVE || 'C:', process.env.HOMEPATH || 'Users/henry', 'AppData/Roaming'),
    'npm', 'node_modules',
  );
  tsxPath = path.join(homeNodeModules, 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxPath)) {
    console.error('[harness-start] ❌ 找不到 tsx，请先安装: npm install -g tsx');
    process.exit(1);
  }
}

const env = {
  ...process.env,
  HARNESS_MCP_PORT: port,
  HARNESS_PROJECT_ROOT: projectRoot,
};

console.error(`[harness-start] 🚀 启动 Harness MCP Server...`);
console.error(`[harness-start]    端口: ${port}`);
console.error(`[harness-start]    项目根目录: ${projectRoot}`);

const child = fork(tsxPath, ['server.ts'], {
  cwd: path.resolve(__dirname),
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => {
  console.error(`[harness-start] MCP Server 退出 (code: ${code})`);
});

process.on('SIGINT', () => { child.kill(); process.exit(0); });
process.on('SIGTERM', () => { child.kill(); process.exit(0); });

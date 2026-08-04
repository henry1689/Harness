/**
 * harness-service.cjs — Windows Service 注册/卸载 (P7-D)
 * ========================================================
 * 将 Harness 注册为 Windows Service，实现开机自启和独立身份运行。
 *
 * 安装:
 *   node scripts/harness-service.cjs --install
 *
 * 卸载:
 *   node scripts/harness-service.cjs --uninstall
 *
 * 查询状态:
 *   node scripts/harness-service.cjs --status
 *
 * 依赖: 需要 PM2 已全局安装 (npm i -g pm2)
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SERVICE_NAME = 'HarnessGuard';
const HARNESS_ROOT = process.env.HARNESS_ROOT || process.cwd();
const ECOSYSTEM_PATH = path.join(HARNESS_ROOT, 'ecosystem.config.cjs');

function findPm2() {
  // 尝试多个路径找到 pm2
  const candidates = [
    'pm2',
    path.join(process.env.APPDATA || '', 'npm', 'pm2.cmd'),
    path.join(process.env.APPDATA || '', 'npm', 'pm2'),
    path.join(process.env.LOCALAPPDATA || '', 'npm', 'pm2.cmd'),
  ];
  for (const c of candidates) {
    try {
      execSync(`"${c}" --version`, { timeout: 5000, windowsHide: true });
      return c;
    } catch (_) {}
  }
  return null;
}

const args = process.argv.slice(2);
const mode = args[0];

if (mode === '--install' || mode === '--setup') {
  console.log('[HarnessService] 🔧 注册 Windows Service...');

  const pm2Path = findPm2();
  if (!pm2Path) {
    console.error('[HarnessService] ❌ 未找到 PM2。请先安装: npm i -g pm2');
    process.exit(1);
  }

  if (!fs.existsSync(ECOSYSTEM_PATH)) {
    console.error(`[HarnessService] ❌ 未找到 ecosystem 配置: ${ECOSYSTEM_PATH}`);
    process.exit(1);
  }

  console.log(`[HarnessService]    PM2: ${pm2Path}`);
  console.log(`[HarnessService]    Ecosystem: ${ECOSYSTEM_PATH}`);
  console.log(`[HarnessService]    项目根: ${HARNESS_ROOT}`);

  // 先启动 PM2（如果还没启动）
  try { execSync(`"${pm2Path}" ping`, { timeout: 3000, windowsHide: true }); } catch (_) {
    console.log('[HarnessService] 启动 PM2 daemon...');
    execSync(`"${pm2Path}" start ${ECOSYSTEM_PATH}`, { cwd: HARNESS_ROOT, windowsHide: true });
  }

  // 注册 Windows Service
  // sc.exe 最多支持 1024 字符的 binPath，需要谨慎
  const binPath = `cmd.exe /c "${pm2Path}" start ${ECOSYSTEM_PATH} --no-daemon && "${pm2Path}" logs`;

  try {
    // 先删除旧服务（如果存在）
    try { execSync(`sc.exe delete ${SERVICE_NAME}`, { timeout: 5000, windowsHide: true }); } catch (_) {}

    execSync(`sc.exe create ${SERVICE_NAME} binPath= "${binPath}" start= auto DisplayName= "Harness Guardian Service"`, { timeout: 10000 });
    console.log(`[HarnessService] ✅ Service "${SERVICE_NAME}" 已注册 (start=auto)`);

    // 设置恢复选项：失败后重启
    execSync(`sc.exe failure ${SERVICE_NAME} reset= 86400 actions= restart/5000/restart/10000/restart/30000`, { timeout: 5000 });
    console.log('[HarnessService] ✅ 恢复策略: 失败后自动重启 (5s/10s/30s)');

    // 启动服务
    execSync(`sc.exe start ${SERVICE_NAME}`, { timeout: 30000 });
    console.log(`[HarnessService] ✅ Service "${SERVICE_NAME}" 已启动`);
  } catch (err) {
    console.error(`[HarnessService] ❌ 注册失败: ${err.message || err}`);
    console.error('[HarnessService] 提示: 需要管理员权限。请以管理员身份运行 PowerShell/CMD');
    process.exit(1);
  }

} else if (mode === '--uninstall') {
  try {
    execSync(`sc.exe stop ${SERVICE_NAME}`, { timeout: 30000, windowsHide: true });
  } catch (_) {}
  try {
    execSync(`sc.exe delete ${SERVICE_NAME}`, { timeout: 10000, windowsHide: true });
  } catch (_) {}
  console.log(`[HarnessService] 🔓 Service "${SERVICE_NAME}" 已停止并删除`);

} else if (mode === '--status') {
  try {
    const out = execSync(`sc.exe query ${SERVICE_NAME}`, { timeout: 5000, encoding: 'utf-8', windowsHide: true });
    console.log(out);
  } catch (_) {
    console.log(`[HarnessService] Service "${SERVICE_NAME}" 未安装`);
    process.exit(1);
  }

} else {
  console.log(`Harness Windows Service Manager (P7-D)

用法:
  node scripts/harness-service.cjs --install    注册并启动 Windows Service (需管理员)
  node scripts/harness-service.cjs --uninstall  停止并删除 Windows Service (需管理员)
  node scripts/harness-service.cjs --status     查看服务状态`);
}

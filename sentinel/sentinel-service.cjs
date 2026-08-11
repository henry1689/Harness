/**
 * sentinel-service.cjs — Harness 文件系统哨兵 (Sentinel) 主入口 v2.0
 * ====================================================================
 * 独立常驻进程，监控受管控项目的文件变更。
 * 未经授权（无令牌）的修改自动 git checkout 回滚。
 *
 * v2.0 更新:
 *   - 批量写入检测：500ms 窗口内聚合多次文件变更，统一处理
 *   - 异步回滚：支持 Git 锁竞争重试（指数退避）
 *   - 批量回滚：同一批次文件按顺序回滚，互不阻塞
 *
 * 启动方式:
 *   node sentinel/sentinel-service.cjs                                    # 默认配置
 *   node sentinel/sentinel-service.cjs --project D:/tools/wenstar-cc      # 指定项目
 *   node sentinel/sentinel-service.cjs --project xxx --dry                # 干运行模式(仅记录不操作)
 */

'use strict';

const path = require('path');
const fs = require('fs');

const { createWatcher } = require('./watcher.cjs');
const { createRollback } = require('./rollback.cjs');
const { checkFile } = require('./sentinel-mcp-client.cjs');
const { createEscalation } = require('./escalation.cjs');
const { loadRiskPolicy } = require('../scripts/risk-policy-loader.cjs');

// ── 命令行参数 ──

const args = process.argv.slice(2);
let projectRoot = '';
let dryRun = false;
let unlockPassword = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project' && args[i + 1]) projectRoot = args[++i];
  else if (args[i] === '--dry') dryRun = true;
  else if (args[i] === '--unlock') {
    // 标记为解锁模式 — 稍后处理
    process.env.__SENTINEL_UNLOCK = args[++i] || '';
  }
  else if (args[i] === '--minutes') {
    // 豁免时长（分钟）— 配合 --unlock 使用
    process.env.__SENTINEL_UNLOCK_MINUTES = args[++i] || '30';
  }
  else if (args[i] === '--password') {
    // 管理员密码 — 配合 --unlock 使用（防 Agent 自行豁免）
    unlockPassword = args[++i] || '';
  }
}

// 处理 --unlock 命令
if (process.env.__SENTINEL_UNLOCK !== undefined) {
  const unlockFile = process.env.__SENTINEL_UNLOCK;
  if (!projectRoot) {
    console.error('[sentinel] --unlock 需要同时指定 --project <项目根目录>');
    process.exit(1);
  }
  // 🔴 S2-安全收紧 ①: --unlock 必须带管理员密码校验，否则拒绝
  // 原因: 此前 --unlock 无任何身份校验，Agent 有 Bash 权限可自行豁免任意文件。
  // 现在必须与 .harness-pass 校验通过才能豁免。--password 未提供或错误 → 拒绝。
  if (!unlockPassword) {
    console.error('[sentinel] 🔴 已启用密码保护: --unlock 必须带 --password <管理员密码>');
    console.error('[sentinel]     用法: node sentinel-service.cjs --project <根> --unlock <file> --minutes <N> --password <密码>');
    process.exit(1);
  }
  const { verifyPassword } = require('../scripts/pass-core.cjs');
  const pwOk = verifyPassword(unlockPassword);
  if (!pwOk) {
    console.error('[sentinel] 🔴 解锁被拒: 管理员密码错误。豁免未签发。');
    process.exit(1);
  }
  const minutes = parseInt(process.env.__SENTINEL_UNLOCK_MINUTES || '30', 10) || 30;
  const { createEscalation: _CE } = require('./escalation.cjs');
  const _esc = _CE(projectRoot);
  _esc.manualUnlock(unlockFile, minutes);
  console.error(`[sentinel] 🔓 已手动解锁: ${unlockFile} (豁免 ${minutes} 分钟)`);
  process.exit(0);
}

if (!projectRoot) {
  console.error('[sentinel] 用法: node sentinel-service.cjs --project <项目根目录> [--dry]');
  console.error('[sentinel] 示例: node sentinel-service.cjs --project D:/tools/wenstar-cc');
  process.exit(1);
}

projectRoot = path.resolve(projectRoot);
const auditDir = path.resolve(__dirname, '..', 'data', 'sentinel');

// P7-A: 多目录监控 — Sentinel 现在覆盖 Harness 自身基础设施 + 被管控项目
// 从统一风险策略 (risk-policy.json) 加载高风险目录，动态生成监测目标
const riskPolicy = loadRiskPolicy(path.resolve(__dirname, '..', 'scripts'));
const WATCH_ROOTS = [
  'src/',         // 被管控项目源文件（必须）
  '.claude/',     // P7: Harness 钩子脚本
  'mcp/',         // P7: MCP 服务实现
  'sentinel/',    // P7: 哨兵自身（防篡改）
  'scripts/',     // P7: 关键防线脚本
  'hooks/',       // P7: Git hooks
  'data/flows/',  // P7: 流水线定义
];

if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });

// MED-4 决策: 不把 data/sessions + data/tokens 加入哨兵监控。
// 原因: 这些目录被合法流程（unlock 签发 / MCP 令牌签发）高频写入，
//       Sentinel 监控会导致正常签发被回滚（误伤）。「绕过流程的 Bash 直接写」
//       已由 scripts/bash-write-guard.cjs 覆盖（关键路径写操作 DENY）。

// ── 配置 ──

/** 批量写入检测窗口 (ms) — 此时间内连续变更视为同一批次 */
const BATCH_WINDOW_MS = 500;

/** 批次处理最大文件数 — 超过告警（防脚本批量篡改） */
const BATCH_ALERT_THRESHOLD = 3;

// ── 统计 ──

const stats = {
  startedAt: new Date().toISOString(),
  events: 0,
  allowed: 0,
  reverted: 0,
  errors: 0,
  batches: 0,
};

// ── 哨兵 ──

const rollback = createRollback(projectRoot);
const escalation = createEscalation(projectRoot);

/** 批次队列 */
let batchQueue = [];
let batchTimer = null;

/**
 * 刷新批次 — 处理当前批次中的所有文件变更。
 * 每个文件独立令牌检查 → 独立回滚，互不影响。
 */
async function flushBatch() {
  if (batchQueue.length === 0) return;
  const batch = [...batchQueue];
  batchQueue = [];
  stats.batches++;

  const batchId = stats.batches;
  const fileList = batch.map(b => b.filePath).join(', ');

  if (batch.length >= BATCH_ALERT_THRESHOLD) {
    console.error(`[sentinel] ⚠️ 批量写入检测 [批次#${batchId}]: ${batch.length} 个文件在 ${BATCH_WINDOW_MS}ms 内被修改`);
    console.error(`[sentinel]    文件: ${fileList}`);
    console.error(`[sentinel]    ⚡ 疑似脚本批量打补丁，启动增强审查`);
  }

  for (const item of batch) {
    await processFileChange(item.filePath, batch.length >= BATCH_ALERT_THRESHOLD);
  }

  // 批次处理完毕后，对失败的文件做一次整体重试
  if (batch.length >= BATCH_ALERT_THRESHOLD) {
    console.error(`[sentinel] ✅ 批次#${batchId} 处理完成: ${batch.length} 个文件`);
  }
}

/**
 * 处理单个文件变更。
 * @param {string} filePath - 相对于项目根目录的文件路径
 * @param {boolean} isBatchAlert - 是否来自批量告警（增强日志）
 */
async function processFileChange(filePath, isBatchAlert) {
  // P6-FIX: 外层 try/catch 防止未捕获异常导致 Sentinel 进程崩溃
  try {
    stats.events++;
    const timestamp = new Date().toISOString();

    const prefix = isBatchAlert ? '[sentinel:batch]' : '[sentinel]';
    console.error(`${prefix} 📁 文件变更: ${filePath} (#${stats.events})`);

    // 🔴 P9-fix: 解锁豁免 — 手动 unlock 的文件在 30 分钟内跳过 token 检查
    // 原因: 手动解锁只清物理锁，但 token 被消费后 checkFile 仍判无效 → 回滚。
    // 豁免让 Agent 在解锁期内能正常写入高风险文件（如 SQLiteAdapter 40D 改造）。
    // 注意: watcher 传的 filePath 可能不带 src/ 前缀（webui/...），
    // manualUnlock 存的 key 是带前缀的（src/webui/...），需两种都试。
    const exemptPath = String(filePath).replace(/\\/g, '/');
    const exemptHit = escalation.isExempt(exemptPath) ||
      (exemptPath.startsWith('src/') ? escalation.isExempt(exemptPath.slice(4)) : escalation.isExempt('src/' + exemptPath));
    if (exemptHit) {
      stats.allowed++;
      console.error(`${prefix} ✅ 解锁豁免放行: ${filePath} — 手动解锁 30 分钟内跳过 token 检查`);
      archiveEvent('allowed', { file: filePath, risk: 'high', reason: '解锁豁免 (manual unlock)', timestamp });
      return;
    }

    // 查令牌
    const result = await checkFile(filePath, { project: projectRoot });

  if (result.allowed) {
    stats.allowed++;
    console.error(`${prefix} ✅ 放行: ${filePath} — ${result.reason}`);
    archiveEvent('allowed', { file: filePath, risk: result.risk, reason: result.reason, timestamp });
    return;
  }

  // 未授权 → 回滚
  console.error(`${prefix} 🚫 拦截: ${filePath} — ${result.reason}`);

  const revertResult = await rollback.revert(filePath, { dryRun });

  if (revertResult.reverted) {
    stats.reverted++;
    archiveEvent('reverted', {
      file: filePath, risk: result.risk, reason: result.reason,
      hash: revertResult.hash, attempts: revertResult.attempts, timestamp,
    });

    // ── 升级判定 ──
    const escResult = escalation.recordRevert(filePath, { risk: result.risk, reason: result.reason });

    if (revertResult.attempts > 1) {
      console.error(`${prefix} ↩ 已回滚（${revertResult.attempts}次重试）: ${filePath} → ${revertResult.hash}`);
    } else {
      console.error(`${prefix} ↩ 已回滚: ${filePath} → ${revertResult.hash}`);
    }
    if (escResult.escalated) {
      console.error(`${prefix} ${escResult.action}`);
    }
  } else if (revertResult.dryRun) {
    stats.reverted++;
    archiveEvent('reverted', {
      file: filePath, risk: result.risk, reason: result.reason,
      diff: revertResult.diff, dryRun: true, timestamp,
    });
    console.error(`${prefix} 🔍 [DRY-RUN] 将回滚: ${filePath} (${revertResult.diff})`);
  } else {
    stats.errors++;
    archiveEvent('error', {
      file: filePath, error: revertResult.error || 'unknown',
      reason: result.reason, attempts: revertResult.attempts, timestamp,
    });
    console.error(`${prefix} ❌ 回滚失败: ${filePath} — ${revertResult.error || revertResult.reason || 'unknown'}`);
    if (revertResult.attempts >= 5) {
      console.error(`${prefix} 🔴 严重: ${filePath} 5次重试全部失败，文件可能已被篡改且无法自动恢复！`);
    }
  }
  } catch (err) {
    stats.errors++;
    console.error(`[sentinel] ❌ processFileChange 异常: ${err.message || err} (file: ${filePath})`);
    try {
      archiveEvent('error', { file: filePath, error: err.message || String(err), timestamp: new Date().toISOString() });
    } catch (_) {}
  }
}

/** 文件变更事件入口 — P7: 支持多目录监控，不再强制补 src/ 前缀 */
function onFileChanged(relPath) {
  let filePath = relPath.replace(/\\/g, '/');
  const normalizedProjectRoot = projectRoot.replace(/\\/g, '/');
  if (filePath.startsWith(normalizedProjectRoot + '/')) {
    filePath = filePath.slice(normalizedProjectRoot.length + 1);
  }
  // 确认文件路径匹配已知的监控根目录之一（排除完全无关的路径）
  const inWatchedDir = WATCH_ROOTS.some(r => filePath.startsWith(r.replace(/\\/g, '/')));
  if (!inWatchedDir) {
    // 不在已知监控目录中 → 尝试补 src/ 前缀（兼容 watcher 裸文件名）
    filePath = 'src/' + filePath;
  }

  // P6-FIX: 批量队列上限，防止 DoS 无限延迟回滚
  const BATCH_MAX_SIZE = 100;
  if (batchQueue.length >= BATCH_MAX_SIZE) {
    console.error(`[sentinel] ⚠️ 批量队列已达上限 ${BATCH_MAX_SIZE}，强制 flush 防止 DoS`);
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    flushBatch();
    return;
  }

  // ── 批次聚合 ──
  // 同一窗口内的文件变更进入同一批次
  batchQueue.push({ filePath, time: Date.now() });

  // 重置批次定时器 — 每次新变更都延长窗口
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = setTimeout(() => {
    batchTimer = null;
    flushBatch();
  }, BATCH_WINDOW_MS);
}

/** 审计归档 */
function archiveEvent(type, detail) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(auditDir, today);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fname = `${type}_${Date.now()}.json`;
    fs.writeFileSync(path.join(dir, fname), JSON.stringify(detail, null, 2), 'utf-8');
  } catch (err) { console.error(`[sentinel] ⚠️ 审计归档失败: ${err.message}`); }
}

// ── 启动（P7: 多目录监控）──

console.error(`[sentinel] ╔══════════════════════════════════════════╗`);
console.error(`[sentinel] ║  Harness 文件系统哨兵 v2.1               ║`);
console.error(`[sentinel] ║  版本: v2.1 (多目录监控 + P7安全加固)    ║`);
console.error(`[sentinel] ║  项目: ${projectRoot.padEnd(34)}║`);
console.error(`[sentinel] ║  模式: ${dryRun ? '干运行 DRY-RUN'.padEnd(34) : '实时回滚 LIVE'.padEnd(34)}║`);
console.error(`[sentinel] ║  监控: ${WATCH_ROOTS.length} 个目录`.padEnd(46) + '║');
console.error(`[sentinel] ╚══════════════════════════════════════════╝`);

// 为每个监控根目录创建独立 watcher
const watchers = [];
// S4 三轮评审决定: 回退 MED-3（.claude 深度监控）。
// 原因: 引入两个 HIGH 新问题（.claude/harness 幻影前缀误判保护区 + onFileChanged 路径错拼导致轮询监控失效），
//       且 watcher 默认排除 .claude 是防自写回滚的必要设计。.claude 防线文件保护改由 bash-write-guard 承担。
for (const root of WATCH_ROOTS) {
  const fullPath = path.join(projectRoot, root);
  if (!fs.existsSync(fullPath)) {
    console.error(`[sentinel] ⚠️ 监控目录不存在，跳过: ${root}`);
    continue;
  }
  try {
    const w = createWatcher(fullPath, onFileChanged);
    w.start();
    watchers.push({ root, watcher: w });
  } catch (err) {
    console.error(`[sentinel] ⚠️ 无法监控 ${root}: ${err.message}`);
  }
}

if (watchers.length === 0) {
  console.error('[sentinel] ❌ 没有任何可监控的目录，退出');
  process.exit(1);
}
console.error(`[sentinel] ✅ 已启动 ${watchers.length}/${WATCH_ROOTS.length} 个监控器`);

// ── 定期状态报告（P7: 汇总所有 watcher）──

setInterval(() => {
  const uptime = Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000);
  const m = Math.floor(uptime / 60);
  const s = uptime % 60;
  const totalTracked = watchers.reduce((sum, w) => sum + w.watcher.getTrackedCount(), 0);
  console.error(`[sentinel] 📊 运行 ${m}m${s}s | 事件: ${stats.events} | 放行: ${stats.allowed} | 回滚: ${stats.reverted} | 错误: ${stats.errors} | 批次: ${stats.batches} | 监控: ${watchers.length}目录/${totalTracked}文件`);
}, 300_000); // 每 5 分钟

// ── 优雅退出 ──

process.on('SIGINT', () => {
  console.error('[sentinel] 收到 SIGINT，退出...');
  if (batchQueue.length > 0) {
    console.error(`[sentinel] 处理残留批次: ${batchQueue.length} 个文件...`);
  }
  if (batchTimer) clearTimeout(batchTimer);
  for (const w of watchers) w.watcher.stop();
  const uptime = Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000);
  console.error(`[sentinel] 运行 ${uptime}s, 共处理 ${stats.events} 个事件, ${stats.reverted} 次回滚, ${stats.batches} 个批次`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (batchTimer) clearTimeout(batchTimer);
  for (const w of watchers) w.watcher.stop();
  process.exit(0);
});

// ── 进程存活信号 ──

console.error(`[sentinel] ✅ 哨兵已就绪 v2.1 (PID: ${process.pid}, 批量窗口: ${BATCH_WINDOW_MS}ms, 监控: ${watchers.length} 个目录, 升级模块: 激活)`);

// ── P9 心跳：哨兵每次状态报告写 sentinel-heartbeat.json（供 watchdog 链路检测）──
const SENTINEL_HEARTBEAT_FILE = path.join(auditDir, '..', 'sentinel-heartbeat.json');
function writeSentinelHeartbeat() {
  try {
    const uptime = Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000);
    const totalTracked = watchers.reduce((sum, w) => sum + w.watcher.getTrackedCount(), 0);
    const dir = path.dirname(SENTINEL_HEARTBEAT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SENTINEL_HEARTBEAT_FILE, JSON.stringify({
      ts: Date.now(),
      pid: process.pid,
      projectRoot,
      uptime,
      events: stats.events,
      allowed: stats.allowed,
      reverted: stats.reverted,
      errors: stats.errors,
      watchers: watchers.length,
      trackedFiles: totalTracked,
      mode: dryRun ? 'DRY-RUN' : 'LIVE',
    }));
  } catch (err) { console.error(`[sentinel] ⚠️ 心跳写入失败: ${err.message}`); }
}

// 立即写一次 + 每 30 秒刷新（比 5 分钟状态报告更细粒度，watchdog 依赖它）
writeSentinelHeartbeat();
setInterval(writeSentinelHeartbeat, 30_000);

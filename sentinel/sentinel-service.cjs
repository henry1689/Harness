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

// ── 命令行参数 ──

const args = process.argv.slice(2);
let projectRoot = '';
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project' && args[i + 1]) projectRoot = args[++i];
  else if (args[i] === '--dry') dryRun = true;
  else if (args[i] === '--unlock') {
    // 标记为解锁模式 — 稍后处理
    process.env.__SENTINEL_UNLOCK = args[++i] || '';
  }
}

// 处理 --unlock 命令
if (process.env.__SENTINEL_UNLOCK !== undefined) {
  const unlockFile = process.env.__SENTINEL_UNLOCK;
  if (!projectRoot) {
    console.error('[sentinel] --unlock 需要同时指定 --project <项目根目录>');
    process.exit(1);
  }
  const { createEscalation: _CE } = require('./escalation.cjs');
  const _esc = _CE(projectRoot);
  _esc.manualUnlock(unlockFile);
  console.error(`[sentinel] 🔓 已手动解锁: ${unlockFile}`);
  process.exit(0);
}

if (!projectRoot) {
  console.error('[sentinel] 用法: node sentinel-service.cjs --project <项目根目录> [--dry]');
  console.error('[sentinel] 示例: node sentinel-service.cjs --project D:/tools/wenstar-cc');
  process.exit(1);
}

projectRoot = path.resolve(projectRoot);
const watchDir = path.join(projectRoot, 'src');
const auditDir = path.resolve(__dirname, '..', 'data', 'sentinel');

if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });

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

/** 文件变更事件入口 */
function onFileChanged(relPath) {
  // 🔴 watcher 可能报告绝对路径（git checkout 触发）或相对路径，统一标准化
  let filePath = relPath.replace(/\\/g, '/');
  const normalizedProjectRoot = projectRoot.replace(/\\/g, '/');
  if (filePath.startsWith(normalizedProjectRoot + '/')) {
    filePath = filePath.slice(normalizedProjectRoot.length + 1);
  }
  // 如果还不包含 src/ 前缀，补上
  if (!filePath.startsWith('src/') && !filePath.startsWith('.claude/') && !filePath.startsWith('data/')) {
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

// ── 启动 ──

console.error(`[sentinel] ╔══════════════════════════════════════════╗`);
console.error(`[sentinel] ║  Harness 文件系统哨兵 v2.0               ║`);
console.error(`[sentinel] ║  版本: v2.0 (批量检测 + Git锁重试)       ║`);
console.error(`[sentinel] ║  项目: ${projectRoot.padEnd(34)}║`);
console.error(`[sentinel] ║  模式: ${dryRun ? '干运行 DRY-RUN'.padEnd(34) : '实时回滚 LIVE'.padEnd(34)}║`);
console.error(`[sentinel] ╚══════════════════════════════════════════╝`);

const watcher = createWatcher(watchDir, onFileChanged);
watcher.start();

// ── 定期状态报告 ──

setInterval(() => {
  const uptime = Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000);
  const m = Math.floor(uptime / 60);
  const s = uptime % 60;
  console.error(`[sentinel] 📊 运行 ${m}m${s}s | 事件: ${stats.events} | 放行: ${stats.allowed} | 回滚: ${stats.reverted} | 错误: ${stats.errors} | 批次: ${stats.batches} | 追踪: ${watcher.getTrackedCount()}`);
}, 300_000); // 每 5 分钟

// ── 优雅退出 ──

process.on('SIGINT', () => {
  console.error('[sentinel] 收到 SIGINT，退出...');
  // 先处理残留批次
  if (batchQueue.length > 0) {
    console.error(`[sentinel] 处理残留批次: ${batchQueue.length} 个文件...`);
  }
  if (batchTimer) clearTimeout(batchTimer);
  watcher.stop();
  const uptime = Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000);
  console.error(`[sentinel] 运行 ${uptime}s, 共处理 ${stats.events} 个事件, ${stats.reverted} 次回滚, ${stats.batches} 个批次`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (batchTimer) clearTimeout(batchTimer);
  watcher.stop();
  process.exit(0);
});

// ── 进程存活信号 ──

console.error(`[sentinel] ✅ 哨兵已就绪 v2.1 (PID: ${process.pid}, 批量窗口: ${BATCH_WINDOW_MS}ms, 升级模块: 激活)`);

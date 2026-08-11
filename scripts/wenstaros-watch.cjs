#!/usr/bin/env node
/**
 * wenstaros-watch.cjs — WenStarOS 轻量文件监控器
 * ==============================================
 * 独立监控 WenStarOS 项目（非 git 场景），只检测文件变更 + 审计 + 心跳，
 * 不做 git 回滚（项目非 git）。与 wenstar-cc 的 harness-sentinel 完全独立，互不影响。
 *
 * 监控目标: D:/WST/wenstar-os-tianshu-lab/WenStarOS
 * 监控目录: data-lab/ data-test/ docs-lab/ harness-lab/ release-candidate/
 *
 * 零 LLM，纯文件系统，复用 sentinel/watcher.cjs
 *
 * 用法:
 *   node scripts/wenstaros-watch.cjs
 *   PM2: pm2 start ecosystem.config.cjs --only wenstaros-watch
 */

'use strict';

const path = require('path');
const fs = require('fs');

const HARNESS_DIR = path.resolve(__dirname, '..');
const { createWatcher } = require(path.join(HARNESS_DIR, 'sentinel', 'watcher.cjs'));

// ── 配置 ──
// 🔴 P9: 监控实际源码目录（Lab 隔离工作区的核心代码），排除缓存/日志
const WENSTAROS_ROOT = 'D:/WST/wenstar-os-tianshu-lab/WenStarOS';
const WATCH_DIRS = ['wenstar-cc', 'wenstar_os'];  // TS 源码 + Python
const AUDIT_DIR = path.join(HARNESS_DIR, 'data', 'wenstaros-audit');
const HEARTBEAT_FILE = path.join(HARNESS_DIR, 'data', 'wenstaros-heartbeat.json');

// 监控的文件后缀（TS + Python + 配置）
const WATCH_SUFFIXES = ['.ts', '.py', '.json', '.yaml', '.yml', '.cjs', '.mjs', '.js'];

// 排除的缓存/日志目录（watcher 的 excludeDirs）
const EXCLUDE_DIRS = ['node_modules', '.git', 'dist', '.cache', '.tmp', '.var', '.pytest_cache', '.claude', '.vscode', '.husky', '.sandbox-data'];

// ── 状态 ──
const stats = { startedAt: new Date().toISOString(), events: 0, changes: [] };

// ── 审计写入 ──
function archiveEvent(type, detail) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(AUDIT_DIR, today);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fname = `${type}_${Date.now()}.json`;
    fs.writeFileSync(path.join(dir, fname), JSON.stringify(detail, null, 2), 'utf-8');
  } catch (err) { console.error(`[wenstaros-watch] ⚠️ 审计归档失败: ${err.message}`); }
}

// ── 心跳写入 ──
function writeHeartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({
      ts: Date.now(),
      pid: process.pid,
      root: WENSTAROS_ROOT,
      events: stats.events,
      uptime: Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000),
    }));
  } catch (_) {}
}

// ── 文件变更回调 ──
function onFileChanged(relPath) {
  const now = new Date().toISOString();
  stats.events++;
  // 只监控指定后缀（watcher 已过滤，这里再兜底）
  const suffix = path.extname(relPath).toLowerCase();
  if (WATCH_SUFFIXES.includes(suffix)) {
    console.error(`[wenstaros-watch] 📁 变更: ${relPath} (#${stats.events})`);
    archiveEvent('change', { file: relPath, timestamp: now, event: stats.events });
  }
}

// ── 启动 ──
console.error(`[wenstaros-watch] ╔═══════════════════════════════════════╗`);
console.error(`[wenstaros-watch] ║  WenStarOS 轻量文件监控器 v1.0        ║`);
console.error(`[wenstaros-watch] ║  项目: ${WENSTAROS_ROOT.slice(0, 40).padEnd(40)}║`);
console.error(`[wenstaros-watch] ║  模式: 仅监控+审计 (非git，不回滚)     ║`);
console.error(`[wenstaros-watch] ║  零 LLM · 纯文件系统                   ║`);
console.error(`[wenstaros-watch] ╚═══════════════════════════════════════╝`);

const watchers = [];
for (const dir of WATCH_DIRS) {
  const fullPath = path.join(WENSTAROS_ROOT, dir);
  if (!fs.existsSync(fullPath)) {
    console.error(`[wenstaros-watch] ⚠️ 监控目录不存在，跳过: ${dir}`);
    continue;
  }
  try {
    const w = createWatcher(fullPath, onFileChanged, { excludeDirs: EXCLUDE_DIRS });
    w.start();
    watchers.push({ dir, watcher: w });
  } catch (err) {
    console.error(`[wenstaros-watch] ⚠️ 无法监控 ${dir}: ${err.message}`);
  }
}

if (watchers.length === 0) {
  console.error('[wenstaros-watch] ❌ 没有可监控目录，退出');
  process.exit(1);
}

writeHeartbeat();
setInterval(writeHeartbeat, 30_000);

// 定期状态
setInterval(() => {
  const total = watchers.reduce((s, w) => s + w.watcher.getTrackedCount(), 0);
  console.error(`[wenstaros-watch] 📊 运行 ${Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000)}s | 事件: ${stats.events} | 监控: ${watchers.length}目录/${total}文件`);
}, 300_000);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

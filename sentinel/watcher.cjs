/**
 * watcher.js — 文件系统哨兵
 * ============================
 * 监控指定目录的 .ts 文件变更（零外部依赖，纯 Node.js）。
 *
 * 输出: 检测到变更 → 回调通知 onFileChanged(filePath)
 *
 * 使用:
 *   const watcher = createWatcher('D:/tools/wenstar-cc/src', onChanged);
 *   watcher.start();
 *   watcher.stop();
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── 配置 ──

/** 防抖窗口 (ms) — 同一文件在此时间内重复变更只触发一次 */
const DEBOUNCE_MS = 300;

/** 轮询间隔 (ms) — 比 fs.watch 可靠，Windows 下推荐 */
const POLL_INTERVAL_MS = 800;

/** 忽略的文件后缀 */
const IGNORE_SUFFIXES = ['.test.ts', '.spec.ts', '.d.ts'];
/** 忽略的目录 */
const IGNORE_DIRS = ['node_modules', '__tests__', '.git', 'dist', '.claude'];
/** 监控的文件后缀 */
const WATCH_SUFFIXES = ['.ts', '.json', '.yaml', '.yml', '.cjs', '.mjs', '.js'];

// ── 导出 ──

/**
 * 创建文件监控哨兵。
 *
 * @param {string} watchDir - 要监控的目录
 * @param {(filePath: string) => void} onChange - 文件变更回调
 * @param {{ debounceMs?: number, pollMs?: number, excludeDirs?: string[] }} opts
 */
function createWatcher(watchDir, onChange, opts = {}) {
  if (!fs.existsSync(watchDir)) {
    throw new Error(`监控目录不存在: ${watchDir}`);
  }

  const debounceMs = opts.debounceMs || DEBOUNCE_MS;
  const pollMs = opts.pollMs || POLL_INTERVAL_MS;
  const excludeDirs = opts.excludeDirs || IGNORE_DIRS;

  /** @type {Map<string, { mtime: number, timer: NodeJS.Timeout|null }>} */
  const fileState = new Map();

  let running = false;
  let pollTimer = null;
  let fsWatcher = null;

  function normalize(p) {
    return p.replace(/\\/g, '/');
  }

  function shouldWatch(filePath) {
    const n = normalize(filePath);
    // 忽略目录
    for (const dir of excludeDirs) {
      if (n.includes('/' + dir + '/') || n.endsWith('/' + dir)) return false;
    }
    // 忽略测试文件
    for (const suffix of IGNORE_SUFFIXES) {
      if (n.endsWith(suffix)) return false;
    }
    // 只看源代码/配置
    for (const suffix of WATCH_SUFFIXES) {
      if (n.endsWith(suffix)) return true;
    }
    return false;
  }

  function fileChanged(filePath) {
    if (!shouldWatch(filePath)) return;

    const entry = fileState.get(filePath);
    const now = Date.now();

    if (entry) {
      // 防抖：同一文件在 debounceMs 内重复触发 → 重置定时器
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        const stat = fs.statSync(filePath, { throwIfNoEntry: false });
        const mtime = stat ? stat.mtimeMs : now;
        if (mtime > entry.mtime + 50) {
          entry.mtime = mtime;
          onChange(filePath);
        }
      }, debounceMs);
    } else {
      // 首次检测
      const stat = fs.statSync(filePath, { throwIfNoEntry: false });
      const mtime = stat ? stat.mtimeMs : now;
      fileState.set(filePath, { mtime, timer: null });
      // 不给首次变更发回调（只有真正的修改才触发）
    }
  }

  /** 扫描目录，发现新增/变更文件 */
  function scanDir(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = normalize(path.relative(watchDir, fullPath));

        if (entry.isDirectory()) {
          if (!excludeDirs.includes(entry.name)) scanDir(fullPath);
        } else if (entry.isFile() && shouldWatch(relPath)) {
          const stat = fs.statSync(fullPath, { throwIfNoEntry: false });
          if (!stat) continue;
          const existing = fileState.get(relPath);
          if (!existing) {
            fileState.set(relPath, { mtime: stat.mtimeMs, timer: null });
          } else if (stat.mtimeMs > existing.mtime + 50) {
            // mtime 变了 → 文件被修改
            existing.mtime = stat.mtimeMs;
            onChange(relPath);
          }
        }
      }
    } catch (_) { /* 目录不可读 → 跳过 */ }
  }

  // ── 公开 API ──

  /** 启动监控 */
  function start() {
    if (running) return;
    running = true;

    console.error(`[sentinel:watcher] 🔍 开始监控: ${watchDir}`);
    console.error(`[sentinel:watcher]    防抖: ${debounceMs}ms  轮询: ${pollMs}ms`);

    // 先全量扫描，建立基线
    scanDir(watchDir);

    // 双重监控：fs.watch（实时）+ 轮询（兜底）
    try {
      fsWatcher = fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
        if (!filename || eventType !== 'change') return;
        const absPath = path.join(watchDir, filename);
        const relPath = normalize(filename);
        if (shouldWatch(relPath)) {
          fileChanged(absPath);
        }
      });
      fsWatcher.on('error', () => { /* 静默处理 */ });
    } catch (_) {
      console.error('[sentinel:watcher] fs.watch 启动失败，仅用轮询模式');
    }

    // 轮询兜底（fs.watch 在 Windows 上偶发漏报）
    pollTimer = setInterval(() => scanDir(watchDir), pollMs);
  }

  /** 停止监控 */
  function stop() {
    running = false;
    if (fsWatcher) { fsWatcher.close(); fsWatcher = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    // 清理所有 pending 定时器
    for (const [, entry] of fileState) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    fileState.clear();
    console.error('[sentinel:watcher] ⏹ 监控已停止');
  }

  /** 获取当前追踪的文件数 */
  function getTrackedCount() {
    return fileState.size;
  }

  return { start, stop, getTrackedCount, scanDir };
}

module.exports = { createWatcher };

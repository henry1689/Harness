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
/** 忽略的目录 — P7: __tests__ 通过环境变量 HARNESS_SENTINEL_MONITOR_TESTS=1 可开启监控 */
// v2.9: dist 纳入治理（哈希基线 + 自愈）— 从忽略目录移除
const IGNORE_DIRS_BASE = ['node_modules', '.git', '.claude'];
/** 监控的文件后缀 — P7: 扩展至 Harness 自身文件类型 */
const WATCH_SUFFIXES = ['.ts', '.json', '.yaml', '.yml', '.cjs', '.mjs', '.js'];

/** P7: 是否监控测试目录（默认跳过） */
const MONITOR_TESTS = process.env.HARNESS_SENTINEL_MONITOR_TESTS === '1';

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
  // P7: __tests__ 排除可通过 MONITOR_TESTS 环境变量控制
  const excludeDirs = opts.excludeDirs || (MONITOR_TESTS ? IGNORE_DIRS_BASE : [...IGNORE_DIRS_BASE, '__tests__']);

  /** @type {Map<string, { mtime: number, timer: NodeJS.Timeout|null }>} */
  const fileState = new Map();

  let running = false;
  let pollTimer = null;
  let fsWatcher = null;
  let initialScanDone = false; // 🔴 P9: 标记首次扫描是否完成（首次只登记不触发，避免启动误报）

  function normalize(p) {
    return p.replace(/\\/g, '/');
  }

  function shouldWatch(filePath) {
    const n = normalize(filePath);
    // 忽略目录（v2.13-fix: 补 startsWith 相对路径头匹配——relPath 如 node_modules/x.ts 开头即排除，
    // 防 fs.watch 通道在相对路径下把 node_modules 等嵌套文件漏放行）
    for (const dir of excludeDirs) {
      if (n.startsWith(dir + '/') || n.includes('/' + dir + '/') || n.endsWith('/' + dir)) return false;
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

  function fileChanged(absPath) {
    // 🔴 P0-fix v2 (S4 评审): key 与轮询 scanDir 统一为「相对 watchDir」路径，
    // 但 statSync 必须用绝对路径——哨兵进程 cwd 是 HARNESS_ROOT，相对路径解析不到 watchDir 下文件。
    const relPath = normalize(path.relative(watchDir, absPath));
    // 🔴 v2.13-fix: 排除判断用 relPath（.claude 是 excludeDirs，若用 absPath 则 .claude root 下
    // 所有文件的绝对路径都含 /.claude/ 子串 → 被排除 → .claude 实时通道全失效）
    if (!shouldWatch(relPath)) return;
    const entry = fileState.get(relPath);
    const now = Date.now();

    if (entry) {
      // 防抖：同一文件在 debounceMs 内重复触发 → 重置定时器
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        const stat = fs.statSync(absPath, { throwIfNoEntry: false });
        const mtime = stat ? stat.mtimeMs : now;
        if (mtime > entry.mtime + 50) {
          entry.mtime = mtime;
          onChange(relPath);
        }
      }, debounceMs);
    } else {
      // 首次检测 — P9-fix 语义对齐: 运行期首见也触发 onChange（对齐 scanDir），
      // 否则 fs.watch 先到登记 + 轮询被 mtime 闸门挡住 → 单次写入的新文件绕过 Sentinel。
      const stat = fs.statSync(absPath, { throwIfNoEntry: false });
      const mtime = stat ? stat.mtimeMs : now;
      fileState.set(relPath, { mtime, timer: null });
      if (initialScanDone) onChange(relPath);
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
            // 🔴 P9-fix: 新文件也触发 onChange（原来只登记不触发 → Agent 新建的源文件修改全部漏报）
            // 原因: Agent 改造时会新建文件并持续修改（如 perception-40d 系列），
            // "首次登记不触发"导致新文件的创建和后续修改都不被 Sentinel 检测到。
            fileState.set(relPath, { mtime: stat.mtimeMs, timer: null });
            // 启动时首次全量扫描会触发所有已有文件（误报）→ 用 IS_INITIAL_SCAN 标记跳过
            if (!initialScanDone) {
              // 首次扫描：登记不触发
            } else {
              onChange(relPath); // 运行中新增文件 → 触发事件
            }
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

    // 先全量扫描，建立基线（首次扫描只登记不触发，避免把存量文件当新事件）
    scanDir(watchDir);
    initialScanDone = true;

    // 双重监控：fs.watch（实时）+ 轮询（兜底）
    try {
      fsWatcher = fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
        if (!filename || eventType !== 'change') return;
        // 🔴 P0-fix (2026-08-14): Windows fs.watch 递归回调偶发返回绝对路径，
        // 原逻辑 path.join(watchDir, filename) 把它当相对段硬拼 → 回调拼 root 前缀后
        // 产生 src/D:/tools/... 幽灵双前缀 → 误拦截 + 回滚失败 + 日志风暴。
        // 统一：绝对路径直接用、相对路径才 join watchDir；fileChanged 内用绝对路径 statSync、relPath 作 key 并统一判断。
        // v2.13-fix: 排除判断统一在 fileChanged 内用 relPath 做（.claude root 下 absPath 恒含 /.claude/ 会自排除）
        const absPath = path.isAbsolute(filename) ? filename : path.join(watchDir, filename);
        fileChanged(absPath);
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

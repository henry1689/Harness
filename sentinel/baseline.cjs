/**
 * baseline.cjs — 受管文件「最后授权内容」基线（Sentinel 回滚缺陷修复）
 * ====================================================================
 * 🔴 背景（2026-09-10 事故）
 *   旧回滚实现是 `git checkout -- <file>`，语义为「用 **index（暂存区）** 覆盖工作区」，
 *   而非「恢复编辑前内容」。后果：拦截回滚会连该文件**全部未暂存改动**一起抹掉
 *   （实证：src/types.ts 的 enhance-v1 类型扩展被销毁 → tsc 21 处报错）。
 *   附带：文件若有已暂存改动，`git checkout --` 后 `git status` 仍为 `M ` → 校验恒判失败。
 *
 * ✅ 本模块提供正确语义：为每个受管文件保存「最后一次**被授权**写入后的内容」。
 *    - 启动时全量建立基线（内容是磁盘现状，不丢任何东西）；
 *    - 每次**授权**写入（令牌有效 / 豁免命中）后刷新基线；
 *    - 未授权写入 → 从基线恢复 = 精确撤销本次未授权改动，不触碰其它任何工作。
 *
 * 存储：data/sentinel/baseline/<项目指纹>/{index.json, files/<sha1(relPath)>.bin}
 *   - 放在 data/sentinel/ 下（**不在** Sentinel 的 WATCH_ROOTS 内）→ 写基线不会触发新事件，避免自激循环。
 *   - 内容以 Buffer 原样保存（二进制安全）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HARNESS_ROOT = path.resolve(__dirname, '..');
const BASELINE_ROOT = path.join(HARNESS_ROOT, 'data', 'sentinel', 'baseline');

/** 内容哈希（sha256，十六进制） */
function hashBuf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 项目指纹：规范化绝对路径的短哈希（Windows 大小写不敏感 → 统一小写） */
function projectKey(projectRoot) {
  const norm = String(projectRoot).replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 12);
}

/** 归一化相对路径（统一正斜杠） */
function norm(relPath) {
  return String(relPath).replace(/\\/g, '/');
}

/**
 * 创建某项目的基线管理器。
 * @param {string} projectRoot - 被监控项目根目录（绝对路径）
 */
function createBaseline(projectRoot) {
  const dir = path.join(BASELINE_ROOT, projectKey(projectRoot));
  const filesDir = path.join(dir, 'files');
  const indexFile = path.join(dir, 'index.json');

  /** @type {Record<string, { hash: string, size: number, snap: string, at: string }>} */
  let index = {};
  let loaded = false;

  function ensureDirs() {
    if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
  }

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      if (fs.existsSync(indexFile)) {
        const j = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
        if (j && typeof j === 'object' && j.files && typeof j.files === 'object') index = j.files;
      }
    } catch (_) {
      index = {}; // 索引损坏 → 视为无基线（后续 refresh 重建）
    }
  }

  function save() {
    try {
      ensureDirs();
      fs.writeFileSync(indexFile, JSON.stringify({ project_root: projectRoot, updated_at: new Date().toISOString(), files: index }, null, 2), 'utf-8');
    } catch (_) { /* 索引写失败不影响内存态；下次 refresh 重写 */ }
  }

  function snapName(relPath) {
    return crypto.createHash('sha256').update(norm(relPath)).digest('hex').slice(0, 32) + '.bin';
  }

  function absOf(relPath) {
    return path.join(projectRoot, norm(relPath));
  }

  /** 读取磁盘当前内容（不存在 → null） */
  function readCurrent(relPath) {
    try {
      const abs = absOf(relPath);
      if (!fs.existsSync(abs)) return null;
      return fs.readFileSync(abs);
    } catch (_) { return null; }
  }

  /** 该路径是否已有基线 */
  function has(relPath) {
    load();
    return Object.prototype.hasOwnProperty.call(index, norm(relPath));
  }

  /** 磁盘当前内容哈希（不存在 → null） */
  function currentHash(relPath) {
    const buf = readCurrent(relPath);
    return buf === null ? null : hashBuf(buf);
  }

  /**
   * 以磁盘当前内容刷新基线（**授权写入后调用**）。
   * @returns {{ok:boolean, hash?:string, reason?:string}}
   */
  function refresh(relPath) {
    load();
    const key = norm(relPath);
    const buf = readCurrent(key);
    if (buf === null) {
      // 文件已删除且被授权 → 移除基线（删除本身是授权行为）
      if (index[key]) { delete index[key]; save(); }
      return { ok: true, reason: '文件不存在，基线已移除' };
    }
    try {
      ensureDirs();
      const snap = snapName(key);
      fs.writeFileSync(path.join(filesDir, snap), buf);
      index[key] = { hash: hashBuf(buf), size: buf.length, snap, at: new Date().toISOString() };
      save();
      return { ok: true, hash: index[key].hash };
    } catch (err) {
      return { ok: false, reason: (err && err.message) || String(err) };
    }
  }

  /** 仅当基线不存在时建立（启动全量初始化用） */
  function init(relPath) {
    if (has(relPath)) return { ok: true, skipped: true };
    return refresh(relPath);
  }

  /**
   * 从基线恢复该文件（撤销未授权改动）。
   * 幂等：内容已与基线一致 → 返回 `already`，调用方不应计为错误/升级。
   * @returns {{restored:boolean, already?:boolean, hash?:string, reason?:string}}
   */
  function restore(relPath) {
    load();
    const key = norm(relPath);
    const entry = index[key];
    if (!entry) return { restored: false, reason: '无基线（未建立或已移除）——拒绝破坏性回滚' };

    const snapPath = path.join(filesDir, entry.snap);
    let buf;
    try {
      if (!fs.existsSync(snapPath)) return { restored: false, reason: '基线快照文件缺失' };
      buf = fs.readFileSync(snapPath);
    } catch (err) {
      return { restored: false, reason: `基线快照读取失败: ${(err && err.message) || err}` };
    }

    const cur = readCurrent(key);
    if (cur !== null && hashBuf(cur) === hashBuf(buf)) {
      return { restored: false, already: true, hash: entry.hash, reason: '内容已与基线一致（免重复回滚）' };
    }

    try {
      const abs = absOf(key);
      const parent = path.dirname(abs);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(abs, buf);
      return { restored: true, hash: entry.hash };
    } catch (err) {
      return { restored: false, reason: `写回失败: ${(err && err.message) || err}` };
    }
  }

  /**
   * 启动全量播种：对监控根目录下所有「哨兵会监控的文件」建立基线（仅补缺失项，不覆盖已有）。
   *
   * 🔴 必要性：回滚 = 恢复到基线。若基线为空，回滚只能 fail-loud（拒绝破坏性回滚），
   *    哨兵对「哨兵启动前就存在的文件」将失去回滚能力 → 防御退化。
   *    故启动时必须先把磁盘现状登记为「已知状态」。
   *
   * 过滤规则**镜像 watcher.cjs 的 shouldWatch**（root 相对路径判定，与 watcher 语义一致）；
   * 二者不一致只会导致基线覆盖范围略有差异（良性），不会造成误删。
   *
   * @param {string[]} roots - 监控根目录（相对 projectRoot，如 'src/'）
   * @returns {{seeded:number, skipped:number, failed:number, dirs:number}}
   */
  function seedDirs(roots) {
    const IGNORE_DIRS = ['node_modules', '.git', '.claude', '__tests__'];
    const IGNORE_SUFFIXES = ['.test.ts', '.spec.ts', '.d.ts'];
    const WATCH_SUFFIXES = ['.ts', '.json', '.yaml', '.yml', '.cjs', '.mjs', '.js'];

    function watchable(rel) {
      const n = norm(rel);
      for (const d of IGNORE_DIRS) {
        if (n.startsWith(d + '/') || n.includes('/' + d + '/') || n.endsWith('/' + d)) return false;
      }
      for (const s of IGNORE_SUFFIXES) if (n.endsWith(s)) return false;
      return WATCH_SUFFIXES.some(s => n.endsWith(s));
    }

    let seeded = 0, skipped = 0, failed = 0, dirs = 0;

    function walk(absDir, rootAbs) {
      let entries;
      try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const abs = path.join(absDir, e.name);
        if (e.isDirectory()) {
          if (!IGNORE_DIRS.includes(e.name)) walk(abs, rootAbs);
        } else if (e.isFile()) {
          const relRoot = norm(path.relative(rootAbs, abs)); // 相对监控根
          if (!watchable(relRoot)) continue;
          const relProject = norm(path.relative(projectRoot, abs)); // 相对项目根（基线 key）
          if (has(relProject)) { skipped++; continue; }
          if (refresh(relProject).ok) seeded++; else failed++;
        }
      }
    }

    for (const root of roots) {
      const rootAbs = path.join(projectRoot, norm(root));
      if (!fs.existsSync(rootAbs)) continue;
      dirs++;
      walk(rootAbs, rootAbs);
    }

    // 写一次索引（refresh 内部已按需 save，这里确保空跑也落盘元数据）
    save();
    return { seeded, skipped, failed, dirs };
  }

  /** 基线统计 */
  function stats() {
    load();
    return { count: Object.keys(index).length, dir };
  }

  return { has, currentHash, refresh, init, restore, seedDirs, stats, dir };
}

module.exports = { createBaseline, BASELINE_ROOT, projectKey };

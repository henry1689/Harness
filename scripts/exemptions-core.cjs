#!/usr/bin/env node
/**
 * exemptions-core.cjs — Harness 豁免数据层（v2.9 新增，共享）
 * ======================================================================
 * 统一 data/exemptions.json 的读写，替换 escalation.cjs / pre-check / sentinel-service
 * 四处手写解析。核心：
 *   - v1/v2 兼容：v1 `{路径: 过期毫秒}`、v2 `{version:2, exemptions:{路径:{...}}}`
 *   - load-merge-write：签发新豁免不覆盖已有条目（修复 v1 并发解锁互相覆盖 bug）
 *   - 签发审计：写 data/audit/exemptions/issue_*.json（谁/为什么/豁免什么）
 *
 * 豁免语义（v2.9 核心变更）：
 *   豁免 ≠ 完全放行。豁免只放宽指定检查（relaxed_checks），仍要求流水线令牌。
 *   operations: 允许的工具类型白名单（edit/write），空 = 不限
 *   relaxed_checks: 只放宽哪些检查（S4.5_complexity / breaker / cooldown）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HARNESS_DIR = path.resolve(__dirname, '..');

/**
 * 🔴 2026-10-15：`HARNESS_EXEMPTIONS_FILE` 覆盖改为**显式放行**。
 *
 * 原实现是一个裸的 env 覆盖 —— 一个环境变量就能把**整份豁免台账**指到别处，
 * 而且 `AUDIT_DIR` 是写死的 ⇒ **台账与审计可以分家**（台账在 A、审计在 B）。
 * 同类教训本仓已多次踩：**能被静默改变的判据来源**。
 *
 * 现要求同时设 `HARNESS_ALLOW_EXEMPTIONS_FILE_OVERRIDE=1` 才生效；否则忽略并大声告警。
 * 这不是安全增强（同用户进程都能改 env），而是把「静默改判据来源」变成**显式且可见**。
 *
 * ⚠️ 台账被覆盖时**审计目录一并跟随**（见下方 AUDIT_DIR），否则又是一处台账/审计分家。
 */
const DEFAULT_EXEMPTIONS_FILE = path.join(HARNESS_DIR, 'data', 'exemptions.json');
const DEFAULT_AUDIT_DIR = path.join(HARNESS_DIR, 'data', 'audit', 'exemptions');

let _overrideWarned = false;
function _warnOverride(msg) {
  if (_overrideWarned) return;
  _overrideWarned = true;
  console.error('[exemptions-core] 🔴 ' + msg);
}

/**
 * 🔴 2026-10-15：**延迟**解析台账路径（不做成模块级 const）。
 *
 * 为什么延迟：本文件与 `src/s7/s7AutoArchive.ts` **各自读了一次** `HARNESS_EXEMPTIONS_FILE`
 * （本仓反复踩的「多真相源」）。s7 那侧是**调用时**读 env，本侧是**模块加载时**定死 ——
 * 两侧在同一进程里可能指向不同文件：测试先 import 本模块、再设 env 就会分家。
 * 改为两处都在**调用时**解析后，本文件成为唯一真值源，s7 直接引用本模块的导出即可。
 */
function resolveExemptionsFile() {
  const ov = process.env.HARNESS_EXEMPTIONS_FILE;
  if (!ov) return DEFAULT_EXEMPTIONS_FILE;
  if (process.env.HARNESS_ALLOW_EXEMPTIONS_FILE_OVERRIDE === '1') return path.resolve(ov);
  _warnOverride(`忽略 HARNESS_EXEMPTIONS_FILE=${ov} —— 未设 HARNESS_ALLOW_EXEMPTIONS_FILE_OVERRIDE=1，改用默认台账。`);
  return DEFAULT_EXEMPTIONS_FILE;
}

/** 审计目录必须与台账**同源** —— 否则台账在 A、审计在 B（本仓实测吃过这个亏） */
function resolveAuditDir() {
  const fp = resolveExemptionsFile();
  return fp === DEFAULT_EXEMPTIONS_FILE
    ? DEFAULT_AUDIT_DIR
    : path.join(path.dirname(fp), 'audit', 'exemptions');
}

function lockFileOf(fp) { return fp + '.lock'; }

// ════════════════════════════════════════════════════════════════════
// 🔴 2026-10-15：并发写保护（原子落盘 + 跨进程锁）
// ════════════════════════════════════════════════════════════════════
//
// **受控实验坐实**（D:\tmp\probe-exemption-race.cjs，N 个子进程各自 load-merge-write）：
//   N=1  → 1/1 存活（对照）
//   N=8  → 7/8 存活，丢 1 个
//   N=16 → 11/16 存活，丢 5 个
// 每个子进程都**报告写入成功**，台账里却少了 —— 经典 lost update：
//   read 全文 → map.set(自己这条) → writeFileSync 整份
// 先写的被后写的整份覆盖。`writeFileSync` 还是非原子的（无 tmp+rename），
// 崩在中途会留下**截断的 JSON**，后续 loadExemptions 解析失败 → 整份台账失效。
//
// 两条修法：
//   ① **原子落盘**：写临时文件再 rename —— 读者要么看到旧版要么看到新版，绝无半截。
//   ② **跨进程锁**：`wx` 独占创建锁文件，拿到才做 load-merge-write。
//      锁有 30s 陈旧回收，防止进程被杀后留下死锁。
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30_000;

function acquireLock(lockFile) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return fd !== undefined;
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;
      // 陈旧锁回收：持锁进程被杀后无人释放
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch (_) { /* 锁刚被别人释放 → 下一轮重试 */ }
      if (Date.now() >= deadline) {
        // fail-closed：宁可让本次签发失败并大声报错，也不做可能丢数据的无锁写
        throw new Error('exemptions-core: 豁免台账加锁超时（' + LOCK_TIMEOUT_MS + 'ms），拒绝无锁写入');
      }
      sleepSync(15 + Math.floor(Math.random() * 20));
    }
  }
}

function releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch (_) { /* 已被陈旧回收 */ }
}

/** 持锁执行（无论成功失败都释放）；锁文件随当前台账路径走 */
function withLock(fn) {
  const lockFile = lockFileOf(resolveExemptionsFile());
  acquireLock(lockFile);
  try { return fn(); } finally { releaseLock(lockFile); }
}

/** 路径归一化：正斜杠 + 剥 ./ 前缀 */
function normalizeKey(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * 同步睡眠（不烧 CPU）。用于重试间隙——本模块是同步语义，不能 await。
 * Atomics.wait 在 Node 主线程可用；不可用时退回有界自旋（时间很短，可接受）。
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* 有界自旋兜底 */ }
  }
}

/** 读失败重试次数与退避基数（瞬时占用——并发写 / 杀软扫描 / 索引器——通常几十毫秒内释放） */
const LOAD_RETRIES = 3;
const LOAD_RETRY_BASE_MS = 40;

/**
 * 读取 v1/v2 豁免，返回 Map<key, record>。record = { expires_at, operations?, relaxed_checks?, reason?, issued_by?, issued_at?, id? }
 *
 * 🔴 2026-09-21 事故（本函数是根因）：
 *   原实现 `catch (_) { return map; }` 把「读/解析失败」与「一条豁免都没有」混为一谈。
 *   Sentinel 的 isExempt() 拿到空 map → 判定「无豁免」→ 走分支3【回滚】→ **作者的改动被静默销毁**。
 *   实证日志（豁免全程有效、未到期）：
 *     02:08:44     签发豁免 ex-ff38a81d（有效期至 04:38）
 *     02:09:16.166 reverted      src/FlowEngine.ts 「无有效令牌」   ← 回滚
 *     02:09:16.978 exempt_allowed src/FlowEngine.ts ex-ff38a81d    ← 0.8s 后同一豁免又认到了
 *   中间隔了 32 秒、豁免有效，仍被回滚 —— 典型瞬时读失败被当成「无豁免」。
 *
 * 修法：先重试；重试仍失败则**大声报错**（原先完全静默），语义保持 fail-closed。
 *   🔴 刻意**不**改成 fail-open（读不到就当有豁免）—— 那会让未豁免的写入溜过 Sentinel，是另一个洞，
 *   而且能被「把 exemptions.json 弄成不可读」当作绕过手法。这里要消灭的是「静默」，不是「拒绝」。
 */
function loadExemptions(file) {
  const map = new Map();
  const fp = file || resolveExemptionsFile();
  if (!fs.existsSync(fp)) return map;

  let parsed = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= LOAD_RETRIES; attempt++) {
    try {
      parsed = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < LOAD_RETRIES) sleepSync(LOAD_RETRY_BASE_MS * attempt);
    }
  }

  if (lastErr) {
    // 读不到 ≠ 没有。必须可见：否则又回到「豁免期内改动被静默回滚」。
    console.error(
      `[exemptions-core] 🔴 豁免文件读取失败（已重试 ${LOAD_RETRIES} 次）: ${fp} — ${lastErr.message}；` +
      '本次按「无豁免」处理（fail-closed）。若此刻正处于豁免期内，作者的改动可能被 Sentinel 回滚 —— ' +
      '请检查该文件是否被其它进程独占。'
    );
    return map;
  }
  if (!parsed || typeof parsed !== 'object') return map;

  // v2: {version:2, exemptions:{key: record}}
  if (parsed.version === 2 && parsed.exemptions && typeof parsed.exemptions === 'object') {
    for (const [k, rec] of Object.entries(parsed.exemptions)) {
      if (rec && typeof rec === 'object' && typeof rec.expires_at === 'number') {
        map.set(normalizeKey(k), rec);
      }
    }
    return map;
  }

  // v1: {路径: 过期毫秒}  → 包裹为 record
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'number') {
      map.set(normalizeKey(k), { expires_at: v, id: 'ex-v1-' + crypto.createHash('sha1').update(k).digest('hex').slice(0, 6) });
    } else if (v && typeof v === 'object' && typeof v.expires_at === 'number') {
      map.set(normalizeKey(k), v);
    }
  }
  return map;
}

/** 统一读取过期时间（v1 数字 / v2 对象） */
function getExpiry(record) {
  return typeof record === 'number' ? record : (record && record.expires_at) || 0;
}

/** 签发豁免（load-merge-write，不覆盖已有条目） */
function addExemption(filePath, opts = {}) {
  const key = normalizeKey(filePath);
  if (!key) throw new Error('exemptions-core: 空文件路径');

  const minutes = opts.minutes || 30;
  const now = Date.now();
  const record = {
    expires_at: now + minutes * 60 * 1000,
    operations: Array.isArray(opts.operations) && opts.operations.length ? opts.operations : undefined,
    relaxed_checks: Array.isArray(opts.relaxed_checks) && opts.relaxed_checks.length ? opts.relaxed_checks : undefined,
    reason: opts.reason || '',
    issued_by: opts.issued_by || 'admin-cli',
    issued_at: now,
    id: 'ex-' + crypto.randomBytes(4).toString('hex'),
  };

  // 🔴 2026-10-15：整段 load-merge-write 持跨进程锁。
  //    只原子落盘不够 —— 锁不住 read→merge 那一段，两个进程仍会各自基于旧快照合并，
  //    后写的整份覆盖先写的（实测 N=16 丢 5 条）。
  const map = withLock(() => {
    const m = loadExemptions(resolveExemptionsFile());
    m.set(key, record);
    writeExemptions(m);
    return m;
  });

  // 签发审计
  writeAudit(record, { file: key, minutes });

  return record;
}

/** 把 Map 写回 v2 格式 */
function writeExemptions(map) {
  const obj = { version: 2, exemptions: {} };
  for (const [k, rec] of map) {
    if (getExpiry(rec) > Date.now()) obj.exemptions[k] = rec;
  }
  const fp = resolveExemptionsFile();
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 🔴 2026-10-15：原子落盘 —— 写临时文件再 rename。
  //    原为直接 `writeFileSync(EXEMPTIONS_FILE, ...)`：进程若在中途被杀（agent-guard 击杀、
  //    30s 超时、崩溃），会留下**截断的 JSON**，此后每次 loadExemptions 解析失败 ⇒
  //    整份豁免台账静默失效（所有文件都失去豁免）。rename 在同一文件系统上是原子的。
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, fp);
}

/** 查询豁免记录（未命中或过期返回 null） */
function isExemptRecord(filePath, now) {
  const map = loadExemptions(resolveExemptionsFile());
  const key = normalizeKey(filePath);
  const rec = map.get(key);
  if (!rec) return null;
  if (getExpiry(rec) <= (now || Date.now())) return null;
  return rec;
}

/** 校验豁免是否覆盖某工具类型（operations 白名单；空 = 不限） */
function coversOperation(record, tool) {
  const ops = record && record.operations;
  if (!ops || !ops.length) return true;
  const t = String(tool || '').toLowerCase();
  return ops.some(o => t.includes(o.toLowerCase()) || o.toLowerCase().includes(t));
}

/** 签发审计写盘 */
function writeAudit(record, extra) {
  try {
    const auditDir = resolveAuditDir();
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(),
      event: 'EXEMPTION_ISSUE',
      id: record.id,
      file: extra.file,
      minutes: extra.minutes,
      expires_at: record.expires_at,
      operations: record.operations || [],
      relaxed_checks: record.relaxed_checks || [],
      reason: record.reason,
      issued_by: record.issued_by,
    };
    fs.writeFileSync(path.join(auditDir, `issue_${Date.now()}.json`), JSON.stringify(entry, null, 2), 'utf-8');
  } catch (_) {}
}

module.exports = {
  // 🔴 getter 而非常量：路径在**调用时**解析（与 src/s7/s7AutoArchive.ts 同口径），
  //    否则两处读取点会在同一进程里指向不同文件（本仓反复踩的多真相源坑）。
  get EXEMPTIONS_FILE() { return resolveExemptionsFile(); },
  get AUDIT_DIR() { return resolveAuditDir(); },
  withLock,
  normalizeKey,
  loadExemptions,
  getExpiry,
  addExemption,
  writeExemptions,
  isExemptRecord,
  coversOperation,
};

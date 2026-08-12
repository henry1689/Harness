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
const EXEMPTIONS_FILE = process.env.HARNESS_EXEMPTIONS_FILE || path.join(HARNESS_DIR, 'data', 'exemptions.json');
const AUDIT_DIR = path.join(HARNESS_DIR, 'data', 'audit', 'exemptions');

/** 路径归一化：正斜杠 + 剥 ./ 前缀 */
function normalizeKey(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** 读取 v1/v2 豁免，返回 Map<key, record>。record = { expires_at, operations?, relaxed_checks?, reason?, issued_by?, issued_at?, id? } */
function loadExemptions(file) {
  const map = new Map();
  const fp = file || EXEMPTIONS_FILE;
  if (!fs.existsSync(fp)) return map;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return map; }
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

  // load-merge-write
  const map = loadExemptions(EXEMPTIONS_FILE);
  map.set(key, record);
  writeExemptions(map);

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
  const dir = path.dirname(EXEMPTIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(EXEMPTIONS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
}

/** 查询豁免记录（未命中或过期返回 null） */
function isExemptRecord(filePath, now) {
  const map = loadExemptions(EXEMPTIONS_FILE);
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
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
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
    fs.writeFileSync(path.join(AUDIT_DIR, `issue_${Date.now()}.json`), JSON.stringify(entry, null, 2), 'utf-8');
  } catch (_) {}
}

module.exports = {
  EXEMPTIONS_FILE,
  AUDIT_DIR,
  normalizeKey,
  loadExemptions,
  getExpiry,
  addExemption,
  writeExemptions,
  isExemptRecord,
  coversOperation,
};

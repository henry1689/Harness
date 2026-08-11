/**
 * scripts/pass-core.cjs — Harness 管理员密码核心逻辑（无副作用，可被 require/import）
 * ===================================================================================
 * 统一密码哈希与校验。三处复用：
 *   - scripts/harness-passwd.cjs   （设置密码）
 *   - scripts/harness-unlock.cjs   （终端解锁 + --password 解锁）
 *   - sentinel/sentinel-service.cjs（--unlock 豁免时的密码校验）
 *   - mcp/server.ts                （harness_admin_unlock 工具）
 *
 * v2 格式（PBKDF2 加盐，防暴力破解）：
 *   { version: 2, algorithm: 'pbkdf2-sha256', salt, iterations, hash }
 * v1 格式（历史 sha256 无盐，验证时向后兼容，但写入一律 v2）：
 *   { version: 1, hash, algorithm: 'sha256' }
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PASS_FILE = path.resolve(__dirname, '..', '.harness-pass');
const SECRET_FILE = path.resolve(__dirname, '..', 'data', '.harness-secret');
const PBKDF2_ITERATIONS = 100_000;

/**
 * 🔴 C4-fix: 统一签名 key 源。所有签名/验签（harness-unlock / server / pre-check）
 * 都从这里拿 key，保证三处一致。优先级:
 *   1. 环境变量 HARNESS_TOKEN_SECRET（≥32 字节）
 *   2. data/.harness-secret 文件（真实随机 secret，默认方式）
 * 不再回退到密码 hash（C1: 密码 hash 对 Agent 可读，作 key 无意义）。
 */
function getSignKey() {
  const envSecret = process.env.HARNESS_TOKEN_SECRET;
  if (envSecret && Buffer.byteLength(envSecret, 'utf8') >= 32) return envSecret;
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const s = fs.readFileSync(SECRET_FILE, 'utf-8').trim();
      if (s && Buffer.byteLength(s, 'utf8') >= 32) return s;
    }
  } catch (_) {}
  // 没有 secret 文件 → 返回 null，调用方应拒绝解锁（fail-closed）
  return null;
}

/**
 * M3-fix: 稳定序列化（排序键），保证签名体跨进程一致。
 * 与 src/security/token-verify.cjs 的 stableStringify 对齐。
 */
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** v2 PBKDF2 生成哈希记录（带随机盐） */
function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256').toString('hex');
  return { version: 2, algorithm: 'pbkdf2-sha256', salt, iterations, hash };
}

/** v1 历史 sha256（仅向后兼容校验用，不再用于写入） */
function hashPasswordSha256(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

/** 读取密码文件；不存在或损坏返回 null */
function readPassFile() {
  if (!fs.existsSync(PASS_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PASS_FILE, 'utf-8'));
  } catch (_) { return null; }
}

/** 安全比较（恒时，避免时序侧信道） */
function safeEqualHex(a, b) {
  try {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch (_) { return a === b; }
}

/** 校验密码：支持 v1(sha256) + v2(pbkdf2) */
function verifyPassword(password) {
  const pf = readPassFile();
  if (!pf || !pf.hash) return false;
  const pwd = String(password || '');

  if ((pf.version || 1) === 1) {
    // v1 历史格式：无盐 sha256
    return safeEqualHex(hashPasswordSha256(pwd), pf.hash);
  }

  // v2：PBKDF2 + 盐
  const salt = pf.salt || '';
  // L1-fix + LOW-3-fix: 防 iterations 非法值（负数/0/非数字/过大）导致 pbkdf2Sync 抛异常或 DoS
  let iterations = parseInt(pf.iterations, 10);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) iterations = PBKDF2_ITERATIONS;
  const inputHash = crypto.pbkdf2Sync(pwd, salt, iterations, 32, 'sha256').toString('hex');
  return safeEqualHex(inputHash, pf.hash);
}

/** 写入密码文件（v2 格式） */
function writePassFile(record) {
  const data = {
    version: 2,
    algorithm: 'pbkdf2-sha256',
    salt: record.salt,
    iterations: record.iterations,
    hash: record.hash,
    created_at: new Date().toISOString(),
    note: 'Harness 管理员密码。修改 harness 自身代码需要提供密码。修改密码: node scripts/harness-passwd.cjs',
  };
  fs.writeFileSync(PASS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  return data;
}

module.exports = {
  PASS_FILE,
  SECRET_FILE,
  PBKDF2_ITERATIONS,
  hashPassword,
  hashPasswordSha256,
  readPassFile,
  writePassFile,
  verifyPassword,
  getSignKey,
  stableStringify,
};

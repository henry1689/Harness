/**
 * token-verify.cjs — Token v2 HMAC 验证 (CJS, 供 Sentinel/Git Hook/PreToolUse)
 * =============================================================================
 * P4-AB: 提供 Token v2 的 HMAC 签名验证，纯 CJS 实现。
 * 与 src/security/ 下的 TS 模块功能等价，但可在 CJS 上下文中 require()。
 *
 * 用法:
 *   const { verifyTokenV2, isHighRiskForWeakToken } = require('./token-verify.cjs');
 *   const result = verifyTokenV2(tokenData, targetFile);
 *   // → { allowed: false, reason: 'token_invalid_signature' }
 */

'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');
const fs = require('fs');
const path = require('path');

// ════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════

const HEX_SHA256_RE = /^[a-f0-9]{64}$/i;
const MIN_SECRET_BYTES = 32;

const HIGH_RISK_PATH_PREFIXES = [
  'src/',
  'mcp/',
  'sentinel/',
  'hooks/',
  'scripts/security/',
  'scripts/harness-gate.cjs',
  'scripts/defense-health-check.cjs',
  'data/tokens/',
  'data/audit/',
  '.claude/settings.json',
  'package-lock.json',
];

// ════════════════════════════════════════════════════════════════════
// Secret 管理
// ════════════════════════════════════════════════════════════════════

function getTokenSecret() {
  const secret = process.env.HARNESS_TOKEN_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    throw new Error(
      '[TokenVerify] HARNESS_TOKEN_SECRET 缺失或长度不足 (需 >= 32 bytes)。' +
      ' Token v2 验证已禁用。'
    );
  }
  return secret;
}

function hasTokenSecret() {
  try {
    const s = process.env.HARNESS_TOKEN_SECRET;
    return !!s && Buffer.byteLength(s, 'utf8') >= MIN_SECRET_BYTES;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════
// Canonicalization (稳定序列化)
// ════════════════════════════════════════════════════════════════════

function stableStringify(value) {
  if (value === null) return 'null';

  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'undefined') return 'null';

  if (Array.isArray(value)) {
    return '[' + value.map(function (item) { return stableStringify(item); }).join(',') + ']';
  }

  if (typeof value === 'object') {
    var obj = value;
    var keys = Object.keys(obj).sort();

    var pairs = keys
      .filter(function (key) { return typeof obj[key] !== 'undefined'; })
      .map(function (key) { return JSON.stringify(key) + ':' + stableStringify(obj[key]); });

    return '{' + pairs.join(',') + '}';
  }

  throw new Error('[TokenVerify] 不支持的类型: ' + typeof value);
}

// ════════════════════════════════════════════════════════════════════
// Token v2 签名提取与验证
// ════════════════════════════════════════════════════════════════════

/**
 * 从完整 token 中提取签名负载。
 * 排除不可变字段: consumed, consumed_at, signature
 */
function toSigningPayload(token) {
  return {
    version: token.version,
    token_id: token.token_id,
    token_strength: token.token_strength,
    run_id: token.run_id,
    intent_id: token.intent_id,
    issued_at: token.issued_at,
    expires_at: token.expires_at,
    files: token.files || [],
    allowed_paths: token.allowed_paths || [],
    forbidden_paths: token.forbidden_paths || [],
    project_root_hash: token.project_root_hash,
    diff_scope_hash: token.diff_scope_hash,
    nonce: token.nonce,
  };
}

function signPayload(payload, secret) {
  return createHmac('sha256', secret)
    .update(stableStringify(payload))
    .digest('hex');
}

/**
 * 常量时间比较两个 sha256 hex 字符串。
 * 不使用长度分支——始终执行完整的 timingSafeEqual。
 */
function safeCompareSha256Hex(expectedHex, actualHex) {
  var expectedValid = HEX_SHA256_RE.test(expectedHex);
  var actualValid = HEX_SHA256_RE.test(actualHex);

  var normalizedExpected = expectedValid ? expectedHex.toLowerCase() : '0'.repeat(64);
  var normalizedActual = actualValid ? actualHex.toLowerCase() : '0'.repeat(64);

  var a = Buffer.from(normalizedExpected, 'hex');
  var b = Buffer.from(normalizedActual, 'hex');

  var equal = timingSafeEqual(a, b);

  return expectedValid && actualValid && equal;
}

function verifyTokenSignature(token, secret) {
  var expected = signPayload(toSigningPayload(token), secret);
  return safeCompareSha256Hex(expected, token.signature);
}

// ════════════════════════════════════════════════════════════════════
// 路径匹配
// ════════════════════════════════════════════════════════════════════

function normalizePath(fp) {
  return String(fp)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/\.\//, '/');
}

function pathMatches(path, rule) {
  if (path === rule) return true;
  if (rule.endsWith('/**')) {
    var prefix = rule.slice(0, -3);
    return path === prefix || path.startsWith(prefix + '/');
  }
  if (rule.endsWith('/')) return path.startsWith(rule);
  if (path.startsWith(rule + '/')) return true;
  return false;
}

function pathMatchesAny(target, rules) {
  for (var i = 0; i < rules.length; i++) {
    if (pathMatches(target, normalizePath(rules[i]))) return true;
  }
  return false;
}

function isHighRiskPath(fp) {
  var n = normalizePath(fp);
  for (var i = 0; i < HIGH_RISK_PATH_PREFIXES.length; i++) {
    if (n.startsWith(HIGH_RISK_PATH_PREFIXES[i]) || n === HIGH_RISK_PATH_PREFIXES[i]) return true;
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════
// 公开 API
// ════════════════════════════════════════════════════════════════════

/**
 * 验证一个 Token v2。
 *
 * @param {object} token — 从 JSON 解析的 Token v2 对象
 * @param {string} [targetFile] — 目标文件路径
 * @param {object} [opts]
 * @param {string} [opts.requireStrength] — 'strong' | 'weak'
 * @param {Date} [opts.now] — 当前时间 (测试注入)
 * @returns {{ allowed: boolean, reason: string, token?: object }}
 */
function verifyTokenV2(token, targetFile, opts) {
  opts = opts || {};
  var now = opts.now || new Date();

  // 0. 不是 v2 → 交给调用方自己处理 v1
  if (!token || token.version !== 2) {
    return { allowed: false, reason: 'token_not_v2' };
  }

  // 1. 签名验证
  try {
    var secret = getTokenSecret();
    if (!verifyTokenSignature(token, secret)) {
      return { allowed: false, reason: 'token_invalid_signature', token: token };
    }
  } catch (e) {
    // secret 缺失 → fail-close
    return { allowed: false, reason: 'token_verify_disabled_no_secret', token: token };
  }

  // 2. 过期
  if (now.getTime() > new Date(token.expires_at).getTime()) {
    return { allowed: false, reason: 'token_expired', token: token };
  }

  // 3. 已消费
  if (token.consumed) {
    return { allowed: false, reason: 'token_consumed', token: token };
  }

  // 4. Scope: forbidden 优先
  if (targetFile) {
    var nf = normalizePath(targetFile);

    if (pathMatchesAny(nf, token.forbidden_paths || [])) {
      return { allowed: false, reason: 'token_forbidden_path', token: token };
    }

    var inFiles = pathMatchesAny(nf, token.files || []);
    var inAllowed = pathMatchesAny(nf, token.allowed_paths || []);

    if (!inFiles && !inAllowed) {
      return { allowed: false, reason: 'token_scope_mismatch', token: token };
    }
  }

  // 5. 强度检查
  if (opts.requireStrength === 'strong' && token.token_strength !== 'strong') {
    return { allowed: false, reason: 'token_strength_insufficient', token: token };
  }

  // 6. 高风险文件必须 strong
  if (targetFile && isHighRiskPath(targetFile) && token.token_strength !== 'strong') {
    return { allowed: false, reason: 'token_strength_insufficient_high_risk', token: token };
  }

  return { allowed: true, reason: 'token_v2_valid', token: token };
}

/**
 * 检查文件是否为高风险（weak token 不可写入）。
 * 供 Sentinel / PreToolUse / Git Hook 在未找到 token 时
 * 按风险等级决定 fail-close vs advisory 策略。
 */
function isHighRiskForWeakToken(filePath) {
  return isHighRiskPath(filePath);
}

/**
 * 检查是否配置了可用的 token secret。
 */
function isTokenSecretAvailable() {
  return hasTokenSecret();
}

module.exports = {
  verifyTokenV2,
  isHighRiskForWeakToken,
  isTokenSecretAvailable,
  normalizePath,
  getTokenSecret,
  // 内部导出供测试
  _stableStringify: stableStringify,
  _safeCompareSha256Hex: safeCompareSha256Hex,
};

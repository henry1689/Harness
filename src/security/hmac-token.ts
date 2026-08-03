/**
 * hmac-token.ts — Token v2 HMAC 签名与安全比较 (P4-AB)
 * ======================================================
 * 使用 HMAC-SHA256 对 Token SigningPayload 签名和验证。
 * 验证使用常量时间比较 (timingSafeEqual)。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { stableStringify } from './token-canonicalize.js';
import type { HarnessTokenSigningPayload, HarnessTokenV2 } from './token-types.js';
import { toSigningPayload } from './token-types.js';

// ════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════

const HEX_SHA256_RE = /^[a-f0-9]{64}$/i;
const MIN_SECRET_BYTES = 32;

// ════════════════════════════════════════════════════════════════════
// 公开 API
// ════════════════════════════════════════════════════════════════════

/**
 * 获取 HARNESS_TOKEN_SECRET，缺失时抛出。
 * MCP 无头模式下，secret 缺失 = 不可恢复的配置错误 = 拒绝签发任何令牌。
 */
export function getTokenSecret(): string {
  const secret = process.env.HARNESS_TOKEN_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    throw new Error(
      '[HMAC] HARNESS_TOKEN_SECRET is missing or too short (need >= 32 bytes).' +
      ' Token signing is disabled. Set HARNESS_TOKEN_SECRET in environment.'
    );
  }
  return secret;
}

/**
 * 检查 secret 是否存在且长度达标。不抛出，供防御健康检查使用。
 */
export function isTokenSecretValid(): boolean {
  try {
    const s = process.env.HARNESS_TOKEN_SECRET;
    return !!s && Buffer.byteLength(s, 'utf8') >= MIN_SECRET_BYTES;
  } catch {
    return false;
  }
}

/**
 * 对签名负载计算 HMAC-SHA256 签名，返回 hex 字符串。
 */
export function signTokenPayload(
  payload: HarnessTokenSigningPayload,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(stableStringify(payload))
    .digest('hex');
}

/**
 * 验证 token 的签名是否与负载匹配。
 * 使用常量时间比较，不泄漏签名长度信息。
 */
export function verifyTokenSignature(
  token: HarnessTokenV2,
  secret: string,
): boolean {
  const expected = signTokenPayload(toSigningPayload(token), secret);
  return safeCompareSha256Hex(expected, token.signature);
}

// ════════════════════════════════════════════════════════════════════
// 安全比较 — 无时序侧信道
// ════════════════════════════════════════════════════════════════════

/**
 * 常量时间比较两个 SHA256 hex 字符串。
 *
 * 关键安全属性:
 *   - 绝不因签名长度不同而提前返回 false（避免长度侧信道）
 *   - 对无效 hex 和有效 hex 执行相同长度的 timingSafeEqual
 *   - 始终执行固定 32 字节的比较（sha256 digest = 32 bytes）
 *
 * @param expectedHex — 服务端计算的正确签名 (64 字符 hex)
 * @param actualHex   — 待验证的签名 (任意长度)
 */
export function safeCompareSha256Hex(
  expectedHex: string,
  actualHex: string,
): boolean {
  const expectedValid = HEX_SHA256_RE.test(expectedHex);
  const actualValid = HEX_SHA256_RE.test(actualHex);

  // 不管输入是否有效，始终构造 32 字节 buffer 做常量时间比较
  const normalizedExpected = expectedValid
    ? expectedHex.toLowerCase()
    : '0'.repeat(64);

  const normalizedActual = actualValid
    ? actualHex.toLowerCase()
    : '0'.repeat(64);

  const a = Buffer.from(normalizedExpected, 'hex');
  const b = Buffer.from(normalizedActual, 'hex');

  const equal = timingSafeEqual(a, b);

  // 只有在双方都是合法 hex 且内容相等时才返回 true
  return expectedValid && actualValid && equal;
}

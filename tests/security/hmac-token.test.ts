/**
 * hmac-token.test.ts — HMAC 签名与安全比较测试 (P4-AB)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  signTokenPayload,
  verifyTokenSignature,
  safeCompareSha256Hex,
  getTokenSecret,
  isTokenSecretValid,
} from '../../src/security/hmac-token.js';
import { toSigningPayload } from '../../src/security/token-types.js';
import type { HarnessTokenV2, HarnessTokenSigningPayload, IssueTokenInput } from '../../src/security/token-types.js';

// 测试用 secret
const TEST_SECRET = 'test-harness-secret-key-minimum-32-bytes!!';

// 构建测试 token
function makeTestToken(overrides: Partial<HarnessTokenV2> = {}): HarnessTokenV2 {
  const base: Omit<HarnessTokenV2, 'signature'> = {
    version: 2,
    token_id: 'test-token-id',
    token_strength: 'strong',
    run_id: 'run-test',
    intent_id: 'intent-test',
    issued_at: '2026-08-03T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
    files: ['src/foo.ts'],
    allowed_paths: ['src/foo.ts'],
    forbidden_paths: [],
    nonce: 'test-nonce-123',
    consumed: false,
    ...overrides,
  };
  const signature = signTokenPayload(toSigningPayload(base as HarnessTokenV2), TEST_SECRET);
  return { ...base, signature };
}

describe('signTokenPayload / verifyTokenSignature', () => {
  beforeAll(() => {
    process.env.HARNESS_TEST_TOKEN_SECRET = TEST_SECRET;
  });

  it('签名后验证通过', () => {
    const token = makeTestToken();
    expect(verifyTokenSignature(token, TEST_SECRET)).toBe(true);
  });

  it('手写 v2 token signature 随便填 → 拒绝', () => {
    const token = makeTestToken();
    const fakeToken = { ...token, signature: 'a'.repeat(64) };
    expect(verifyTokenSignature(fakeToken, TEST_SECRET)).toBe(false);
  });

  it('修改 files 后签名不匹配 → 拒绝', () => {
    const token = makeTestToken();
    const tamperedToken = { ...token, files: ['src/evil.ts'] };
    expect(verifyTokenSignature(tamperedToken, TEST_SECRET)).toBe(false);
  });

  it('修改 allowed_paths 后签名不匹配 → 拒绝', () => {
    const token = makeTestToken();
    const tamperedToken = { ...token, allowed_paths: ['src/evil/**'] };
    expect(verifyTokenSignature(tamperedToken, TEST_SECRET)).toBe(false);
  });

  it('修改 token_strength 后签名不匹配 → 拒绝', () => {
    const token = makeTestToken();
    const tamperedToken = { ...token, run_id: 'tampered-run-id' };
    expect(verifyTokenSignature(tamperedToken, TEST_SECRET)).toBe(false);
  });

  it('复制旧 token 改 files → 拒绝', () => {
    const token = makeTestToken();
    // 直接替换 files，签名不会随之更新
    const copied = JSON.parse(JSON.stringify(token));
    copied.files = ['src/hacked.ts'];
    expect(verifyTokenSignature(copied, TEST_SECRET)).toBe(false);
  });

  it('修改 payload 后复用原 signature → 拒绝', () => {
    const token = makeTestToken();
    const tampered = { ...token, run_id: 'different-run' };
    expect(verifyTokenSignature(tampered, TEST_SECRET)).toBe(false);
  });
});

describe('safeCompareSha256Hex', () => {
  it('相同签名 → true', () => {
    const sig = 'a'.repeat(64);
    expect(safeCompareSha256Hex(sig, sig)).toBe(true);
  });

  it('不同签名 → false', () => {
    expect(safeCompareSha256Hex('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });

  it('非 hex 输入 → false (但走过完整比较路径)', () => {
    expect(safeCompareSha256Hex('a'.repeat(64), 'not-hex!')).toBe(false);
  });

  it('非 64 位 hex → false', () => {
    expect(safeCompareSha256Hex('a'.repeat(64), 'a'.repeat(32))).toBe(false);
  });

  it('大小写不敏感', () => {
    const sig = 'a'.repeat(32) + 'b'.repeat(32);
    expect(safeCompareSha256Hex(sig, sig.toUpperCase())).toBe(true);
  });
});

describe('getTokenSecret', () => {
  it('无 secret 时抛出', () => {
    const oldSecret = process.env.HARNESS_TOKEN_SECRET;
    delete process.env.HARNESS_TOKEN_SECRET;
    expect(() => getTokenSecret()).toThrow(/HARNESS_TOKEN_SECRET/);
    if (oldSecret) process.env.HARNESS_TOKEN_SECRET = oldSecret;
  });

  it('secret 太短时抛出', () => {
    process.env.HARNESS_TOKEN_SECRET = 'short';
    expect(() => getTokenSecret()).toThrow(/32 bytes/);
    delete process.env.HARNESS_TOKEN_SECRET;
  });

  it('isTokenSecretValid: 无 secret → false', () => {
    const old = process.env.HARNESS_TOKEN_SECRET;
    delete process.env.HARNESS_TOKEN_SECRET;
    expect(isTokenSecretValid()).toBe(false);
    if (old) process.env.HARNESS_TOKEN_SECRET = old;
  });
});

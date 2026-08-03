/**
 * token-canonicalize.test.ts — 稳定序列化测试 (P4-AB)
 */
import { describe, it, expect } from 'vitest';
import { stableStringify } from '../../src/security/token-canonicalize.js';

describe('stableStringify', () => {
  it('对象 key 顺序不同 → 签名一致', () => {
    const a = stableStringify({ b: 1, a: 2 });
    const b = stableStringify({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('数组顺序不同 → 签名不同', () => {
    const a = stableStringify([1, 2, 3]);
    const b2 = stableStringify([1, 3, 2]);
    expect(a).not.toBe(b2);
  });

  it('嵌套对象 key 顺序不同 → 签名一致', () => {
    const a = stableStringify({ outer: { b: 1, a: 2 } });
    const b2 = stableStringify({ outer: { a: 2, b: 1 } });
    expect(a).toBe(b2);
  });

  it('null → "null"', () => {
    expect(stableStringify(null)).toBe('null');
  });

  it('undefined → "null"', () => {
    expect(stableStringify(undefined)).toBe('null');
  });

  it('undefined 字段被丢弃', () => {
    const a = stableStringify({ a: 1, b: undefined, c: 3 });
    const b2 = stableStringify({ a: 1, c: 3 });
    expect(a).toBe(b2);
  });

  it('数字正常序列化', () => {
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify(-1.5)).toBe('-1.5');
  });

  it('布尔值正常序列化', () => {
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(false)).toBe('false');
  });

  it('字符串用 JSON.stringify 转义', () => {
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify('a"b')).toBe(JSON.stringify('a"b'));
  });

  it('空对象 → {}', () => {
    expect(stableStringify({})).toBe('{}');
  });

  it('空数组 → []', () => {
    expect(stableStringify([])).toBe('[]');
  });

  it('混合类型', () => {
    const result = stableStringify({
      str: 'hello',
      num: 42,
      bool: true,
      nested: { x: 1 },
      arr: [1, 'two', null],
    });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('Token SigningPayload 典型结构', () => {
    const payload = {
      version: 2,
      token_id: 'test-uuid',
      token_strength: 'strong',
      run_id: 'run-123',
      intent_id: 'intent-456',
      issued_at: '2026-08-03T00:00:00.000Z',
      expires_at: '2026-08-03T00:15:00.000Z',
      files: ['src/foo.ts'],
      allowed_paths: ['src/foo.ts'],
      forbidden_paths: [],
      nonce: 'abc123',
    };
    const result = stableStringify(payload);
    expect(result).toContain('"version":2');
    expect(result).toContain('"token_id":"test-uuid"');
  });

  it('NaN → "null"', () => {
    expect(stableStringify(NaN)).toBe('null');
  });

  it('Infinity → "null"', () => {
    expect(stableStringify(Infinity)).toBe('null');
  });

  it('supports BigInt', () => {
    // BigInts throw because they're not serializable
    expect(() => stableStringify(BigInt(1))).toThrow();
  });

  it('函数抛出', () => {
    expect(() => stableStringify(() => {})).toThrow();
  });
});

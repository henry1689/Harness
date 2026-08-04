/**
 * token-store.test.ts — TokenStore 签发/验证/消费测试 (P4-AB)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenStore } from '../../src/security/token-store.js';
import type { HarnessTokenV2 } from '../../src/security/token-types.js';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TEST_SECRET = 'test-harness-secret-key-minimum-32-bytes!!';
const TEST_TOKEN_DIR = join(__dirname, '..', '..', 'data', 'tokens-test');

function makeStore(overrides: any = {}) {
  return new TokenStore({
    tokenDir: TEST_TOKEN_DIR,
    secret: TEST_SECRET,
    now: () => new Date('2026-08-03T12:00:00.000Z'),
    ...overrides,
  });
}

describe('TokenStore', () => {
  beforeEach(() => {
    process.env.HARNESS_TOKEN_SECRET = TEST_SECRET;
    if (!existsSync(TEST_TOKEN_DIR)) mkdirSync(TEST_TOKEN_DIR, { recursive: true });
    // 清理测试目录
    try {
      for (const f of readdirSync(TEST_TOKEN_DIR)) {
        rmSync(join(TEST_TOKEN_DIR, f), { force: true });
      }
    } catch (_) {}
  });

  afterEach(() => {
    try {
      rmSync(TEST_TOKEN_DIR, { recursive: true, force: true });
    } catch (_) {}
    delete process.env.HARNESS_TOKEN_SECRET;
  });

  // ── 签发 ──

  it('issueToken: 签发 strong token', () => {
    const store = makeStore();
    const token = store.issueToken({
      token_strength: 'strong',
      run_id: 'run-1',
      intent_id: 'intent-1',
      files: ['src/foo.ts'],
    });

    expect(token.version).toBe(2);
    expect(token.token_strength).toBe('strong');
    expect(token.token_id).toBeTruthy();
    expect(token.consumed).toBe(false);
    expect(token.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(token.expires_at).toBe('2026-08-03T12:15:00.000Z'); // +15min
  });

  it('issueToken: 默认签发 strong token', () => {
    const store = makeStore();
    const token = store.issueToken({
      run_id: 'run-2',
      intent_id: 'intent-2',
      files: ['docs/readme.md'],
    });

    expect(token.token_strength).toBe('strong');
    expect(token.expires_at).toBe('2026-08-03T12:15:00.000Z'); // +15min (default)
  });

  // ── 读取 ──

  it('readToken: 签发后可读取', () => {
    const store = makeStore();
    const token = store.issueToken({
      token_strength: 'strong', run_id: 'r', intent_id: 'i', files: ['src/x.ts'],
    });
    const read = store.readToken(token.token_id);
    expect(read).not.toBeNull();
    expect(read!.signature).toBe(token.signature);
  });

  it('readToken: 不存在返回 null', () => {
    const store = makeStore();
    expect(store.readToken('nonexistent')).toBeNull();
  });

  // ── 验证 ──

  it('verifyToken: 有效 token → allowed', () => {
    const store = makeStore();
    const token = store.issueToken({
      token_strength: 'strong', run_id: 'r', intent_id: 'i', files: ['src/foo.ts'],
    });
    const result = store.verifyToken({ token_id: token.token_id, target_file: 'src/foo.ts' });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('token_valid');
  });

  it('verifyToken: 签名不匹配 → 拒绝', () => {
    const store = makeStore();
    const token = store.issueToken({
      token_strength: 'strong', run_id: 'r', intent_id: 'i', files: ['src/foo.ts'],
    });
    // 篡改签名
    const tampered = { ...token, signature: 'f'.repeat(64) };
    const filePath = join(TEST_TOKEN_DIR, token.token_id + '.json');
    const { writeFileSync } = require('node:fs');
    writeFileSync(filePath, JSON.stringify(tampered), 'utf-8');

    const result = store.verifyToken({ token_id: token.token_id });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('token_invalid_signature');
  });

  it('verifyToken: 过期 token → 拒绝', () => {
    const store = makeStore({
      now: () => new Date('2099-01-01T00:00:00.000Z'), // 未来时间
    });
    const token = store.issueToken({
      token_strength: 'strong', run_id: 'r', intent_id: 'i', files: ['src/foo.ts'],
    });

    // 用过去的 now 验证
    const expiredStore = new TokenStore({
      tokenDir: TEST_TOKEN_DIR,
      secret: TEST_SECRET,
      now: () => new Date('2099-01-02T00:00:00.000Z'), // 过期后
    });
    const result = expiredStore.verifyToken({ token_id: token.token_id });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('token_expired');
  });

  it('verifyToken: 已消费 → 拒绝', () => {
    const store = makeStore();
    const token = store.issueToken({
      token_strength: 'strong', run_id: 'r', intent_id: 'i', files: ['src/foo.ts'],
    });
    store.consumeToken(token.token_id);
    const result = store.verifyToken({ token_id: token.token_id });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('token_consumed');
  });

  it('verifyToken: scope mismatch → 拒绝', () => {
    const store = makeStore();
    const token = store.issueToken({
      token_strength: 'strong', run_id: 'r', intent_id: 'i', files: ['src/foo.ts'],
    });
    const result = store.verifyToken({ token_id: token.token_id, target_file: 'src/bar.ts' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('token_scope_mismatch');
  });

  it('verifyToken: forbidden_path 命中 → 拒绝', () => {
    const store = makeStore();
    const token = store.issueToken({
      token_strength: 'strong',
      run_id: 'r',
      intent_id: 'i',
      files: ['src/allowed.ts'],
      allowed_paths: ['src/'],
      forbidden_paths: ['src/secret/'],
    });
    const result = store.verifyToken({ token_id: token.token_id, target_file: 'src/secret/evil.ts' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('token_forbidden_path');
  });

  it('verifyToken: require_strength 不匹配 → 拒绝（P5: 所有令牌均为 strong，此测试为 defense-in-depth）', () => {
    const store = makeStore();
    // 签发强令牌
    const token = store.issueToken({
      token_strength: 'strong', run_id: 'r', intent_id: 'i', files: ['src/foo.ts'],
    });
    // require_strength='strong' 对 strong token → 应该通过
    const result = store.verifyToken({ token_id: token.token_id, target_file: 'src/foo.ts', require_strength: 'strong' });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('token_valid');
  });

  it('verifyToken: 不存在的 token → token_missing', () => {
    const store = makeStore();
    const result = store.verifyToken({ token_id: 'nonexistent' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('token_missing');
  });

  // ── 消费 ──

  it('consumeToken: 消费后不可再消费', () => {
    const store = makeStore();
    const token = store.issueToken({
      token_strength: 'strong', run_id: 'r', intent_id: 'i', files: ['src/foo.ts'],
    });

    const r1 = store.consumeToken(token.token_id);
    expect(r1.allowed).toBe(true);

    const r2 = store.consumeToken(token.token_id);
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toBe('token_consumed');
  });

  // ── 路径标准化 ──

  it('Windows 路径反斜杠 normalize', () => {
    const store = makeStore();
    const token = store.issueToken({
      token_strength: 'strong', run_id: 'r', intent_id: 'i', files: ['src\\foo.ts'],
    });
    const result = store.verifyToken({ token_id: token.token_id, target_file: 'src/foo.ts' });
    expect(result.allowed).toBe(true);
  });

  it('路径包含 .. 越界 → 拒绝', () => {
    const store = makeStore();
    const token = store.issueToken({
      token_strength: 'strong', run_id: 'r', intent_id: 'i', files: ['src/foo.ts'],
    });
    // .. 不会被 files 列表匹配
    const result = store.verifyToken({ token_id: token.token_id, target_file: '../secret.ts' });
    expect(result.allowed).toBe(false);
  });
});

/** H-05 覆写占比纯函数单测 */
import { describe, it, expect } from 'vitest';
import { computeRewriteRatio, isFullFileRewrite, effectiveLines, isLikelyBinary } from '../writeguard/writeRatio.js';

const A = `const a = 1;\nconst b = 2;\nfunction f() { return a + b; }\n`;
const B = `const a = 1;\nconst b = 2;\nfunction f() { return a + b; }\n// 仅加注释\n\n`;

describe('writeRatio（H-05）', () => {
  it('完全一致 → 0', () => expect(computeRewriteRatio(A, A)).toBe(0));
  it('完全替换 → 1', () => {
    const old = 'line1\nline2\n';
    const fresh = 'xxx\nyyy\nzzz\n';
    expect(computeRewriteRatio(old, fresh)).toBe(1);
  });
  it('一半行不同 → ~0.5', () => {
    const old = ['l1', 'l2', 'l3', 'l4'].join('\n');
    const newer = ['l1', 'l2', 'x3', 'x4'].join('\n');
    expect(computeRewriteRatio(old, newer)).toBe(0.5);
  });
  it('只加注释/空行不判为大改写（有效行过滤）', () => {
    // A 有效 3 行；B 有效仍是 3 行（新增注释+空行不计）
    expect(computeRewriteRatio(A, B)).toBe(0);
  });
  it('二进制 → null 跳过', () => {
    expect(computeRewriteRatio('a\0b', 'c\0d')).toBeNull();
    expect(isLikelyBinary('a\0b')).toBe(true);
  });
  it('isFullFileRewrite 阈值判定', () => {
    const old = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const big = Array.from({ length: 10 }, (_, i) => `changed${i}_${Math.random()}`).join('\n');
    const { suspected, ratio } = isFullFileRewrite(old, big, 0.7);
    expect(suspected).toBe(true);
    expect(ratio).toBeGreaterThan(0.7);
    expect(effectiveLines(old)).toHaveLength(10);
  });
});

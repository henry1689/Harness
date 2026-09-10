/** H-02 manualVerify 纯逻辑单测 */
import { describe, it, expect } from 'vitest';
import { buildManualTicket, confirmItem, isAwaitingManual } from '../s6/manualVerify.js';

describe('manualVerify（H-02）', () => {
  it('buildManualTicket 默认 5 项未确认', () => {
    const t = buildManualTicket('r1');
    expect(t.items.length).toBeGreaterThanOrEqual(5);
    expect(t.items.every(i => i.confirmed === false)).toBe(true);
  });
  it('逐项确认至全完 → allConfirmed / isAwaiting 翻转', () => {
    const t = buildManualTicket('r2', [{ verify_item: '对话', precondition: '起', expected_result: '正常', verifier: '' }]);
    expect(isAwaitingManual(false, t)).toBe(true);
    expect(confirmItem(t, 0, 'owner')).toBe(true);
    expect(isAwaitingManual(false, t)).toBe(false);
  });
  it('skip_manual_verification=true → 永不等待', () => {
    expect(isAwaitingManual(true, null)).toBe(false);
  });
  it('无 ticket → 需先生成(等待)', () => {
    expect(isAwaitingManual(false, null)).toBe(true);
  });
});

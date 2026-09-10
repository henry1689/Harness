/** H-01 S7ArchiveValidator 分支单测 */
import { describe, it, expect } from 'vitest';
import { validateArchive, type S7ArchiveContext } from '../s7/S7ArchiveValidator.js';
import type { S7ArchivePayload } from '../schemas/s7-archive-payload.js';

function validPayload(): S7ArchivePayload {
  return {
    change_summary: '修X', audit_ref: 'run_x',
    rollback_plan: { modified_files: ['src/a.ts', 'src/b.ts'], rollback_steps: 'git revert' },
    verification_checklist: [{ item: 'tsc' }],
    debt_marker: { is_patch: false, debt_item_id: null },
  };
}
function ctx(over: Partial<S7ArchiveContext> = {}): S7ArchiveContext {
  return {
    diffFiles: ['src/a.ts', 'src/b.ts'], s45score: 99, isLargeRefactor: false,
    ledgerGetDebt: () => null, exemptionExists: () => true, ...over,
  };
}

describe('S7ArchiveValidator（H-01）', () => {
  it('非补丁 + 全字段 + 回滚一致 + score≥98 → 通过', () => {
    const v = validateArchive(validPayload(), ctx());
    expect(v.archive_valid).toBe(true);
  });
  it('场景A: 补丁未登记债务 → R2 拦截', () => {
    const p = validPayload();
    p.debt_marker = { is_patch: true, debt_item_id: null };
    const v = validateArchive(p, ctx());
    expect(v.errors.some(e => e.startsWith('R2'))).toBe(true);
  });
  it('场景B: 回滚漏记 1 个文件 → R3 拦截', () => {
    const p = validPayload();
    p.rollback_plan = { modified_files: ['src/a.ts'], rollback_steps: 'git revert' };
    const v = validateArchive(p, ctx());
    expect(v.errors.some(e => e.startsWith('R3'))).toBe(true);
  });
  it('场景C: score 92<98 无豁免 → R4 拦截；带豁免但不存在 → R4 拦截', () => {
    const p = validPayload();
    const v1 = validateArchive(p, ctx({ s45score: 92 }));
    expect(v1.errors.some(e => e.startsWith('R4'))).toBe(true);
    p.exemption_id = 'ex-xxx';
    const v2 = validateArchive(p, ctx({ s45score: 92, exemptionExists: () => false }));
    expect(v2.errors.some(e => e.startsWith('R4'))).toBe(true);
  });
  it('场景D: 补丁 + 合法 debt_id + 全字段 → 通过', () => {
    const p = validPayload();
    p.debt_marker = { is_patch: true, debt_item_id: 'debt_1' };
    const v = validateArchive(p, ctx({ ledgerGetDebt: () => ({ debt_id: 'debt_1' }) }));
    expect(v.archive_valid).toBe(true);
  });
  it('R5: 大重构缺三轮复审 → 拦截；补上则过', () => {
    const p = validPayload();
    p.rollback_plan.modified_files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    const v1 = validateArchive(p, ctx({ isLargeRefactor: true }));
    expect(v1.errors.some(e => e.startsWith('R5'))).toBe(true);
    p.debt_marker = { is_patch: false, debt_item_id: null, three_round_review_plan: '三轮' };
    const v2 = validateArchive(p, ctx({ isLargeRefactor: true, diffFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }));
    expect(v2.archive_valid).toBe(true);
  });
});

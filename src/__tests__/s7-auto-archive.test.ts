/**
 * P0-B：S7-A 进程内自动归档
 * ================================================================
 * 覆盖：R3 回滚清单与 diff 一致 / R4 豁免只引用不伪造 / R5 大重构填计划 /
 * is_patch 如实取自 s2_evidence / 已有归档不被覆盖 / 产物能通过 S7ArchiveValidator。
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { existsSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildAutoArchive, writeAutoArchive, autoArchivePathFor } from '../s7/s7AutoArchive.js';
import { validateArchive } from '../s7/S7ArchiveValidator.js';
import type { FlowRunState } from '../types.js';

const RUN_ID = 'run_test_p0b_auto_archive';
const ARCHIVE = autoArchivePathFor(RUN_ID);

// 用例间隔离：同一 RUN_ID 共用同一路径，前一用例写下的产物会干扰后一用例的「首次写入」
beforeEach(() => {
  if (existsSync(ARCHIVE)) rmSync(ARCHIVE, { force: true });
});

afterAll(() => {
  // 🔴 测试数据清理：按精确路径删除本次产物（勿按时间窗）
  if (existsSync(ARCHIVE)) rmSync(ARCHIVE, { force: true });
});

function mkState(over: Partial<FlowRunState> = {}): FlowRunState {
  return {
    run_id: RUN_ID,
    modified_files: ['src/a.ts'],
    ...over,
  } as unknown as FlowRunState;
}

describe('buildAutoArchive（纯函数）', () => {
  it('R3：rollback_plan.modified_files 与 state.modified_files 完全一致（不漏记不多记）', () => {
    const files = ['src/a.ts', 'src/b/c.ts'];
    const p = buildAutoArchive(mkState({ modified_files: files }));
    expect(p.rollback_plan.modified_files).toEqual(files);
    const v = validateArchive(p, { diffFiles: files, s45score: 99, isLargeRefactor: false });
    expect(v.errors.filter(e => e.startsWith('R3'))).toEqual([]);
  });

  it('R1：必填字段齐备', () => {
    const p = buildAutoArchive(mkState());
    expect(p.change_summary).toBeTruthy();
    expect(p.rollback_plan.rollback_steps).toBeTruthy();
    expect(Array.isArray(p.verification_checklist)).toBe(true);
    expect(typeof p.debt_marker.is_patch).toBe('boolean');
    expect(p.audit_ref).toBeTruthy();
  });

  it('R5：≥3 文件填 three_round_review_plan；<3 文件留空', () => {
    const big = buildAutoArchive(mkState({ modified_files: ['a.ts', 'b.ts', 'c.ts'] }));
    expect(big.debt_marker.three_round_review_plan).toBeTruthy();
    const small = buildAutoArchive(mkState({ modified_files: ['a.ts', 'b.ts'] }));
    expect(small.debt_marker.three_round_review_plan).toBeNull();
  });

  it('is_patch 如实取自 s2_evidence（patch_plan.is_available）', () => {
    const patch = buildAutoArchive(mkState({
      s2_evidence: { approval_ref: 'r', approved_plan: 'p', patch_plan: { is_available: true } },
    } as never));
    expect(patch.debt_marker.is_patch).toBe(true);
    const normal = buildAutoArchive(mkState({
      s2_evidence: { approval_ref: 'r', approved_plan: 'p', final_approved_plan: 'arch_structural' },
    } as never));
    expect(normal.debt_marker.is_patch).toBe(false);
  });

  it('R2：补丁但查不到债务 → debt_item_id 留空（不伪造 id，交给 R2 拒绝）', () => {
    const p = buildAutoArchive(mkState({
      modified_files: ['zz_no_such_run.ts'],
      s2_evidence: { approval_ref: 'r', approved_plan: 'p', final_approved_plan: 'patch' },
      run_id: 'run_test_p0b_no_such_debt',
    } as never));
    expect(p.debt_marker.is_patch).toBe(true);
    expect(p.debt_marker.debt_item_id).toBeNull();
    const v = validateArchive(p, { diffFiles: ['zz_no_such_run.ts'], s45score: 99, isLargeRefactor: false });
    expect(v.errors.some(e => e.startsWith('R2'))).toBe(true);
  });

  it('R4：豁免为「只引用」——查不到时留空，由 R4 报缺豁免（可行动），而非静默通过', () => {
    const p = buildAutoArchive(mkState({ modified_files: ['definitely/not/exempted_xyz.ts'] }));
    expect(p.exemption_id).toBeNull();
    const v = validateArchive(p, { diffFiles: ['definitely/not/exempted_xyz.ts'], s45score: 90.7, isLargeRefactor: false });
    expect(v.errors.some(e => e.includes('R4') && e.includes('必须携带 exemption_id'))).toBe(true);
  });
});

describe('writeAutoArchive（落盘）', () => {
  it('写入后能被 S7ArchiveValidator 通过（豁免台账存在时）', () => {
    const files = ['src/a.ts'];
    const state = mkState({
      modified_files: files,
      s2_evidence: { approval_ref: 'r', approved_plan: '闪屏修复', final_approved_plan: 'arch_structural' },
    } as never);

    // 若环境中恰好命中真实豁免，则 R4 走「引用已有豁免」；否则自行注入豁免存在性
    const out = writeAutoArchive(state);
    expect(out.written).toBe(true);
    expect(existsSync(ARCHIVE)).toBe(true);

    const payload = JSON.parse(readFileSync(ARCHIVE, 'utf-8'));
    const v = validateArchive(payload, {
      diffFiles: files,
      s45score: payload.exemption_id ? 90.7 : 99, // 有豁免则模拟 <98 场景
      isLargeRefactor: false,
      exemptionExists: () => true,
    });
    expect(v.errors).toEqual([]);
    expect(v.archive_valid).toBe(true);
  });

  it('已有归档 → 不覆盖（保留 Agent/人工写的那一份）', () => {
    const state = mkState({ modified_files: ['src/a.ts'] });
    const first = writeAutoArchive(state);
    expect(first.written).toBe(true);

    // 人为改成一份「人工版」
    mkdirSync(dirname(ARCHIVE), { recursive: true });
    writeFileSync(ARCHIVE, JSON.stringify({ change_summary: '人工写的归档', __manual: true }), 'utf-8');

    const second = writeAutoArchive(state);
    expect(second.written).toBe(false);
    expect(second.skipped_reason).toContain('已存在');
    expect(JSON.parse(readFileSync(ARCHIVE, 'utf-8')).__manual).toBe(true);
  });
});

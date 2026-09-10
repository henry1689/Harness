/**
 * H-03 / P1-1：S2「选补丁方案」→ 自动登记技术债
 * ================================================================
 * 台账三环的第一环（另两环：S4.5 DS<98→候选池、S7-B R2 校验 debt_id 存在）。
 * 覆盖：非补丁跳过 / 已绑定回填 / 未绑定新建 / 建账失败降级不阻断。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePatchDebt } from '../debt/s2PatchDebt.js';
import { openLedger, hasSqlite } from '../debt/techDebtLedger.js';

const TEST_DB = join(process.cwd(), 'data', 'harness_db', '_s2patch_test_debt.sqlite');

afterAll(() => {
  // 🔴 测试数据清理：删除本次用的临时台账库文件（含 -wal/-shm）
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TEST_DB + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

describe('ensurePatchDebt（S2 补丁 → 债务自动登记）', () => {
  it('非补丁方案 → 跳过且不建账', () => {
    const out = ensurePatchDebt(
      { approval_ref: 'r1', approved_plan: '架构重构', final_approved_plan: 'arch_structural', patch_plan: { is_available: false } },
      { dbPath: TEST_DB },
    );
    expect(out.created).toBe(false);
    expect(out.debt_id).toBeNull();
    expect(out.skipped_reason).toContain('非补丁方案');
  });

  it('补丁方案但补丁不可用（未采纳）→ 跳过', () => {
    const out = ensurePatchDebt(
      { approval_ref: 'r2', approved_plan: 'x', patch_plan: { is_available: false } },
      { dbPath: TEST_DB },
    );
    expect(out.debt_id).toBeNull();
    expect(out.skipped_reason).toContain('非补丁方案');
  });

  it('补丁方案 + 已绑定 associated_debt_id → 直接回填，不新建', () => {
    const out = ensurePatchDebt(
      { approval_ref: 'r3', approved_plan: 'x', final_approved_plan: 'patch', patch_plan: { is_available: true, associated_debt_id: 'debt_existing_001' } },
      { dbPath: TEST_DB },
    );
    expect(out.created).toBe(false);
    expect(out.debt_id).toBe('debt_existing_001');
  });

  it('补丁方案 + 未绑定 → 新建台账条目并可查回', () => {
    if (!hasSqlite()) return; // 无 node:sqlite 时跳过（其余分支仍受保护）
    const out = ensurePatchDebt(
      {
        approval_ref: 'src/x.test.ts (绑定测试)',
        approved_plan: '短期补丁式修复：先堵住异常路径',
        problem_nature: 'coupling_debt',
        final_approved_plan: 'patch',
        patch_plan: { is_available: true, change_scope: ['src/a.ts', 'src/b.ts'], debt_risks: '后续需重构', payback_milestone: 'P2' },
      },
      { dbPath: TEST_DB, runId: 'run_test_s2debt' },
    );
    expect(out.created).toBe(true);
    expect(out.debt_id).toMatch(/^debt_/);

    const ledger = openLedger(TEST_DB);
    try {
      const rec = ledger.getDebt(out.debt_id!);
      expect(rec).toBeTruthy();
      expect(rec!.debt_title).toContain('[S2补丁]');
      expect(rec!.problem_nature).toBe('coupling_debt');
      expect(rec!.payback_milestone).toBe('P2');
      expect(rec!.description).toContain('src/a.ts');
      // linkRun：登记为 created 事件
      const runs = ledger.runsForDebt(out.debt_id!);
      expect(runs.some(r => r.audit_ref === 'run_test_s2debt' && r.debt_occur_type === 'created')).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it('problem_nature 非法值 → 归一为 coupling_debt（不抛异常）', () => {
    if (!hasSqlite()) return;
    const out = ensurePatchDebt(
      { approval_ref: 'r5', approved_plan: 'x', problem_nature: '乱填的值', final_approved_plan: 'patch', patch_plan: { is_available: true } },
      { dbPath: TEST_DB },
    );
    expect(out.created).toBe(true);
    const ledger = openLedger(TEST_DB);
    try {
      expect(ledger.getDebt(out.debt_id!)!.problem_nature).toBe('coupling_debt');
    } finally {
      ledger.close();
    }
  });

  it('台账路径不可用 → 降级跳过、不抛异常（不阻断已批准的流程）', () => {
    const out = ensurePatchDebt(
      { approval_ref: 'r6', approved_plan: 'x', final_approved_plan: 'patch', patch_plan: { is_available: true } },
      // 用一个非法路径（目录不存在且无法创建：以文件路径充当目录）触发异常
      { dbPath: join(process.cwd(), 'package.json', 'nested', 'x.sqlite') },
    );
    expect(out.created).toBe(false);
    expect(out.debt_id).toBeNull();
    expect(out.skipped_reason).toBeTruthy();
  });
});

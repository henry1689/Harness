/**
 * H-01 S7-B 归档校验 delegate 端到端（01 方案 §5 回归用例）
 * 覆盖：缺归档产物 / 合规通过 / 缺债务(R2) / 回滚清单漏记(R3) / 大重构缺三轮复审(R5)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { s7ArchiveValidateDelegate, archivePathForRun } from '../s7/S7ArchiveDelegate.js';
import type { S7ArchivePayload } from '../schemas/s7-archive-payload.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const ARCHIVES = join(DATA_DIR, 'archives');
const RUNS = ['run_t_s7_none', 'run_t_s7_ok', 'run_t_s7_debt', 'run_t_s7_roll', 'run_t_s7_large'];

/** 写入归档产物 */
function writeArchive(runId: string, payload: Partial<S7ArchivePayload>): void {
  if (!existsSync(ARCHIVES)) mkdirSync(ARCHIVES, { recursive: true });
  writeFileSync(archivePathForRun(runId), JSON.stringify(payload, null, 2), 'utf-8');
}

/** 状态桩：3 文件（大重构）、S4.5 末轮 99 分（R4 不触发） */
function state(runId: string, files: string[], score = 99) {
  return { run_id: runId, modified_files: files, convergence_history: [{ overallScore: score }] } as never;
}

afterAll(() => {
  // 🔴 测试数据清理：删除本测试写入的归档产物，不留残留
  for (const r of RUNS) {
    const p = archivePathForRun(r);
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

describe('s7ArchiveValidateDelegate（H-01 S7-B）', () => {
  it('无归档产物 → 驳回（high），指明 S7-A 必须产出 data/archives/<run_id>.json', async () => {
    const out = await s7ArchiveValidateDelegate({} as never, state('run_t_s7_none', ['src/a.ts'], 99));
    expect(out.machine_signal.passed).toBe(false);
    expect(out.machine_signal.risk_level).toBe('high');
    expect(out.human_report).toContain('data/archives/');
    expect(out.machine_signal.reject_reason.join(' ')).toContain('未找到 S7-A 归档产物');
  });

  it('合规归档（非补丁 / 3 文件 / 含三轮复审）→ 通过', async () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    writeArchive('run_t_s7_ok', {
      change_summary: '修复 X 缺陷',
      rollback_plan: { modified_files: files, rollback_steps: 'git checkout -- 三个文件' },
      verification_checklist: [{ item: 'tsc', evidence: '0 error' }],
      debt_marker: { is_patch: false, debt_item_id: null, three_round_review_plan: '三轮对比审计已执行' },
      audit_ref: 'data/audit/run_t_s7_ok',
    });
    const out = await s7ArchiveValidateDelegate({} as never, state('run_t_s7_ok', files, 99));
    expect(out.machine_signal.passed).toBe(true);
    expect(out.human_report).toContain('S7-B 归档校验通过');
  });

  it('R2 缺债务：is_patch=true 但无 debt_item_id → 驳回', async () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    writeArchive('run_t_s7_debt', {
      change_summary: '补丁式修复',
      rollback_plan: { modified_files: files, rollback_steps: 'git checkout' },
      verification_checklist: [{ item: 'tsc', evidence: 'ok' }],
      debt_marker: { is_patch: true, debt_item_id: null, three_round_review_plan: '三轮审计' },
      audit_ref: 'ref',
    });
    const out = await s7ArchiveValidateDelegate({} as never, state('run_t_s7_debt', files, 99));
    expect(out.machine_signal.passed).toBe(false);
    expect(out.human_report).toContain('R2');
  });

  it('R3 回滚清单漏记 diff 文件 → 驳回', async () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    writeArchive('run_t_s7_roll', {
      change_summary: '漏记回滚',
      rollback_plan: { modified_files: ['src/a.ts'], rollback_steps: '回滚 a' }, // 漏 b/c
      verification_checklist: [{ item: 'tsc', evidence: 'ok' }],
      debt_marker: { is_patch: false, debt_item_id: null, three_round_review_plan: '三轮审计' },
      audit_ref: 'ref',
    });
    const out = await s7ArchiveValidateDelegate({} as never, state('run_t_s7_roll', files, 99));
    expect(out.machine_signal.passed).toBe(false);
    expect(out.human_report).toContain('R3');
    expect(out.human_report).toContain('漏记');
  });

  it('R5 大重构（≥3 文件）缺 three_round_review_plan → 驳回', async () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    writeArchive('run_t_s7_large', {
      change_summary: '大重构',
      rollback_plan: { modified_files: files, rollback_steps: '整体回滚' },
      verification_checklist: [{ item: 'tsc', evidence: 'ok' }],
      debt_marker: { is_patch: false, debt_item_id: null }, // 缺 three_round_review_plan
      audit_ref: 'ref',
    });
    const out = await s7ArchiveValidateDelegate({} as never, state('run_t_s7_large', files, 99));
    expect(out.machine_signal.passed).toBe(false);
    expect(out.human_report).toContain('R5');
  });
});

/**
 * B0 骨架/schema/DB 单元测试
 * =================================================
 * 覆盖（任务单 B0 范围，仅静态/schema/DB；不涉 E/H 业务接入）：
 *   1. s2-evidence-v2 / s7-archive-payload / manual-ticket / full-evidence 校验器各分支
 *   2. full_review_evidence 结构化压缩（机器字段不裁剪）
 *   3. 4 份 json-schema 静态可解析
 *   4. tech_debt_ledger CRUD + 候选池（node:sqlite，临时库用完即删）
 *   5. migrate CLI --validate-schema exit 0
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateS2EvidenceV2, type S2EvidenceV2 } from '../schemas/s2-evidence-v2.js';
import { validateS7ArchivePayload, type S7ArchivePayload } from '../schemas/s7-archive-payload.js';
import { validateManualTicket, allConfirmed, type ManualVerificationTicket } from '../schemas/manual-verification-ticket.js';
import { validateFullEvidence, compressFullEvidence, assembleFullReviewEvidence, type FullReviewEvidence } from '../schemas/full-review-evidence.js';
import { TechDebtLedger } from '../debt/techDebtLedger.js';

const TEST_DB = join(process.cwd(), 'data', 'harness_db', '_b0_test_debt.sqlite');
let ledger: TechDebtLedger | null = null;

beforeAll(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  ledger = new TechDebtLedger(TEST_DB);
});

afterAll(() => {
  try { ledger?.close(); } catch { /* ignore */ }
  try { rmSync(TEST_DB, { force: true }); } catch { /* ignore */ }
});

function validS2(): S2EvidenceV2 {
  return {
    approval_ref: 'ar-1', problem_nature: 'arch_structural_defect',
    patch_plan: { is_available: false, change_scope: ['src/a.ts'], not_available_reason: '需根治' },
    arch_structural_plan: { is_available: true, change_scope: ['src/a.ts', 'src/b.ts'], benefit: '去耦合' },
    final_approved_plan: 'arch_structural',
    confirmations: ['FG_REDLINE_8'],
  };
}

describe('s2-evidence-v2', () => {
  it('合法通过', () => expect(validateS2EvidenceV2(validS2())).toHaveLength(0));
  it('选 patch 未绑定债务 → 拒（H-03）', () => {
    const o = validS2();
    o.final_approved_plan = 'patch';
    o.patch_plan = { is_available: true, change_scope: ['src/a.ts'], short_term_effect: '快' };
    expect(validateS2EvidenceV2(o).some(m => m.includes('associated_debt_id'))).toBe(true);
  });
  it('problem_nature 非法 → 拒', () => {
    const o = validS2() as unknown as Record<string, unknown>;
    o.problem_nature = 'xxx';
    expect(validateS2EvidenceV2(o).some(m => m.includes('problem_nature 非法'))).toBe(true);
  });
});

describe('s7-archive-payload', () => {
  const valid: S7ArchivePayload = {
    change_summary: '修X', audit_ref: 'run_x',
    rollback_plan: { modified_files: ['src/a.ts'], rollback_steps: 'git revert' },
    verification_checklist: [{ item: 'tsc' }],
    debt_marker: { is_patch: false, debt_item_id: null },
  };
  it('合法通过', () => expect(validateS7ArchivePayload(valid)).toHaveLength(0));
  it('补丁未登记债务 → 拒（H-01）', () => {
    const o = { ...valid, debt_marker: { is_patch: true, debt_item_id: null } };
    expect(validateS7ArchivePayload(o).some(m => m.includes('debt_item_id'))).toBe(true);
  });
  it('缺 audit_ref → 拒', () => {
    const { audit_ref: _drop, ...rest } = valid;
    void _drop;
    expect(validateS7ArchivePayload(rest).some(m => m.includes('audit_ref'))).toBe(true);
  });
});

describe('manual-verification-ticket', () => {
  const ticket: ManualVerificationTicket = {
    run_id: 'r1', generated_at: '2026-09-09',
    items: [{ verify_item: 'WebUI对话', precondition: '服务起', expected_result: '正常', verifier: 'owner', confirmed: false }],
  };
  it('未确认 → allConfirmed=false', () => expect(allConfirmed(ticket)).toBe(false));
  it('全确认 → true', () => {
    ticket.items[0]!.confirmed = true;
    expect(allConfirmed(ticket)).toBe(true);
  });
  it('validate 通过', () => expect(validateManualTicket(ticket)).toHaveLength(0));
});

describe('full-review-evidence', () => {
  const ev: FullReviewEvidence = {
    run_id: 'r1', convergence_round: 1, summary: 'x'.repeat(3000),
    dim_review: { arch: { ok: true } },
    ck_reports: [{ ck_id: 'CK-05', passed: false, violations: [{ message: '编目不同步' }] }],
    ds_score_details: [{ ds_id: 'DS-06', score_delta: -40, reason: '编目不同步', suggest_fix: '同步', machine_sourced: true }],
  };
  it('validate 通过', () => expect(validateFullEvidence(ev)).toHaveLength(0));
  it('压缩截断自由文本但保留机器字段（H-04）', () => {
    const c = compressFullEvidence(ev, 100);
    expect(c.summary.length).toBeLessThan(150);
    expect(c.ds_score_details[0]!.machine_sourced).toBe(true); // 机器字段不裁剪
    expect(c.ds_score_details[0]!.ds_id).toBe('DS-06');
    expect(c.ck_reports).toHaveLength(1);
  });
  it('assembleFullReviewEvidence 装配完整并可通过 validate（H-04）', () => {
    const built = assembleFullReviewEvidence({
      run_id: 'r1', convergence_round: 2, summary: 's',
      ck_reports: [{ ck_id: 'CK-05', passed: false, violations: [{ message: 'x' }] }],
      ds_score_details: [{ ds_id: 'DS-06', score_delta: -40, reason: 'r', suggest_fix: 'f', machine_sourced: true }],
      dim_review: { arch: { ok: false } },
    });
    expect(validateFullEvidence(built)).toHaveLength(0);
    expect(built.convergence_round).toBe(2);
  });
});

describe('json-schema 静态可解析', () => {
  const files = ['s2-evidence-v2', 'full-review-evidence', 's7-archive-payload', 'manual-verification-ticket'];
  for (const f of files) {
    it(`${f}.schema.json 合法`, () => {
      const j = JSON.parse(readFileSync(join(process.cwd(), 'src', 'schemas', `${f}.schema.json`), 'utf-8'));
      expect(j.$schema).toContain('draft-07');
    });
  }
});

describe('tech_debt_ledger CRUD（node:sqlite 临时库）', () => {
  it('createDebt + getDebt + list + linkRun + runsForDebt', () => {
    const d = ledger!.createDebt({
      debt_title: 'X耦合债', problem_nature: 'coupling_debt', risk_level: 'high',
      description: '测试债', related_milestones: ['P2#8'], origin_audit_ref: 'run_test_1',
      payback_plan: '拆文件', payback_milestone: 'P2#8',
    });
    expect(ledger!.getDebt(d.debt_id)?.debt_status).toBe('open');
    ledger!.linkRun(d.debt_id, 'run_test_1', 'created');
    expect(ledger!.runsForDebt(d.debt_id)).toHaveLength(1);
    ledger!.updateStatus(d.debt_id, 'resolved');
    expect(ledger!.getDebt(d.debt_id)?.resolved_at).toBeTruthy();
    expect(ledger!.listDebts({ status: 'resolved' }).length).toBeGreaterThanOrEqual(1);
  });
  it('候选池 add → accept 转正 / discard', () => {
    const cid = ledger!.addCandidate({ source_audit_ref: 'run_test_2', ds_violate_list: ['DS-06'], ck_violate_list: ['CK-05'], risk_hint: '编目债' });
    expect(ledger!.listCandidates('pending').some(c => c.candidate_id === cid)).toBe(true);
    const d = ledger!.acceptCandidate(cid, { problem_nature: 'coupling_debt', risk_level: 'medium', description: '转正', related_milestones: ['P0-A'], payback_plan: 'p' });
    expect(d?.origin_audit_ref).toBe('run_test_2');
    expect(ledger!.listCandidates('pending').some(c => c.candidate_id === cid)).toBe(false);
  });
});

describe('migrate CLI --validate-schema', () => {
  it('exit 0（DDL 与期望一致）', () => {
    const out = execFileSync('node', [join(process.cwd(), 'scripts', 'harness-debt-migrate.cjs'), '--validate-schema'], { encoding: 'utf-8' });
    expect(out).toContain('schema 校验通过');
  });
});

// M-02 ContractResolver 骨架已于 2026-09-11 按 07 计划 P1-2 显式删除（去半成品）。
// 该骨架自创建起零生产调用方（仅自身 + 断言其抛错的测试引用），从未接线。
// 若将来真要落地契约映射，见 07 计划重新立项。

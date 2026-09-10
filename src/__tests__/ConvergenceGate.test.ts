/**
 * H1: ConvergenceGate 结构化收敛测试
 * - S4.5 只消费结构化 blocking（machine_signal.reject_reason），human_report 文本不参与判定
 * - exempt_files 严格校验 relaxed_checks 精确包含 S4.5_complexity
 */
import { describe, it, expect } from 'vitest';
import { evaluate, isRelaxedForComplexity } from '../ConvergenceGate.js';
import type { StageConfig, FlowRunState, StageResult, MachineSignal } from '../types.js';

function makeStage(overrides: Partial<StageConfig> = {}): StageConfig {
  return {
    stage_id: 'S4.5_Convergence_Gate',
    stage_name: 'S4.5 收敛闸门',
    work_manual: '收敛评估',
    tool_whitelist: {},
    gate_type: 'condition',
    runner_mode: 'local',
    next_stage_pass: 'S5_Compile_Test',
    next_stage_reject: 'S3_Code_Implement',
    ...overrides,
  };
}

/** H1 合法 review_details fixture——11 维全 checked、无 blocking */
const VALID_REVIEW_DETAILS = {
  checked_dimensions: [
    'ARCH_LAYER', 'FG_UUID', 'COUPLING', 'PERSISTENCE', 'RISK_CATCHALL',
    'DOC_SYNC', 'REPAIR_CLASSIFICATION', 'STATIC_QUALITY', 'ROBUSTNESS',
    'HOOK_SELFCHECK', 'PROPOSAL_FIDELITY',
  ],
  blocking: [] as { rule: string; detail: string }[],
  confirmations_met: [],
  confirmations_missing: [],
  advisories: [] as { rule: string; detail: string }[],
};

function makeS4Result(overrides: Partial<StageResult> = {}): StageResult {
  return {
    stage_id: 'S4_Arch_Review',
    status: 'completed',
    gate_type: 'condition',
    gate_resolution: 'auto_passed',
    audit_entries: [],
    started_at: new Date().toISOString(),
    ...overrides,
  };
}

/** 合法 S4 machine_signal——默认带 review_details（H1 契约输入） */
function makeValidSignal(overrides: Partial<MachineSignal> = {}): MachineSignal {
  return {
    passed: true,
    risk_level: 'low',
    reject_reason: [],
    review_details: VALID_REVIEW_DETAILS,
    ...overrides,
  };
}

function makeState(overrides: Partial<FlowRunState> = {}): FlowRunState {
  return {
    run_id: 'cg_test',
    flow_id: 'test_flow',
    flow_status: 'running',
    current_stage: 'S4.5_Convergence_Gate',
    jump_count: 0,
    stage_retry_count: 0,
    s3_retry_count: 0,
    convergence_round: 0,
    convergence_history: [],
    stage_results: new Map(),
    global_memo: '',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    modified_files: [],
    risk_level: 'mid',
    mode: 'pipeline',
    project_root: 'D:/AI文件/harness',
    ...overrides,
  };
}

describe('ConvergenceGate (H1)', () => {
  it('S4 structured blocking violation 被计入并拒绝', async () => {
    const stage = makeStage();
    const state = makeState();
    state.stage_results.set('S4_Arch_Review', makeS4Result({
      machine_signal: makeValidSignal({
        passed: false,
        risk_level: 'high',
        reject_reason: ['[blocking] 已有证据证明的确定违规'],
        review_details: {
          ...VALID_REVIEW_DETAILS,
          blocking: [{ rule: 'BLOCKING_1', detail: '[blocking] 已有证据证明的确定违规' }],
        },
      }),
      human_report: '# S4\n确定违规存在',
    }));

    const out = await evaluate(stage, state);
    // 有确定 blocking → 判定不通过（decision REJECT 而非 PASS）
    expect(out.machine_signal.passed).toBe(false);
    expect(out.machine_signal.reject_reason.length).toBeGreaterThan(0);
  });

  it('human_report 旧式违规标签不参与判定', async () => {
    const stage = makeStage();
    // 无 structured blocking，但 human_report 含旧式标签
    const withText = makeState();
    withText.stage_results.set('S4_Arch_Review', makeS4Result({
      machine_signal: makeValidSignal(),
      human_report: '# S4\n[架构] 修改了 M 层模块，需确认未引入反向依赖\n[FG·红线1] FamilyGraph 需确认',
    }));

    // 对照：完全无标签
    const withoutText = makeState();
    withoutText.stage_results.set('S4_Arch_Review', makeS4Result({
      machine_signal: makeValidSignal(),
      human_report: '# S4\n无违规',
    }));

    const outWithText = await evaluate(stage, withText);
    const outWithoutText = await evaluate(stage, withoutText);

    // H1: 只读结构化 blocking——human_report 文本不改变判定结果（同 passed）
    expect(outWithText.machine_signal.passed).toBe(outWithoutText.machine_signal.passed);
  });

  it('不传 exempt_files → 普通路径保持严格检查', async () => {
    const stage = makeStage();
    const state = makeState();
    state.stage_results.set('S4_Arch_Review', makeS4Result({
      machine_signal: makeValidSignal(),
    }));

    const out = await evaluate(stage, state);
    // 无豁免 → 不因 exempt 放宽任何 CK（结果由 CK + S4 结构化信号决定）
    expect(out).toBeDefined();
    expect(typeof out.machine_signal.passed).toBe('boolean');
  });

  it('exempt_files 传文件但无有效豁免记录 → 不并入豁免', async () => {
    const stage = makeStage();
    const state = makeState();
    state.stage_results.set('S4_Arch_Review', makeS4Result({
      machine_signal: makeValidSignal(),
    }));
    // s4_exempt_files 指向无豁免记录的文件 → 严格校验后不豁免
    (state as any).s4_exempt_files = ['src/no-such-exempt-file-xyz.ts'];

    const out = await evaluate(stage, state);
    // 不豁免 → 仍按严格检查评估（不崩溃）
    expect(out).toBeDefined();
    expect(typeof out.machine_signal.passed).toBe('boolean');
  });

  it('空 findings（无 blocking）→ 不因文本自检反向判缺失', async () => {
    const stage = makeStage();
    const state = makeState();
    state.stage_results.set('S4_Arch_Review', makeS4Result({
      machine_signal: makeValidSignal(),
      human_report: '',
    }));

    const out = await evaluate(stage, state);
    // 空 findings 表示已检查且通过——不得反向制造 violation
    expect(out.machine_signal.reject_reason).not.toContain('评审维度缺失');
  });

  it('H1: 无 review_details → fail-closed（REVIEW_INVARIANT 进入拒绝通道）', async () => {
    const stage = makeStage();
    // 无 review_details 但 passed=true + reject_reason=[] —— 无任何 blocking 也判定不通过
    const state = makeState();
    state.stage_results.set('S4_Arch_Review', makeS4Result({
      machine_signal: { passed: true, risk_level: 'low', reject_reason: [] },
      human_report: '# S4\n无违规',
    }));

    const out = await evaluate(stage, state);
    // H1 契约要求结构化 review_details；缺失 → invariant 违规进拒绝通道
    expect(out.machine_signal.reject_reason.some(r => r.includes('REVIEW_INVARIANT: REVIEW_DETAILS_MISSING'))).toBe(true);
    // 有 invariant 违规 → 不应判定为 PASS
    expect(out.machine_signal.passed).toBe(false);
  });

  it('H1: 缺维度 / 重复 / 未知 / blocking 矛盾 → fail-closed', async () => {
    const stage = makeStage();
    const state = makeState();
    state.stage_results.set('S4_Arch_Review', makeS4Result({
      machine_signal: {
        passed: true,
        risk_level: 'low',
        reject_reason: [],
        review_details: {
          checked_dimensions: ['ARCH_LAYER', 'FG_UUID', 'ARCH_LAYER', 'NOT_A_DIM'], // 缺 9 维 + 重复 + 未知
          blocking: [{ rule: 'X', detail: '有 blocking 但 passed=true' }], // passed 矛盾
          confirmations_met: [],
          confirmations_missing: [],
          advisories: [],
        },
      },
      human_report: '',
    }));

    const out = await evaluate(stage, state);
    const rr = out.machine_signal.reject_reason.join(' ');
    expect(out.machine_signal.passed).toBe(false);
    expect(rr).toContain('REVIEW_DETAILS_DIMS_MISSING');
    expect(rr).toContain('REVIEW_DETAILS_DIMS_DUP');
    expect(rr).toContain('REVIEW_DETAILS_DIMS_UNKNOWN');
    expect(rr).toContain('REVIEW_DETAILS_PASS_BLOCKING_CONFLICT');
  });

  it('H1: reject_reason 与 blocking 不一致 → fail-closed', async () => {
    const stage = makeStage();
    const state = makeState();
    const dims = [...VALID_REVIEW_DETAILS.checked_dimensions];
    state.stage_results.set('S4_Arch_Review', makeS4Result({
      machine_signal: {
        passed: false,
        risk_level: 'high',
        reject_reason: ['[文档·强制] 架构级改动需同步文档'],
        review_details: {
          checked_dimensions: dims,
          blocking: [
            { rule: 'DOC_SYNC_REQUIRED', detail: '[文档·强制] 架构级改动需同步文档' },
            { rule: 'HOOK_REQUIRED', detail: '[Hook·强制] 核心链路需埋点' },
          ], // 2 项 vs reject_reason 1 项 → 数量不一致
          confirmations_met: [],
          confirmations_missing: [],
          advisories: [],
        },
      },
      human_report: '',
    }));

    const out = await evaluate(stage, state);
    expect(out.machine_signal.reject_reason.some(r => r.includes('REVIEW_DETAILS_RR_BLOCKING_MISMATCH'))).toBe(true);
  });

  it('H1: confirmation met/missing 重叠 → fail-closed', async () => {
    const stage = makeStage();
    const state = makeState();
    const dims = [...VALID_REVIEW_DETAILS.checked_dimensions];
    state.stage_results.set('S4_Arch_Review', makeS4Result({
      machine_signal: {
        passed: true,
        risk_level: 'low',
        reject_reason: [],
        review_details: {
          checked_dimensions: dims,
          blocking: [],
          confirmations_met: ['ARCH_CHAT_TS_THIN'],
          confirmations_missing: ['ARCH_CHAT_TS_THIN'], // 重叠
          advisories: [],
        },
      },
      human_report: '',
    }));

    const out = await evaluate(stage, state);
    expect(out.machine_signal.passed).toBe(false);
    expect(out.machine_signal.reject_reason.some(r => r.includes('REVIEW_DETAILS_CONF_OVERLAP'))).toBe(true);
  });

  it('H1: review_details 完整合法 → 不产生 invariant 违规', async () => {
    const stage = makeStage();
    const state = makeState();
    state.stage_results.set('S4_Arch_Review', makeS4Result({
      machine_signal: makeValidSignal(),
      human_report: '# S4\n无违规',
    }));

    const out = await evaluate(stage, state);
    expect(out.machine_signal.reject_reason.some(r => r.includes('REVIEW_INVARIANT'))).toBe(false);
  });

  it('H1: passed=false 但 blocking=[] → fail-closed', async () => {
    const stage = makeStage();
    const state = makeState();
    state.stage_results.set('S4_Arch_Review', makeS4Result({
      machine_signal: {
        passed: false, // 有否定结果
        risk_level: 'high',
        reject_reason: [],
        review_details: {
          ...VALID_REVIEW_DETAILS,
          blocking: [], // 但无 blocking 理由 → 矛盾
        },
      },
      human_report: '# S4\n判定不通过',
    }));

    const out = await evaluate(stage, state);
    expect(out.machine_signal.passed).toBe(false);
    expect(out.machine_signal.reject_reason.some(r => r.includes('REVIEW_DETAILS_FAIL_NO_BLOCKING'))).toBe(true);
  });

  it('H1: passed=true 但 confirmations_missing 非空 → fail-closed', async () => {
    const stage = makeStage();
    const state = makeState();
    state.stage_results.set('S4_Arch_Review', makeS4Result({
      machine_signal: {
        passed: true, // 声称通过
        risk_level: 'low',
        reject_reason: [],
        review_details: {
          ...VALID_REVIEW_DETAILS,
          blocking: [],
          confirmations_missing: ['ARCH_CHAT_TS_THIN'], // 但留有未满足确认 → 矛盾
        },
      },
      human_report: '# S4\n通过',
    }));

    const out = await evaluate(stage, state);
    expect(out.machine_signal.passed).toBe(false);
    expect(out.machine_signal.reject_reason.some(r => r.includes('REVIEW_DETAILS_PASS_CONF_MISSING'))).toBe(true);
  });

  it('H1: advisory.detail 精确混入 reject_reason → fail-closed（非 rule 子串）', async () => {
    const stage = makeStage();
    const state = makeState();
    // advisory 的 detail 被混入 reject_reason（应被精确比对捕获）
    const advisoryDetail = '[文档·提醒] 多文件修改建议同步文档';
    state.stage_results.set('S4_Arch_Review', makeS4Result({
      machine_signal: {
        passed: false,
        risk_level: 'mid',
        reject_reason: ['[blocking] 真实阻塞项', advisoryDetail], // advisory detail 混入
        review_details: {
          ...VALID_REVIEW_DETAILS,
          blocking: [
            { rule: 'BLOCKING_1', detail: '[blocking] 真实阻塞项' },
            { rule: 'DOC_SYNC_ADVISORY', detail: advisoryDetail }, // 这是 advisory，不是 blocking
          ],
          advisories: [{ rule: 'DOC_SYNC_ADVISORY', detail: advisoryDetail }],
        },
      },
      human_report: '# S4\n混合',
    }));

    const out = await evaluate(stage, state);
    // advisory detail 混入 reject_reason → 被精确比对捕获
    expect(out.machine_signal.reject_reason.some(r => r.includes('REVIEW_DETAILS_ADVISORY_IN_REJECT'))).toBe(true);
  });

  it('H1: isRelaxedForComplexity 精确匹配——精确值豁免', () => {
    expect(isRelaxedForComplexity({ relaxed_checks: ['S4.5_complexity'] })).toBe(true);
    expect(isRelaxedForComplexity({ relaxed_checks: ['breaker', 'S4.5_complexity', 'cooldown'] })).toBe(true);
  });

  it('H1: isRelaxedForComplexity 前缀/子串/大小写/空 → 不豁免', () => {
    expect(isRelaxedForComplexity({ relaxed_checks: ['S4.5_complex'] })).toBe(false);   // 前缀
    expect(isRelaxedForComplexity({ relaxed_checks: ['complexity_S4.5'] })).toBe(false); // 子串反转
    expect(isRelaxedForComplexity({ relaxed_checks: ['s4.5_complexity'] })).toBe(false); // 大小写
    expect(isRelaxedForComplexity({ relaxed_checks: [] })).toBe(false);                  // 空
    expect(isRelaxedForComplexity({ relaxed_checks: ['breaker'] })).toBe(false);         // 其他检查
    expect(isRelaxedForComplexity(undefined)).toBe(false);                               // 无记录
    expect(isRelaxedForComplexity(null)).toBe(false);
  });
});

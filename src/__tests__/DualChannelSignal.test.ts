/**
 * H1: DualChannelSignal 双通道信号编解码测试
 * - validateMachineSignal 保留合法对象形态的 review_details（S4→S4.5 契约通道）
 * - 非法 review_details → 缺失（undefined），由 ConvergenceGate 继续 fail-closed
 * - encode→decode round-trip 不丢 review_details
 * - StageOutput 校验、非法输入 fail-closed
 */
import { describe, it, expect } from 'vitest';
import {
  validateMachineSignal,
  encodeMachineSignal,
  decodeMachineSignal,
  validateStageOutput,
  makeStageOutput,
  passSignal,
  rejectSignal,
} from '../DualChannelSignal.js';

/** H1 合法 review_details fixture——ReviewDetails 契约全字段数组 */
const VALID_REVIEW_DETAILS = {
  checked_dimensions: [
    'ARCH_LAYER', 'FG_UUID', 'COUPLING', 'PERSISTENCE', 'RISK_CATCHALL',
    'DOC_SYNC', 'REPAIR_CLASSIFICATION', 'STATIC_QUALITY', 'ROBUSTNESS',
    'HOOK_SELFCHECK', 'PROPOSAL_FIDELITY',
  ],
  blocking: [{ rule: 'RULE_A', detail: 'blocking A' }],
  confirmations_met: ['CONF_A'],
  confirmations_missing: [],
  advisories: [{ rule: 'ADV_B', detail: 'advisory B' }],
};

const METRICS = {
  files_checked: 1,
  violations_found: 1,
  fg_redlines_touched: [],
  uuid_chain_broken: false,
  chat_injection_order_changed: false,
};

// ════════════════════════════════════════════════════════════════════
// validateMachineSignal — review_details 契约
// ════════════════════════════════════════════════════════════════════

describe('validateMachineSignal', () => {
  it('保留合法对象形态的 review_details', () => {
    const sig = validateMachineSignal({
      passed: false,
      risk_level: 'mid',
      reject_reason: ['blocking A'],
      review_details: VALID_REVIEW_DETAILS,
    });
    expect(sig.review_details).toEqual(VALID_REVIEW_DETAILS);
  });

  it('非法 review_details（非对象）→ 缺失 undefined（fail-closed）', () => {
    const sig = validateMachineSignal({
      passed: false,
      risk_level: 'mid',
      reject_reason: [],
      review_details: 'not-an-object',
    });
    expect(sig.review_details).toBeUndefined();
  });

  it('非法 review_details（缺 checked_dimensions 数组）→ 缺失', () => {
    const sig = validateMachineSignal({
      passed: false,
      risk_level: 'mid',
      reject_reason: [],
      review_details: { blocking: [] },
    });
    expect(sig.review_details).toBeUndefined();
  });

  it('非法 review_details（部分字段非数组）→ 缺失', () => {
    const sig = validateMachineSignal({
      passed: false,
      risk_level: 'mid',
      reject_reason: [],
      review_details: { ...VALID_REVIEW_DETAILS, advisories: 'not-array' },
    });
    expect(sig.review_details).toBeUndefined();
  });

  it('无 review_details → undefined（缺失，ConvergenceGate 将报 REVIEW_DETAILS_MISSING）', () => {
    const sig = validateMachineSignal({ passed: true, risk_level: 'low', reject_reason: [] });
    expect(sig.review_details).toBeUndefined();
  });

  it('常规字段标准化：passed 布尔化 / risk_level 默认 mid / reject_reason 过滤非字符串', () => {
    const sig = validateMachineSignal({ passed: 'yes', risk_level: 'weird', reject_reason: [42, 'ok', null] });
    expect(sig.passed).toBe(true);
    expect(sig.risk_level).toBe('mid');
    expect(sig.reject_reason).toEqual(['ok']);
  });

  it('非对象输入 → throw', () => {
    expect(() => validateMachineSignal(null as unknown)).toThrow('machine_signal 必须是对象');
    expect(() => validateMachineSignal('str' as unknown)).toThrow('machine_signal 必须是对象');
  });
});

// ════════════════════════════════════════════════════════════════════
// encode → decode round-trip
// ════════════════════════════════════════════════════════════════════

describe('encodeMachineSignal → decodeMachineSignal', () => {
  it('round-trip 保留合法 review_details', () => {
    const sig = {
      passed: false,
      risk_level: 'mid',
      reject_reason: ['blocking A'],
      metrics: METRICS,
      review_details: VALID_REVIEW_DETAILS,
    };
    const decoded = decodeMachineSignal(encodeMachineSignal(sig as never));
    expect(decoded.review_details).toEqual(VALID_REVIEW_DETAILS);
    expect(decoded.passed).toBe(false);
    expect(decoded.metrics).toEqual(METRICS);
  });

  it('encode 无 review_details → decode 后 undefined', () => {
    const decoded = decodeMachineSignal(JSON.stringify({ passed: true, risk_level: 'low', reject_reason: [] }));
    expect(decoded.review_details).toBeUndefined();
  });

  it('非法 JSON → throw', () => {
    expect(() => decodeMachineSignal('not-json{')).toThrow('machine_signal JSON 解析失败');
  });
});

// ════════════════════════════════════════════════════════════════════
// validateStageOutput — 双通道完整性
// ════════════════════════════════════════════════════════════════════

describe('validateStageOutput', () => {
  it('保留 machine_signal 中合法 review_details', () => {
    const out = validateStageOutput({
      machine_signal: { passed: false, risk_level: 'mid', reject_reason: ['x'], review_details: VALID_REVIEW_DETAILS },
      human_report: '# 评审报告',
    });
    expect(out.machine_signal.review_details).toEqual(VALID_REVIEW_DETAILS);
    expect(out.human_report).toBe('# 评审报告');
  });

  it('非法 review_details 在 StageOutput 中也转缺失', () => {
    const out = validateStageOutput({
      machine_signal: { passed: true, risk_level: 'low', reject_reason: [], review_details: { blocking: [] } },
      human_report: '# ok',
    });
    expect(out.machine_signal.review_details).toBeUndefined();
  });

  it('缺 machine_signal → throw', () => {
    expect(() => validateStageOutput({ human_report: '# x' } as never)).toThrow('缺少 machine_signal');
  });

  it('human_report 非字符串 → throw', () => {
    expect(() => validateStageOutput({ machine_signal: { passed: true, risk_level: 'low', reject_reason: [] }, human_report: 42 } as never)).toThrow('human_report 必须是字符串');
  });

  it('非对象 → throw', () => {
    expect(() => validateStageOutput('x' as never)).toThrow('StageOutput 必须是对象');
  });
});

// ════════════════════════════════════════════════════════════════════
// 工厂函数
// ════════════════════════════════════════════════════════════════════

describe('工厂函数', () => {
  it('passSignal / rejectSignal 基础字段与默认无 review_details', () => {
    const p = passSignal(METRICS);
    expect(p.passed).toBe(true);
    expect(p.risk_level).toBe('low');
    expect(p.review_details).toBeUndefined();

    const r = rejectSignal(['reason'], 'high');
    expect(r.passed).toBe(false);
    expect(r.risk_level).toBe('high');
    expect(r.review_details).toBeUndefined();
  });

  it('makeStageOutput 组合双通道', () => {
    const out = makeStageOutput({ passed: true, risk_level: 'low', reject_reason: [] }, '# report');
    expect(out.machine_signal.passed).toBe(true);
    expect(out.human_report).toBe('# report');
  });
});

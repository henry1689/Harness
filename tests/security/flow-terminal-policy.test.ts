/**
 * H0: token 签发 fail-closed 策略测试
 * - isTokenEligible: mode 必须显式 pipeline；双向一致性；矛盾 → terminal_invariant_violation
 * - attemptTokenIssue: 可注入 helper，拒绝态绝不调用签发回调（spy 证明）
 */
import { describe, it, expect, vi } from 'vitest';
import { isTokenEligible, attemptTokenIssue } from '../../src/security/flow-terminal-policy.js';

describe('flow-terminal-policy (H0)', () => {
  it('正常 completed pipeline → eligible', () => {
    expect(isTokenEligible({
      success: true, flow_status: 'completed', end_reason: 'completed', mode: 'pipeline',
    })).toEqual({ eligible: true });
  });

  it('mode 缺失 → not_pipeline（fail-closed，绝不 eligible）', () => {
    expect(isTokenEligible({
      success: true, flow_status: 'completed', end_reason: 'completed',
    })).toEqual({ eligible: false, code: 'not_pipeline' });
  });

  it('mode 非 pipeline → not_pipeline', () => {
    expect(isTokenEligible({
      success: true, flow_status: 'completed', end_reason: 'completed', mode: 'free_mode',
    })).toEqual({ eligible: false, code: 'not_pipeline' });
  });

  it('aborted pipeline → not_success', () => {
    expect(isTokenEligible({
      success: false, flow_status: 'aborted', end_reason: 'retry_limit', mode: 'pipeline',
    })).toEqual({ eligible: false, code: 'not_success' });
  });

  it('success=false 但终态声称 completed → terminal_invariant_violation（矛盾）', () => {
    expect(isTokenEligible({
      success: false, flow_status: 'completed', end_reason: 'completed', mode: 'pipeline',
    })).toEqual({ eligible: false, code: 'terminal_invariant_violation' });
  });

  it('success=true 但 flow_status=aborted → terminal_invariant_violation', () => {
    expect(isTokenEligible({
      success: true, flow_status: 'aborted', end_reason: 'completed', mode: 'pipeline',
    })).toEqual({ eligible: false, code: 'terminal_invariant_violation' });
  });

  it('success=true 但 end_reason 非 completed → terminal_invariant_violation', () => {
    expect(isTokenEligible({
      success: true, flow_status: 'completed', end_reason: 'free_mode', mode: 'pipeline',
    })).toEqual({ eligible: false, code: 'terminal_invariant_violation' });
  });

  // ── attemptTokenIssue：可注入 helper，拒绝态绝不调用签发回调 ──
  it('aborted 信号 → 不调用签发回调（spy 证明）', () => {
    const issueSpy = vi.fn(() => true);
    const r = attemptTokenIssue(
      { success: false, flow_status: 'aborted', end_reason: 'retry_limit', mode: 'pipeline' },
      issueSpy,
    );
    expect(r.issued).toBe(false);
    expect(issueSpy).not.toHaveBeenCalled();
  });

  it('字段矛盾信号 → 不调用签发回调（spy 证明）', () => {
    const issueSpy = vi.fn(() => true);
    const r = attemptTokenIssue(
      { success: true, flow_status: 'aborted', end_reason: 'completed', mode: 'pipeline' },
      issueSpy,
    );
    expect(r.issued).toBe(false);
    expect(issueSpy).not.toHaveBeenCalled();
  });

  it('mode 缺失 → 不调用签发回调（spy 证明）', () => {
    const issueSpy = vi.fn(() => true);
    const r = attemptTokenIssue(
      { success: true, flow_status: 'completed', end_reason: 'completed' },
      issueSpy,
    );
    expect(r.issued).toBe(false);
    expect(issueSpy).not.toHaveBeenCalled();
  });

  it('completed 信号 → 调用签发回调一次，issued=true', () => {
    const issueSpy = vi.fn(() => true);
    const r = attemptTokenIssue(
      { success: true, flow_status: 'completed', end_reason: 'completed', mode: 'pipeline' },
      issueSpy,
    );
    expect(r.issued).toBe(true);
    expect(r.value).toBe(true);
    expect(issueSpy).toHaveBeenCalledTimes(1);
  });

  it('completed 但签发回调抛异常 → 异常向上传播（由调用方捕获，不吞）', () => {
    const boom = vi.fn(() => { throw new Error('store down'); });
    expect(() => attemptTokenIssue(
      { success: true, flow_status: 'completed', end_reason: 'completed', mode: 'pipeline' },
      boom,
    )).toThrow('store down');
    expect(boom).toHaveBeenCalledTimes(1);
  });
});

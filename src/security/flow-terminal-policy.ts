/**
 * H0: token 签发 fail-closed 策略模块
 * =============================================
 * 独立校验 success/flow_status/end_reason/mode 四项机械一致（双向一致性）。
 * attemptTokenIssue 是生产可注入 helper——签发回调由调用方注入，拒绝态绝不调用。
 */

export interface TokenEligibilitySignal {
  success: boolean;
  flow_status?: string;
  end_reason?: string;
  mode?: string;
}

export type TokenEligibilityVerdict =
  | { eligible: true }
  | { eligible: false; code: 'not_pipeline' | 'not_success' | 'terminal_invariant_violation' };

/**
 * 终态一致性判定（fail-closed）：
 * - mode 必须显式为 'pipeline'（缺失 → not_pipeline，绝不 eligible）
 * - success=false + 终态声称 completed → terminal_invariant_violation（字段矛盾）
 * - success=true 必须三项（flow_status/end_reason）全 completed，否则矛盾
 */
export function isTokenEligible(signal: TokenEligibilitySignal): TokenEligibilityVerdict {
  if (signal.mode !== 'pipeline') return { eligible: false, code: 'not_pipeline' };

  const completedConsistent =
    signal.flow_status === 'completed' && signal.end_reason === 'completed';

  if (signal.success !== true) {
    // success=false 但终态字段声称 completed → 矛盾
    if (completedConsistent) return { eligible: false, code: 'terminal_invariant_violation' };
    return { eligible: false, code: 'not_success' };
  }

  // success=true：必须全 completed，否则矛盾
  if (!completedConsistent) return { eligible: false, code: 'terminal_invariant_violation' };
  return { eligible: true };
}

/**
 * 生产可注入的签发 helper：
 * 仅当 verdict.eligible 时调用 issueCallback；拒绝态绝不调用。
 * 测试通过注入 spy 证明「拒绝态确实不调用签发回调」。
 */
export function attemptTokenIssue<T>(
  signal: TokenEligibilitySignal,
  issueCallback: () => T,
): { issued: boolean; verdict: TokenEligibilityVerdict; value?: T } {
  const verdict = isTokenEligible(signal);
  if (!verdict.eligible) return { issued: false, verdict };
  return { issued: true, verdict, value: issueCallback() };
}

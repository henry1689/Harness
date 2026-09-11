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

// ════════════════════════════════════════════════════════════════════
// 方案预审「自动授权」白名单 —— owner 划定的边界（2026-09-11）
// ════════════════════════════════════════════════════════════════════
// 背景：中/高风险改动的写授权此前只能靠 owner 逐文件输密码签豁免。为取消这个仪式，
// 新增 data/flows/plan_review_flow.yaml 作为「方案预审 → 写令牌」通路。
// 但预审链路的输入（方案文字、分类、理由）**全部由申请方 Agent 提供**，链上没有人类锚点。
// 因此把锚点改为 **owner 划定的边界**：只有边界内的文件才允许自动授权，越界一律拒绝。
//
// 🔴 白名单放在**源码**里而不是外挂 json：`data/*.json` 在 2026-09-11 之前被判为低风险
// （免检即写），外挂白名单等于把边界交给被治理方；`src/` 下的文件受令牌约束，才是可控的。
//
// 修改本白名单本身需要走完整流水线令牌（本文件在被保护清单内，且见下方 NEVER 规则）。
// ════════════════════════════════════════════════════════════════════

/** 允许经「方案预审」自动授权的路径前缀（相对 harness 根） */
export const AUTO_GRANT_ALLOWED_PREFIXES: readonly string[] = [
  'src/',
];

/**
 * 永不允许经方案预审自动授权的路径（**优先于**白名单）。
 *
 * 分两类：
 *  ① **授权机制自身** —— 若可自动授权，Agent 就能「申请一个改白名单的令牌」把白名单
 *     改成任意值，再改一切。这是自引用绕过，必须硬编码堵死。
 *  ② **防线控制面** —— 风险策略、流水线定义、钩子、哨兵、MCP 实现、防线脚本：
 *     改动它们等于改规则本身，必须走更高门槛（完整流水线 / 人工通道）。
 */
export const AUTO_GRANT_NEVER: readonly string[] = [
  // ① 授权机制自身
  'src/security/',
  // ② 防线控制面
  'data/risk-policy.json',
  'data/exemptions.json',
  'data/flows/',
  'sentinel/',
  'mcp/',
  'scripts/',
  'hooks/',
  '.claude/',
  // ③ 治理引擎核心：门控与判定逻辑，改它们等于改门槛
  'src/FlowEngine.ts',
  'src/StageRunner.ts',
  'src/GateController.ts',
  'src/ToolWhitelistGuard.ts',
  'src/ConvergenceGate.ts',
  'src/ComplianceScorer.ts',
  'src/DelegateReviewer.ts',
  'src/HardnessLadder.ts',
  'src/EvolutionEngine.ts',
];

export interface AutoGrantVerdict {
  allowed: boolean;
  code: 'ok' | 'not_in_whitelist' | 'never_auto_grant';
  reason: string;
}

/** 判断某文件是否允许经「方案预审」自动授权写入 */
export function isAutoGrantAllowed(file: string): AutoGrantVerdict {
  const n = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
  for (const p of AUTO_GRANT_NEVER) {
    if (n === p || n.startsWith(p)) {
      return {
        allowed: false,
        code: 'never_auto_grant',
        reason: `「${n}」命中禁止项「${p}」——属授权机制自身或防线控制面，永不允许经方案预审自动授权（防止改白名单/改门槛的自引用绕过）。请走完整流水线或人工通道。`,
      };
    }
  }
  for (const p of AUTO_GRANT_ALLOWED_PREFIXES) {
    if (n.startsWith(p)) return { allowed: true, code: 'ok', reason: `在白名单前缀「${p}」内` };
  }
  return {
    allowed: false,
    code: 'not_in_whitelist',
    reason: `「${n}」不在方案预审自动授权白名单内（允许前缀：${AUTO_GRANT_ALLOWED_PREFIXES.join(', ')}）。请走完整流水线或人工通道。`,
  };
}

/** 批量校验：返回**不允许**的项（空数组 = 全部可自动授权） */
export function checkAutoGrantScope(files: readonly string[]): Array<{ file: string } & AutoGrantVerdict> {
  return files.map(f => ({ file: f, ...isAutoGrantAllowed(f) })).filter(r => !r.allowed);
}

/**
 * manualVerify.ts — S6-B 人工验证任务单生成/确认纯逻辑（H-02）
 * ================================================================
 * 原则：不强行自动化全部行为测试，做「强制分层契约」：
 *   S6-A 机器必跑（tsc/vitest/CK-09/10/save grep）；
 *   S6-B 机器生成 manual_verification_ticket，人工逐项确认后才算 S6 收口。
 * 纯函数；不依赖引擎状态。接线（YAML S6-A/S6-B + FlowEngine await 语义）见 03 文档。
 */
import type { ManualVerificationItem, ManualVerificationTicket } from '../schemas/manual-verification-ticket.js';
import { allConfirmed } from '../schemas/manual-verification-ticket.js';

/** 默认人工验证项（wenstar-cc 行为级；按项目可配置扩展） */
export const DEFAULT_MANUAL_ITEMS: Array<Omit<ManualVerificationItem, 'confirmed' | 'confirmed_at' | 'confirmed_note'>> = [
  { verify_item: 'WebUI 普通对话', precondition: '服务启动', expected_result: '对话正常、无幻觉/角色混淆', verifier: '' },
  { verify_item: '实体会晤模式', precondition: '≥2 个不同话题', expected_result: '不读取其他角色记忆', verifier: '' },
  { verify_item: '角色扮演分支', precondition: '角色扮演开启', expected_result: '不污染主 FamilyGraph 户籍', verifier: '' },
  { verify_item: 'DB 标注率抽样', precondition: '库可查', expected_result: 'belong_entity_uuid 标注正常', verifier: '' },
  { verify_item: '停服-重启一致性', precondition: '可停服', expected_result: '重启后数据仍在（save 落盘）', verifier: '' },
];

/** 由 run 生成任务单（items 缺省用 DEFAULT_MANUAL_ITEMS） */
export function buildManualTicket(run_id: string, items?: ManualVerificationItem[]): ManualVerificationTicket {
  return {
    run_id,
    generated_at: new Date().toISOString(),
    items: (items ?? DEFAULT_MANUAL_ITEMS.map(i => ({ ...i, confirmed: false }))),
  };
}

/** 确认单条（返回是否全部完成） */
export function confirmItem(ticket: ManualVerificationTicket, index: number, verifier: string, note?: string): boolean {
  if (index < 0 || index >= ticket.items.length) return allConfirmed(ticket);
  const it = ticket.items[index]!;
  it.confirmed = true;
  it.confirmed_at = new Date().toISOString();
  it.verifier = verifier || it.verifier;
  if (note) it.confirmed_note = note;
  return allConfirmed(ticket);
}

/** S6-B 是否需人工等待：skip_manual_verification=true 或 ticket 已全确认 → false（自动放行） */
export function isAwaitingManual(skipManualVerification: boolean | undefined, ticket: ManualVerificationTicket | null): boolean {
  if (skipManualVerification === true) return false;
  if (!ticket) return true; // 无 ticket → 需先生成
  return !allConfirmed(ticket);
}

/** S6-B 门控决策（纯函数，无 IO——便于单测） */
export type ManualGateDecision =
  | { action: 'pass'; reason: string }
  | { action: 'await'; pending: number; total: number };

/**
 * S6-B 放行判定（顺序即优先级）：
 *   ① 总开关关闭 → pass（兼容/回滚）
 *   ② s2_evidence.skip_manual_verification=true → pass
 *   ③ 任务单不存在 → await（需先生成，由调用方落盘）
 *   ④ 任务单已全确认 → pass
 *   ⑤ 否则 → await
 */
export function decideManualGate(opts: {
  enabled: boolean;
  skipManualVerification?: boolean;
  ticket: ManualVerificationTicket | null;
}): ManualGateDecision {
  if (!opts.enabled) return { action: 'pass', reason: '总开关 manual_verification_enabled=false' };
  if (opts.skipManualVerification === true) return { action: 'pass', reason: 'skip_manual_verification=true' };
  if (!opts.ticket || opts.ticket.items.length === 0) return { action: 'await', pending: 0, total: 0 };
  if (allConfirmed(opts.ticket)) return { action: 'pass', reason: '人工验收任务单已全部确认' };
  const pending = opts.ticket.items.filter(i => i.confirmed !== true).length;
  return { action: 'await', pending, total: opts.ticket.items.length };
}

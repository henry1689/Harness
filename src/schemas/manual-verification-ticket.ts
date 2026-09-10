/**
 * manual-verification-ticket.ts — S6-B 人工验证任务单结构（H-02）
 * ================================================================
 * S6 拆 A/B：S6-B 机器生成人工验证任务单，人工完成签名后才允许进入 S7。
 * run 状态扩展（不破坏旧 FlowStatus）：await_manual_verification / archive_invalid。
 * B0 仅类型 + 校验器；S6 拆分在 H-02 批次接入。
 */
export interface ManualVerificationItem {
  verify_item: string;       // WebUI 对话 / 会晤 / 角色扮演 / DB标注率 / 停服重启…
  precondition: string;
  expected_result: string;
  reproduce_steps?: string;
  verifier: string;          // 验收人
  due_at?: string;           // 截止时间
  confirmed?: boolean;       // 人工确认签名后 true
  confirmed_at?: string;
  confirmed_note?: string;
}

export interface ManualVerificationTicket {
  run_id: string;
  generated_at: string;
  items: ManualVerificationItem[];
  /** 全部 items.confirmed===true 才算完成 */
}

export function allConfirmed(ticket: ManualVerificationTicket): boolean {
  return ticket.items.length > 0 && ticket.items.every(i => i.confirmed === true);
}

export function validateManualTicket(obj: unknown): string[] {
  const errs: string[] = [];
  if (!obj || typeof obj !== 'object') return ['manual_verification_ticket 非对象'];
  const o = obj as Partial<ManualVerificationTicket>;
  if (!o.run_id) errs.push('run_id 必填');
  if (!Array.isArray(o.items) || o.items.length === 0) errs.push('items 必填且非空');
  return errs;
}

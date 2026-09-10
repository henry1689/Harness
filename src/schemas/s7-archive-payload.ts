/**
 * s7-archive-payload.ts — S7 归档产物结构（H-01，S7-B 机器校验输入）
 * ================================================================
 * S7 拆 A/B：
 *   S7-A 产出 s7_archive_payload；
 *   S7-B（S7ArchiveValidator，纯 TS 无 LLM）据此硬校验。
 * V1.0 方案 §4.2。
 * B0 仅类型 + 校验器；S7ArchiveValidator 业务接入在 H-01 批次。
 */
export interface DebtMarker {
  is_patch: boolean;
  /** 补丁方案必填：tech_debt_ledger.debt_id */
  debt_item_id: string | null;
  /** 大重构时必填：三轮复审计划 */
  three_round_review_plan?: string | null;
}

export interface RollbackPlan {
  modified_files: string[];
  rollback_steps: string;
}

export interface S7ArchivePayload {
  change_summary: string;
  rollback_plan: RollbackPlan;
  verification_checklist: Array<Record<string, unknown>>;
  debt_marker: DebtMarker;
  audit_ref: string;
  /** S4.5 打分 <98 时必填对应豁免记录 id（exemptions.json） */
  exemption_id?: string | null;
}

export function validateS7ArchivePayload(obj: unknown): string[] {
  const errs: string[] = [];
  if (!obj || typeof obj !== 'object') return ['s7_archive_payload 非对象'];
  const o = obj as Partial<S7ArchivePayload>;
  if (!o.change_summary) errs.push('change_summary 必填');
  if (!o.rollback_plan || !Array.isArray(o.rollback_plan.modified_files) || !o.rollback_plan.rollback_steps) {
    errs.push('rollback_plan 必填(modified_files[] + rollback_steps)');
  }
  if (!Array.isArray(o.verification_checklist)) errs.push('verification_checklist 必填数组');
  if (!o.debt_marker || typeof o.debt_marker.is_patch !== 'boolean') errs.push('debt_marker.is_patch 必填');
  // H-01：补丁必须登记债务；否则 S7-B 拒绝（见 S7ArchiveValidator 完整规则）
  if (o.debt_marker && o.debt_marker.is_patch === true && !o.debt_marker.debt_item_id) {
    errs.push('补丁方案必须携带 debt_item_id（tech_debt_ledger），未登记债务归档不放行');
  }
  if (!o.audit_ref) errs.push('audit_ref 必填');
  return errs;
}

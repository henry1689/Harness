/**
 * S7ArchiveValidator — S7-B 归档机器校验（H-01）
 * ================================================================
 * 纯 TS，不调用 LLM。S7 拆分 A/B：
 *   S7-A 产出 s7_archive_payload → S7-B 本校验器硬校验 → 通过才 run_status=completed，
 *   否则 archive_invalid 返回 S7-A 补全。
 * V1.0 方案 H-01 + §4.2。
 *
 * 校验规则（H-01）：
 *   R1 必填字段完整（change_summary / rollback_plan / verification_checklist / debt_marker / audit_ref）
 *   R2 补丁方案必须绑定 tech_debt_ledger.debt_id（存在性由注入的 ledger 校验）
 *   R3 回滚清单 modified_files 与 S3 实际 diff 文件集合一致（不允许漏记）
 *   R4 S4.5 打分 <98 必须有对应 exemption_id（exemptions.json 存在性由注入校验）
 *   R5 大重构（≥3 文件 或 S2 problem_nature=arch_structural_defect）→ three_round_review_plan 必填
 *
 * 依赖注入（便于单测）：ledger.getDebt / exemptionExists 均为可注入函数。
 */
import type { S7ArchivePayload } from '../schemas/s7-archive-payload.js';

export interface S7ArchiveContext {
  /** S3 实际 diff 的文件集合（相对路径，正斜杠） */
  diffFiles: string[];
  /** S4.5 综合打分（0-100；未达 S4.5 传 null） */
  s45score: number | null;
  /** 是否大重构（≥3 文件或 arch_structural） */
  isLargeRefactor: boolean;
  /** 债务台账存在性（H-03 ledger） */
  ledgerGetDebt?: (debt_id: string) => { debt_id: string } | null | undefined;
  /** 豁免记录存在性（exemptions.json） */
  exemptionExists?: (exemption_id: string) => boolean;
}

export interface S7ArchiveVerdict {
  archive_valid: boolean;
  errors: string[];
}

export function validateArchive(payload: S7ArchivePayload, ctx: S7ArchiveContext): S7ArchiveVerdict {
  const errors: string[] = [];
  // R1 必填
  if (!payload.change_summary) errors.push('R1: change_summary 必填');
  if (!payload.rollback_plan || !Array.isArray(payload.rollback_plan.modified_files) || !payload.rollback_plan.rollback_steps) {
    errors.push('R1: rollback_plan 必填(modified_files[]+rollback_steps)');
  }
  if (!Array.isArray(payload.verification_checklist)) errors.push('R1: verification_checklist 必填数组');
  if (!payload.debt_marker || typeof payload.debt_marker.is_patch !== 'boolean') errors.push('R1: debt_marker.is_patch 必填');
  if (!payload.audit_ref) errors.push('R1: audit_ref 必填');

  // R2 补丁必须登记债务且存在
  if (payload.debt_marker?.is_patch) {
    if (!payload.debt_marker.debt_item_id) {
      errors.push('R2: 补丁方案必须携带 debt_item_id（tech_debt_ledger）');
    } else if (ctx.ledgerGetDebt && !ctx.ledgerGetDebt(payload.debt_marker.debt_item_id)) {
      errors.push(`R2: debt_item_id=${payload.debt_marker.debt_item_id} 在台账不存在`);
    }
  }

  // R3 回滚文件与 diff 一致（不漏记；允许归档多列已含全部 diff）
  const diffSet = new Set(ctx.diffFiles.map(f => f.replace(/\\/g, '/')));
  const rollFiles = (payload.rollback_plan?.modified_files ?? []).map(f => f.replace(/\\/g, '/'));
  const missing = [...diffSet].filter(f => !rollFiles.includes(f));
  if (missing.length > 0) errors.push(`R3: 回滚清单漏记 ${missing.length} 个修改文件: ${missing.slice(0, 5).join(', ')}`);
  const extra = rollFiles.filter(f => !diffSet.has(f));
  if (extra.length > 0) errors.push(`R3: 回滚清单含非 diff 文件: ${extra.slice(0, 3).join(', ')}`);

  // R4 S4.5<98 需豁免
  if (ctx.s45score !== null && ctx.s45score < 98) {
    if (!payload.exemption_id) {
      errors.push(`R4: S4.5 打分 ${ctx.s45score}<98 必须携带 exemption_id`);
    } else if (ctx.exemptionExists && !ctx.exemptionExists(payload.exemption_id)) {
      errors.push(`R4: exemption_id=${payload.exemption_id} 在豁免台账不存在`);
    }
  }

  // R5 大重构三轮复审
  if (ctx.isLargeRefactor && !payload.debt_marker?.three_round_review_plan) {
    errors.push('R5: 大重构必须填写 three_round_review_plan');
  }

  return { archive_valid: errors.length === 0, errors };
}

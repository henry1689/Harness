/**
 * s2-evidence-v2.ts — S2 审批证据增强结构（M-03 骨架 + H-03 补丁债务字段）
 * ================================================================
 * 演进目标：把 S2「两套方案 / 共性归类」从 prompt 软约束升级为结构化机器校验。
 * 本文件 B0 仅定义 TS 类型 + 最小校验器；**尚未接入 S2 闸门**（M-03/H-03 接入在后续批次）。
 *
 * 关键字段（V1.0 方案 §4.3）：
 *   problem_nature      specific_bug | coupling_debt | arch_structural_defect
 *   patch_plan / arch_structural_plan   两套方案结构化（含 associated_debt_id：选补丁必须绑定债务）
 *   final_approved_plan patch | arch_structural
 *   allow_full_rewrite  H-05 白名单（S2 人工确认后才允许 S3 大文件覆写）
 *   skip_manual_verification  H-02 开关：纯自动化任务跳过 S6-B 人工环节
 *   confirmations       P0-A 确认声明 key（既有）
 */
export type ProblemNature = 'specific_bug' | 'coupling_debt' | 'arch_structural_defect';
export type ApprovedPlanKind = 'patch' | 'arch_structural';

export interface PlanOption {
  is_available: boolean;
  change_scope: string[];
  short_term_effect?: string;
  debt_risks?: string;
  not_available_reason?: string | null;
  /** 补丁方案必填：绑定的债务台账 id（tech_debt_ledger.debt_id） */
  associated_debt_id?: string | null;
  payback_milestone?: string | null;
}

export interface ArchStructuralPlan {
  is_available: boolean;
  change_scope: string[];
  benefit?: string;
  dependencies?: string[];
  estimated_workload?: string;
  not_available_reason?: string | null;
}

export interface S2EvidenceV2 {
  approval_ref: string;
  problem_nature: ProblemNature;
  patch_plan: PlanOption;
  arch_structural_plan: ArchStructuralPlan;
  final_approved_plan: ApprovedPlanKind;
  allow_full_rewrite?: string[];
  skip_manual_verification?: boolean;
  confirmations?: string[];
}

/** 最小校验：返回错误清单（空=通过）。接入 S2 闸门时由此驱动。 */
export function validateS2EvidenceV2(obj: unknown): string[] {
  const errs: string[] = [];
  if (!obj || typeof obj !== 'object') return ['s2_evidence 非对象'];
  const o = obj as Partial<S2EvidenceV2>;
  if (!o.approval_ref) errs.push('approval_ref 必填');
  if (!o.problem_nature) errs.push('problem_nature 必填');
  if (o.problem_nature && !['specific_bug', 'coupling_debt', 'arch_structural_defect'].includes(o.problem_nature)) {
    errs.push(`problem_nature 非法: ${o.problem_nature}`);
  }
  if (!o.patch_plan || typeof o.patch_plan.is_available !== 'boolean') errs.push('patch_plan.is_available 必填');
  if (!o.arch_structural_plan || typeof o.arch_structural_plan.is_available !== 'boolean') errs.push('arch_structural_plan.is_available 必填');
  if (o.final_approved_plan && !['patch', 'arch_structural'].includes(o.final_approved_plan)) {
    errs.push(`final_approved_plan 非法: ${o.final_approved_plan}`);
  }
  // 补丁方案必须绑定债务（H-03）：选了 patch 但未给 associated_debt_id → 拒绝
  if (o.final_approved_plan === 'patch' && o.patch_plan && o.patch_plan.is_available && !o.patch_plan.associated_debt_id) {
    errs.push('选补丁方案必须绑定 associated_debt_id（tech_debt_ledger），未登记债务不放行');
  }
  if (Array.isArray(o.confirmations)) {
    for (const c of o.confirmations) if (typeof c !== 'string') errs.push('confirmations 元素必须为 string');
  }
  return errs;
}

/**
 * full-review-evidence.ts — S4.5 完整评审证据结构（H-04）
 * ================================================================
 * 解决评审证据截断：S4.5 不通过回流 S3 时，下游编码上下文必须拿到全量机器证据，
 * 而非只有 reject_reason_summary。V1.0 方案 §4.4。
 *
 * B0 仅定义类型 + 序列化/校验器；ConvergenceGate 产出拆分在 H-04 批次接入。
 * 约束（H-04）：full_review_evidence 为必选输出，即使打分通过也要生成（供 S7 审计）；
 * 机器可校验字段（ds_score_details / ck / uuid / coupling）永不允许裁剪；
 * 仅超长自由文本允许摘要，原始全文入 audit 独立附件。
 */
export interface DsScoreDetail {
  ds_id: string;
  score_delta: number;        // 扣分
  reason: string;
  suggest_fix: string;
  /** 机器字段：扣分是否来自机器(CK/结构化) —— 永不裁剪 */
  machine_sourced?: boolean;
}

export interface FullReviewEvidence {
  run_id: string;
  convergence_round: number;
  summary: string;                 // reject_reason_summary（兼容旧逻辑展示）
  dim_review: Record<string, unknown>;   // 11 维评审明细（结构化对象原样）
  ck_reports: Array<{ ck_id: string; passed: boolean; severity?: string; violations: Array<{ message: string }> }>;
  ds_score_details: DsScoreDetail[];
  uuid_chain_check?: Record<string, unknown>;
  coupling_analysis?: Record<string, unknown>;
  risk_markers?: string[];
  classification_check?: Record<string, unknown>;
}

/** 结构化压缩（H-04 大小保护）：仅截断自由文本字段，机器字段原样保留。 */
export function compressFullEvidence(ev: FullReviewEvidence, maxText = 2000): FullReviewEvidence {
  const cut = (s: string) => (s.length > maxText ? `${s.slice(0, maxText)}…[已截断,全文见audit附件]` : s);
  return {
    ...ev,
    summary: cut(ev.summary),
    ds_score_details: ev.ds_score_details.map(d => ({ ...d, reason: cut(d.reason), suggest_fix: cut(d.suggest_fix) })),
    // ck/dim/uuid/coupling 机器字段：原样保留，不裁剪
  };
}

/** H-04: 从 S4.5 各部件装配完整评审证据（纯函数；ConvergenceGate 在 H-04 接入期调用） */
export function assembleFullReviewEvidence(args: {
  run_id: string;
  convergence_round: number;
  summary: string;
  dim_review?: Record<string, unknown>;
  ck_reports: FullReviewEvidence['ck_reports'];
  ds_score_details: DsScoreDetail[];
  uuid_chain_check?: Record<string, unknown>;
  coupling_analysis?: Record<string, unknown>;
  risk_markers?: string[];
  classification_check?: Record<string, unknown>;
}): FullReviewEvidence {
  return {
    run_id: args.run_id,
    convergence_round: args.convergence_round,
    summary: args.summary,
    dim_review: args.dim_review ?? {},
    ck_reports: args.ck_reports,
    ds_score_details: args.ds_score_details,
    uuid_chain_check: args.uuid_chain_check,
    coupling_analysis: args.coupling_analysis,
    risk_markers: args.risk_markers,
    classification_check: args.classification_check,
  };
}

export function validateFullEvidence(obj: unknown): string[] {
  const errs: string[] = [];
  if (!obj || typeof obj !== 'object') return ['full_review_evidence 非对象'];
  const o = obj as Partial<FullReviewEvidence>;
  if (!o.run_id) errs.push('run_id 必填');
  if (typeof o.summary !== 'string') errs.push('summary 必填(string)');
  if (!Array.isArray(o.ck_reports)) errs.push('ck_reports 必填数组');
  if (!Array.isArray(o.ds_score_details)) errs.push('ds_score_details 必填数组');
  return errs;
}

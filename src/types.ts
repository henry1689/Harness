/**
 * Harness 调度引擎 — 核心类型定义
 * ========================================
 * 零侵入外挂架构的类型系统。
 * 所有流水线、Stage、Gate、信号、审计日志的接口/类型集中管理。
 */

// ════════════════════════════════════════════════════════════════════
// 流水线配置（与 YAML 结构一一对应）
// ════════════════════════════════════════════════════════════════════

/** Stage 级的工具白名单键名 */
export type WhitelistKey =
  | 'read_file'
  | 'write_file'
  | 'delete_file'
  | 'run_command'
  | 'run_db_script'
  | 'truncate_db'
  | 'run_modify_script'
  | 'search_code'
  | 'grep_import'
  | 'list_dir'
  | 'run_cli_check';

/** 门控类型 */
export type GateType = 'auto' | 'human' | 'condition';

/** 执行模式 */
export type RunnerMode = 'local' | 'delegate';

/** Stage 后置动作 */
export type AfterAction = 'inject_global_memo';

/** 单个 Stage 的 YAML 配置映射 */
export interface StageConfig {
  stage_id: string;
  stage_name: string;
  work_manual: string;
  tool_whitelist: Partial<Record<WhitelistKey, boolean>>;
  gate_type: GateType;
  /** human/auto 门控的下一阶段 */
  next_stage?: string;
  /** condition 门控通过时的下一阶段 */
  next_stage_pass?: string;
  /** condition 门控驳回时的回退阶段 */
  next_stage_reject?: string;
  runner_mode: RunnerMode;
  /** 阶段完成后触发的特殊动作 */
  after_action?: AfterAction;
}

/** 完整的 Flow YAML 配置 */
export interface FlowConfig {
  flow_id: string;
  flow_name: string;
  version: string;
  max_jump_limit: number;
  /** 通用单阶段回流最大次数（非 S3 阶段），默认 5 */
  max_stage_retries: number;
  /** 🔴 S3 专属驳回回流最大轮次（独立计数，超限强制锁定），默认 3 */
  max_s3_retries: number;
  global_memo_key: string;
  /** 业务架构铁律（10条，不可突破） */
  global_arch_constraint: string;
  /** 开发落地强制校验规则（6条，永久生效，全阶段自动注入） */
  global_implementation_rules: string;
  stages: StageConfig[];
}

// ════════════════════════════════════════════════════════════════════
// 运行时状态
// ════════════════════════════════════════════════════════════════════

/** 单个 Stage 的执行状态 */
export type StageStatus = 'pending' | 'running' | 'completed' | 'rejected' | 'skipped';

/** 整个 Flow 的运行状态 */
export type FlowStatus = 'idle' | 'running' | 'paused' | 'completed' | 'aborted';

/** H0: 终态原因——机器可区分，禁止折叠为 error，禁止给内部熔断追加 user_abort */
export type TerminalEndReason =
  | 'completed'
  | 'free_mode'
  | 'retry_limit'
  | 'human_denied'
  | 'human_timeout'
  | 'circuit_breaker'
  | 'stage_error'
  | 'user_abort'
  | 'confirmations_pending'        // P0-A2: S4.5 内容达标但仅剩确认未声明（s2_evidence run 内固定 → 提前终局）
  | 's3_patch_loop'                // E-02(enhance-v1): S3 补丁循环强制回审，S2 复批仍为旧证据 → 终局要求新方案
  | 'manual_verification_required'; // H-02(enhance-v1): S6-B 人工验收未完成 → 悬挂终局（不签发 token）

/** 门控决议结果（统一枚举） */
export type GateResolution =
  | 'auto_passed'
  | 'human_approved'
  | 'human_denied'
  | 'human_timeout'
  | 'condition_passed'
  | 'condition_rejected';

/** 风险等级 */
export type RiskLevel = 'high' | 'mid' | 'low';

/** 运行模式 */
export type RunMode = 'pipeline' | 'free';

// ════════════════════════════════════════════════════════════════════
// 双通道信号
// ════════════════════════════════════════════════════════════════════

/**
 * 结构化判定信号——供引擎 Gate 判定条件门控。
 * 🔴 machine_signal 不进入用户界面，与 human_report 物理隔离。
 */
export interface MachineSignal {
  /** 是否通过 */
  passed: boolean;
  /** 风险等级 */
  risk_level: RiskLevel;
  /** 驳回原因列表（条件门控解析此字段）——H1: 仅承载最终 blocking violations（兼容镜像） */
  reject_reason: string[];
  /** 可选的量化指标 */
  metrics?: MachineSignalMetrics;
  /** H1: 结构化评审详情——checked IDs、blocking、确认满足/缺失、advisory（ConvergenceGate 只读此结构化输入） */
  review_details?: ReviewDetails;
  /** H-04(enhance-v1): S4.5 完整评审证据（summary+full 分离；机器字段永不裁剪），供回流注入 memo 与 S7 审计 */
  full_review_evidence?: import('./schemas/full-review-evidence.js').FullReviewEvidence;
}

/** 量化指标（S4 架构评审 / S5 编译测试 / S6 功能验证 共用） */
export interface MachineSignalMetrics {
  /** 检查的文件数 */
  files_checked?: number;
  /** 发现的违规数 */
  violations_found?: number;
  /** 触碰的 FG 红线编号（如 ['红线1', '红线3']） */
  fg_redlines_touched?: string[];
  /** UUID 标注链路是否被破坏 */
  uuid_chain_broken?: boolean;
  /** chat.ts 22段注入顺序是否被修改 */
  chat_injection_order_changed?: boolean;
  /** 编译错误数（S5） */
  compile_errors?: number;
  /** 测试失败数（S5） */
  test_failures?: number;
  /** 数据库标注率（S6） */
  uuid_label_rate?: number;
  /** S4.5 合规得分 (0-100) */
  compliance_score?: number;
  /** S4.5 收敛轮次 */
  convergence_round?: number;
  /** P0-A: 内容分达标但仍未声明的评审确认数（结构化簿记闸门） */
  unresolved_confirmations?: number;
  /** H-02(enhance-v1): S6-B 人工验收未完成 → true。FlowEngine 据此悬挂终局（run_status=await_manual_verification） */
  await_manual_verification?: boolean;
  /** H-02(enhance-v1): 本次 S6-B 对应的变更指纹（任务单寻址键，见 data/manual_tickets/） */
  manual_ticket_key?: string;
  /** H1: S4.5 typed diagnostics——blocking/advisory/confirmation 分通道结构化计数（不混 channel） */
  s4_checked_dimensions?: number;
  s4_blocking_count?: number;
  s4_confirmations_met?: number;
  s4_confirmations_missing?: number;
  s4_advisory_count?: number;
  /** H1: S4 review_details typed invariant 机器码诊断（分号分隔，空=无降级） */
  s4_review_invariant?: string;
}

/** H1: 单个评审发现（结构化，rule=稳定规则标识） */
export interface ReviewFinding {
  rule: string;
  detail: string;
}

/** H1: 需 S2 evidence.confirmations 精确匹配确认的前置事实 */
export interface ConfirmationRequirement {
  key: string;
  label: string;
}

/** H1: 单个评审维度结果——checked=true 表示该维度已执行；空 blocking=已检查且通过 */
export interface ReviewDimensionResult {
  dimension_id: string;
  checked: boolean;
  blocking_violations: ReviewFinding[];
  required_confirmations: ConfirmationRequirement[];
  advisories: ReviewFinding[];
}

/** H1: MachineSignal 携带的结构化评审详情 */
export interface ReviewDetails {
  checked_dimensions: string[];
  blocking: ReviewFinding[];
  confirmations_met: string[];
  confirmations_missing: string[];
  advisories: ReviewFinding[];
}

// ════════════════════════════════════════════════════════════════════
// S4.5 收敛闸门 — 设计标准合规评分类型
// ════════════════════════════════════════════════════════════════════

/** 单条设计标准合规得分 */
export interface StandardComplianceScore {
  /** 标准编号（DS-01 ~ DS-19） */
  standardId: string;
  /** 标准标题（简短） */
  standardText: string;
  /** 权重（0.0~1.0） */
  weight: number;
  /** 得分（0-100） */
  score: number;
  /** 总检查项数 */
  totalChecks: number;
  /** 通过的检查项数 */
  passedChecks: number;
  /** 失败的检查项数 */
  failedChecks: number;
  /** 关联的违规描述 */
  relatedViolations: string[];
  /** 距 90% 目标的差距分 */
  gapToTarget: number;
}

/** 差距项（需要改进的标准） */
export interface GapItem {
  standardId: string;
  standardText: string;
  currentScore: number;
  targetScore: number;
  pointsNeeded: number;
  suggestedActions: string[];
}

/** 合规报告（S4.5 输出） */
export interface ComplianceReport {
  /** 加权综合得分 (0-100) */
  overallScore: number;
  /** 达标标准数 */
  passedStandards: number;
  /** 总标准数 */
  totalStandards: number;
  /** 逐条标准得分 */
  standardScores: StandardComplianceScore[];
  /** 差距分析 */
  gapAnalysis: GapItem[];
  /** 最需解决的 Top 5 问题 */
  topIssues: string[];
  /** 计算时间（ISO 时间戳） */
  computedAt: string;
}

/** 收敛历史条目 */
export interface ConvergenceEntry {
  /** 轮次 */
  round: number;
  /** 综合得分 */
  overallScore: number;
  /** 通过标准数 */
  passedStandards: number;
  /** 总标准数 */
  totalStandards: number;
  /** 决策 */
  decision: 'PASS' | 'REJECT' | 'HUMAN_BYPASS' | 'HARD_LOCKOUT';
  /** 时间戳 */
  timestamp: string;
  /** 仍未达标的标准 ID */
  gapStandards: string[];
}

/**
 * 子 Agent 双通道输出——machine_signal 给引擎，human_report 给用户。
 * 两者物理隔离，子 Agent 必须同时返回，引擎分别处理。
 */
export interface StageOutput {
  /** 结构化判定信号（引擎消费，不进用户界面） */
  machine_signal: MachineSignal;
  /** 纯人类文本报告（直接展示给用户） */
  human_report: string;
}

// ════════════════════════════════════════════════════════════════════
// 审计日志
// ════════════════════════════════════════════════════════════════════

/** 审计事件类型 */
export type AuditEventType =
  | 'flow_start'
  | 'flow_complete'
  | 'flow_abort'
  | 'stage_enter'
  | 'stage_exit'
  | 'gate_resolve'
  | 'tool_call'
  | 'tool_blocked'
  | 'machine_signal'
  | 'memo_injected'
  | 'circuit_breaker'
  | 'proposal_archive'
  | 'convergence_check'
  | 'convergence_bypass'
  | 'convergence_lockout';

/** 单条审计记录 */
export interface AuditEntry {
  /** 事件类型 */
  event: AuditEventType;
  /** ISO 时间戳 */
  timestamp: string;
  /** 关联的 stage_id（可为空） */
  stage_id?: string;
  /** 事件详情（结构化） */
  detail: Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════════════
// 阶段执行结果
// ════════════════════════════════════════════════════════════════════

/** 单个 Stage 的完整执行结果 */
export interface StageResult {
  /** Stage ID */
  stage_id: string;
  /** 执行状态 */
  status: StageStatus;
  /** 门控类型 */
  gate_type: GateType;
  /** 门控决议 */
  gate_resolution: GateResolution;
  /** 子 Agent 输出的结构化信号（condition gate 时必有） */
  machine_signal?: MachineSignal;
  /** 子 Agent 输出的人类可读报告 */
  human_report?: string;
  /** 此阶段的审计记录 */
  audit_entries: AuditEntry[];
  /** Stage 开始时间 */
  started_at: string;
  /** Stage 完成时间 */
  completed_at?: string;
  /** 错误信息 */
  error?: string;
}

// ════════════════════════════════════════════════════════════════════
// 流水线运行状态
// ════════════════════════════════════════════════════════════════════

/** H1: S2 审批证据——非秘密、可序列化、与本次 run 绑定；不含密码/token/签名 */
export interface HumanApprovalEvidence {
  approval_ref: string;
  approved_plan: string;
  change_classification: string;
  global_architecture_decision: string;
  confirmations: string[];
  /** E-02(enhance-v1): S3 补丁循环强制回审时旧证据标记被取代（不删除，保留审计溯源） */
  superseded?: boolean;
  superseded_at?: string;
  /** H-02(enhance-v1): S2 方案声明免人工验收 → S6-B 自动放行 */
  skip_manual_verification?: boolean;
}

/** 流水线触发上下文 */
export interface TriggerContext {
  /** 用户原始消息 */
  message: string;
  /** 待修改的文件路径列表 */
  modifiedFiles: string[];
  /** 触发时的会话 ID */
  sessionId?: string;
  /** 风险等级（由 RiskClassifier 计算） */
  riskLevel: RiskLevel;
  /** 是否为微小修改（自由裸奔判定用） */
  isTrivial: boolean;
  /** 触发该流水线的用户标识 */
  triggeredBy?: string;
  /** H1: 本次 run 的 S2 审批证据（非秘密；缺失/无效时 S2 fail-closed） */
  s2_evidence?: HumanApprovalEvidence;
  /** 项目根目录（供 ConvergenceGate 运行 CK 检查） */
  projectRoot?: string;
  /** 🔴 P9: 修复编译错误专用豁免标志（true = S3 跳过编译检查，仅用于清理历史错误） */
  skip_s3_compile?: boolean;
}

/** E-02(enhance-v1): 运行期机器信号（随 run 归档，供 S7 审计溯源；不影响 DFA 跳转） */
export interface RunSignal {
  /** 信号标识（如 's3_stuck_in_patch_loop'） */
  signal: string;
  /** 发生时间（ISO） */
  at: string;
  /** 附加明细 */
  detail?: Record<string, unknown>;
}

/** 整个 Flow 的运行时状态 */
export interface FlowRunState {
  /** 本次运行的唯一 ID */
  run_id: string;
  /** 关联的 flow_id */
  flow_id: string;
  /** 流水线整体状态 */
  flow_status: FlowStatus;
  /** H0: 首个真实终止原因（幂等，不可被后续覆盖；completed 时为 'completed'） */
  end_reason?: TerminalEndReason;
  /** H1: 本次 run 的 S2 审批证据（供 S4 确认项精确匹配；非秘密） */
  s2_evidence?: HumanApprovalEvidence;
  /** 当前所在 stage_id */
  current_stage: string;
  /** 连续 auto 跳转计数（熔断用） */
  jump_count: number;
  /** 通用单阶段回流计数（非 S3 阶段回流，超限强制锁定） */
  stage_retry_count: number;
  /** 🔴 S3 专属驳回回流计数（独立于通用计数，max_s3_retries 限制） */
  s3_retry_count: number;
  /** E-02(enhance-v1): 已触发 S3 补丁循环强制回审（旧 s2_evidence 已 superseded，需新方案重开） */
  s3_patch_loop?: boolean;
  /** E-02(enhance-v1): 运行期机器信号序列（随 run 归档，供 S7 审计溯源） */
  run_signals?: RunSignal[];
  /** 🔴 S4.5 收敛轮次计数 */
  convergence_round: number;
  /** 🔴 S4.5 收敛历史（每轮得分快照） */
  convergence_history: ConvergenceEntry[];
  /** 🔴 项目根目录（供 ConvergenceGate 运行 CK 检查） */
  project_root?: string;
  /** 各 stage 的执行结果（key: stage_id） */
  stage_results: Map<string, StageResult>;
  /** S2 确认后持久化的全局备忘录 */
  global_memo: string;
  /** 运行开始时间 */
  started_at: string;
  /** 最后更新时间 */
  updated_at: string;
  /** 涉及的修改文件 */
  modified_files: string[];
  /** 风险等级 */
  risk_level: RiskLevel;
  /** 运行模式 */
  mode: RunMode;
}

// ════════════════════════════════════════════════════════════════════
// 异常类型
// ════════════════════════════════════════════════════════════════════

/** 工具白名单违规异常 */
export class WhitelistViolationError extends Error {
  public readonly action: string;
  public readonly stage_id: string;

  constructor(action: string, stage_id: string) {
    super(`[Harness] 操作 "${action}" 在 Stage "${stage_id}" 被工具白名单禁止`);
    this.name = 'WhitelistViolationError';
    this.action = action;
    this.stage_id = stage_id;
  }
}

/** 循环熔断异常 */
export class CircuitBreakerError extends Error {
  public readonly jumpCount: number;
  public readonly maxLimit: number;

  constructor(jumpCount: number, maxLimit: number) {
    super(`[Harness] 熔断触发: 连续 auto 流转 ${jumpCount} 次，超过上限 ${maxLimit}`);
    this.name = 'CircuitBreakerError';
    this.jumpCount = jumpCount;
    this.maxLimit = maxLimit;
  }
}

/** Stage 执行异常 */
export class StageExecutionError extends Error {
  public readonly stage_id: string;
  public readonly cause_error: string;

  constructor(stage_id: string, cause: string) {
    super(`[Harness] Stage "${stage_id}" 执行失败: ${cause}`);
    this.name = 'StageExecutionError';
    this.stage_id = stage_id;
    this.cause_error = cause;
  }
}

// ════════════════════════════════════════════════════════════════════
// 自进化引擎 — EvolutionEngine 相关类型
// ════════════════════════════════════════════════════════════════════

/** 观察到的原始事件类型 */
export type ObservedEventType =
  | 'sentinel_reverted'
  | 'sentinel_allowed'
  | 'sentinel_error'
  | 'audit_convergence'
  | 'audit_bypass'
  | 'audit_lockout'
  | 'hook_denial';

/** 违规模式类型 */
export type ViolationPatternType =
  | 'cluster_attack'
  | 'repeat_offender'
  | 'git_contention'
  | 'bash_script'
  | 'new_violation_type'
  | 'convergence_bottleneck'
  | 'bypass_abuse';

/** 规则升级建议类型 */
export type RuleUpgradeType =
  | 'add_ck_check'
  | 'add_design_standard'
  | 'modify_yaml_stage'
  | 'add_yaml_rule'
  | 'risk_upgrade'
  | 'weight_adjust'
  | 'add_blocklist_rule';

/** 配置校验异常 */
export class FlowConfigError extends Error {
  constructor(message: string) {
    super(`[Harness] 流水线配置错误: ${message}`);
    this.name = 'FlowConfigError';
  }
}

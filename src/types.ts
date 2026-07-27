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
  /** 驳回原因列表（条件门控解析此字段） */
  reject_reason: string[];
  /** 可选的量化指标 */
  metrics?: MachineSignalMetrics;
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
  | 'proposal_archive';

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
}

/** 整个 Flow 的运行时状态 */
export interface FlowRunState {
  /** 本次运行的唯一 ID */
  run_id: string;
  /** 关联的 flow_id */
  flow_id: string;
  /** 流水线整体状态 */
  flow_status: FlowStatus;
  /** 当前所在 stage_id */
  current_stage: string;
  /** 连续 auto 跳转计数（熔断用） */
  jump_count: number;
  /** 通用单阶段回流计数（非 S3 阶段回流，超限强制锁定） */
  stage_retry_count: number;
  /** 🔴 S3 专属驳回回流计数（独立于通用计数，max_s3_retries 限制） */
  s3_retry_count: number;
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

/** 配置校验异常 */
export class FlowConfigError extends Error {
  constructor(message: string) {
    super(`[Harness] 流水线配置错误: ${message}`);
    this.name = 'FlowConfigError';
  }
}

/**
 * types.ts — ProjectBrain v0.1 核心类型系统
 * ============================================
 * P1-T1: ProjectBrain 类型骨架。
 *
 * 定义 Harness v4.0 ProjectBrain 的基础类型。
 * 本文件不包含任何运行时业务逻辑。
 *
 * 架构约束（见 docs/v4/upgrade-isolation-rules.md）：
 * - 不得引用 src/FlowEngine、src/StageRunner、src/GateController
 * - 不得引用 mcp/、sentinel/
 * - 不得引入外部 npm 依赖
 */

// ============================================================================
// 1. 基础标识类型
// ============================================================================

/** ProjectBrain schema 版本号（当前为 1） */
export type ProjectBrainSchemaVersion = 1;

/** 项目唯一标识符 */
export type ProjectId = string;

/** 意图合约唯一标识符 */
export type IntentId = string;

/** 证据记录唯一标识符 */
export type EvidenceId = string;

/** 决策记录唯一标识符 */
export type DecisionId = string;

/** ISO 8601 时间戳字符串 */
export type IsoTimestamp = string;

/** 相对于项目根目录的路径（统一使用 `/` 分隔符） */
export type RelativePath = string;

// ============================================================================
// 2. ProjectBrainRoot — 项目大脑顶层结构
// ============================================================================

/** ProjectBrain 的顶层根对象 */
export interface ProjectBrainRoot {
  /** Schema 版本号 */
  schema_version: ProjectBrainSchemaVersion;
  /** 项目档案 */
  project: ProjectProfile;
  /** 意图合约列表 */
  intents: IntentSpec[];
  /** 证据记录列表 */
  evidence: EvidenceRecord[];
  /** 决策记录列表 */
  decisions: DecisionRecord[];
  /** 风险信号列表 */
  risks: RiskSignal[];
  /** 快照生成时间 */
  generated_at: IsoTimestamp;
}

// ============================================================================
// 3. ProjectProfile — 项目档案
// ============================================================================

/** 被管制项目的基本档案 */
export interface ProjectProfile {
  /** 项目唯一 ID */
  id: ProjectId;
  /** 项目人类可读名称 */
  name: string;
  /** 项目根目录绝对路径 */
  root: string;
  /** 项目描述（可选） */
  description?: string;
  /** 项目负责人列表（可选） */
  owners?: string[];
  /** 标签（可选） */
  tags?: string[];
}

// ============================================================================
// 4. IntentSpec — 意图合约
// ============================================================================

/** 意图合约（IntentSpec）—— 一次改造任务的边界定义 */
export interface IntentSpec {
  /** 意图合约唯一 ID */
  id: IntentId;
  /** 标题 */
  title: string;
  /** 详细描述 */
  description: string;
  /** 请求人（可选） */
  requested_by?: string;
  /** 创建时间 */
  created_at: IsoTimestamp;
  /** 最后更新时间（可选） */
  updated_at?: IsoTimestamp;
  /** 当前状态 */
  status: IntentStatus;
  /** 允许/禁止的文件范围 */
  scope: IntentScope;
  /** 风险评估摘要 */
  risk: IntentRiskSummary;
  /** 关联的证据记录 ID 列表 */
  evidence_ids: EvidenceId[];
  /** 关联的决策记录 ID 列表 */
  decision_ids: DecisionId[];
}

/** 意图合约的生命周期状态 */
export type IntentStatus =
  | 'draft'
  | 'reviewing'
  | 'approved'
  | 'rejected'
  | 'implemented'
  | 'superseded';

// ============================================================================
// 5. IntentScope — 改造范围定义
// ============================================================================

/** 意图合约的文件范围约束 */
export interface IntentScope {
  /** 允许修改的文件路径列表 */
  allowed_paths: RelativePath[];
  /** 禁止修改的文件路径列表 */
  forbidden_paths: RelativePath[];
  /** 预期产出的文件（可选） */
  expected_outputs?: RelativePath[];
  /** 备注（可选） */
  notes?: string[];
}

// ============================================================================
// 6. Risk — 风险类型
// ============================================================================

/** 风险等级 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** 意图合约的风险评估摘要 */
export interface IntentRiskSummary {
  /** 风险等级 */
  level: RiskLevel;
  /** 风险原因列表 */
  reasons: string[];
  /** 是否需要 Harness token */
  requires_token: boolean;
  /** 是否需要架构师审查 */
  requires_architect_review: boolean;
}

// ============================================================================
// 7. EvidenceRecord — 证据记录
// ============================================================================

/** 证据记录——来自基线报告、健康检查、测试结果等 */
export interface EvidenceRecord {
  /** 证据唯一 ID */
  id: EvidenceId;
  /** 证据类型 */
  type: EvidenceType;
  /** 证据标题 */
  title: string;
  /** 证据来源（文件路径、报告路径、或 URL） */
  source: string;
  /** 证据采集时间 */
  captured_at: IsoTimestamp;
  /** 摘要（可选） */
  summary?: string;
  /** 关联文件路径（可选） */
  related_paths?: RelativePath[];
  /** 额外元数据（可选） */
  metadata?: Record<string, unknown>;
}

/** 证据类型枚举 */
export type EvidenceType =
  | 'baseline_report'
  | 'health_report'
  | 'test_result'
  | 'code_review'
  | 'architect_decision'
  | 'runtime_observation'
  | 'manual_note';

// ============================================================================
// 8. DecisionRecord — 决策记录
// ============================================================================

/** 决策记录——来自人工审查或自动判定 */
export interface DecisionRecord {
  /** 决策唯一 ID */
  id: DecisionId;
  /** 决策类型 */
  type: DecisionType;
  /** 决策时间 */
  made_at: IsoTimestamp;
  /** 决策人/来源（可选） */
  made_by?: string;
  /** 决策摘要 */
  summary: string;
  /** 决策理由（可选） */
  rationale?: string;
  /** 关联意图 ID（可选） */
  related_intent_ids?: IntentId[];
  /** 关联证据 ID（可选） */
  related_evidence_ids?: EvidenceId[];
  /** 决策状态 */
  status: DecisionStatus;
}

/** 决策类型 */
export type DecisionType =
  | 'approve'
  | 'reject'
  | 'defer'
  | 'escalate'
  | 'override';

/** 决策的生命周期状态 */
export type DecisionStatus =
  | 'active'
  | 'superseded'
  | 'revoked';

// ============================================================================
// 9. RiskSignal — 风险信号
// ============================================================================

/** 来自各防线的实时风险信号 */
export interface RiskSignal {
  /** 信号风险等级 */
  level: RiskLevel;
  /** 信号来源 */
  source: RiskSignalSource;
  /** 风险描述 */
  message: string;
  /** 检出时间 */
  detected_at: IsoTimestamp;
  /** 关联文件路径（可选） */
  related_paths?: RelativePath[];
  /** 关联意图 ID（可选） */
  related_intent_ids?: IntentId[];
}

/** 风险信号来源 */
export type RiskSignalSource =
  | 'diff_scope'
  | 'architecture_baseline'
  | 'sentinel'
  | 'git_hook'
  | 'mcp'
  | 'test'
  | 'manual';

// ============================================================================
// 10. ProjectBrainSnapshot — 快照
// ============================================================================

/** ProjectBrain 的一次完整快照 */
export interface ProjectBrainSnapshot {
  /** Schema 版本号 */
  schema_version: ProjectBrainSchemaVersion;
  /** 快照生成时间 */
  generated_at: IsoTimestamp;
  /** 根对象 */
  root: ProjectBrainRoot;
}

// ============================================================================
// 11. 工具类型
// ============================================================================

/** ProjectBrain 数据校验结果 */
export interface ProjectBrainValidationResult {
  /** 是否校验通过 */
  valid: boolean;
  /** 错误信息列表 */
  errors: string[];
  /** 警告信息列表 */
  warnings: string[];
}

/**
 * Harness 调度引擎 — 统一导出
 * ==============================
 * 零侵入外挂架构的单一入口点。
 *
 * 快速使用：
 *   import { WenstarOSAdapter } from './harness/index.js';
 *   if (WenstarOSAdapter.isEnabled() && WenstarOSAdapter.shouldTriggerPipeline(msg)) {
 *     await WenstarOSAdapter.triggerPipeline(msg);
 *   }
 */

// ── 核心引擎 ──
export { FlowEngine } from './FlowEngine.js';
export type { FlowEngineOptions, FlowResult } from './FlowEngine.js';

export { StageRunner } from './StageRunner.js';
export type { StageRunnerOptions, DelegateReviewFn } from './StageRunner.js';

export { GateController } from './GateController.js';
export type { GateControllerOptions, HumanGateCallback } from './GateController.js';

export { ToolWhitelistGuard } from './ToolWhitelistGuard.js';

export { GlobalMemoStore } from './GlobalMemoStore.js';

export { AuditLogger } from './AuditLogger.js';

export { loadFlowConfig, clearConfigCache } from './FlowConfigLoader.js';

// ── 双通道信号 ──
export {
  passSignal,
  rejectSignal,
  makeStageOutput,
  encodeMachineSignal,
  decodeMachineSignal,
  validateMachineSignal,
  validateStageOutput,
  formatHumanReport,
} from './DualChannelSignal.js';

// ── 业务适配 ──
// WenstarOSAdapter 已归属宿主项目（wenstar-cc），不属于 Harness 独立项目
export {
  classifyFile,
  classifyFiles,
  isTrivialChange,
  isHighRisk,
  getHighRiskFiles,
} from './RiskClassifier.js';
export {
  tscCheck,
  vitestRun,
  vitestRunDir,
  webuiStart,
  safeBackfill,
} from './NativeCommands.js';
export { review } from './DelegateReviewer.js';

// ── Token 降耗模块 ──
export { CheckCache } from './CheckCache.js';
export { RulesLazyLoader } from './RulesLazyLoader.js';
export type { SlimStageContext } from './RulesLazyLoader.js';

// ── 本地硬校验脚本（导出核心函数供外部调用） ──
export {
  checkGlobalSurvey,
  checkNineLayerPipeline,
  checkPFCThinScheduler,
  checkFGHouseholdSpec,
  checkUUIDAnnotationChain,
  checkMeetingEntityPoints,
  checkSQLiteSaveCalls,
  checkSystemicPattern,
  checkHighRiskDependencyScan,
  checkASTIfBranchCount,
  checkRegressionSafety,
  checkIntentFulfillment,
  MEETING_ENTITY_CHECKPOINTS,
  PATCH_IF_THRESHOLD,
  HIGH_RISK_FILES,
  FG_REDLINE_TITLES,
} from './main_harness_checker.js';
export type {
  CheckResult,
  Violation,
  CheckerOutput,
  CheckerSummary,
  CacheableData,
} from './main_harness_checker.js';

// ── S4.5 收敛闸门 ──
export { DESIGN_STANDARDS, getStandardById, getStandardsByCategory, getCKToStandardMapping } from './DesignStandards.js';
export type { DesignStandard, StandardCategory } from './DesignStandards.js';

export { computeComplianceScore, isCompliancePassed } from './ComplianceScorer.js';

export { evaluate as convergenceEvaluate, getConvergenceHistory, getCurrentConvergenceRound } from './ConvergenceGate.js';
export type { ConvergenceGateConfig } from './ConvergenceGate.js';

// ── 自学习引擎 ──
export { analyze as selfLearn } from './SelfLearner.js';

// ── 自进化引擎 ──
export { EvolutionEngine } from './EvolutionEngine.js';
export type {
  EvolutionEngineConfig,
  EvolutionStatus,
  ObservedEvent,
  ViolationPattern,
  RuleUpgrade,
} from './EvolutionEngine.js';

export {
  HARDNESS_LEVELS,
  evaluateUpgrade,
  getLevelDef,
  getNextLevel,
  getUpgradeProgress,
  formatUpgradeReport,
} from './HardnessLadder.js';
export type {
  HardnessLevel as EvolutionHardnessLevel,
  HardnessLevelDef,
  HardnessStats,
  UpgradePath,
  UpgradeCondition,
} from './HardnessLadder.js';

// ── 类型 ──
export type {
  FlowConfig,
  StageConfig,
  FlowRunState,
  StageResult,
  StageStatus,
  FlowStatus,
  StageOutput,
  MachineSignal,
  MachineSignalMetrics,
  TriggerContext,
  AuditEntry,
  AuditEventType,
  GateType,
  GateResolution,
  RunnerMode,
  RiskLevel,
  RunMode,
  WhitelistKey,
  AfterAction,
  StandardComplianceScore,
  GapItem,
  ComplianceReport,
  ConvergenceEntry,
} from './types.js';

export {
  WhitelistViolationError,
  CircuitBreakerError,
  StageExecutionError,
  FlowConfigError,
} from './types.js';

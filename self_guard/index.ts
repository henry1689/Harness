/**
 * SelfGuard 独立自护子系统 — 统一导出
 * ======================================
 * 零侵入外挂架构的 SelfGuard 子系统单一入口点。
 *
 * 体系概览：
 *   SelfGuard 是 WenStarOS 的独立自护子系统，专门管控主 Harness 自身的
 *   配置修改、规则升级、评审逻辑适配、内核微调。
 *
 *   分工铁律：
 *     - 业务迭代 → 主 Harness（src/harness/）
 *     - Harness 基础设施改造 → SelfGuard（harness/self_guard/）
 *
 * 快速使用（自动路由）：
 *   import { SelfGuardIntegration } from '../harness/self_guard/index.js';
 *
 *   const result = await SelfGuardIntegration.dispatch(userMessage, files);
 *   // 自动分流：Harness 基础设施 → SelfGuard | 业务代码 → 主 Harness
 *
 * 快速使用（直接触发）：
 *   import { SelfGuardEngine } from '../harness/self_guard/index.js';
 *
 *   if (SelfGuardEngine.shouldTakeOver(modifiedFiles)) {
 *     const engine = new SelfGuardEngine();
 *     const result = await engine.trigger({ message, modifiedFiles });
 *   }
 *
 * 🔑 启动口令（发给 WenStarOS 即可激活）：
 *   @selfguard on  |  启动自护  |  /selfguard  |  selfguard:on
 *
 * 体系注册信息：
 *   - 流水线配置：harness/self_guard/self_guard_flow.yaml (S1-S7)
 *   - 独立规则集：harness/self_guard/self_guard_rules.yaml (十条自护铁律)
 *   - 独立评审器：SelfReviewer (十条铁律全维度校验)
 *   - 独立卷宗分区：data/harness/self_guard/audit/
 *   - 版本链：data/harness/self_guard/version_chain.json
 *   - 对接适配器：SelfGuardIntegration (与主 Harness 自动分流)
 */

// ── 自护引擎 ──
export { SelfGuardEngine } from './SelfGuardEngine.js';
export type { SelfGuardEngineOptions, SelfGuardTriggerInput } from './SelfGuardEngine.js';

// ── 集成适配器（与主 Harness 对接 + 口令） ──
export * as SelfGuardIntegration from './SelfGuardIntegration.js';

// ── 独立评审器 ──
export { review as selfReview } from './SelfReviewer.js';

// ── 外部制衡 ──
export { GlobalWatchdog } from './GlobalWatchdog.js';
export type { BreachEvent, BreachCallback, WatchdogStatus, PermissionBaseline } from './GlobalWatchdog.js';

// ── 独立卷宗 ──
export { SelfGuardAuditLogger } from './SelfGuardAuditLogger.js';
export type { VersionChainEntry, VersionChain } from './SelfGuardAuditLogger.js';

// ── 十一条自护铁律常量 ──
/** 十一条自护铁律 ID 列表 */
export const SELF_GUARD_RULE_IDS = [
  'SG-R1', 'SG-R2', 'SG-R3',
  'SG-R4', 'SG-R5', 'SG-R6',
  'SG-R7', 'SG-R8', 'SG-R9',
  'SG-R10', 'SG-R11',
] as const;

/** 十一条自护铁律名称映射 */
export const SELF_GUARD_RULE_NAMES: Record<string, string> = {
  'SG-R1': '改动范围铁律',
  'SG-R2': '主Harness底层架构不可破坏基线',
  'SG-R3': 'Harness变更强制升级为最高风险等级',
  'SG-R4': '禁止隐性削弱原有防护能力',
  'SG-R5': '双向兼容强制校验规则',
  'SG-R6': '基础设施配套文档同步规则',
  'SG-R7': '全量单元测试强制100%通过',
  'SG-R8': '基础设施变更痕迹强化归档规则',
  'SG-R9': '架构重构提案权限收缩规则',
  'SG-R10': '版本迭代强制复审铁律',
  'SG-R11': '外部制衡与旁路巡检铁律',
};

/** 十一条自护铁律分类 */
export const SELF_GUARD_RULE_CATEGORIES: Record<string, string> = {
  'SG-R1': 'scope_boundary',
  'SG-R2': 'baseline_protection',
  'SG-R3': 'risk_enforcement',
  'SG-R4': 'protection_escalation',
  'SG-R5': 'compatibility',
  'SG-R6': 'documentation_sync',
  'SG-R7': 'test_enforcement',
  'SG-R8': 'audit_trail',
  'SG-R9': 'permission_control',
  'SG-R10': 'iteration_review',
  'SG-R11': 'external_oversight',
};

/** SelfGuard 版本 */
export const SELF_GUARD_VERSION = '1.2.0';

/** SelfGuard 生效域前缀 */
export const SELF_GUARD_SCOPE_PREFIXES = [
  'src/harness/',
  'data/harness/',
  'harness/self_guard/',
] as const;

/** SelfGuard 卷宗分区路径（相对于项目根） */
export const SELF_GUARD_AUDIT_PATH = 'data/harness/self_guard/audit/';

/** SelfGuard 基础设施变更标签 */
export const SELF_GUARD_INFRA_TAG = '【基础设施变更】';

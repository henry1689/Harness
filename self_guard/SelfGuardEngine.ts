/**
 * SelfGuardEngine — 自护引擎入口
 * ================================
 * SelfGuard 体系的流水线引擎，复用主 Harness 的 FlowEngine 基础框架，
 * 但使用完全独立的配置、评审器、卷宗分区。
 *
 * 核心职责：
 *   1. 加载 self_guard_flow.yaml 独立流水线配置
 *   2. 注入 SelfReviewer 作为 delegate 评审函数
 *   3. 使用 SelfGuardAuditLogger 写入独立卷宗分区
 *   4. 生效域限定：只接受 src/harness/ 或 data/harness/ 目录的变更
 *   5. 自动拦截业务目录的变更请求
 *
 * 🔴 与主 Harness 的隔离：
 *   - SelfGuard 使用独立的 FlowConfig（self_guard_flow.yaml）
 *   - SelfGuard 使用独立的评审器（SelfReviewer vs DelegateReviewer）
 *   - SelfGuard 使用独立的卷宗分区（data/harness/self_guard/audit/）
 *   - SelfGuard 九条自护铁律仅在 SelfGuard 流水线内部生效
 *
 * 使用方式：
 *   import { SelfGuardEngine } from '../harness/self_guard/index.js';
 *
 *   const engine = new SelfGuardEngine({ projectRoot: process.cwd() });
 *   const result = await engine.trigger({
 *     message: '修改 FlowEngine.ts 增加超时重试逻辑',
 *     modifiedFiles: ['src/harness/FlowEngine.ts'],
 *   });
 */

import { FlowEngine, type FlowResult } from '../src/FlowEngine.js';
import { classifyFiles, isTrivialChange } from '../src/RiskClassifier.js';
import { loadFlowConfig } from '../src/FlowConfigLoader.js';
import { review as selfReview } from './SelfReviewer.js';
import { SelfGuardAuditLogger } from './SelfGuardAuditLogger.js';
import type {
  TriggerContext,
  RiskLevel,
  StageConfig,
  FlowRunState,
  StageOutput,
} from '../src/types.js';

// ════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════

/** SelfGuardEngine 构造选项 */
export interface SelfGuardEngineOptions {
  /** 项目根目录 */
  projectRoot?: string;
  /** 人工审批回调 */
  onHumanGate?: (stageId: string, message: string) => Promise<boolean>;
}

/** SelfGuard 触发输入 */
export interface SelfGuardTriggerInput {
  /** 用户原始消息 */
  message: string;
  /** 待修改的文件路径列表 */
  modifiedFiles: string[];
  /** 会话 ID（可选） */
  sessionId?: string;
}

// ════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════

/** SelfGuard 流水线配置文件名 */
const SELF_GUARD_FLOW_CONFIG = 'self_guard_flow.yaml';

/** SelfGuard 允许的修改域 */
const ALLOWED_SCOPE_PREFIXES = [
  'src/harness/',
  'data/harness/',
  'harness/self_guard/',
  'harness-core/',           // junction from wenstar-cc → standalone harness
  'src/',                    // standalone harness project relative
  '.claude/',
];

// ════════════════════════════════════════════════════════════════════
// SelfGuardEngine
// ════════════════════════════════════════════════════════════════════

export class SelfGuardEngine {
  private readonly options: SelfGuardEngineOptions;
  private flowEngine: FlowEngine | null = null;

  constructor(options: SelfGuardEngineOptions = {}) {
    this.options = options;
  }

  // ════════════════════════════════════════════════════════════════
  // 公开 API
  // ════════════════════════════════════════════════════════════════

  /**
   * 触发 SelfGuard 自护流水线。
   *
   * @param input — 触发输入（用户消息 + 文件列表）
   * @returns 流水线执行结果
   */
  async trigger(input: SelfGuardTriggerInput): Promise<FlowResult> {
    // 0. 生效域校验——拦截业务目录的变更
    const domainCheck = this.validateScope(input.modifiedFiles);
    if (!domainCheck.valid) {
      return {
        run_id: 'rejected_scope',
        success: false,
        end_reason: `[SelfGuard] 生效域拦截: ${domainCheck.reason}`,
        stage_results: [],
      };
    }

    // 1. 风险分级——Harness 变更一律升级为超高风险（SG-R3）
    const riskLevel: RiskLevel = 'high'; // 基础设施变更强制高风险

    // 2. 构建触发上下文
    const context: TriggerContext = {
      message: input.message,
      modifiedFiles: input.modifiedFiles,
      sessionId: input.sessionId,
      riskLevel,
      isTrivial: false, // Harness 变更永远不是微小修改
    };

    // 3. 初始化 FlowEngine（复用框架，配独立配置）
    this.flowEngine = new FlowEngine({
      projectRoot: this.options.projectRoot || process.cwd(),
      delegateReviewFn: this.delegateReviewFn.bind(this),
    });

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  🛡️  SelfGuard 基础设施自护流水线已激活                       ║');
    console.log('║  生效域：src/harness/ + data/harness/                         ║');
    console.log('║  评审器：SelfReviewer（九条自护铁律）                          ║');
    console.log('║  卷　宗：data/harness/self_guard/audit/                       ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // 4. 启动流水线
    const result = await this.flowEngine.start(SELF_GUARD_FLOW_CONFIG, context);

    // 5. 归档版本链快照（SG-R8）
    if (result.success) {
      const auditLogger = new SelfGuardAuditLogger(result.run_id, 'self_guard_flow');
      auditLogger.logVersionSnapshot(
        `SelfGuard 流水线完成: ${input.message}`,
        undefined, // commit hash 可在外部注入
      );
    }

    return result;
  }

  /**
   * 🔴 生效域校验——确保变更仅限于 Harness 域内。
   * 业务目录的变更请求直接拦截。
   */
  validateScope(files: string[]): { valid: boolean; reason?: string } {
    const outOfScope: string[] = [];

    for (const f of files) {
      const normalized = f.replace(/\\/g, '/');
      const inScope = ALLOWED_SCOPE_PREFIXES.some(prefix => normalized.startsWith(prefix));

      if (!inScope) {
        outOfScope.push(f);
      }
    }

    if (outOfScope.length > 0) {
      return {
        valid: false,
        reason: `以下文件不在 SelfGuard 管控域内：${outOfScope.join(', ')}。` +
          'SelfGuard 仅管控 src/harness/ 及 data/harness/ 目录。' +
          '业务迭代请走主 Harness 流水线。',
      };
    }

    return { valid: true };
  }

  /**
   * 🔴 判断是否应由 SelfGuard 接管。
   * 仅当所有修改文件都落在 harness 域内时才接管。
   */
  static shouldTakeOver(files: string[]): boolean {
    if (files.length === 0) return false;

    return files.every(f => {
      const n = f.replace(/\\/g, '/');
      return ALLOWED_SCOPE_PREFIXES.some(prefix => n.startsWith(prefix));
    });
  }

  /**
   * 🔴 判断是否应由 SelfGuard 接管（含跨域检测）。
   * 与 shouldTakeOver 不同，此方法会检测是否存在部分文件在域内、部分在域外的情况。
   */
  static analyzeScope(files: string[]): {
    takeover: 'self_guard' | 'main_harness' | 'mixed' | 'unknown';
    harnessFiles: string[];
    businessFiles: string[];
  } {
    const harnessFiles: string[] = [];
    const businessFiles: string[] = [];

    for (const f of files) {
      const n = f.replace(/\\/g, '/');
      if (ALLOWED_SCOPE_PREFIXES.some(p => n.startsWith(p))) {
        harnessFiles.push(f);
      } else {
        businessFiles.push(f);
      }
    }

    if (harnessFiles.length > 0 && businessFiles.length === 0) {
      return { takeover: 'self_guard', harnessFiles, businessFiles };
    }

    if (harnessFiles.length === 0 && businessFiles.length > 0) {
      return { takeover: 'main_harness', harnessFiles, businessFiles };
    }

    if (harnessFiles.length > 0 && businessFiles.length > 0) {
      return { takeover: 'mixed', harnessFiles, businessFiles };
    }

    return { takeover: 'unknown', harnessFiles, businessFiles };
  }

  // ════════════════════════════════════════════════════════════════
  // 内部
  // ════════════════════════════════════════════════════════════════

  /**
   * Delegate 评审函数——注入 SelfReviewer。
   * 由 FlowEngine 在 S4（condition + delegate）阶段调用。
   */
  private async delegateReviewFn(stage: StageConfig, state: FlowRunState): Promise<StageOutput> {
    console.log('[SelfGuardEngine] 🔍 委托 SelfReviewer 执行自护评审...');
    return selfReview(stage, state);
  }
}

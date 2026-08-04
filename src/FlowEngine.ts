/**
 * FlowEngine — 流水线引擎主控（DFA 状态机核心）
 * ==================================================
 * 基于确定性有限状态机实现 Stage 流转。
 *
 * 核心铁律：
 *   1. AI 输出文本无法干预跳转——跳转由代码逻辑基于 gate_resolution 决定
 *   2. max_jump_limit 对连续 auto 跳转计数，超过触发熔断
 *   3. 每个 Stage 启动前注入全局备忘录
 *   4. 白名单随 Stage 切换自动激活/停用
 *   5. 全流程审计日志自动记录
 *
 * 使用示例：
 *   const engine = new FlowEngine({ /* options *\/ });
 *   const result = await engine.start('wenstaros_core_repair_flow', {
 *     message: '修复 chat.ts 中的 FG 写入 bug',
 *     modifiedFiles: ['src/webui/chat.ts'],
 *     riskLevel: 'high',
 *     isTrivial: false,
 *   });
 */

import type {
  FlowConfig,
  StageConfig,
  StageResult,
  FlowRunState,
  FlowStatus,
  GateResolution,
  TriggerContext,
  RunMode,
} from './types.js';
import { CircuitBreakerError, StageExecutionError } from './types.js';
import { loadFlowConfig } from './FlowConfigLoader.js';
import { GateController, type HumanGateCallback } from './GateController.js';
import { StageRunner, type DelegateReviewFn } from './StageRunner.js';
import { ToolWhitelistGuard } from './ToolWhitelistGuard.js';
import { GlobalMemoStore } from './GlobalMemoStore.js';
import { AuditLogger } from './AuditLogger.js';
import { RulesLazyLoader, type SlimStageContext } from './RulesLazyLoader.js';
import { execSync } from 'node:child_process';

// ════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════

/** FlowEngine 构造选项 */
export interface FlowEngineOptions {
  /** 人工审批回调（human gate 必须） */
  onHumanGate?: HumanGateCallback;
  /** 委托评审函数（delegate runner 必须） */
  delegateReviewFn?: DelegateReviewFn;
  /** 🔴 按阶段分派的委托评审函数（优先于 delegateReviewFn） */
  delegateReviewFnMap?: Map<string, DelegateReviewFn>;
  /** 项目根目录 */
  projectRoot?: string;
  /** 🔴 自动批准 human gate（MCP 无头模式，跳过人工确认） */
  autoApproveHumanGate?: boolean;
  /** 🔴 P5: condition gate 前置检查（如 S3 编译自检） */
  conditionGateCheck?: (stageId: string, projectRoot: string) => Promise<{ passed: boolean; reason?: string }>;
}

/** 流水线执行结果 */
export interface FlowResult {
  /** 运行 ID */
  run_id: string;
  /** 流程是否成功完成 */
  success: boolean;
  /** 终止原因（aborted / circuit_breaker / completed） */
  end_reason: string;
  /** 各 stage 的执行结果 */
  stage_results: StageResult[];
  /** 审计日志文件路径 */
  audit_path?: string;
  /** 备忘录文件路径 */
  memo_path?: string;
}

// ════════════════════════════════════════════════════════════════════
// 引擎
// ════════════════════════════════════════════════════════════════════

export class FlowEngine {
  private readonly gateController: GateController;
  private readonly stageRunner: StageRunner;
  private memoStore: GlobalMemoStore | null = null;
  private auditLogger: AuditLogger | null = null;
  private config: FlowConfig | null = null;
  private state: FlowRunState | null = null;
  private _aborted = false;
  private _paused = false;

  constructor(options: FlowEngineOptions = {}) {
    // 🔴 自动批准模式：构造一个始终返回 'approved' 的回调
    const humanCallback = options.autoApproveHumanGate
      ? async (_stage: StageConfig, _result: StageResult): Promise<'approved'> => 'approved'
      : options.onHumanGate;

    this.gateController = new GateController({
      onHumanGate: humanCallback ?? undefined,
    });
    this.stageRunner = new StageRunner({
      delegateReviewFn: options.delegateReviewFn,
      delegateReviewFnMap: options.delegateReviewFnMap,
      projectRoot: options.projectRoot || process.cwd(),
      conditionGateCheck: options.conditionGateCheck,
    });
  }

  // ════════════════════════════════════════════════════════════════
  // 公开 API
  // ════════════════════════════════════════════════════════════════

  /**
   * 启动流水线。
   *
   * @param flowFileName — YAML 配置文件名（如 "wenstaros_core_repair_flow.yaml"）
   * @param context — 触发上下文
   * @returns 流水线执行结果
   */
  async start(flowFileName: string, context: TriggerContext): Promise<FlowResult> {
    // 0. 风险分级 → 决定流水线 / 自由模式
    if (context.riskLevel === 'low' && context.isTrivial) {
      return this.runFreeMode(context);
    }

    // 1. 加载配置
    this.config = loadFlowConfig(flowFileName);

    // 2. 初始化运行状态
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.state = this.initRunState(runId, context);

    // 3. 初始化备忘录
    this.memoStore = new GlobalMemoStore(
      runId,
      this.config.flow_id,
      this.config.global_arch_constraint,
      this.config.global_implementation_rules,
    );

    // 4. 初始化审计日志
    this.auditLogger = new AuditLogger(runId, this.config.flow_id);
    this.auditLogger.logFlowStart({
      flow_name: this.config.flow_name,
      risk_level: context.riskLevel,
      modified_files: context.modifiedFiles,
    });

    console.log(`\n[FlowEngine] 🚀 流水线启动: ${this.config.flow_name} (${runId})`);
    console.log(`[FlowEngine]    风险: ${context.riskLevel} | 文件: ${context.modifiedFiles.join(', ')}`);

    // 5. 进入第一个 Stage
    try {
      const firstStage = this.config.stages[0].stage_id;
      await this.transitionTo(firstStage);
      return this.buildResult(true, 'completed');
    } catch (err) {
      return this.handleError(err);
    }
  }

  /** 获取当前流水线运行状态 */
  getState(): FlowRunState | null {
    return this.state;
  }

  /** 获取当前配置 */
  getConfig(): FlowConfig | null {
    return this.config;
  }

  /** 人工确认当前 human gate stage（从外部调用） */
  async approveCurrentStage(): Promise<void> {
    // human gate 的审批由 GateController 内部的 callback 处理
    // 此方法作为外部入口，设置暂停标记
    if (this._paused) {
      this._paused = false;
      console.log('[FlowEngine] ▶ 人工确认，继续流水线');
    }
  }

  /** 驳回当前 human gate stage */
  async rejectCurrentStage(): Promise<void> {
    this._paused = false;
    console.log('[FlowEngine] ⏹ 人工驳回');
    // 由 GateController 的 callback 处理跳转
  }

  /** 中止流水线 */
  abort(): void {
    this._aborted = true;
    this._paused = false;
    if (this.state) this.state.flow_status = 'aborted';
    if (this.auditLogger) this.auditLogger.logFlowAbort('用户主动中止');
    ToolWhitelistGuard.deactivate();
    console.log('[FlowEngine] ⏹ 流水线已中止');
  }

  // ════════════════════════════════════════════════════════════════
  // DFA 状态机核心
  // ════════════════════════════════════════════════════════════════

  /**
   * 🔴 确定性跳转——AI 无权限干预。
   * 跳转目标由纯代码逻辑根据 gate_type 和 gate_resolution 计算。
   */
  private async transitionTo(stageId: string): Promise<void> {
    if (this._aborted) {
      console.log('[FlowEngine] 流水线已中止，停止跳转');
      return;
    }

    if (!this.config || !this.state) {
      throw new Error('[FlowEngine] 未初始化');
    }

    // END 哨兵
    if (stageId === 'END') {
      this.state.flow_status = 'completed';
      this.state.updated_at = new Date().toISOString();
      if (this.auditLogger) this.auditLogger.logFlowComplete({ total_stages: this.state.stage_results.size });
      ToolWhitelistGuard.deactivate();
      console.log('[FlowEngine] ✅ 流水线完成');
      return;
    }

    // 查找 stage 配置
    const stage = this.config.stages.find(s => s.stage_id === stageId);
    if (!stage) {
      throw new StageExecutionError(stageId, `配置中不存在 stage_id: ${stageId}`);
    }

    // 更新状态
    this.state.current_stage = stageId;
    this.state.updated_at = new Date().toISOString();

    // 🔴 注入全局备忘录到 work_manual
    const workManual = this.injectMemo(stage);

    // 🔴 激活工具白名单
    ToolWhitelistGuard.activate(stage.tool_whitelist, stageId);

    // 🔴 审计记录：Stage 进入
    if (this.auditLogger) {
      this.auditLogger.logStageEntry(stageId, {
        gate_type: stage.gate_type,
        runner_mode: stage.runner_mode,
        whitelist_active: Object.keys(stage.tool_whitelist)
          .filter(k => stage.tool_whitelist[k as keyof typeof stage.tool_whitelist] === false)
          .join(', '),
        memo_injected: this.memoStore ? this.memoStore.content.length > 0 : false,
      });
    }

    // 🔴 执行 Stage
    const stageWithMemo: StageConfig = { ...stage, work_manual: workManual };
    const result = await this.stageRunner.execute(stageWithMemo, this.state);

    // 存储结果
    this.state.stage_results.set(stageId, result);

    // 🔴 门控判定
    const resolution = await this.gateController.resolve(stage, result);
    result.gate_resolution = resolution;

    // 审计记录：门控决议
    if (this.auditLogger) {
      this.auditLogger.logGateResolve(stageId, stage.gate_type, resolution);
    }

    console.log(`[FlowEngine] 🎯 ${stageId} → gate: ${stage.gate_type} → ${resolution}`);

    // 🔴 熔断检查：连续 auto 跳转计数
    if (stage.gate_type === 'auto' && resolution === 'auto_passed') {
      this.state.jump_count++;
      if (this.state.jump_count >= this.config.max_jump_limit) {
        const err = new CircuitBreakerError(this.state.jump_count, this.config.max_jump_limit);
        if (this.auditLogger) this.auditLogger.logCircuitBreaker(this.state.jump_count, this.config.max_jump_limit);
        throw err;
      }
    } else {
      this.state.jump_count = 0; // 非 auto 或非 passed → 重置计数
    }

    // 🔴 after_action 处理
    if (stage.after_action === 'inject_global_memo' && resolution === 'human_approved') {
      if (this.memoStore && result.human_report) {
        this.memoStore.save(result.human_report);
        this.state.global_memo = this.memoStore.content;
        if (this.auditLogger) this.auditLogger.logMemoInjected(stageId, this.memoStore.content.length);
        console.log('[FlowEngine] 📌 全局备忘录已注入');
      }
    }

    // 🔴 确定性跳转：纯代码逻辑决定下一 stage
    const nextStage = this.determineNextStage(stage, resolution);

    // 🔴 human gate 超时/驳回 → 直接中止流水线，不进入下一阶段
    if (resolution === 'human_timeout' || resolution === 'human_denied') {
      if (this.state) this.state.flow_status = 'aborted';
      this.abort();
      if (this.auditLogger) {
        this.auditLogger.logFlowAbort(`human gate ${resolution}: ${stageId}`);
      }
      console.log(`[FlowEngine] ⏹ human gate ${resolution} → 流水线中止`);
      return;
    }

    // 🔴 回流计数器：检测是否回到 S3 或更高序号回退
    if (this.isStageRegression(stageId, nextStage)) {
      // S3 专属计数（S4/S5/S6 驳回→S3）
      if (nextStage.startsWith('S3')) {
        this.state.s3_retry_count++;
        const maxS3 = this.config?.max_s3_retries ?? 3;
        if (this.state.s3_retry_count > maxS3) {
          console.error(`[FlowEngine] 🔴 S3 驳回熔断: 已回流 ${this.state.s3_retry_count}/${maxS3} 次，触发强制锁定 → 需人工解锁`);
          if (this.auditLogger) {
            this.auditLogger.logFlowAbort(`S3 驳回回流 ${this.state.s3_retry_count}/${maxS3} 次超限，强制锁定——需人工解锁`);
          }
          if (this.state) this.state.flow_status = 'aborted';
          this.abort();
          ToolWhitelistGuard.deactivate();
          return;
        }
        console.log(`[FlowEngine] 🔄 S3 驳回回流 #${this.state.s3_retry_count}/${maxS3}: ${stageId}→${nextStage}`);
      } else {
        // 通用回流计数器（非 S3 驳回）
        this.state.stage_retry_count++;
        const maxRetries = this.config?.max_stage_retries ?? 5;
        if (this.state.stage_retry_count > maxRetries) {
          console.error(`[FlowEngine] 🔴 回流熔断: ${stageId}→${nextStage} 已达上限 ${maxRetries} 次`);
          if (this.auditLogger) {
            this.auditLogger.logFlowAbort(`重试次数 ${this.state.stage_retry_count}/${maxRetries} 超限，强制锁定`);
          }
          if (this.state) this.state.flow_status = 'aborted';
          this.abort();
          ToolWhitelistGuard.deactivate();
          return;
        }
        console.log(`[FlowEngine] 🔄 回流 #${this.state.stage_retry_count}/${maxRetries}: ${stageId}→${nextStage}`);
      }
    }

    // 停用当前 stage 的白名单
    ToolWhitelistGuard.deactivate();

    // 递归跳转
    await this.transitionTo(nextStage);
  }

  /**
   * 🔴 确定性跳转逻辑——AI 输出文本无法改变此决策。
   *
   * @param stage — 当前 stage 配置
   * @param resolution — 门控决议
   * @returns 下一 stage_id（或 "END"）
   */
  private determineNextStage(stage: StageConfig, resolution: GateResolution): string {
    if (stage.gate_type === 'condition') {
      // 条件门控：passed → next_stage_pass, rejected → next_stage_reject
      if (resolution === 'condition_passed') {
        return stage.next_stage_pass || 'END';
      }
      return stage.next_stage_reject || stage.stage_id; // 默认回退到自身
    }

  // auto gate：无条件走 next_stage
  return stage.next_stage || 'END';
  }

  // ════════════════════════════════════════════════════════════════
  // 回流计数器
  // ════════════════════════════════════════════════════════════════

  /** 检测是否回到了更高序号的 stage（如 S4→S3） */
  private isStageRegression(from: string, to: string): boolean {
    if (!this.config) return false;
    const fromIdx = this.config.stages.findIndex(s => s.stage_id === from);
    const toIdx = this.config.stages.findIndex(s => s.stage_id === to);
    return fromIdx >= 0 && toIdx >= 0 && fromIdx > toIdx;
  }

  // ════════════════════════════════════════════════════════════════
  // 备忘录注入
  // ════════════════════════════════════════════════════════════════

  /**
   * 🔴 Token 降耗：注入精简上下文。
   *
   * 业务流水线（wenstaros_core_repair_flow）使用 RulesLazyLoader 仅注入：
   *   - 精简规则摘要（~200 tokens，替代完整架构铁律 ~3000 tokens）
   *   - 前序阶段失败要点（仅违规项）
   *   - S4→S3 回流时的具体驳回反馈
   *
   * SelfGuard 等其他 Flow 保持原有全量注入逻辑不变。
   */
  private injectMemo(stage: StageConfig): string {
    if (!this.memoStore || !this.state) return stage.work_manual;

    const flowId = this.config?.flow_id ?? '';

    // 🔴 业务流水线：使用懒加载精简上下文
    if (RulesLazyLoader.getInstance().isBusinessFlow(flowId)) {
      return this.injectSlimContext(stage);
    }

    // 其他流水线（SelfGuard 等）：保持原有全量注入逻辑不变
    if (this.state.global_memo || this.memoStore.content) {
      return this.memoStore.inject(stage.work_manual);
    }

    // S2 之前：注入架构铁律 + 落地强制规则
    return this.memoStore.injectFullRules(stage.work_manual);
  }

  /**
   * 🔴 精简上下文注入（仅业务流水线）。
   */
  private injectSlimContext(stage: StageConfig): string {
    if (!this.state || !this.config) return stage.work_manual;

    const loader = RulesLazyLoader.getInstance();
    const slimCtx = loader.buildStageContext(
      this.config.flow_id,
      stage.stage_id,
      this.state.stage_results,
    );

    // 如果有 S2 定稿方案，仍需注入（这是用户审核确认的方案，不可省略）
    const memoBlock = this.state.global_memo || (this.memoStore?.content || '');

    const parts: string[] = [stage.work_manual, '', '---', ''];

    // 1. 精简规则摘要
    parts.push(slimCtx.rules_brief);

    // 2. S2 定稿方案（若有）
    if (memoBlock) {
      parts.push('');
      parts.push('## 📌 S2 审定方案（不可突破）');
      parts.push('');
      parts.push(memoBlock.slice(0, 2000)); // 截断过长方案，保留核心内容
    }

    // 3. 前序阶段失败要点
    if (slimCtx.failure_brief && !slimCtx.failure_brief.includes('全部通过')) {
      parts.push('');
      parts.push(slimCtx.failure_brief);
    }

    // 4. S4→S3 回流反馈
    if (slimCtx.review_feedback) {
      parts.push('');
      parts.push('## 🔴 S4 架构评审驳回项（仅修复以下内容）');
      parts.push('');
      parts.push(slimCtx.review_feedback);
    }

    return parts.join('\n');
  }

  // ════════════════════════════════════════════════════════════════
  // 运行状态初始化
  // ════════════════════════════════════════════════════════════════

  private initRunState(runId: string, context: TriggerContext): FlowRunState {
    // 🔴 projectRoot 优先从 TriggerContext 取值，其次 FlowEngine 构造选项，最后当前目录
    const projectRoot = context.projectRoot || this.stageRunner.getProjectRoot();
    return {
      run_id: runId,
      flow_id: this.config!.flow_id,
      flow_status: 'running',
      current_stage: '',
      jump_count: 0,
      stage_retry_count: 0,
      s3_retry_count: 0,
      convergence_round: 0,
      convergence_history: [],
      project_root: projectRoot,
      stage_results: new Map(),
      global_memo: '',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      modified_files: context.modifiedFiles,
      risk_level: context.riskLevel,
      mode: 'pipeline' as RunMode,
    };
  }

  // ════════════════════════════════════════════════════════════════
  // 自由裸奔模式
  // ════════════════════════════════════════════════════════════════

  private runFreeMode(context: TriggerContext): FlowResult {
    const runId = `free_${Date.now().toString(36)}`;

    console.log(`[FlowEngine] 🆓 自由裸奔模式: 低风险微小修改，跳过流水线 (${context.modifiedFiles.join(', ')})`);

    return {
      run_id: runId,
      success: true,
      end_reason: 'free_mode',
      stage_results: [],
    };
  }

  // ════════════════════════════════════════════════════════════════
  // 错误处理
  // ════════════════════════════════════════════════════════════════

  private handleError(err: unknown): FlowResult {
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (err instanceof CircuitBreakerError) {
      console.error(`[FlowEngine] 🔴 熔断: ${errorMsg}`);
      if (this.state) this.state.flow_status = 'aborted';
      if (this.auditLogger) {
        this.auditLogger.logFlowAbort(`熔断: ${errorMsg}`);
      }
      ToolWhitelistGuard.deactivate();
      return this.buildResult(false, 'circuit_breaker');
    }

    console.error(`[FlowEngine] 💥 异常: ${errorMsg}`);
    if (this.state) this.state.flow_status = 'aborted';
    if (this.auditLogger) {
      this.auditLogger.logFlowAbort(errorMsg);
    }

    // P7-B1: 尝试回滚 S3 阶段已修改的文件
    const modifiedFiles = this.state?.modified_files;
    const projectRoot = this.state?.project_root;
    if (modifiedFiles && modifiedFiles.length > 0 && projectRoot) {
      console.error(`[FlowEngine] ↩ 异常恢复: 尝试回滚 ${modifiedFiles.length} 个文件...`);
      for (const f of modifiedFiles) {
        try {
          execSync(`git checkout -- "${f}"`, { cwd: projectRoot, timeout: 5000, stdio: 'pipe' });
          console.error(`[FlowEngine]   ✓ 已回滚: ${f}`);
        } catch (rollbackErr) {
          console.error(`[FlowEngine]   ⚠️ 回滚失败: ${f} — ${(rollbackErr as Error).message}`);
        }
      }
    }

    ToolWhitelistGuard.deactivate();
    return this.buildResult(false, 'error');
  }

  private buildResult(success: boolean, endReason: string): FlowResult {
    const stageResults: StageResult[] = [];
    if (this.state) {
      for (const [, result] of this.state.stage_results) {
        stageResults.push(result);
      }
    }

    return {
      run_id: this.state?.run_id ?? 'unknown',
      success,
      end_reason: endReason,
      stage_results: stageResults,
    };
  }
}

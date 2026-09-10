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
  TerminalEndReason,
  HumanApprovalEvidence,
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
import { createHash } from 'node:crypto';

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
  conditionGateCheck?: (stageId: string, projectRoot: string, modifiedFiles?: string[]) => Promise<{ passed: boolean; reason?: string }>;
}

/** 流水线执行结果 */
export interface FlowResult {
  /** 运行 ID */
  run_id: string;
  /** 流程是否成功完成 */
  success: boolean;
  /** 终止原因（机器可区分，见 types.ts TerminalEndReason） */
  end_reason: TerminalEndReason;
  /** H0: 流水线终态（completed / aborted / free_mode）——由 state 派生，与 success/end_reason 机械一致 */
  flow_status?: FlowStatus;
  /** H-02/H-01(enhance-v1): 扩展运行状态——completed | aborted | await_manual_verification | archive_invalid（扩展枚举，不改旧语义） */
  run_status?: 'completed' | 'aborted' | 'await_manual_verification' | 'archive_invalid';
  /** H0: 运行模式（pipeline / free）——供 token 签发 policy 校验 mode=pipeline */
  mode?: RunMode;
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

/** H1: SHA-256 摘要（审计记录用——存哈希不存原文，防止敏感方案全文进入审计卷宗） */
function createHash256(s: string): string {
  return createHash('sha256').update(s ?? '').digest('hex');
}

export class FlowEngine {
  private readonly gateController: GateController;
  private readonly stageRunner: StageRunner;
  private memoStore: GlobalMemoStore | null = null;
  private auditLogger: AuditLogger | null = null;
  private config: FlowConfig | null = null;
  private state: FlowRunState | null = null;
  private _aborted = false;
  private _paused = false;
  /** H0: 首个真实终止原因（幂等，不可被后续覆盖） */
  private _endReason: TerminalEndReason | null = null;
  /** H0: 终态审计事件是否已写入（每 run 仅一个 flow_complete 或 flow_abort） */
  private _terminalLogged = false;
  /** H1: 本次 run 的 S2 审批证据（start 时从 context 捕获，S2 注入 human_report/global memo） */
  private _s2Evidence: HumanApprovalEvidence | null = null;
  /** H-02(enhance-v1): S6-B 人工验收悬挂——非空时为变更指纹，run_status 派生为 await_manual_verification */
  private _awaitManualTicketKey: string | null = null;
  /** H-01(enhance-v1): S7-B 归档校验失败过——终局若为 abort，run_status 派生为 archive_invalid（优先于 aborted） */
  private _archiveInvalid = false;

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

    // H1: 捕获 S2 审批证据（类字段 + state 供 S4 review 匹配 confirmations）
    this._s2Evidence = context.s2_evidence || null;
    if (this.state) this.state.s2_evidence = context.s2_evidence;

    // 4. 初始化审计日志
    this.auditLogger = new AuditLogger(runId, this.config.flow_id);
    this.auditLogger.logFlowStart({
      flow_name: this.config.flow_name,
      risk_level: context.riskLevel,
      modified_files: context.modifiedFiles,
      skip_s3_compile: context.skip_s3_compile === true,
    });
    // H0: start 前 abort（auditLogger 未初始化时 abort() 无法写终态审计）→ 初始化后补记
    if (this._endReason && !this._terminalLogged) {
      this._terminalLogged = true;
      if (this.state) this.state.flow_status = 'aborted';
      const text = this._endReason === 'user_abort' ? '用户主动中止' : String(this._endReason);
      this.auditLogger.logFlowAbort(text);
    }

    console.log(`\n[FlowEngine] 🚀 流水线启动: ${this.config.flow_name} (${runId})`);
    console.log(`[FlowEngine]    风险: ${context.riskLevel} | 文件: ${context.modifiedFiles.join(', ')}`);

    // 5. 进入第一个 Stage
    try {
      const firstStage = this.config.stages[0].stage_id;
      await this.transitionTo(firstStage);
      // H0: 由内部 state 派生终态，禁止双写——state=aborted 不可能被包装成 success=true
      return this.deriveFinalResult();
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

  /** 中止流水线（幂等：终态已定即不可逆；completed 后调用不翻转、不追加审计） */
  abort(): void {
    if (this._terminalLogged) return; // H0: 首个终态一旦确定，后续调用不得修改
    this._aborted = true;
    this._paused = false;
    if (!this._endReason) {
      this.recordAbort('user_abort', '用户主动中止');
    }
    ToolWhitelistGuard.deactivate();
    console.log(`[FlowEngine] ⏹ 流水线已中止 (${this._endReason})`);
  }

  /**
   * H0: 统一中止记录——幂等写入终态审计。
   * 首个真实原因保留；终态一旦确定即冻结；内部熔断不追加「用户主动中止」。
   */
  private recordAbort(endReason: TerminalEndReason, logText: string): void {
    if (this._terminalLogged) return; // 终态已定（含 completed），不可逆
    if (!this._endReason) this._endReason = endReason; // 首个真实原因不可覆盖
    if (this.state) {
      this.state.flow_status = 'aborted';
      this.state.end_reason = endReason;
    }
    if (this.auditLogger) {
      this._terminalLogged = true;
      this.auditLogger.logFlowAbort(logText);
    }
    // auditLogger 未初始化（start 前 abort）→ 不设 _terminalLogged，由 start 初始化后补记
  }

  /**
   * H0: 统一完成记录——幂等锁定 completed + 唯一 flow_complete。
   * 终态已定时调用不翻转、不追加；start 前 abort 后 _terminalLogged 已置位不会走到此处。
   */
  private recordComplete(): void {
    if (this._terminalLogged) return;
    this._terminalLogged = true;
    this._endReason = 'completed';
    if (this.state) {
      this.state.flow_status = 'completed';
      this.state.end_reason = 'completed';
    }
    if (this.auditLogger) this.auditLogger.logFlowComplete({ total_stages: this.state?.stage_results.size ?? 0 });
  }

  /** H1: 由 S2 审批证据构造 human_report（非秘密，不含密码/token/签名） */
  private buildEvidenceReport(ev: HumanApprovalEvidence): string {
    return [
      '# S2 审批证据',
      `- approval_ref: ${ev.approval_ref}`,
      `- approved_plan: ${ev.approved_plan}`,
      `- change_classification: ${ev.change_classification}`,
      `- global_architecture_decision: ${ev.global_architecture_decision}`,
      `- confirmations: ${(ev.confirmations || []).join(', ') || '(无)'}`,
    ].join('\n');
  }

  /** H1: 缺失 S2 审批证据时的稳定诊断（机器可区分，不泄露任何原文） */
  static evidenceMissingDiagnostic(): string {
    return 'S2_APPROVAL_EVIDENCE_MISSING: 未提供有效审批证据（approval_ref/approved_plan/change_classification/global_architecture_decision 均为空或纯空白）';
  }

  // ════════════════════════════════════════════════════════════════
  // DFA 状态机核心
  // ════════════════════════════════════════════════════════════════

  /**
   * 🔴 确定性跳转——AI 无权限干预。
   * 跳转目标由纯代码逻辑根据 gate_type 和 gate_resolution 计算。
   */
  /** E-02(enhance-v1): 补丁循环历史驳回要点（注入 memo 供 S2 重审，紧凑文本） */
  private buildPatchLoopBrief(fromStage: string): string {
    const lines = ['## 🔴 S3 补丁循环 → 强制架构重审（enhance-v1 E-02）', `触发回流源: ${fromStage}`];
    const hist = this.state?.convergence_history ?? [];
    if (hist.length > 0) {
      lines.push('S4.5 收敛历史: ' + hist.map(h => `r${h.round}=${h.overallScore}%(${h.decision})`).join(' → '));
    }
    const s4 = this.state?.stage_results?.get('S4_Arch_Review');
    const rr = s4?.machine_signal?.reject_reason;
    if (Array.isArray(rr) && rr.length > 0) {
      lines.push('最近 S4 驳回要点:');
      for (const r of rr.slice(0, 12)) lines.push(`  - ${r}`);
    }
    lines.push('→ S2 重审要求：重新输出「补丁 / 架构优化」两套方案并解释连续轮次未达标根因；补丁方案必须登记债务(tech_debt_ledger)；无新 s2_evidence 不放行 S3。');
    return lines.join('\n');
  }

  /** H-04(enhance-v1): 将完整评审证据压缩为紧凑文本并入 memo（机器字段保留，长文本已由 ConvergenceGate 压缩） */
  private injectFullReviewEvidenceToMemo(ev: import('./schemas/full-review-evidence.js').FullReviewEvidence): void {
    if (!this.memoStore || !this.state || !ev) return;
    const lines = ['## 📋 S4.5 完整评审证据（H-04：编码前必读全部明细，勿只看摘要）', `run=${ev.run_id} | round=${ev.convergence_round}`];
    if (ev.ds_score_details.length > 0) {
      lines.push('DS 扣分明细:');
      for (const d of ev.ds_score_details) lines.push(`  - ${d.ds_id} ${d.score_delta}分 | ${d.reason} | 建议: ${d.suggest_fix}`);
    }
    const failCk = (ev.ck_reports ?? []).filter(c => !c.passed);
    if (failCk.length > 0) lines.push('未通过 CK: ' + failCk.map(c => `${c.ck_id}(${(c.violations || []).map(v => v.message).join(';')})`).join(' | '));
    const base = this.memoStore.content || '';
    this.memoStore.save((base ? base + '\n\n' : '') + lines.join('\n'));
    this.state.global_memo = this.memoStore.content ?? '';
  }

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
      this.recordComplete(); // H0: 幂等锁定 completed + 唯一 flow_complete
      ToolWhitelistGuard.deactivate();
      console.log('[FlowEngine] ✅ 流水线完成');
      return;
    }

    // 查找 stage 配置
    const stage = this.config.stages.find(s => s.stage_id === stageId);
    if (!stage) {
      throw new StageExecutionError(stageId, `配置中不存在 stage_id: ${stageId}`);
    }

    // E-02(enhance-v1): S3 补丁循环强制回 S1→S2 后，若 S2 仍携带被 superseded 的旧证据
    // （引擎无运行中重新审批通路）→ 不给"旧证据自动复批→无限循环"留路：可行动终局，要求以新 s2_evidence 重开。
    if (stageId === 'S2_Solution_Design' && this.state.s3_patch_loop && this.state.s2_evidence?.superseded) {
      this.recordAbort('s3_patch_loop',
        'S3 补丁循环已达上限并强制回架构重审，但 S2 仍携带被取代(superseded)的旧审批证据——引擎无运行中重新审批通路。' +
        '请以「新 s2_evidence」重开 harness_run_flow：补丁方案必须绑定 tech_debt_ledger 债务登记，或改用架构重构方案。全部历史驳回证据已保留在本次 run 卷宗。');
      ToolWhitelistGuard.deactivate();
      console.error('[FlowEngine] ⏹ S3 补丁循环终局 (s3_patch_loop): 需新 s2_evidence 重开');
      return;
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
      // 🔴 P9-fix: 把 S4.5 收敛分数（compliance_score）也写入审计，使分数可观察
      // 原来只记 resolution（passed/rejected），分数只在进程日志，用户/看板看不到
      const gateDetail = (result.machine_signal?.metrics || {}) as Record<string, unknown>;
      // P3-fix: gate_resolve 审计附加 reject_reason 明细（前 8 条）——此前只落分数/轮次，
      // 事后无法追溯“为何拒”（本会话 P0/P3 报告实证）。reject_reason 即 gap 标准摘要串。
      const rejectReasons = (result.machine_signal as { reject_reason?: unknown })?.reject_reason;
      if (Array.isArray(rejectReasons) && rejectReasons.length > 0) {
        (gateDetail as Record<string, unknown>).reject_reason = rejectReasons.slice(0, 8);
      }
      // H1: S2 审批成功时附加 evidence 摘要（非秘密；approved_plan 仅存 SHA-256，不泄露原文全文）
      if (stage.gate_type === 'human' && resolution === 'human_approved' && this._s2Evidence) {
        const ev = this._s2Evidence;
        (gateDetail as Record<string, unknown>).s2_evidence_status = 'provided';
        (gateDetail as Record<string, unknown>).approval_ref = ev.approval_ref;
        (gateDetail as Record<string, unknown>).change_classification = ev.change_classification;
        (gateDetail as Record<string, unknown>).global_architecture_decision_sha256 = createHash256(ev.global_architecture_decision);
        (gateDetail as Record<string, unknown>).approved_plan_sha256 = createHash256(ev.approved_plan);
        (gateDetail as Record<string, unknown>).confirmations_count = (ev.confirmations || []).length;
      }
      this.auditLogger.logGateResolve(stageId, stage.gate_type, resolution, gateDetail);
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
      // H1: S2 evidence 注入——local human stage 无 human_report 时，用结构化审批证据构造并进入 memo
      const s2Report = result.human_report || (this._s2Evidence ? this.buildEvidenceReport(this._s2Evidence) : '');
      if (this.memoStore && s2Report) {
        this.memoStore.save(s2Report);
        this.state.global_memo = this.memoStore.content;
        if (this.auditLogger) this.auditLogger.logMemoInjected(stageId, this.memoStore.content.length);
        console.log('[FlowEngine] 📌 全局备忘录已注入');
      }
    }

    // 🔴 确定性跳转：纯代码逻辑决定下一 stage
    let nextStage = this.determineNextStage(stage, resolution); // E-02: let —— S3 补丁循环可强制改道 S1

    // 🔴 human gate 超时/驳回 → 直接中止流水线，不进入下一阶段
    if (resolution === 'human_timeout' || resolution === 'human_denied') {
      this.recordAbort(
        resolution === 'human_timeout' ? 'human_timeout' : 'human_denied',
        `human gate ${resolution}: ${stageId}`,
      );
      ToolWhitelistGuard.deactivate();
      console.log(`[FlowEngine] ⏹ human gate ${resolution} → 流水线中止`);
      return;
    }

    // ── H-01/H-02(enhance-v1): S6-B / S7-B 扩展终局语义 ──
    // S6-B 人工验收未完成 → 悬挂终局：不回流 S3、不签发 token。
    // 原因：FlowEngine 无运行中暂停/恢复原语，故落地形态为「悬挂 + 确认后重跑」；
    //   任务单按 change_key（稳定变更指纹）寻址，重跑同一批文件即命中同一张单。
    const _ms = result.machine_signal as { metrics?: { await_manual_verification?: boolean; manual_ticket_key?: string } } | undefined;
    if (stageId.startsWith('S6') && resolution === 'condition_rejected' && _ms?.metrics?.await_manual_verification === true) {
      this._awaitManualTicketKey = _ms.metrics.manual_ticket_key ?? null;
      const key = this._awaitManualTicketKey ?? '(未生成)';
      this.recordAbort('manual_verification_required',
        `S6-B 人工验收未完成（变更指纹 ${key}）→ 悬挂终局，未签发写入令牌。` +
        `请先运行 scripts/harness-manual-confirm.cjs 逐项确认，再以同一批文件重跑 harness_run_flow（change_key 相同 → 命中同一张任务单 → 自动放行 S7）。`);
      ToolWhitelistGuard.deactivate();
      console.error(`[FlowEngine] ⏸ S6-B 悬挂终局 (await_manual_verification): ${key}`);
      return;
    }
    // S7-B 归档校验失败 → 标记 archive_invalid + 运行期信号（随 run 归档）。
    // 回退 S7-A 重试；若最终因回流熔断中止，run_status 暴露为 archive_invalid 而非笼统 aborted。
    if (stageId.startsWith('S7') && resolution === 'condition_rejected') {
      this._archiveInvalid = true;
      this.state.run_signals = this.state.run_signals ?? [];
      this.state.run_signals.push({
        signal: 's7_archive_invalid',
        at: new Date().toISOString(),
        detail: { from: stageId, to: nextStage, reasons: (result.machine_signal?.reject_reason ?? []).slice(0, 3) },
      });
      console.error(`[FlowEngine] 📦 S7-B 归档校验失败 → 回退 ${nextStage} 补全归档产物 (archive_invalid)`);
    }

    // ── P0-A2: 确认阻塞提前终局 ──
    // 内容合规分已达标（≥90，即已够 S4.5 的转交门槛），唯一阻塞是「评审确认未声明」。
    // s2_evidence 在一次 run 内固定不可变 → 回流 S3 修码永远无法消除确认缺失（审计实证：
    // 曾出现 rounds 3–20 逐轮同因空转）。故此处直接终局，让 Agent 携「待声明 key 清单」重开 run。
    // 注意：必须在回流计数自增【之前】判定，否则会先被 s3_retry_count 阈值改道 S1（E-02），
    // 白烧一轮架构重审后才终局。
    const _sig = (result.machine_signal || {}) as {
      metrics?: { unresolved_confirmations?: number; compliance_score?: number };
    };
    if (
      stageId.startsWith('S4.5') &&
      resolution === 'condition_rejected' &&
      (_sig.metrics?.unresolved_confirmations ?? 0) > 0 &&
      (_sig.metrics?.compliance_score ?? 0) >= 90
    ) {
      this.recordAbort(
        'confirmations_pending',
        `S4.5 内容合规分 ${_sig.metrics?.compliance_score}% 已达标，但 ${_sig.metrics?.unresolved_confirmations} 项评审确认未声明` +
        `（s2_evidence 在一次 run 内固定，回流 S3 无效）——请重开 harness_run_flow，在 s2_evidence.confirmations 声明对应 key 后继续；` +
        `完整待声明清单见本次 run 的 S4.5 human_report。`,
      );
      ToolWhitelistGuard.deactivate();
      console.error(`[FlowEngine] ⏹ 确认阻塞提前终局 (confirmations_pending): ${_sig.metrics?.unresolved_confirmations} 项确认未声明`);
      return;
    }

    // 🔴 回流计数器：检测是否回到 S3 或更高序号回退
    if (this.isStageRegression(stageId, nextStage)) {
      // S3 专属计数（S4/S5/S6 驳回→S3）
      if (nextStage.startsWith('S3')) {
        this.state.s3_retry_count++;
        const maxS3 = this.config?.max_s3_retries ?? 3;
        if (this.state.s3_retry_count >= maxS3) {
          // E-02(enhance-v1): 不再直接锁死——达 max_s3_retries 轮编码未达标即强制回 S1→S2 架构重审。
          // 旧 s2_evidence 标记 superseded（保留审计溯源）；机器信号入 state.run_signals（随 run 归档）；
          // 计数器归零以开启新 S2 审批周期；历史驳回要点写入 memo 供 S2 重审读取。
          //
          // 🔴 E-02-hardstop: 计数器归零使「S3 熔断」永不可达 → 必须自带上界，否则当 S2 可被
          // 自动放行（autoApproveHumanGate / 无证据守卫未命中）时会 S1→S2→S3→S4→S4.5→S1 无限循环。
          // 语义：强制回架构重审只给一次机会；第二次仍达上限 → 自动修复不可达，终局要求人工介入。
          const priorPatchLoops = (this.state.run_signals ?? []).filter(s => s.signal === 's3_stuck_in_patch_loop').length;
          if (priorPatchLoops >= 1) {
            this.recordAbort('s3_patch_loop',
              `S3 补丁循环已强制回架构重审 ${priorPatchLoops} 次，编码仍达 ${maxS3} 轮未达标 → 自动修复不可达，终局。` +
              '请人工介入：收敛问题定义与方案（可用 harness-manual-confirm.cjs 记录人工验收结论），或缩小改动范围后重开 run。');
            ToolWhitelistGuard.deactivate();
            console.error(`[FlowEngine] ⏹ S3 补丁循环硬止 (s3_patch_loop): 已重审 ${priorPatchLoops} 次仍未达标 → 终局`);
            return;
          }
          const at = new Date().toISOString();
          this.state.s3_retry_count = 0;
          this.state.s3_patch_loop = true;
          this.state.run_signals = this.state.run_signals ?? [];
          this.state.run_signals.push({ signal: 's3_stuck_in_patch_loop', at, detail: { from: stageId, limit: maxS3 } });
          if (this.state.s2_evidence) { this.state.s2_evidence.superseded = true; this.state.s2_evidence.superseded_at = at; }
          if (this._s2Evidence) { this._s2Evidence.superseded = true; this._s2Evidence.superseded_at = at; }
          const brief = this.buildPatchLoopBrief(stageId);
          if (this.memoStore && brief) { this.memoStore.save(brief); this.state.global_memo = this.memoStore.content; }
          console.error(`[FlowEngine] 🔴 S3 补丁循环: ${stageId}→S3 达 ${maxS3} 轮未达标 → WARN: 强制回退架构重审 S1→S2（旧 s2_evidence 已 superseded，需新方案）`);
          nextStage = 'S1_Problem_Analysis'; // DFA 强制跳回架构预分析（S1 auto → S2 human）
        } else {
          console.log(`[FlowEngine] 🔄 S3 驳回回流 #${this.state.s3_retry_count}/${maxS3}: ${stageId}→${nextStage}`);
        }
      } else {
        // 通用回流计数器（非 S3 驳回）
        this.state.stage_retry_count++;
        const maxRetries = this.config?.max_stage_retries ?? 5;
        if (this.state.stage_retry_count > maxRetries) {
          console.error(`[FlowEngine] 🔴 回流熔断: ${stageId}→${nextStage} 已达上限 ${maxRetries} 次`);
          this.recordAbort('retry_limit', `重试次数 ${this.state.stage_retry_count}/${maxRetries} 超限，强制锁定`);
          ToolWhitelistGuard.deactivate();
          return;
        }
        console.log(`[FlowEngine] 🔄 回流 #${this.state.stage_retry_count}/${maxRetries}: ${stageId}→${nextStage}`);
      }
    }

    // H-04(enhance-v1): S4.5 驳回回流 S3 前，把完整评审证据(full_review_evidence)注入 memo——下游编码不再只见摘要
    if (stageId.startsWith('S4.5') && resolution === 'condition_rejected' && nextStage.startsWith('S3')) {
      const ev = (result.machine_signal as { full_review_evidence?: import('./schemas/full-review-evidence.js').FullReviewEvidence })?.full_review_evidence;
      if (ev) this.injectFullReviewEvidenceToMemo(ev);
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
      flow_status: 'completed',
      mode: 'free',
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
      this.recordAbort('circuit_breaker', `熔断: ${errorMsg}`);
      ToolWhitelistGuard.deactivate();
      return this.buildResult(false, 'circuit_breaker');
    }

    console.error(`[FlowEngine] 💥 异常: ${errorMsg}`);
    this.recordAbort('stage_error', errorMsg);

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
    return this.buildResult(false, 'stage_error');
  }

  private buildResult(success: boolean, endReason: TerminalEndReason): FlowResult {
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
      flow_status: this.state?.flow_status,
      run_status: this.deriveRunStatus(endReason),
      mode: this.state?.mode ?? 'pipeline',
      stage_results: stageResults,
    };
  }

  /**
   * H-02/H-01(enhance-v1): run_status 派生（单一真值源，优先级从高到低）。
   * await_manual_verification（S6-B 悬挂）> completed > archive_invalid（S7-B 校验失败终局）> aborted。
   * 旧行为不变：非以上情形一律 aborted/completed（老 run 无 S6-B/S7-B 自然落回旧语义）。
   */
  private deriveRunStatus(endReason: TerminalEndReason): 'completed' | 'aborted' | 'await_manual_verification' | 'archive_invalid' {
    if (this._awaitManualTicketKey) return 'await_manual_verification';
    if (endReason === 'completed') return 'completed';
    if (this._archiveInvalid) return 'archive_invalid';
    return 'aborted';
  }

  /**
   * H0: 由内部 state 派生终态结果——单一真值源，消除 success/endReason 双写。
   * completed 终态优先（recordComplete 锁定）；存在 abort 终止原因 → abort 终态；
   * running（异常泄漏）→ fail-closed。
   */
  private deriveFinalResult(): FlowResult {
    const st = this.state;
    if (st?.flow_status === 'completed' || this._endReason === 'completed') {
      if (st) st.flow_status = 'completed';
      return this.buildResult(true, 'completed');
    }
    if (this._aborted || this._endReason) {
      if (st) st.flow_status = 'aborted';
      return this.buildResult(false, this._endReason || 'stage_error');
    }
    if (!st) return this.buildResult(false, 'stage_error');
    if (st.flow_status === 'aborted') return this.buildResult(false, this._endReason || 'stage_error');
    // running（异常泄漏）→ fail-closed
    return this.buildResult(false, 'stage_error');
  }
}

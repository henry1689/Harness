/**
 * GateController — 三门控控制器
 * =================================
 * 实现 auto（自动放行）/ human（人工审批）/ condition（条件判定）三类门控。
 *
 * 核心设计：
 *   - auto: 无条件直接放行
 *   - human: 暂停流水线，通过 callback 通知外部等待人工确认
 *   - condition: 基于 machine_signal.passed 判定通过/驳回
 *
 * AI 输出文本无法干预跳转——跳转目标由 FlowEngine.determineNextStage() 纯代码决定。
 */

import type { StageConfig, StageResult, GateResolution, MachineSignal } from './types.js';

/** 人工审批的回调函数签名：接收审批请求，返回用户决议 */
export type HumanGateCallback = (stage: StageConfig, stageResult: StageResult) => Promise<'approved' | 'denied' | 'timeout'>;

/** GateController 配置选项 */
export interface GateControllerOptions {
  /** 人工审批超时时间（毫秒），默认 300000（5分钟） */
  humanTimeoutMs?: number;
  /** 人工审批回调（必须提供，否则 human gate 默认 timeout） */
  onHumanGate?: HumanGateCallback;
}

export class GateController {
  private readonly humanTimeoutMs: number;
  private readonly onHumanGate: HumanGateCallback | null;

  constructor(options: GateControllerOptions = {}) {
    this.humanTimeoutMs = options.humanTimeoutMs ?? 300_000; // 5分钟
    this.onHumanGate = options.onHumanGate ?? null;
  }

  /**
   * 解析门控——根据 stage 的 gate_type 和 stage 执行结果，返回统一的 GateResolution。
   *
   * @param stage — 当前 stage 配置
   * @param result — stage 执行结果（condition gate 必须含 machine_signal）
   * @returns 门控决议
   */
  async resolve(stage: StageConfig, result: StageResult): Promise<GateResolution> {
    switch (stage.gate_type) {
      case 'auto':
        return this.resolveAuto();

      case 'human':
        return this.resolveHuman(stage, result);

      case 'condition':
        return this.resolveCondition(stage, result);

      default:
        throw new Error(`[GateController] 未知的 gate_type: ${stage.gate_type}`);
    }
  }

  /** 设置人工审批回调（运行时动态注入） */
  setHumanGateCallback(cb: HumanGateCallback): void {
    (this as unknown as { onHumanGate: HumanGateCallback }).onHumanGate = cb;
  }

  // ════════════════════════════════════════════════════════════════
  // 内部实现
  // ════════════════════════════════════════════════════════════════

  /** auto: 无条件放行 */
  private resolveAuto(): GateResolution {
    return 'auto_passed';
  }

  /** human: 等待人工审批 */
  private async resolveHuman(stage: StageConfig, result: StageResult): Promise<GateResolution> {
    if (!this.onHumanGate) {
      console.warn(`[GateController] human gate 无回调注册，默认超时 (stage: ${stage.stage_id})`);
      return 'human_timeout';
    }

    try {
      const userDecision = await this.withTimeout(
        this.onHumanGate(stage, result),
        this.humanTimeoutMs,
      );

      switch (userDecision) {
        case 'approved': return 'human_approved';
        case 'denied': return 'human_denied';
        case 'timeout': return 'human_timeout';
        default: return 'human_timeout';
      }
    } catch (err) {
      console.error(`[GateController] human gate 回调异常 (stage: ${stage.stage_id}):`, (err as Error).message);
      return 'human_timeout';
    }
  }

  /** condition: 基于 machine_signal 判定 */
  private resolveCondition(stage: StageConfig, result: StageResult): GateResolution {
    if (!result.machine_signal) {
      throw new Error(
        `[GateController] condition gate "${stage.stage_id}" 要求 machine_signal，但未收到。` +
        `请确保 delegate runner 正确输出了双通道信号。`,
      );
    }

    const signal: MachineSignal = result.machine_signal;

    if (signal.passed) {
      console.log(`[GateController] ✅ condition_passed (${stage.stage_id})`);
      return 'condition_passed';
    }

    const reasons = signal.reject_reason.length > 0
      ? signal.reject_reason.join('; ')
      : '未提供具体原因';
    console.warn(`[GateController] ❌ condition_rejected (${stage.stage_id}): ${reasons}`);
    return 'condition_rejected';
  }

  /** 带超时的 Promise 包装 */
  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    });

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

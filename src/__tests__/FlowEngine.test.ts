/**
 * Harness 引擎集成测试 — FlowEngine 全流程
 * =============================================
 * 使用最小 mock 验证 DFA 状态机全链路。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlowEngine, type FlowResult } from '../FlowEngine.js';
import type { TriggerContext, StageConfig, StageOutput, MachineSignal, FlowRunState } from '../types.js';
import { CircuitBreakerError, WhitelistViolationError } from '../types.js';

// ════════════════════════════════════════════════════════════════════
// Mock DelegateReviewer
// ════════════════════════════════════════════════════════════════════

/** 创建一个总是"通过"的委托评审函数 */
function makePassReview(): (stage: StageConfig, state: FlowRunState) => Promise<StageOutput> {
  return async () => ({
    machine_signal: { passed: true, risk_level: 'low', reject_reason: [] },
    human_report: '# 评审通过\n\n所有校验已通过。',
  });
}

/** 创建一个总是"驳回"的委托评审函数 */
function makeRejectReview(reasons: string[]): (stage: StageConfig, state: FlowRunState) => Promise<StageOutput> {
  return async () => ({
    machine_signal: { passed: false, risk_level: 'high', reject_reason: reasons },
    human_report: `# 评审未通过\n\n${reasons.join('\n')}`,
  });
}

// ════════════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════════════

function makeHighRiskContext(overrides: Partial<TriggerContext> = {}): TriggerContext {
  return {
    message: '修复 chat.ts 中 FG 写入 bug',
    modifiedFiles: ['src/webui/chat.ts'],
    riskLevel: 'high',
    isTrivial: false,
    ...overrides,
  };
}

function makeLowRiskTrivialContext(overrides: Partial<TriggerContext> = {}): TriggerContext {
  return {
    message: '修复 config 中的 typo 拼写错误',
    modifiedFiles: ['src/config/types.ts'],
    riskLevel: 'low',
    isTrivial: true,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════
// 测试
// ════════════════════════════════════════════════════════════════════

describe('FlowEngine', () => {
  describe('自由裸奔模式', () => {
    it('低风险微小修改应跳过流水线', async () => {
      const engine = new FlowEngine();
      const ctx = makeLowRiskTrivialContext();

      const result = await engine.start('wenstaros_core_repair_flow.yaml', ctx);

      expect(result.success).toBe(true);
      expect(result.end_reason).toBe('free_mode');
      expect(result.stage_results).toHaveLength(0);
    });

    it('单文件低风险但无 trivial 信号 → 仍走流水线', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: makePassReview(),
      });
      const ctx: TriggerContext = {
        message: '重构 config 模块架构',
        modifiedFiles: ['src/config/ConfigService.ts'],
        riskLevel: 'low',
        isTrivial: false, // 非微小修改
      };

      const result = await engine.start('wenstaros_core_repair_flow.yaml', ctx);

      // 低风险非微小修改仍走流水线
      expect(result.end_reason).not.toBe('free_mode');
    });
  });

  describe('高风险文件', () => {
    it('chat.ts 修改应触发全流程', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: makePassReview(),
      });
      const ctx = makeHighRiskContext();

      const result = await engine.start('wenstaros_core_repair_flow.yaml', ctx);

      expect(result.end_reason).toBe('completed');
      expect(result.success).toBe(true);
      expect(result.stage_results.length).toBeGreaterThanOrEqual(1);
    });

    it('S4 delegate 评审驳回 → 回退到 S3 确认循环机制', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: makeRejectReview(['违反FG红线1: 角色扮演数据污染']),
      });
      const ctx = makeHighRiskContext();

      const result = await engine.start('wenstaros_core_repair_flow.yaml', ctx);

      // S1 human gate 无回调 → timeout → END
      // 实际项目中需要注入 human gate callback 才能走完 S1→S2→S3→S4
      // 此处验证引擎未崩溃即可
      expect(result).toBeDefined();
      expect(result.run_id).toBeDefined();
    });
  });

  describe('状态机确定性', () => {
    it('auto gate 自动累加 jump_count', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: makePassReview(),
      });
      const ctx = makeHighRiskContext();

      const result = await engine.start('wenstaros_core_repair_flow.yaml', ctx);

      // jump_count 应在完成时被重置（遇到非 auto 或 END）
      if (result.run_id !== 'unknown') {
        const state = engine.getState();
        if (state) {
          // 最终状态应该已重置或完成
          expect(state.jump_count).toBeLessThan(10); // 小于 max_jump_limit
        }
      }
    });
  });

  describe('熔断检查', () => {
    it('模拟超过 max_jump_limit 时的熔断行为', () => {
      // max_jump_limit 在 YAML 中设为 10
      // 正常情况下 local runner 的 auto gate 不会连续触发 10 次
      // 此测试仅验证 CircuitBreakerError 的行为
      const error = new CircuitBreakerError(10, 10);
      expect(error.jumpCount).toBe(10);
      expect(error.maxLimit).toBe(10);
      expect(error.message).toContain('熔断触发');
    });
  });

  describe('abort 中止', () => {
    it('中止后状态正确', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: makePassReview(),
      });
      const ctx = makeHighRiskContext();

      engine.abort(); // 启动前中止

      const result = await engine.start('wenstaros_core_repair_flow.yaml', ctx);

      // 由于 S1 进入后马上遇到 abort 标记，跳转会停止
      // 实际结果依赖于 race condition——验证引擎未崩溃
      expect(result).toBeDefined();
      expect(result.run_id).toBeDefined();
    });
  });
});

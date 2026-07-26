/**
 * Harness 引擎单元测试 — GateController
 * =========================================
 */

import { describe, it, expect, vi } from 'vitest';
import { GateController, type HumanGateCallback } from '../GateController.js';
import type { StageConfig, StageResult, GateResolution } from '../types.js';

/** 创建一个最小的 StageConfig 用于测试 */
function makeStage(overrides: Partial<StageConfig> = {}): StageConfig {
  return {
    stage_id: 'S_test',
    stage_name: '测试阶段',
    work_manual: '测试工作手册',
    tool_whitelist: { read_file: true },
    gate_type: 'auto',
    runner_mode: 'local',
    ...overrides,
  };
}

/** 创建一个最小但有 machine_signal 的 StageResult */
function makeResult(overrides: Partial<StageResult> = {}): StageResult {
  return {
    stage_id: 'S_test',
    status: 'completed',
    gate_type: 'auto',
    gate_resolution: 'auto_passed',
    audit_entries: [],
    started_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('GateController', () => {
  describe('auto gate', () => {
    it('直接返回 auto_passed', async () => {
      const controller = new GateController();
      const stage = makeStage({ gate_type: 'auto' });
      const result = makeResult();

      const resolution = await controller.resolve(stage, result);
      expect(resolution).toBe('auto_passed');
    });
  });

  describe('condition gate', () => {
    it('machine_signal.passed=true → condition_passed', async () => {
      const controller = new GateController();
      const stage = makeStage({
        gate_type: 'condition',
        next_stage_pass: 'S_next',
        next_stage_reject: 'S_back',
      });
      const result = makeResult({
        machine_signal: { passed: true, risk_level: 'low', reject_reason: [] },
      });

      const resolution = await controller.resolve(stage, result);
      expect(resolution).toBe('condition_passed');
    });

    it('machine_signal.passed=false → condition_rejected', async () => {
      const controller = new GateController();
      const stage = makeStage({
        gate_type: 'condition',
        next_stage_pass: 'S_next',
        next_stage_reject: 'S_back',
      });
      const result = makeResult({
        machine_signal: { passed: false, risk_level: 'high', reject_reason: ['违反FG红线1'] },
      });

      const resolution = await controller.resolve(stage, result);
      expect(resolution).toBe('condition_rejected');
    });

    it('缺少 machine_signal 时抛出异常', async () => {
      const controller = new GateController();
      const stage = makeStage({ gate_type: 'condition' });
      const result = makeResult({ machine_signal: undefined });

      await expect(controller.resolve(stage, result)).rejects.toThrow('machine_signal');
    });
  });

  describe('human gate', () => {
    it('有回调且用户批准 → human_approved', async () => {
      const onHumanGate: HumanGateCallback = vi.fn().mockResolvedValue('approved');
      const controller = new GateController({ onHumanGate });
      const stage = makeStage({ gate_type: 'human' });
      const result = makeResult();

      const resolution = await controller.resolve(stage, result);
      expect(resolution).toBe('human_approved');
      expect(onHumanGate).toHaveBeenCalledTimes(1);
    });

    it('有回调且用户拒绝 → human_denied', async () => {
      const onHumanGate: HumanGateCallback = vi.fn().mockResolvedValue('denied');
      const controller = new GateController({ onHumanGate });
      const stage = makeStage({ gate_type: 'human' });
      const result = makeResult();

      const resolution = await controller.resolve(stage, result);
      expect(resolution).toBe('human_denied');
    });

    it('无回调 → 默认超时', async () => {
      const controller = new GateController(); // 未提供 onHumanGate
      const stage = makeStage({ gate_type: 'human' });
      const result = makeResult();

      // 跳过实际等待，因为无回调直接返回 timeout
      const resolution = await controller.resolve(stage, result);
      expect(resolution).toBe('human_timeout');
    });
  });
});

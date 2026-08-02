/**
 * Harness 引擎集成测试 — StageRunner
 * =======================================
 */

import { describe, it, expect } from 'vitest';
import { StageRunner } from '../StageRunner.js';
import type { StageConfig, FlowRunState } from '../types.js';
import { ToolWhitelistGuard } from '../ToolWhitelistGuard.js';

/** 最小 StageConfig */
function makeStage(overrides: Partial<StageConfig> = {}): StageConfig {
  return {
    stage_id: 'S_test',
    stage_name: '测试阶段',
    work_manual: '测试工作手册',
    tool_whitelist: { read_file: true, write_file: true, run_command: true },
    gate_type: 'auto',
    runner_mode: 'local',
    ...overrides,
  };
}

/** 最小 FlowRunState */
function makeState(overrides: Partial<FlowRunState> = {}): FlowRunState {
  return {
    run_id: 'test_run_1',
    flow_id: 'test_flow',
    flow_status: 'running',
    current_stage: 'S_test',
    jump_count: 0,
    stage_retry_count: 0,
    s3_retry_count: 0,
    convergence_round: 0,
    convergence_history: [],
    stage_results: new Map(),
    global_memo: '',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    modified_files: ['src/config/ConfigService.ts'],
    risk_level: 'low',
    mode: 'pipeline',
    ...overrides,
  };
}

describe('StageRunner', () => {
  describe('local runner', () => {
    it('执行 local stage 并返回结果', async () => {
      const runner = new StageRunner();
      const stage = makeStage({ runner_mode: 'local' });
      const state = makeState();

      const result = await runner.execute(stage, state);

      expect(result.status).toBe('completed');
      expect(result.stage_id).toBe('S_test');
      expect(result.audit_entries.length).toBeGreaterThanOrEqual(2); // stage_enter + stage_exit
    });

    it('local runner 的 readFile 受白名单保护', () => {
      ToolWhitelistGuard.activate({ read_file: true }, 'S_test');
      const runner = new StageRunner();

      // 读取实际存在的文件
      const file = runner.readFile('package.json', 'S_test');
      expect(file.path).toBe('package.json');
      expect(file.lines).toBeGreaterThan(0);
      expect(file.content.length).toBeGreaterThan(0);

      ToolWhitelistGuard.deactivate();
    });

    it('白名单 getStats 正确记录', () => {
      ToolWhitelistGuard.activate({ read_file: true, write_file: false }, 'S_test');

      const stats = ToolWhitelistGuard.getStats();
      expect(stats.stageId).toBe('S_test');
      expect(stats.allowed).toBe(0);
      expect(stats.blocked).toBe(0);

      ToolWhitelistGuard.deactivate();
    });
  });

  describe('delegate runner', () => {
    it('委托评审函数被调用', async () => {
      let called = false;
      const runner = new StageRunner({
        delegateReviewFn: async () => {
          called = true;
          return {
            machine_signal: { passed: true, risk_level: 'low', reject_reason: [] },
            human_report: '评审通过',
          };
        },
      });

      const stage = makeStage({ runner_mode: 'delegate', gate_type: 'condition' });
      const state = makeState();

      const result = await runner.execute(stage, state);

      expect(called).toBe(true);
      expect(result.status).toBe('completed');
      expect(result.machine_signal).toBeDefined();
      expect(result.machine_signal!.passed).toBe(true);
      expect(result.human_report).toBe('评审通过');
    });

    it('delegate 无评审函数时抛出异常', async () => {
      const runner = new StageRunner(); // 未注入 delegateReviewFn
      const stage = makeStage({ runner_mode: 'delegate' });
      const state = makeState();

      const result = await runner.execute(stage, state);

      expect(result.status).toBe('rejected');
      expect(result.error).toContain('delegateReviewFn');
    });
  });

  describe('runCommand', () => {
    it('执行简单命令并返回结果', () => {
      ToolWhitelistGuard.activate({ run_command: true }, 'S_test');
      const runner = new StageRunner();

      const result = runner.runCommand('echo hello', 'S_test');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello');

      ToolWhitelistGuard.deactivate();
    });
  });
});

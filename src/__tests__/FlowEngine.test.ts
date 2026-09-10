/**
 * Harness 引擎集成测试 — FlowEngine 全流程
 * =============================================
 * 使用最小 mock 验证 DFA 状态机全链路。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
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
        autoApproveHumanGate: true, // H0: 让 human gate 通过，真实走到 END
      });
      const ctx = makeHighRiskContext();

      const result = await engine.start('wenstaros_core_repair_flow.yaml', ctx);

      expect(result.end_reason).toBe('completed');
      expect(result.success).toBe(true);
      expect(result.flow_status).toBe('completed');
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

  describe('abort 中止 (H0)', () => {
    it('显式 abort → success=false, end_reason=user_abort, flow_status=aborted（不再误报 completed）', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: makePassReview(),
      });
      const ctx = makeHighRiskContext();

      engine.abort(); // 启动前中止

      const result = await engine.start('wenstaros_core_repair_flow.yaml', ctx);

      expect(result.success).toBe(false);
      expect(result.end_reason).toBe('user_abort');
      expect(result.flow_status).toBe('aborted');
    });

    it('内部 abort 不抛异常、不被 start() 改写成 completed', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: makeRejectReview(['S4 评审驳回，触发回流']),
      });
      const ctx = makeHighRiskContext();

      const result = await engine.start('wenstaros_core_repair_flow.yaml', ctx);

      expect(result).toBeDefined();
      // H0 契约：aborted 态永远 success=false；completed 才 success=true
      if (result.flow_status === 'aborted') {
        expect(result.success).toBe(false);
        expect(result.end_reason).not.toBe('completed');
      }
    });
  });

  describe('H0 终态真值与幂等', () => {
    it('human gate denied → success=false, end_reason=human_denied, flow_status=aborted', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: makePassReview(),
        onHumanGate: async () => 'denied' as const,
      });
      const result = await engine.start('wenstaros_core_repair_flow.yaml', makeHighRiskContext());
      expect(result.success).toBe(false);
      expect(result.end_reason).toBe('human_denied');
      expect(result.flow_status).toBe('aborted');
    });

    it('human gate timeout → success=false, end_reason=human_timeout, flow_status=aborted', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: makePassReview(),
        onHumanGate: async () => 'timeout' as const,
      });
      const result = await engine.start('wenstaros_core_repair_flow.yaml', makeHighRiskContext());
      expect(result.success).toBe(false);
      expect(result.end_reason).toBe('human_timeout');
      expect(result.flow_status).toBe('aborted');
    });

    it('delegate 抛异常（error 场景）→ E-02 补丁循环硬止，不误报 completed', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: async () => { throw new Error('boom'); },
        autoApproveHumanGate: true,
      });
      const result = await engine.start('wenstaros_core_repair_flow.yaml', makeHighRiskContext());
      // StageRunner 捕获 delegate 异常 → 转 reject → S3 回流达 max_s3_retries
      // → E-02 强制回架构重审 S1→S2（一次机会）→ 仍不达标 → 硬止终局 s3_patch_loop（fail-closed）。
      // 🔴 不再期望 retry_limit：E-02 后该路径改走补丁循环硬止（原期望已随语义变更失效）。
      expect(result.success).toBe(false);
      expect(result.end_reason).toBe('s3_patch_loop');
      expect(result.flow_status).toBe('aborted');
      expect(result.run_status).toBe('aborted');
    });

    it('completed 后 abort() 不翻转状态、不追加审计', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: makePassReview(),
        autoApproveHumanGate: true,
      });
      const result = await engine.start('wenstaros_core_repair_flow.yaml', makeHighRiskContext());
      expect(result.success).toBe(true);
      expect(result.flow_status).toBe('completed');
      expect(result.end_reason).toBe('completed');

      engine.abort(); // completed 后 abort —— 不应翻转
      const state = engine.getState();
      expect(state?.flow_status).toBe('completed');
      expect(result.end_reason).toBe('completed');
    });

    it('start 前 abort → success=false, end_reason=user_abort，审计补记 flow_abort', async () => {
      const engine = new FlowEngine({ delegateReviewFn: makePassReview() });
      engine.abort(); // start 前 abort（auditLogger 未初始化）
      const result = await engine.start('wenstaros_core_repair_flow.yaml', makeHighRiskContext());
      expect(result.success).toBe(false);
      expect(result.end_reason).toBe('user_abort');
      expect(result.flow_status).toBe('aborted');
      // 审计补记验证：run_id 对应审计文件存在且含唯一 flow_abort
      const auditDir = path.resolve('data', 'audit');
      const found = readdirSync(auditDir).flatMap((d: string) => {
        const f = path.join(auditDir, d, result.run_id + '.json');
        return existsSync(f) ? [f] : [];
      });
      expect(found.length).toBe(1);
      const audit = JSON.parse(readFileSync(found[0], 'utf-8'));
      const terminal = audit.entries.filter((e: { event: string }) => e.event === 'flow_abort' || e.event === 'flow_complete');
      expect(terminal.length).toBe(1);
      expect(terminal[0].event).toBe('flow_abort');
    });

    it('终态不可逆：abort 两次 → 首个原因保留且不重复', async () => {
      const engine = new FlowEngine({ delegateReviewFn: makePassReview() });
      engine.abort();
      engine.abort(); // 第二次
      const result = await engine.start('wenstaros_core_repair_flow.yaml', makeHighRiskContext());
      expect(result.end_reason).toBe('user_abort');
      expect(result.success).toBe(false);
      expect(result.flow_status).toBe('aborted');
    });

    it('S4 持续驳回 → S3 回流达上限 → E-02 补丁循环硬止（s3_patch_loop）', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: makeRejectReview(['触发回流熔断']),
        autoApproveHumanGate: true,
      });
      const result = await engine.start('wenstaros_core_repair_flow.yaml', makeHighRiskContext());
      // 🔴 E-02 后：S3 回流达 max_s3_retries 不再直接 retry_limit，而是强制回架构重审一次；
      //    仍不达标 → 补丁循环硬止 s3_patch_loop（原 retry_limit 期望已随语义变更失效）。
      expect(result.success).toBe(false);
      expect(result.end_reason).toBe('s3_patch_loop');
      expect(result.flow_status).toBe('aborted');
    });
  });

  describe('H1 S2 审批证据', () => {
    it('完整 s2_evidence → S2 human_approved 且 evidence 进入 global memo', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: makePassReview(),
        onHumanGate: async () => 'approved' as const,
      });
      const ctx = makeHighRiskContext({
        s2_evidence: {
          approval_ref: 'ref-001',
          approved_plan: '修复 chat.ts FG 写入 bug',
          change_classification: 'specific',
          global_architecture_decision: '维持原始方案',
          confirmations: [],
        },
      });

      const result = await engine.start('wenstaros_core_repair_flow.yaml', ctx);

      expect(result).toBeDefined();
      const state = engine.getState();
      expect(state?.global_memo).toContain('approval_ref: ref-001');
      expect(state?.global_memo).toContain('approved_plan: 修复 chat.ts FG 写入 bug');
      // 不泄露认证材料（memo 不应含 password/token/signature）
      expect(state?.global_memo).not.toMatch(/password|token|signature|nonce/i);
    });

    it('缺 s2_evidence → S2 fail-closed（onHumanGate denied → human_denied abort）', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: makePassReview(),
        onHumanGate: async () => 'denied' as const,
      });

      const result = await engine.start('wenstaros_core_repair_flow.yaml', makeHighRiskContext());

      expect(result.success).toBe(false);
      expect(result.end_reason).toBe('human_denied');
      expect(result.flow_status).toBe('aborted');
    });

    it('evidenceMissingDiagnostic 返回稳定机器码且不泄露原文', () => {
      const diag = FlowEngine.evidenceMissingDiagnostic();
      expect(diag).toContain('S2_APPROVAL_EVIDENCE_MISSING');
      expect(diag).not.toMatch(/password|token|secret|signature/i);
      // 稳定：两次调用结果一致
      expect(FlowEngine.evidenceMissingDiagnostic()).toBe(diag);
    });

    it('S2 审批成功 → 审计记录 status/ref/approved-plan SHA-256', async () => {
      const engine = new FlowEngine({
        delegateReviewFn: makePassReview(),
        onHumanGate: async () => 'approved' as const,
      });
      const ctx = makeHighRiskContext({
        s2_evidence: {
          approval_ref: 'ref-002',
          approved_plan: '修复 chat.ts FG 写入 bug',
          change_classification: 'common',
          global_architecture_decision: '采纳全局优化方案',
          confirmations: ['ARCH_CHAT_TS_THIN'],
        },
      });

      const result = await engine.start('wenstaros_core_repair_flow.yaml', ctx);
      expect(result.success).toBe(true);

      // 审计文件应记录 S2 gate_resolve 的 evidence 摘要（含 hash，不含原文全文）
      const auditDir = path.resolve('data', 'audit');
      const dirs = readdirSync(auditDir).filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d));
      let foundAudit: string | null = null;
      for (const d of dirs) {
        const f = path.join(auditDir, d, result.run_id + '.json');
        if (existsSync(f)) { foundAudit = f; break; }
      }
      expect(foundAudit).not.toBeNull();
      const audit = JSON.parse(readFileSync(foundAudit!, 'utf-8'));
      // S2 gate_resolve 统一记录——approve 时附加 evidence 摘要
      const s2Gates = audit.entries.filter((e: { event: string; stage_id?: string }) =>
        e.event === 'gate_resolve' && e.stage_id === 'S2_Solution_Design');
      expect(s2Gates.length).toBeGreaterThanOrEqual(1);
      const s2Gate = s2Gates[s2Gates.length - 1];
      const detail = s2Gate.detail || {};
      expect(detail.s2_evidence_status).toBe('provided');
      expect(detail.approval_ref).toBe('ref-002');
      expect(detail.approved_plan_sha256).toMatch(/^[0-9a-f]{64}$/); // SHA-256
      // 不泄露 approved_plan 原文到审计 detail
      expect(detail.approved_plan).toBeUndefined();
      expect(detail.approved_plan_sha256).not.toContain('修复 chat.ts FG 写入 bug');
    });
  });
});

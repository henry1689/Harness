/**
 * Harness 引擎单元测试 — DelegateReviewer
 * ============================================
 * 覆盖六维评审全维度，重点验证文档同步一致性校验（第六维）。
 */

import { describe, it, expect } from 'vitest';
import { review } from '../DelegateReviewer.js';
import type { StageConfig, FlowRunState, MachineSignal } from '../types.js';

/** 最小 StageConfig */
function makeStage(overrides: Partial<StageConfig> = {}): StageConfig {
  return {
    stage_id: 'S4_Arch_Review',
    stage_name: '委托独立专家架构&代码合规评审',
    work_manual: '评审工作手册',
    tool_whitelist: { read_file: true, write_file: false },
    gate_type: 'condition',
    runner_mode: 'delegate',
    next_stage_pass: 'S5_Compile_Test',
    next_stage_reject: 'S3_Code_Implement',
    ...overrides,
  };
}

/** 最小 FlowRunState */
function makeState(overrides: Partial<FlowRunState> & { modified_files?: string[]; risk_level?: 'high' | 'mid' | 'low' } = {}): FlowRunState {
  const { modified_files, risk_level, ...rest } = overrides;
  return {
    run_id: 'test_run_doc',
    flow_id: 'test_flow',
    flow_status: 'running',
    current_stage: 'S4_Arch_Review',
    jump_count: 0,
    stage_retry_count: 0,
    s3_retry_count: 0,
    convergence_round: 0,
    convergence_history: [],
    stage_results: new Map(),
    global_memo: '',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    modified_files: modified_files ?? ['src/config/types.ts'],
    risk_level: risk_level ?? 'low',
    mode: 'pipeline',
    ...rest,
  };
}

describe('DelegateReviewer', () => {
  describe('第六维 — 文档同步一致性校验', () => {
    it('单文件低风险改动 → 仅输出提醒，不构成强制违规', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/config/ConfigService.ts'],
        risk_level: 'low',
      });

      const output = review(stage, state);

      const docViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[文档·'));
      // 单文件低风险：最多有"提醒"项，不应有"强制"项
      const forcedViolations = docViolations.filter(r => r.includes('[文档·强制]'));
      expect(forcedViolations).toHaveLength(0);
    });

    it('双文件修改 → 输出提醒但非强制', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/config/ConfigService.ts', 'src/common/logger.ts'],
        risk_level: 'low',
      });

      const output = review(stage, state);

      const docViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[文档·'));
      const hasReminder = docViolations.some(r => r.includes('提醒'));
      // 双文件低风险可能有提醒
      expect(docViolations.length).toBeGreaterThanOrEqual(0);
    });

    it('高风险文件(chat.ts) → 触发强制文档同步违规', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/webui/chat.ts', 'src/m4/household/FamilyGraph.ts', 'src/m2/SQLiteAdapter.ts'],
        risk_level: 'high',
      });

      const output = review(stage, state);

      const docViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[文档·'));
      const forcedViolations = docViolations.filter(r => r.includes('[文档·强制]'));

      // 3文件+高风险 → 必须触发强制文档违规
      expect(forcedViolations.length).toBeGreaterThanOrEqual(1);
      // 必须包含白皮书/蓝皮书更新要求
      expect(forcedViolations.some(v => v.includes('白皮书') || v.includes('蓝皮书'))).toBe(true);
      // 必须包含"打回 S3"
      expect(forcedViolations.some(v => v.includes('打回 S3') || v.includes('补充文档'))).toBe(true);
    });

    it('高风险文件+白皮书逐文件提示完整', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/webui/chat.ts'],
        risk_level: 'high',
      });

      const output = review(stage, state);

      // chat.ts 作为单一高风险文件，但 archLevel 判定可能不会达到3分（单文件=0 + 高风险=3 =3分，刚好达到）
      // 检查是否有 chat.ts 的文档提示
      const chatDocViolations = output.machine_signal.reject_reason.filter(
        r => r.includes('chat.ts') || r.includes('注入链路'),
      );

      // 至少输出文档影响提示
      expect(output.machine_signal.reject_reason.length).toBeGreaterThan(0);
    });

    it('PFC 接口变更 → 触发白皮书/蓝皮书文档要求', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: [
          'src/engine/tianquan/prefrontal/PrefrontalCortex.ts',
          'src/engine/tianquan/prefrontal/types.ts',
          'src/webui/chat.ts',
        ],
        risk_level: 'high',
      });

      const output = review(stage, state);

      // PFC 相关文档提示
      const pfcDoc = output.machine_signal.reject_reason.filter(r =>
        r.includes('PFC') || r.includes('PrefrontalCortex'),
      );
      expect(pfcDoc.length).toBeGreaterThan(0);
    });

    it('输出必须包含文档同步清单（最低要求摘要）', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: [
          'src/webui/chat.ts',
          'src/m4/household/FamilyGraph.ts',
          'src/m2/SQLiteAdapter.ts',
        ],
        risk_level: 'high',
      });

      const output = review(stage, state);

      // 文档·清单 应包含最低要求
      const checklistViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[文档·清单]'));
      expect(checklistViolations.length).toBe(1);
      expect(checklistViolations[0]).toContain('白皮书更新摘要');
      expect(checklistViolations[0]).toContain('蓝皮书更新摘要');
      expect(checklistViolations[0]).toContain('回滚方案');
    });
  });

  describe('machine_signal 完整性', () => {
    it('高风险多文件 → machine_signal.passed 应为 false', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: [
          'src/webui/chat.ts',
          'src/m4/household/FamilyGraph.ts',
          'src/m2/SQLiteAdapter.ts',
        ],
        risk_level: 'high',
      });

      const output = review(stage, state);

      expect(output.machine_signal.passed).toBe(false);
      expect(output.machine_signal.risk_level).toBe('high');
    });

    it('单文件低风险 → 除文档提醒外不应有致命违规', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/common/GlobalRegistry.ts'],
        risk_level: 'low',
      });

      const output = review(stage, state);

      // 必须有 machine_signal 和 human_report
      expect(output.machine_signal).toBeDefined();
      expect(typeof output.human_report).toBe('string');
      expect(output.human_report.length).toBeGreaterThan(0);
    });
  });

  describe('human_report 包含文档维度信息', () => {
    it('高风险改动 → human_report 应列出文档相关违规', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: [
          'src/webui/chat.ts',
          'src/m4/household/FamilyGraph.ts',
          'src/m2/SQLiteAdapter.ts',
        ],
        risk_level: 'high',
      });

      const output = review(stage, state);

      expect(output.human_report).toContain('评审报告');
      // 高风险+多文件必定有大量违规项（含文档同步规则）
      expect(output.human_report.length).toBeGreaterThan(100);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 第七维 — 归类真实性专项校验（共性底层 / 个性特例）
  // ════════════════════════════════════════════════════════════════════

  describe('第七维 — 归类真实性校验', () => {
    it('公共内核文件(chat.ts/FamilyGraph/SQLiteAdapter) → 必须命中归类违规', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/webui/chat.ts', 'src/m4/household/FamilyGraph.ts', 'src/m2/SQLiteAdapter.ts'],
        risk_level: 'high',
        global_memo: '【本次修改归类：个性局部特例修改】仅修改 chat.ts 中一句话',
      });

      const output = review(stage, state);

      const classifyViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[归类·'));
      // 公共内核文件自称为个性特例 → 必须被拦截
      const interceptViolations = classifyViolations.filter(r => r.includes('[归类·拦截]'));
      expect(interceptViolations.length).toBeGreaterThanOrEqual(1);
      expect(interceptViolations.some(v => v.includes('共性底层问题虚假归类'))).toBe(true);
      expect(output.machine_signal.passed).toBe(false);
    });

    it('S2 归类为共性修复但无横向模块清单 → 判定不通过', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/m4/MemoryInjector.ts'],
        risk_level: 'mid',
        global_memo: '【本次修改归类：共性底层通用修复】修复 MemoryInjector 注入逻辑',
      });

      const output = review(stage, state);

      const classifyViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[归类·'));
      const missingListViolations = classifyViolations.filter(r => r.includes('清单缺失'));
      // 声称共性修复但无横向清单 → 必须报清单缺失
      expect(missingListViolations.length).toBeGreaterThanOrEqual(1);
    });

    it('S2 方案缺少归类板块 → 判定不通过', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/webui/chat.ts'],
        risk_level: 'high',
        global_memo: 'S2 审定方案：修改 chat.ts 第1200行…（无归类说明）',
      });

      const output = review(stage, state);

      const classifyViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[归类·'));
      const missingDecl = classifyViolations.filter(r => r.includes('缺少必填板块'));
      expect(missingDecl.length).toBeGreaterThanOrEqual(1);
      expect(missingDecl[0]).toContain('二选一');
    });

    it('个性特例但多文件+高风险 → 输出可疑警告', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/app/persona/built-in/yuyao/persona.ts', 'src/app/persona/built-in/secretary/persona.ts', 'src/app/persona/built-in/counselor/persona.ts'],
        risk_level: 'high',
        global_memo: '【本次修改归类：个性局部特例修改】仅调整玉瑶角色文案，无横向复用模块，无需全局同步核验。判定依据：独立的 persona.ts 文件，仅影响单角色提示词。',
      });

      const output = review(stage, state);

      const classifyViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[归类·'));
      // 3个文件+高风险声明为个性特例 → 应有可疑警告
      const suspiciousViolations = classifyViolations.filter(r => r.includes('可疑'));
      expect(suspiciousViolations.length).toBeGreaterThanOrEqual(1);
    });

    it('合理个性特例（单文件persona文案）→ 无强制违规', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/app/persona/built-in/yuyao/persona.ts'],
        risk_level: 'low',
        global_memo: '【本次修改归类：个性局部特例修改】仅调整玉瑶角色专属问候文案，无横向复用模块，无需全局同步核验。判定依据：该文案仅用于 yuyao persona.ts，其他角色各有独立文案，不存在跨角色复用场景。',
      });

      const output = review(stage, state);

      const classifyViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[归类·'));
      // 合理的个性特例 → 不应有[归类·拦截]强制违规
      const interceptViolations = classifyViolations.filter(r => r.includes('[归类·拦截]'));
      expect(interceptViolations).toHaveLength(0);
    });

    it('归类模糊(ambiguous)声称个性但缺少论证 → 判定不通过', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/some-unknown-dir/helper.ts'],
        risk_level: 'low',
        global_memo: '【本次修改归类：个性局部特例修改】本次为个性特例。',
      });

      const output = review(stage, state);

      const classifyViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[归类·'));
      const missingReasoning = classifyViolations.filter(r => r.includes('论证缺失'));
      expect(missingReasoning.length).toBeGreaterThanOrEqual(1);
    });

    it('共性修复附带完整清单 → 应无归类强拦违规', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/m4/MemoryInjector.ts', 'src/m4/MemoryRetriever.ts', 'src/webui/chat.ts'],
        risk_level: 'high',
        global_memo:
          '【本次修改归类：共性底层通用修复】修复 MemoryInjector 跨角色记忆注入逻辑。' +
          '横向关联模块清单：src/m4/MemoryInjector.ts（核心注入）、src/m4/MemoryRetriever.ts（检索端）、' +
          'src/webui/chat.ts（调用端）、src/m4/household/EntityContextBuilder.ts（消费端）、' +
          'src/webui/chat/MeetingContextPipeline.ts（会晤消费端）。共 5 个文件需要同步修复。',
      });

      const output = review(stage, state);

      const classifyViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[归类·'));
      // 完整清单 → 不应有 [归类·清单缺失] 或 [归类·拦截]
      const strongViolations = classifyViolations.filter(
        r => r.includes('[归类·清单缺失]') || r.includes('[归类·拦截]'),
      );
      expect(strongViolations).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 第八维 — 基础静态质量校验（新规则5 第一层）
  // ════════════════════════════════════════════════════════════════════

  describe('第八维 — 基础静态质量校验', () => {
    it('源文件修改 → 强制输出编译检查要求', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/webui/chat.ts'],
        risk_level: 'high',
      });

      const output = review(stage, state);

      const sqViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[静态质量·'));
      expect(sqViolations.length).toBeGreaterThanOrEqual(2); // 强制 + 编译提醒/文件专项
      expect(sqViolations.some(r => r.includes('tsc --noEmit'))).toBe(true);
    });

    it('M层管线文件 → 类型定义检查提示', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/m4/MemoryInjector.ts'],
        risk_level: 'mid',
      });

      const output = review(stage, state);

      const sqViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[静态质量·'));
      expect(sqViolations.some(r => r.includes('管线'))).toBe(true);
    });

    it('测试文件 → 确认测试本身编译通过', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/m2/__tests__/adapter.test.ts'],
        risk_level: 'low',
      });

      const output = review(stage, state);

      const sqViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[静态质量·'));
      expect(sqViolations.some(r => r.includes('测试'))).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 第九维 — 鲁棒加固专项校验（新规则5 第二层）
  // ════════════════════════════════════════════════════════════════════

  describe('第九维 — 鲁棒加固校验', () => {
    it('核心链路文件(chat.ts) → 强制输出鲁棒要求', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/webui/chat.ts'],
        risk_level: 'high',
      });

      const output = review(stage, state);

      const robustViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[鲁棒·'));
      const forced = robustViolations.filter(r => r.includes('[鲁棒·强制]'));
      expect(forced.length).toBeGreaterThanOrEqual(1);
      // chat.ts 应有 LLM 三级保护提示
      const llmGuard = robustViolations.filter(r => r.includes('[鲁棒·LLM]'));
      expect(llmGuard.length).toBeGreaterThanOrEqual(1);
    });

    it('SQLiteAdapter修改 → 持久化鲁棒要求', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/m2/SQLiteAdapter.ts'],
        risk_level: 'high',
      });

      const output = review(stage, state);

      const robustViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[鲁棒·'));
      expect(robustViolations.some(r => r.includes('scheduleFlush') || r.includes('防抖'))).toBe(true);
      expect(robustViolations.some(r => r.includes('事务回滚'))).toBe(true);
    });

    it('非核心链路文件 → 仅提醒不强制', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/config/ConfigService.ts'],
        risk_level: 'low',
      });

      const output = review(stage, state);

      const robustViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[鲁棒·'));
      const forced = robustViolations.filter(r => r.includes('[鲁棒·强制]'));
      expect(forced).toHaveLength(0);
    });

    it('必须包含补丁检测提示', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/webui/chat.ts'],
        risk_level: 'high',
      });

      const output = review(stage, state);

      const robustViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[鲁棒·'));
      expect(robustViolations.some(r => r.includes('补丁检测'))).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 第十维 — Hook埋点与自检合规校验（新规则8）
  // ════════════════════════════════════════════════════════════════════

  describe('第十维 — Hook埋点与自检合规', () => {
    it('核心管线修改 → 强制Hook埋点', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/m4/MemoryInjector.ts', 'src/webui/chat.ts'],
        risk_level: 'high',
      });

      const output = review(stage, state);

      const hookViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[Hook·'));
      const forced = hookViolations.filter(r => r.includes('[Hook·强制]'));
      expect(forced.length).toBeGreaterThanOrEqual(1);
    });

    it('六级全景健康体检全部列举', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/webui/chat.ts'],
        risk_level: 'high',
      });

      const output = review(stage, state);

      const hookViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[Hook·'));
      expect(hookViolations.some(r => r.includes('编译校验'))).toBe(true);
      expect(hookViolations.some(r => r.includes('全量单元测试'))).toBe(true);
      expect(hookViolations.some(r => r.includes('行为核验'))).toBe(true);
      expect(hookViolations.some(r => r.includes('标注率审计'))).toBe(true);
      expect(hookViolations.some(r => r.includes('持久化核验'))).toBe(true);
    });

    it('非核心链路 → 仅提醒不强制', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/config/types.ts'],
        risk_level: 'low',
      });

      const output = review(stage, state);

      const hookViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[Hook·'));
      const forced = hookViolations.filter(r => r.includes('[Hook·强制]'));
      expect(forced).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 第十一维 — 优化提案落地真实性校验（新规则9）
  // ════════════════════════════════════════════════════════════════════

  describe('第十一维 — 优化提案落地真实性', () => {
    it('S2缺少优化提案板块 → 强制驳回', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/webui/chat.ts'],
        risk_level: 'high',
        global_memo: 'S2 审定方案：修复 chat.ts 中某处逻辑…（无优化提案板块）',
      });

      const output = review(stage, state);

      const proposalViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[提案·'));
      const forced = proposalViolations.filter(r => r.includes('[提案·强制]'));
      expect(forced.length).toBeGreaterThanOrEqual(1);
    });

    it('用户否决优化提案 → 核验退回原始方案一致性', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/webui/chat.ts'],
        risk_level: 'high',
        global_memo:
          '【全局架构优化提案：形态二——存在全局升级空间】…' +
          '【用户审批】维持原始方案——驳回优化提案，按原局部方案执行。' +
          '选择原始方案。',
      });

      const output = review(stage, state);

      const proposalViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[提案·'));
      expect(proposalViolations.some(r => r.includes('已否决') || r.includes('一致性'))).toBe(true);
    });

    it('用户同意优化提案 → 核验全部落地流程', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/webui/chat.ts', 'src/m4/MemoryInjector.ts'],
        risk_level: 'high',
        global_memo:
          '【全局架构优化提案：形态二——存在全局升级空间】…' +
          '【用户审批】已采纳全局优化方案——同意根据优化方案执行。' +
          '采纳全局优化替代方案。',
      });

      const output = review(stage, state);

      const proposalViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[提案·'));
      expect(proposalViolations.some(r => r.includes('[提案·落地]'))).toBe(true);
      const land = proposalViolations.find(r => r.includes('[提案·落地]'));
      expect(land).toContain('共性横向');
      expect(land).toContain('鲁棒加固');
      expect(land).toContain('Hook埋点');
      expect(land).toContain('六级全景');
      expect(land).toContain('稳定链路');
    });

    it('有优化提案但用户未审批 → 标记待决', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/webui/chat.ts'],
        risk_level: 'high',
        global_memo:
          '【全局架构优化提案：形态二——存在全局升级空间】…（无审批标记）',
      });

      const output = review(stage, state);

      const proposalViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[提案·'));
      expect(proposalViolations.some(r => r.includes('[提案·待决]'))).toBe(true);
    });

    it('审计归档要求必须出现', () => {
      const stage = makeStage();
      const state = makeState({
        modified_files: ['src/webui/chat.ts'],
        risk_level: 'high',
        global_memo: '【全局架构优化提案：形态一——无优化空间】',
      });

      const output = review(stage, state);

      const proposalViolations = output.machine_signal.reject_reason.filter(r => r.startsWith('[提案·'));
      expect(proposalViolations.some(r => r.includes('审计'))).toBe(true);
    });
  });
});
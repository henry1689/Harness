/**
 * RulesLazyLoader — 规则懒加载器
 * ====================================
 * 🔴 Token 降耗核心模块。
 *
 * 业务流水线（wenstaros_core_repair_flow）仅加载本 Flow 的精简规则摘要，
 * 不注入 SelfGuard 全套 13 条自护规则（SG-R1~SG-R13）。
 *
 * 设计原理：
 *   1. main_harness_checker.ts 已硬编码全部架构铁律的本地校验逻辑
 *   2. LLM 不再需要完整规则文本来做判断——它只需汇总脚本输出
 *   3. 因此每个阶段仅注入「失败要点摘要」而非「完整规则 + 完整备忘录」
 *   4. SelfGuard 自护规则仅在修改 Harness 自身基础设施时加载
 *
 * 规则分层：
 *   Layer 0 — 精简摘要（~200 tokens）：仅 check_id + 通过/失败 + 违规数
 *   Layer 1 — 违规详情（~800 tokens）：失败检查项的违规描述摘要
 *   Layer 2 — 完整规则（~3000 tokens）：YAML 中的完整 global_arch_constraint + global_implementation_rules
 *   Layer SG — SelfGuard（~5000 tokens，本模块不加载）
 *
 * 使用方式：
 *   import { RulesLazyLoader } from './RulesLazyLoader.js';
 *   const loader = RulesLazyLoader.getInstance();
 *   const slimContext = loader.buildStageContext(flowId, stageId, lastCheckResult);
 */

import type { FlowConfig, StageResult } from './types.js';

// ════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════

/** 上下文层级 */
type ContextLayer = 'summary' | 'detail' | 'full';

/** 精简阶段上下文 */
export interface SlimStageContext {
  /** 阶段 work_manual（原始） */
  work_manual: string;
  /** 精简规则注入（仅本 Flow 规则摘要） */
  rules_brief: string;
  /** 前序阶段失败要点（仅违规项摘要） */
  failure_brief: string;
  /** 上一阶段评审建议（S4→S3 回流时注入） */
  review_feedback?: string;
}

/** 规则摘要 */
interface RuleSummary {
  /** 规则标题列表 */
  titles: string[];
  /** 核心约束关键词 */
  keywords: string[];
  /** 简要文本（~200 tokens） */
  brief: string;
}

// ════════════════════════════════════════════════════════════════════
// 主业务 Flow 精简规则（硬编码——不读 YAML，直接零延迟）
// ════════════════════════════════════════════════════════════════════

const WENSTAROS_RULE_SUMMARY: RuleSummary = {
  titles: [
    'M1-M9九层管线无循环依赖',
    'PFC薄调度(chat.ts仅编排)',
    'FG户籍角色扮演分支隔离',
    'UUID四层标注全链路',
    '_meetingEntityName 12处同步',
    '新旧角色扮演双管线同步',
    '数据只增不删',
    'chat.ts 22段注入顺序',
    '高风险文件全量import评估',
  ],
  keywords: [
    '九层管线', 'PFC', '薄调度', 'FG户籍', 'UUID标注',
    '会晤点位', '角色扮演', '双管线', '数据只增不删',
    '22段注入', '高风险评估', 'save落盘', '防抖',
  ],
  brief: [
    '## 🔴 架构铁律（精简摘要——完整校验已由 main_harness_checker.ts 执行）',
    '',
    '1. M1-M9 无循环依赖，chat.ts 仅薄调度编排',
    '2. PFC 为唯一上下文门控，FG 角色扮演分支隔离',
    '3. UUID(TXS-xxxx) 四层标注不可删减',
    '4. SQLiteAdapter 唯一持久化通道，save() 必须保留',
    '5. _meetingEntityName 12处必须同步',
    '6. 新旧角色扮演双管线同步修改',
    '7. 数据只增不删，22段注入顺序不可调换',
    '8. 高风险文件必须评估全量 import 依赖',
    '',
    '🔴 硬校验结果已由本地脚本生成——LLM 仅需汇总违规项，不重新执行检查。',
  ].join('\n'),
};

// ════════════════════════════════════════════════════════════════════
// 实现
// ════════════════════════════════════════════════════════════════════

export class RulesLazyLoader {
  private static instance: RulesLazyLoader | null = null;

  /** 缓存的规则摘要 */
  private readonly summaries = new Map<string, RuleSummary>();

  private constructor() {
    // 预注册主业务 Flow 规则摘要
    this.summaries.set('wenstaros_core_repair_flow', WENSTAROS_RULE_SUMMARY);
  }

  static getInstance(): RulesLazyLoader {
    if (!RulesLazyLoader.instance) {
      RulesLazyLoader.instance = new RulesLazyLoader();
    }
    return RulesLazyLoader.instance;
  }

  static reset(): void {
    RulesLazyLoader.instance = null;
  }

  // ════════════════════════════════════════════════════════════════
  // 公开 API
  // ════════════════════════════════════════════════════════════════

  /**
   * 🔴 核心方法：构建精简阶段上下文。
   *
   * 替代原有的 injectMemo()（注入完整架构铁律 + 落地规则 + S2 备忘录）。
   * 仅注入：
   *   1. work_manual（原始阶段工作手册——保持不变）
   *   2. rules_brief（本 Flow 规则精简摘要，~200 tokens）
   *   3. failure_brief（前序阶段失败要点，仅违规项）
   *   4. review_feedback（S4→S3 回流时的具体驳回原因）
   *
   * @param flowId — Flow ID
   * @param stageId — 当前阶段
   * @param prevResults — 前序阶段执行结果（Map）
   * @returns 精简上下文
   */
  buildStageContext(
    flowId: string,
    stageId: string,
    prevResults: Map<string, StageResult>,
  ): SlimStageContext {
    const summary = this.summaries.get(flowId) || this.buildDefaultSummary();

    return {
      work_manual: '', // 由调用方从 stage.work_manual 填充
      rules_brief: this.buildRulesBrief(summary),
      failure_brief: this.buildFailureBrief(prevResults),
      review_feedback: this.buildReviewFeedback(stageId, prevResults),
    };
  }

  /**
   * 获取指定 Flow 的规则摘要。
   */
  getRuleSummary(flowId: string): RuleSummary {
    return this.summaries.get(flowId) || this.buildDefaultSummary();
  }

  /**
   * 注册自定义 Flow 规则摘要。
   */
  registerSummary(flowId: string, summary: RuleSummary): void {
    this.summaries.set(flowId, summary);
  }

  /**
   * 判断当前阶段是否为业务流水线（非 SelfGuard）。
   */
  isBusinessFlow(flowId: string): boolean {
    return flowId === 'wenstaros_core_repair_flow';
  }

  // ════════════════════════════════════════════════════════════════
  // 内部方法
  // ════════════════════════════════════════════════════════════════

  /**
   * 构建规则摘要文本（~200 tokens）。
   */
  private buildRulesBrief(summary: RuleSummary): string {
    return summary.brief;
  }

  /**
   * 构建前序阶段失败要点摘要。
   * 🔴 仅提取失败阶段的关键违规信息，不注入完整规则。
   */
  private buildFailureBrief(prevResults: Map<string, StageResult>): string {
    const failures: string[] = [];

    for (const [sid, result] of prevResults) {
      if (result.status === 'rejected' || result.gate_resolution === 'condition_rejected') {
        const reasons: string[] = [];

        if (result.machine_signal?.reject_reason?.length) {
          reasons.push(...result.machine_signal.reject_reason);
        }
        if (result.error) {
          reasons.push(result.error);
        }

        if (reasons.length > 0) {
          failures.push(`**${sid}** 驳回原因: ${reasons.slice(0, 3).join('; ')}`);
        } else {
          failures.push(`**${sid}** 未通过（无详细驳回信息）`);
        }
      }
    }

    if (failures.length === 0) {
      return '（前序阶段全部通过）';
    }

    return [
      '## ⚠️ 前序阶段失败要点',
      '',
      ...failures,
      '',
      '🔴 仅修复上述驳回项，不扩大改动范围。',
    ].join('\n');
  }

  /**
   * 构建 S4→S3 回流时的具体驳回反馈。
   */
  private buildReviewFeedback(stageId: string, prevResults: Map<string, StageResult>): string | undefined {
    // 仅在 S3 阶段且 S4 有驳回结果时生成
    if (!stageId.startsWith('S3')) return undefined;

    const s4Result = prevResults.get('S4_Arch_Review');
    if (!s4Result || s4Result.status !== 'rejected') return undefined;

    const parts: string[] = [];
    if (s4Result.machine_signal?.reject_reason?.length) {
      parts.push('**S4 架构评审驳回项（必须逐条修复）：**');
      for (const reason of s4Result.machine_signal.reject_reason) {
        parts.push(`- ❌ ${reason}`);
      }
    }
    if (s4Result.human_report) {
      // 提取 human_report 中关键行（避免整段注入）
      const keyLines = s4Result.human_report
        .split('\n')
        .filter(l => l.includes('❌') || l.includes('违规') || l.includes('缺失') || l.includes('风险'))
        .slice(0, 5);
      if (keyLines.length > 0) {
        parts.push('', '**关键问题摘要：**');
        parts.push(...keyLines);
      }
    }

    return parts.length > 1 ? parts.join('\n') : undefined;
  }

  /**
   * 构建默认规则摘要（未知 Flow 时使用）。
   */
  private buildDefaultSummary(): RuleSummary {
    return {
      titles: [],
      keywords: [],
      brief: '（无预设规则——请遵循项目 CLAUDE.md 中的通用开发规范）',
    };
  }
}

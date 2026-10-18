/**
 * ComplianceScorer — 合规评分引擎
 * ===================================
 * 接收 S4 的全部输出（CK-01~CK-08 硬校验结果 + DelegateReviewer 11 维违规清单），
 * 映射到 19 条设计标准，逐条打分，输出加权综合合规报告。
 *
 * 评分逻辑：
 *   1. 每条标准起始 100 分
 *   2. CK 检查违规扣分：severity=fail → -30, severity=warn → -10
 *   3. DelegateReviewer 违规扣分：每条匹配违规 → -15
 *   4. 单条标准最低 0 分，最高 100 分
 *   5. 总体加权分 = Σ(标准分 × 权重) / 总权重
 *
 * 使用方式：
 *   import { computeComplianceScore } from './ComplianceScorer.js';
 *   const report = computeComplianceScore(ckResults, violations, humanReport);
 */

import { DESIGN_STANDARDS, TOTAL_WEIGHT } from './DesignStandards.js';
import type { DesignStandard } from './DesignStandards.js';
import type {
  ComplianceReport,
  StandardComplianceScore,
  ComplianceDeduction,
  GapItem,
} from './types.js';

// ════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════

/** CK 检查结果（最小接口——兼容 main_harness_checker 的 CheckResult） */
interface CKCheckResult {
  id: string;
  passed: boolean;
  severity: 'pass' | 'warn' | 'fail';
  violations: Array<{ message: string }>;
}

/**
 * 扣分规则。
 * 🔴 2026-10-15：类型本体移到 `src/types.ts::ComplianceDeduction` 并对外导出 ——
 *    此前它是本文件的**局部 interface 且不返回**，算完即丢，报告层拿不到「谁扣了多少、为什么」，
 *    agent 只能回翻 ck_reports/dim_review 去猜（实测抱怨点）。此处保留别名以免大面积改写。
 */
type Deduction = ComplianceDeduction;

// ════════════════════════════════════════════════════════════════════
// 评分常量
// ════════════════════════════════════════════════════════════════════

/** CK 检查 fail 扣分 */
const CK_FAIL_DEDUCTION = 40;
/** CK 检查 warn 扣分 */
const CK_WARN_DEDUCTION = 15;
/** DelegateReviewer 违规每项扣分 */
const REVIEW_VIOLATION_DEDUCTION = 20;
/** 通过阈值 — 🔴 每条标准 ≥98 分才放行（v2.6 校准：100% 满分制误伤低复杂度文件，回落 98） */
const PASS_THRESHOLD = 98;
/** 旁路/转交用户阈值（死配置，仅一致性；真实转交门槛见 ConvergenceGate.makeDecision handoffThreshold=90） */
const BYPASS_THRESHOLD = 98;
/** 硬锁定阈值 — 🔴 任意标准 <80 分立即锁定 */
const HARD_LOCKOUT_THRESHOLD = 80;

/**
 * 🔴 2026-09-23 C2：S4.5 不计分的标准 / 检查（61 份现场报告实证）。
 *
 * 背景 —— 61 份报告里**自然通过 0 份**，失败高度集中在两条：
 *   - **DS-16 / DS-19**（失败率 40/61、53/61）：本质是 **S2 方案文档的填空题**（方案里有没有
 *     写"本次修改归类"和"全局架构优化提案"两个板块），与代码质量无关；且其义务**已由 S4
 *     阶段硬阻断承担**（S4 reviewer 直接输出 `[归类·强制]` / `[提案·强制]` blocking）。
 *     在 S4.5 再各扣 20 分，等于用文档缺失去否决代码，并直接导致整条 run 结构性失败。
 *   - **CK-06.5**（拖累 DS-23，失败率 54/61）：为**纯名字匹配**的全仓扫描，
 *     `main_harness_checker.ts:810` 自述「特征提取纯基于名字，无法区分"同名普通使用"与
 *     "同款缺陷复现"」「关系赋值特征……92 处正常引用全仓爆炸」「通用方法名……17 处普通
 *     调用误判」。其设计意图已声明改为「真实共性由 S4 reviewer 内容通道判定」，但 CK 侧
 *     仍返回 warn，而 warn 就是 −15 分 → **只要做改动，DS-23 就先丢 15 分**。
 *
 * 处置：以下标准/CK 在 S4.5 **只记录不扣分**，义务回归 S4 评审与 S2 声明闭环。
 * ⚠️ 边界：这是「评分口径」调整，**不是**削弱防护 —— S4 阶段对 `[归类·强制]` /
 *    `[提案·强制]` 的 blocking 必须保持生效（符合 SG-R4）。改动后需专项确认这一点。
 */
const S45_NON_SCORING_STANDARDS = new Set(['DS-16', 'DS-19']);
const S45_INFORMATIONAL_CKS = new Set(['CK-06.5']);

// ════════════════════════════════════════════════════════════════════
// 公开 API
// ════════════════════════════════════════════════════════════════════

/**
 * 计算合规得分。
 *
 * @param ckResults — main_harness_checker.ts 输出的 CK-01~CK-08 结果
 * @param reviewViolations — S4 machine_signal.reject_reason 中的违规字符串列表
 * @param _humanReport — S4 human_report（暂用于上下文参考）
 * @returns 合规报告
 */
export function computeComplianceScore(
  ckResults: CKCheckResult[],
  reviewViolations: string[],
  _humanReport: string = '',
): ComplianceReport {
  const standardScores: StandardComplianceScore[] = [];

  for (const std of DESIGN_STANDARDS) {
    standardScores.push(scoreStandard(std, ckResults, reviewViolations));
  }

  // 🔴 per-standard minimum: 任意标准 <98 → 加权总分额外惩罚
  let perStandardPenalty = 0;
  for (const s of standardScores) {
    if (s.score < PASS_THRESHOLD) {
      perStandardPenalty += (s.weight / TOTAL_WEIGHT) * ((PASS_THRESHOLD - s.score) / 100);
    }
  }

  // 应用惩罚
  const rawScore = standardScores.reduce((sum, s) => sum + s.score * s.weight, 0) / TOTAL_WEIGHT;
  const overallScore = Math.max(0, Math.round((rawScore - perStandardPenalty * 100) * 10) / 10);

  // 分类
  const passedStandards = standardScores.filter(s => s.score >= PASS_THRESHOLD).length;
  const failingStandards = standardScores.filter(s => s.score < PASS_THRESHOLD);
  const criticalStandards = standardScores.filter(s => s.score < BYPASS_THRESHOLD);
  const lockedOutStandards = standardScores.filter(s => s.score < HARD_LOCKOUT_THRESHOLD);

  // 差距分析
  const gapAnalysis: GapItem[] = failingStandards
    .map(s => ({
      standardId: s.standardId,
      standardText: s.standardText,
      currentScore: s.score,
      targetScore: PASS_THRESHOLD,
      pointsNeeded: PASS_THRESHOLD - s.score,
      suggestedActions: buildSuggestedActions(s),
      // 🔴 2026-10-15：透传逐条扣分，供 ConvergenceGate 的驳回报告直接引用
      deductions: s.deductions,
    }))
    .sort((a, b) => b.pointsNeeded - a.pointsNeeded);

  // 🔴 2026-10-15：Top 5 问题 —— 原本只写「85分(需提升13分)」，**没有任何原因**，
  //    agent 拿到只能自己回翻 ck_reports 猜是哪一项扣的（实测抱怨点）。
  //    现把扣分最多的那一项连同原因一并带上，一句话就能定位。
  const topIssues = gapAnalysis
    .slice(0, 5)
    .map(g => {
      const worst = [...g.deductions].sort((a, b) => b.amount - a.amount)[0];
      const why = worst ? ` ← ${worst.source} −${worst.amount}: ${worst.reason.slice(0, 80)}` : '';
      return `DS-${g.standardId.slice(3)} ${g.standardText}: ${g.currentScore}分(需提升${g.pointsNeeded}分)${why}`;
    });

  return {
    overallScore,
    passedStandards,
    totalStandards: DESIGN_STANDARDS.length,
    standardScores,
    gapAnalysis,
    topIssues,
    computedAt: new Date().toISOString(),
  };
}

/** 判断合规报告是否通过阈值 */
export function isCompliancePassed(report: ComplianceReport, threshold: number = PASS_THRESHOLD): boolean {
  return report.overallScore >= threshold;
}

// ════════════════════════════════════════════════════════════════════
// 内部实现
// ════════════════════════════════════════════════════════════════════

/** 对单条标准打分 */
function scoreStandard(
  std: DesignStandard,
  ckResults: CKCheckResult[],
  reviewViolations: string[],
): StandardComplianceScore {
  let score = 100;
  const deductions: Deduction[] = [];
  const relatedViolations: string[] = [];
  let totalChecks = 0;
  let passedChecks = 0;
  let failedChecks = 0;

  // 1. CK 检查扣分
  for (const ckId of std.mappedCKChecks) {
    // 🔴 2026-09-23 C2：信息性 CK 只记录不扣分（见 S45_INFORMATIONAL_CKS 注释）
    if (S45_INFORMATIONAL_CKS.has(ckId)) {
      const _ck = ckResults.find(c => c.id === ckId);
      if (_ck && _ck.violations && _ck.violations[0]) {
        relatedViolations.push(`[${ckId}] ${_ck.violations[0].message}`);
      }
      continue;
    }
    const ck = ckResults.find(c => c.id === ckId);
    // P6-FIX: 缺失的 CK 结果不作为"通过"，而是作为严重扣分（可能因异常被跳过）
    if (!ck) {
      failedChecks++;
      totalChecks++;
      deductions.push({ source: ckId, amount: CK_FAIL_DEDUCTION, reason: `${ckId} 结果缺失（可能因执行异常被跳过）` });
      relatedViolations.push(`[${ckId}] ⚠ 结果缺失 - 此检查可能因异常被静默跳过`);
      continue;
    }

    totalChecks++;
    if (ck.severity === 'fail') {
      failedChecks++;
      deductions.push({ source: ckId, amount: CK_FAIL_DEDUCTION, reason: ck.violations[0]?.message || `${ckId} 未通过` });
      relatedViolations.push(`[${ckId}] ${ck.violations[0]?.message || '未通过'}`);
    } else if (ck.severity === 'warn') {
      // warn 不算 passed，也不算 failed
      deductions.push({ source: ckId, amount: CK_WARN_DEDUCTION, reason: ck.violations[0]?.message || `${ckId} 警告` });
      relatedViolations.push(`[${ckId}] ⚠ ${ck.violations[0]?.message || '警告'}`);
    } else {
      passedChecks++;
    }
  }

  // 2. DelegateReviewer 违规扣分
  // P0-fix(去重): S4 review 通道对同一标准至多计 1 次扣分。reviewer blocking 多为过程性
  // 义务/确认项，全文文本会被多个标准的关键词正则命中；多条义务叠同一标准会造成
  // 单标准被 -40/-60（如 DS-15 被 STATIC+ROBUST+体检文案叠扣到 40）。多条真实内容级
  // 违规仍由 CK 通道（mappedCKChecks）各自逐条计分，不受此去重影响。
  //
  // A-full(P0后半): 5 个无条件"过程义务"不计 S4.5 文本分——它们是 S5(tsc)/S6(行为) 真验的
  // 待办指令，非 S4 检测到的内容违规。只要计分就必然拖多个标准各 -20 → 核心文件结构性
  // 地板 ~80-85（chat.ts 62-74 / m7 81 实证），与改动质量无关。内容正确性仍由 CK 通道 +
  // 真实 reviewer 发现（如 CLASSIFY_FALSE_SPECIFIC / FG 红线确认缺失）计分。
  const PROCESS_OBLIGATION_PREFIXES = ['[静态质量·强制]', '[鲁棒·强制]', '[Hook·强制]', '[Hook·体检]', '[文档·强制]'];
  // 🔴 2026-09-23 C2：S4.5 不计分标准 —— 义务由 S4 硬阻断承担，此处只记录不扣分。
  // 注意用 return 而非 break：score 保持 100、gapToTarget 归零，使 passedStandards
  // 不再被这两条文档填空题拖住（否则「全部标准达标」永远无法满足）。
  if (S45_NON_SCORING_STANDARDS.has(std.standardId)) {
    for (const v of reviewViolations) {
      if (std.violationTagPatterns.some(p => p.test(v))) relatedViolations.push(v.slice(0, 120));
    }
    return {
      standardId: std.standardId,
      standardText: std.title,
      weight: std.weight,
      score: 100,
      totalChecks,
      passedChecks,
      failedChecks,
      // 🔴 2026-10-15：不计分标准恒为空（本路径刻意不扣分，见上方注释）
      deductions: [],
      relatedViolations: relatedViolations.slice(0, 20),
      gapToTarget: 0,
    };
  }

  let reviewerDeducted = false;
  for (const violation of reviewViolations) {
    if (reviewerDeducted) break;
    if (std.violationTagPatterns.length === 0) continue;
    if (PROCESS_OBLIGATION_PREFIXES.some(p => violation.startsWith(p))) continue;

    if (std.violationTagPatterns.some(p => p.test(violation))) {
      reviewerDeducted = true;
      totalChecks++;
      failedChecks++;
      deductions.push({ source: 'Reviewer', amount: REVIEW_VIOLATION_DEDUCTION, reason: violation.slice(0, 100) });
      relatedViolations.push(violation.slice(0, 120));
    }
  }

  // 3. 应用扣分
  for (const d of deductions) {
    score = Math.max(0, score - d.amount);
  }

  // 4. 如果该标准无关联检查和维度（如 DS-17），默认满分
  if (std.mappedCKChecks.length === 0 && std.violationTagPatterns.length === 0) {
    totalChecks = 0;
    passedChecks = 0;
    failedChecks = 0;
    score = 100;
  }

  return {
    standardId: std.standardId,
    standardText: std.title,
    weight: std.weight,
    score,
    totalChecks,
    passedChecks,
    failedChecks,
    relatedViolations,
    // 🔴 2026-10-15：把扣分明细一并带出。此前 deductions 是局部变量、算完即丢，
    // 报告只能给「DS-15: 85分(距达标差13分)」这种无原因结论。
    deductions,
    gapToTarget: Math.max(0, PASS_THRESHOLD - score),
  };
}

/** 根据标准得分生成改进建议 */
function buildSuggestedActions(s: StandardComplianceScore): string[] {
  const actions: string[] = [];

  if (s.score < 60) {
    actions.push('⚠️ 严重违规——优先修复此项');
  }

  // 🔴 2026-10-15：改用「真实扣分明细」而不是违规文本条数。
  //    原实现只说「共 N 条违规需修复」+ 贴 3 条截断原文，agent 仍不知道该改哪一项、改成什么；
  //    现在逐条给出「来源 −分量：原因」，并把最贵的一项置顶，避免在长列表里找。
  if (s.deductions.length > 0) {
    const ranked = [...s.deductions].sort((a, b) => b.amount - a.amount);
    const total = ranked.reduce((n, d) => n + d.amount, 0);
    actions.push(`扣分明细（合计 −${total}）：`);
    for (const d of ranked) {
      actions.push(`  → ${d.source} −${d.amount}：${d.reason.slice(0, 100)}`);
    }
  } else if (s.relatedViolations.length > 0) {
    // 无结构化扣分但有违规文本（信息性 CK 等只记录不扣分的场景）—— 仍给出原文
    actions.push(`共 ${s.relatedViolations.length} 条违规需修复（本标准未扣分，仅供参考）：`);
    for (const v of s.relatedViolations.slice(0, 3)) {
      actions.push(`  → ${v.slice(0, 80)}`);
    }
  }

  if (s.totalChecks === 0 && s.score === 100) {
    actions.push('无关联检查项——默认满分（仅作为文档备案）');
  }

  return actions;
}

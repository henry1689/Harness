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

/** 扣分规则 */
interface Deduction {
  source: string;
  amount: number;
  reason: string;
}

// ════════════════════════════════════════════════════════════════════
// 评分常量
// ════════════════════════════════════════════════════════════════════

/** CK 检查 fail 扣分 */
const CK_FAIL_DEDUCTION = 40;
/** CK 检查 warn 扣分 */
const CK_WARN_DEDUCTION = 15;
/** DelegateReviewer 违规每项扣分 */
const REVIEW_VIOLATION_DEDUCTION = 20;
/** 通过阈值 — 🔴 每条标准 ≥100 分，满分才放行 */
const PASS_THRESHOLD = 100;
/** 旁路/转交用户阈值 */
const BYPASS_THRESHOLD = 100;
/** 硬锁定阈值 — 🔴 任意标准 <80 分立即锁定 */
const HARD_LOCKOUT_THRESHOLD = 80;

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
    }))
    .sort((a, b) => b.pointsNeeded - a.pointsNeeded);

  // Top 5 问题
  const topIssues = gapAnalysis
    .slice(0, 5)
    .map(g => `DS-${g.standardId.slice(3)} ${g.standardText}: ${g.currentScore}分(需提升${g.pointsNeeded}分)`);

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
    const ck = ckResults.find(c => c.id === ckId);
    if (!ck) continue; // 该 CK 未被触发 → 视为通过

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
  for (const violation of reviewViolations) {
    if (std.violationTagPatterns.length === 0) continue;

    const matched = std.violationTagPatterns.some(p => p.test(violation));
    if (matched) {
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
    gapToTarget: Math.max(0, PASS_THRESHOLD - score),
  };
}

/** 根据标准得分生成改进建议 */
function buildSuggestedActions(s: StandardComplianceScore): string[] {
  const actions: string[] = [];

  if (s.score < 60) {
    actions.push('⚠️ 严重违规——优先修复此项');
  }
  if (s.relatedViolations.length > 0) {
    actions.push(`共 ${s.relatedViolations.length} 条违规需修复`);
    // 前 3 条违规作为具体指引
    for (const v of s.relatedViolations.slice(0, 3)) {
      actions.push(`  → ${v.slice(0, 80)}`);
    }
  }
  if (s.totalChecks === 0 && s.score === 100) {
    actions.push('无关联检查项——默认满分（仅作为文档备案）');
  }

  return actions;
}

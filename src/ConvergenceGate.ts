/**
 * ConvergenceGate — S4.5 设计标准合规收敛闸门
 * ==============================================
 * S4 之后、S5 之前的新增阶段。
 *
 * 核心逻辑：
 *   1. 读取 S4 阶段完整结果（CK-01~CK-08 + DelegateReviewer 11维违规清单）
 *   2. 调用 ComplianceScorer 计算 19 条设计标准的加权合规得分
 *   3. 决策：
 *      - ≥ 90% → PASS → 流入 S5
 *      - < 90% 且 < 5轮 → REJECT → 回流 S3（附带逐条差距分析）
 *      - ≥ 80% 且 = 5轮 → HUMAN_BYPASS → 人工审批放行
 *      - < 80% 且 ≥ 5轮 → HARD_LOCKOUT → 流水线中止
 *   4. 记录收敛历史，输出趋势报告
 *
 * 使用方式：
 *   作为 S4.5 阶段的 delegate runner 函数注入：
 *   import { evaluate as convergenceEvaluate } from './ConvergenceGate.js';
 *   delegateFnMap.set('S4.5_Convergence_Gate', convergenceEvaluate);
 */

import type { StageConfig, StageOutput, FlowRunState, ConvergenceEntry } from './types.js';
import { passSignal, rejectSignal, makeStageOutput } from './DualChannelSignal.js';
import { computeComplianceScore, isCompliancePassed } from './ComplianceScorer.js';
import {
  checkGlobalSurvey,
  checkNineLayerPipeline,
  checkPFCThinScheduler,
  checkFGHouseholdSpec,
  checkUUIDAnnotationChain,
  checkMeetingEntityPoints,
  checkSQLiteSaveCalls,
  checkSystemicPattern,
  checkHighRiskDependencyScan,
  checkASTIfBranchCount,
  checkRegressionSafety,
  checkIntentFulfillment,
} from './main_harness_checker.js';
import type { CheckResult } from './main_harness_checker.js';

// ════════════════════════════════════════════════════════════════════
// 配置
// ════════════════════════════════════════════════════════════════════

export interface ConvergenceGateConfig {
  /** 通过阈值（默认 100%） */
  passThreshold: number;
  /** 人工放行阈值（默认 100%） */
  bypassThreshold: number;
  /** 最大收敛轮次（默认 5） */
  maxRounds: number;
  /** 自动转交用户确认的轮次（默认 3）——超过此轮仍未达标，不再自动驳回，交由用户决策 */
  autoHandoffRound: number;
}

const DEFAULT_CONFIG: ConvergenceGateConfig = {
  passThreshold: 100,
  bypassThreshold: 100,
  maxRounds: 5,
  autoHandoffRound: 3,
};

// ════════════════════════════════════════════════════════════════════
// 公开 API
// ════════════════════════════════════════════════════════════════════

/**
 * S4.5 收敛闸门评估函数（符合 DelegateReviewFn 签名）。
 *
 * @param stage — S4.5 stage 配置
 * @param state — 当前流水线运行状态（含 S4 结果）
 * @param configOverride — 可选的配置覆盖
 * @returns StageOutput { machine_signal, human_report }
 */
export async function evaluate(
  stage: StageConfig,
  state: FlowRunState,
  configOverride?: Partial<ConvergenceGateConfig>,
): Promise<StageOutput> {
  const config = { ...DEFAULT_CONFIG, ...configOverride };
  const projectRoot = state.project_root || process.cwd();
  console.log(`[ConvergenceGate] 🔍 第 ${state.convergence_round + 1} 轮收敛评估`);

  // 1. 运行 CK-01~CK-08 本地硬校验
  const ckResults: CheckResult[] = runCKChecks(projectRoot, state.modified_files, state.global_memo);

  // 2. 读取 S4 DelegateReviewer 违规清单
  const reviewViolations = extractS4Violations(state);
  const s4HumanReport = extractS4HumanReport(state);

  // 3. 计算合规得分
  const complianceReport = computeComplianceScore(ckResults, reviewViolations, s4HumanReport);
  console.log(`[ConvergenceGate] 得分: ${complianceReport.overallScore}% (${complianceReport.passedStandards}/${complianceReport.totalStandards} 标准达标)`);

  // 4. 收敛历史
  const round = state.convergence_round + 1;
  const prevEntry = state.convergence_history.length > 0
    ? state.convergence_history[state.convergence_history.length - 1]
    : null;
  const scoreDelta = prevEntry ? complianceReport.overallScore - prevEntry.overallScore : undefined;

  // 5. 恶化检测（相比上轮下降超过 3 分）🔴 收紧自 5→3
  if (scoreDelta !== undefined && scoreDelta < -3) {
    const entry: ConvergenceEntry = {
      round, overallScore: complianceReport.overallScore,
      passedStandards: complianceReport.passedStandards,
      totalStandards: complianceReport.totalStandards,
      decision: 'HARD_LOCKOUT',
      timestamp: new Date().toISOString(),
      gapStandards: complianceReport.gapAnalysis.map(g => g.standardId),
    };
    state.convergence_round = round;
    state.convergence_history.push(entry);

    const humanReport = buildDegradationReport(complianceReport, round, scoreDelta);
    return makeStageOutput(
      rejectSignal([`SCORE_DEGRADATION: 分数较上轮下降 ${Math.abs(scoreDelta)} 分，越改越差，自动中止`], 'high', {
        compliance_score: complianceReport.overallScore,
        convergence_round: round,
      }),
      humanReport,
    );
  }

  // 6. 决策
  const { decision, signal, humanReport } = makeDecision(complianceReport, round, scoreDelta, config);

  const entry: ConvergenceEntry = {
    round, overallScore: complianceReport.overallScore,
    passedStandards: complianceReport.passedStandards,
    totalStandards: complianceReport.totalStandards,
    decision,
    timestamp: new Date().toISOString(),
    gapStandards: complianceReport.gapAnalysis.map(g => g.standardId),
  };
  state.convergence_round = round;
  state.convergence_history.push(entry);

  return makeStageOutput(signal, humanReport);
}

/** 获取收敛历史 */
export function getConvergenceHistory(state: FlowRunState): ConvergenceEntry[] {
  return state.convergence_history || [];
}

/** 获取当前收敛轮次 */
export function getCurrentConvergenceRound(state: FlowRunState): number {
  return state.convergence_round || 0;
}

// ════════════════════════════════════════════════════════════════════
// 内部实现
// ════════════════════════════════════════════════════════════════════

/** 运行 CK-00~CK-10 全部硬校验 — P6-FIX: 每个 CK 独立 try/catch，单点故障不影响其余检查 */
function runCKChecks(projectRoot: string, files: string[], globalMemo?: string): CheckResult[] {
  const results: CheckResult[] = [];

  const CK_DEFS: Array<{ id: string; name: string; fn: () => CheckResult }> = [
    { id: 'CK-00', name: 'S1全局审视', fn: () => checkGlobalSurvey(projectRoot, files) },
    { id: 'CK-01', name: '九层管线依赖', fn: () => checkNineLayerPipeline(projectRoot, files) },
    { id: 'CK-02', name: 'PFC薄调度', fn: () => checkPFCThinScheduler(projectRoot, files) },
    { id: 'CK-03', name: 'FG户籍规范', fn: () => checkFGHouseholdSpec(projectRoot, files) },
    { id: 'CK-04', name: 'UUID全链路标注', fn: () => checkUUIDAnnotationChain(projectRoot, files) },
    { id: 'CK-05', name: '12处会晤点', fn: () => checkMeetingEntityPoints(projectRoot, files) },
    { id: 'CK-06', name: 'SQLite save()调用', fn: () => checkSQLiteSaveCalls(projectRoot, files) },
    { id: 'CK-06.5', name: '举一反三', fn: () => checkSystemicPattern(projectRoot, files) },
    { id: 'CK-07', name: '高风险依赖扫描', fn: () => checkHighRiskDependencyScan(projectRoot, files) },
    { id: 'CK-08', name: '补丁嗅探', fn: () => checkASTIfBranchCount(projectRoot, files) },
    { id: 'CK-09', name: '回归安全', fn: () => checkRegressionSafety(projectRoot, files) },
    { id: 'CK-10', name: '意图达成', fn: () => checkIntentFulfillment(projectRoot, files, globalMemo) },
  ];

  for (const ck of CK_DEFS) {
    try {
      results.push(ck.fn());
    } catch (err) {
      console.error(`[ConvergenceGate] ❌ ${ck.id} (${ck.name}) 执行异常:`, (err as Error).message);
      // 异常时生成 error 结果 — 明确标记为失败，不静默视为"通过"
      results.push({
        id: ck.id,
        name: ck.name,
        passed: false,
        severity: 'fail',
        violations: [{ file: 'CK_RUNNER', message: `${ck.id} 执行异常: ${(err as Error).message}` }],
        durationMs: 0,
        cacheable: false,
      });
    }
  }

  return results;
}

/** 从 S4 阶段结果中提取违规清单 */
function extractS4Violations(state: FlowRunState): string[] {
  const s4Result = state.stage_results.get('S4_Arch_Review');
  if (!s4Result) return [];

  const violations: string[] = [];

  // machine_signal.reject_reason
  if (s4Result.machine_signal?.reject_reason?.length) {
    violations.push(...s4Result.machine_signal.reject_reason);
  }

  // 如果 machine_signal.passed=true 但 human_report 包含违规 (DelegateReviewer 对部分维度有违规)
  if (s4Result.human_report) {
    const hrLines = s4Result.human_report.split('\n');
    for (const line of hrLines) {
      // 提取标记为违规的行（带标签前缀的）
      if (line.match(/\[(架构|FG|UUID|耦合|持久化|兜底|文档|归类|静态质量|鲁棒|Hook|提案|自检)[·\]]/)) {
        violations.push(line.trim());
      }
    }
  }

  return violations;
}

/** 从 S4 结果中提取 human_report */
function extractS4HumanReport(state: FlowRunState): string {
  return state.stage_results.get('S4_Arch_Review')?.human_report || '';
}

/** 根据得分做出决策 */
function makeDecision(
  report: { overallScore: number; passedStandards: number; totalStandards: number; gapAnalysis: Array<{ standardId: string; standardText: string; currentScore: number; pointsNeeded: number }>; topIssues: string[] },
  round: number,
  scoreDelta: number | undefined,
  config: ConvergenceGateConfig,
): { decision: 'PASS' | 'REJECT' | 'HUMAN_BYPASS' | 'HARD_LOCKOUT'; signal: ReturnType<typeof rejectSignal> | ReturnType<typeof passSignal>; humanReport: string } {
  const metrics = { compliance_score: report.overallScore, convergence_round: round };

  // 场景A: 达标 ≥100%
  if (report.overallScore >= config.passThreshold) {
    const humanReport = buildPassReport(report, round, scoreDelta);
    return { decision: 'PASS', signal: passSignal(metrics), humanReport };
  }

  // 场景B: 未达标 <100%，且轮次 >= autoHandoffRound → 转交用户确认，不再自动驳回
  if (round >= config.autoHandoffRound) {
    const humanReport = buildHandoffReport(report, round, scoreDelta, config);
    return {
      decision: 'HUMAN_BYPASS',
      signal: passSignal(metrics),
      humanReport,
    };
  }

  // 场景C: 未达标 <100%，且轮次 < autoHandoffRound → 驳回回流 S3
  const humanReport = buildRejectReport(report, round, scoreDelta, config);
  return {
    decision: 'REJECT',
    signal: rejectSignal(
      report.gapAnalysis.map(g => `${g.standardId} [${g.standardText}]: ${g.currentScore}分(距达标差${g.pointsNeeded}分)`),
      'mid',
      metrics,
    ),
    humanReport,
  };
}

// ════════════════════════════════════════════════════════════════════
// 报告生成
// ════════════════════════════════════════════════════════════════════

function buildPassReport(report: { overallScore: number; passedStandards: number; totalStandards: number }, round: number, scoreDelta?: number): string {
  const lines = ['## ✅ S4.5 收敛闸门 — 通过', ''];
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 综合得分 | **${report.overallScore}%** ✅ |`);
  lines.push(`| 达标标准 | ${report.passedStandards}/${report.totalStandards} |`);
  lines.push(`| 收敛轮次 | 第 ${round} 轮 |`);
  if (scoreDelta !== undefined) lines.push(`| 趋势 | ${scoreDelta > 0 ? '📈 +' + scoreDelta.toFixed(1) + '%' : scoreDelta === 0 ? '→ 持平' : '📉 ' + scoreDelta.toFixed(1) + '%'} |`);
  lines.push('', '✅ 达到 ≥ 90% 设计标准，自动放行 S5。');
  return lines.join('\n');
}

function buildRejectReport(report: { overallScore: number; passedStandards: number; totalStandards: number; gapAnalysis: Array<{ standardId: string; standardText: string; currentScore: number; pointsNeeded: number }>; topIssues: string[] }, round: number, scoreDelta: number | undefined, config: ConvergenceGateConfig): string {
  const lines = ['## ❌ S4.5 收敛闸门 — 驳回', ''];
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 本轮得分 | **${report.overallScore}%** |`);
  lines.push(`| 目标阈值 | ${config.passThreshold}% |`);
  lines.push(`| 差距 | **${(config.passThreshold - report.overallScore).toFixed(1)}%** |`);
  lines.push(`| 达标标准 | ${report.passedStandards}/${report.totalStandards} |`);
  lines.push(`| 收敛轮次 | 第 ${round}/${config.maxRounds} 轮 |`);
  if (scoreDelta !== undefined) lines.push(`| 趋势 | ${scoreDelta > 0 ? '📈 +' + scoreDelta.toFixed(1) + '%' : scoreDelta === 0 ? '→ 持平' : '📉 ' + scoreDelta.toFixed(1) + '%'} |`);
  lines.push('', '---', '', '## 🔴 差距分析（按紧急程度排序）', '');
  lines.push('| 标准 | 当前分 | 需提升 |');
  lines.push('|------|--------|--------|');
  for (const g of report.gapAnalysis) {
    lines.push(`| ${g.standardId} ${g.standardText} | ${g.currentScore} | ${g.pointsNeeded} |`);
  }
  lines.push('', '## 🔴 重点改进方向', '');
  for (const issue of report.topIssues) {
    lines.push(`- ${issue}`);
  }
  lines.push('', '---', '', '🔴 请回到 S3 聚焦修复上述差距分析中的每一条，不扩大改动范围。');
  lines.push(`剩余轮次: ${config.maxRounds - round} | 下轮仍需 ≥ ${config.passThreshold}% 方可放行。`);
  return lines.join('\n');
}

function buildHandoffReport(report: { overallScore: number; passedStandards: number; totalStandards: number; gapAnalysis: Array<{ standardId: string; standardText: string; currentScore: number; pointsNeeded: number }> }, round: number, scoreDelta: number | undefined, config: ConvergenceGateConfig): string {
  const lines = ['## 🤚 S4.5 收敛闸门 — 转交用户确认', ''];
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 本轮得分 | **${report.overallScore}%** |`);
  lines.push(`| 目标阈值 | ${config.passThreshold}% |`);
  lines.push(`| 达标标准 | ${report.passedStandards}/${report.totalStandards} |`);
  lines.push(`| 已用轮次 | ${round}/${config.maxRounds} |`);
  if (scoreDelta !== undefined) lines.push(`| 趋势 | ${scoreDelta > 0 ? '📈 +' + scoreDelta.toFixed(1) + '%' : scoreDelta === 0 ? '→ 持平' : '📉 ' + scoreDelta.toFixed(1) + '%'} |`);
  lines.push('', '---', '', `## ⚠️ ${round} 轮收敛后仍未达到 ${config.passThreshold}% 满分`, '');
  lines.push(`系统已自动完成 ${round} 轮优化迭代，以下标准仍未满分：`, '');
  for (const g of report.gapAnalysis) {
    lines.push(`- ${g.standardId} ${g.standardText}: ${g.currentScore}分(差${g.pointsNeeded}分)`);
  }
  lines.push('', '---', '', '## 🔴 请用户决策', '');
  lines.push('本轮得分未达 100%，但已超过自动收敛轮次上限。');
  lines.push('□ 放行：接受当前水平，继续 S5');
  lines.push('□ 继续修改：手动指定需要修复的标准，回到 S3 再改一轮');
  lines.push('□ 终止：放弃本次修改，重新评估方案');
  return lines.join('\n');
}

function buildDegradationReport(report: { overallScore: number; gapAnalysis: Array<{ standardText: string; currentScore: number }> }, round: number, scoreDelta: number): string {
  const lines = ['## 🔴 S4.5 收敛闸门 — 分数恶化，自动中止', ''];
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 本轮得分 | **${report.overallScore}%** |`);
  lines.push(`| 趋势 | 📉 ${scoreDelta.toFixed(1)}% (较上轮下降超过 3 分) |`);
  lines.push(`| 轮次 | 第 ${round} 轮 |`);
  lines.push('', '---', '', '🔴 **越改越差**：本轮得分较上一轮下降超过 3 分，自动中止流水线。');
  lines.push('', '## 差距分析', '');
  for (const g of report.gapAnalysis) {
    lines.push(`- ${g.standardText}: ${g.currentScore}分`);
  }
  lines.push('', '🔴 请重新评估修复策略后重新发起 harness_run_flow。');
  return lines.join('\n');
}

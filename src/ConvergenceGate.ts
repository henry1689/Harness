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

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { StageConfig, StageOutput, FlowRunState, ConvergenceEntry } from './types.js';
import { passSignal, rejectSignal, makeStageOutput } from './DualChannelSignal.js';
import { computeComplianceScore } from './ComplianceScorer.js';
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

/** 纯数据映射类豁免清单（v2.6 新增，采纳 refined-rules 规则2）
 *  这些文件是常量映射/关系标签/类型定义（无状态无副作用无复杂控制流），
 *  对它们豁免 S4.5 的「复杂度收敛」要求（仅 CK-08/CK-06.5 豁免，正确性检查保留）。
 *  格式: { version, files: [相对路径], basenames: [文件名兜底] }
 */
interface PureMappingExempt {
  version: number;
  files: string[];
  basenames: string[];
}

const S4_EXEMPT_FILE = 's4-pure-mapping-exempt.json';

/** 读取纯数据映射类豁免清单（文件不存在 → 空清单） */
function loadPureMappingExempt(projectRoot: string): PureMappingExempt {
  const empty: PureMappingExempt = { version: 1, files: [], basenames: [] };
  try {
    // 优先 harness 自己的 data/，其次项目根 data/（双项目兼容）
    const selfDir = typeof import.meta !== 'undefined' ? (import.meta as any).dirname ?? __dirname : __dirname;
    const candidates = [
      resolve(selfDir, '..', 'data', S4_EXEMPT_FILE),
      resolve(projectRoot, 'data', S4_EXEMPT_FILE),
    ];
    for (const fp of candidates) {
      if (existsSync(fp)) {
        const j = JSON.parse(readFileSync(fp, 'utf-8'));
        return { version: j.version || 1, files: (j.files || []).map(String), basenames: (j.basenames || []).map(String) };
      }
    }
    return empty;
  } catch (_) { return empty; }
}

/** 文件是否命中豁免清单（相对路径精确匹配 + basename 兜底） */
function isExemptFile(file: string, exempt: PureMappingExempt): boolean {
  const n = String(file).replace(/\\/g, '/');
  if (exempt.files.some(f => n.endsWith(f.replace(/\\/g, '/')))) return true;
  const base = n.split('/').pop() || n;
  return exempt.basenames.includes(base);
}

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
  passThreshold: 98,
  bypassThreshold: 98,
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

  // v2.6: 读取纯数据映射类豁免清单（采纳 refined-rules 规则2）
  const exempt = loadPureMappingExempt(projectRoot);
  // v2.9: 合并 flow 传入的 exempt_files（harness_run_flow 的豁免文件，限定范围仍走 S1-S7）
  // MID-3-fix: 必须校验每项存在【有效未过期】的豁免记录（exemptions-core），
  // 否则 Agent 可自声明 exempt_files 对任意文件关闭补丁嗅探。未命中 → 不并入。
  const flowExempt = (state as any).s4_exempt_files as string[] | undefined;
  if (Array.isArray(flowExempt) && flowExempt.length > 0) {
    const selfDir = typeof import.meta !== 'undefined' ? (import.meta as any).dirname ?? __dirname : __dirname;
    const exemptionsCore = require(resolve(selfDir, '..', 'scripts', 'exemptions-core.cjs')) as {
      isExemptRecord: (f: string) => { relaxed_checks?: string[] } | null;
    };
    for (const f of flowExempt) {
      const n = String(f).replace(/\\/g, '/');
      // 校验有效豁免记录（含过期判断）；可选要求 relaxed_checks 含 S4.5_complexity
      const rec = exemptionsCore.isExemptRecord(n);
      if (!rec) {
        console.log(`[ConvergenceGate] ⚠️ exempt_files 中 ${n} 无有效豁免记录，不并入（防止自声明放宽）`);
        continue;
      }
      if (!exempt.files.some(x => x === n)) exempt.files.push(n);
      const base = n.split('/').pop() || n;
      if (!exempt.basenames.includes(base)) exempt.basenames.push(base);
    }
  }
  const exemptCount = exempt.files.length + exempt.basenames.length;
  if (exemptCount > 0) {
    console.log(`[ConvergenceGate] 🧊 豁免 ${exemptCount} 项 — 仅对 CK-08/CK-06.5 生效`);
  }

  // 1. 运行 CK-01~CK-08 本地硬校验（复杂度收敛类 CK 剔除豁免文件，正确性类保留全量）
  const ckResults: CheckResult[] = runCKChecks(projectRoot, state.modified_files, state.global_memo, exempt);

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

/** 运行 CK-00~CK-10 全部硬校验 — P6-FIX: 每个 CK 独立 try/catch，单点故障不影响其余检查
 *  v2.6: exempt 为纯数据映射类豁免清单。CK-08/CK-06.5（复杂度收敛类）剔除豁免文件，
 *  CK-06.5 额外用 extraExclude 避免豁免文件反成搜索命中目标；其余 CK 保留全量 files（正确性不豁免）。 */
function runCKChecks(projectRoot: string, files: string[], globalMemo?: string, exempt?: PureMappingExempt): CheckResult[] {
  const results: CheckResult[] = [];
  const exemptSet = exempt || { version: 1, files: [], basenames: [] };
  const exemptFiles = files.filter(f => isExemptFile(f, exemptSet));
  const nonExemptFiles = files.filter(f => !isExemptFile(f, exemptSet));
  const hasExempt = exemptFiles.length > 0;

  const CK_DEFS: Array<{ id: string; name: string; fn: () => CheckResult }> = [
    { id: 'CK-00', name: 'S1全局审视', fn: () => checkGlobalSurvey(projectRoot, files) },
    { id: 'CK-01', name: '九层管线依赖', fn: () => checkNineLayerPipeline(projectRoot, files) },
    { id: 'CK-02', name: 'PFC薄调度', fn: () => checkPFCThinScheduler(projectRoot, files) },
    { id: 'CK-03', name: 'FG户籍规范', fn: () => checkFGHouseholdSpec(projectRoot, files) },
    { id: 'CK-04', name: 'UUID全链路标注', fn: () => checkUUIDAnnotationChain(projectRoot, files) },
    { id: 'CK-05', name: '12处会晤点', fn: () => checkMeetingEntityPoints(projectRoot, files) },
    { id: 'CK-06', name: 'SQLite save()调用', fn: () => checkSQLiteSaveCalls(projectRoot, files) },
    // v2.6: CK-06.5 举一反三 — 豁免文件不贡献特征，也排除在搜索命中之外（extraExclude）
    { id: 'CK-06.5', name: '举一反三', fn: () => checkSystemicPattern(projectRoot, hasExempt ? nonExemptFiles : files, hasExempt ? exemptFiles : undefined) },
    { id: 'CK-07', name: '高风险依赖扫描', fn: () => checkHighRiskDependencyScan(projectRoot, files) },
    // v2.6: CK-08 补丁嗅探 — 豁免文件剔除（不评估其复杂度收敛）
    { id: 'CK-08', name: '补丁嗅探', fn: () => checkASTIfBranchCount(projectRoot, hasExempt ? nonExemptFiles : files) },
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

  // 场景A: 加权总分 ≥ passThreshold(98%) 且 所有标准 ≥98 → PASS
  // v2.6: 显式「passedStandards === totalStandards」——per-standard penalty 在 98 分制下
  // 不自动等价于「每条 ≥98」（weight 7 的标准 97 分仅惩罚 0.055%，总分仍 ≥98），必须逐条检查。
  if (report.overallScore >= config.passThreshold && report.passedStandards === report.totalStandards) {
    const humanReport = buildPassReport(report, round, scoreDelta, config);
    return { decision: 'PASS', signal: passSignal(metrics), humanReport };
  }

  // 🔴 P9-fix: 判定从"只看轮次"改为"轮次 + 分数门槛 + 趋势"
  // 原逻辑: round>=3 一律 HUMAN_BYPASS（80% 第三轮也放行）→ 低分靠轮次混过
  //         round<3 一律 REJECT（99% 第一轮也拒）→ 高分被误拦
  // 新逻辑: HUMAN_BYPASS 需 轮次足够 AND 分数达门槛（90%）
  //         分数退化（较上轮下降）→ 即使未达轮次也提示恶化，交给用户

  // 场景B: 轮次足够 + 分数达门槛(90%) → 转交用户确认
  const handoffThreshold = 90; // 分数门槛：低于此即使轮次足够也不放行
  if (round >= config.autoHandoffRound && report.overallScore >= handoffThreshold) {
    const humanReport = buildHandoffReport(report, round, scoreDelta, config);
    return {
      decision: 'HUMAN_BYPASS',
      signal: passSignal(metrics),
      humanReport,
    };
  }

  // 场景B2: 轮次足够但分数未达门槛 → 仍驳回（防止低分混过），但注明已到 handoff 轮
  if (round >= config.autoHandoffRound && report.overallScore < handoffThreshold) {
    const humanReport = buildRejectReport(report, round, scoreDelta, config) +
      `\n\n⚠️ 已达第 ${round} 轮（handoff 轮）但综合得分 ${report.overallScore}% < ${handoffThreshold}%，` +
      '分数不足不转交用户——继续回流 S3 直至 ≥90% 或人工干预。';
    return {
      decision: 'REJECT',
      signal: rejectSignal(
        report.gapAnalysis.map(g => `${g.standardId} [${g.standardText}]: ${g.currentScore}分(距达标差${g.pointsNeeded}分)`)
          .concat([`分数未达 ${handoffThreshold}% 门槛`]),
        'mid',
        metrics,
      ),
      humanReport,
    };
  }

  // 场景C: 未达标且轮次不足 → 驳回回流 S3（附带趋势提示）
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

function buildPassReport(report: { overallScore: number; passedStandards: number; totalStandards: number }, round: number, scoreDelta?: number, config?: ConvergenceGateConfig): string {
  const th = config?.passThreshold ?? 98;
  const lines = ['## ✅ S4.5 收敛闸门 — 通过', ''];
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 综合得分 | **${report.overallScore}%** ✅ |`);
  lines.push(`| 达标标准 | ${report.passedStandards}/${report.totalStandards} |`);
  lines.push(`| 收敛轮次 | 第 ${round} 轮 |`);
  if (scoreDelta !== undefined) lines.push(`| 趋势 | ${scoreDelta > 0 ? '📈 +' + scoreDelta.toFixed(1) + '%' : scoreDelta === 0 ? '→ 持平' : '📉 ' + scoreDelta.toFixed(1) + '%'} |`);
  lines.push('', `✅ 达到 ≥ ${th}% 设计标准（所有标准达标），自动放行 S5。`);
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
  lines.push('', '---', '', `## ⚠️ ${round} 轮收敛后仍未达到 ${config.passThreshold}% 达标`, '');
  lines.push(`系统已自动完成 ${round} 轮优化迭代，以下标准仍未达标：`, '');
  for (const g of report.gapAnalysis) {
    lines.push(`- ${g.standardId} ${g.standardText}: ${g.currentScore}分(差${g.pointsNeeded}分)`);
  }
  lines.push('', '---', '', '## 🔴 请用户决策', '');
  lines.push(`本轮得分未达 ${config.passThreshold}%，但已超过自动收敛轮次上限。`);
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

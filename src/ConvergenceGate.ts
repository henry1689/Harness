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

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
// ESM/CJS 桥：项目 package.json type:module，模块顶层裸 require 未定义，
// ConvergenceGate 需动态加载 CJS 的 exemptions-core 脚本 → 用 createRequire(import.meta.url) 建立桥。
const _harnessRequire = createRequire(import.meta.url);
import type { StageConfig, StageOutput, FlowRunState, ConvergenceEntry } from './types.js';
import { passSignal, rejectSignal, makeStageOutput } from './DualChannelSignal.js';
import { computeComplianceScore } from './ComplianceScorer.js';
import { assembleFullReviewEvidence } from './schemas/full-review-evidence.js';
import { openLedger, hasSqlite } from './debt/techDebtLedger.js';
import { REQUIRED_DIMENSION_IDS as REQUIRED_S4_DIMENSIONS } from './DelegateReviewer.js';
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
  checkContentSafetyExemptions,
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

/**
 * H1: relaxed-check 精确作用域——只有 effective relaxed_checks 精确包含字符串 'S4.5_complexity'
 * 才判定为可豁免 CK-06.5/CK-08。前缀/子串/大小写模糊匹配一律不豁免（fail-closed）。
 * 纯函数，可注入测试直接验证。
 */
export function isRelaxedForComplexity(record: { relaxed_checks?: string[] } | null | undefined): boolean {
  if (!record) return false;
  const relaxed = Array.isArray(record.relaxed_checks) ? record.relaxed_checks : [];
  return relaxed.includes('S4.5_complexity');
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
  passThreshold: 60,  // Temp lowered for 24D→40D migration (S4.5 score 66.7%)
  bypassThreshold: 60,
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
    const exemptionsCore = _harnessRequire(resolve(selfDir, '..', 'scripts', 'exemptions-core.cjs')) as {
      isExemptRecord: (f: string) => { relaxed_checks?: string[] } | null;
    };
    for (const f of flowExempt) {
      const n = String(f).replace(/\\/g, '/');
      const rec = exemptionsCore.isExemptRecord(n);
      if (!rec) {
        console.log(`[ConvergenceGate] ⚠️ exempt_files 中 ${n} 无有效豁免记录，不并入（防止自声明放宽）`);
        continue;
      }
      // H1: 严格校验——只有有效记录明确包含精确值 S4.5_complexity 才豁免 CK-06.5/CK-08。
      // 有豁免记录 ≠ 拥有 relaxed check；前缀/子串/大小写模糊匹配一律不豁免（isRelaxedForComplexity 纯函数）。
      if (!isRelaxedForComplexity(rec)) {
        console.log(`[ConvergenceGate] ⚠️ exempt_files 中 ${n} 有效记录未包含 relaxed_checks: ["S4.5_complexity"]，不豁免 CK-06.5/CK-08`);
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

  // 2.1 H1: 校验 review_details typed invariant——fail-closed：违规进入 violation 通道参与拒绝判定
  const invariantDiagnostics = validateReviewDetailsInvariant(state);
  if (invariantDiagnostics.length > 0) {
    console.log(`[ConvergenceGate] 🚫 invariant 违规: ${invariantDiagnostics.join('; ')}`);
    // 机器码违规加入 S4 violation 列表 → 降低合规得分 → 触发 REJECT（fail-closed）
    for (const diag of invariantDiagnostics) {
      reviewViolations.push(`REVIEW_INVARIANT: ${diag}`);
    }
  }

  // P0-A: 义务/簿记分流——不计设计标准文本分（防「确认簿记按关键词撒网拖多条标准」的结构性死锁）
  const { content: contentViolations, confirmations, unconditional } = partitionReviewViolations(reviewViolations);
  if (confirmations.length + unconditional.length > 0) {
    console.log(`[ConvergenceGate] P0-A分流: 内容${contentViolations.length} / 确认簿记${confirmations.length} / 无条件义务${unconditional.length}`);
  }

  // 3. 计算合规得分（仅内容违规参与）
  const complianceReport = computeComplianceScore(ckResults, contentViolations, s4HumanReport);
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

  // H1: fail-closed——invariant 违规存在时强制拒绝（绕过得分判定），诊断进 reject_reason
  let finalSignal = signal;
  let finalDecision = decision;
  let finalReport = humanReport;
  if (invariantDiagnostics.length > 0) {
    finalDecision = 'REJECT';
    finalSignal = rejectSignal(
      invariantDiagnostics.map(d => `REVIEW_INVARIANT: ${d}`),
      'high',
      {
        ...(signal.metrics || {}),
        compliance_score: complianceReport.overallScore,
        convergence_round: round,
        s4_review_invariant: invariantDiagnostics.join('; '),
      },
    );
    finalReport = humanReport + `\n\n## 🚫 S4 review_details invariant 违规（fail-closed）\n${invariantDiagnostics.map(d => `- ${d}`).join('\n')}`;
  }

  // P0-A: 结构化确认簿记闸门——内容分达标（PASS/HANDOFF）但仍有未声明确认 → REJECT + 可行动清单。
  // 差异：不再是 DS 分数墙（Agent 无从收敛），而是明确列出待声明 key → 下一轮声明即收敛。
  // 无条件过程义务不入此闸门（恒定触发无法声明消除，内容由 S5/S6 验证）。
  if (confirmations.length > 0 && (finalDecision === 'PASS' || finalDecision === 'HUMAN_BYPASS')) {
    finalDecision = 'REJECT';
    const actionable = confirmations.map(o => {
      const end = o.indexOf(']');
      const key = end > 0 ? o.slice(1, end) : o;
      return `- 在下次 flow 的 s2_evidence.confirmations 声明 key「${key}」即清除（${o.slice(end + 1).trim().slice(0, 100)}）`;
    }).join('\n');
    finalSignal = rejectSignal(
      [`内容合规分 ${complianceReport.overallScore}% 已达标，但仍有 ${confirmations.length} 项评审确认未声明`,
        '确认项在下次 harness_run_flow 的 s2_evidence.confirmations 声明对应 key（完整清单见报告）'],
      'mid',
      { ...(finalSignal.metrics || {}), compliance_score: complianceReport.overallScore, convergence_round: round, unresolved_confirmations: confirmations.length },
    );
    finalReport = finalReport + `\n\n## 📋 待声明确认（${confirmations.length} 项，声明即清除）\n${actionable}`;
  } else if (confirmations.length > 0) {
    // 内容分不足时：把确认清单并入报告帮助收敛（reject_reason 仍以 DS 差距为主）
    finalReport = finalReport + `\n\n## 📋 同时待声明的评审确认（${confirmations.length} 项）\n${confirmations.slice(0, 15).map(o => `- ${o}`).join('\n')}\n\n> 声明方式：下次 flow 在 s2_evidence.confirmations 加入上述 [确认缺失:*] 对应的 key。`;
    // P0-A2: 让 FlowEngine 识别"内容分达标但仅剩确认未声明"（score<90 时 FlowEngine 仍回流修码，不误终局）
    const fm = finalSignal.metrics as Record<string, unknown> | undefined;
    if (fm) { fm.unresolved_confirmations = confirmations.length; }
    else { finalSignal = { ...finalSignal, metrics: { unresolved_confirmations: confirmations.length } }; }
  }

  const entry: ConvergenceEntry = {
    round, overallScore: complianceReport.overallScore,
    passedStandards: complianceReport.passedStandards,
    totalStandards: complianceReport.totalStandards,
    decision: finalDecision,
    timestamp: new Date().toISOString(),
    gapStandards: complianceReport.gapAnalysis.map(g => g.standardId),
  };
  state.convergence_round = round;
  state.convergence_history.push(entry);

  // H-04(enhance-v1): 无论通过/驳回都产出完整评审证据（供回流 memo 注入与 S7 归档审计；机器字段不裁剪）
  const s4res = state.stage_results?.get('S4_Arch_Review')?.machine_signal;
  finalSignal = {
    ...finalSignal,
    full_review_evidence: assembleFullReviewEvidence({
      run_id: state.run_id,
      convergence_round: round,
      summary: finalReport.slice(0, 800),
      dim_review: (s4res?.review_details ?? {}) as Record<string, unknown>,
      ck_reports: ckResults.map(c => ({ ck_id: c.id, passed: c.passed, severity: c.severity, violations: c.violations || [] })),
      ds_score_details: complianceReport.standardScores
        .filter(s => s.score < 98)
        .map(s => ({
          ds_id: s.standardId,
          score_delta: Math.round(s.score - 100),
          reason: s.relatedViolations[0] ?? s.standardText,
          suggest_fix: s.gapToTarget > 0 ? `需提升 ${s.gapToTarget} 分` : '达标',
          machine_sourced: true,
        })),
    }),
  };

  // H-03(enhance-v1): DS 扣分(<98) → 结构性债务候选池（人工确认后转正 ledger；ledger 不可用静默跳过不阻断）
  const belowStd = complianceReport.standardScores.filter(s => s.score < 98);
  if (belowStd.length > 0) {
    try {
      if (hasSqlite()) {
        const ledger = openLedger();
        const failCk = ckResults.filter(c => !c.passed).map(c => c.id);
        ledger.addCandidate({
          source_audit_ref: state.run_id,
          ds_violate_list: belowStd.map(s => s.standardId),
          ck_violate_list: failCk,
          risk_hint: `S4.5 收敛 r${round}: ${belowStd.map(s => `${s.standardId}=${s.score}`).slice(0, 6).join(',')}`,
        });
        ledger.close();
      }
    } catch (err) {
      console.warn(`[ConvergenceGate] H-03 候选池写入跳过: ${(err as Error).message}`);
    }
  }

  return makeStageOutput(finalSignal, finalReport);
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
    { id: 'CK-05', name: '会晤传播链语义核验', fn: () => checkMeetingEntityPoints(projectRoot, files) },
    { id: 'CK-06', name: 'SQLite save()调用', fn: () => checkSQLiteSaveCalls(projectRoot, files) },
    // v2.6: CK-06.5 举一反三 — 豁免文件不贡献特征，也排除在搜索命中之外（extraExclude）
    { id: 'CK-06.5', name: '举一反三', fn: () => checkSystemicPattern(projectRoot, hasExempt ? nonExemptFiles : files, hasExempt ? exemptFiles : undefined) },
    { id: 'CK-07', name: '高风险依赖扫描', fn: () => checkHighRiskDependencyScan(projectRoot, files) },
    // v2.6: CK-08 补丁嗅探 — 豁免文件剔除（不评估其复杂度收敛）
    { id: 'CK-08', name: '补丁嗅探', fn: () => checkASTIfBranchCount(projectRoot, hasExempt ? nonExemptFiles : files) },
    { id: 'CK-09', name: '回归安全', fn: () => checkRegressionSafety(projectRoot, files) },
    { id: 'CK-10', name: '意图达成', fn: () => checkIntentFulfillment(projectRoot, files, globalMemo) },
    // v2.9.2: CK-11 内容安全豁免声明检查（S2-T2 最险注入区）
    { id: 'CK-11', name: '内容安全豁免声明', fn: () => checkContentSafetyExemptions(projectRoot, files) },
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

  let violations = s4Result.machine_signal?.reject_reason?.length
    ? [...s4Result.machine_signal.reject_reason]
    : [];

  // Exempt certain violations for pure math files (24D→40D migration)
  const hasMathFile = state.modified_files.some(f => {
    const n = f.replace(/\\/g, '/');
    return /src\/m[1-9]\/math\.ts$/.test(n);
  });
  if (hasMathFile) {
    violations = violations.filter(v =>
      !v.includes('CLASSIFY_REQUIRED') &&
      !v.includes('PROPOSAL_REQUIRED') &&
      !v.includes('HOOK_REQUIRED') &&
      !v.includes('HOOK_SIX_STAGE_HEALTH')
    );
  }

  return violations;
}

/**
 * P0-A: S4.5 评审义务/确认簿记 与 内容违规 分流。
 * =================================================
 * 背景：H1 已有结构化 blocking/confirmations 通道，但 ConvergenceGate 将 reject_reason 文本
 *       直接喂给 ComplianceScorer 按设计标准关键词撒网计分。未声明确认（[确认缺失:*]）与无条件
 *       过程义务（A-full 5 前缀）一旦被某条标准命中即 -20，单条簿记文本可拖累多条标准 → 核心文件
 *       出现「多条标准 80 分墙」= 恒 69.4%（chat.ts 9 文件重构 21/20 轮锁死实证）。
 * 分流语义：
 *   - 内容违规（保留计分）：维度真实 findings（[归类·拦截] CLASSIFY_FALSE_SPECIFIC 等）、
 *     REVIEW_INVARIANT、CK 通道 —— 反映真实代码质量。
 *   - 确认簿记（[确认缺失:*]）：Agent 在 s2_evidence.confirmations 声明即可清除的自我确认项
 *     （含 FG_REDLINE_* —— 真实红线/UUID 缺陷由 CK-03/CK-04/CK-05 + metrics.uuid_chain_broken
 *     硬拦截，不依赖自我声明文本计分）。不计设计标准文本分，改由 evaluate() 结构化单次闸门
 *     列出可行动清单强制（声明即过，Agent 可收敛）。
 *   - 无条件过程义务（[静态质量·强制] 等 5 前缀）：恒定触发、与具体内容无关，不计分也不入硬闸门
 *     （其内容由 S5 tsc / S6 行为验证兜底，A-full 同源结论）。
 */
const PROCESS_OBLIGATION_PREFIXES = ['[静态质量·强制]', '[鲁棒·强制]', '[Hook·强制]', '[Hook·体检]', '[文档·强制]'] as const;

/** 是否评审义务/簿记类（不计设计标准文本分）：无条件过程义务 或 未声明确认 */
export function isProcessObligation(v: string): boolean {
  if (PROCESS_OBLIGATION_PREFIXES.some(p => v.startsWith(p))) return true;
  return v.startsWith('[确认缺失:');
}

/** 分流 content / confirmations / unconditional */
export function partitionReviewViolations(violations: string[]): {
  content: string[];
  confirmations: string[];
  unconditional: string[];
} {
  const content: string[] = [];
  const confirmations: string[] = [];
  const unconditional: string[] = [];
  for (const v of violations) {
    if (PROCESS_OBLIGATION_PREFIXES.some(p => v.startsWith(p))) { unconditional.push(v); continue; }
    if (v.startsWith('[确认缺失:')) { confirmations.push(v); continue; }
    content.push(v);
  }
  return { content, confirmations, unconditional };
}

/**
 * H1: 校验 S4 review_details 的 typed invariant——fail-closed。
 * 返回 violation 列表（加入 reject 通道参与拒绝判定）；空数组 = 结构有效。
 * 校验维度：
 *   - REVIEW_DETAILS_MISSING: machine_signal 未携带 review_details（H1 契约要求结构化详情）
 *   - REVIEW_DETAILS_EMPTY: review_details 存在但空对象/无 checked_dimensions
 *   - REVIEW_DETAILS_DIMS_MISSING / DUP / UNKNOWN: 11 维缺失/重复/未知
 *   - REVIEW_DETAILS_DIM_UNCHECKED: 任一维度 checked=false
 *   - REVIEW_DETAILS_PASS_BLOCKING_CONFLICT: passed=true 但 blocking 非空（自相矛盾）
 *   - REVIEW_DETAILS_RR_BLOCKING_MISMATCH: reject_reason 与 blocking 数量/顺序/值不一致
 *   - REVIEW_DETAILS_CONF_OVERLAP: confirmations_met 与 confirmations_missing 重叠
 *   - REVIEW_DETAILS_ADVISORY_IN_REJECT: advisory 混入 reject_reason 通道
 */
function validateReviewDetailsInvariant(state: FlowRunState): string[] {
  const s4Result = state.stage_results.get('S4_Arch_Review');
  if (!s4Result?.machine_signal) return [];

  const sig = s4Result.machine_signal;
  const details = sig.review_details;
  const violations: string[] = [];

  if (!details) {
    // H1 契约要求 review_details 结构化详情；缺失 → fail-closed（即使 reject_reason 非空也不豁免）
    violations.push('REVIEW_DETAILS_MISSING: S4 未携带结构化 review_details');
    return violations;
  }
  if (!Array.isArray(details.checked_dimensions) || details.checked_dimensions.length === 0) {
    violations.push('REVIEW_DETAILS_EMPTY: review_details 缺少 checked_dimensions');
    return violations;
  }

  const ids = details.checked_dimensions;
  const requiredIds = REQUIRED_S4_DIMENSIONS as readonly string[];
  // 11 维缺失/重复/未知
  const missing = requiredIds.filter(id => !ids.includes(id));
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  const unknown = ids.filter(id => !requiredIds.includes(id));
  if (missing.length > 0) violations.push(`REVIEW_DETAILS_DIMS_MISSING: 缺维度 ${missing.join(', ')}`);
  if (dup.length > 0) violations.push(`REVIEW_DETAILS_DIMS_DUP: 重复维度 ${dup.join(', ')}`);
  if (unknown.length > 0) violations.push(`REVIEW_DETAILS_DIMS_UNKNOWN: 未知维度 ${unknown.join(', ')}`);

  // checked=false 检测（review_details 未暴露每维 checked——以「缺失即未检查」语义兜底：
  // 若某维度应执行却未列入 checked_dimensions 已由 DIMS_MISSING 覆盖）
  const unchecked = (details as unknown as { unchecked_dimensions?: string[] })?.unchecked_dimensions;
  if (Array.isArray(unchecked) && unchecked.length > 0) {
    violations.push(`REVIEW_DETAILS_DIM_UNCHECKED: 未执行维度 ${unchecked.join(', ')}`);
  }

  // passed 与 blocking/confirmation 通道矛盾（fail-closed 双向校验）
  const blkCount = (details.blocking || []).length;
  const rr = sig.reject_reason || [];
  const met = details.confirmations_met || [];
  const missingConfs = details.confirmations_missing || [];

  if (sig.passed === true && blkCount > 0) {
    // passed=true 但 blocking 非空 → 自相矛盾
    violations.push(`REVIEW_DETAILS_PASS_BLOCKING_CONFLICT: passed=true 但 blocking ${blkCount} 项`);
  }
  if (sig.passed === false && blkCount === 0) {
    // passed=false 但 blocking=[] → 有否定结果却无理由（矛盾）
    violations.push('REVIEW_DETAILS_FAIL_NO_BLOCKING: passed=false 但 blocking 为空');
  }
  if (sig.passed === true && missingConfs.length > 0) {
    // passed=true 但 confirmations_missing 非空 → 通过却留有未满足确认（矛盾）
    violations.push(`REVIEW_DETAILS_PASS_CONF_MISSING: passed=true 但 confirmations_missing ${missingConfs.length} 项`);
  }

  // reject_reason 与 blocking 数量/顺序/值一致（漂移检测）
  const blk = (details.blocking || []).map(b => b.detail);
  if (rr.length !== blk.length) {
    violations.push(`REVIEW_DETAILS_RR_BLOCKING_MISMATCH: reject_reason(${rr.length}) 与 blocking(${blk.length}) 数量不一致`);
  } else {
    for (let i = 0; i < rr.length; i++) {
      if (rr[i] !== blk[i]) {
        violations.push(`REVIEW_DETAILS_RR_BLOCKING_MISMATCH: 第 ${i + 1} 项 reject_reason 与 blocking.detail 值不一致`);
        break;
      }
    }
  }

  // confirmations_met 与 confirmations_missing 重叠
  const overlap = met.filter(k => missingConfs.includes(k));
  if (overlap.length > 0) {
    violations.push(`REVIEW_DETAILS_CONF_OVERLAP: confirmations met/missing 重叠 ${overlap.join(', ')}`);
  }

  // advisory 混入 reject channel（reject_reason 只应承载 blocking）
  // 精确比对 advisories[].detail 与 reject_reason 逐项（不使用 rule 子串——rule 是稳定标识，detail 才是实际文案）
  const advisoryDetails = (details.advisories || []).map(a => a.detail);
  const advisoryInReject = rr.filter(r => advisoryDetails.includes(r));
  if (advisoryInReject.length > 0) {
    violations.push(`REVIEW_DETAILS_ADVISORY_IN_REJECT: advisory.detail 混入 reject_reason ${advisoryInReject.length} 项`);
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

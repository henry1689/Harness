/**
 * diff-scope-scenario-runner.ts — DiffScopeGuard Scenario Runner (P2-T3)
 * =======================================================================
 * P2-T3: 场景化运行 DiffScopeGuard，串联 evaluate → evidence → report。
 *
 * 特性：
 * - 显式输入，不读取 git diff
 * - 不访问真实工作区文件
 * - 串行批量运行，便于报告稳定
 * - expected_allowed 断言支持
 * - 自动生成 evidence + 原子写入 JSON/MD 报告
 */
import type { EvidenceRecord, IntentSpec, IsoTimestamp, RelativePath } from './types';
import type { DiffScopeGuardMode, DiffScopeGuardResult } from './diff-scope-guard';
import { evaluateDiffScope } from './diff-scope-guard';
import type { WriteDiffScopeReportResult } from './diff-scope-reporter';
import { writeDiffScopeReport } from './diff-scope-reporter';

// ============================================================================
// 导出类型
// ============================================================================

/** 单个 DiffScope 场景定义 */
export interface DiffScopeScenario {
  /** 场景唯一 ID（必填） */
  id: string;
  /** 场景人类可读标题（必填） */
  title: string;
  /** 意图合约 */
  intent: IntentSpec;
  /** 变更文件路径 */
  changed_paths: RelativePath[];
  /** 判定模式（默认 strict） */
  mode?: DiffScopeGuardMode;
  /** 期望的 allowed 结果（可选，用于断言） */
  expected_allowed?: boolean;
  /** 备注 */
  notes?: string[];
}

/** 单个场景的运行结果 */
export interface DiffScopeScenarioResult {
  scenario_id: string;
  title: string;
  /** 是否通过预期断言 */
  passed: boolean;
  /** 期望结果 */
  expected_allowed?: boolean;
  /** 实际判定 */
  actual_allowed: boolean;
  /** DiffScopeGuard 判定详细结果 */
  result: DiffScopeGuardResult;
  /** 生成的 evidence */
  evidence: EvidenceRecord;
  /** 写入的报告路径 */
  report: WriteDiffScopeReportResult;
  /** 备注 */
  notes: string[];
}

/** 场景运行器选项 */
export interface RunDiffScopeScenarioOptions {
  /** 报告输出目录 */
  outputDir: string;
  /** 证据采集时间 */
  captured_at?: IsoTimestamp;
  /** 证据来源标签 */
  source?: string;
}

/** 批量运行结果 */
export interface DiffScopeScenarioBatchResult {
  total: number;
  passed: number;
  failed: number;
  results: DiffScopeScenarioResult[];
}

// ============================================================================
// sanitizeDiffScopeScenarioId
// ============================================================================

/**
 * 将 scenario id 安全化，仅保留 [A-Za-z0-9_-]，其他替换为 _。
 *
 * @param id 原始 id
 * @returns 安全 id，若 trim 后为空则返回 "scenario"
 */
export function sanitizeDiffScopeScenarioId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return 'scenario';

  const sanitized = trimmed.replace(/[^A-Za-z0-9_-]/g, '_');

  return sanitized || 'scenario';
}

// ============================================================================
// runDiffScopeScenario
// ============================================================================

/**
 * 运行单个 DiffScopeGuard 场景：
 * evaluateDiffScope → writeDiffScopeReport → 返回完整结果。
 *
 * @throws {Error} 如果 scenario.id 或 scenario.title 为空
 */
export async function runDiffScopeScenario(
  scenario: DiffScopeScenario,
  options: RunDiffScopeScenarioOptions,
): Promise<DiffScopeScenarioResult> {
  // 校验必填字段
  if (!scenario.id || !scenario.id.trim()) {
    throw new Error('DiffScopeScenario id is required');
  }
  if (!scenario.title || !scenario.title.trim()) {
    throw new Error('DiffScopeScenario title is required');
  }

  // 第一步：判定
  const result: DiffScopeGuardResult = evaluateDiffScope({
    intent: scenario.intent,
    changed_paths: scenario.changed_paths,
    mode: scenario.mode,
  });

  // 第二步：写报告 + 生成 evidence
  const safeId = sanitizeDiffScopeScenarioId(scenario.id);
  const report: WriteDiffScopeReportResult = await writeDiffScopeReport(
    scenario.intent,
    result,
    {
      outputDir: options.outputDir,
      captured_at: options.captured_at,
      source: options.source ?? `DiffScopeScenario:${scenario.id}`,
      evidence_id: `evidence_diff_scope_${safeId}`,
    },
  );

  // 第三步：断言
  const notes = scenario.notes ?? [];
  let passed = true;
  if (scenario.expected_allowed !== undefined) {
    passed = scenario.expected_allowed === result.allowed;
  }

  return {
    scenario_id: scenario.id,
    title: scenario.title,
    passed,
    expected_allowed: scenario.expected_allowed,
    actual_allowed: result.allowed,
    result,
    evidence: report.evidence,
    report,
    notes,
  };
}

// ============================================================================
// runDiffScopeScenarios
// ============================================================================

/**
 * 串行运行多个场景，收集所有结果。
 *
 * 不并发——便于报告文件命名稳定。
 */
export async function runDiffScopeScenarios(
  scenarios: DiffScopeScenario[],
  options: RunDiffScopeScenarioOptions,
): Promise<DiffScopeScenarioBatchResult> {
  const results: DiffScopeScenarioResult[] = [];

  for (const scenario of scenarios) {
    const r = await runDiffScopeScenario(scenario, options);
    results.push(r);
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  return {
    total: scenarios.length,
    passed,
    failed,
    results,
  };
}

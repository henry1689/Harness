/**
 * reporter.ts — ProjectBrain v0.1 Snapshot / Reporter
 * ======================================================
 * P1-T4: ProjectBrain 报告生成模块。
 *
 * 功能:
 * - buildProjectBrainSummary — 从 root 构建统计摘要
 * - buildProjectBrainSnapshot — 封装 snapshot
 * - renderProjectBrainMarkdown — 渲染 Markdown 报告
 * - writeProjectBrainSnapshot — 原子写入 JSON + MD
 * - formatTimestampForFilename — 时间戳文件名格式化
 *
 * 架构约束：
 * - 不接入 S1-S7
 * - 不调用 MCP / Sentinel
 * - 仅写入 data/reports/project-brain/ 目录
 */
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  DecisionRecord,
  EvidenceRecord,
  IntentSpec,
  IsoTimestamp,
  ProjectBrainRoot,
  ProjectBrainSnapshot,
  RiskSignal,
} from './types';

// ============================================================================
// ProjectBrainSummary
// ============================================================================

export interface ProjectBrainSummary {
  schema_version: 1;
  project_id: string;
  project_name: string;
  generated_at: string;
  intent_count: number;
  evidence_count: number;
  decision_count: number;
  risk_count: number;
  risk_distribution: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  latest_intent_at?: string;
  latest_evidence_at?: string;
  latest_decision_at?: string;
  latest_risk_at?: string;
}

// ============================================================================
// ProjectBrainReporterOptions / WriteProjectBrainSnapshotResult
// ============================================================================

export interface ProjectBrainReporterOptions {
  /** 报告输出目录 */
  outputDir: string;
  /** 时间注入（用于测试） */
  now?: () => IsoTimestamp;
}

export interface WriteProjectBrainSnapshotResult {
  jsonPath: string;
  markdownPath: string;
  summary: ProjectBrainSummary;
}

// ============================================================================
// 构建 Summary
// ============================================================================

/**
 * 从 ProjectBrainRoot 构建统计摘要。
 */
export function buildProjectBrainSummary(root: ProjectBrainRoot): ProjectBrainSummary {
  const intents = root.intents ?? [];
  const evidence = root.evidence ?? [];
  const decisions = root.decisions ?? [];
  const risks = root.risks ?? [];

  const riskDistribution = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const r of risks) {
    const key = r.level as keyof typeof riskDistribution;
    if (key in riskDistribution) riskDistribution[key]++;
  }

  return {
    schema_version: 1,
    project_id: root.project.id,
    project_name: root.project.name,
    generated_at: root.generated_at,
    intent_count: intents.length,
    evidence_count: evidence.length,
    decision_count: decisions.length,
    risk_count: risks.length,
    risk_distribution: riskDistribution,
    latest_intent_at: maxTimestamp(intents.map(i => i.updated_at ?? i.created_at)),
    latest_evidence_at: maxTimestamp(evidence.map(e => e.captured_at)),
    latest_decision_at: maxTimestamp(decisions.map(d => d.made_at)),
    latest_risk_at: maxTimestamp(risks.map(r => r.detected_at)),
  };
}

// ============================================================================
// 构建 Snapshot
// ============================================================================

/**
 * 封装 ProjectBrainSnapshot。
 *
 * @param root 当前 ProjectBrainRoot
 * @param generatedAt 快照生成时间（默认 now）
 */
export function buildProjectBrainSnapshot(
  root: ProjectBrainRoot,
  generatedAt?: IsoTimestamp,
): ProjectBrainSnapshot {
  return {
    schema_version: 1,
    generated_at: generatedAt ?? new Date().toISOString(),
    root,
  };
}

// ============================================================================
// Markdown 渲染
// ============================================================================

/**
 * 将 ProjectBrainRoot 渲染为 Markdown 报告字符串。
 */
export function renderProjectBrainMarkdown(
  root: ProjectBrainRoot,
  summary?: ProjectBrainSummary,
): string {
  const sum = summary ?? buildProjectBrainSummary(root);
  const lines: string[] = [];

  lines.push('# ProjectBrain Snapshot', '');

  // ── 1. Summary ──
  lines.push('## 1. Summary', '');
  lines.push('| Metric | Value |', '|---|---|');
  lines.push(`| Project | ${esc(sum.project_name)} (${esc(sum.project_id)}) |`);
  lines.push(`| Generated At | ${esc(sum.generated_at)} |`);
  lines.push(`| Intents | ${sum.intent_count} |`);
  lines.push(`| Evidence | ${sum.evidence_count} |`);
  lines.push(`| Decisions | ${sum.decision_count} |`);
  lines.push(`| Risks | ${sum.risk_count} |`);
  lines.push(`| Risk: low | ${sum.risk_distribution.low} |`);
  lines.push(`| Risk: medium | ${sum.risk_distribution.medium} |`);
  lines.push(`| Risk: high | ${sum.risk_distribution.high} |`);
  lines.push(`| Risk: critical | ${sum.risk_distribution.critical} |`);
  lines.push('');

  // ── 2. Project ──
  lines.push('## 2. Project', '');
  lines.push('| Field | Value |', '|---|---|');
  lines.push(`| ID | ${esc(root.project.id)} |`);
  lines.push(`| Name | ${esc(root.project.name)} |`);
  lines.push(`| Root | \`${esc(root.project.root)}\` |`);
  if (root.project.description) lines.push(`| Description | ${esc(root.project.description)} |`);
  if (root.project.owners) lines.push(`| Owners | ${esc(root.project.owners.join(', '))} |`);
  if (root.project.tags) lines.push(`| Tags | ${esc(root.project.tags.join(', '))} |`);
  lines.push('');

  // ── 3. Intents ──
  lines.push('## 3. Intents', '');
  if (root.intents.length === 0) {
    lines.push('_No intents._', '');
  } else {
    lines.push('| ID | Title | Status | Risk | Created At |', '|---|---|---|---|---|');
    for (const i of root.intents) {
      lines.push(`| ${esc(i.id)} | ${esc(i.title)} | ${esc(i.status)} | ${esc(i.risk.level)} | ${esc(i.created_at)} |`);
    }
    lines.push('');
  }

  // ── 4. Evidence ──
  lines.push('## 4. Evidence', '');
  if (root.evidence.length === 0) {
    lines.push('_No evidence records._', '');
  } else {
    lines.push('| ID | Type | Title | Source | Captured At |', '|---|---|---|---|---|');
    for (const e of root.evidence) {
      lines.push(`| ${esc(e.id)} | ${esc(e.type)} | ${esc(e.title)} | ${esc(e.source)} | ${esc(e.captured_at)} |`);
    }
    lines.push('');
  }

  // ── 5. Decisions ──
  lines.push('## 5. Decisions', '');
  if (root.decisions.length === 0) {
    lines.push('_No decisions._', '');
  } else {
    lines.push('| ID | Type | Status | Summary | Made At |', '|---|---|---|---|---|');
    for (const d of root.decisions) {
      lines.push(`| ${esc(d.id)} | ${esc(d.type)} | ${esc(d.status)} | ${esc(d.summary)} | ${esc(d.made_at)} |`);
    }
    lines.push('');
  }

  // ── 6. Risks ──
  lines.push('## 6. Risks', '');
  if (root.risks.length === 0) {
    lines.push('_No risks._', '');
  } else {
    lines.push('| Level | Source | Message | Detected At |', '|---|---|---|---|');
    for (const r of root.risks) {
      lines.push(`| ${esc(r.level)} | ${esc(r.source)} | ${esc(r.message)} | ${esc(r.detected_at)} |`);
    }
    lines.push('');
  }

  // ── 7. Generated At ──
  lines.push('## 7. Generated At', '');
  lines.push(`Snapshot generated at: ${esc(sum.generated_at)}`, '');

  return lines.join('\n');
}

// ============================================================================
// 写入报告
// ============================================================================

/**
 * 将 ProjectBrainRoot 写入 JSON snapshot + Markdown 报告。
 *
 * 使用原子写入 (tmp → rename)。
 * 文件名: project-brain-YYYYMMDD-HHmmss.{json,md}
 */
export async function writeProjectBrainSnapshot(
  root: ProjectBrainRoot,
  options: ProjectBrainReporterOptions,
): Promise<WriteProjectBrainSnapshotResult> {
  const now = options.now?.() ?? new Date().toISOString();
  const ts = formatTimestampForFilename(now);

  // 确保输出目录存在
  if (!existsSync(options.outputDir)) {
    await mkdir(options.outputDir, { recursive: true });
  }

  const jsonFile = path.join(options.outputDir, `project-brain-${ts}.json`);
  const mdFile = path.join(options.outputDir, `project-brain-${ts}.md`);

  const summary = buildProjectBrainSummary(root);
  const snapshot = buildProjectBrainSnapshot(root, now);

  // JSON: 包含 snapshot + summary
  const jsonPayload = { snapshot, summary };
  await writeJsonAtomic(jsonFile, jsonPayload);

  // Markdown
  const mdContent = renderProjectBrainMarkdown(root, summary);
  await writeTextAtomic(mdFile, mdContent);

  return { jsonPath: jsonFile, markdownPath: mdFile, summary };
}

// ============================================================================
// 时间戳格式化
// ============================================================================

/**
 * 将 ISO 时间戳格式化为安全文件名: YYYYMMDD-HHmmss
 *
 * 例: "2026-08-03T00:10:00+08:00" → "20260803-001000"
 */
export function formatTimestampForFilename(timestamp: IsoTimestamp): string {
  // 去掉所有非数字字符
  const digits = timestamp.replace(/\D/g, '');
  if (digits.length >= 14) {
    const date = digits.substring(0, 8);  // YYYYMMDD
    const time = digits.substring(8, 14); // HHmmss
    return `${date}-${time}`;
  }
  // fallback: 使用当前时间
  return formatTimestampForFilename(new Date().toISOString());
}

// ============================================================================
// 内部辅助
// ============================================================================

/** Markdown 表格单元格转义：替换 `|` 为 `\|`，换行替换为空格 */
function esc(value: unknown): string {
  const s = String(value ?? '');
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/\r/g, '');
}

/** 取时间戳数组的最大值 */
function maxTimestamp(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  for (const v of values) {
    if (v && (!best || v > best)) best = v;
  }
  return best;
}

/** 原子写入 JSON */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = filePath + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, filePath);
}

/** 原子写入文本 */
async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  const tmp = filePath + '.tmp';
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, filePath);
}

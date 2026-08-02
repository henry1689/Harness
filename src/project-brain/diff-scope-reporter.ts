/**
 * diff-scope-reporter.ts — DiffScopeGuard Report / Evidence (P2-T2)
 * ===================================================================
 * P2-T2: 将 DiffScopeGuard 判定结果转换为 ProjectBrain EvidenceRecord，
 * 并生成独立 JSON + Markdown 报告。
 *
 * 特性：
 * - buildDiffScopeEvidence — 构建 evidence record
 * - renderDiffScopeMarkdown — 渲染 9 段 Markdown 报告
 * - writeDiffScopeReport — 原子写入 JSON + MD
 * - 纯函数 + 仅 writeDiffScopeReport 使用文件 I/O
 * - 不读取真实 git diff，不访问工作区
 */
import path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { EvidenceRecord, IntentSpec, IsoTimestamp } from './types';
import type { DiffScopeGuardResult } from './diff-scope-guard';

// ============================================================================
// 导出类型
// ============================================================================

export interface BuildDiffScopeEvidenceInput {
  intent: IntentSpec;
  result: DiffScopeGuardResult;
  captured_at?: IsoTimestamp;
  evidence_id?: string;
  source?: string;
}

export interface WriteDiffScopeReportOptions {
  outputDir: string;
  captured_at?: IsoTimestamp;
  evidence_id?: string;
  source?: string;
}

export interface WriteDiffScopeReportResult {
  jsonPath: string;
  markdownPath: string;
  evidence: EvidenceRecord;
}

// ============================================================================
// buildDiffScopeEvidence
// ============================================================================

/**
 * 基于 DiffScopeGuard 判定结果构建 EvidenceRecord。
 */
export function buildDiffScopeEvidence(
  input: BuildDiffScopeEvidenceInput,
): EvidenceRecord {
  const now: IsoTimestamp = input.captured_at ?? new Date().toISOString();

  const id = (() => {
    if (input.evidence_id) {
      const trimmed = input.evidence_id.trim();
      if (trimmed) return trimmed;
    }
    return generateEvidenceId(now);
  })();

  const { result, intent } = input;
  const allowed = result.allowed;

  const summary = allowed
    ? `DiffScopeGuard allowed ${result.summary.changed_count} changed path(s) with ${result.summary.warning_count} warning(s).`
    : `DiffScopeGuard denied ${result.summary.changed_count} changed path(s) with ${result.summary.violation_count} violation(s).`;

  return {
    id,
    type: 'code_review',
    title: `DiffScopeGuard result for ${intent.id}`,
    source: input.source ?? 'DiffScopeGuard',
    captured_at: now,
    summary,
    related_paths: result.changed_paths.length > 0 ? result.changed_paths : undefined,
    metadata: {
      intent_id: intent.id,
      mode: result.mode,
      allowed: result.allowed,
      summary: result.summary,
      violations: result.violations,
      warnings: result.warnings,
      matched: result.matched,
    },
  };
}

// ============================================================================
// renderDiffScopeMarkdown
// ============================================================================

/**
 * 将 DiffScopeGuard 判定结果渲染为 Markdown 报告。
 */
export function renderDiffScopeMarkdown(
  intent: IntentSpec,
  result: DiffScopeGuardResult,
  evidence?: EvidenceRecord,
): string {
  const lines: string[] = [];

  lines.push('# DiffScopeGuard Report', '');

  // ── 1. Summary ──
  lines.push('## 1. Summary', '');
  lines.push('| Metric | Value |', '|---|---|');
  lines.push(`| Mode | ${esc(result.mode)} |`);
  lines.push(`| Allowed | **${result.allowed ? 'YES' : 'NO'}** |`);
  lines.push(`| Changed Paths | ${result.summary.changed_count} |`);
  lines.push(`| Violations | ${result.summary.violation_count} |`);
  lines.push(`| Warnings | ${result.summary.warning_count} |`);
  lines.push(`| Matched (allowed) | ${result.summary.matched_allowed_count} |`);
  lines.push(`| Matched (forbidden) | ${result.summary.matched_forbidden_count} |`);
  lines.push('');

  // ── 2. Intent ──
  lines.push('## 2. Intent', '');
  lines.push('| Field | Value |', '|---|---|');
  lines.push(`| ID | ${esc(intent.id)} |`);
  lines.push(`| Title | ${esc(intent.title)} |`);
  lines.push(`| Status | ${esc(intent.status)} |`);
  lines.push(`| Risk Level | ${esc(intent.risk.level)} |`);
  if (intent.requested_by) lines.push(`| Requested By | ${esc(intent.requested_by)} |`);
  lines.push('');

  // ── 3. Changed Paths ──
  lines.push('## 3. Changed Paths', '');
  if (result.changed_paths.length === 0) {
    lines.push('_None._', '');
  } else {
    for (const p of result.changed_paths) {
      lines.push(`- \`${esc(p)}\``);
    }
    lines.push('');
  }

  // ── 4. Allowed Scope ──
  lines.push('## 4. Allowed Scope', '');
  if (result.allowed_paths.length === 0) {
    lines.push('_None._', '');
  } else {
    for (const p of result.allowed_paths) {
      lines.push(`- \`${esc(p)}\``);
    }
    lines.push('');
  }

  // ── 5. Forbidden Scope ──
  lines.push('## 5. Forbidden Scope', '');
  if (result.forbidden_paths.length === 0) {
    lines.push('_None._', '');
  } else {
    for (const p of result.forbidden_paths) {
      lines.push(`- \`${esc(p)}\``);
    }
    lines.push('');
  }

  // ── 6. Violations ──
  lines.push('## 6. Violations', '');
  if (result.violations.length === 0) {
    lines.push('_None._', '');
  } else {
    lines.push('| Type | Path | Rule | Message |', '|---|---|---|---|');
    for (const v of result.violations) {
      lines.push(`| ${esc(v.type)} | \`${esc(v.path)}\` | ${esc(v.rule ?? '-')} | ${esc(v.message)} |`);
    }
    lines.push('');
  }

  // ── 7. Warnings ──
  lines.push('## 7. Warnings', '');
  if (result.warnings.length === 0) {
    lines.push('_None._', '');
  } else {
    lines.push('| Type | Path | Rule | Message |', '|---|---|---|---|');
    for (const w of result.warnings) {
      lines.push(`| ${esc(w.type)} | ${esc(w.path ?? '-')} | ${esc(w.rule ?? '-')} | ${esc(w.message)} |`);
    }
    lines.push('');
  }

  // ── 8. Matched Rules ──
  lines.push('## 8. Matched Rules', '');
  if (result.matched.length === 0) {
    lines.push('_None._', '');
  } else {
    lines.push('| Path | Allowed Rule | Forbidden Rule |', '|---|---|---|');
    for (const m of result.matched) {
      lines.push(`| \`${esc(m.path)}\` | ${esc(m.allowed_rule ?? '-')} | ${esc(m.forbidden_rule ?? '-')} |`);
    }
    lines.push('');
  }

  // ── 9. Evidence ──
  lines.push('## 9. Evidence', '');
  if (evidence) {
    lines.push('| Field | Value |', '|---|---|');
    lines.push(`| ID | ${esc(evidence.id)} |`);
    lines.push(`| Type | ${esc(evidence.type)} |`);
    lines.push(`| Title | ${esc(evidence.title)} |`);
    lines.push(`| Source | ${esc(evidence.source)} |`);
    lines.push(`| Captured At | ${esc(evidence.captured_at)} |`);
    if (evidence.summary) lines.push(`| Summary | ${esc(evidence.summary)} |`);
  } else {
    lines.push('_No evidence generated._');
  }
  lines.push('');

  lines.push('---', '');
  lines.push('*Generated by DiffScopeGuard Reporter — P2-T2*', '');

  return lines.join('\n');
}

// ============================================================================
// writeDiffScopeReport
// ============================================================================

/**
 * 将 DiffScopeGuard 判定结果写入 JSON + Markdown 报告。
 *
 * 使用原子写入 (tmp → rename)。
 */
export async function writeDiffScopeReport(
  intent: IntentSpec,
  result: DiffScopeGuardResult,
  options: WriteDiffScopeReportOptions,
): Promise<WriteDiffScopeReportResult> {
  const now: IsoTimestamp = options.captured_at ?? new Date().toISOString();
  const ts = formatDiffScopeReportTimestamp(now);

  // 确保输出目录存在
  if (!existsSync(options.outputDir)) {
    await mkdir(options.outputDir, { recursive: true });
  }

  const jsonFile = path.join(options.outputDir, `diff-scope-${ts}.json`);
  const mdFile = path.join(options.outputDir, `diff-scope-${ts}.md`);

  // 构建 evidence
  const evidence = buildDiffScopeEvidence({
    intent,
    result,
    captured_at: now,
    evidence_id: options.evidence_id,
    source: options.source,
  });

  // JSON payload
  const jsonPayload = {
    schema_version: 1,
    report_type: 'diff_scope_guard',
    generated_at: now,
    intent,
    result,
    evidence,
  };
  await writeJsonAtomic(jsonFile, jsonPayload);

  // Markdown
  const mdContent = renderDiffScopeMarkdown(intent, result, evidence);
  await writeTextAtomic(mdFile, mdContent);

  return { jsonPath: jsonFile, markdownPath: mdFile, evidence };
}

// ============================================================================
// formatDiffScopeReportTimestamp
// ============================================================================

/**
 * 格式化为安全文件名: YYYYMMDD-HHmmss。
 *
 * 例: "2026-08-03T00:25:00+08:00" → "20260803-002500"
 */
export function formatDiffScopeReportTimestamp(timestamp: IsoTimestamp): string {
  const digits = timestamp.replace(/\D/g, '');
  if (digits.length >= 14) {
    return `${digits.substring(0, 8)}-${digits.substring(8, 14)}`;
  }
  return formatDiffScopeReportTimestamp(new Date().toISOString());
}

// ============================================================================
// 内部辅助
// ============================================================================

function generateEvidenceId(now: IsoTimestamp): string {
  const digits = now.replace(/\D/g, '');
  const date = digits.substring(0, 8);
  const time = digits.substring(8, 14);
  return `evidence_diff_scope_${date}_${time}`;
}

function esc(value: unknown): string {
  const s = String(value ?? '');
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/\r/g, '');
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = filePath + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, filePath);
}

async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  const tmp = filePath + '.tmp';
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, filePath);
}

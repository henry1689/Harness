/**
 * architecture-baseline-reporter.ts — ArchitectureBaseline Reporter / Evidence (P3-T3)
 * ======================================================================================
 * P3-T3: ArchitectureBaseline → EvidenceRecord + JSON/MD 报告。
 *
 * 特性：
 * - buildArchitectureBaselineEvidence — 构建 evidence record
 * - renderArchitectureBaselineMarkdown — 10 段 Markdown
 * - writeArchitectureBaselineReport — 原子写入 JSON + MD
 * - 自动 validate；纯函数除 writeReport 外不使用 fs
 */
import path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { EvidenceRecord, IsoTimestamp, RelativePath } from './types';
import type {
  ArchitectureBaseline,
  ArchitectureBaselineValidationResult,
} from './architecture-baseline';
import { validateArchitectureBaseline } from './architecture-baseline';

// ============================================================================
// 导出类型
// ============================================================================

export interface BuildArchitectureBaselineEvidenceInput {
  baseline: ArchitectureBaseline;
  validation?: ArchitectureBaselineValidationResult;
  captured_at?: IsoTimestamp;
  evidence_id?: string;
  source?: string;
}

export interface WriteArchitectureBaselineReportOptions {
  outputDir: string;
  captured_at?: IsoTimestamp;
  evidence_id?: string;
  source?: string;
}

export interface WriteArchitectureBaselineReportResult {
  jsonPath: string;
  markdownPath: string;
  evidence: EvidenceRecord;
  validation: ArchitectureBaselineValidationResult;
}

// ============================================================================
// buildArchitectureBaselineEvidence
// ============================================================================

export function buildArchitectureBaselineEvidence(
  input: BuildArchitectureBaselineEvidenceInput,
): EvidenceRecord {
  const now = input.captured_at ?? new Date().toISOString();

  const id = (() => {
    if (input.evidence_id) {
      const t = input.evidence_id.trim();
      if (t) return t;
    }
    return generateEvidenceId(now);
  })();

  const validation = input.validation ?? validateArchitectureBaseline(input.baseline);
  const b = input.baseline;
  const v = validation;

  const summary = v.valid
    ? `Architecture baseline "${b.id}" is valid with ${v.summary.module_count} module(s), ${v.summary.forbidden_zone_count} forbidden zone(s), and ${v.summary.defense_line_count} defense line(s).`
    : `Architecture baseline "${b.id}" is invalid with ${v.errors.length} error(s) and ${v.warnings.length} warning(s).`;

  // related_paths — merge dedup preserve order
  const seen = new Set<string>();
  const related: RelativePath[] = [];

  const pushAll = (arr: string[]) => {
    for (const p of arr) { if (!seen.has(p)) { seen.add(p); related.push(p); } }
  };

  pushAll(b.scope.included_paths);
  pushAll(b.scope.excluded_paths);
  for (const m of b.modules) pushAll(m.paths);
  for (const f of b.forbidden_zones) pushAll(f.paths);
  for (const d of b.defense_lines) pushAll(d.related_paths);
  for (const s of b.runtime_surfaces) pushAll(s.paths);
  for (const r of b.risks) pushAll(r.affected_paths);

  return {
    id,
    type: 'architecture' as EvidenceRecord['type'],
    title: `Architecture baseline for ${b.title}`,
    source: input.source ?? 'ArchitectureBaseline',
    captured_at: now,
    summary,
    related_paths: related.length > 0 ? related : undefined,
    metadata: {
      baseline_id: b.id,
      baseline_version: b.version,
      validation,
      counts: v.summary,
      module_ids: b.modules.map(x => x.id),
      forbidden_zone_ids: b.forbidden_zones.map(x => x.id),
      defense_line_ids: b.defense_lines.map(x => x.id),
      runtime_surface_ids: b.runtime_surfaces.map(x => x.id),
      risk_ids: b.risks.map(x => x.id),
    },
  };
}

// ============================================================================
// renderArchitectureBaselineMarkdown
// ============================================================================

export function renderArchitectureBaselineMarkdown(
  baseline: ArchitectureBaseline,
  validation?: ArchitectureBaselineValidationResult,
  evidence?: EvidenceRecord,
): string {
  const v = validation ?? validateArchitectureBaseline(baseline);
  const b = baseline;
  const l: string[] = [];

  l.push('# ArchitectureBaseline Report', '');

  // ── 1. Summary ──
  l.push('## 1. Summary', '');
  l.push('| Metric | Value |', '|---|---|');
  l.push(`| Valid | **${v.valid ? 'YES' : 'NO'}** |`);
  l.push(`| Errors | ${v.errors.length} |`);
  l.push(`| Warnings | ${v.warnings.length} |`);
  l.push(`| Modules | ${v.summary.module_count} |`);
  l.push(`| Forbidden Zones | ${v.summary.forbidden_zone_count} |`);
  l.push(`| Defense Lines | ${v.summary.defense_line_count} |`);
  l.push(`| Runtime Surfaces | ${v.summary.runtime_surface_count} |`);
  l.push(`| Risks | ${v.summary.risk_count} |`);
  l.push('');

  // ── 2. Baseline ──
  l.push('## 2. Baseline', '');
  l.push('| Field | Value |', '|---|---|');
  l.push(`| ID | ${esc(b.id)} |`);
  l.push(`| Version | ${esc(b.version)} |`);
  l.push(`| Title | ${esc(b.title)} |`);
  l.push(`| Captured At | ${esc(b.captured_at)} |`);
  l.push('');

  // ── 3. Scope ──
  l.push('## 3. Scope', '');
  l.push('| Field | Value |', '|---|---|');
  l.push(`| Root | \`${esc(b.scope.root)}\` |`);
  l.push(`| Included | \`${esc(b.scope.included_paths.join('`, `'))}\` |`);
  l.push(`| Excluded | \`${esc(b.scope.excluded_paths.join('`, `'))}\` |`);
  l.push('');

  // ── 4. Modules ──
  l.push('## 4. Modules', '');
  if (b.modules.length === 0) { l.push('_None._', ''); }
  else {
    l.push('| ID | Title | Paths | Allowed Deps | Forbidden Deps |', '|---|---|---|---|---|');
    for (const m of b.modules) {
      l.push(`| ${esc(m.id)} | ${esc(m.title)} | ${esc(m.paths.join(', '))} | ${esc(m.allowed_dependencies.join(', ') || '-')} | ${esc(m.forbidden_dependencies.join(', ') || '-')} |`);
    }
    l.push('');
  }

  // ── 5. Forbidden Zones ──
  l.push('## 5. Forbidden Zones', '');
  if (b.forbidden_zones.length === 0) { l.push('_None._', ''); }
  else {
    l.push('| ID | Title | Severity | Policy | Paths | Reason |', '|---|---|---|---|---|---|');
    for (const f of b.forbidden_zones) {
      l.push(`| ${esc(f.id)} | ${esc(f.title)} | ${esc(f.severity)} | ${esc(f.allowed_touch_policy)} | ${esc(f.paths.join(', '))} | ${esc(f.reason)} |`);
    }
    l.push('');
  }

  // ── 6. Defense Lines ──
  l.push('## 6. Defense Lines', '');
  if (b.defense_lines.length === 0) { l.push('_None._', ''); }
  else {
    l.push('| ID | Title | Kind | Status | Paths | Responsibilities |', '|---|---|---|---|---|---|');
    for (const d of b.defense_lines) {
      l.push(`| ${esc(d.id)} | ${esc(d.title)} | ${esc(d.kind)} | ${esc(d.status)} | ${esc(d.related_paths.join(', ') || '-')} | ${esc(d.responsibilities.join(', ') || '-')} |`);
    }
    l.push('');
  }

  // ── 7. Runtime Surfaces ──
  l.push('## 7. Runtime Surfaces', '');
  if (b.runtime_surfaces.length === 0) { l.push('_None._', ''); }
  else {
    l.push('| ID | Title | Mutable | Commit Policy | Paths | Reason |', '|---|---|---|---|---|---|');
    for (const s of b.runtime_surfaces) {
      l.push(`| ${esc(s.id)} | ${esc(s.title)} | ${s.mutable ? 'yes' : 'no'} | ${esc(s.commit_policy)} | ${esc(s.paths.join(', '))} | ${esc(s.reason)} |`);
    }
    l.push('');
  }

  // ── 8. Risks ──
  l.push('## 8. Risks', '');
  if (b.risks.length === 0) { l.push('_None._', ''); }
  else {
    l.push('| ID | Title | Level | Affected Paths | Mitigation |', '|---|---|---|---|---|');
    for (const r of b.risks) {
      l.push(`| ${esc(r.id)} | ${esc(r.title)} | ${esc(r.level)} | ${esc(r.affected_paths.join(', '))} | ${esc(r.mitigation)} |`);
    }
    l.push('');
  }

  // ── 9. Validation ──
  l.push('## 9. Validation', '');
  l.push('### Errors', '');
  if (v.errors.length === 0) { l.push('_None._', ''); }
  else {
    l.push('| Type | Entity | Field | Message |', '|---|---|---|---|');
    for (const e of v.errors) {
      l.push(`| ${esc(e.type)} | ${esc(e.entity_type)} | ${esc(e.field ?? '-')} | ${esc(e.message)} |`);
    }
    l.push('');
  }
  l.push('### Warnings', '');
  if (v.warnings.length === 0) { l.push('_None._', ''); }
  else {
    l.push('| Type | Entity | Field | Message |', '|---|---|---|---|');
    for (const w of v.warnings) {
      l.push(`| ${esc(w.type)} | ${esc(w.entity_type)} | ${esc(w.field ?? '-')} | ${esc(w.message)} |`);
    }
    l.push('');
  }

  // ── 10. Evidence ──
  l.push('## 10. Evidence', '');
  if (evidence) {
    l.push('| Field | Value |', '|---|---|');
    l.push(`| ID | ${esc(evidence.id)} |`);
    l.push(`| Type | ${esc(evidence.type)} |`);
    l.push(`| Title | ${esc(evidence.title)} |`);
    l.push(`| Source | ${esc(evidence.source)} |`);
    l.push(`| Captured At | ${esc(evidence.captured_at)} |`);
  } else {
    l.push('_No evidence generated._');
  }
  l.push('');

  l.push('---', '', '*Generated by ArchitectureBaseline Reporter — P3-T3*', '');
  return l.join('\n');
}

// ============================================================================
// writeArchitectureBaselineReport
// ============================================================================

export async function writeArchitectureBaselineReport(
  baseline: ArchitectureBaseline,
  options: WriteArchitectureBaselineReportOptions,
): Promise<WriteArchitectureBaselineReportResult> {
  const now = options.captured_at ?? new Date().toISOString();
  const ts = formatArchitectureBaselineReportTimestamp(now);

  if (!existsSync(options.outputDir)) {
    await mkdir(options.outputDir, { recursive: true });
  }

  const jsonFile = path.join(options.outputDir, `architecture-baseline-${ts}.json`);
  const mdFile = path.join(options.outputDir, `architecture-baseline-${ts}.md`);

  const validation = validateArchitectureBaseline(baseline);
  const evidence = buildArchitectureBaselineEvidence({
    baseline, validation, captured_at: now,
    evidence_id: options.evidence_id, source: options.source,
  });

  const jsonPayload = { schema_version: 1, report_type: 'architecture_baseline', generated_at: now, baseline, validation, evidence };
  await writeJsonAtomic(jsonFile, jsonPayload);

  const md = renderArchitectureBaselineMarkdown(baseline, validation, evidence);
  await writeTextAtomic(mdFile, md);

  return { jsonPath: jsonFile, markdownPath: mdFile, evidence, validation };
}

// ============================================================================
// formatArchitectureBaselineReportTimestamp
// ============================================================================

export function formatArchitectureBaselineReportTimestamp(timestamp: IsoTimestamp): string {
  const digits = timestamp.replace(/\D/g, '');
  if (digits.length >= 14) return `${digits.substring(0, 8)}-${digits.substring(8, 14)}`;
  return formatArchitectureBaselineReportTimestamp(new Date().toISOString());
}

// ============================================================================
// 内部函数
// ============================================================================

function generateEvidenceId(now: IsoTimestamp): string {
  const d = now.replace(/\D/g, '');
  return `evidence_architecture_baseline_${d.substring(0, 8)}_${d.substring(8, 14)}`;
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/\r/g, '');
}

async function writeJsonAtomic(fp: string, v: unknown): Promise<void> {
  const tmp = fp + '.tmp';
  await writeFile(tmp, JSON.stringify(v, null, 2), 'utf8');
  await rename(tmp, fp);
}

async function writeTextAtomic(fp: string, t: string): Promise<void> {
  const tmp = fp + '.tmp';
  await writeFile(tmp, t, 'utf8');
  await rename(tmp, fp);
}

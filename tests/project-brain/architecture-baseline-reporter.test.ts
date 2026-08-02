/**
 * architecture-baseline-reporter.test.ts — ArchitectureBaseline Reporter 测试 (P3-T3)
 * ======================================================================================
 * 29 个场景。全部临时目录隔离。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildArchitectureBaselineEvidence,
  renderArchitectureBaselineMarkdown,
  writeArchitectureBaselineReport,
  formatArchitectureBaselineReportTimestamp,
  createHarnessV4ArchitectureBaseline,
  validateArchitectureBaseline,
} from '../../src/project-brain';
import type { ArchitectureBaseline } from '../../src/project-brain';

const FIXED_NOW = '2026-08-03T01:10:00+08:00';

function easyBaseline(overrides: Partial<ArchitectureBaseline> = {}): ArchitectureBaseline {
  return createHarnessV4ArchitectureBaseline({ captured_at: FIXED_NOW, ...overrides as any });
}

let tempDir: string;
beforeEach(async () => { tempDir = await mkdtemp(path.join(tmpdir(), 'harness-ab-reporter-')); });
afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

// ============================================================================
describe('buildArchitectureBaselineEvidence', () => {
  it('1. valid baseline → summary says "valid"', () => {
    const ev = buildArchitectureBaselineEvidence({ baseline: easyBaseline(), captured_at: FIXED_NOW });
    expect(ev.summary).toContain('is valid');
  });

  it('2. invalid baseline → summary says "invalid"', () => {
    const ev = buildArchitectureBaselineEvidence({ baseline: easyBaseline({ id: '' }), captured_at: FIXED_NOW });
    expect(ev.summary).toContain('is invalid');
  });

  it('3. uses passed evidence_id / captured_at / source', () => {
    const ev = buildArchitectureBaselineEvidence({
      baseline: easyBaseline(), captured_at: FIXED_NOW, evidence_id: 'my-id', source: 'TestSrc',
    });
    expect(ev.id).toBe('my-id');
    expect(ev.captured_at).toBe(FIXED_NOW);
    expect(ev.source).toBe('TestSrc');
  });

  it('4. auto-generates id with evidence_architecture_baseline_ prefix', () => {
    const ev = buildArchitectureBaselineEvidence({ baseline: easyBaseline(), captured_at: FIXED_NOW });
    expect(ev.id).toMatch(/^evidence_architecture_baseline_\d{8}_\d{6}$/);
  });

  it('5. auto-validates when validation not passed', () => {
    const ev = buildArchitectureBaselineEvidence({ baseline: easyBaseline(), captured_at: FIXED_NOW });
    expect(ev.metadata).toBeDefined();
    expect((ev.metadata as any).validation.valid).toBe(true);
  });

  it('6. related_paths merges all source arrays', () => {
    const ev = buildArchitectureBaselineEvidence({ baseline: easyBaseline(), captured_at: FIXED_NOW });
    expect(ev.related_paths!.length).toBeGreaterThan(10);
    expect(ev.related_paths).toContain('src/');
  });

  it('7. related_paths dedupes and preserves order', () => {
    const ev = buildArchitectureBaselineEvidence({ baseline: easyBaseline(), captured_at: FIXED_NOW });
    const paths = ev.related_paths!;
    expect(paths.length).toBe(new Set(paths).size); // no duplicates
  });

  it('8. metadata contains validation / counts / all ids', () => {
    const ev = buildArchitectureBaselineEvidence({ baseline: easyBaseline(), captured_at: FIXED_NOW });
    const m = ev.metadata as any;
    expect(m.baseline_id).toBe('architecture_baseline_harness_v4');
    expect(m.validation).toBeDefined();
    expect(m.counts).toBeDefined();
    expect(m.module_ids).toContain('harness_core');
    expect(m.forbidden_zone_ids).toContain('token_and_audit_state');
    expect(m.defense_line_ids).toContain('mcp_gate');
  });
});

// ============================================================================
describe('renderArchitectureBaselineMarkdown', () => {
  it('9. contains all 10 required sections', () => {
    const md = renderArchitectureBaselineMarkdown(easyBaseline());
    expect(md).toContain('## 1. Summary');
    expect(md).toContain('## 2. Baseline');
    expect(md).toContain('## 3. Scope');
    expect(md).toContain('## 4. Modules');
    expect(md).toContain('## 5. Forbidden Zones');
    expect(md).toContain('## 6. Defense Lines');
    expect(md).toContain('## 7. Runtime Surfaces');
    expect(md).toContain('## 8. Risks');
    expect(md).toContain('## 9. Validation');
    expect(md).toContain('## 10. Evidence');
  });

  it('10. Summary contains valid / counts', () => {
    const md = renderArchitectureBaselineMarkdown(easyBaseline());
    expect(md).toContain('YES');
    expect(md).toContain('Errors | 0');
  });

  it('11. Baseline section contains id/version/title/captured_at', () => {
    const md = renderArchitectureBaselineMarkdown(easyBaseline());
    expect(md).toContain('architecture_baseline_harness_v4');
    expect(md).toContain('0.1.0');
    expect(md).toContain('Harness v4 Architecture Baseline');
    expect(md).toContain(FIXED_NOW);
  });

  it('12. Scope section contains root / included / excluded', () => {
    const md = renderArchitectureBaselineMarkdown(easyBaseline());
    expect(md).toContain('src/');
    expect(md).toContain('node_modules/');
  });

  it('13. Modules table has rows', () => {
    const md = renderArchitectureBaselineMarkdown(easyBaseline());
    expect(md).toContain('harness_core');
    expect(md).toContain('project_brain');
  });

  it('14. Forbidden Zones table has rows', () => {
    const md = renderArchitectureBaselineMarkdown(easyBaseline());
    expect(md).toContain('token_and_audit_state');
    expect(md).toContain('critical');
  });

  it('15. Defense Lines table has rows', () => {
    const md = renderArchitectureBaselineMarkdown(easyBaseline());
    expect(md).toContain('pm2_guard');
    expect(md).toContain('expected_pass');
  });

  it('16. Runtime Surfaces table has rows', () => {
    const md = renderArchitectureBaselineMarkdown(easyBaseline());
    expect(md).toContain('heartbeat');
    expect(md).toContain('do_not_commit');
  });

  it('17. Risks table has rows', () => {
    const md = renderArchitectureBaselineMarkdown(easyBaseline());
    expect(md).toContain('defense_bypass');
  });

  it('18. Validation shows errors/warnings tables', () => {
    const b = easyBaseline({ id: '' });
    const md = renderArchitectureBaselineMarkdown(b);
    expect(md).toContain('### Errors');
    expect(md).toContain('### Warnings');
  });

  it('19. Evidence section shows evidence fields', () => {
    const ev = buildArchitectureBaselineEvidence({ baseline: easyBaseline(), captured_at: FIXED_NOW });
    const md = renderArchitectureBaselineMarkdown(easyBaseline(), undefined, ev);
    expect(md).toContain(ev.id);
    expect(md).toContain(ev.type);
  });

  it('20. Evidence section without evidence shows placeholder', () => {
    const md = renderArchitectureBaselineMarkdown(easyBaseline());
    expect(md).toContain('_No evidence generated._');
  });

  it('21. empty arrays show _None._ in validation errors/warnings', () => {
    const md = renderArchitectureBaselineMarkdown(easyBaseline());
    expect(md).toContain('_None._'); // errors and warnings both empty
  });

  it('22. pipe character escaped in cell value', () => {
    const b = easyBaseline();
    b.modules[0].title = 'Test | pipe';
    const md = renderArchitectureBaselineMarkdown(b);
    expect(md).toContain('Test \\| pipe');
  });
});

// ============================================================================
describe('formatArchitectureBaselineReportTimestamp', () => {
  it('23. formats correctly', () => {
    expect(formatArchitectureBaselineReportTimestamp('2026-08-03T01:10:00+08:00')).toBe('20260803-011000');
  });
});

// ============================================================================
describe('writeArchitectureBaselineReport', () => {
  it('24. writes JSON and MD files', async () => {
    const r = await writeArchitectureBaselineReport(easyBaseline(), { outputDir: tempDir, captured_at: FIXED_NOW });
    expect(existsSync(r.jsonPath)).toBe(true);
    expect(existsSync(r.markdownPath)).toBe(true);
    expect(path.basename(r.jsonPath)).toBe('architecture-baseline-20260803-011000.json');
  });

  it('25. JSON content structure correct', async () => {
    const r = await writeArchitectureBaselineReport(easyBaseline(), { outputDir: tempDir, captured_at: FIXED_NOW });
    const data = JSON.parse(await readFile(r.jsonPath, 'utf8'));
    expect(data.schema_version).toBe(1);
    expect(data.report_type).toBe('architecture_baseline');
    expect(data.baseline).toBeDefined();
    expect(data.validation).toBeDefined();
    expect(data.evidence).toBeDefined();
  });

  it('26. no tmp residue', async () => {
    await writeArchitectureBaselineReport(easyBaseline(), { outputDir: tempDir, captured_at: FIXED_NOW });
    const files = await readdir(tempDir);
    expect(files.filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('27. returns evidence and validation', async () => {
    const r = await writeArchitectureBaselineReport(easyBaseline(), { outputDir: tempDir, captured_at: FIXED_NOW });
    expect(r.evidence).toBeDefined();
    expect(r.validation).toBeDefined();
    expect(r.validation.valid).toBe(true);
  });

  it('28. stable filename from captured_at', async () => {
    const r = await writeArchitectureBaselineReport(easyBaseline(), { outputDir: tempDir, captured_at: FIXED_NOW });
    expect(path.basename(r.jsonPath)).toContain('20260803-011000');
  });

  it('29. creates nested outputDir', async () => {
    const nested = path.join(tempDir, 'deep', 'nested');
    const r = await writeArchitectureBaselineReport(easyBaseline(), { outputDir: nested, captured_at: FIXED_NOW });
    expect(existsSync(r.jsonPath)).toBe(true);
  });
});

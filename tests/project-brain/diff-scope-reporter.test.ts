/**
 * diff-scope-reporter.test.ts — DiffScopeGuard Reporter 测试 (P2-T2)
 * =====================================================================
 * 覆盖 buildDiffScopeEvidence / renderDiffScopeMarkdown / writeDiffScopeReport
 * 的 24 个场景。
 *
 * 所有文件写入使用临时目录。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildDiffScopeEvidence,
  renderDiffScopeMarkdown,
  writeDiffScopeReport,
  formatDiffScopeReportTimestamp,
  evaluateDiffScope,
} from '../../src/project-brain';
import type {
  IntentSpec,
  DiffScopeGuardResult,
} from '../../src/project-brain';

// ============================================================================
// Helpers
// ============================================================================

const FIXED_NOW = '2026-08-03T00:25:00+08:00';

function makeIntent(overrides: Partial<IntentSpec> = {}): IntentSpec {
  return {
    id: 'intent-001',
    title: 'Test Intent | with pipe',
    description: 'Test description',
    created_at: FIXED_NOW,
    status: 'draft',
    scope: {
      allowed_paths: overrides.scope?.allowed_paths ?? ['src/project-brain/'],
      forbidden_paths: overrides.scope?.forbidden_paths ?? [],
    },
    risk: { level: 'medium', reasons: ['test'], requires_token: false, requires_architect_review: false },
    evidence_ids: [],
    decision_ids: [],
    ...overrides,
  };
}

/** 产生一个 allowed result */
function allowedResult(): DiffScopeGuardResult {
  const intent = makeIntent({ scope: { allowed_paths: ['src/'], forbidden_paths: [] } });
  return evaluateDiffScope({ intent, changed_paths: ['src/new.ts'] });
}

/** 产生一个 denied result */
function deniedResult(): DiffScopeGuardResult {
  const intent = makeIntent({ scope: { allowed_paths: ['docs/'], forbidden_paths: [] } });
  return evaluateDiffScope({ intent, changed_paths: ['src/FlowEngine.ts'] });
}

/** 产生一个 mixed result */
function mixedResult(): DiffScopeGuardResult {
  const intent = makeIntent({
    scope: { allowed_paths: ['src/project-brain/'], forbidden_paths: ['src/project-brain/store.ts'] },
  });
  return evaluateDiffScope({
    intent,
    changed_paths: ['src/project-brain/types.ts', 'src/project-brain/store.ts', 'src/other.ts'],
  });
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'harness-ds-reporter-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ============================================================================
// buildDiffScopeEvidence
// ============================================================================

describe('buildDiffScopeEvidence', () => {
  it('1. allowed result — summary says "allowed"', () => {
    const intent = makeIntent();
    const result = allowedResult();
    const ev = buildDiffScopeEvidence({ intent, result, captured_at: FIXED_NOW });

    expect(ev.type).toBe('code_review');
    expect(ev.summary).toContain('allowed');
    expect(ev.summary).toContain('1 changed path');
  });

  it('2. denied result — summary says "denied"', () => {
    const intent = makeIntent();
    const result = deniedResult();
    const ev = buildDiffScopeEvidence({ intent, result, captured_at: FIXED_NOW });

    expect(ev.summary).toContain('denied');
    expect(ev.summary).toContain('violation');
  });

  it('3. uses passed evidence_id / captured_at / source', () => {
    const ev = buildDiffScopeEvidence({
      intent: makeIntent(),
      result: allowedResult(),
      captured_at: FIXED_NOW,
      evidence_id: 'my-custom-id',
      source: 'Manual Test',
    });

    expect(ev.id).toBe('my-custom-id');
    expect(ev.captured_at).toBe(FIXED_NOW);
    expect(ev.source).toBe('Manual Test');
  });

  it('4. auto-generates id with evidence_diff_scope_ prefix', () => {
    const ev = buildDiffScopeEvidence({
      intent: makeIntent(),
      result: allowedResult(),
      captured_at: FIXED_NOW,
    });

    expect(ev.id).toMatch(/^evidence_diff_scope_\d{8}_\d{6}$/);
  });

  it('5. related_paths = changed_paths', () => {
    const intent = makeIntent({ scope: { allowed_paths: ['src/'], forbidden_paths: [] } });
    const result = evaluateDiffScope({ intent, changed_paths: ['src/a.ts', 'src/b.ts'] });
    const ev = buildDiffScopeEvidence({ intent, result, captured_at: FIXED_NOW });

    expect(ev.related_paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('6. evidence metadata contains result summary / violations / warnings / matched', () => {
    const intent = makeIntent({
      scope: { allowed_paths: ['src/project-brain/'], forbidden_paths: ['src/project-brain/store.ts'] },
    });
    const result = evaluateDiffScope({
      intent,
      changed_paths: ['src/project-brain/types.ts', 'src/project-brain/store.ts'],
    });
    const ev = buildDiffScopeEvidence({ intent, result, captured_at: FIXED_NOW });

    expect(ev.metadata).toBeDefined();
    const meta = ev.metadata as Record<string, unknown>;
    expect(meta.intent_id).toBe('intent-001');
    expect(meta.mode).toBe('strict');
    expect(meta.allowed).toBe(false);
    expect(meta.summary).toBeDefined();
    expect(Array.isArray(meta.violations)).toBe(true);
    expect(Array.isArray(meta.warnings)).toBe(true);
    expect(Array.isArray(meta.matched)).toBe(true);
  });
});

// ============================================================================
// renderDiffScopeMarkdown
// ============================================================================

describe('renderDiffScopeMarkdown', () => {
  it('7. contains all 9 required sections', () => {
    const intent = makeIntent();
    const result = allowedResult();
    const ev = buildDiffScopeEvidence({ intent, result, captured_at: FIXED_NOW });
    const md = renderDiffScopeMarkdown(intent, result, ev);

    expect(md).toContain('# DiffScopeGuard Report');
    expect(md).toContain('## 1. Summary');
    expect(md).toContain('## 2. Intent');
    expect(md).toContain('## 3. Changed Paths');
    expect(md).toContain('## 4. Allowed Scope');
    expect(md).toContain('## 5. Forbidden Scope');
    expect(md).toContain('## 6. Violations');
    expect(md).toContain('## 7. Warnings');
    expect(md).toContain('## 8. Matched Rules');
    expect(md).toContain('## 9. Evidence');
  });

  it('8. Summary contains mode / allowed / counts', () => {
    const intent = makeIntent();
    const result = allowedResult();
    const md = renderDiffScopeMarkdown(intent, result);

    expect(md).toContain('strict');
    expect(md).toContain('YES');
    expect(md).toContain('1'); // changed count
  });

  it('9. Intent section contains id / title / status / risk', () => {
    const intent = makeIntent();
    const result = allowedResult();
    const md = renderDiffScopeMarkdown(intent, result);

    expect(md).toContain('intent-001');
    expect(md).toContain('Test Intent \\| with pipe'); // escaped pipe
    expect(md).toContain('draft');
    expect(md).toContain('medium');
  });

  it('10. Changed Paths / Allowed Scope / Forbidden Scope listed', () => {
    const intent = makeIntent({
      scope: { allowed_paths: ['src/project-brain/'], forbidden_paths: ['src/FlowEngine.ts'] },
    });
    const result = evaluateDiffScope({
      intent,
      changed_paths: ['src/project-brain/types.ts'],
    });
    const md = renderDiffScopeMarkdown(intent, result);

    expect(md).toContain('src/project-brain/types.ts');
    expect(md).toContain('src/project-brain/');
    expect(md).toContain('src/FlowEngine.ts');
  });

  it('11. Violations table has rows', () => {
    const intent = makeIntent({
      scope: { allowed_paths: ['docs/'], forbidden_paths: [] },
    });
    const result = evaluateDiffScope({ intent, changed_paths: ['src/FlowEngine.ts'] });
    const md = renderDiffScopeMarkdown(intent, result);

    expect(md).toContain('outside_allowed_scope');
    expect(md).toContain('src/FlowEngine.ts');
  });

  it('12. Warnings table has rows', () => {
    const intent = makeIntent({
      scope: { allowed_paths: [], forbidden_paths: [] },
    });
    const result = evaluateDiffScope({ intent, changed_paths: ['src/new.ts'] });
    const md = renderDiffScopeMarkdown(intent, result);

    expect(md).toContain('empty_allowed_scope');
  });

  it('13. Matched Rules table', () => {
    const intent = makeIntent({
      scope: { allowed_paths: ['src/project-brain/'], forbidden_paths: [] },
    });
    const result = evaluateDiffScope({ intent, changed_paths: ['src/project-brain/types.ts'] });
    const md = renderDiffScopeMarkdown(intent, result);

    expect(md).toContain('src/project-brain/types.ts');
    expect(md).toContain('src/project-brain/');
  });

  it('14. Evidence section with evidence shows fields', () => {
    const intent = makeIntent();
    const result = allowedResult();
    const ev = buildDiffScopeEvidence({ intent, result, captured_at: FIXED_NOW });
    const md = renderDiffScopeMarkdown(intent, result, ev);

    expect(md).toContain(ev.id);
    expect(md).toContain('code_review');
    expect(md).toContain('DiffScopeGuard');
  });

  it('15. Evidence section without evidence shows placeholder', () => {
    const intent = makeIntent();
    const result = allowedResult();
    const md = renderDiffScopeMarkdown(intent, result); // no evidence arg

    expect(md).toContain('_No evidence generated._');
  });

  it('16. empty arrays show _None._', () => {
    const intent = makeIntent({
      scope: { allowed_paths: ['src/'], forbidden_paths: [] },
    });
    const result = evaluateDiffScope({ intent, changed_paths: [] });
    const md = renderDiffScopeMarkdown(intent, result);

    expect(md).toContain('_None._'); // changed paths + violations + warnings all empty
  });

  it('17. pipe character in cell value is escaped', () => {
    const intent = makeIntent({ title: 'Fix | pipe | issue' });
    const result = allowedResult();
    const md = renderDiffScopeMarkdown(intent, result);

    expect(md).toContain('Fix \\| pipe \\| issue');
  });
});

// ============================================================================
// formatDiffScopeReportTimestamp
// ============================================================================

describe('formatDiffScopeReportTimestamp', () => {
  it('18. formats ISO timestamp correctly', () => {
    const result = formatDiffScopeReportTimestamp('2026-08-03T00:25:00+08:00');
    expect(result).toBe('20260803-002500');
  });

  it('19. formats UTC timestamp', () => {
    const result = formatDiffScopeReportTimestamp('2026-08-03T12:30:45.000Z');
    expect(result).toBe('20260803-123045');
  });
});

// ============================================================================
// writeDiffScopeReport
// ============================================================================

describe('writeDiffScopeReport', () => {
  it('20. writes JSON and MD files', async () => {
    const intent = makeIntent({ scope: { allowed_paths: ['src/project-brain/'], forbidden_paths: [] } });
    const result = evaluateDiffScope({ intent, changed_paths: ['src/project-brain/types.ts'] });
    const report = await writeDiffScopeReport(intent, result, {
      outputDir: tempDir,
      captured_at: FIXED_NOW,
    });

    expect(existsSync(report.jsonPath)).toBe(true);
    expect(existsSync(report.markdownPath)).toBe(true);
    expect(path.basename(report.jsonPath)).toBe('diff-scope-20260803-002500.json');
    expect(path.basename(report.markdownPath)).toBe('diff-scope-20260803-002500.md');
  });

  it('21. JSON content structure is correct', async () => {
    const intent = makeIntent();
    const result = mixedResult();
    const report = await writeDiffScopeReport(intent, result, {
      outputDir: tempDir,
      captured_at: FIXED_NOW,
    });

    const raw = await readFile(report.jsonPath, 'utf8');
    const data = JSON.parse(raw);

    expect(data.schema_version).toBe(1);
    expect(data.report_type).toBe('diff_scope_guard');
    expect(data.intent).toBeDefined();
    expect(data.result).toBeDefined();
    expect(data.evidence).toBeDefined();
    expect(data.result.allowed).toBe(false);
    expect(data.result.violations.length).toBeGreaterThan(0);
  });

  it('22. no tmp files left after atomic write', async () => {
    const intent = makeIntent();
    const result = allowedResult();
    await writeDiffScopeReport(intent, result, { outputDir: tempDir, captured_at: FIXED_NOW });

    const files = await readdir(tempDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
  });

  it('23. returns evidence in result', async () => {
    const intent = makeIntent();
    const result = allowedResult();
    const report = await writeDiffScopeReport(intent, result, {
      outputDir: tempDir,
      captured_at: FIXED_NOW,
    });

    expect(report.evidence).toBeDefined();
    expect(report.evidence.type).toBe('code_review');
    expect(report.evidence.id).toMatch(/^evidence_diff_scope/);
  });

  it('24. creates nested outputDir if missing', async () => {
    const nestedDir = path.join(tempDir, 'deep', 'nested');
    const intent = makeIntent();
    const result = allowedResult();
    const report = await writeDiffScopeReport(intent, result, {
      outputDir: nestedDir,
      captured_at: FIXED_NOW,
    });

    expect(existsSync(report.jsonPath)).toBe(true);
  });
});

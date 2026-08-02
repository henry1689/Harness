/**
 * reporter.test.ts — ProjectBrain v0.1 Reporter 测试
 * =====================================================
 * P1-T4: 覆盖 reporter 模块的 18+ 场景。
 *
 * 所有文件写入使用临时目录，不污染真实 data/reports/project-brain/。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildProjectBrainSummary,
  buildProjectBrainSnapshot,
  renderProjectBrainMarkdown,
  writeProjectBrainSnapshot,
  formatTimestampForFilename,
} from '../../src/project-brain';
import type {
  ProjectBrainRoot,
  IntentSpec,
  EvidenceRecord,
  DecisionRecord,
  RiskSignal,
} from '../../src/project-brain';

// ============================================================================
// Test helpers
// ============================================================================

const FIXED_NOW = '2026-08-03T00:10:00+08:00';

function emptyRoot(overrides: Partial<ProjectBrainRoot> = {}): ProjectBrainRoot {
  return {
    schema_version: 1,
    project: { id: 'test', name: 'Test Project', root: '/test' },
    intents: [],
    evidence: [],
    decisions: [],
    risks: [],
    generated_at: FIXED_NOW,
    ...overrides,
  };
}

function sampleIntent(overrides: Partial<IntentSpec> = {}): IntentSpec {
  return {
    id: 'i-001',
    title: 'Sample Intent',
    description: 'A sample intent',
    created_at: '2026-08-03T00:00:00Z',
    status: 'draft',
    scope: { allowed_paths: ['src/'], forbidden_paths: [] },
    risk: { level: 'low', reasons: [], requires_token: false, requires_architect_review: false },
    evidence_ids: [],
    decision_ids: [],
    ...overrides,
  };
}

function sampleEvidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: 'ev-001',
    type: 'test_result',
    title: 'Sample Evidence',
    source: 'vitest output',
    captured_at: '2026-08-03T00:01:00Z',
    ...overrides,
  };
}

function sampleDecision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 'dec-001',
    type: 'approve',
    made_at: '2026-08-03T00:02:00Z',
    summary: 'Approved',
    status: 'active',
    ...overrides,
  };
}

function sampleRisk(overrides: Partial<RiskSignal> = {}): RiskSignal {
  return {
    level: 'medium',
    source: 'test',
    message: 'Sample risk',
    detected_at: '2026-08-03T00:03:00Z',
    ...overrides,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'harness-pb-reporter-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ============================================================================
// buildProjectBrainSummary
// ============================================================================

describe('buildProjectBrainSummary', () => {
  it('1. empty root — all counts zero', () => {
    const sum = buildProjectBrainSummary(emptyRoot());
    expect(sum.intent_count).toBe(0);
    expect(sum.evidence_count).toBe(0);
    expect(sum.decision_count).toBe(0);
    expect(sum.risk_count).toBe(0);
    expect(sum.project_id).toBe('test');
    expect(sum.project_name).toBe('Test Project');
  });

  it('2. counts are correct with populated data', () => {
    const root = emptyRoot({
      intents: [sampleIntent(), sampleIntent({ id: 'i-002' })],
      evidence: [sampleEvidence()],
      decisions: [],
      risks: [sampleRisk(), sampleRisk({ id: 'r-002' as never })],
    });
    const sum = buildProjectBrainSummary(root);
    expect(sum.intent_count).toBe(2);
    expect(sum.evidence_count).toBe(1);
    expect(sum.decision_count).toBe(0);
    expect(sum.risk_count).toBe(2);
  });

  it('3. risk_distribution counts correctly', () => {
    const risks: RiskSignal[] = [
      sampleRisk({ level: 'low' }),
      sampleRisk({ level: 'low' }),
      sampleRisk({ level: 'medium' }),
      sampleRisk({ level: 'high' }),
      sampleRisk({ level: 'critical' }),
      sampleRisk({ level: 'critical' }),
    ];
    const sum = buildProjectBrainSummary(emptyRoot({ risks }));
    expect(sum.risk_distribution).toEqual({ low: 2, medium: 1, high: 1, critical: 2 });
  });

  it('4. latest_intent_at uses max of created_at / updated_at', () => {
    const intents: IntentSpec[] = [
      sampleIntent({ id: 'old', created_at: '2026-08-01T00:00:00Z' }),
      sampleIntent({ id: 'mid', created_at: '2026-08-02T00:00:00Z', updated_at: '2026-08-03T00:00:00Z' }),
      sampleIntent({ id: 'new', created_at: '2026-08-03T12:00:00Z' }),
    ];
    const sum = buildProjectBrainSummary(emptyRoot({ intents }));
    expect(sum.latest_intent_at).toBe('2026-08-03T12:00:00Z');
  });

  it('5. latest_evidence_at correct', () => {
    const evidence: EvidenceRecord[] = [
      sampleEvidence({ id: 'e1', captured_at: '2026-08-01T00:00:00Z' }),
      sampleEvidence({ id: 'e2', captured_at: '2026-08-03T10:00:00Z' }),
    ];
    const sum = buildProjectBrainSummary(emptyRoot({ evidence }));
    expect(sum.latest_evidence_at).toBe('2026-08-03T10:00:00Z');
  });

  it('6. latest_decision_at correct', () => {
    const decisions: DecisionRecord[] = [
      sampleDecision({ id: 'd1', made_at: '2026-08-02T00:00:00Z' }),
      sampleDecision({ id: 'd2', made_at: '2026-08-03T09:00:00Z' }),
    ];
    const sum = buildProjectBrainSummary(emptyRoot({ decisions }));
    expect(sum.latest_decision_at).toBe('2026-08-03T09:00:00Z');
  });

  it('7. latest_risk_at correct', () => {
    const risks: RiskSignal[] = [
      sampleRisk({ level: 'low', detected_at: '2026-08-02T00:00:00Z' }),
      sampleRisk({ level: 'high', detected_at: '2026-08-03T11:00:00Z' }),
    ];
    const sum = buildProjectBrainSummary(emptyRoot({ risks }));
    expect(sum.latest_risk_at).toBe('2026-08-03T11:00:00Z');
  });
});

// ============================================================================
// buildProjectBrainSnapshot
// ============================================================================

describe('buildProjectBrainSnapshot', () => {
  it('8. uses provided generatedAt', () => {
    const root = emptyRoot();
    const snapshot = buildProjectBrainSnapshot(root, '2026-08-03T12:00:00Z');
    expect(snapshot.schema_version).toBe(1);
    expect(snapshot.generated_at).toBe('2026-08-03T12:00:00Z');
    expect(snapshot.root).toBe(root);
  });

  it('9. defaults generatedAt when omitted', () => {
    const before = new Date().toISOString();
    const snapshot = buildProjectBrainSnapshot(emptyRoot());
    const after = new Date().toISOString();
    expect(snapshot.generated_at >= before).toBe(true);
    expect(snapshot.generated_at <= after).toBe(true);
  });
});

// ============================================================================
// renderProjectBrainMarkdown
// ============================================================================

describe('renderProjectBrainMarkdown', () => {
  it('10. contains all required sections', () => {
    const md = renderProjectBrainMarkdown(emptyRoot());
    expect(md).toContain('# ProjectBrain Snapshot');
    expect(md).toContain('## 1. Summary');
    expect(md).toContain('## 2. Project');
    expect(md).toContain('## 3. Intents');
    expect(md).toContain('## 4. Evidence');
    expect(md).toContain('## 5. Decisions');
    expect(md).toContain('## 6. Risks');
    expect(md).toContain('## 7. Generated At');
  });

  it('11. empty arrays show placeholder text', () => {
    const md = renderProjectBrainMarkdown(emptyRoot());
    expect(md).toContain('_No intents._');
    expect(md).toContain('_No evidence records._');
    expect(md).toContain('_No decisions._');
    expect(md).toContain('_No risks._');
  });

  it('12. table contains intent rows', () => {
    const root = emptyRoot({ intents: [sampleIntent()] });
    const md = renderProjectBrainMarkdown(root);
    expect(md).toContain('| i-001 |');
    expect(md).toContain('Sample Intent');
    expect(md).toContain('draft');
    expect(md).toContain('low');
  });

  it('13. table contains evidence rows', () => {
    const root = emptyRoot({ evidence: [sampleEvidence()] });
    const md = renderProjectBrainMarkdown(root);
    expect(md).toContain('| ev-001 |');
    expect(md).toContain('test_result');
    expect(md).toContain('vitest output');
  });

  it('14. table contains decision rows', () => {
    const root = emptyRoot({ decisions: [sampleDecision()] });
    const md = renderProjectBrainMarkdown(root);
    expect(md).toContain('| dec-001 |');
    expect(md).toContain('approve');
    expect(md).toContain('active');
  });

  it('15. table contains risk rows', () => {
    const root = emptyRoot({ risks: [sampleRisk()] });
    const md = renderProjectBrainMarkdown(root);
    expect(md).toContain('| medium |');
    expect(md).toContain('test');
    expect(md).toContain('Sample risk');
  });

  it('16. escapes pipe character in table cells', () => {
    const root = emptyRoot({
      intents: [sampleIntent({ title: 'Fix bug | in | pipeline' })],
    });
    const md = renderProjectBrainMarkdown(root);
    // Should contain escaped pipes, not raw ones breaking the table
    expect(md).toContain('Fix bug \\| in \\| pipeline');
  });
});

// ============================================================================
// formatTimestampForFilename
// ============================================================================

describe('formatTimestampForFilename', () => {
  it('17. formats with timezone offset', () => {
    const result = formatTimestampForFilename('2026-08-03T00:10:00+08:00');
    expect(result).toBe('20260803-001000');
  });

  it('18. formats UTC timestamp', () => {
    const result = formatTimestampForFilename('2026-08-03T12:30:45.000Z');
    expect(result).toBe('20260803-123045');
  });
});

// ============================================================================
// writeProjectBrainSnapshot
// ============================================================================

describe('writeProjectBrainSnapshot', () => {
  const now = () => '2026-08-03T00:10:00+08:00';

  it('19. writes JSON and MD files', async () => {
    const root = emptyRoot({ intents: [sampleIntent()], risks: [sampleRisk()] });
    const result = await writeProjectBrainSnapshot(root, { outputDir: tempDir, now });

    expect(existsSync(result.jsonPath)).toBe(true);
    expect(existsSync(result.markdownPath)).toBe(true);
    expect(path.basename(result.jsonPath)).toBe('project-brain-20260803-001000.json');
    expect(path.basename(result.markdownPath)).toBe('project-brain-20260803-001000.md');
  });

  it('20. JSON contains snapshot and summary', async () => {
    const root = emptyRoot();
    const result = await writeProjectBrainSnapshot(root, { outputDir: tempDir, now });
    const raw = await readFile(result.jsonPath, 'utf8');
    const data = JSON.parse(raw);

    expect(data.snapshot).toBeDefined();
    expect(data.snapshot.schema_version).toBe(1);
    expect(data.summary).toBeDefined();
    expect(data.summary.intent_count).toBe(0);
  });

  it('21. no tmp files left after atomic write', async () => {
    const root = emptyRoot();
    const result = await writeProjectBrainSnapshot(root, { outputDir: tempDir, now });

    const dirFiles = await (await import('node:fs/promises')).readdir(tempDir);
    const tmpFiles = dirFiles.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
  });

  it('22. returns summary in result', async () => {
    const root = emptyRoot({ intents: [sampleIntent(), sampleIntent({ id: 'i-002' })] });
    const result = await writeProjectBrainSnapshot(root, { outputDir: tempDir, now });
    expect(result.summary.intent_count).toBe(2);
    expect(result.summary.project_id).toBe('test');
  });

  it('23. creates output directory if missing', async () => {
    const nestedDir = path.join(tempDir, 'nested', 'sub');
    const root = emptyRoot();
    const result = await writeProjectBrainSnapshot(root, { outputDir: nestedDir, now });
    expect(existsSync(result.jsonPath)).toBe(true);
  });
});

/**
 * diff-scope-scenario-runner.test.ts — Scenario Runner 测试 (P2-T3)
 * ==================================================================
 * 覆盖 runDiffScopeScenario / runDiffScopeScenarios / sanitizeDiffScopeScenarioId
 * 的 22 个场景。
 *
 * 全部使用临时目录，不污染真实 data/reports/。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runDiffScopeScenario,
  runDiffScopeScenarios,
  sanitizeDiffScopeScenarioId,
} from '../../src/project-brain';
import type {
  DiffScopeScenario,
  IntentSpec,
} from '../../src/project-brain';

// ============================================================================
// Helpers
// ============================================================================

const FIXED_NOW = '2026-08-03T00:30:00+08:00';

function makeIntent(id = 'intent-001', allowed: string[] = ['src/project-brain/']): IntentSpec {
  return {
    id,
    title: `Intent ${id}`,
    description: 'Test intent',
    created_at: FIXED_NOW,
    status: 'draft',
    scope: { allowed_paths: allowed, forbidden_paths: [] },
    risk: { level: 'low', reasons: [], requires_token: false, requires_architect_review: false },
    evidence_ids: [],
    decision_ids: [],
  };
}

function makeScenario(overrides: Partial<DiffScopeScenario> = {}): DiffScopeScenario {
  return {
    id: 'scenario-01',
    title: 'Test Scenario 01',
    intent: makeIntent(),
    changed_paths: ['src/project-brain/types.ts'],
    ...overrides,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'harness-ds-scenario-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ============================================================================
// sanitizeDiffScopeScenarioId
// ============================================================================

describe('sanitizeDiffScopeScenarioId', () => {
  it('1. preserves alphanumeric, underscore, hyphen', () => {
    expect(sanitizeDiffScopeScenarioId('scenario_01-test')).toBe('scenario_01-test');
  });

  it('2. replaces spaces and special characters with underscore', () => {
    expect(sanitizeDiffScopeScenarioId('my scenario!@#')).toBe('my_scenario___');
  });

  it('3. empty input returns "scenario"', () => {
    expect(sanitizeDiffScopeScenarioId('')).toBe('scenario');
  });

  it('4. whitespace-only returns "scenario"', () => {
    expect(sanitizeDiffScopeScenarioId('   \t  ')).toBe('scenario');
  });
});

// ============================================================================
// runDiffScopeScenario
// ============================================================================

describe('runDiffScopeScenario', () => {
  it('5. allowed scenario → actual_allowed true', async () => {
    const result = await runDiffScopeScenario(makeScenario(), {
      outputDir: tempDir,
      captured_at: FIXED_NOW,
    });

    expect(result.actual_allowed).toBe(true);
  });

  it('6. denied scenario → actual_allowed false', async () => {
    const intent = makeIntent('intent-002', ['docs/']);
    const result = await runDiffScopeScenario(
      makeScenario({ intent, changed_paths: ['src/FlowEngine.ts'] }),
      { outputDir: tempDir, captured_at: FIXED_NOW },
    );

    expect(result.actual_allowed).toBe(false);
  });

  it('7. expected_allowed matches → passed true', async () => {
    const result = await runDiffScopeScenario(
      makeScenario({ expected_allowed: true }),
      { outputDir: tempDir, captured_at: FIXED_NOW },
    );

    expect(result.passed).toBe(true);
  });

  it('8. expected_allowed mismatch → passed false', async () => {
    const intent = makeIntent('intent-003', ['docs/']);
    const result = await runDiffScopeScenario(
      makeScenario({
        intent,
        changed_paths: ['src/FlowEngine.ts'],
        expected_allowed: true, // expects allowed but is denied
      }),
      { outputDir: tempDir, captured_at: FIXED_NOW },
    );

    expect(result.passed).toBe(false);
    expect(result.expected_allowed).toBe(true);
    expect(result.actual_allowed).toBe(false);
  });

  it('9. expected_allowed undefined → passed true regardless', async () => {
    const intent = makeIntent('intent-004', ['docs/']);
    const result = await runDiffScopeScenario(
      makeScenario({ intent, changed_paths: ['src/FlowEngine.ts'], expected_allowed: undefined }),
      { outputDir: tempDir, captured_at: FIXED_NOW },
    );

    // allowed is false but expected_allowed is not set, so passed is true
    expect(result.actual_allowed).toBe(false);
    expect(result.passed).toBe(true);
  });

  it('10. notes default empty array', async () => {
    const result = await runDiffScopeScenario(
      makeScenario({ notes: undefined }),
      { outputDir: tempDir, captured_at: FIXED_NOW },
    );

    expect(result.notes).toEqual([]);
  });

  it('11. notes preserved from input', async () => {
    const result = await runDiffScopeScenario(
      makeScenario({ notes: ['Note A', 'Note B'] }),
      { outputDir: tempDir, captured_at: FIXED_NOW },
    );

    expect(result.notes).toEqual(['Note A', 'Note B']);
  });

  it('12. report writes JSON and MD files', async () => {
    const result = await runDiffScopeScenario(makeScenario(), {
      outputDir: tempDir,
      captured_at: FIXED_NOW,
    });

    expect(existsSync(result.report.jsonPath)).toBe(true);
    expect(existsSync(result.report.markdownPath)).toBe(true);
    expect(result.report.evidence).toBeDefined();
  });

  it('13. evidence_id uses sanitized scenario id', async () => {
    const result = await runDiffScopeScenario(
      makeScenario({ id: 'my scenario-01' }),
      { outputDir: tempDir, captured_at: FIXED_NOW },
    );

    expect(result.evidence.id).toBe('evidence_diff_scope_my_scenario-01');
  });

  it('14. source defaults to DiffScopeScenario:<id>', async () => {
    const result = await runDiffScopeScenario(
      makeScenario({ id: 'test-001' }),
      { outputDir: tempDir, captured_at: FIXED_NOW },
    );

    expect(result.evidence.source).toBe('DiffScopeScenario:test-001');
  });

  it('15. source overwritable by options.source', async () => {
    const result = await runDiffScopeScenario(makeScenario(), {
      outputDir: tempDir,
      captured_at: FIXED_NOW,
      source: 'Custom Source',
    });

    expect(result.evidence.source).toBe('Custom Source');
  });

  it('16. captured_at flows through to evidence and report', async () => {
    const result = await runDiffScopeScenario(makeScenario(), {
      outputDir: tempDir,
      captured_at: FIXED_NOW,
    });

    expect(result.evidence.captured_at).toBe(FIXED_NOW);
  });

  it('17. throws when scenario.id is empty string', async () => {
    await expect(
      runDiffScopeScenario(makeScenario({ id: '' }), { outputDir: tempDir }),
    ).rejects.toThrow('DiffScopeScenario id is required');
  });

  it('18. throws when scenario.title is empty string', async () => {
    await expect(
      runDiffScopeScenario(makeScenario({ title: '' }), { outputDir: tempDir }),
    ).rejects.toThrow('DiffScopeScenario title is required');
  });
});

// ============================================================================
// runDiffScopeScenarios
// ============================================================================

describe('runDiffScopeScenarios', () => {
  it('19. batch returns total / passed / failed counts', async () => {
    const scenarios: DiffScopeScenario[] = [
      makeScenario({ id: 's-01', expected_allowed: true }),   // allowed → passed
      makeScenario({ id: 's-02', expected_allowed: true }),   // allowed → passed
      makeScenario({ id: 's-03', intent: makeIntent('int-03', ['docs/']), changed_paths: ['src/x.ts'], expected_allowed: true }), // denied, expected=true → failed
    ];

    const batch = await runDiffScopeScenarios(scenarios, {
      outputDir: tempDir,
      captured_at: FIXED_NOW,
    });

    expect(batch.total).toBe(3);
    expect(batch.passed).toBe(2);
    expect(batch.failed).toBe(1);
    expect(batch.results).toHaveLength(3);
  });

  it('20. batch preserves input order', async () => {
    const scenarios: DiffScopeScenario[] = [
      makeScenario({ id: 'first' }),
      makeScenario({ id: 'second' }),
      makeScenario({ id: 'third' }),
    ];

    const batch = await runDiffScopeScenarios(scenarios, {
      outputDir: tempDir,
      captured_at: FIXED_NOW,
    });

    expect(batch.results[0].scenario_id).toBe('first');
    expect(batch.results[1].scenario_id).toBe('second');
    expect(batch.results[2].scenario_id).toBe('third');
  });

  it('21. batch includes failed scenarios in results', async () => {
    const intent = makeIntent('int-004', ['docs/']);
    const scenarios: DiffScopeScenario[] = [
      makeScenario({ id: 'ok', expected_allowed: true }),
      makeScenario({ id: 'fail', intent, changed_paths: ['src/x.ts'], expected_allowed: true }),
    ];

    const batch = await runDiffScopeScenarios(scenarios, {
      outputDir: tempDir,
      captured_at: FIXED_NOW,
    });

    // both should be in results
    expect(batch.results).toHaveLength(2);
    expect(batch.results[1].passed).toBe(false);
    expect(batch.failed).toBe(1);
  });

  it('22. empty array returns total=0', async () => {
    const batch = await runDiffScopeScenarios([], {
      outputDir: tempDir,
      captured_at: FIXED_NOW,
    });

    expect(batch.total).toBe(0);
    expect(batch.passed).toBe(0);
    expect(batch.failed).toBe(0);
    expect(batch.results).toEqual([]);
  });

  it('23. no tmp files left after batch run', async () => {
    const scenarios: DiffScopeScenario[] = [
      makeScenario({ id: 'a' }),
      makeScenario({ id: 'b' }),
    ];

    await runDiffScopeScenarios(scenarios, {
      outputDir: tempDir,
      captured_at: FIXED_NOW,
    });

    const files = await readdir(tempDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
  });
});

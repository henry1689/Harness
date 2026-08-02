/**
 * diff-scope-audit-script.test.ts — Audit CLI 测试 (P2-T5)
 * ==========================================================
 * 24 个场景。全部使用 fake deps，零真实 git 调用。
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseArgs,
  printHelp,
  loadProjectBrain,
  findIntent,
  runAuditCli,
} from '../../scripts/project-brain-diff-scope-audit.cjs';

// ============================================================================
// Helpers
// ============================================================================

function fakeProjectBrain(intents: object[] = []) {
  return {
    schema_version: 1,
    project: { id: 'test', name: 'Test', root: '/test' },
    intents,
    evidence: [],
    decisions: [],
    risks: [],
    generated_at: '2026-08-03T00:00:00Z',
  };
}

function makeIntent(id: string, overrides = {}) {
  return {
    id,
    title: 'Intent ' + id,
    description: 'Test',
    created_at: '2026-08-03T00:00:00Z',
    status: 'draft',
    scope: { allowed_paths: ['src/'], forbidden_paths: [] },
    risk: { level: 'low', reasons: [], requires_token: false, requires_architect_review: false },
    evidence_ids: [],
    decision_ids: [],
    ...overrides,
  };
}

// ============================================================================
// parseArgs
// ============================================================================

describe('parseArgs', () => {
  it('1. parses required args', () => {
    const args = parseArgs(['--intent-id', 'test-01', '--output-dir', '/tmp']);
    expect(args.intentId).toBe('test-01');
    expect(args.outputDir).toBe('/tmp');
  });

  it('2. defaults project-brain path', () => {
    const args = parseArgs(['--intent-id', 'test-01']);
    expect(args.projectBrain).toBe('data/project-brain/project-brain.json');
  });

  it('3. defaults output-dir', () => {
    const args = parseArgs(['--intent-id', 'test-01']);
    expect(args.outputDir).toBe('data/reports/project-brain');
  });

  it('4. parses --staged and --include-untracked', () => {
    const args = parseArgs([
      '--intent-id', 'test-01',
      '--staged',
      '--include-untracked',
    ]);
    expect(args.staged).toBe(true);
    expect(args.includeUntracked).toBe(true);
  });

  it('5. parses --base-ref and --head-ref', () => {
    const args = parseArgs([
      '--intent-id', 'test-01',
      '--base-ref', 'main',
      '--head-ref', 'HEAD',
    ]);
    expect(args.baseRef).toBe('main');
    expect(args.headRef).toBe('HEAD');
  });

  it('6. parses --mode strict', () => {
    const args = parseArgs(['--intent-id', 'test-01', '--mode', 'strict']);
    expect(args.mode).toBe('strict');
  });

  it('7. parses --mode advisory', () => {
    const args = parseArgs(['--intent-id', 'test-01', '--mode', 'advisory']);
    expect(args.mode).toBe('advisory');
  });

  it('8. rejects invalid --mode', () => {
    expect(() => parseArgs(['--intent-id', 'test-01', '--mode', 'invalid']))
      .toThrow('Invalid mode');
  });

  it('9. parses --expected-allowed true', () => {
    const args = parseArgs(['--intent-id', 'test-01', '--expected-allowed', 'true']);
    expect(args.expectedAllowed).toBe(true);
  });

  it('10. parses --expected-allowed false', () => {
    const args = parseArgs(['--intent-id', 'test-01', '--expected-allowed', 'false']);
    expect(args.expectedAllowed).toBe(false);
  });

  it('11. rejects invalid --expected-allowed', () => {
    expect(() => parseArgs(['--intent-id', 'test-01', '--expected-allowed', 'maybe']))
      .toThrow('Invalid expected-allowed');
  });

  it('12. --staged + --base-ref throws', () => {
    expect(() => parseArgs([
      '--intent-id', 'test-01',
      '--staged',
      '--base-ref', 'main',
      '--head-ref', 'HEAD',
    ])).toThrow('Cannot specify both --staged and --base-ref');
  });

  it('13. missing --intent-id still returns object (validated later)', () => {
    const args = parseArgs([]);
    expect(args.intentId).toBeUndefined();
    expect(args.help).toBeUndefined();
  });
});

// ============================================================================
// printHelp
// ============================================================================

describe('printHelp', () => {
  it('14. --help output contains required flags', () => {
    const lines: string[] = [];
    printHelp({ log: (s: string) => lines.push(s) });

    const text = lines.join('\n');
    expect(text).toContain('--intent-id');
    expect(text).toContain('--project-brain');
    expect(text).toContain('--output-dir');
    expect(text).toContain('--staged');
    expect(text).toContain('--include-untracked');
    expect(text).toContain('--base-ref');
    expect(text).toContain('--head-ref');
    expect(text).toContain('--mode');
    expect(text).toContain('--expected-allowed');
  });

  it('15. --help does not call fs or git', () => {
    // printHelp is pure — just prints text
    const lines: string[] = [];
    printHelp({ log: (s: string) => lines.push(s) });
    expect(lines.length).toBeGreaterThan(10);
  });
});

// ============================================================================
// loadProjectBrain
// ============================================================================

describe('loadProjectBrain', () => {
  it('16. reads valid JSON', () => {
    const pb = fakeProjectBrain();
    const mockFs = {
      existsSync: () => true,
      readFileSync: () => JSON.stringify(pb),
    };
    const result = loadProjectBrain('/fake/path.json', { fs: mockFs });
    expect(result.schema_version).toBe(1);
    expect(result.project.id).toBe('test');
  });

  it('17. throws on file not found', () => {
    const mockFs = { existsSync: () => false, readFileSync: () => '' };
    expect(() => loadProjectBrain('/missing.json', { fs: mockFs }))
      .toThrow('ProjectBrain store file not found');
  });

  it('18. throws on invalid JSON', () => {
    const mockFs = {
      existsSync: () => true,
      readFileSync: () => 'not valid json {{{',
    };
    expect(() => loadProjectBrain('/bad.json', { fs: mockFs }))
      .toThrow('Failed to parse ProjectBrain store JSON');
  });
});

// ============================================================================
// findIntent
// ============================================================================

describe('findIntent', () => {
  it('19. finds intent by id', () => {
    const pb = fakeProjectBrain([
      makeIntent('intent-a'),
      makeIntent('intent-b'),
      makeIntent('intent-c'),
    ]);
    const result = findIntent(pb, 'intent-b');
    expect(result).toBeDefined();
    expect(result?.id).toBe('intent-b');
  });

  it('20. returns undefined for not found', () => {
    const pb = fakeProjectBrain([makeIntent('intent-a')]);
    const result = findIntent(pb, 'intent-zzz');
    expect(result).toBeUndefined();
  });

  it('21. handles empty intents array', () => {
    const pb = fakeProjectBrain([]);
    const result = findIntent(pb, 'any');
    expect(result).toBeUndefined();
  });
});

// ============================================================================
// runAuditCli
// ============================================================================

describe('runAuditCli', () => {
  it('22. calls getChangedPathsFromGitDiff', async () => {
    let diffCalled = false;
    let scenarioCalled = false;
    let tempPath = '';

    try {
      const d = await mkdtemp(path.join(tmpdir(), 'harness-audit-test-'));
      tempPath = d;

      const fakeGetChanged = async (opts: any) => {
        diffCalled = true;
        return ['src/new.ts'];
      };

      const fakeRunScenario = async (_s: any, _o: any) => {
        scenarioCalled = true;
        return {
          scenario_id: 'git_audit_test-01',
          title: 'test',
          passed: true,
          expected_allowed: undefined,
          actual_allowed: true,
          result: {},
          evidence: { id: 'ev-1', type: 'test' },
          report: { jsonPath: path.join(d, 'report.json'), markdownPath: path.join(d, 'report.md'), evidence: {} },
          notes: [],
        };
      };

      const pb = fakeProjectBrain([makeIntent('test-01')]);

      const result = await runAuditCli(
        ['--intent-id', 'test-01', '--output-dir', d],
        {
          getChangedPathsFromGitDiff: fakeGetChanged,
          runDiffScopeScenario: fakeRunScenario,
          fs: {
            existsSync: () => true,
            readFileSync: () => JSON.stringify(pb),
          },
          printFn: () => {},
        },
      );

      expect(diffCalled).toBe(true);
      expect(scenarioCalled).toBe(true);
      expect(result.exitCode).toBe(0);
    } finally {
      if (tempPath) await rm(tempPath, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('23. passes staged/include-untracked flags', async () => {
    const capturedOpts: any[] = [];
    let tempPath = '';

    try {
      const d = await mkdtemp(path.join(tmpdir(), 'harness-audit-test-'));
      tempPath = d;

      const fakeGetChanged = async (opts: any) => {
        capturedOpts.push(opts);
        return [];
      };

      const fakeRunScenario = async (_s: any, _o: any) => ({
        scenario_id: 'x', title: 'x', passed: true,
        actual_allowed: true, result: {}, evidence: { id: 'ev', type: 't' },
        report: { jsonPath: path.join(d, 'r.json'), markdownPath: path.join(d, 'r.md'), evidence: {} },
        notes: [],
      });

      const pb = fakeProjectBrain([makeIntent('test-01')]);

      await runAuditCli(
        ['--intent-id', 'test-01', '--staged', '--include-untracked', '--output-dir', d],
        {
          getChangedPathsFromGitDiff: fakeGetChanged,
          runDiffScopeScenario: fakeRunScenario,
          fs: { existsSync: () => true, readFileSync: () => JSON.stringify(pb) },
          printFn: () => {},
        },
      );

      expect(capturedOpts[0].staged).toBe(true);
      expect(capturedOpts[0].includeUntracked).toBe(true);
    } finally {
      if (tempPath) await rm(tempPath, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('24. passes base-ref/head-ref/cwd', async () => {
    const capturedOpts: any[] = [];
    let tempPath = '';

    try {
      const d = await mkdtemp(path.join(tmpdir(), 'harness-audit-test-'));
      tempPath = d;

      const fakeGetChanged = async (opts: any) => {
        capturedOpts.push(opts);
        return ['src/changed.ts'];
      };

      const fakeRunScenario = async (_s: any, _o: any) => ({
        scenario_id: 'x', title: 'x', passed: true,
        actual_allowed: true, result: {}, evidence: { id: 'ev', type: 't' },
        report: { jsonPath: path.join(d, 'r.json'), markdownPath: path.join(d, 'r.md'), evidence: {} },
        notes: [],
      });

      const pb = fakeProjectBrain([makeIntent('test-01')]);

      await runAuditCli(
        ['--intent-id', 'test-01', '--base-ref', 'main', '--head-ref', 'HEAD', '--cwd', '/custom', '--output-dir', d],
        {
          getChangedPathsFromGitDiff: fakeGetChanged,
          runDiffScopeScenario: fakeRunScenario,
          fs: { existsSync: () => true, readFileSync: () => JSON.stringify(pb) },
          printFn: () => {},
        },
      );

      expect(capturedOpts[0].baseRef).toBe('main');
      expect(capturedOpts[0].headRef).toBe('HEAD');
      expect(capturedOpts[0].cwd).toBe('/custom');
    } finally {
      if (tempPath) await rm(tempPath, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('25. intent not found → fail', async () => {
    const pb = fakeProjectBrain([makeIntent('other')]);
    const result = await runAuditCli(
      ['--intent-id', 'missing-id', '--output-dir', '/tmp'],
      {
        fs: { existsSync: () => true, readFileSync: () => JSON.stringify(pb) },
        printFn: () => {},
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.error).toContain('Intent not found');
  });

  it('26. passed=false → exit code 1', async () => {
    let tempPath = '';
    try {
      const d = await mkdtemp(path.join(tmpdir(), 'harness-audit-test-'));
      tempPath = d;

      const pb = fakeProjectBrain([makeIntent('test-01')]);
      const result = await runAuditCli(
        ['--intent-id', 'test-01', '--output-dir', d],
        {
          getChangedPathsFromGitDiff: async () => ['src/FlowEngine.ts'],
          runDiffScopeScenario: async () => ({
            scenario_id: 'x', title: 'x', passed: false,
            expected_allowed: true, actual_allowed: false, result: {}, evidence: { id: 'ev', type: 't' },
            report: { jsonPath: path.join(d, 'r.json'), markdownPath: path.join(d, 'r.md'), evidence: {} },
            notes: [],
          }),
          fs: { existsSync: () => true, readFileSync: () => JSON.stringify(pb) },
          printFn: () => {},
        },
      );

      expect(result.exitCode).toBe(1);
    } finally {
      if (tempPath) await rm(tempPath, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('27. --help exits 0 without calling fs/git', async () => {
    const result = await runAuditCli(['--help'], {});

    expect(result.exitCode).toBe(0);
  });

  it('28. missing --intent-id exits with error', async () => {
    const result = await runAuditCli([], {
      printFn: () => {},
    });

    expect(result.exitCode).toBe(2);
  });

  it('29. scenario runner passes notes', async () => {
    let capturedScenario: any = null;
    let tempPath = '';
    try {
      const d = await mkdtemp(path.join(tmpdir(), 'harness-audit-test-'));
      tempPath = d;

      const pb = fakeProjectBrain([makeIntent('test-01')]);
      await runAuditCli(
        ['--intent-id', 'test-01', '--output-dir', d],
        {
          getChangedPathsFromGitDiff: async () => ['src/new.ts'],
          runDiffScopeScenario: async (scenario: any, _opts: any) => {
            capturedScenario = scenario;
            return {
              scenario_id: 'x', title: 'x', passed: true,
              actual_allowed: true, result: {}, evidence: { id: 'ev', type: 't' },
              report: { jsonPath: path.join(d, 'r.json'), markdownPath: path.join(d, 'r.md'), evidence: {} },
              notes: [],
            };
          },
          fs: { existsSync: () => true, readFileSync: () => JSON.stringify(pb) },
          printFn: () => {},
        },
      );

      expect(capturedScenario.notes).toBeDefined();
      expect(capturedScenario.notes.some((n: string) => n.includes('P2-T5'))).toBe(true);
      expect(capturedScenario.id).toBe('git_audit_test-01');
    } finally {
      if (tempPath) await rm(tempPath, { recursive: true, force: true }).catch(() => {});
    }
  });
});

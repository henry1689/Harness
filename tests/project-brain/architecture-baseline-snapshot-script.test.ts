/**
 * architecture-baseline-snapshot-script.test.ts — Snapshot CLI 测试 (P3-T4 / P3-T4R)
 * ====================================================================================
 * 覆盖 runArchitectureBaselineSnapshotCli + fallback 行为。全部使用 fake deps。
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseArgs,
  printHelp,
  runArchitectureBaselineSnapshotCli,
  buildFallbackBaseline,
  validateFallbackBaseline,
} from '../../scripts/project-brain-architecture-baseline-snapshot.cjs';

function fakeBaseline() {
  return { id: 'arch-test', version: '1.0', title: 'Test', captured_at: '2026-08-03T02:00:00Z',
    scope: { root: '.', included_paths: [], excluded_paths: [] },
    modules: [], forbidden_zones: [], defense_lines: [], runtime_surfaces: [], risks: [], metadata: {} };
}
function fakeValid() {
  return { valid: true, errors: [], warnings: [], summary: { module_count: 5, forbidden_zone_count: 4, defense_line_count: 5, runtime_surface_count: 4, risk_count: 3 } };
}
function fakeInvalid() {
  return { valid: false, errors: [{ type: 'missing_required_field' as const, entity_type: 'baseline' as const, message: 'x' }], warnings: [], summary: { module_count: 5, forbidden_zone_count: 4, defense_line_count: 5, runtime_surface_count: 4, risk_count: 3 } };
}

// ============================================================================
describe('parseArgs', () => {
  it('1. defaults output-dir', () => expect(parseArgs([]).outputDir).toBe('data/reports/project-brain'));
  it('2. parses output-dir', () => expect(parseArgs(['--output-dir','/x']).outputDir).toBe('/x'));
  it('3. parses --dry-run', () => expect(parseArgs(['--dry-run']).dryRun).toBe(true));
  it('4. parses id/version/title', () => {
    const a = parseArgs(['--id','a','--version','b','--title','c']);
    expect(a.id).toBe('a'); expect(a.version).toBe('b'); expect(a.title).toBe('c');
  });
  it('5. parses captured-at/source/evidence-id', () => {
    const a = parseArgs(['--captured-at','iso','--source','s','--evidence-id','e']);
    expect(a.capturedAt).toBe('iso'); expect(a.source).toBe('s'); expect(a.evidenceId).toBe('e');
  });
});

describe('printHelp', () => {
  it('6. contains required flags', () => {
    const lines: string[] = []; printHelp({ log: (s: string) => lines.push(s) });
    const t = lines.join('\n');
    ['output-dir','dry-run','id','version','title','captured-at','source','evidence-id'].forEach(f => expect(t).toContain(f));
  });
  it('7. help is pure function', () => {
    const lines: string[] = []; printHelp({ log: (s: string) => lines.push(s) });
    expect(lines.length).toBeGreaterThan(8);
  });
});

// ============================================================================
describe('fallback functions', () => {
  it('8. buildFallbackBaseline has expected defaults', () => {
    const b = buildFallbackBaseline({});
    expect(b.id).toBe('architecture_baseline_harness_v4');
    expect(b.version).toBe('0.1.0');
    expect(b.modules).toHaveLength(5);
    expect(b.forbidden_zones).toHaveLength(4);
    expect(b.defense_lines).toHaveLength(5);
    expect(b.runtime_surfaces).toHaveLength(4);
    expect(b.risks).toHaveLength(3);
  });

  it('9. buildFallbackBaseline respects id/version/title overrides', () => {
    const b = buildFallbackBaseline({ id: 'my-id', version: '2.0', title: 'My Title' });
    expect(b.id).toBe('my-id');
    expect(b.version).toBe('2.0');
    expect(b.title).toBe('My Title');
  });

  it('10. validateFallbackBaseline returns valid with correct counts', () => {
    const b = buildFallbackBaseline({});
    const v = validateFallbackBaseline(b);
    expect(v.valid).toBe(true);
    expect(v.summary.module_count).toBe(5);
    expect(v.summary.forbidden_zone_count).toBe(4);
    expect(v.summary.defense_line_count).toBe(5);
  });
});

// ============================================================================
describe('runArchitectureBaselineSnapshotCli', () => {
  it('11. dry-run with injected deps exit 0', async () => {
    const code = await runArchitectureBaselineSnapshotCli(['--dry-run'], {
      createHarnessV4ArchitectureBaseline: () => fakeBaseline(),
      validateArchitectureBaseline: () => fakeValid(),
      printFn: () => {},
    });
    expect(code).toBe(0);
  });

  it('12. dry-run does not call writer', async () => {
    let called = false;
    const code = await runArchitectureBaselineSnapshotCli(['--dry-run'], {
      createHarnessV4ArchitectureBaseline: () => fakeBaseline(),
      validateArchitectureBaseline: () => fakeValid(),
      writeArchitectureBaselineReport: () => { called = true; },
      printFn: () => {},
    });
    expect(called).toBe(false); expect(code).toBe(0);
  });

  it('13. dry-run outputs summary', async () => {
    const lines: string[] = [];
    await runArchitectureBaselineSnapshotCli(['--dry-run'], {
      createHarnessV4ArchitectureBaseline: () => fakeBaseline(),
      validateArchitectureBaseline: () => fakeValid(),
      printFn: (s: string) => lines.push(s),
    });
    expect(lines.join('\n')).toContain('dry run complete');
    expect(lines.join('\n')).toContain('Modules: 5');
  });

  it('14. formal run calls writer', async () => {
    let called = false;
    const code = await runArchitectureBaselineSnapshotCli([], {
      createHarnessV4ArchitectureBaseline: () => fakeBaseline(),
      validateArchitectureBaseline: () => fakeValid(),
      writeArchitectureBaselineReport: async () => {
        called = true; return { jsonPath: '/r.json', markdownPath: '/r.md', evidence: {}, validation: fakeValid() };
      },
      printFn: () => {},
    });
    expect(called).toBe(true); expect(code).toBe(0);
  });

  it('15. passes writer options', async () => {
    let opts: any = null;
    await runArchitectureBaselineSnapshotCli(['--output-dir','/out','--source','S','--evidence-id','E','--captured-at','2026-08-03T03:00:00Z'], {
      createHarnessV4ArchitectureBaseline: () => fakeBaseline(),
      validateArchitectureBaseline: () => fakeValid(),
      writeArchitectureBaselineReport: async (_b: any, o: any) => { opts = o; return { jsonPath: '/r.json', markdownPath: '/r.md', evidence: {}, validation: fakeValid() }; },
      printFn: () => {},
    });
    expect(opts.outputDir).toBe(path.resolve('/out'));
    expect(opts.source).toBe('S'); expect(opts.evidence_id).toBe('E'); expect(opts.captured_at).toBe('2026-08-03T03:00:00Z');
  });

  it('16. formal run outputs paths', async () => {
    const lines: string[] = [];
    await runArchitectureBaselineSnapshotCli([], {
      createHarnessV4ArchitectureBaseline: () => fakeBaseline(),
      validateArchitectureBaseline: () => fakeValid(),
      writeArchitectureBaselineReport: async () => ({ jsonPath: '/a.json', markdownPath: '/a.md', evidence: {}, validation: fakeValid() }),
      printFn: (s: string) => lines.push(s),
    });
    expect(lines.join('\n')).toContain('/a.json'); expect(lines.join('\n')).toContain('/a.md');
  });

  it('17. valid → exit 0', async () => {
    const code = await runArchitectureBaselineSnapshotCli([], {
      createHarnessV4ArchitectureBaseline: () => fakeBaseline(),
      validateArchitectureBaseline: () => fakeValid(),
      writeArchitectureBaselineReport: async () => ({ jsonPath: '/x.json', markdownPath: '/x.md', evidence: {}, validation: fakeValid() }),
      printFn: () => {},
    });
    expect(code).toBe(0);
  });

  it('18. invalid → exit 1', async () => {
    const code = await runArchitectureBaselineSnapshotCli([], {
      createHarnessV4ArchitectureBaseline: () => fakeBaseline(),
      validateArchitectureBaseline: () => fakeInvalid(),
      writeArchitectureBaselineReport: async () => ({ jsonPath: '/x.json', markdownPath: '/x.md', evidence: {}, validation: fakeInvalid() }),
      printFn: () => {},
    });
    expect(code).toBe(1);
  });

  it('19. writer throws → exit 2', async () => {
    const code = await runArchitectureBaselineSnapshotCli([], {
      createHarnessV4ArchitectureBaseline: () => fakeBaseline(),
      validateArchitectureBaseline: () => fakeValid(),
      writeArchitectureBaselineReport: async () => { throw new Error('disk full'); },
      printFn: () => {},
    });
    expect(code).toBe(2);
  });

  it('20. --help exits 0', async () => {
    expect(await runArchitectureBaselineSnapshotCli(['--help'], {})).toBe(0);
  });

  it('21. passes id/version/title overrides to builder', async () => {
    let captured: any = null;
    await runArchitectureBaselineSnapshotCli(['--id','custom','--version','2','--title','T'], {
      createHarnessV4ArchitectureBaseline: (input: any) => { captured = input; return fakeBaseline(); },
      validateArchitectureBaseline: () => fakeValid(),
      writeArchitectureBaselineReport: async () => ({ jsonPath: '/x.json', markdownPath: '/x.md', evidence: {}, validation: fakeValid() }),
      printFn: () => {},
    });
    expect(captured.id).toBe('custom'); expect(captured.version).toBe('2'); expect(captured.title).toBe('T');
  });

  // ── P3-T4R: fallback behavior ──
  it('22. dry-run with fallback deps (no TS modules) exit 0', async () => {
    const lines: string[] = [];
    const code = await runArchitectureBaselineSnapshotCli(['--dry-run'], {
      // no createFn/validateFn — simulates TS modules unavailable
      printFn: (s: string) => lines.push(s),
    });
    expect(code).toBe(0);
    const t = lines.join('\n');
    expect(t).toContain('dry run complete');
    expect(t).toContain('Modules: 5');
    expect(t).toContain('Forbidden zones: 4');
    expect(t).toContain('Defense lines: 5');
  });

  it('23. fallback dry-run respects --id/--version/--title', async () => {
    const lines: string[] = [];
    const code = await runArchitectureBaselineSnapshotCli(
      ['--dry-run', '--id', 'my-fb-id', '--version', '9.9', '--title', 'Fallback Title'],
      { printFn: (s: string) => lines.push(s) },
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('my-fb-id');
  });

  it('24. formal run without deps and without --dry-run → exit 2', async () => {
    const lines: string[] = [];
    const code = await runArchitectureBaselineSnapshotCli(
      ['--output-dir', '/tmp/nope'],
      { printFn: (s: string) => lines.push(s) },
    );
    expect(code).toBe(2);
    expect(lines.join(' ')).toContain('Failed to load');
  });

  it('25. --help does not load deps', async () => {
    const code = await runArchitectureBaselineSnapshotCli(['--help'], {});
    expect(code).toBe(0);
  });
});

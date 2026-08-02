/**
 * architecture-baseline-builder.test.ts — ArchitectureBaseline Builder 测试 (P3-T2)
 * ===================================================================================
 * 覆盖 createHarnessV4ArchitectureBaseline + 6 个默认构建块的 27 个场景。
 */
import { describe, expect, it } from 'vitest';
import {
  createHarnessV4ArchitectureBaseline,
  getDefaultHarnessV4ArchitectureScope,
  getDefaultHarnessV4ModuleBoundaries,
  getDefaultHarnessV4ForbiddenZones,
  getDefaultHarnessV4DefenseLines,
  getDefaultHarnessV4RuntimeSurfaces,
  getDefaultHarnessV4BaselineRisks,
  validateArchitectureBaseline,
} from '../../src/project-brain';
import type { ModuleBoundary } from '../../src/project-brain';

// ============================================================================
// Default artifact content
// ============================================================================

describe('factory functions — content', () => {
  it('1. default scope has correct included/excluded paths', () => {
    const s = getDefaultHarnessV4ArchitectureScope();
    expect(s.root).toBe('.');
    expect(s.included_paths).toContain('src/');
    expect(s.included_paths).toContain('mcp/');
    expect(s.included_paths).toContain('sentinel/');
    expect(s.included_paths).toContain('hooks/');
    expect(s.excluded_paths).toContain('node_modules/');
    expect(s.excluded_paths).toContain('data/sentinel/');
  });

  it('2. default modules include expected ids', () => {
    const mods = getDefaultHarnessV4ModuleBoundaries();
    const ids = mods.map(m => m.id);
    expect(ids).toContain('harness_core');
    expect(ids).toContain('project_brain');
    expect(ids).toContain('diff_scope_guard');
    expect(ids).toContain('defense_subsystem');
    expect(ids).toContain('runtime_state');
  });

  it('3. harness_core forbids project_brain dependency', () => {
    const mods = getDefaultHarnessV4ModuleBoundaries();
    const core = mods.find(m => m.id === 'harness_core')!;
    expect(core.forbidden_dependencies).toContain('project_brain');
  });

  it('4. default forbidden zones include expected ids', () => {
    const fzs = getDefaultHarnessV4ForbiddenZones();
    const ids = fzs.map(f => f.id);
    expect(ids).toContain('harness_core_mainline');
    expect(ids).toContain('token_and_audit_state');
    expect(ids).toContain('defense_runtime');
    expect(ids).toContain('external_controlled_projects');
  });

  it('5. token_and_audit_state is critical and never', () => {
    const fzs = getDefaultHarnessV4ForbiddenZones();
    const t = fzs.find(f => f.id === 'token_and_audit_state')!;
    expect(t.severity).toBe('critical');
    expect(t.allowed_touch_policy).toBe('never');
  });

  it('6. default defense lines include 5 types', () => {
    const dls = getDefaultHarnessV4DefenseLines();
    const ids = dls.map(d => d.id);
    expect(ids).toContain('pm2_guard');
    expect(ids).toContain('mcp_gate');
    expect(ids).toContain('sentinel');
    expect(ids).toContain('git_hook');
    expect(ids).toContain('manual_diff_scope_audit');
    for (const d of dls) {
      expect(d.status).toBe('expected_pass');
    }
  });

  it('7. default runtime surfaces include expected ids', () => {
    const rss = getDefaultHarnessV4RuntimeSurfaces();
    const ids = rss.map(r => r.id);
    expect(ids).toContain('heartbeat');
    expect(ids).toContain('sentinel_state');
    expect(ids).toContain('logs');
    expect(ids).toContain('health_reports');
  });

  it('8. runtime_state surfaces are do_not_commit except health_reports', () => {
    const rss = getDefaultHarnessV4RuntimeSurfaces();
    expect(rss.find(r => r.id === 'heartbeat')!.commit_policy).toBe('do_not_commit');
    expect(rss.find(r => r.id === 'sentinel_state')!.commit_policy).toBe('do_not_commit');
    expect(rss.find(r => r.id === 'logs')!.commit_policy).toBe('do_not_commit');
    expect(rss.find(r => r.id === 'health_reports')!.commit_policy).toBe('review_required');
  });

  it('9. default risks include 3 expected', () => {
    const risks = getDefaultHarnessV4BaselineRisks();
    const ids = risks.map(r => r.id);
    expect(ids).toContain('accidental_core_modification');
    expect(ids).toContain('defense_bypass');
    expect(ids).toContain('runtime_state_commit_noise');
    expect(risks.find(r => r.id === 'defense_bypass')!.level).toBe('critical');
  });
});

// ============================================================================
// createHarnessV4ArchitectureBaseline — defaults
// ============================================================================

describe('createHarnessV4ArchitectureBaseline — defaults', () => {
  it('10. creates default baseline with correct id/version/title', () => {
    const bl = createHarnessV4ArchitectureBaseline();
    expect(bl.id).toBe('architecture_baseline_harness_v4');
    expect(bl.version).toBe('0.1.0');
    expect(bl.title).toBe('Harness v4 Architecture Baseline');
  });

  it('11. captured_at can be passed', () => {
    const bl = createHarnessV4ArchitectureBaseline({ captured_at: '2026-08-03T02:00:00Z' });
    expect(bl.captured_at).toBe('2026-08-03T02:00:00Z');
  });

  it('12. metadata contains generated_by', () => {
    const bl = createHarnessV4ArchitectureBaseline();
    expect(bl.metadata.generated_by).toBe('createHarnessV4ArchitectureBaseline');
  });

  it('13. scope partial override merges with defaults', () => {
    const bl = createHarnessV4ArchitectureBaseline({
      scope: { root: 'custom-root' },
    });
    expect(bl.scope.root).toBe('custom-root');
    expect(bl.scope.included_paths).toContain('src/');  // default preserved
    expect(bl.scope.excluded_paths).toContain('node_modules/');
  });

  it('14. generated baseline passes validation', () => {
    const bl = createHarnessV4ArchitectureBaseline();
    const result = validateArchitectureBaseline(bl);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ============================================================================
// createHarnessV4ArchitectureBaseline — append mode
// ============================================================================

describe('createHarnessV4ArchitectureBaseline — append', () => {
  it('15. append mode appends modules after defaults', () => {
    const bl = createHarnessV4ArchitectureBaseline({
      mode: 'append',
      modules: [{ id: 'extra_mod', title: 'Extra', paths: ['extra/'], responsibilities: ['x'], allowed_dependencies: [], forbidden_dependencies: [] }],
    });
    const ids = bl.modules.map(m => m.id);
    expect(ids[ids.length - 1]).toBe('extra_mod');
    expect(ids).toContain('harness_core'); // defaults still present
  });

  it('16. append appends forbidden zones', () => {
    const bl = createHarnessV4ArchitectureBaseline({
      mode: 'append',
      forbidden_zones: [{ id: 'extra_fz', title: 'X', paths: ['x/'], reason: 'r', severity: 'low', allowed_touch_policy: 'never' }],
    });
    const ids = bl.forbidden_zones.map(f => f.id);
    expect(ids[ids.length - 1]).toBe('extra_fz');
  });

  it('17. append appends defense lines', () => {
    const bl = createHarnessV4ArchitectureBaseline({
      mode: 'append',
      defense_lines: [{ id: 'extra_dl', title: 'X', kind: 'other', status: 'unknown', related_paths: [], responsibilities: ['x'] }],
    });
    expect(bl.defense_lines.some(d => d.id === 'extra_dl')).toBe(true);
  });

  it('18. append appends runtime surfaces', () => {
    const bl = createHarnessV4ArchitectureBaseline({
      mode: 'append',
      runtime_surfaces: [{ id: 'extra_rs', title: 'X', paths: ['x/'], mutable: false, commit_policy: 'do_not_commit', reason: 'r' }],
    });
    expect(bl.runtime_surfaces.some(r => r.id === 'extra_rs')).toBe(true);
  });

  it('19. append appends risks', () => {
    const bl = createHarnessV4ArchitectureBaseline({
      mode: 'append',
      risks: [{ id: 'extra_risk', title: 'X', level: 'low', affected_paths: ['x/'], mitigation: 'm' }],
    });
    expect(bl.risks.some(r => r.id === 'extra_risk')).toBe(true);
  });

  it('20. append preserves input order after defaults', () => {
    const inputModules: ModuleBoundary[] = [
      { id: 'z', title: 'Z', paths: ['z/'], responsibilities: ['z'], allowed_dependencies: [], forbidden_dependencies: [] },
      { id: 'a', title: 'A', paths: ['a/'], responsibilities: ['a'], allowed_dependencies: [], forbidden_dependencies: [] },
    ];
    const bl = createHarnessV4ArchitectureBaseline({ mode: 'append', modules: inputModules });
    const tail = bl.modules.slice(-2);
    expect(tail[0].id).toBe('z');
    expect(tail[1].id).toBe('a');
  });
});

// ============================================================================
// createHarnessV4ArchitectureBaseline — override mode
// ============================================================================

describe('createHarnessV4ArchitectureBaseline — override', () => {
  it('21. override replaces modules', () => {
    const bl = createHarnessV4ArchitectureBaseline({
      mode: 'override',
      modules: [{ id: 'only_mod', title: 'Only', paths: ['only/'], responsibilities: ['x'], allowed_dependencies: [], forbidden_dependencies: [] }],
    });
    expect(bl.modules).toHaveLength(1);
    expect(bl.modules[0].id).toBe('only_mod');
  });

  it('22. override replaces forbidden zones', () => {
    const bl = createHarnessV4ArchitectureBaseline({
      mode: 'override',
      forbidden_zones: [{ id: 'only_fz', title: 'X', paths: ['x/'], reason: 'r', severity: 'low', allowed_touch_policy: 'never' }],
    });
    expect(bl.forbidden_zones).toHaveLength(1);
  });

  it('23. override replaces defense lines', () => {
    const bl = createHarnessV4ArchitectureBaseline({
      mode: 'override',
      defense_lines: [{ id: 'only_dl', title: 'X', kind: 'other', status: 'unknown', related_paths: [], responsibilities: ['x'] }],
    });
    expect(bl.defense_lines).toHaveLength(1);
  });

  it('24. override replaces runtime surfaces', () => {
    const bl = createHarnessV4ArchitectureBaseline({
      mode: 'override',
      runtime_surfaces: [{ id: 'only_rs', title: 'X', paths: ['x/'], mutable: false, commit_policy: 'do_not_commit', reason: 'r' }],
    });
    expect(bl.runtime_surfaces).toHaveLength(1);
  });

  it('25. override replaces risks', () => {
    const bl = createHarnessV4ArchitectureBaseline({
      mode: 'override',
      risks: [{ id: 'only_risk', title: 'X', level: 'low', affected_paths: ['x/'], mitigation: 'm' }],
    });
    expect(bl.risks).toHaveLength(1);
  });

  it('26. unprovided collections in override still use defaults', () => {
    const bl = createHarnessV4ArchitectureBaseline({
      mode: 'override',
      modules: [{ id: 'only', title: 'X', paths: ['x/'], responsibilities: ['x'], allowed_dependencies: [], forbidden_dependencies: [] }],
    });
    // modules overridden, but forbidden_zones/defense_lines/etc still default
    expect(bl.modules).toHaveLength(1);
    expect(bl.forbidden_zones.length).toBeGreaterThan(0); // defaults
    expect(bl.defense_lines.length).toBeGreaterThan(0);   // defaults
  });
});

// ============================================================================
// Factory immutability
// ============================================================================

describe('factory functions — immutability', () => {
  it('27. factory returns new arrays each call', () => {
    const a1 = getDefaultHarnessV4ModuleBoundaries();
    const a2 = getDefaultHarnessV4ModuleBoundaries();
    expect(a1).not.toBe(a2);
    expect(a1[0]).not.toBe(a2[0]);
    expect(a1[0].paths).not.toBe(a2[0].paths);
  });
});

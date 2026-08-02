/**
 * diff-scope-guard.test.ts — DiffScopeGuard 测试 (P2-T1)
 * ========================================================
 * 覆盖 evaluateDiffScope + pathMatchesRule 的 24+ 场景。
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateDiffScope,
  pathMatchesRule,
  normalizeFilePath,
  normalizePathList,
} from '../../src/project-brain';
import type {
  EvaluateDiffScopeInput,
  IntentSpec,
} from '../../src/project-brain';

// ============================================================================
// Helper
// ============================================================================

function makeIntent(overrides: Partial<IntentSpec['scope']> = {}): IntentSpec {
  return {
    id: 'intent-001',
    title: 'Test Intent',
    description: 'Test',
    created_at: '2026-08-03T00:00:00Z',
    status: 'draft',
    scope: {
      allowed_paths: overrides.allowed_paths ?? [],
      forbidden_paths: overrides.forbidden_paths ?? [],
      expected_outputs: overrides.expected_outputs,
      notes: overrides.notes,
    },
    risk: { level: 'low', reasons: [], requires_token: false, requires_architect_review: false },
    evidence_ids: [],
    decision_ids: [],
  };
}

function evalScope(changed: string[], intent?: IntentSpec, mode?: 'strict' | 'advisory') {
  return evaluateDiffScope({
    intent: intent ?? makeIntent(),
    changed_paths: changed,
    mode,
  });
}

// ============================================================================
// pathMatchesRule
// ============================================================================

describe('pathMatchesRule', () => {
  it('1. exact file match', () => {
    expect(pathMatchesRule('src/FlowEngine.ts', 'src/FlowEngine.ts')).toBe(true);
  });

  it('2. directory prefix with trailing slash', () => {
    expect(pathMatchesRule('src/project-brain/types.ts', 'src/project-brain/')).toBe(true);
  });

  it('3. directory prefix without trailing slash', () => {
    expect(pathMatchesRule('src/project-brain/types.ts', 'src/project-brain')).toBe(true);
  });

  it('4. non-similar prefix not falsely matched', () => {
    expect(pathMatchesRule('src/application.ts', 'src/app')).toBe(false);
  });

  it('5. exact match not confused by prefix overlap', () => {
    expect(pathMatchesRule('src/app', 'src/app')).toBe(true);
  });

  it('6. recursive wildcard /**', () => {
    expect(pathMatchesRule('src/project-brain/types.ts', 'src/project-brain/**')).toBe(true);
  });

  it('7. /** matches root itself', () => {
    expect(pathMatchesRule('src/project-brain', 'src/project-brain/**')).toBe(true);
  });

  it('8. unrelated paths mismatch', () => {
    expect(pathMatchesRule('data/reports/health.json', 'src/project-brain/')).toBe(false);
  });
});

// ============================================================================
// evaluateDiffScope — 基础场景
// ============================================================================

describe('evaluateDiffScope — basic scenarios', () => {
  it('9. no changed paths → allowed=true, no_changed_paths warning', () => {
    const result = evalScope([]);
    expect(result.allowed).toBe(true);
    expect(result.warnings.some(w => w.type === 'no_changed_paths')).toBe(true);
  });

  it('10. changed paths with empty allowed_paths → strict: denied', () => {
    const result = evalScope(['src/new.ts']);
    expect(result.allowed).toBe(false);
    expect(result.violations.some(v => v.type === 'empty_allowed_scope_with_changes')).toBe(true);
  });

  it('11. changed paths with empty allowed_paths → advisory: allowed', () => {
    const result = evalScope(['src/new.ts'], undefined, 'advisory');
    expect(result.allowed).toBe(true);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('12. changed path within allowed scope → allowed', () => {
    const intent = makeIntent({ allowed_paths: ['src/project-brain/'] });
    const result = evalScope(['src/project-brain/types.ts'], intent);
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('13. changed path outside allowed scope → violation', () => {
    const intent = makeIntent({ allowed_paths: ['src/project-brain/'] });
    const result = evalScope(['src/FlowEngine.ts'], intent);
    expect(result.allowed).toBe(false);
    expect(result.violations.some(v => v.type === 'outside_allowed_scope')).toBe(true);
  });
});

// ============================================================================
// evaluateDiffScope — forbidden
// ============================================================================

describe('evaluateDiffScope — forbidden paths', () => {
  it('14. changed path touches forbidden → violation', () => {
    const intent = makeIntent({
      allowed_paths: ['src/'],
      forbidden_paths: ['src/FlowEngine.ts'],
    });
    const result = evalScope(['src/FlowEngine.ts'], intent);
    expect(result.allowed).toBe(false);
    expect(result.violations.some(v => v.type === 'forbidden_path_touched')).toBe(true);
  });

  it('15. forbidden takes priority over allowed', () => {
    const intent = makeIntent({
      allowed_paths: ['src/FlowEngine.ts'],
      forbidden_paths: ['src/FlowEngine.ts'],
    });
    const result = evalScope(['src/FlowEngine.ts'], intent);
    expect(result.allowed).toBe(false);
    expect(result.violations[0].type).toBe('forbidden_path_touched');
  });

  it('16. empty forbidden_paths: no forbidden violation', () => {
    const intent = makeIntent({ allowed_paths: ['src/'], forbidden_paths: [] });
    const result = evalScope(['src/new.ts'], intent);
    expect(result.allowed).toBe(true);
    expect(result.violations.some(v => v.type === 'forbidden_path_touched')).toBe(false);
  });

  it('17. multiple changed paths: mixed allowed / forbidden / outside', () => {
    const intent = makeIntent({
      allowed_paths: ['src/project-brain/', 'docs/v4/'],
      forbidden_paths: ['src/project-brain/store.ts'],
    });
    const result = evalScope([
      'src/project-brain/types.ts',   // allowed
      'src/project-brain/store.ts',   // forbidden
      'src/other.ts',                  // outside
    ], intent);

    expect(result.allowed).toBe(false);
    const types = result.violations.map(v => v.type);
    expect(types).toContain('forbidden_path_touched');
    expect(types).toContain('outside_allowed_scope');
    // types.ts is allowed → no violation
    expect(result.violations.length).toBe(2);
  });
});

// ============================================================================
// evaluateDiffScope — path normalization
// ============================================================================

describe('evaluateDiffScope — path normalization', () => {
  it('18. backslashes converted to forward slashes', () => {
    const intent = makeIntent({ allowed_paths: ['src/project-brain/'] });
    const result = evalScope(['src\\project-brain\\types.ts'], intent);
    expect(result.allowed).toBe(true);
    expect(result.changed_paths).toEqual(['src/project-brain/types.ts']);
  });

  it('19. empty strings removed from changed paths', () => {
    const intent = makeIntent({ allowed_paths: ['src/'] });
    const result = evalScope(['src/new.ts', '', '  ', 'src/other.ts'], intent);
    expect(result.changed_paths).toEqual(['src/new.ts', 'src/other.ts']);
  });

  it('20. duplicates removed, first occurrence kept', () => {
    const intent = makeIntent({ allowed_paths: ['src/'] });
    const result = evalScope(['src/a.ts', 'src/b.ts', 'src/a.ts', 'src/c.ts', 'src/b.ts'], intent);
    expect(result.changed_paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });
});

// ============================================================================
// evaluateDiffScope — matched records
// ============================================================================

describe('evaluateDiffScope — matched records', () => {
  it('21. matched records contain allowed_rule', () => {
    const intent = makeIntent({ allowed_paths: ['src/project-brain/'] });
    const result = evalScope(['src/project-brain/types.ts'], intent);
    expect(result.matched[0].allowed_rule).toBe('src/project-brain/');
    expect(result.matched[0].forbidden_rule).toBeUndefined();
  });

  it('22. matched records contain forbidden_rule', () => {
    const intent = makeIntent({
      allowed_paths: ['src/'],
      forbidden_paths: ['src/FlowEngine.ts'],
    });
    const result = evalScope(['src/FlowEngine.ts'], intent);
    expect(result.matched[0].forbidden_rule).toBe('src/FlowEngine.ts');
  });

  it('23. first matching rule wins for allowed and forbidden independently', () => {
    const intent = makeIntent({
      allowed_paths: ['src/project-brain/', 'src/'],
      forbidden_paths: ['src/FlowEngine.ts', 'src/StageRunner.ts'],
    });
    const result = evalScope(['src/FlowEngine.ts'], intent);
    // forbidden matched first
    expect(result.matched[0].allowed_rule).toBe('src/'); // all src/ matches
    expect(result.matched[0].forbidden_rule).toBe('src/FlowEngine.ts');
  });
});

// ============================================================================
// evaluateDiffScope — overlap warnings
// ============================================================================

describe('evaluateDiffScope — overlap warnings', () => {
  it('24. overlap: allowed "src/" with forbidden "src/FlowEngine.ts" → warning', () => {
    const intent = makeIntent({
      allowed_paths: ['src/'],
      forbidden_paths: ['src/FlowEngine.ts'],
    });
    const result = evalScope(['src/project-brain/types.ts'], intent);
    expect(result.warnings.some(w => w.type === 'overlapping_allowed_and_forbidden_scope')).toBe(true);
    expect(result.allowed).toBe(true); // not touching forbidden
  });

  it('25. overlap: allowed "src/project-brain/" with forbidden "src/project-brain/store.ts"', () => {
    const intent = makeIntent({
      allowed_paths: ['src/project-brain/'],
      forbidden_paths: ['src/project-brain/store.ts'],
    });
    const result = evalScope(['src/project-brain/types.ts'], intent);
    expect(result.warnings.some(w => w.type === 'overlapping_allowed_and_forbidden_scope')).toBe(true);
    expect(result.allowed).toBe(true);
  });

  it('26. no overlap when rules are independent', () => {
    const intent = makeIntent({
      allowed_paths: ['src/project-brain/'],
      forbidden_paths: ['data/tokens/'],
    });
    const result = evalScope(['src/project-brain/types.ts'], intent);
    expect(result.warnings.some(w => w.type === 'overlapping_allowed_and_forbidden_scope')).toBe(false);
  });
});

// ============================================================================
// evaluateDiffScope — mode
// ============================================================================

describe('evaluateDiffScope — mode', () => {
  it('27. strict mode: violations cause allowed=false', () => {
    const result = evalScope(['src/FlowEngine.ts'], makeIntent({ allowed_paths: ['docs/'] }), 'strict');
    expect(result.allowed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('28. advisory mode: violations exist but allowed=true', () => {
    const result = evalScope(['src/FlowEngine.ts'], makeIntent({ allowed_paths: ['docs/'] }), 'advisory');
    expect(result.allowed).toBe(true);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('29. default mode is strict', () => {
    const result = evalScope(['src/FlowEngine.ts'], makeIntent({ allowed_paths: ['docs/'] }));
    expect(result.mode).toBe('strict');
    expect(result.allowed).toBe(false);
  });
});

// ============================================================================
// evaluateDiffScope — summary
// ============================================================================

describe('evaluateDiffScope — summary counts', () => {
  it('30. summary counts are accurate', () => {
    const intent = makeIntent({
      allowed_paths: ['src/project-brain/'],
      forbidden_paths: ['src/project-brain/store.ts'],
    });
    const result = evalScope(['src/project-brain/types.ts', 'src/project-brain/store.ts'], intent);

    expect(result.summary.changed_count).toBe(2);
    expect(result.summary.violation_count).toBe(1); // store.ts is forbidden
    expect(result.summary.matched_allowed_count).toBe(2); // both match src/project-brain/
    expect(result.summary.matched_forbidden_count).toBe(1); // store.ts matches forbidden
  });
});

// ============================================================================
// normalizeFilePath / normalizePathList
// ============================================================================

describe('normalizeFilePath / normalizePathList', () => {
  it('31. normalizeFilePath converts backslash', () => {
    expect(normalizeFilePath('src\\dir\\file.ts')).toBe('src/dir/file.ts');
  });

  it('32. normalizeFilePath trims whitespace', () => {
    expect(normalizeFilePath('  src/file.ts  ')).toBe('src/file.ts');
  });

  it('33. normalizePathList handles null/undefined', () => {
    expect(normalizePathList(null as unknown as string[])).toEqual([]);
    expect(normalizePathList(undefined as unknown as string[])).toEqual([]);
  });
});

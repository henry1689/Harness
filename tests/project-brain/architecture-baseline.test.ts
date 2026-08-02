/**
 * architecture-baseline.test.ts — ArchitectureBaseline 测试 (P3-T1)
 * ===================================================================
 * 覆盖 createArchitectureBaseline + validateArchitectureBaseline 的 27 个场景。
 */
import { describe, expect, it } from 'vitest';
import {
  createArchitectureBaseline,
  validateArchitectureBaseline,
} from '../../src/project-brain';
import type {
  ArchitectureBaseline,
  ArchitectureScope,
  ModuleBoundary,
  CreateArchitectureBaselineInput,
} from '../../src/project-brain';

const FIXED_NOW = '2026-08-03T01:00:00.000Z';

function makeScope(overrides: Partial<ArchitectureScope> = {}): ArchitectureScope {
  return { root: '/test', included_paths: ['src/'], excluded_paths: ['node_modules/'], ...overrides };
}

function makeInput(overrides: Partial<CreateArchitectureBaselineInput> = {}): CreateArchitectureBaselineInput {
  return {
    id: 'arch-001',
    version: '1.0.0',
    title: 'Test Architecture Baseline',
    captured_at: FIXED_NOW,
    scope: makeScope(),
    ...overrides,
  };
}

function makeModule(id: string, overrides: Partial<ModuleBoundary> = {}): ModuleBoundary {
  return {
    id, title: `Module ${id}`, paths: [`src/${id}/`], responsibilities: ['does things'],
    allowed_dependencies: [], forbidden_dependencies: [], ...overrides,
  };
}

// ============================================================================
// createArchitectureBaseline
// ============================================================================

describe('createArchitectureBaseline', () => {
  it('1. creates a complete baseline with all fields', () => {
    const b = createArchitectureBaseline(makeInput({
      modules: [makeModule('m1')],
      forbidden_zones: [{ id: 'fz1', title: 'FZ1', paths: ['data/tokens/'], reason: 'sensitive', severity: 'critical', allowed_touch_policy: 'never' }],
      defense_lines: [{ id: 'dl1', title: 'DL1', kind: 'mcp_gate', status: 'expected_pass', related_paths: ['mcp/'], responsibilities: ['gate'] }],
      runtime_surfaces: [{ id: 'rs1', title: 'RS1', paths: ['data/logs/'], mutable: true, commit_policy: 'do_not_commit', reason: 'runtime logs' }],
      risks: [{ id: 'r1', title: 'R1', level: 'high', affected_paths: ['src/'], mitigation: 'review' }],
    }));

    expect(b.id).toBe('arch-001');
    expect(b.version).toBe('1.0.0');
    expect(b.captured_at).toBe(FIXED_NOW);
    expect(b.modules).toHaveLength(1);
    expect(b.forbidden_zones).toHaveLength(1);
    expect(b.defense_lines).toHaveLength(1);
    expect(b.runtime_surfaces).toHaveLength(1);
    expect(b.risks).toHaveLength(1);
  });

  it('2. captured_at defaults when not provided', () => {
    const b = createArchitectureBaseline({ ...makeInput(), captured_at: undefined });
    expect(b.captured_at).toBeDefined();
    expect(typeof b.captured_at).toBe('string');
  });

  it('3. optional arrays default to empty', () => {
    const b = createArchitectureBaseline(makeInput());
    expect(b.modules).toEqual([]);
    expect(b.forbidden_zones).toEqual([]);
    expect(b.defense_lines).toEqual([]);
    expect(b.runtime_surfaces).toEqual([]);
    expect(b.risks).toEqual([]);
  });

  it('4. metadata defaults to empty object', () => {
    const b = createArchitectureBaseline(makeInput());
    expect(b.metadata).toEqual({});
  });

  it('5. does not mutate input scope arrays', () => {
    const scope: ArchitectureScope = { root: '/x', included_paths: ['a'], excluded_paths: ['b'] };
    const input = makeInput({ scope });
    createArchitectureBaseline(input);
    expect(input.scope.included_paths).toEqual(['a']);
  });

  it('6. preserves module order', () => {
    const b = createArchitectureBaseline(makeInput({
      modules: [makeModule('c'), makeModule('a'), makeModule('b')],
    }));
    expect(b.modules.map(m => m.id)).toEqual(['c', 'a', 'b']);
  });
});

// ============================================================================
// validateArchitectureBaseline
// ============================================================================

describe('validateArchitectureBaseline', () => {
  function bl(overrides: Partial<ArchitectureBaseline> = {}): ArchitectureBaseline {
    return createArchitectureBaseline(makeInput(overrides as any));
  }

  it('7. valid baseline → valid true, no errors', () => {
    const r = validateArchitectureBaseline(bl());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  // Baseline level
  it('8. missing id → error', () => {
    const r = validateArchitectureBaseline(bl({ id: '' }));
    expect(r.errors.some(e => e.type === 'missing_required_field' && e.entity_type === 'baseline' && e.field === 'id')).toBe(true);
    expect(r.valid).toBe(false);
  });

  it('9. missing version → error', () => {
    const r = validateArchitectureBaseline(bl({ version: '' }));
    expect(r.errors.some(e => e.field === 'version')).toBe(true);
    expect(r.valid).toBe(false);
  });

  it('10. missing title → error', () => {
    const r = validateArchitectureBaseline(bl({ title: '' }));
    expect(r.errors.some(e => e.field === 'title')).toBe(true);
  });

  it('11. scope.root empty → error', () => {
    const r = validateArchitectureBaseline(bl({ scope: { ...makeScope(), root: '' } }));
    expect(r.errors.some(e => e.entity_type === 'baseline' && e.field === 'root')).toBe(true);
  });

  // Modules
  it('12. module missing id → error', () => {
    const r = validateArchitectureBaseline(bl({ modules: [{ ...makeModule('m1'), id: '' }] }));
    expect(r.errors.some(e => e.entity_type === 'module' && e.field === 'id')).toBe(true);
  });

  it('13. module missing title → error', () => {
    const r = validateArchitectureBaseline(bl({ modules: [{ ...makeModule('m1'), title: '' }] }));
    expect(r.errors.some(e => e.entity_type === 'module' && e.field === 'title')).toBe(true);
  });

  it('14. module empty paths → warning', () => {
    const r = validateArchitectureBaseline(bl({ modules: [{ ...makeModule('m1'), paths: [] }] }));
    expect(r.warnings.some(w => w.type === 'empty_paths' && w.entity_type === 'module')).toBe(true);
    expect(r.valid).toBe(true); // warning不影响
  });

  it('15. module duplicate id → error', () => {
    const r = validateArchitectureBaseline(bl({ modules: [makeModule('dup'), makeModule('dup')] }));
    expect(r.errors.some(e => e.type === 'duplicate_id' && e.entity_type === 'module')).toBe(true);
    expect(r.valid).toBe(false);
  });

  // Forbidden zones
  it('16. forbidden zone missing reason → error', () => {
    const r = validateArchitectureBaseline(bl({
      forbidden_zones: [{ id: 'fz1', title: 'FZ', paths: ['x/'], reason: '', severity: 'high', allowed_touch_policy: 'never' }],
    }));
    expect(r.errors.some(e => e.type === 'forbidden_zone_without_reason')).toBe(true);
  });

  it('17. forbidden zone empty paths → warning', () => {
    const r = validateArchitectureBaseline(bl({
      forbidden_zones: [{ id: 'fz1', title: 'FZ', paths: [], reason: 'sensitive', severity: 'high', allowed_touch_policy: 'never' }],
    }));
    expect(r.warnings.some(w => w.type === 'empty_paths' && w.entity_type === 'forbidden_zone')).toBe(true);
  });

  it('18. forbidden zone duplicate id → error', () => {
    const r = validateArchitectureBaseline(bl({
      forbidden_zones: [
        { id: 'fz', title: 'A', paths: ['a/'], reason: 'r', severity: 'low', allowed_touch_policy: 'never' },
        { id: 'fz', title: 'B', paths: ['b/'], reason: 'r', severity: 'low', allowed_touch_policy: 'never' },
      ],
    }));
    expect(r.errors.some(e => e.type === 'duplicate_id' && e.entity_type === 'forbidden_zone')).toBe(true);
  });

  // Defense lines
  it('19. defense line empty responsibilities → warning', () => {
    const r = validateArchitectureBaseline(bl({
      defense_lines: [{ id: 'dl1', title: 'DL', kind: 'other', status: 'unknown', related_paths: [], responsibilities: [] }],
    }));
    expect(r.warnings.some(w => w.type === 'defense_line_without_responsibility')).toBe(true);
  });

  it('20. defense line duplicate id → error', () => {
    const r = validateArchitectureBaseline(bl({
      defense_lines: [
        { id: 'dl', title: 'A', kind: 'other', status: 'unknown', related_paths: [], responsibilities: ['r'] },
        { id: 'dl', title: 'B', kind: 'other', status: 'unknown', related_paths: [], responsibilities: ['r'] },
      ],
    }));
    expect(r.errors.some(e => e.type === 'duplicate_id' && e.entity_type === 'defense_line')).toBe(true);
  });

  // Runtime surfaces
  it('21. runtime surface empty paths → warning', () => {
    const r = validateArchitectureBaseline(bl({
      runtime_surfaces: [{ id: 'rs1', title: 'RS', paths: [], mutable: false, commit_policy: 'do_not_commit', reason: 'r' }],
    }));
    expect(r.warnings.some(w => w.type === 'empty_paths' && w.entity_type === 'runtime_surface')).toBe(true);
  });

  it('22. runtime surface missing commit_policy → error', () => {
    const r = validateArchitectureBaseline(bl({
      runtime_surfaces: [{ id: 'rs1', title: 'RS', paths: ['x/'], mutable: false, commit_policy: '' as any, reason: 'r' }],
    }));
    expect(r.errors.some(e => e.type === 'runtime_surface_without_policy')).toBe(true);
  });

  it('23. runtime surface duplicate id → error', () => {
    const r = validateArchitectureBaseline(bl({
      runtime_surfaces: [
        { id: 'rs', title: 'A', paths: ['a/'], mutable: false, commit_policy: 'do_not_commit', reason: 'r' },
        { id: 'rs', title: 'B', paths: ['b/'], mutable: false, commit_policy: 'do_not_commit', reason: 'r' },
      ],
    }));
    expect(r.errors.some(e => e.type === 'duplicate_id' && e.entity_type === 'runtime_surface')).toBe(true);
  });

  // Risks
  it('24. risk missing mitigation → error', () => {
    const r = validateArchitectureBaseline(bl({
      risks: [{ id: 'r1', title: 'R', level: 'low', affected_paths: ['src/'], mitigation: '' }],
    }));
    expect(r.errors.some(e => e.type === 'risk_without_mitigation')).toBe(true);
  });

  it('25. risk duplicate id → error', () => {
    const r = validateArchitectureBaseline(bl({
      risks: [
        { id: 'r', title: 'A', level: 'low', affected_paths: ['a/'], mitigation: 'm' },
        { id: 'r', title: 'B', level: 'low', affected_paths: ['b/'], mitigation: 'm' },
      ],
    }));
    expect(r.errors.some(e => e.type === 'duplicate_id' && e.entity_type === 'risk')).toBe(true);
  });

  // warnings不影响valid
  it('26. warnings do not affect valid', () => {
    const r = validateArchitectureBaseline(bl({
      modules: [{ ...makeModule('m1'), paths: [] }],  // warning only
    }));
    expect(r.valid).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.errors).toEqual([]);
  });

  // summary
  it('27. summary counts are correct', () => {
    const r = validateArchitectureBaseline(bl({
      modules: [makeModule('a'), makeModule('b')],
      forbidden_zones: [{ id: 'fz1', title: 'FZ', paths: ['x/'], reason: 'r', severity: 'high', allowed_touch_policy: 'never' }],
      defense_lines: [],
      runtime_surfaces: [],
      risks: [{ id: 'r1', title: 'R1', level: 'low', affected_paths: ['src/'], mitigation: 'm' }, { id: 'r2', title: 'R2', level: 'medium', affected_paths: ['tests/'], mitigation: 'm' }],
    }));
    expect(r.summary.module_count).toBe(2);
    expect(r.summary.forbidden_zone_count).toBe(1);
    expect(r.summary.defense_line_count).toBe(0);
    expect(r.summary.runtime_surface_count).toBe(0);
    expect(r.summary.risk_count).toBe(2);
  });
});

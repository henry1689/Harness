/**
 * intent-builder.test.ts — ProjectBrain v0.1 IntentSpec Builder 测试
 * ====================================================================
 * P1-T2: 覆盖 buildIntentSpec + inferIntentRisk 的 20+ 场景。
 */
import { describe, expect, it } from 'vitest';
import {
  buildIntentSpec,
  inferIntentRisk,
} from '../../src/project-brain';
import type { BuildIntentSpecInput } from '../../src/project-brain/intent-builder';

// ============================================================================
// Helper
// ============================================================================

const FIXED_NOW = '2026-08-02T23:50:00.000Z';
const FIXED_ID = 'intent_20260802_235000_test01';

function baseInput(overrides: Partial<BuildIntentSpecInput> = {}): BuildIntentSpecInput {
  return {
    title: 'Test Intent',
    description: 'A test intent for builder tests.',
    ...overrides,
  };
}

// ============================================================================
// buildIntentSpec — 基础构造
// ============================================================================

describe('buildIntentSpec — basic construction', () => {
  it('1. constructs a minimal IntentSpec', () => {
    const spec = buildIntentSpec(baseInput({ now: FIXED_NOW, id: FIXED_ID }));

    expect(spec.id).toBe(FIXED_ID);
    expect(spec.title).toBe('Test Intent');
    expect(spec.description).toBe('A test intent for builder tests.');
    expect(spec.status).toBe('draft');
    expect(spec.created_at).toBe(FIXED_NOW);
    expect(spec.updated_at).toBe(FIXED_NOW);
    expect(spec.scope.allowed_paths).toEqual([]);
    expect(spec.scope.forbidden_paths).toEqual([]);
    expect(spec.evidence_ids).toEqual([]);
    expect(spec.decision_ids).toEqual([]);
  });

  it('2. trims title and description', () => {
    const spec = buildIntentSpec(baseInput({
      title: '  Trimmed Title  ',
      description: '\tTrimmed Description\n',
      now: FIXED_NOW,
      id: FIXED_ID,
    }));

    expect(spec.title).toBe('Trimmed Title');
    expect(spec.description).toBe('Trimmed Description');
  });

  it('3. trims requested_by', () => {
    const spec = buildIntentSpec(baseInput({
      requested_by: '  architect  ',
      now: FIXED_NOW,
      id: FIXED_ID,
    }));

    expect(spec.requested_by).toBe('architect');
  });

  it('4. requested_by undefined when empty after trim', () => {
    const spec = buildIntentSpec(baseInput({
      requested_by: '   ',
      now: FIXED_NOW,
      id: FIXED_ID,
    }));

    expect(spec.requested_by).toBeUndefined();
  });

  it('5. throws when title is empty string', () => {
    expect(() => buildIntentSpec(baseInput({ title: '' })))
      .toThrow('Intent title is required');
  });

  it('6. throws when title is whitespace only', () => {
    expect(() => buildIntentSpec(baseInput({ title: '   \t\n  ' })))
      .toThrow('Intent title is required');
  });

  it('7. throws when description is empty', () => {
    expect(() => buildIntentSpec(baseInput({ description: '' })))
      .toThrow('Intent description is required');
  });

  it('8. generated id starts with intent_ prefix', () => {
    const spec = buildIntentSpec(baseInput({ now: FIXED_NOW }));

    expect(spec.id).toMatch(/^intent_20260802_235000_[a-z0-9]{6}$/);
  });

  it('9. accepts external id', () => {
    const spec = buildIntentSpec(baseInput({ id: 'my-custom-id', now: FIXED_NOW }));

    expect(spec.id).toBe('my-custom-id');
  });

  it('10. trims external id', () => {
    const spec = buildIntentSpec(baseInput({ id: '  my-id  ', now: FIXED_NOW }));

    expect(spec.id).toBe('my-id');
  });

  it('11. empty external id treated as missing', () => {
    const spec = buildIntentSpec(baseInput({ id: '   ', now: FIXED_NOW }));

    expect(spec.id).toMatch(/^intent_/);
  });
});

// ============================================================================
// buildIntentSpec — 路径标准化
// ============================================================================

describe('buildIntentSpec — path normalization', () => {
  it('12. converts backslashes to forward slashes', () => {
    const spec = buildIntentSpec(baseInput({
      allowed_paths: ['src\\project-brain\\', 'tests\\project-brain'],
      now: FIXED_NOW,
      id: FIXED_ID,
    }));

    expect(spec.scope.allowed_paths).toEqual([
      'src/project-brain/',
      'tests/project-brain',
    ]);
  });

  it('13. removes empty strings from path lists', () => {
    const spec = buildIntentSpec(baseInput({
      allowed_paths: ['src/new/', '', '  ', 'tests/new/'],
      now: FIXED_NOW,
      id: FIXED_ID,
    }));

    expect(spec.scope.allowed_paths).toEqual(['src/new/', 'tests/new/']);
  });

  it('14. deduplicates paths preserving first occurrence order', () => {
    const spec = buildIntentSpec(baseInput({
      allowed_paths: ['src/a/', 'src/b/', 'src/a/', 'src/c/', 'src/b/'],
      now: FIXED_NOW,
      id: FIXED_ID,
    }));

    expect(spec.scope.allowed_paths).toEqual(['src/a/', 'src/b/', 'src/c/']);
  });

  it('15. deduplicates notes', () => {
    const spec = buildIntentSpec(baseInput({
      notes: ['Note A', 'Note B', 'Note A', '  Note C  ', 'Note B'],
      now: FIXED_NOW,
      id: FIXED_ID,
    }));

    expect(spec.scope.notes).toEqual(['Note A', 'Note B', 'Note C']);
  });

  it('16. deduplicates evidence_ids and decision_ids', () => {
    const spec = buildIntentSpec(baseInput({
      evidence_ids: ['ev-1', 'ev-2', 'ev-1', '  ev-3  '],
      decision_ids: ['dec-1', 'dec-2', 'dec-1'],
      now: FIXED_NOW,
      id: FIXED_ID,
    }));

    expect(spec.evidence_ids).toEqual(['ev-1', 'ev-2', 'ev-3']);
    expect(spec.decision_ids).toEqual(['dec-1', 'dec-2']);
  });

  it('17. expected_outputs undefined when empty after normalization', () => {
    const spec = buildIntentSpec(baseInput({
      expected_outputs: ['', '  ', '\t'],
      now: FIXED_NOW,
      id: FIXED_ID,
    }));

    expect(spec.scope.expected_outputs).toBeUndefined();
  });

  it('18. notes undefined when empty after normalization', () => {
    const spec = buildIntentSpec(baseInput({
      notes: ['', '  '],
      now: FIXED_NOW,
      id: FIXED_ID,
    }));

    expect(spec.scope.notes).toBeUndefined();
  });
});

// ============================================================================
// inferIntentRisk — 风险推断
// ============================================================================

describe('inferIntentRisk — risk inference', () => {
  const empty = { allowed_paths: [] as string[], forbidden_paths: [] as string[], expected_outputs: [] as string[] };

  it('19. empty allowed_paths => low risk', () => {
    const risk = inferIntentRisk(empty);
    expect(risk.level).toBe('low');
    expect(risk.requires_token).toBe(false);
    expect(risk.requires_architect_review).toBe(false);
  });

  it('20. docs/v4 only => low risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['docs/v4/'] });
    expect(risk.level).toBe('low');
    expect(risk.requires_token).toBe(false);
  });

  it('21. data/project-brain only => low risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['data/project-brain/'] });
    expect(risk.level).toBe('low');
  });

  it('22. src/project-brain => medium risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['src/project-brain/types.ts'] });
    expect(risk.level).toBe('medium');
    expect(risk.requires_token).toBe(false);
    expect(risk.requires_architect_review).toBe(false);
  });

  it('23. tests/ path => medium risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['tests/project-brain/intent-builder.test.ts'] });
    expect(risk.level).toBe('medium');
  });

  it('24. data/reports/ path => medium risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['data/reports/project-brain/'] });
    expect(risk.level).toBe('medium');
  });

  it('25. src/FlowEngine.ts => high risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['src/FlowEngine.ts'] });
    expect(risk.level).toBe('high');
    expect(risk.requires_token).toBe(true);
    expect(risk.requires_architect_review).toBe(true);
  });

  it('26. src/StageRunner.ts => high risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['src/StageRunner.ts'] });
    expect(risk.level).toBe('high');
  });

  it('27. src/GateController.ts => high risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['src/GateController.ts'] });
    expect(risk.level).toBe('high');
  });

  it('28. mcp/ directory => high risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['mcp/server.ts'] });
    expect(risk.level).toBe('high');
    expect(risk.requires_token).toBe(true);
  });

  it('29. sentinel/ directory => high risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['sentinel/sentinel-service.cjs'] });
    expect(risk.level).toBe('high');
  });

  it('30. scripts/harness-gate.cjs => high risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['scripts/harness-gate.cjs'] });
    expect(risk.level).toBe('high');
  });

  it('31. hooks/ directory => high risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['hooks/pre-commit'] });
    expect(risk.level).toBe('high');
  });

  it('32. data/tokens => critical risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['data/tokens'] });
    expect(risk.level).toBe('critical');
    expect(risk.requires_token).toBe(true);
    expect(risk.requires_architect_review).toBe(true);
  });

  it('33. data/tokens/ sub-path => critical risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['data/tokens/token-001.json'] });
    expect(risk.level).toBe('critical');
    expect(risk.requires_token).toBe(true);
  });

  it('34. data/audit => critical risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['data/audit'] });
    expect(risk.level).toBe('critical');
  });

  it('35. data/sentinel => critical risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['data/sentinel'] });
    expect(risk.level).toBe('critical');
  });

  it('36. package.json => critical risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['package.json'] });
    expect(risk.level).toBe('critical');
  });

  it('37. tsconfig.json => critical risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['tsconfig.json'] });
    expect(risk.level).toBe('critical');
  });

  it('38. ecosystem.config.cjs => critical risk', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['ecosystem.config.cjs'] });
    expect(risk.level).toBe('critical');
  });

  it('39. high + critical together => picks critical', () => {
    const risk = inferIntentRisk({
      ...empty,
      allowed_paths: ['src/FlowEngine.ts', 'data/tokens/token.json'],
    });
    expect(risk.level).toBe('critical');
  });

  it('40. medium + high together => picks high', () => {
    const risk = inferIntentRisk({
      ...empty,
      allowed_paths: ['src/project-brain/', 'src/FlowEngine.ts'],
    });
    expect(risk.level).toBe('high');
  });

  it('41. low + medium together => picks medium', () => {
    const risk = inferIntentRisk({
      ...empty,
      allowed_paths: ['docs/v4/', 'src/project-brain/types.ts'],
    });
    expect(risk.level).toBe('medium');
  });

  it('42. all four levels => picks critical', () => {
    const risk = inferIntentRisk({
      ...empty,
      allowed_paths: [
        'docs/v4/',                      // low
        'src/project-brain/',            // medium
        'src/FlowEngine.ts',             // high
        'package.json',                  // critical
      ],
    });
    expect(risk.level).toBe('critical');
  });

  it('43. reasons array is non-empty for all risk levels', () => {
    const low = inferIntentRisk({ ...empty, allowed_paths: [] });
    expect(low.reasons.length).toBeGreaterThan(0);

    const medium = inferIntentRisk({ ...empty, allowed_paths: ['src/project-brain/'] });
    expect(medium.reasons.length).toBeGreaterThan(0);

    const high = inferIntentRisk({ ...empty, allowed_paths: ['src/FlowEngine.ts'] });
    expect(high.reasons.length).toBeGreaterThan(0);

    const critical = inferIntentRisk({ ...empty, allowed_paths: ['data/tokens/'] });
    expect(critical.reasons.length).toBeGreaterThan(0);
  });

  it('44. high risk requires token and architect review', () => {
    const risk = inferIntentRisk({ ...empty, allowed_paths: ['scripts/harness-gate.cjs'] });
    expect(risk.requires_token).toBe(true);
    expect(risk.requires_architect_review).toBe(true);
  });
});

// ============================================================================
// buildIntentSpec — 风险集成
// ============================================================================

describe('buildIntentSpec — risk integration', () => {
  it('45. risk is inferred automatically in the built spec', () => {
    const spec = buildIntentSpec(baseInput({
      allowed_paths: ['src/FlowEngine.ts'],
      now: FIXED_NOW,
      id: FIXED_ID,
    }));

    expect(spec.risk.level).toBe('high');
    expect(spec.risk.requires_token).toBe(true);
    expect(spec.status).toBe('draft');
  });

  it('46. low-risk intent does not require token', () => {
    const spec = buildIntentSpec(baseInput({
      allowed_paths: ['docs/v4/upgrade-isolation-rules.md'],
      now: FIXED_NOW,
      id: FIXED_ID,
    }));

    expect(spec.risk.level).toBe('low');
    expect(spec.risk.requires_token).toBe(false);
  });
});

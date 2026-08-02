/**
 * types.test.ts — ProjectBrain v0.1 类型系统最小测试
 * ======================================================
 * P1-T1: 验证所有核心类型可被导入并构造合法实例。
 * 不测试运行时业务逻辑。
 */

import { describe, expect, it } from 'vitest';
import type {
  ProjectBrainRoot,
  ProjectProfile,
  IntentSpec,
  IntentScope,
  IntentRiskSummary,
  EvidenceRecord,
  DecisionRecord,
  RiskSignal,
  ProjectBrainSnapshot,
  ProjectBrainValidationResult,
} from '../../src/project-brain';

// ============================================================================
// ProjectBrainRoot
// ============================================================================

describe('ProjectBrain types — ProjectBrainRoot', () => {
  it('supports a minimal valid ProjectBrainRoot', () => {
    const root: ProjectBrainRoot = {
      schema_version: 1,
      project: {
        id: 'harness',
        name: 'Harness',
        root: 'D:/AI文件/harness',
      },
      intents: [],
      evidence: [],
      decisions: [],
      risks: [],
      generated_at: '2026-08-02T23:50:00+08:00',
    };

    expect(root.schema_version).toBe(1);
    expect(root.project.id).toBe('harness');
    expect(root.project.name).toBe('Harness');
    expect(root.intents).toHaveLength(0);
    expect(root.evidence).toHaveLength(0);
    expect(root.decisions).toHaveLength(0);
    expect(root.risks).toHaveLength(0);
  });

  it('supports a ProjectBrainRoot with populated intents', () => {
    const root: ProjectBrainRoot = {
      schema_version: 1,
      project: {
        id: 'wenstar-cc',
        name: 'WenStar CC',
        root: 'D:/tools/wenstar-cc',
        description: 'WenStar TypeScript core',
        owners: ['architect'],
        tags: ['typescript', 'wenstar'],
      },
      intents: [
        {
          id: 'intent-001',
          title: 'Add ProjectBrain types',
          description: 'Define core ProjectBrain type system for v4.0',
          requested_by: 'architect',
          created_at: '2026-08-02T23:00:00Z',
          status: 'draft',
          scope: {
            allowed_paths: ['src/project-brain/'],
            forbidden_paths: ['src/FlowEngine.ts', 'mcp/'],
          },
          risk: {
            level: 'low',
            reasons: ['new files only', 'no existing code modified'],
            requires_token: false,
            requires_architect_review: true,
          },
          evidence_ids: [],
          decision_ids: [],
        },
      ],
      evidence: [],
      decisions: [],
      risks: [],
      generated_at: '2026-08-02T23:50:00+08:00',
    };

    expect(root.intents).toHaveLength(1);
    expect(root.intents[0].id).toBe('intent-001');
    expect(root.intents[0].status).toBe('draft');
  });
});

// ============================================================================
// IntentSpec
// ============================================================================

describe('ProjectBrain types — IntentSpec', () => {
  it('supports all IntentStatus values', () => {
    const statuses = [
      'draft',
      'reviewing',
      'approved',
      'rejected',
      'implemented',
      'superseded',
    ] as const;

    const intent: IntentSpec = {
      id: 'i-1',
      title: 'Test',
      description: 'Test intent',
      created_at: '2026-08-02T00:00:00Z',
      status: 'draft',
      scope: { allowed_paths: [], forbidden_paths: [] },
      risk: { level: 'low', reasons: [], requires_token: false, requires_architect_review: false },
      evidence_ids: [],
      decision_ids: [],
    };

    for (const s of statuses) {
      intent.status = s;
      expect(intent.status).toBe(s);
    }
  });

  it('supports optional fields omitted', () => {
    const intent: IntentSpec = {
      id: 'i-min',
      title: 'Minimal Intent',
      description: 'Minimal intent with no optional fields',
      created_at: '2026-08-02T00:00:00Z',
      status: 'draft',
      scope: { allowed_paths: ['src/new/'], forbidden_paths: [] },
      risk: { level: 'low', reasons: [], requires_token: false, requires_architect_review: false },
      evidence_ids: [],
      decision_ids: [],
    };

    // optional fields should be undefined when omitted
    expect(intent.requested_by).toBeUndefined();
    expect(intent.updated_at).toBeUndefined();
  });

  it('supports IntentScope with all optional fields', () => {
    const scope: IntentScope = {
      allowed_paths: ['src/project-brain/', 'tests/project-brain/'],
      forbidden_paths: ['src/FlowEngine.ts', 'mcp/server.ts'],
      expected_outputs: ['src/project-brain/types.ts'],
      notes: ['Architect review required before merging'],
    };

    expect(scope.allowed_paths).toHaveLength(2);
    expect(scope.forbidden_paths).toHaveLength(2);
    expect(scope.expected_outputs).toBeDefined();
    expect(scope.notes).toHaveLength(1);
  });
});

// ============================================================================
// EvidenceRecord
// ============================================================================

describe('ProjectBrain types — EvidenceRecord', () => {
  it('supports a minimal evidence record', () => {
    const evidence: EvidenceRecord = {
      id: 'ev-001',
      type: 'baseline_report',
      title: 'P0-T1 Baseline',
      source: 'data/reports/baseline/baseline-20260802-225953.json',
      captured_at: '2026-08-02T14:55:07Z',
    };

    expect(evidence.id).toBe('ev-001');
    expect(evidence.type).toBe('baseline_report');
  });

  it('supports all EvidenceType values', () => {
    const types = [
      'baseline_report',
      'health_report',
      'test_result',
      'code_review',
      'architect_decision',
      'runtime_observation',
      'manual_note',
    ] as const;

    for (const t of types) {
      const ev: EvidenceRecord = {
        id: 'ev',
        type: t,
        title: t,
        source: 'some/path',
        captured_at: '2026-08-02T00:00:00Z',
      };
      expect(ev.type).toBe(t);
    }
  });

  it('supports evidence with metadata', () => {
    const evidence: EvidenceRecord = {
      id: 'ev-002',
      type: 'test_result',
      title: 'Vitest run',
      source: 'vitest output',
      captured_at: '2026-08-02T00:00:00Z',
      summary: '67 tests passed, 6 files',
      related_paths: ['src/project-brain/types.ts'],
      metadata: {
        test_count: 67,
        file_count: 6,
        duration_ms: 2859,
      },
    };

    expect(evidence.metadata?.test_count).toBe(67);
    expect(evidence.related_paths).toContain('src/project-brain/types.ts');
  });
});

// ============================================================================
// DecisionRecord
// ============================================================================

describe('ProjectBrain types — DecisionRecord', () => {
  it('supports a minimal decision record', () => {
    const decision: DecisionRecord = {
      id: 'dec-001',
      type: 'approve',
      made_at: '2026-08-02T15:00:00Z',
      made_by: 'architect',
      summary: 'P1-T1 type skeleton approved',
      status: 'active',
    };

    expect(decision.type).toBe('approve');
    expect(decision.status).toBe('active');
  });

  it('supports all DecisionType and DecisionStatus values', () => {
    const types = ['approve', 'reject', 'defer', 'escalate', 'override'] as const;
    const statuses = ['active', 'superseded', 'revoked'] as const;

    for (const t of types) {
      const d: DecisionRecord = {
        id: 'd',
        type: t,
        made_at: '2026-08-02T00:00:00Z',
        summary: t,
        status: 'active',
      };
      expect(d.type).toBe(t);
    }

    for (const s of statuses) {
      const d: DecisionRecord = {
        id: 'd',
        type: 'approve',
        made_at: '2026-08-02T00:00:00Z',
        summary: s,
        status: s,
      };
      expect(d.status).toBe(s);
    }
  });

  it('supports decision with rationale and related IDs', () => {
    const decision: DecisionRecord = {
      id: 'dec-002',
      type: 'escalate',
      made_at: '2026-08-02T16:00:00Z',
      made_by: 'architect',
      summary: 'Risk too high, escalate to architecture review',
      rationale: 'Modification touches FlowEngine core pipeline',
      related_intent_ids: ['intent-042'],
      related_evidence_ids: ['ev-001', 'ev-002'],
      status: 'active',
    };

    expect(decision.related_intent_ids).toHaveLength(1);
    expect(decision.related_evidence_ids).toHaveLength(2);
    expect(decision.rationale).toContain('FlowEngine');
  });
});

// ============================================================================
// RiskSignal
// ============================================================================

describe('ProjectBrain types — RiskSignal', () => {
  it('supports all RiskSignalSource values', () => {
    const sources = [
      'diff_scope',
      'architecture_baseline',
      'sentinel',
      'git_hook',
      'mcp',
      'test',
      'manual',
    ] as const;

    for (const s of sources) {
      const signal: RiskSignal = {
        level: 'high',
        source: s,
        message: 'Test signal from ' + s,
        detected_at: '2026-08-02T00:00:00Z',
      };
      expect(signal.source).toBe(s);
    }
  });

  it('supports all RiskLevel values', () => {
    const levels = ['low', 'medium', 'high', 'critical'] as const;

    for (const l of levels) {
      const signal: RiskSignal = {
        level: l,
        source: 'manual',
        message: 'Level ' + l,
        detected_at: '2026-08-02T00:00:00Z',
      };
      expect(signal.level).toBe(l);
    }
  });
});

// ============================================================================
// ProjectBrainSnapshot
// ============================================================================

describe('ProjectBrain types — ProjectBrainSnapshot', () => {
  it('wraps a ProjectBrainRoot in a snapshot', () => {
    const root: ProjectBrainRoot = {
      schema_version: 1,
      project: { id: 'test', name: 'Test', root: '/test' },
      intents: [],
      evidence: [],
      decisions: [],
      risks: [],
      generated_at: '2026-08-02T23:00:00Z',
    };

    const snapshot: ProjectBrainSnapshot = {
      schema_version: 1,
      generated_at: '2026-08-02T23:00:00Z',
      root,
    };

    expect(snapshot.root.project.id).toBe('test');
    expect(snapshot.schema_version).toBe(1);
  });
});

// ============================================================================
// ProjectBrainValidationResult
// ============================================================================

describe('ProjectBrain types — ProjectBrainValidationResult', () => {
  it('supports valid result', () => {
    const result: ProjectBrainValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
    };

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('supports invalid result with errors and warnings', () => {
    const result: ProjectBrainValidationResult = {
      valid: false,
      errors: ['Missing required field: project.name'],
      warnings: ['Optional field "owners" is empty'],
    };

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });
});

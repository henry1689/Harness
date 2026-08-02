/**
 * store.test.ts — ProjectBrain v0.1 Store 测试
 * ===============================================
 * P1-T3: 覆盖 ProjectBrainStore 的 18+ 场景。
 *
 * 所有文件读写使用临时目录，不污染真实 data/project-brain/。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ProjectBrainStore,
  validateProjectBrainRoot,
  getDefaultProjectBrainPath,
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

const FIXED_NOW = '2026-08-03T00:00:00.000Z';
function fixedNow() {
  return FIXED_NOW;
}

let tempDir: string;
let storePath: string;
let store: ProjectBrainStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'harness-pb-store-'));
  storePath = path.join(tempDir, 'project-brain.json');
  store = new ProjectBrainStore({ filePath: storePath, now: fixedNow });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ============================================================================
// getDefaultProjectBrainPath
// ============================================================================

describe('getDefaultProjectBrainPath', () => {
  it('1. returns expected path under data/project-brain/', () => {
    const result = getDefaultProjectBrainPath('D:/test/project');
    expect(result).toBe(path.join('D:/test/project', 'data', 'project-brain', 'project-brain.json'));
  });

  it('2. defaults to process.cwd() when no argument', () => {
    const result = getDefaultProjectBrainPath();
    expect(result).toContain('data');
    expect(result).toContain('project-brain.json');
  });
});

// ============================================================================
// createDefaultRoot
// ============================================================================

describe('ProjectBrainStore — createDefaultRoot', () => {
  it('3. creates a root with schema_version=1', () => {
    const root = store.createDefaultRoot();
    expect(root.schema_version).toBe(1);
    expect(root.generated_at).toBe(FIXED_NOW);
  });

  it('4. uses default project values when not provided', () => {
    const root = store.createDefaultRoot();
    expect(root.project.id).toBe('harness');
    expect(root.project.name).toBe('Harness');
    expect(typeof root.project.root).toBe('string');
  });

  it('5. uses custom project overrides', () => {
    const store2 = new ProjectBrainStore({
      filePath: storePath,
      project: { id: 'wenstar-cc', name: 'WenStar', root: 'D:/tools/wenstar-cc' },
      now: fixedNow,
    });
    const root = store2.createDefaultRoot();
    expect(root.project.id).toBe('wenstar-cc');
    expect(root.project.name).toBe('WenStar');
    expect(root.project.root).toBe('D:/tools/wenstar-cc');
  });

  it('6. initializes all arrays empty', () => {
    const root = store.createDefaultRoot();
    expect(root.intents).toEqual([]);
    expect(root.evidence).toEqual([]);
    expect(root.decisions).toEqual([]);
    expect(root.risks).toEqual([]);
  });
});

// ============================================================================
// loadOrCreate / load / save
// ============================================================================

describe('ProjectBrainStore — loadOrCreate / load / save', () => {
  it('7. loadOrCreate creates file when it does not exist', async () => {
    const root = await store.loadOrCreate();
    expect(root.schema_version).toBe(1);
    expect(root.project.id).toBe('harness');

    // file should now exist on disk
    const { existsSync } = await import('node:fs');
    expect(existsSync(storePath)).toBe(true);
  });

  it('8. loadOrCreate loads existing file when it exists', async () => {
    // First call creates
    await store.loadOrCreate();
    // Second call loads
    const root = await store.loadOrCreate();
    expect(root.schema_version).toBe(1);
  });

  it('9. load throws when file does not exist', async () => {
    await expect(store.load()).rejects.toThrow('ProjectBrain store file does not exist');
  });

  it('10. load throws on invalid JSON', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(storePath, 'not valid json', 'utf8');

    await expect(store.load()).rejects.toThrow('Failed to parse ProjectBrain store JSON');
  });

  it('11. load throws on invalid schema', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(storePath, JSON.stringify({ schema_version: 99 }), 'utf8');

    await expect(store.load()).rejects.toThrow('Invalid ProjectBrain store');
  });

  it('12. save writes formatted JSON with 2-space indent', async () => {
    const root = store.createDefaultRoot();
    await store.save(root);

    const { readFile } = await import('node:fs/promises');
    const content = await readFile(storePath, 'utf8');
    const parsed = JSON.parse(content);

    expect(parsed.schema_version).toBe(1);
    expect(content).toContain('  "schema_version"');
  });

  it('13. save creates parent directory if missing', async () => {
    const nestedPath = path.join(tempDir, 'nested', 'deep', 'brain.json');
    const nestedStore = new ProjectBrainStore({ filePath: nestedPath, now: fixedNow });
    const root = nestedStore.createDefaultRoot();
    await nestedStore.save(root);

    const { existsSync } = await import('node:fs');
    expect(existsSync(nestedPath)).toBe(true);
  });

  it('14. save rejects invalid root', async () => {
    const badRoot = { schema_version: 99 } as unknown as ProjectBrainRoot;
    await expect(store.save(badRoot)).rejects.toThrow('Cannot save invalid ProjectBrain root');
  });
});

// ============================================================================
// appendIntent / appendEvidence / appendDecision / appendRisk
// ============================================================================

describe('ProjectBrainStore — append methods', () => {
  const sampleIntent: IntentSpec = {
    id: 'intent-001',
    title: 'Test Intent',
    description: 'A test intent',
    created_at: FIXED_NOW,
    status: 'draft',
    scope: { allowed_paths: ['src/project-brain/'], forbidden_paths: [] },
    risk: { level: 'low', reasons: [], requires_token: false, requires_architect_review: false },
    evidence_ids: [],
    decision_ids: [],
  };

  const sampleEvidence: EvidenceRecord = {
    id: 'ev-001',
    type: 'test_result',
    title: 'Test Evidence',
    source: 'vitest output',
    captured_at: FIXED_NOW,
  };

  const sampleDecision: DecisionRecord = {
    id: 'dec-001',
    type: 'approve',
    made_at: FIXED_NOW,
    summary: 'Approved',
    status: 'active',
  };

  const sampleRisk: RiskSignal = {
    level: 'medium',
    source: 'test',
    message: 'Test risk signal',
    detected_at: FIXED_NOW,
  };

  it('15. appendIntent appends intent and updates generated_at', async () => {
    const root = await store.appendIntent(sampleIntent);
    expect(root.intents).toHaveLength(1);
    expect(root.intents[0].id).toBe('intent-001');
    expect(root.generated_at).toBe(FIXED_NOW);
  });

  it('16. appendEvidence appends evidence', async () => {
    const root = await store.appendEvidence(sampleEvidence);
    expect(root.evidence).toHaveLength(1);
    expect(root.evidence[0].id).toBe('ev-001');
  });

  it('17. appendDecision appends decision', async () => {
    const root = await store.appendDecision(sampleDecision);
    expect(root.decisions).toHaveLength(1);
    expect(root.decisions[0].id).toBe('dec-001');
  });

  it('18. appendRisk appends risk', async () => {
    const root = await store.appendRisk(sampleRisk);
    expect(root.risks).toHaveLength(1);
    expect(root.risks[0].level).toBe('medium');
  });

  it('19. multiple appends preserve order', async () => {
    await store.appendIntent({ ...sampleIntent, id: 'i-1', title: 'First' });
    await store.appendIntent({ ...sampleIntent, id: 'i-2', title: 'Second' });
    await store.appendIntent({ ...sampleIntent, id: 'i-3', title: 'Third' });

    const root = await store.load();
    expect(root.intents).toHaveLength(3);
    expect(root.intents[0].title).toBe('First');
    expect(root.intents[1].title).toBe('Second');
    expect(root.intents[2].title).toBe('Third');
  });

  it('20. append persists to disk across store instances', async () => {
    await store.appendIntent(sampleIntent);

    // New store instance with same file path
    const store2 = new ProjectBrainStore({ filePath: storePath, now: fixedNow });
    const root = await store2.load();
    expect(root.intents).toHaveLength(1);
    expect(root.intents[0].id).toBe('intent-001');
  });
});

// ============================================================================
// validateProjectBrainRoot
// ============================================================================

describe('validateProjectBrainRoot', () => {
  const validRoot: ProjectBrainRoot = {
    schema_version: 1,
    project: { id: 'test', name: 'Test', root: '/test' },
    intents: [],
    evidence: [],
    decisions: [],
    risks: [],
    generated_at: FIXED_NOW,
  };

  it('21. accepts valid root', () => {
    const result = validateProjectBrainRoot(validRoot);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('22. rejects non-object values', () => {
    expect(validateProjectBrainRoot(null).valid).toBe(false);
    expect(validateProjectBrainRoot(undefined).valid).toBe(false);
    expect(validateProjectBrainRoot('string').valid).toBe(false);
    expect(validateProjectBrainRoot(42).valid).toBe(false);
  });

  it('23. rejects schema_version !== 1', () => {
    const root = { ...validRoot, schema_version: 2 };
    const result = validateProjectBrainRoot(root);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('schema_version'))).toBe(true);
  });

  it('24. rejects missing project object', () => {
    const root = { ...validRoot, project: null };
    const result = validateProjectBrainRoot(root);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('project'))).toBe(true);
  });

  it('25. rejects empty project.id', () => {
    const root = {
      ...validRoot,
      project: { id: '', name: 'Test', root: '/test' },
    };
    const result = validateProjectBrainRoot(root);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('project.id'))).toBe(true);
  });

  it('26. rejects empty project.name', () => {
    const root = {
      ...validRoot,
      project: { id: 'test', name: '', root: '/test' },
    };
    const result = validateProjectBrainRoot(root);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('project.name'))).toBe(true);
  });

  it('27. rejects empty project.root', () => {
    const root = {
      ...validRoot,
      project: { id: 'test', name: 'Test', root: '' },
    };
    const result = validateProjectBrainRoot(root);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('project.root'))).toBe(true);
  });

  it('28. rejects array fields that are not arrays', () => {
    const root = { ...validRoot, intents: 'not-an-array' as unknown };
    const result = validateProjectBrainRoot(root);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('intents must be an array'))).toBe(true);
  });

  it('29. rejects empty generated_at', () => {
    const root = { ...validRoot, generated_at: '' };
    const result = validateProjectBrainRoot(root);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('generated_at'))).toBe(true);
  });
});

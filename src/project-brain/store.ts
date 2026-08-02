/**
 * store.ts — ProjectBrain v0.1 本地 JSON 存储层
 * ================================================
 * P1-T3: ProjectBrainStore。
 *
 * 支持：
 * - 创建默认 ProjectBrainRoot
 * - 从 JSON 文件加载 / 原子保存
 * - append intent / evidence / decision / risk
 * - 基础 schema 校验
 *
 * 架构约束（见 docs/v4/upgrade-isolation-rules.md）：
 * - 不接入 S1-S7
 * - 不调用 MCP / Sentinel
 * - 不修改 token
 * - 仅写入 data/project-brain/ 目录
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  DecisionRecord,
  EvidenceRecord,
  IntentSpec,
  IsoTimestamp,
  ProjectBrainRoot,
  ProjectBrainValidationResult,
  ProjectProfile,
  RiskSignal,
} from './types';

// ============================================================================
// ProjectBrainStoreOptions
// ============================================================================

export interface ProjectBrainStoreOptions {
  /** JSON 存储文件路径（绝对路径或相对 CWD） */
  filePath: string;
  /** 项目档案覆写（用于创建默认 root 时） */
  project?: Partial<ProjectProfile>;
  /** 时间注入（用于测试） */
  now?: () => IsoTimestamp;
}

// ============================================================================
// ProjectBrainStore
// ============================================================================

export class ProjectBrainStore {
  readonly #filePath: string;
  readonly #project: Partial<ProjectProfile>;
  readonly #now: () => IsoTimestamp;

  constructor(options: ProjectBrainStoreOptions) {
    this.#filePath = path.resolve(options.filePath);
    this.#project = options.project ?? {};
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** 存储文件的绝对路径 */
  get filePath(): string {
    return this.#filePath;
  }

  // ── createDefaultRoot ──

  /** 创建默认（空）ProjectBrainRoot，不写文件 */
  createDefaultRoot(): ProjectBrainRoot {
    return {
      schema_version: 1,
      project: {
        id: this.#project.id ?? 'harness',
        name: this.#project.name ?? 'Harness',
        root: this.#project.root ?? process.cwd(),
        description: this.#project.description,
        owners: this.#project.owners,
        tags: this.#project.tags,
      },
      intents: [],
      evidence: [],
      decisions: [],
      risks: [],
      generated_at: this.#now(),
    };
  }

  // ── loadOrCreate ──

  /** 如果 store 文件存在则加载，否则创建默认 root 并保存 */
  async loadOrCreate(): Promise<ProjectBrainRoot> {
    if (existsSync(this.#filePath)) {
      return this.load();
    }
    const root = this.createDefaultRoot();
    await this.save(root);
    return root;
  }

  // ── load ──

  /** 从文件加载并校验 */
  async load(): Promise<ProjectBrainRoot> {
    if (!existsSync(this.#filePath)) {
      throw new Error('ProjectBrain store file does not exist: ' + this.#filePath);
    }

    let raw: string;
    try {
      raw = await readFile(this.#filePath, 'utf8');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error('Failed to read ProjectBrain store: ' + msg);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error('Failed to parse ProjectBrain store JSON: ' + msg);
    }

    const result = validateProjectBrainRoot(parsed);
    if (!result.valid) {
      throw new Error('Invalid ProjectBrain store: ' + result.errors.join('; '));
    }

    return parsed as ProjectBrainRoot;
  }

  // ── save ──

  /** 原子保存：写 tmp → rename */
  async save(root: ProjectBrainRoot): Promise<void> {
    const result = validateProjectBrainRoot(root);
    if (!result.valid) {
      throw new Error('Cannot save invalid ProjectBrain root: ' + result.errors.join('; '));
    }

    // 确保父目录存在
    const dir = path.dirname(this.#filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const tmp = this.#filePath + '.tmp';
    const json = JSON.stringify(root, null, 2);
    await writeFile(tmp, json, 'utf8');
    await rename(tmp, this.#filePath);
  }

  // ── append 方法 ──

  async appendIntent(intent: IntentSpec): Promise<ProjectBrainRoot> {
    const root = await this.loadOrCreate();
    root.intents.push(intent);
    root.generated_at = this.#now();
    await this.save(root);
    return root;
  }

  async appendEvidence(evidence: EvidenceRecord): Promise<ProjectBrainRoot> {
    const root = await this.loadOrCreate();
    root.evidence.push(evidence);
    root.generated_at = this.#now();
    await this.save(root);
    return root;
  }

  async appendDecision(decision: DecisionRecord): Promise<ProjectBrainRoot> {
    const root = await this.loadOrCreate();
    root.decisions.push(decision);
    root.generated_at = this.#now();
    await this.save(root);
    return root;
  }

  async appendRisk(risk: RiskSignal): Promise<ProjectBrainRoot> {
    const root = await this.loadOrCreate();
    root.risks.push(risk);
    root.generated_at = this.#now();
    await this.save(root);
    return root;
  }
}

// ============================================================================
// validateProjectBrainRoot
// ============================================================================

/**
 * 对 ProjectBrainRoot 进行基础 schema 校验。
 *
 * 校验规则（最小）：
 * - value 是 object
 * - schema_version === 1
 * - project 是 object，id/name/root 是 string 且非空
 * - intents / evidence / decisions / risks 是 array
 * - generated_at 是 string 且非空
 */
export function validateProjectBrainRoot(value: unknown): ProjectBrainValidationResult {
  const errors: string[] = [];

  if (value === null || typeof value !== 'object') {
    errors.push('value must be a non-null object');
    return { valid: false, errors, warnings: [] };
  }

  const root = value as Record<string, unknown>;

  // schema_version
  if (root.schema_version !== 1) {
    errors.push('schema_version must be 1, got: ' + String(root.schema_version));
  }

  // project
  if (root.project === null || typeof root.project !== 'object') {
    errors.push('project must be a non-null object');
  } else {
    const proj = root.project as Record<string, unknown>;
    if (typeof proj.id !== 'string' || !proj.id) errors.push('project.id must be a non-empty string');
    if (typeof proj.name !== 'string' || !proj.name) errors.push('project.name must be a non-empty string');
    if (typeof proj.root !== 'string' || !proj.root) errors.push('project.root must be a non-empty string');
  }

  // arrays
  if (!Array.isArray(root.intents)) errors.push('intents must be an array');
  if (!Array.isArray(root.evidence)) errors.push('evidence must be an array');
  if (!Array.isArray(root.decisions)) errors.push('decisions must be an array');
  if (!Array.isArray(root.risks)) errors.push('risks must be an array');

  // generated_at
  if (typeof root.generated_at !== 'string' || !root.generated_at) {
    errors.push('generated_at must be a non-empty string');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 返回默认 ProjectBrain 存储文件路径。
 *
 * @param rootDir 项目根目录（默认为 process.cwd()）
 */
export function getDefaultProjectBrainPath(rootDir: string = process.cwd()): string {
  return path.join(rootDir, 'data', 'project-brain', 'project-brain.json');
}

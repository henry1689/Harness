/**
 * architecture-baseline.ts — ArchitectureBaseline 类型与纯数据模型 (P3-T1)
 * =========================================================================
 * P3-T1: 定义 Harness v4.0 的架构边界与防线拓扑。
 *
 * 特性：
 * - ArchitectureBaseline 顶层模型
 * - ModuleBoundary / ForbiddenZone / DefenseLine / RuntimeSurface / BaselineRisk
 * - createArchitectureBaseline 纯函数构建器
 * - validateArchitectureBaseline 校验器（27 条规则）
 * - 不扫描真实仓库、不读 git diff、不访问文件系统
 */
import type { IsoTimestamp, RelativePath, RiskLevel } from './types';

// ============================================================================
// ArchitectureBaseline
// ============================================================================

export interface ArchitectureBaseline {
  /** 基线唯一 ID */
  id: string;
  /** 基线版本号 */
  version: string;
  /** 基线标题 */
  title: string;
  /** 采集时间 */
  captured_at: IsoTimestamp;
  /** 基线范围 */
  scope: ArchitectureScope;
  /** 模块边界列表 */
  modules: ModuleBoundary[];
  /** 禁止区域列表 */
  forbidden_zones: ForbiddenZone[];
  /** 防线定义列表 */
  defense_lines: DefenseLine[];
  /** 运行时表面列表 */
  runtime_surfaces: RuntimeSurface[];
  /** 基线风险列表 */
  risks: BaselineRisk[];
  /** 额外元数据 */
  metadata: Record<string, unknown>;
}

// ============================================================================
// ArchitectureScope
// ============================================================================

export interface ArchitectureScope {
  /** 项目根目录 */
  root: RelativePath;
  /** 基线覆盖的路径 */
  included_paths: RelativePath[];
  /** 基线排除的路径 */
  excluded_paths: RelativePath[];
}

// ============================================================================
// ModuleBoundary
// ============================================================================

export interface ModuleBoundary {
  /** 模块唯一 ID */
  id: string;
  /** 模块标题 */
  title: string;
  /** 模块文件路径列表 */
  paths: RelativePath[];
  /** 模块职责描述 */
  responsibilities: string[];
  /** 允许依赖的模块 ID 列表 */
  allowed_dependencies: string[];
  /** 禁止依赖的模块 ID 列表 */
  forbidden_dependencies: string[];
  /** 模块负责人（可选） */
  owner?: string;
  /** 额外元数据（可选） */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// ForbiddenZone
// ============================================================================

export interface ForbiddenZone {
  /** 禁止区域唯一 ID */
  id: string;
  /** 标题 */
  title: string;
  /** 禁止区域覆盖的路径 */
  paths: RelativePath[];
  /** 禁止原因 */
  reason: string;
  /** 严重程度 */
  severity: RiskLevel;
  /** 触碰策略 */
  allowed_touch_policy: 'never' | 'explicit_approval' | 'maintenance_only';
  /** 额外元数据（可选） */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// DefenseLine
// ============================================================================

export interface DefenseLine {
  /** 防线唯一 ID */
  id: string;
  /** 标题 */
  title: string;
  /** 防线类型 */
  kind: 'pm2_guard' | 'mcp_gate' | 'sentinel' | 'git_hook' | 'manual_audit' | 'other';
  /** 当前状态 */
  status: 'expected_pass' | 'expected_warn' | 'expected_fail' | 'unknown';
  /** 相关文件路径 */
  related_paths: RelativePath[];
  /** 防线职责描述 */
  responsibilities: string[];
  /** 额外元数据（可选） */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// RuntimeSurface
// ============================================================================

export interface RuntimeSurface {
  /** 运行时表面唯一 ID */
  id: string;
  /** 标题 */
  title: string;
  /** 覆盖的路径 */
  paths: RelativePath[];
  /** 是否可以被运行时修改 */
  mutable: boolean;
  /** 提交策略 */
  commit_policy: 'commit' | 'do_not_commit' | 'review_required';
  /** 策略原因 */
  reason: string;
  /** 额外元数据（可选） */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// BaselineRisk
// ============================================================================

export interface BaselineRisk {
  /** 风险唯一 ID */
  id: string;
  /** 标题 */
  title: string;
  /** 风险等级 */
  level: RiskLevel;
  /** 影响路径 */
  affected_paths: RelativePath[];
  /** 缓解措施 */
  mitigation: string;
  /** 额外元数据（可选） */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// createArchitectureBaseline
// ============================================================================

export interface CreateArchitectureBaselineInput {
  id: string;
  version: string;
  title: string;
  captured_at?: IsoTimestamp;
  scope: ArchitectureScope;
  modules?: ModuleBoundary[];
  forbidden_zones?: ForbiddenZone[];
  defense_lines?: DefenseLine[];
  runtime_surfaces?: RuntimeSurface[];
  risks?: BaselineRisk[];
  metadata?: Record<string, unknown>;
}

/**
 * 创建 ArchitectureBaseline。可选字段有合理默认值。
 * 纯函数——不访问文件系统，不读 git。
 */
export function createArchitectureBaseline(
  input: CreateArchitectureBaselineInput,
): ArchitectureBaseline {
  return {
    id: input.id,
    version: input.version,
    title: input.title,
    captured_at: input.captured_at ?? new Date().toISOString(),
    scope: {
      root: input.scope.root,
      included_paths: [...input.scope.included_paths],
      excluded_paths: [...input.scope.excluded_paths],
    },
    modules: [...(input.modules ?? [])],
    forbidden_zones: [...(input.forbidden_zones ?? [])],
    defense_lines: [...(input.defense_lines ?? [])],
    runtime_surfaces: [...(input.runtime_surfaces ?? [])],
    risks: [...(input.risks ?? [])],
    metadata: { ...(input.metadata ?? {}) },
  };
}

// ============================================================================
// ArchitectureBaselineValidation
// ============================================================================

export interface ArchitectureBaselineValidationResult {
  valid: boolean;
  errors: ArchitectureBaselineValidationIssue[];
  warnings: ArchitectureBaselineValidationIssue[];
  summary: {
    module_count: number;
    forbidden_zone_count: number;
    defense_line_count: number;
    runtime_surface_count: number;
    risk_count: number;
  };
}

export interface ArchitectureBaselineValidationIssue {
  type:
    | 'missing_required_field'
    | 'empty_paths'
    | 'duplicate_id'
    | 'forbidden_zone_without_reason'
    | 'runtime_surface_without_policy'
    | 'defense_line_without_responsibility'
    | 'risk_without_mitigation';
  entity_type:
    | 'baseline'
    | 'module'
    | 'forbidden_zone'
    | 'defense_line'
    | 'runtime_surface'
    | 'risk';
  entity_id?: string;
  field?: string;
  message: string;
}

// ============================================================================
// validateArchitectureBaseline
// ============================================================================

/**
 * 校验 ArchitectureBaseline。
 * errors 影响 valid；warnings 不影响 valid。
 */
export function validateArchitectureBaseline(
  baseline: ArchitectureBaseline,
): ArchitectureBaselineValidationResult {
  const errors: ArchitectureBaselineValidationIssue[] = [];
  const warnings: ArchitectureBaselineValidationIssue[] = [];

  // Baseline level
  checkRequired(baseline, 'id', 'baseline', errors);
  checkRequired(baseline, 'version', 'baseline', errors);
  checkRequired(baseline, 'title', 'baseline', errors);
  checkRequired(baseline.scope, 'root', 'baseline', errors);

  // Modules
  const modIds = new Set<string>();
  for (const mod of baseline.modules) {
    checkRequired(mod, 'id', 'module', errors);
    checkRequired(mod, 'title', 'module', errors);
    checkArrayNonEmpty(mod, 'paths', 'module', warnings, 'empty_paths');
    checkDupId(mod.id, modIds, 'module', errors);
  }

  // Forbidden zones
  const fzIds = new Set<string>();
  for (const fz of baseline.forbidden_zones) {
    checkRequired(fz, 'id', 'forbidden_zone', errors);
    checkRequired(fz, 'title', 'forbidden_zone', errors);
    checkArrayNonEmpty(fz, 'paths', 'forbidden_zone', warnings, 'empty_paths');
    checkDupId(fz.id, fzIds, 'forbidden_zone', errors);

    if (!fz.reason || !fz.reason.trim()) {
      errors.push({
        type: 'forbidden_zone_without_reason',
        entity_type: 'forbidden_zone',
        entity_id: fz.id || '(missing id)',
        field: 'reason',
        message: `Forbidden zone "${fz.id || '(missing id)'}" is missing reason.`,
      });
    }
  }

  // Defense lines
  const dlIds = new Set<string>();
  for (const dl of baseline.defense_lines) {
    checkRequired(dl, 'id', 'defense_line', errors);
    checkRequired(dl, 'title', 'defense_line', errors);
    checkArrayNonEmpty(dl, 'responsibilities', 'defense_line', warnings, 'defense_line_without_responsibility');
    checkDupId(dl.id, dlIds, 'defense_line', errors);
  }

  // Runtime surfaces
  const rsIds = new Set<string>();
  for (const rs of baseline.runtime_surfaces) {
    checkRequired(rs, 'id', 'runtime_surface', errors);
    checkRequired(rs, 'title', 'runtime_surface', errors);
    checkArrayNonEmpty(rs, 'paths', 'runtime_surface', warnings, 'empty_paths');
    checkDupId(rs.id, rsIds, 'runtime_surface', errors);

    if (!rs.commit_policy) {
      errors.push({
        type: 'runtime_surface_without_policy',
        entity_type: 'runtime_surface',
        entity_id: rs.id || '(missing id)',
        field: 'commit_policy',
        message: `Runtime surface "${rs.id || '(missing id)'}" is missing commit_policy.`,
      });
    }
  }

  // Risks
  const riskIds = new Set<string>();
  for (const r of baseline.risks) {
    checkRequired(r, 'id', 'risk', errors);
    checkRequired(r, 'title', 'risk', errors);
    checkDupId(r.id, riskIds, 'risk', errors);

    if (!r.mitigation || !r.mitigation.trim()) {
      errors.push({
        type: 'risk_without_mitigation',
        entity_type: 'risk',
        entity_id: r.id || '(missing id)',
        field: 'mitigation',
        message: `Risk "${r.id || '(missing id)'}" is missing mitigation.`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      module_count: baseline.modules.length,
      forbidden_zone_count: baseline.forbidden_zones.length,
      defense_line_count: baseline.defense_lines.length,
      runtime_surface_count: baseline.runtime_surfaces.length,
      risk_count: baseline.risks.length,
    },
  };
}

// ============================================================================
// 内部辅助
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asAny(obj: unknown): any { return obj; }

function checkRequired(
  obj: unknown,
  field: string,
  entity: ArchitectureBaselineValidationIssue['entity_type'],
  errors: ArchitectureBaselineValidationIssue[],
): void {
  const o = asAny(obj);
  const val = o[field];
  const id = String(o['id'] ?? '(missing id)');
  if (val === undefined || val === null || String(val).trim() === '') {
    errors.push({
      type: 'missing_required_field',
      entity_type: entity,
      entity_id: id,
      field,
      message: `${entity} "${id}" is missing required field: ${field}`,
    });
  }
}

function checkArrayNonEmpty(
  obj: unknown,
  field: string,
  entity: ArchitectureBaselineValidationIssue['entity_type'],
  warnings: ArchitectureBaselineValidationIssue[],
  type: ArchitectureBaselineValidationIssue['type'],
): void {
  const o = asAny(obj);
  const val = o[field];
  const id = String(o['id'] ?? '(missing id)');
  if (!Array.isArray(val) || val.length === 0) {
    warnings.push({
      type,
      entity_type: entity,
      entity_id: id,
      field,
      message: `${entity} "${id}" has empty ${field}.`,
    });
  }
}

function checkDupId(
  id: string | undefined,
  seen: Set<string>,
  entity: ArchitectureBaselineValidationIssue['entity_type'],
  errors: ArchitectureBaselineValidationIssue[],
): void {
  if (!id) return;
  if (seen.has(id)) {
    errors.push({
      type: 'duplicate_id',
      entity_type: entity,
      entity_id: id,
      field: 'id',
      message: `Duplicate ${entity} id: "${id}"`,
    });
  } else {
    seen.add(id);
  }
}

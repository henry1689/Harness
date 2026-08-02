/**
 * diff-scope-guard.ts — DiffScopeGuard 类型与纯函数判定 (P2-T1)
 * ===============================================================
 * P2-T1: 基于 IntentSpec.scope 判断 changed_paths 是否在允许范围内。
 *
 * 特性：
 * - 纯函数，不访问文件系统，不读 git diff
 * - 支持 strict / advisory 两种模式
 * - forbidden 优先于 allowed
 * - overlap warning 检测 (allowed ∩ forbidden 包含关系)
 * - 路径标准化 (反斜杠→斜杠、trim、去重)
 * - matched records 记录每个 changed path 的匹配规则
 */
import type { IntentSpec, RelativePath } from './types';

// ============================================================================
// 导出类型
// ============================================================================

export type DiffScopeGuardMode = 'strict' | 'advisory';

export interface EvaluateDiffScopeInput {
  /** 意图合约 */
  intent: IntentSpec;
  /** 变更文件路径列表 */
  changed_paths: RelativePath[];
  /** 判定模式（默认 strict） */
  mode?: DiffScopeGuardMode;
}

export interface DiffScopeGuardResult {
  /** 是否允许 */
  allowed: boolean;
  /** 判定模式 */
  mode: DiffScopeGuardMode;
  /** 标准化后的变更路径 */
  changed_paths: RelativePath[];
  /** 标准化后的允许范围 */
  allowed_paths: RelativePath[];
  /** 标准化后的禁止范围 */
  forbidden_paths: RelativePath[];
  /** 违规列表 */
  violations: DiffScopeViolation[];
  /** 警告列表 */
  warnings: DiffScopeWarning[];
  /** 每个 changed path 的匹配记录 */
  matched: DiffScopeMatchedPath[];
  /** 统计摘要 */
  summary: {
    changed_count: number;
    violation_count: number;
    warning_count: number;
    matched_allowed_count: number;
    matched_forbidden_count: number;
  };
}

export interface DiffScopeViolation {
  type:
    | 'forbidden_path_touched'
    | 'outside_allowed_scope'
    | 'empty_allowed_scope_with_changes';
  path: RelativePath;
  rule?: RelativePath;
  message: string;
}

export interface DiffScopeWarning {
  type:
    | 'no_changed_paths'
    | 'empty_allowed_scope'
    | 'overlapping_allowed_and_forbidden_scope';
  path?: RelativePath;
  rule?: RelativePath;
  message: string;
}

export interface DiffScopeMatchedPath {
  path: RelativePath;
  allowed_rule?: RelativePath;
  forbidden_rule?: RelativePath;
}

// ============================================================================
// 路径标准化
// ============================================================================

/**
 * 标准化单个路径：反斜杠→斜杠、trim、去空串。
 */
export function normalizeFilePath(value: string): string {
  return value.replace(/\\/g, '/').trim();
}

/**
 * 标准化路径列表：归一化、去空串、去重、保持首次出现顺序。
 */
export function normalizePathList(values: string[]): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const v of values) {
    const n = normalizeFilePath(v);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    result.push(n);
  }
  return result;
}

// ============================================================================
// pathMatchesRule
// ============================================================================

/**
 * 判断 path 是否匹配 rule。
 *
 * 匹配规则：
 * 1. 精确文件匹配: path === rule
 * 2. rule 以 "/" 结尾 → 目录前缀匹配
 * 3. rule 不以 "/" 结尾但 path 以 "rule/" 开头 → 目录匹配
 * 4. rule 以 "/**" 结尾 → 递归通配
 * 5. 不相似前缀不误匹配：`src/app` 不匹配 `src/application.ts`
 */
export function pathMatchesRule(path: RelativePath, rule: RelativePath): boolean {
  // 精确匹配
  if (path === rule) return true;

  // rule 以 "/**" 结尾 → 递归通配
  if (rule.endsWith('/**')) {
    const prefix = rule.slice(0, -3); // 去掉 "/**"
    return path === prefix || path.startsWith(prefix + '/');
  }

  // rule 以 "/" 结尾 → 目录前缀
  if (rule.endsWith('/')) {
    return path.startsWith(rule);
  }

  // rule 不以 "/" 结尾，但 path 以 "rule/" 开头 → 目录容错
  // 关键：必须紧跟着 "/"，避免 `src/app` 误匹配 `src/application.ts`
  if (path.startsWith(rule + '/')) {
    return true;
  }

  return false;
}

// ============================================================================
// evaluateDiffScope
// ============================================================================

/**
 * 基于意图合约的 allowed/forbidden scope 判定变更路径是否合规。
 *
 * 纯函数——不访问文件系统，不读 git diff。
 */
export function evaluateDiffScope(input: EvaluateDiffScopeInput): DiffScopeGuardResult {
  const mode: DiffScopeGuardMode = input.mode ?? 'strict';

  // 标准化
  const changed_paths = normalizePathList(input.changed_paths);
  const allowed_paths = normalizePathList(input.intent.scope.allowed_paths);
  const forbidden_paths = normalizePathList(input.intent.scope.forbidden_paths);

  const violations: DiffScopeViolation[] = [];
  const warnings: DiffScopeWarning[] = [];
  const matched: DiffScopeMatchedPath[] = [];

  // ── 0. 无 changed paths ──
  if (changed_paths.length === 0) {
    warnings.push({
      type: 'no_changed_paths',
      message: 'No changed paths provided.',
    });
    return buildResult(true, mode, changed_paths, allowed_paths, forbidden_paths, violations, warnings, matched);
  }

  // ── 1. allowed_paths 为空 ──
  if (allowed_paths.length === 0) {
    warnings.push({
      type: 'empty_allowed_scope',
      message: 'IntentSpec.scope.allowed_paths is empty.',
    });
    for (const p of changed_paths) {
      violations.push({
        type: 'empty_allowed_scope_with_changes',
        path: p,
        message: 'Changed path outside empty allowed scope: ' + p,
      });
    }
    const allowed = mode === 'advisory';
    return buildResult(allowed, mode, changed_paths, allowed_paths, forbidden_paths, violations, warnings, matched);
  }

  // ── 2. overlap detection (allowed vs forbidden) ──
  for (const fRule of forbidden_paths) {
    for (const aRule of allowed_paths) {
      // 检查是否一个规则包含另一个
      if (pathMatchesRule(aRule, fRule) || pathMatchesRule(fRule, aRule)) {
        warnings.push({
          type: 'overlapping_allowed_and_forbidden_scope',
          path: fRule,
          rule: aRule,
          message: `Overlap: forbidden="${fRule}" is within allowed="${aRule}"`,
        });
      }
    }
  }

  // ── 3. 逐个 changed path 判定 ──
  for (const p of changed_paths) {
    // 3a. forbidden 优先
    const forbiddenRule = findFirstMatch(p, forbidden_paths);

    // 3b. allowed
    const allowedRule = findFirstMatch(p, allowed_paths);

    matched.push({
      path: p,
      allowed_rule: allowedRule,
      forbidden_rule: forbiddenRule,
    });

    // 3c. forbidden 优先判定
    if (forbiddenRule) {
      violations.push({
        type: 'forbidden_path_touched',
        path: p,
        rule: forbiddenRule,
        message: `Path "${p}" matches forbidden rule "${forbiddenRule}"`,
      });
    }
    // 3d. outside allowed
    else if (!allowedRule) {
      violations.push({
        type: 'outside_allowed_scope',
        path: p,
        message: `Path "${p}" does not match any allowed rule`,
      });
    }
  }

  // ── 4. allowed ──
  const allowed = mode === 'advisory' ? true : violations.length === 0;

  return buildResult(allowed, mode, changed_paths, allowed_paths, forbidden_paths, violations, warnings, matched);
}

// ============================================================================
// 内部辅助
// ============================================================================

/**
 * 在规则列表中查找第一个匹配 path 的规则。
 */
function findFirstMatch(path: RelativePath, rules: RelativePath[]): RelativePath | undefined {
  for (const rule of rules) {
    if (pathMatchesRule(path, rule)) return rule;
  }
  return undefined;
}

function buildResult(
  allowed: boolean,
  mode: DiffScopeGuardMode,
  changed_paths: RelativePath[],
  allowed_paths: RelativePath[],
  forbidden_paths: RelativePath[],
  violations: DiffScopeViolation[],
  warnings: DiffScopeWarning[],
  matched: DiffScopeMatchedPath[],
): DiffScopeGuardResult {
  return {
    allowed,
    mode,
    changed_paths,
    allowed_paths,
    forbidden_paths,
    violations,
    warnings,
    matched,
    summary: {
      changed_count: changed_paths.length,
      violation_count: violations.length,
      warning_count: warnings.length,
      matched_allowed_count: matched.filter(m => m.allowed_rule).length,
      matched_forbidden_count: matched.filter(m => m.forbidden_rule).length,
    },
  };
}

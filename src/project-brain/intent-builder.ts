/**
 * intent-builder.ts — ProjectBrain v0.1 IntentSpec Builder
 * ==========================================================
 * P1-T2: 纯函数构建器，将任务输入标准化为 IntentSpec。
 *
 * 特性：
 * - 生成稳定 intent id
 * - 自动填充时间戳
 * - 标准化路径（反斜杠转斜杠、trim、去重）
 * - 保守风险推断
 * - 无副作用、不访问文件系统、不调用 MCP
 */
import type {
  EvidenceId,
  DecisionId,
  IntentId,
  IntentRiskSummary,
  IntentScope,
  IntentSpec,
  IsoTimestamp,
  RelativePath,
} from './types';

// ============================================================================
// BuildIntentSpecInput
// ============================================================================

/**
 * buildIntentSpec 的输入参数。
 *
 * 所有可选字段均有合理默认值。
 */
export interface BuildIntentSpecInput {
  /** 意图标题（必填） */
  title: string;
  /** 意图描述（必填） */
  description: string;
  /** 请求人（可选） */
  requested_by?: string;
  /** 允许修改路径（可选） */
  allowed_paths?: string[];
  /** 禁止修改路径（可选） */
  forbidden_paths?: string[];
  /** 预期产出路径（可选） */
  expected_outputs?: string[];
  /** 备注（可选） */
  notes?: string[];
  /** 关联证据 ID（可选） */
  evidence_ids?: EvidenceId[];
  /** 关联决策 ID（可选） */
  decision_ids?: DecisionId[];
  /** 创建时间（可选，用于测试稳定性） */
  now?: IsoTimestamp;
  /** Intent ID（可选，默认自动生成） */
  id?: IntentId;
}

// ============================================================================
// buildIntentSpec
// ============================================================================

/**
 * 构建标准化的 IntentSpec。
 *
 * 输入会被标准化（trim、路径归一化、去重），
 * 风险等级由 {@link inferIntentRisk} 自动推断。
 *
 * @throws {Error} 如果 title 或 description 为空字符串（trim 后）
 */
export function buildIntentSpec(input: BuildIntentSpecInput): IntentSpec {
  const title = trimToEmpty(input.title);
  const description = trimToEmpty(input.description);

  if (!title) {
    throw new Error('Intent title is required');
  }
  if (!description) {
    throw new Error('Intent description is required');
  }

  const requested_by = normalizeOptionalString(input.requested_by);
  const now: IsoTimestamp = input.now || new Date().toISOString();
  const id: IntentId = normalizeOptionalString(input.id) || createIntentId(now);

  const allowed_paths = normalizePathList(input.allowed_paths);
  const forbidden_paths = normalizePathList(input.forbidden_paths);
  const expected_outputs = normalizePathList(input.expected_outputs);
  const notes = normalizeStringList(input.notes);

  const scope: IntentScope = {
    allowed_paths,
    forbidden_paths,
    expected_outputs: expected_outputs.length > 0 ? expected_outputs : undefined,
    notes: notes.length > 0 ? notes : undefined,
  };

  const risk = inferIntentRisk({ allowed_paths, forbidden_paths, expected_outputs });

  const evidence_ids = normalizeStringList(input.evidence_ids) as EvidenceId[];
  const decision_ids = normalizeStringList(input.decision_ids) as DecisionId[];

  return {
    id,
    title,
    description,
    requested_by,
    created_at: now,
    updated_at: now,
    status: 'draft',
    scope,
    risk,
    evidence_ids,
    decision_ids,
  };
}

// ============================================================================
// inferIntentRisk — 风险推断
// ============================================================================

/**
 * 根据允许路径推断意图合约的风险等级。
 *
 * 使用保守策略——如果路径同时匹配多个风险等级，取最高者。
 * 等级优先级：critical > high > medium > low。
 */
export function inferIntentRisk(input: {
  allowed_paths: RelativePath[];
  forbidden_paths: RelativePath[];
  expected_outputs: RelativePath[];
}): IntentRiskSummary {
  const paths = input.allowed_paths;

  // 无 allowed paths → 低风险
  if (paths.length === 0) {
    return makeRisk('low', ['No allowed paths specified; defaulting to low risk draft intent.']);
  }

  let level = 0; // 0=low, 1=medium, 2=high, 3=critical
  const reasons: string[] = [];

  for (const p of paths) {
    const normalized = normalizePath(p);

    // ── CRITICAL (level 3) ──
    if (isCriticalPath(normalized)) {
      level = Math.max(level, 3);
      reasons.push('Allowed scope touches protected runtime or infrastructure path: ' + p);
    }
    // ── HIGH (level 2) ──
    else if (isHighRiskPath(normalized)) {
      level = Math.max(level, 2);
      reasons.push('Allowed scope touches protected core path: ' + p);
    }
    // ── MEDIUM (level 1) ──
    else if (isMediumRiskPath(normalized)) {
      level = Math.max(level, 1);
      reasons.push('Allowed scope touches source/test/report path: ' + p);
    }
    // ── LOW (level 0) ── (default, no reason needed for individual low paths)
  }

  // 如果没有匹配到任何危险路径 → low
  if (level === 0 && reasons.length === 0) {
    return makeRisk('low', ['Allowed paths are all low-risk: ' + paths.join(', ')]);
  }

  // 如果有危险路径但没有匹配到 enough reasons → 仍按 level
  if (reasons.length === 0) {
    reasons.push('No specific risk reasons matched.');
  }

  const riskLevel = levelToRiskLevel(level);
  return makeRisk(riskLevel, reasons);
}

// ============================================================================
// 内部辅助：风险判断
// ============================================================================

function isCriticalPath(normalized: string): boolean {
  // 精确匹配
  if (['ecosystem.config.cjs', 'package.json', 'tsconfig.json'].includes(normalized)) {
    return true;
  }
  // 目录前缀匹配
  if (normalized.startsWith('data/tokens/') || normalized === 'data/tokens') return true;
  if (normalized.startsWith('data/audit/') || normalized === 'data/audit') return true;
  if (normalized.startsWith('data/sentinel/') || normalized === 'data/sentinel') return true;
  return false;
}

function isHighRiskPath(normalized: string): boolean {
  const exacts = [
    'src/FlowEngine.ts',
    'src/StageRunner.ts',
    'src/GateController.ts',
    'src/ComplianceScorer.ts',
    'src/EvolutionEngine.ts',
    'src/main_harness_checker.ts',
    'scripts/harness-gate.cjs',
    'scripts/defense-health-check.cjs',
    'scripts/baseline-report.cjs',
  ];
  if (exacts.includes(normalized)) return true;

  // 目录前缀匹配
  if (normalized.startsWith('mcp/') || normalized === 'mcp') return true;
  if (normalized.startsWith('sentinel/') || normalized === 'sentinel') return true;
  if (normalized.startsWith('hooks/') || normalized === 'hooks') return true;
  if (normalized.startsWith('data/flows/') || normalized === 'data/flows') return true;

  return false;
}

function isMediumRiskPath(normalized: string): boolean {
  if (normalized.startsWith('src/') || normalized === 'src') return true;
  if (normalized.startsWith('tests/') || normalized === 'tests') return true;
  // docs/ 整体为 medium，但 docs/v4/ 专门用于升级文档，属于低风险
  if (normalized.startsWith('docs/') && !normalized.startsWith('docs/v4/')) return true;
  if (normalized === 'docs') return true;
  if (normalized.startsWith('data/reports/') || normalized === 'data/reports') return true;
  return false;
}

function levelToRiskLevel(level: number): 'low' | 'medium' | 'high' | 'critical' {
  switch (level) {
    case 3: return 'critical';
    case 2: return 'high';
    case 1: return 'medium';
    default: return 'low';
  }
}

function makeRisk(level: 'low' | 'medium' | 'high' | 'critical', reasons: string[]): IntentRiskSummary {
  const isHighOrCritical = level === 'high' || level === 'critical';
  return {
    level,
    reasons,
    requires_token: isHighOrCritical,
    requires_architect_review: isHighOrCritical,
  };
}

// ============================================================================
// 内部辅助：标准化
// ============================================================================

/** 标准化单个路径：反斜杠→斜杠、trim */
function normalizePath(p: string): string {
  return trimToEmpty(p).replace(/\\/g, '/');
}

/** trim → 空串返回 '' */
function trimToEmpty(value?: string): string {
  if (value == null) return '';
  return String(value).trim();
}

/** trim + 空串返回 undefined */
function normalizeOptionalString(value?: string): string | undefined {
  const trimmed = trimToEmpty(value);
  return trimmed || undefined;
}

/** 标准化路径列表：归一化、去掉空串、去重、保持顺序 */
function normalizePathList(values?: string[]): string[] {
  return normalizeStringList(values).map(p => normalizePath(p));
}

/** 标准化字符串列表：trim、去掉空串、去重、保持顺序 */
function normalizeStringList(values?: string[]): string[] {
  if (!values || !Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const v of values) {
    const trimmed = trimToEmpty(v);
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

// ============================================================================
// 内部辅助：ID 生成
// ============================================================================

/**
 * 生成 intent id，格式：intent_YYYYMMDD_HHmmss_xxxxxx
 *
 * @param now IsoTimestamp
 */
function createIntentId(now: IsoTimestamp): IntentId {
  // 从 ISO 时间戳提取日期时间部分
  // 格式: 2026-08-02T23:50:00.000Z 或 2026-08-02T23:50:00+08:00
  const datePart = now.substring(0, 10).replace(/-/g, '');   // 20260802
  const timePart = now.substring(11, 19).replace(/:/g, '');  // 235000

  // 简单伪随机后缀（不要求加密安全）
  const suffix = Math.random().toString(36).substring(2, 8);

  return `intent_${datePart}_${timePart}_${suffix}`;
}

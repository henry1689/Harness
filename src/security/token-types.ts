/**
 * token-types.ts — Harness Token v2 类型定义 (P4-AB)
 * =====================================================
 * HMAC 签名令牌的类型系统。与 v1 明文 JSON 令牌的数据模型完全不同。
 *
 * 设计原则:
 *   - signing_payload 不包含可变字段 (consumed, consumed_at, signature)
 *   - 所有令牌均为 strong，统一 15min TTL
 *   - P5-CLEANUP: 移除 weak token（三道防线均拒绝，无合法用例）
 */

// ════════════════════════════════════════════════════════════════════
// 令牌强度
// ════════════════════════════════════════════════════════════════════

export type HarnessTokenStrength = 'strong';

// ════════════════════════════════════════════════════════════════════
// Token v2 完整结构
// ════════════════════════════════════════════════════════════════════

export interface HarnessTokenV2 {
  /** 版本号固定为 2 */
  version: 2;
  /** 唯一令牌 ID (crypto.randomUUID) */
  token_id: string;
  /** 令牌强度 */
  token_strength: HarnessTokenStrength;
  /** 关联的流水线 run_id */
  run_id: string;
  /** 关联的意图合约 ID */
  intent_id: string;
  /** 签发时间 ISO 8601 */
  issued_at: string;
  /** 过期时间 ISO 8601 */
  expires_at: string;
  /** 绑定文件列表 (精确文件路径) */
  files: string[];
  /** 允许的路径范围 */
  allowed_paths: string[];
  /** 禁止的路径范围 */
  forbidden_paths: string[];
  /** 可选：项目根目录 hash */
  project_root_hash?: string;
  /** 可选：diff scope hash */
  diff_scope_hash?: string;
  /** 随机 nonce (防重放) */
  nonce: string;
  /** 是否已消费 */
  consumed: boolean;
  /** 消费时间 ISO 8601 */
  consumed_at?: string;
  /** HMAC-SHA256 签名 (hex) */
  signature: string;
}

// ════════════════════════════════════════════════════════════════════
// 签名负载——不可变字段子集
// ════════════════════════════════════════════════════════════════════

/**
 * 签名负载：只包含不可变字段，不包含 consumed/consumed_at/signature。
 * canonicalization 时需要对此类型的对象做稳定序列化，然后 HMAC 签名。
 */
export interface HarnessTokenSigningPayload {
  version: 2;
  token_id: string;
  token_strength: HarnessTokenStrength;
  run_id: string;
  intent_id: string;
  issued_at: string;
  expires_at: string;
  files: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  project_root_hash?: string;
  diff_scope_hash?: string;
  nonce: string;
}

// ════════════════════════════════════════════════════════════════════
// 签发输入
// ════════════════════════════════════════════════════════════════════

export interface IssueTokenInput {
  token_strength?: HarnessTokenStrength;  // 默认 'strong'（仅此选项）
  run_id: string;
  intent_id: string;
  files: string[];
  allowed_paths?: string[];
  forbidden_paths?: string[];
  project_root_hash?: string;
  diff_scope_hash?: string;
  /** TTL 毫秒，默认 15min */
  ttl_ms?: number;
}

// ════════════════════════════════════════════════════════════════════
// 验证请求/结果
// ════════════════════════════════════════════════════════════════════

export interface VerifyTokenRequest {
  token_id: string;
  target_file?: string;
  require_strength?: HarnessTokenStrength;
}

export interface VerifyTokenResult {
  allowed: boolean;
  reason?: string;
  token?: HarnessTokenV2;
}

// ════════════════════════════════════════════════════════════════════
// 工具函数
// ════════════════════════════════════════════════════════════════════

/**
 * 从完整 token 提取签名负载。
 * 仅复制不可变字段，可变字段 (consumed/consumed_at/signature) 被排除。
 */
export function toSigningPayload(token: HarnessTokenV2): HarnessTokenSigningPayload {
  return {
    version: token.version,
    token_id: token.token_id,
    token_strength: token.token_strength,
    run_id: token.run_id,
    intent_id: token.intent_id,
    issued_at: token.issued_at,
    expires_at: token.expires_at,
    files: [...token.files],
    allowed_paths: [...token.allowed_paths],
    forbidden_paths: [...token.forbidden_paths],
    project_root_hash: token.project_root_hash,
    diff_scope_hash: token.diff_scope_hash,
    nonce: token.nonce,
  };
}

/** 默认 TTL（统一 15 分钟） */
export const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;

/** 高风险路径前缀 — weak token 禁止覆盖 */
export const HIGH_RISK_PATH_PREFIXES = [
  'src/',
  'mcp/',
  'sentinel/',
  'hooks/',
  'scripts/security/',
  'scripts/harness-gate.cjs',
  'scripts/defense-health-check.cjs',
  'data/tokens/',
  'data/audit/',
  '.claude/settings.json',
  'package-lock.json',
];

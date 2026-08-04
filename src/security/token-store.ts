/**
 * token-store.ts — Token v2 原子存储与验证 (P4-AB)
 * ===================================================
 * 提供 Token 的签发、读取、验证、消费全生命周期管理。
 *
 * 安全要求:
 *   - 写入使用 temp file + rename（原子写）
 *   - token_id 使用 crypto.randomUUID（不可预测）
 *   - 消费状态使用原子更新
 *   - 过期/已消费/scope 不匹配一律拒绝
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  HarnessTokenV2,
  IssueTokenInput,
  VerifyTokenRequest,
  VerifyTokenResult,
} from './token-types.js';
import {
  toSigningPayload,
  DEFAULT_TOKEN_TTL_MS,
  HIGH_RISK_PATH_PREFIXES,
} from './token-types.js';
import { signTokenPayload, verifyTokenSignature, getTokenSecret } from './hmac-token.js';

// ════════════════════════════════════════════════════════════════════
// 配置
// ════════════════════════════════════════════════════════════════════

export interface TokenStoreOptions {
  /** 令牌存储目录 */
  tokenDir: string;
  /** HMAC 密钥 (通常来自 HARNESS_TOKEN_SECRET) */
  secret?: string;
  /** 时间注入 (测试用) */
  now?: () => Date;
}

// ════════════════════════════════════════════════════════════════════
// TokenStore
// ════════════════════════════════════════════════════════════════════

export class TokenStore {
  private readonly tokenDir: string;
  private readonly _now: () => Date;

  constructor(private readonly options: TokenStoreOptions) {
    this.tokenDir = resolve(options.tokenDir);
    this._now = options.now ?? (() => new Date());
  }

  /** 获取用于签名的 secret */
  private get secret(): string {
    return this.options.secret ?? getTokenSecret();
  }

  // ── 签发 ──

  /**
   * 签发一个新的 Token v2。
   * 自动计算 expires_at、nonce、signature。
   * 原子写入到 tokenDir。
   */
  issueToken(input: IssueTokenInput): HarnessTokenV2 {
    const now = this._now();
    const ttl = input.ttl_ms ?? DEFAULT_TOKEN_TTL_MS;

    const token_id = randomUUID();
    const nonce = randomUUID().replace(/-/g, '');

    const token: Omit<HarnessTokenV2, 'signature'> = {
      version: 2,
      token_id,
      token_strength: input.token_strength ?? 'strong',
      run_id: input.run_id,
      intent_id: input.intent_id,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttl).toISOString(),
      files: [...input.files],
      allowed_paths: [...(input.allowed_paths ?? input.files)],
      forbidden_paths: [...(input.forbidden_paths ?? [])],
      project_root_hash: input.project_root_hash,
      diff_scope_hash: input.diff_scope_hash,
      nonce,
      consumed: false,
    };

    const signature = signTokenPayload(toSigningPayload(token as HarnessTokenV2), this.secret);

    const fullToken: HarnessTokenV2 = { ...token, signature };

    // 原子写入
    this.atomicWrite(token_id, fullToken);

    return fullToken;
  }

  // ── 读取 ──

  /** 读取指定 token_id 的令牌，不存在时返回 null */
  readToken(tokenId: string): HarnessTokenV2 | null {
    const filePath = this.tokenPath(tokenId);
    if (!existsSync(filePath)) return null;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as HarnessTokenV2;
    } catch {
      return null;
    }
  }

  // ── 验证 ──

  /**
   * 验证一个令牌是否有效。
   * 检查顺序: 存在→版本→签名→过期→已消费→scope→强度
   */
  verifyToken(request: VerifyTokenRequest): VerifyTokenResult {
    const token = this.readToken(request.token_id);
    if (!token) {
      return { allowed: false, reason: 'token_missing' };
    }

    // 版本检查
    if (token.version !== 2) {
      return { allowed: false, reason: 'token_invalid_version' };
    }

    // HMAC 签名
    if (!verifyTokenSignature(token, this.secret)) {
      return { allowed: false, reason: 'token_invalid_signature' };
    }

    // 过期
    const now = this._now();
    if (now.getTime() > new Date(token.expires_at).getTime()) {
      this.deleteToken(token.token_id);  // 清理过期令牌
      return { allowed: false, reason: 'token_expired' };
    }

    // 已消费
    if (token.consumed) {
      return { allowed: false, reason: 'token_consumed' };
    }

    // Scope 检查
    if (request.target_file) {
      const normalized = this.normalizePath(request.target_file);

      // forbidden 优先
      if (this.pathMatchesAny(normalized, token.forbidden_paths)) {
        return { allowed: false, reason: 'token_forbidden_path', token };
      }

      // 检查是否在 files 或 allowed_paths 中
      const inFiles = this.pathMatchesAny(normalized, token.files);
      const inAllowed = this.pathMatchesAny(normalized, token.allowed_paths);

      if (!inFiles && !inAllowed) {
        return { allowed: false, reason: 'token_scope_mismatch', token };
      }
    }

    // 强度检查 — 所有令牌均为 'strong'（P5-CLEANUP: weak token 已移除）
    if (request.require_strength === 'strong' && token.token_strength !== 'strong') {
      return { allowed: false, reason: 'token_strength_insufficient', token };
    }

    return { allowed: true, reason: 'token_valid', token };
  }

  // ── 消费 ──

  /**
   * 消费令牌（一次性使用）。
   * 写入 consumed=true + consumed_at，使用原子更新。
   */
  consumeToken(tokenId: string): VerifyTokenResult {
    const result = this.verifyToken({ token_id: tokenId });
    if (!result.allowed || !result.token) return result;

    const token = result.token;
    token.consumed = true;
    token.consumed_at = this._now().toISOString();

    // 原子更新：写 temp → rename
    this.atomicWrite(tokenId, token);

    return { allowed: true, reason: 'token_consumed', token };
  }

  // ── 删除 ──

  /** 删除过期或无效的令牌文件 */
  private deleteToken(tokenId: string): void {
    const fp = this.tokenPath(tokenId);
    try { if (existsSync(fp)) unlinkSync(fp); } catch { /* ignore */ }
  }

  // ════════════════════════════════════════════════════════════════
  // 内部工具
  // ════════════════════════════════════════════════════════════════

  private tokenPath(tokenId: string): string {
    // 防止路径遍历
    const safe = tokenId.replace(/[<>:"/\\|?*]/g, '_');
    return join(this.tokenDir, safe + '.json');
  }

  /** 原子写入：temp file → rename */
  private atomicWrite(tokenId: string, token: HarnessTokenV2): void {
    if (!existsSync(this.tokenDir)) {
      mkdirSync(this.tokenDir, { recursive: true });
    }

    const finalPath = this.tokenPath(tokenId);
    const tempPath = finalPath + '.' + Date.now().toString(36) + '.tmp';

    writeFileSync(tempPath, JSON.stringify(token, null, 2), {
      encoding: 'utf-8',
      flag: 'wx',  // 排他创建，防止并发覆盖
    });

    renameSync(tempPath, finalPath);
  }

  /** 标准化路径 */
  private normalizePath(fp: string): string {
    return fp
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/\.\//, '/');
  }

  /** 检查路径是否匹配规则列表中的任意一条 */
  private pathMatchesAny(target: string, rules: string[]): boolean {
    for (const rule of rules) {
      if (this.pathMatches(target, this.normalizePath(rule))) return true;
    }
    return false;
  }

  /** 简单路径匹配：精确匹配 + 目录前缀匹配 + 递归通配 */
  private pathMatches(path: string, rule: string): boolean {
    if (path === rule) return true;
    if (rule.endsWith('/**')) {
      const prefix = rule.slice(0, -3);
      return path === prefix || path.startsWith(prefix + '/');
    }
    if (rule.endsWith('/')) return path.startsWith(rule);
    if (path.startsWith(rule + '/')) return true;
    return false;
  }

  /** 高风险路径判定 */
  private isHighRiskPath(fp: string): boolean {
    const n = this.normalizePath(fp);
    for (const prefix of HIGH_RISK_PATH_PREFIXES) {
      if (n.startsWith(prefix) || n === prefix) return true;
    }
    return false;
  }
}

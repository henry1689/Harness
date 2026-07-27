/**
 * CheckCache — 本地校验结果缓存层
 * ======================================
 * 对 FG 校验、会晤点位检查、补丁扫描结果提供 10 分钟 TTL 文件级缓存。
 *
 * 核心设计：
 *   - 缓存键 = sha256(file_path + file_mtime) —— 文件未变则缓存命中
 *   - TTL 10 分钟（600,000ms），过期自动失效
 *   - 内存 LRU 最大 200 条，超出淘汰最旧条目
 *   - 仅缓存可缓存项（check.cacheable === true 的结果）
 *
 * 使用方式：
 *   import { CheckCache } from './CheckCache.js';
 *   const cache = CheckCache.getInstance();
 *   const cached = cache.get('CK-05', 'src/webui/chat.ts');
 *   if (!cached) { ... 执行检查 ... cache.set('CK-05', 'src/webui/chat.ts', result); }
 */

import { createHash } from 'node:crypto';
import type { CacheableData } from './main_harness_checker.js';

// ════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════

/** 缓存条目 */
interface CacheEntry {
  /** 检查 ID */
  checkId: string;
  /** 文件路径 */
  filePath: string;
  /** 文件内容哈希 */
  fileHash: string;
  /** 缓存数据 */
  data: unknown;
  /** 创建时间戳 */
  createdAt: number;
  /** 过期时间戳 */
  expiresAt: number;
}

// ════════════════════════════════════════════════════════════════════
// 实现
// ════════════════════════════════════════════════════════════════════

export class CheckCache {
  private static instance: CheckCache | null = null;

  /** 缓存存储 */
  private readonly store = new Map<string, CacheEntry>();

  /** 默认 TTL (ms) — 10 分钟 */
  private readonly ttl: number;

  /** 最大缓存条目数 */
  private readonly maxSize: number;

  /** 统计 */
  private hits = 0;
  private misses = 0;

  private constructor(ttl = 600_000, maxSize = 200) {
    this.ttl = ttl;
    this.maxSize = maxSize;
  }

  /** 获取单例 */
  static getInstance(ttl?: number, maxSize?: number): CheckCache {
    if (!CheckCache.instance) {
      CheckCache.instance = new CheckCache(ttl, maxSize);
    }
    return CheckCache.instance;
  }

  /** 重置单例（测试用） */
  static reset(): void {
    CheckCache.instance = null;
  }

  // ════════════════════════════════════════════════════════════════
  // 公开 API
  // ════════════════════════════════════════════════════════════════

  /**
   * 获取缓存结果。
   *
   * @param checkId — 检查 ID（如 CK-03 / CK-05 / CK-08）
   * @param filePath — 文件绝对路径
   * @param currentFileHash — 当前文件的 sha256（用于检测文件是否变化）
   * @returns 缓存数据，或 null（未命中/已过期/文件已变）
   */
  get(checkId: string, filePath: string, currentFileHash: string): unknown | null {
    const key = this.makeKey(checkId, filePath);
    const entry = this.store.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // TTL 过期
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return null;
    }

    // 文件内容已变更
    if (entry.fileHash !== currentFileHash) {
      this.store.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    console.log(`[CheckCache] ✅ 缓存命中: ${checkId} → ${filePath}`);
    return entry.data;
  }

  /**
   * 批量获取缓存结果。
   * 返回命中部分 + 未命中的 checkId/filePath 列表。
   */
  batchGet(entries: Array<{ checkId: string; filePath: string; fileHash: string }>): {
    hits: Map<string, unknown>;
    misses: Array<{ checkId: string; filePath: string }>;
  } {
    const hits = new Map<string, unknown>();
    const misses: Array<{ checkId: string; filePath: string }> = [];

    for (const { checkId, filePath, fileHash } of entries) {
      const key = this.makeKey(checkId, filePath);
      const cached = this.get(checkId, filePath, fileHash);
      if (cached !== null) {
        hits.set(key, cached);
      } else {
        misses.push({ checkId, filePath });
      }
    }

    return { hits, misses };
  }

  /**
   * 存入缓存。
   *
   * @param checkId — 检查 ID
   * @param filePath — 文件绝对路径
   * @param fileHash — 文件内容哈希
   * @param data — 可缓存数据
   */
  set(checkId: string, filePath: string, fileHash: string, data: unknown): void {
    // LRU 淘汰：超出容量时删除最旧条目
    if (this.store.size >= this.maxSize) {
      const oldest = this.findOldest();
      if (oldest) {
        this.store.delete(oldest);
        console.log(`[CheckCache] 🗑 淘汰最旧条目: ${oldest}`);
      }
    }

    const key = this.makeKey(checkId, filePath);
    const entry: CacheEntry = {
      checkId,
      filePath,
      fileHash,
      data,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttl,
    };

    this.store.set(key, entry);
    console.log(`[CheckCache] 💾 缓存写入: ${checkId} → ${filePath} (TTL: ${this.ttl / 1000}s)`);
  }

  /**
   * 存入 CacheableData（S4 全部可缓存输出）。
   */
  setCacheable(filePath: string, fileHash: string, cacheable: CacheableData): void {
    if (cacheable.fg_redlines_check !== undefined) {
      this.set('CK-03', filePath, fileHash, cacheable.fg_redlines_check);
    }
    if (cacheable.meeting_points_check !== undefined) {
      this.set('CK-05', filePath, fileHash, cacheable.meeting_points_check);
    }
    if (cacheable.patch_scan !== undefined) {
      this.set('CK-08', filePath, fileHash, cacheable.patch_scan);
    }
  }

  /**
   * 尝试从缓存获取 S4 可缓存结果。
   */
  getCacheable(checkId: string, filePath: string, fileHash: string): unknown | null {
    return this.get(checkId, filePath, fileHash);
  }

  /** 清除指定检查的所有缓存 */
  clearByCheckId(checkId: string): void {
    for (const [key, entry] of this.store.entries()) {
      if (entry.checkId === checkId) {
        this.store.delete(key);
      }
    }
  }

  /** 清除指定文件的所有缓存 */
  clearByFilePath(filePath: string): void {
    for (const [key, entry] of this.store.entries()) {
      if (entry.filePath === filePath) {
        this.store.delete(key);
      }
    }
  }

  /** 清除所有过期条目 */
  evictExpired(): number {
    let count = 0;
    for (const [key, entry] of this.store.entries()) {
      if (Date.now() > entry.expiresAt) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /** 清空所有缓存 */
  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** 获取统计信息 */
  getStats(): { size: number; maxSize: number; hits: number; misses: number; hitRate: string; ttlMs: number } {
    return {
      size: this.store.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0
        ? `${((this.hits / (this.hits + this.misses)) * 100).toFixed(1)}%`
        : 'N/A',
      ttlMs: this.ttl,
    };
  }

  // ════════════════════════════════════════════════════════════════
  // 内部方法
  // ════════════════════════════════════════════════════════════════

  private makeKey(checkId: string, filePath: string): string {
    return `${checkId}::${filePath}`;
  }

  private findOldest(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.store.entries()) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }

  /** 计算文件的 sha256 哈希 */
  static hashFile(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16);
  }
}

/**
 * SelfGuardAuditLogger — 独立卷宗分区
 * ========================================
 * SelfGuard 体系专用审计日志，数据与主业务审计日志完全分区隔离。
 *
 * 核心特性：
 *   1. 数据目录：data/harness/self_guard/audit/（独立于主业务 audit 目录）
 *   2. 所有记录自动标记【基础设施变更】专属标签
 *   3. 版本链维护——支持一键回退至上一稳定版本
 *   4. 历史只增不删原则
 *   5. 双轨卷宗：基础设施卷宗 vs 业务卷宗完全分区
 *
 * 🔴 与主 AuditLogger 的隔离：
 *   - SelfGuard 卷宗写入 data/harness/self_guard/audit/
 *   - 主业务卷宗写入 data/harness/audit/
 *   - 两套卷宗物理隔离，互不查询、互不混合
 */

import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import type { AuditEntry, AuditEventType, MachineSignal } from '../src/types.js';

/** SelfGuard 独立审计日志根目录 */
const SELF_GUARD_AUDIT_DIR = (() => {
  const base = typeof import.meta !== 'undefined' && (import.meta as unknown as Record<string, unknown>).dirname
    ? (import.meta as unknown as Record<string, unknown>).dirname as string
    : __dirname;
  return resolve(base, '..', '..', 'data', 'harness', 'self_guard', 'audit');
})();

/** SelfGuard 版本链文件路径 */
const VERSION_CHAIN_PATH = join(SELF_GUARD_AUDIT_DIR, '..', 'version_chain.json');

/** 基础设施变更标签 */
const INFRA_TAG = '【基础设施变更】';

/** 容量管控常量 */
const CAPACITY = {
  MAX_FILE_BYTES: 5 * 1024 * 1024,    // 单文件告警阈值 (5MB)
  MAX_RETENTION_DAYS: 90,               // SelfGuard 日志保留更长（90天 vs 主审计30天）
  MAX_ENTRIES_IN_MEMORY: 10000,
} as const;

// ════════════════════════════════════════════════════════════════════
// 版本链类型
// ════════════════════════════════════════════════════════════════════

/** 单条版本链记录 */
export interface VersionChainEntry {
  /** 版本序号 */
  index: number;
  /** 版本标签 */
  version: string;
  /** 变更时间 */
  timestamp: string;
  /** 运行 ID */
  run_id: string;
  /** Git commit hash（快照引用） */
  commit_hash?: string;
  /** 变更摘要 */
  summary: string;
  /** 上一稳定版本索引 */
  previous_stable_index: number | null;
  /** 是否为稳定版本 */
  is_stable: boolean;
}

/** 版本链完整结构 */
export interface VersionChain {
  /** 当前最新版本索引 */
  head_index: number;
  /** 当前稳定版本索引 */
  stable_index: number;
  /** 版本链条目列表（按时间排序，只增不删） */
  entries: VersionChainEntry[];
  /** 最后更新时间 */
  updated_at: string;
}

// ════════════════════════════════════════════════════════════════════
// SelfGuardAuditLogger
// ════════════════════════════════════════════════════════════════════

export class SelfGuardAuditLogger {
  private readonly runId: string;
  private readonly flowId: string;
  private readonly entries: AuditEntry[];
  private readonly startedAt: string;
  private _entryCountExceeded = false;

  constructor(runId: string, flowId: string) {
    this.runId = runId;
    this.flowId = flowId;
    this.entries = [];
    this.startedAt = new Date().toISOString();

    // 构造时执行过期日志清理
    SelfGuardAuditLogger.cleanupExpired();
  }

  // ════════════════════════════════════════════════════════════════
  // 容量管控静态方法
  // ════════════════════════════════════════════════════════════════

  static getDiskUsage(): { totalFiles: number; totalBytes: number; warning: boolean } {
    try {
      if (!existsSync(SELF_GUARD_AUDIT_DIR)) {
        return { totalFiles: 0, totalBytes: 0, warning: false };
      }

      let totalBytes = 0;
      let totalFiles = 0;

      const dateDirs = readdirSync(SELF_GUARD_AUDIT_DIR);
      for (const dateDir of dateDirs) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue;
        const dirPath = join(SELF_GUARD_AUDIT_DIR, dateDir);
        try {
          const files = readdirSync(dirPath);
          for (const file of files) {
            try {
              const stat = statSync(join(dirPath, file));
              totalBytes += stat.size;
              totalFiles++;
            } catch { /* 文件可能已被删除 */ }
          }
        } catch { /* 目录不可读 */ }
      }

      const warning = totalBytes > 50 * 1024 * 1024;
      return { totalFiles, totalBytes, warning };
    } catch {
      return { totalFiles: 0, totalBytes: 0, warning: false };
    }
  }

  static cleanupExpired(): number {
    try {
      if (!existsSync(SELF_GUARD_AUDIT_DIR)) return 0;

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - CAPACITY.MAX_RETENTION_DAYS);
      const cutoffStr = cutoffDate.toISOString().slice(0, 10);

      const dateDirs = readdirSync(SELF_GUARD_AUDIT_DIR);
      let cleaned = 0;

      for (const dateDir of dateDirs) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue;
        if (dateDir < cutoffStr) {
          const dirPath = join(SELF_GUARD_AUDIT_DIR, dateDir);
          try {
            const files = readdirSync(dirPath);
            for (const file of files) {
              unlinkSync(join(dirPath, file));
              cleaned++;
            }
            try { rmdirSync(dirPath); } catch { /* 忽略非空目录 */ }
          } catch (err) {
            console.warn(`[SelfGuardAuditLogger] 清理旧日志失败 (${dateDir}):`, (err as Error).message);
          }
        }
      }

      if (cleaned > 0) {
        console.log(`[SelfGuardAuditLogger] 🧹 已清理 ${cleaned} 条过期日志（>${CAPACITY.MAX_RETENTION_DAYS}天）`);
      }
      return cleaned;
    } catch (err) {
      console.warn('[SelfGuardAuditLogger] 清理过期日志异常:', (err as Error).message);
      return 0;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 公开 API
  // ════════════════════════════════════════════════════════════════

  logFlowStart(detail: Record<string, unknown> = {}): void {
    this.append('flow_start', undefined, {
      flow_id: this.flowId,
      tag: INFRA_TAG,
      ...detail,
    });
  }

  logFlowComplete(detail: Record<string, unknown> = {}): void {
    this.append('flow_complete', undefined, {
      tag: INFRA_TAG,
      ...detail,
    });
    this.persist();
  }

  logFlowAbort(reason: string): void {
    this.append('flow_abort', undefined, {
      tag: INFRA_TAG,
      reason,
    });
    this.persist();
  }

  logStageEntry(stageId: string, detail: Record<string, unknown> = {}): void {
    this.append('stage_enter', stageId, {
      tag: INFRA_TAG,
      ...detail,
    });
  }

  logStageExit(stageId: string, detail: Record<string, unknown> = {}): void {
    this.append('stage_exit', stageId, {
      tag: INFRA_TAG,
      ...detail,
    });
  }

  logGateResolve(stageId: string, gateType: string, resolution: string, detail: Record<string, unknown> = {}): void {
    this.append('gate_resolve', stageId, {
      tag: INFRA_TAG,
      gate_type: gateType,
      resolution,
      ...detail,
    });
  }

  logToolCall(stageId: string, tool: string, path?: string, detail: Record<string, unknown> = {}): void {
    this.append('tool_call', stageId, {
      tag: INFRA_TAG,
      tool,
      path: path || '',
      whitelist_check: 'passed',
      ...detail,
    });
  }

  logToolBlocked(stageId: string, tool: string, reason: string): void {
    this.append('tool_blocked', stageId, {
      tag: INFRA_TAG,
      tool,
      whitelist_check: 'blocked',
      reason,
    });
  }

  logMachineSignal(stageId: string, signal: MachineSignal): void {
    this.append('machine_signal', stageId, {
      tag: INFRA_TAG,
      passed: signal.passed,
      risk_level: signal.risk_level,
      reject_count: signal.reject_reason.length,
      top_reasons: signal.reject_reason.slice(0, 5),
      metrics_summary: signal.metrics ? Object.keys(signal.metrics).join(',') : 'none',
    });
  }

  logMemoInjected(stageId: string, memoLength: number): void {
    this.append('memo_injected', stageId, {
      tag: INFRA_TAG,
      memo_size_bytes: memoLength,
    });
  }

  logCircuitBreaker(jumpCount: number, maxLimit: number): void {
    this.append('circuit_breaker', undefined, {
      tag: INFRA_TAG,
      jump_count: jumpCount,
      max_limit: maxLimit,
    });
  }

  /**
   * 🔴 SG-R8 强化归档：记录版本链快照。
   * 每次 SelfGuard 流水线完成时调用，追加版本链条目。
   */
  logVersionSnapshot(summary: string, commitHash?: string): void {
    try {
      const chain = SelfGuardAuditLogger.loadVersionChain();
      const newEntry: VersionChainEntry = {
        index: chain.head_index + 1,
        version: `v${chain.head_index + 1}.0.0`,
        timestamp: new Date().toISOString(),
        run_id: this.runId,
        commit_hash: commitHash,
        summary,
        previous_stable_index: chain.stable_index,
        is_stable: true,
      };

      chain.entries.push(newEntry);
      chain.head_index = newEntry.index;
      chain.stable_index = newEntry.index;
      chain.updated_at = new Date().toISOString();

      SelfGuardAuditLogger.saveVersionChain(chain);
      console.log(`[SelfGuardAuditLogger] 🔗 版本链已更新: ${newEntry.version} (run: ${this.runId})`);
    } catch (err) {
      console.error('[SelfGuardAuditLogger] 版本快照记录失败:', (err as Error).message);
    }
  }

  /**
   * 🔴 SG-R8 一键回退：获取上一稳定版本的快照信息。
   * @returns 上一稳定版本的 VersionChainEntry，或 null（如无历史版本）
   */
  static getRollbackTarget(): VersionChainEntry | null {
    try {
      const chain = SelfGuardAuditLogger.loadVersionChain();
      if (chain.stable_index <= 1) return null;

      // 回退到上一稳定版本（当前稳定版本的前一个稳定版本）
      const stableEntries = chain.entries.filter(e => e.is_stable);
      if (stableEntries.length < 2) return null;

      return stableEntries[stableEntries.length - 2]; // 倒数第二个稳定版本
    } catch (err) {
      console.error('[SelfGuardAuditLogger] 获取回退目标失败:', (err as Error).message);
      return null;
    }
  }

  /** 获取完整的审计报告 */
  getReport(): string {
    return JSON.stringify({
      run_id: this.runId,
      flow_id: this.flowId,
      tag: INFRA_TAG,
      started_at: this.startedAt,
      completed_at: new Date().toISOString(),
      total_events: this.entries.length,
      is_infrastructure_change: true,
      capacity: {
        memory_entries: this.entries.length,
        max_entries: CAPACITY.MAX_ENTRIES_IN_MEMORY,
        exceeded: this._entryCountExceeded,
        disk_usage: SelfGuardAuditLogger.getDiskUsage(),
      },
      entries: this.entries,
    }, null, 2);
  }

  getEntries(): readonly AuditEntry[] {
    return this.entries;
  }

  // ════════════════════════════════════════════════════════════════
  // 持久化（写入独立分区）
  // ════════════════════════════════════════════════════════════════

  persist(): void {
    try {
      const dateDir = new Date().toISOString().slice(0, 10);
      const dir = join(SELF_GUARD_AUDIT_DIR, dateDir);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const filePath = join(dir, `${this.runId}.json`);
      const report = this.getReport();

      const reportBytes = Buffer.byteLength(report, 'utf-8');
      if (reportBytes > CAPACITY.MAX_FILE_BYTES) {
        console.warn(
          `[SelfGuardAuditLogger] ⚠️ 日志文件过大: ${(reportBytes / 1024 / 1024).toFixed(1)}MB ` +
          `(阈值: ${CAPACITY.MAX_FILE_BYTES / 1024 / 1024}MB) — ${this.entries.length} 条记录`,
        );
      }

      writeFileSync(filePath, report, 'utf-8');
      console.log(
        `[SelfGuardAuditLogger] 📝 ${INFRA_TAG}审计日志已持久化: ${filePath} ` +
        `(${this.entries.length} 条记录, ${(reportBytes / 1024).toFixed(1)}KB)`,
      );
    } catch (err) {
      console.error(`[SelfGuardAuditLogger] 持久化失败:`, (err as Error).message);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 版本链读写
  // ════════════════════════════════════════════════════════════════

  /** 加载版本链（不存在则返回空链） */
  static loadVersionChain(): VersionChain {
    try {
      if (!existsSync(VERSION_CHAIN_PATH)) {
        return {
          head_index: 0,
          stable_index: 0,
          entries: [],
          updated_at: new Date().toISOString(),
        };
      }

      const raw = readFileSync(VERSION_CHAIN_PATH, 'utf-8');
      return JSON.parse(raw) as VersionChain;
    } catch (err) {
      console.warn('[SelfGuardAuditLogger] 加载版本链失败，使用空链:', (err as Error).message);
      return {
        head_index: 0,
        stable_index: 0,
        entries: [],
        updated_at: new Date().toISOString(),
      };
    }
  }

  /** 保存版本链 */
  static saveVersionChain(chain: VersionChain): void {
    try {
      const dir = join(SELF_GUARD_AUDIT_DIR, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(VERSION_CHAIN_PATH, JSON.stringify(chain, null, 2), 'utf-8');
    } catch (err) {
      console.error('[SelfGuardAuditLogger] 保存版本链失败:', (err as Error).message);
    }
  }

  /** 从磁盘加载审计日志（复盘用） */
  static load(runId: string): AuditEntry[] | null {
    try {
      if (!existsSync(SELF_GUARD_AUDIT_DIR)) return null;

      const dateDirs = readdirSync(SELF_GUARD_AUDIT_DIR)
        .filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d));

      for (const dateDir of dateDirs.reverse()) {
        const filePath = join(SELF_GUARD_AUDIT_DIR, dateDir, `${runId}.json`);
        if (existsSync(filePath)) {
          const raw = readFileSync(filePath, 'utf-8');
          const report = JSON.parse(raw);
          return report.entries || [];
        }
      }

      return null;
    } catch (err) {
      console.error(`[SelfGuardAuditLogger] 加载失败:`, (err as Error).message);
      return null;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 内部
  // ════════════════════════════════════════════════════════════════

  private append(event: AuditEventType, stageId: string | undefined, detail: Record<string, unknown>): void {
    // 确保所有记录自动带上基础设施标签
    const taggedDetail = { tag: INFRA_TAG, ...detail };

    if (this.entries.length >= CAPACITY.MAX_ENTRIES_IN_MEMORY) {
      if (!this._entryCountExceeded) {
        console.warn(
          `[SelfGuardAuditLogger] ⚠️ 内存中审计条目超限 (${this.entries.length} >= ${CAPACITY.MAX_ENTRIES_IN_MEMORY})，` +
          '后续条目将跳过。',
        );
        this._entryCountExceeded = true;
      }
      return;
    }

    this.entries.push({
      event,
      timestamp: new Date().toISOString(),
      stage_id: stageId,
      detail: taggedDetail,
    });
  }
}

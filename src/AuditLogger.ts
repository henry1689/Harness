/**
 * AuditLogger — 全流程审计日志（含容量管控）
 * ==============================================
 * 完整记录每阶段进入、放行方式、工具调用、子Agent信号。
 * 日志持久化到磁盘 JSON 文件，支持任务回放复盘。
 *
 * 记录维度：
 *   - flow_start / flow_complete / flow_abort
 *   - stage_enter / stage_exit
 *   - gate_resolve — 门控决议
 *   - tool_call — 工具调用（含白名单检查结果）
 *   - tool_blocked — 工具被拦截
 *   - machine_signal — 子Agent结构化信号（摘要）
 *   - memo_injected — 备忘录注入
 *   - circuit_breaker — 熔断触发
 *
 * 🔧 容量管控（开发落地规则5）：
 *   - 按日期自动分片存储
 *   - 单文件超 5MB 告警
 *   - 自动清理超过 30 天的旧日志
 *   - 磁盘空间水位监控
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { AuditEntry, AuditEventType, MachineSignal } from './types.js';

/** 审计日志根目录 */
const AUDIT_DIR = (() => {
  const base = typeof import.meta !== 'undefined' && (import.meta as any).dirname
    ? (import.meta as any).dirname
    : __dirname;
  return resolve(base, '..', 'data', 'audit');
})();

/** 容量管控常量 */
const CAPACITY = {
  /** 单文件告警阈值 (5MB) */
  MAX_FILE_BYTES: 5 * 1024 * 1024,
  /** 日志保留天数 */
  MAX_RETENTION_DAYS: 30,
  /** 内存中最大条目数（防止 OOM） */
  MAX_ENTRIES_IN_MEMORY: 10000,
} as const;

export class AuditLogger {
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

    // 构造时执行一次过期日志清理
    AuditLogger.cleanupExpired();
  }

  // ════════════════════════════════════════════════════════════════
  // 容量管控静态方法（开发落地规则5）
  // ════════════════════════════════════════════════════════════════

  /** 获取审计日志磁盘使用量（估算） */
  static getDiskUsage(): { totalFiles: number; totalBytes: number; warning: boolean } {
    try {
      if (!existsSync(AUDIT_DIR)) return { totalFiles: 0, totalBytes: 0, warning: false };

      let totalBytes = 0;
      let totalFiles = 0;

      const dateDirs = readdirSync(AUDIT_DIR);
      for (const dateDir of dateDirs) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue;
        const dirPath = join(AUDIT_DIR, dateDir);
        const files = readdirSync(dirPath);
        for (const file of files) {
          try {
            const stat = statSync(join(dirPath, file));
            totalBytes += stat.size;
            totalFiles++;
          } catch { /* 文件可能已被删除 */ }
        }
      }

      // 总容量超过 50MB 告警
      const warning = totalBytes > 50 * 1024 * 1024;
      return { totalFiles, totalBytes, warning };
    } catch {
      return { totalFiles: 0, totalBytes: 0, warning: false };
    }
  }

  /** 清理超过保留天数的旧日志 */
  static cleanupExpired(): number {
    try {
      if (!existsSync(AUDIT_DIR)) return 0;

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - CAPACITY.MAX_RETENTION_DAYS);
      const cutoffStr = cutoffDate.toISOString().slice(0, 10);

      const dateDirs = readdirSync(AUDIT_DIR);
      let cleaned = 0;

      for (const dateDir of dateDirs) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue;
        if (dateDir < cutoffStr) {
          const dirPath = join(AUDIT_DIR, dateDir);
          try {
            const files = readdirSync(dirPath);
            for (const file of files) {
              unlinkSync(join(dirPath, file));
              cleaned++;
            }
            // rmdir 如果为空会自动失败，忽略即可
            try { rmdirSync(dirPath); } catch {}
          } catch (err) {
            console.warn(`[AuditLogger] 清理旧日志失败 (${dateDir}):`, (err as Error).message);
          }
        }
      }

      if (cleaned > 0) {
        console.log(`[AuditLogger] 🧹 已清理 ${cleaned} 条过期日志（>${CAPACITY.MAX_RETENTION_DAYS}天）`);
      }
      return cleaned;
    } catch (err) {
      console.warn('[AuditLogger] 清理过期日志异常:', (err as Error).message);
      return 0;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 公开 API
  // ════════════════════════════════════════════════════════════════

  /** 流程开始 */
  logFlowStart(detail: Record<string, unknown> = {}): void {
    this.append('flow_start', undefined, {
      flow_id: this.flowId,
      ...detail,
    });
  }

  /** 流程完成 */
  logFlowComplete(detail: Record<string, unknown> = {}): void {
    this.append('flow_complete', undefined, detail);
    this.persist();
  }

  /** 流程异常中止 */
  logFlowAbort(reason: string): void {
    this.append('flow_abort', undefined, { reason });
    this.persist();
  }

  /** Stage 进入 */
  logStageEntry(stageId: string, detail: Record<string, unknown> = {}): void {
    this.append('stage_enter', stageId, detail);
  }

  /** Stage 退出 */
  logStageExit(stageId: string, detail: Record<string, unknown> = {}): void {
    this.append('stage_exit', stageId, detail);
  }

  /** 门控决议 */
  logGateResolve(stageId: string, gateType: string, resolution: string, detail: Record<string, unknown> = {}): void {
    this.append('gate_resolve', stageId, {
      gate_type: gateType,
      resolution,
      ...detail,
    });
  }

  /** 工具调用（放行） */
  logToolCall(stageId: string, tool: string, path?: string, detail: Record<string, unknown> = {}): void {
    this.append('tool_call', stageId, {
      tool,
      path: path || '',
      whitelist_check: 'passed',
      ...detail,
    });
  }

  /** 工具调用被白名单拦截 */
  logToolBlocked(stageId: string, tool: string, reason: string): void {
    this.append('tool_blocked', stageId, {
      tool,
      whitelist_check: 'blocked',
      reason,
    });
  }

  /** 记录 machine_signal 摘要（完整 signal 不写入日志避免冗余） */
  logMachineSignal(stageId: string, signal: MachineSignal): void {
    this.append('machine_signal', stageId, {
      passed: signal.passed,
      risk_level: signal.risk_level,
      reject_count: signal.reject_reason.length,
      top_reasons: signal.reject_reason.slice(0, 5),
      metrics_summary: signal.metrics ? Object.keys(signal.metrics).join(',') : 'none',
    });
  }

  /** 备忘录注入 */
  logMemoInjected(stageId: string, memoLength: number): void {
    this.append('memo_injected', stageId, {
      memo_size_bytes: memoLength,
    });
  }

  /** 熔断触发 */
  logCircuitBreaker(jumpCount: number, maxLimit: number): void {
    this.append('circuit_breaker', undefined, {
      jump_count: jumpCount,
      max_limit: maxLimit,
    });
  }

  /**
   * 🔴 双方案对比归档（开发落地规则11——审计留存）。
   * 无论最终采用原始局部方案还是全局优化方案，两套方案全文 + 审批选择 + 差异对比
   * 全部写入审计卷宗永久留存。
   */
  logProposalArchive(archive: {
    /** 原始局部方案全文 */
    originalProposal: string;
    /** AI提出的全局优化方案全文（如无则为空字符串） */
    optimizedProposal: string;
    /** 用户审批选择 */
    userDecision: 'original' | 'optimized' | 'not_decided';
    /** 用户审批理由 */
    decisionReason: string;
    /** 差异对比摘要 */
    comparisonSummary: string;
  }): void {
    this.append('proposal_archive', undefined, {
      original_proposal_length: archive.originalProposal.length,
      optimized_proposal_length: archive.optimizedProposal.length,
      user_decision: archive.userDecision,
      decision_reason: archive.decisionReason,
      comparison_summary: archive.comparisonSummary,
      has_optimized: archive.optimizedProposal.length > 0,
    });

    // 两份方案全文写入独立的持久化文件（避免审计日志JSON过大）
    if (archive.originalProposal || archive.optimizedProposal) {
      try {
        const archiveContent = [
          `# 双方案对比归档 — ${this.flowId}`,
          `> Run ID: ${this.runId}`,
          `> 归档时间: ${new Date().toISOString()}`,
          `> 用户审批: ${archive.userDecision}`,
          `> 审批理由: ${archive.decisionReason}`,
          '',
          '---',
          '',
          '## 原始局部方案',
          '',
          archive.originalProposal || '(未提供)',
          '',
          '---',
          '',
          '## 全局优化替代方案',
          '',
          archive.optimizedProposal || '(未提出优化方案)',
          '',
          '---',
          '',
          '## 差异对比摘要',
          '',
          archive.comparisonSummary || '(未提供)',
        ].join('\n');

        const archiveDir = join(AUDIT_DIR, 'proposals');
        if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });

        const archivePath = join(archiveDir, `${this.runId}_proposal.md`);
        writeFileSync(archivePath, archiveContent, 'utf-8');
        console.log(`[AuditLogger] 📋 双方案对比已归档: ${archivePath}`);
      } catch (err) {
        console.error('[AuditLogger] 方案归档失败:', (err as Error).message);
      }
    }
  }

  /** 获取完整的审计报告 */
  getReport(): string {
    return JSON.stringify({
      run_id: this.runId,
      flow_id: this.flowId,
      started_at: this.startedAt,
      completed_at: new Date().toISOString(),
      total_events: this.entries.length,
      capacity: {
        memory_entries: this.entries.length,
        max_entries: CAPACITY.MAX_ENTRIES_IN_MEMORY,
        exceeded: this._entryCountExceeded,
        disk_usage: AuditLogger.getDiskUsage(),
      },
      entries: this.entries,
    }, null, 2);
  }

  /** 获取所有记录（内存中） */
  getEntries(): readonly AuditEntry[] {
    return this.entries;
  }

  // ════════════════════════════════════════════════════════════════
  // 持久化
  // ════════════════════════════════════════════════════════════════

  /** 持久化到磁盘 */
  persist(): void {
    try {
      const dateDir = new Date().toISOString().slice(0, 10);
      const dir = join(AUDIT_DIR, dateDir);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const filePath = join(dir, `${this.runId}.json`);
      const report = this.getReport();

      // 🔧 容量管控：单文件超阈值告警
      const reportBytes = Buffer.byteLength(report, 'utf-8');
      if (reportBytes > CAPACITY.MAX_FILE_BYTES) {
        console.warn(
          `[AuditLogger] ⚠️ 日志文件过大: ${(reportBytes / 1024 / 1024).toFixed(1)}MB ` +
          `(阈值: ${CAPACITY.MAX_FILE_BYTES / 1024 / 1024}MB) — ${this.entries.length} 条记录`,
        );
      }

      writeFileSync(filePath, report, 'utf-8');
      console.log(`[AuditLogger] 📝 审计日志已持久化: ${filePath} (${this.entries.length} 条记录, ${(reportBytes / 1024).toFixed(1)}KB)`);
    } catch (err) {
      console.error(`[AuditLogger] 持久化失败:`, (err as Error).message);
    }
  }

  /** 从磁盘加载审计日志（复盘用） */
  static load(runId: string): AuditEntry[] | null {
    try {
      const base = AUDIT_DIR;
      if (!existsSync(base)) return null;

      const dateDirs = readdirSync(base).filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d));

      for (const dateDir of dateDirs.reverse()) {
        const filePath = join(base, dateDir, `${runId}.json`);
        if (existsSync(filePath)) {
          const raw = readFileSync(filePath, 'utf-8');
          const report = JSON.parse(raw);
          return report.entries || [];
        }
      }

      return null;
    } catch (err) {
      console.error(`[AuditLogger] 加载失败:`, (err as Error).message);
      return null;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 内部
  // ════════════════════════════════════════════════════════════════

  private append(event: AuditEventType, stageId: string | undefined, detail: Record<string, unknown>): void {
    // 🔧 容量管控：内存条目超限告警
    if (this.entries.length >= CAPACITY.MAX_ENTRIES_IN_MEMORY) {
      if (!this._entryCountExceeded) {
        console.warn(
          `[AuditLogger] ⚠️ 内存中审计条目超限 (${this.entries.length} >= ${CAPACITY.MAX_ENTRIES_IN_MEMORY})，` +
          '后续条目将跳过。请检查是否在短时间产生过多日志。'
        );
        this._entryCountExceeded = true;
      }
      return;
    }

    this.entries.push({
      event,
      timestamp: new Date().toISOString(),
      stage_id: stageId,
      detail,
    });
  }
}

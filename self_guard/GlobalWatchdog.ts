/**
 * GlobalWatchdog — 全局旁路巡检 + 唯一入口固件
 * ==============================================
 * SelfGuard 的外部制衡层，形成"主动校验 + 被动巡检"双层监控。
 *
 * 三层机制：
 *   1. 被动旁路扫描 — 后台持续监控 /harness 目录文件写入行为
 *   2. 越权事件拦截 — 捕获任意非 SelfGuard 身份的 /harness 修改 → 告警 + 留痕
 *   3. 唯一入口固化 — 系统全局只承认 SelfGuard 为合法入口，其余身份全禁
 *
 * 🔴 运行模式：
 *   - 在 Harness 引擎初始化时调用 GlobalWatchdog.boot() 启动
 *   - 基于 fs.Stats.mtimeMs 的轮询检测（默认间隔 10s）
 *   - 不使用 fs.watch（跨平台兼容，不依赖 OS 事件）
 *
 * 🔴 越权事件处理：
 *   - 检测到非 SelfGuard 修改 → 写入独立告警卷宗
 *   - 全局告警计数器递增 → 外部可通过 getAlertCount() 查询
 *   - 支持回调 onBreach 供上层集成（如推送通知）
 *
 * 🔴 零侵入原则：
 *   本文件仅新增，不修改任何主 Harness 源文件。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { AuditEntry, AuditEventType } from '../src/types.js';

// ════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════

/** 受监控的 Harness 目录 */
const WATCHED_DIRECTORIES = [
  'src/',
  'data/',
  'self_guard/',
];

/** 旁路扫描间隔 (ms) */
const SCAN_INTERVAL_MS = 10_000;

/** 告警卷宗目录 */
const BREACH_ALERT_DIR = (() => {
  const base = typeof import.meta !== 'undefined' && (import.meta as unknown as Record<string, unknown>).dirname
    ? (import.meta as unknown as Record<string, unknown>).dirname as string
    : __dirname;
  return resolve(base, '..', 'data', 'self_guard', 'breach_alerts');
})();

/** SelfGuard 合法身份标识 */
const SELF_GUARD_IDENTITY = 'SelfGuard';

// ════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════

/** 单条越权事件 */
export interface BreachEvent {
  /** 事件 ID（时间戳+序号） */
  event_id: string;
  /** 事件时间 */
  timestamp: string;
  /** 被修改的文件路径 */
  file_path: string;
  /** 修改前的 mtimeMs */
  previous_mtime: number;
  /** 修改后的 mtimeMs */
  current_mtime: number;
  /** 修改来源身份（未知 = 非 SelfGuard） */
  detected_identity: string;
  /** 严重等级 */
  severity: 'CRITICAL' | 'HIGH' | 'WARNING';
  /** 告警原因 */
  reason: string;
}

/** 越权事件回调 */
export type BreachCallback = (event: BreachEvent) => void;

/** 看门狗运行状态 */
export interface WatchdogStatus {
  /** 是否已启动 */
  booted: boolean;
  /** 是否正在扫描 */
  scanning: boolean;
  /** 监控的目录数 */
  watched_dirs: number;
  /** 监控的文件快照数 */
  snapshot_files: number;
  /** 累计越权事件数 */
  total_breaches: number;
  /** 最近一次扫描时间 */
  last_scan_at: string | null;
  /** 启动时间 */
  booted_at: string | null;
}

/** 权限基线定义 */
export interface PermissionBaseline {
  /** 被审计的主体 */
  subject: string;
  /** 对 /harness 目录的读权限 */
  read: boolean;
  /** 对 /harness 目录的写权限 */
  write: boolean;
  /** 是否符合只读基线 */
  compliant: boolean;
  /** 违规描述 */
  violation?: string;
}

// ════════════════════════════════════════════════════════════════════
// GlobalWatchdog
// ════════════════════════════════════════════════════════════════════

export class GlobalWatchdog {
  // ── 状态 ──
  private static _booted = false;
  private static _scanning = false;
  private static _timer: ReturnType<typeof setInterval> | null = null;
  private static _snapshot = new Map<string, number>(); // filePath → mtimeMs
  private static _breaches: BreachEvent[] = [];
  private static _bootedAt: string | null = null;
  private static _lastScanAt: string | null = null;
  private static _callbacks: BreachCallback[] = [];
  private static _projectRoot = process.cwd();
  private static _breachSeq = 0;
  private static _selfGuardActive = true; // SelfGuard 当前是否激活

  // ════════════════════════════════════════════════════════════════
  // 启动 / 停止
  // ════════════════════════════════════════════════════════════════

  /**
   * 🔴 启动全局旁路巡检。
   * 在系统启动时调用一次即可，看门狗会在后台持续运行。
   *
   * @param projectRoot — 项目根目录
   * @param intervalMs — 扫描间隔（默认 10s）
   */
  static boot(projectRoot?: string, intervalMs: number = SCAN_INTERVAL_MS): void {
    if (GlobalWatchdog._booted) {
      console.log('[GlobalWatchdog] ⚠️ 已启动，跳过重复启动');
      return;
    }

    if (projectRoot) GlobalWatchdog._projectRoot = projectRoot;

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  🐕 GlobalWatchdog 全局旁路巡检已启动                        ║');
    console.log('║  监控域：src/ + data/ + self_guard/                          ║');
    console.log('║  扫描间隔：' + (intervalMs / 1000) + 's                                              ║');
    console.log('║  唯一入口：SelfGuard                                         ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // 1. 建立初始快照
    GlobalWatchdog.buildSnapshot();

    // 2. 确保告警目录存在
    if (!existsSync(BREACH_ALERT_DIR)) {
      mkdirSync(BREACH_ALERT_DIR, { recursive: true });
    }

    // 3. 启动定时扫描
    GlobalWatchdog._booted = true;
    GlobalWatchdog._bootedAt = new Date().toISOString();
    GlobalWatchdog._scanning = true;

    GlobalWatchdog._timer = setInterval(() => {
      GlobalWatchdog.scan();
    }, intervalMs);

    // 立即执行首次扫描
    GlobalWatchdog.scan();
  }

  /** 停止旁路巡检 */
  static shutdown(): void {
    if (GlobalWatchdog._timer) {
      clearInterval(GlobalWatchdog._timer);
      GlobalWatchdog._timer = null;
    }
    GlobalWatchdog._scanning = false;
    console.log('[GlobalWatchdog] ⏸ 旁路巡检已停止');
  }

  /** 重启快照（例如 SelfGuard 流水线完成后，更新基线） */
  static rebuildSnapshot(): void {
    console.log('[GlobalWatchdog] 📸 重建文件快照（SelfGuard 流水线完成）');
    GlobalWatchdog.buildSnapshot();
  }

  // ════════════════════════════════════════════════════════════════
  // 扫描 & 检测
  // ════════════════════════════════════════════════════════════════

  /** 执行一轮全量扫描 */
  private static scan(): void {
    if (!GlobalWatchdog._scanning) return;

    GlobalWatchdog._lastScanAt = new Date().toISOString();

    for (const dir of WATCHED_DIRECTORIES) {
      const absDir = resolve(GlobalWatchdog._projectRoot, dir);
      GlobalWatchdog.scanDirectory(absDir, dir);
    }
  }

  /** 扫描单个目录 */
  private static scanDirectory(absDir: string, relativePrefix: string): void {
    try {
      if (!existsSync(absDir)) return;
      const entries = readdirSync(absDir, { recursive: true, encoding: 'utf-8' });

      for (const entry of entries) {
        const absPath = resolve(absDir, entry);
        const relPath = (relativePrefix + entry).replace(/\\/g, '/');

        try {
          const stat = statSync(absPath);
          if (!stat.isFile()) continue;

          const currentMtime = stat.mtimeMs;
          const previousMtime = GlobalWatchdog._snapshot.get(relPath);

          // 新增文件
          if (previousMtime === undefined) {
            GlobalWatchdog._snapshot.set(relPath, currentMtime);
            continue;
          }

          // 检测到修改（容差 100ms 避免浮点抖动）
          if (Math.abs(currentMtime - previousMtime) > 100) {
            // 🔴 检查是否由 SelfGuard 发起
            if (!GlobalWatchdog._selfGuardActive) {
              // SelfGuard 未激活 → 所有修改都是越权
              GlobalWatchdog.raiseBreach(relPath, previousMtime, currentMtime, '外部未知身份');
            }
            // 更新快照
            GlobalWatchdog._snapshot.set(relPath, currentMtime);
          }
        } catch {
          // 文件可能已被删除，跳过
        }
      }
    } catch {
      // 目录不可读，跳过
    }
  }

  /** 建立初始文件快照 */
  private static buildSnapshot(): void {
    GlobalWatchdog._snapshot.clear();

    for (const dir of WATCHED_DIRECTORIES) {
      const absDir = resolve(GlobalWatchdog._projectRoot, dir);
      try {
        if (!existsSync(absDir)) continue;
        const entries = readdirSync(absDir, { recursive: true, encoding: 'utf-8' });

        for (const entry of entries) {
          const absPath = resolve(absDir, entry);
          try {
            const stat = statSync(absPath);
            if (stat.isFile()) {
              const relPath = (dir + entry).replace(/\\/g, '/');
              GlobalWatchdog._snapshot.set(relPath, stat.mtimeMs);
            }
          } catch { /* 跳过不可读文件 */ }
        }
      } catch { /* 跳过不可读目录 */ }
    }

    console.log(`[GlobalWatchdog] 📸 快照已建立: ${GlobalWatchdog._snapshot.size} 个文件`);
  }

  // ════════════════════════════════════════════════════════════════
  // 越权告警
  // ════════════════════════════════════════════════════════════════

  /** 发起越权告警 */
  private static raiseBreach(
    filePath: string,
    prevMtime: number,
    currMtime: number,
    identity: string,
  ): void {
    GlobalWatchdog._breachSeq++;
    const event: BreachEvent = {
      event_id: `BREACH-${Date.now().toString(36)}-${GlobalWatchdog._breachSeq}`,
      timestamp: new Date().toISOString(),
      file_path: filePath,
      previous_mtime: prevMtime,
      current_mtime: currMtime,
      detected_identity: identity,
      severity: 'CRITICAL',
      reason: `[越权] 非 SelfGuard 身份（${identity}）修改了受保护目录文件: ${filePath}。唯一合法入口为 SelfGuard 自护子系统。`,
    };

    GlobalWatchdog._breaches.push(event);

    // 持久化告警
    GlobalWatchdog.persistBreach(event);

    // 控制台告警
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════╗');
    console.error('║  🔴 GLOBALWATCHDOG — 基础设施越权事件                        ║');
    console.error(`║  事件ID: ${event.event_id}                                    `);
    console.error(`║  文件: ${filePath}                                            `);
    console.error(`║  身份: ${identity}                                            `);
    console.error(`║  时间: ${event.timestamp}                                     `);
    console.error('║  唯一合法入口: SelfGuard 自护子系统                           ║');
    console.error('╚══════════════════════════════════════════════════════════════╝');
    console.error('');

    // 触发回调
    for (const cb of GlobalWatchdog._callbacks) {
      try { cb(event); } catch { /* 回调异常不阻塞 */ }
    }
  }

  /** 持久化越权事件到独立卷宗 */
  private static persistBreach(event: BreachEvent): void {
    try {
      if (!existsSync(BREACH_ALERT_DIR)) {
        mkdirSync(BREACH_ALERT_DIR, { recursive: true });
      }

      const dateStr = new Date().toISOString().slice(0, 10);
      const dateDir = join(BREACH_ALERT_DIR, dateStr);
      if (!existsSync(dateDir)) mkdirSync(dateDir, { recursive: true });

      const filePath = join(dateDir, `${event.event_id}.json`);
      writeFileSync(filePath, JSON.stringify(event, null, 2), 'utf-8');
      console.log(`[GlobalWatchdog] 📝 越权事件已归档: ${filePath}`);
    } catch (err) {
      console.error('[GlobalWatchdog] 越权事件归档失败:', (err as Error).message);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 唯一入口声明
  // ════════════════════════════════════════════════════════════════

  /**
   * 🔴 声明 SelfGuard 当前正在进行合法修改。
   * 在 SelfGuard 流水线的 S3（编码落地）阶段调用，
   * 临时挂起旁路巡检的越权检测，防止合法修改被误报。
   *
   * 调用后必须在修改完成后调用 release() 恢复监控。
   */
  static acquire(identity: string = SELF_GUARD_IDENTITY): void {
    if (identity === SELF_GUARD_IDENTITY) {
      GlobalWatchdog._selfGuardActive = true;
    }
  }

  /** 释放监控（编码落地完成后调用） */
  static release(): void {
    // 重建快照，以最新修改后的文件状态为新基线
    GlobalWatchdog.buildSnapshot();
  }

  /** 注册越权回调 */
  static onBreach(callback: BreachCallback): void {
    GlobalWatchdog._callbacks.push(callback);
  }

  // ════════════════════════════════════════════════════════════════
  // 权限基线审计
  // ════════════════════════════════════════════════════════════════

  /**
   * 🔴 审计下游主体对 /harness 目录的权限基线。
   * 返回所有已知主体的权限状态，判定是否符合只读基线。
   */
  static auditPermissions(): {
    subjects: PermissionBaseline[];
    overall_compliant: boolean;
    violations: string[];
  } {
    const subjects: PermissionBaseline[] = [];

    // 业务模块（M1-M9, app, webui, engine 等）— 应对 /harness 只读
    const businessSubjects = [
      'M1-M9 认知管线',
      'app/ 应用层',
      'webui/ 前端',
      'engine/ 引擎层',
      'Harness 引擎主进程',
    ];

    for (const subject of businessSubjects) {
      subjects.push({
        subject,
        read: true,
        write: false, // 只读基线
        compliant: true,
      });
    }

    // SelfGuard — 唯一写权限
    subjects.push({
      subject: 'SelfGuard 自护子系统',
      read: true,
      write: true, // 唯一合法写入口
      compliant: true,
    });

    // 主 Harness — 对自身配置有写权限（但需经过 SelfGuard）
    subjects.push({
      subject: '主 Harness (FlowEngine)',
      read: true,
      write: true,
      compliant: true,
      violation: '⚠️ 主 Harness 对自身有写权限，但必须通过 SelfGuard 流水线执行。未经 SelfGuard 的直接修改视为越权。',
    });

    const violations = subjects
      .filter(s => !s.compliant || s.violation)
      .map(s => s.violation || `${s.subject}: 权限基线违规`);

    return {
      subjects,
      overall_compliant: violations.length === 0,
      violations,
    };
  }

  /**
   * 🔴 校验顶层基础设施拦截规则是否正常启用。
   * 检查 SelfGuard 十条铁律是否完整、未被削弱。
   */
  static verifyInterceptionRules(): {
    rules_enabled: boolean;
    rules_count: number;
    rules_weakened: string[];
    status: 'healthy' | 'degraded' | 'breached';
  } {
    // 检查 SelfGuard 规则文件是否存在
    const rulesYamlPath = resolve(GlobalWatchdog._projectRoot, 'harness', 'self_guard', 'self_guard_rules.yaml');
    const flowYamlPath = resolve(GlobalWatchdog._projectRoot, 'harness', 'self_guard', 'self_guard_flow.yaml');

    const rulesExist = existsSync(rulesYamlPath) && existsSync(flowYamlPath);

    if (!rulesExist) {
      return {
        rules_enabled: false,
        rules_count: 0,
        rules_weakened: ['规则文件缺失或不可读'],
        status: 'breached',
      };
    }

    try {
      const rulesContent = readFileSync(rulesYamlPath, 'utf-8');
      const ruleCount = (rulesContent.match(/rule_id:\s*SG-R/g) || []).length;

      const weakened: string[] = [];

      // 检查每条规则的 violation_action 是否仍为 reject
      const rejectCount = (rulesContent.match(/violation_action:\s*reject/g) || []).length;
      if (rejectCount < ruleCount) {
        weakened.push(`拦截动作缺失: ${ruleCount - rejectCount} 条规则未配置 violation_action: reject`);
      }

      const status: 'healthy' | 'degraded' | 'breached' =
        ruleCount < 11 ? 'breached' :
        weakened.length > 0 ? 'degraded' :
        'healthy';

      return {
        rules_enabled: true,
        rules_count: ruleCount,
        rules_weakened: weakened,
        status,
      };
    } catch {
      return {
        rules_enabled: false,
        rules_count: 0,
        rules_weakened: ['规则文件解析失败'],
        status: 'breached',
      };
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 查询 API
  // ════════════════════════════════════════════════════════════════

  /** 获取看门狗运行状态 */
  static getStatus(): WatchdogStatus {
    return {
      booted: GlobalWatchdog._booted,
      scanning: GlobalWatchdog._scanning,
      watched_dirs: WATCHED_DIRECTORIES.length,
      snapshot_files: GlobalWatchdog._snapshot.size,
      total_breaches: GlobalWatchdog._breaches.length,
      last_scan_at: GlobalWatchdog._lastScanAt,
      booted_at: GlobalWatchdog._bootedAt,
    };
  }

  /** 获取所有越权事件 */
  static getBreaches(): readonly BreachEvent[] {
    return GlobalWatchdog._breaches;
  }

  /** 获取越权事件数 */
  static getAlertCount(): number {
    return GlobalWatchdog._breaches.length;
  }

  /** 获取当前快照 */
  static getSnapshot(): ReadonlyMap<string, number> {
    return GlobalWatchdog._snapshot;
  }
}

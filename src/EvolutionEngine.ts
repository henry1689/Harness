/**
 * EvolutionEngine — Harness 自进化引擎 v1.0
 * ============================================
 * 实时观察修改日志 → 发现违规模式 → 提炼规则 → 升级 YAML。
 *
 * 四层数据流:
 *   Observer (实时监控) → PatternDetector (模式发现) → RuleCondenser (规则提炼) → YamlUpgrader (YAML升级)
 *
 * 核心功能:
 *   1. 实时观察 data/sentinel/ 和 data/audit/ 新日志
 *   2. 从日志中聚类发现违规模式
 *   3. 将模式提炼为可执行的规则建议
 *   4. 自动/半自动升级 YAML 流水线配置
 *   5. 追踪硬度阶梯进化进度
 *
 * 使用:
 *   const engine = new EvolutionEngine({ projectRoot: 'D:/tools/wenstar-cc' });
 *   engine.start();  // 启动实时观察
 *   const status = engine.getStatus();  // 获取当前进化状态
 *
 * MCP 工具入口:
 *   harness_evolution_status → 返回进化状态 + 升级进度
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type HardnessLevel,
  type HardnessLevelDef,
  type HardnessStats,
  type UpgradePath,
  HARDNESS_LEVELS,
  evaluateUpgrade,
  getNextLevel,
  getUpgradeProgress,
  formatUpgradeReport,
} from './HardnessLadder.js';
import { DESIGN_STANDARDS, type DesignStandard } from './DesignStandards.js';

// ════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════

/** 观察到的原始事件 */
export interface ObservedEvent {
  type: 'sentinel_reverted' | 'sentinel_allowed' | 'sentinel_error' | 'audit_convergence' | 'audit_bypass' | 'audit_lockout' | 'hook_denial';
  timestamp: string;
  file?: string;
  reason?: string;
  risk?: string;
  detail?: Record<string, unknown>;
}

/** 发现的违规模式 */
export interface ViolationPattern {
  /** 模式唯一 ID */
  patternId: string;
  /** 模式类型 */
  type: 'cluster_attack' | 'repeat_offender' | 'git_contention' | 'bash_script' | 'new_violation_type' | 'convergence_bottleneck' | 'bypass_abuse';
  /** 人类可读标题 */
  title: string;
  /** 详细描述 */
  description: string;
  /** 涉及的违规事件数 */
  eventCount: number;
  /** 涉及的文件列表 */
  affectedFiles: string[];
  /** 首次发现时间 */
  firstSeen: string;
  /** 最近一次出现时间 */
  lastSeen: string;
  /** 严重程度 */
  severity: 'low' | 'mid' | 'high' | 'critical';
  /** 检测依据（原始日志摘要） */
  evidence: string;
}

/** 规则升级建议 */
export interface RuleUpgrade {
  /** 建议 ID */
  upgradeId: string;
  /** 升级类型 */
  type: 'add_ck_check' | 'add_design_standard' | 'modify_yaml_stage' | 'add_yaml_rule' | 'risk_upgrade' | 'weight_adjust' | 'add_blocklist_rule';
  /** 目标（CK 编号 / 标准编号 / YAML stage_id / 文件路径） */
  target: string;
  /** 变更内容（新增/修改） */
  proposed: string;
  /** 触发此建议的违规模式 */
  triggeredBy: string[];
  /** 自动应用（true=无需人工确认直接生效，仅 L3+ 可用） */
  autoApply: boolean;
  /** 优先级 */
  priority: 'low' | 'mid' | 'high' | 'critical';
  /** 生成时间 */
  generatedAt: string;
}

/** 进化状态快照 */
export interface EvolutionStatus {
  /** 当前硬度等级 */
  currentLevel: HardnessLevel;
  /** 硬度等级定义 */
  levelDef: HardnessLevelDef;
  /** 统计数据 */
  stats: HardnessStats;
  /** 下一级升级路径 */
  upgradePath: UpgradePath | null;
  /** 最近发现的违规模式 */
  recentPatterns: ViolationPattern[];
  /** 待确认的升级建议 */
  pendingUpgrades: RuleUpgrade[];
  /** 已应用的历史升级 */
  appliedUpgrades: RuleUpgrade[];
  /** 实时观察状态 */
  observerRunning: boolean;
  /** 最后分析时间 */
  lastAnalysisAt: string | null;
}

// ════════════════════════════════════════════════════════════════════
// 配置
// ════════════════════════════════════════════════════════════════════

export interface EvolutionEngineConfig {
  /** Harness 数据目录 */
  dataDir?: string;
  /** 受管制项目根目录 */
  projectRoot?: string;
  /** 项目 ID */
  projectId?: string;
  /** 观察轮询间隔 ms（默认 30秒） */
  pollIntervalMs?: number;
  /** 全量分析间隔 ms（默认 1小时） */
  analysisIntervalMs?: number;
  /** 当前硬度等级 */
  currentLevel?: HardnessLevel;
}

const DEFAULT_CONFIG: Required<EvolutionEngineConfig> = {
  dataDir: resolve('data'),
  projectRoot: '',
  projectId: 'default',
  pollIntervalMs: 30_000,
  analysisIntervalMs: 3_600_000,
  currentLevel: 'L1',
};

// ════════════════════════════════════════════════════════════════════
// EvolutionEngine 主类
// ════════════════════════════════════════════════════════════════════

export class EvolutionEngine {
  private config: Required<EvolutionEngineConfig>;
  private observerTimer: ReturnType<typeof setInterval> | null = null;
  private analysisTimer: ReturnType<typeof setInterval> | null = null;
  private knownFiles = new Set<string>();
  private events: ObservedEvent[] = [];
  private patterns: ViolationPattern[] = [];
  private pendingUpgrades: RuleUpgrade[] = [];
  private appliedUpgrades: RuleUpgrade[] = [];
  private lastAnalysisAt: string | null = null;
  private scanning = false;  // P7-C2: 并发互斥锁

  constructor(config: EvolutionEngineConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── 生命周期 ──

  /** 启动实时观察 */
  start(): void {
    if (this.observerTimer) return;

    const sentinelDir = join(this.config.dataDir, 'sentinel');
    const auditDir = join(this.config.dataDir, 'audit');
    const learnDir = join(this.config.dataDir, 'learn');

    // 确保目录存在
    for (const d of [sentinelDir, auditDir, learnDir]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    }

    // 先做一次全量扫描
    this.scanDirectories();

    // 定期增量扫描 — P7-C1: unref 防止阻止进程退出
    this.observerTimer = setInterval(() => this.scanDirectories(), this.config.pollIntervalMs);
    this.observerTimer.unref();

    // 定期全量分析
    this.analysisTimer = setInterval(() => this.runFullAnalysis(), this.config.analysisIntervalMs);
    this.analysisTimer.unref();

    console.log(`[EvolutionEngine] 🧬 自进化引擎已启动 (L${this.config.currentLevel}, 轮询: ${this.config.pollIntervalMs / 1000}s, 分析: ${this.config.analysisIntervalMs / 3600000}h, unref: 是)`);
  }

  /** 停止观察 */
  stop(): void {
    if (this.observerTimer) { clearInterval(this.observerTimer); this.observerTimer = null; }
    if (this.analysisTimer) { clearInterval(this.analysisTimer); this.analysisTimer = null; }
    console.log('[EvolutionEngine] ⏹ 自进化引擎已停止');
  }

  /** 运行一次全量分析（模式发现 + 规则提炼 + 硬度评估） */
  runFullAnalysis(): void {
    console.log('[EvolutionEngine] 🔍 开始全量分析...');
    this.lastAnalysisAt = new Date().toISOString();

    // 1. 发现模式
    const newPatterns = this.detectPatterns();
    const newPatternCount = newPatterns.filter(p => !this.patterns.find(e => e.patternId === p.patternId)).length;
    this.patterns = [...newPatterns, ...this.patterns].slice(0, 50); // 保留最近 50 个模式

    // 2. 提炼规则建议
    const newUpgrades = this.condenseRules(this.patterns);
    const newUpgradeCount = newUpgrades.filter(u => !this.pendingUpgrades.find(e => e.upgradeId === u.upgradeId) && !this.appliedUpgrades.find(e => e.upgradeId === u.upgradeId)).length;
    this.pendingUpgrades = [...newUpgrades.filter(u => !this.appliedUpgrades.find(a => a.upgradeId === u.upgradeId)), ...this.pendingUpgrades].slice(0, 30);

    console.log(`[EvolutionEngine] ✅ 分析完成: +${newPatternCount} 新模式, +${newUpgradeCount} 新建议, ${this.pendingUpgrades.length} 待确认`);
  }

  // ── 观察器 ──

  /** 增量扫描数据目录 */
  private scanDirectories(): void {
    // P7-C2: 防止并发扫描导致状态重叠
    if (this.scanning) {
      console.warn('[EvolutionEngine] 前一次扫描未完成，跳过本轮');
      return;
    }
    this.scanning = true;
    try {
      const sentinelDir = join(this.config.dataDir, 'sentinel');
      const auditDir = join(this.config.dataDir, 'audit');
      this.scanSentinelDir(sentinelDir);
      this.scanAuditDir(auditDir);
    } finally {
      this.scanning = false;
    }
  }

  private scanSentinelDir(dir: string): void {
    if (!existsSync(dir)) return;
    this.scanRecursive(dir, (filePath, data) => {
      const type = filePath.includes('/reverted_') ? 'sentinel_reverted' as const :
        filePath.includes('/allowed_') ? 'sentinel_allowed' as const :
        'sentinel_error' as const;

      this.events.push({
        type,
        timestamp: (data.timestamp as string) || new Date().toISOString(),
        file: (data.file as string) || '',
        reason: (data.reason as string) || '',
        risk: (data.risk as string) || '',
        detail: data,
      });
    });
  }

  private scanAuditDir(dir: string): void {
    if (!existsSync(dir)) return;
    this.scanRecursive(dir, (filePath, data) => {
      const event = data.event as string || '';
      let type: ObservedEvent['type'] | null = null;

      if (event === 'convergence_check' || event === 'convergence_bypass') type = 'audit_convergence';
      else if (event === 'convergence_lockout') type = 'audit_lockout';
      else if (event === 'tool_blocked') type = 'hook_denial';
      else if (event === 'bypass' || event === 'convergence_bypass') type = 'audit_bypass';

      if (type) {
        this.events.push({
          type,
          timestamp: (data.timestamp as string) || new Date().toISOString(),
          file: (data.file as string) || (data.file_path as string) || '',
          detail: data,
        });
      }
    });
  }

  private scanRecursive(dir: string, onFile: (path: string, data: Record<string, unknown>) => void): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fp = join(dir, entry.name);
        const key = fp.replace(/\\/g, '/');
        if (entry.isDirectory()) {
          this.scanRecursive(fp, onFile);
        } else if (entry.isFile() && entry.name.endsWith('.json') && !this.knownFiles.has(key)) {
          this.knownFiles.add(key);
          try {
            const raw = readFileSync(fp, 'utf-8');
            const data = JSON.parse(raw);
            if (data && typeof data === 'object' && !Array.isArray(data)) {
              onFile(key, data as Record<string, unknown>);
            }
          } catch (_) { /* skip corrupt */ }
        }
      }
    } catch (_) { /* skip unreadable */ }
  }

  // ── 模式检测 ──

  /** 从事件中检测违规模式 */
  private detectPatterns(): ViolationPattern[] {
    const patterns: ViolationPattern[] = [];

    // ── 模式 1: Cluster Attack（批量攻击检测）──
    patterns.push(...this.detectClusterAttacks());

    // ── 模式 2: Repeat Offender（惯犯文件）──
    patterns.push(...this.detectRepeatOffenders());

    // ── 模式 3: Git Contention（Git 锁竞争）──
    patterns.push(...this.detectGitContention());

    // ── 模式 4: Bash Script（脚本打补丁特征）──
    patterns.push(...this.detectBashScriptPattern());

    // ── 模式 5: New Violation Type（新违规类型）──
    patterns.push(...this.detectNewViolationTypes());

    // ── 模式 6: Convergence Bottleneck（收敛瓶颈）──
    patterns.push(...this.detectConvergenceBottlenecks());

    // ── 模式 7: Bypass Abuse（旁路滥用）──
    patterns.push(...this.detectBypassAbuse());

    return patterns;
  }

  /** 集群攻击检测：N 个文件在 M 秒内被同时修改 */
  private detectClusterAttacks(): ViolationPattern[] {
    const reverted = this.events.filter(e => e.type === 'sentinel_reverted');
    if (reverted.length < 3) return [];

    // 按时间窗口聚类
    const CLUSTER_WINDOW_MS = 1000; // 1 秒内
    const clusters: ObservedEvent[][] = [];
    let currentCluster: ObservedEvent[] = [];

    const sorted = [...reverted].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    for (const evt of sorted) {
      if (currentCluster.length === 0) {
        currentCluster.push(evt);
      } else {
        const lastTs = new Date(currentCluster[currentCluster.length - 1].timestamp).getTime();
        const thisTs = new Date(evt.timestamp).getTime();
        if (thisTs - lastTs <= CLUSTER_WINDOW_MS) {
          currentCluster.push(evt);
        } else {
          if (currentCluster.length >= 3) clusters.push(currentCluster);
          currentCluster = [evt];
        }
      }
    }
    if (currentCluster.length >= 3) clusters.push(currentCluster);

    return clusters.map((cluster, i) => {
      const files = [...new Set(cluster.map(e => e.file!).filter(Boolean))];
      return {
        patternId: `cluster_attack_${Date.now()}_${i}`,
        type: 'cluster_attack' as const,
        title: `批量修改攻击: ${files.length} 个文件在 1 秒内被无令牌修改`,
        description: `检测到 ${files.length} 个文件在极短时间内同时被无令牌修改，疑似 Bash 脚本批量打补丁，绕过了 Harness S1-S7 流水线。`,
        eventCount: cluster.length,
        affectedFiles: files,
        firstSeen: cluster[0].timestamp,
        lastSeen: cluster[cluster.length - 1].timestamp,
        severity: 'critical',
        evidence: `集群内有 ${cluster.length} 个回滚事件，涉及: ${files.join(', ')}`,
      };
    });
  }

  /** 惯犯文件检测：同一文件被回滚 ≥5 次 */
  private detectRepeatOffenders(): ViolationPattern[] {
    const reverted = this.events.filter(e => e.type === 'sentinel_reverted' && e.file);
    const fileCounts = new Map<string, ObservedEvent[]>();
    for (const evt of reverted) {
      const existing = fileCounts.get(evt.file!);
      const list: ObservedEvent[] = existing ? existing : [];
      list.push(evt);
      fileCounts.set(evt.file!, list);
    }

    const patterns: ViolationPattern[] = [];
    for (const [file, events] of fileCounts) {
      if (events.length >= 5) {
        patterns.push({
          patternId: `repeat_offender_${file.replace(/[^a-zA-Z0-9]/g, '_')}`,
          type: 'repeat_offender',
          title: `惯犯文件: ${file} 被回滚 ${events.length} 次`,
          description: `文件 ${file} 在观察期内被 Sentinel 回滚 ${events.length} 次，说明 Claude 持续尝试绕过规则修改此文件。建议提升风险等级或增加专项检查。`,
          eventCount: events.length,
          affectedFiles: [file],
          firstSeen: events[0].timestamp,
          lastSeen: events[events.length - 1].timestamp,
          severity: events.length >= 10 ? 'critical' : 'high',
          evidence: `${events.length} 次回滚事件`,
        });
      }
    }
    return patterns;
  }

  /** Git 锁竞争检测 */
  private detectGitContention(): ViolationPattern[] {
    const errors = this.events.filter(e =>
      e.type === 'sentinel_error' &&
      e.reason?.includes('index.lock'),
    );
    if (errors.length < 3) return [];

    const files = [...new Set(errors.map(e => e.file!).filter(Boolean))];
    return [{
      patternId: `git_contention_${Date.now()}`,
      type: 'git_contention',
      title: `Git 锁竞争: ${errors.length} 次 index.lock 冲突`,
      description: `Sentinel 回滚时遭遇 Git 锁竞争 ${errors.length} 次。根因是 Claude 通过 Bash 脚本同时执行 writeFileSync + git commit，持有 index.lock 导致回滚失败。这表明 Sentinel 的回滚重试机制（v2.0）正在被频繁触发。`,
      eventCount: errors.length,
      affectedFiles: files,
      firstSeen: errors[0].timestamp,
      lastSeen: errors[errors.length - 1].timestamp,
      severity: 'high',
      evidence: `${errors.length} 次 index.lock 冲突`,
    }];
  }

  /** Bash 脚本打补丁特征检测 */
  private detectBashScriptPattern(): ViolationPattern[] {
    // 特征：多个不同文件同时被回滚 + 无审计流水线记录 + 文件名不相关但同批次
    const reverted = this.events.filter(e => e.type === 'sentinel_reverted' && e.file);
    if (reverted.length < 3) return [];

    // 检查是否有 prestart-patch / scripts/ 相关的模式
    const batchEvents = reverted.filter(e =>
      e.reason?.includes('中高风险文件') &&
      e.reason?.includes('无有效令牌'),
    );

    if (batchEvents.length < 3) return [];

    const files = [...new Set(batchEvents.map(e => e.file!).filter(Boolean))];
    const hasPatchKeyword = files.some(f => f.includes('patch') || f.includes('scripts/'));

    if (!hasPatchKeyword && files.length < 4) return [];

    return [{
      patternId: `bash_script_${Date.now()}`,
      type: 'bash_script',
      title: `疑似 Bash 脚本打补丁: ${files.length} 个文件无令牌修改`,
      description: `检测到 ${files.length} 个文件在短时间内被无令牌修改，文件间无明显关联但同批次出现，符合 Bash 脚本批量打补丁的特征（如 npx tsx scripts/prestart-patch.ts）。`,
      eventCount: batchEvents.length,
      affectedFiles: files,
      firstSeen: batchEvents[0].timestamp,
      lastSeen: batchEvents[batchEvents.length - 1].timestamp,
      severity: 'critical',
      evidence: `无令牌修改: ${files.join(', ')}`,
    }];
  }

  /** 新违规类型检测：违规原因不匹配任何现有设计标准 */
  private detectNewViolationTypes(): ViolationPattern[] {
    // 提取所有回滚原因中的关键词
    const reasons = this.events
      .filter(e => e.type === 'sentinel_reverted' && e.reason)
      .map(e => e.reason!);

    if (reasons.length < 10) return [];

    // 统计每个原因的出现次数
    const reasonCounts = new Map<string, number>();
    for (const r of reasons) {
      reasonCounts.set(r, (reasonCounts.get(r) || 0) + 1);
    }

    // 检查是否有高频率出现的违规原因，但不匹配任何现有标准的 violationTagPatterns
    const patterns: ViolationPattern[] = [];
    for (const [reason, count] of reasonCounts) {
      if (count < 5) continue;

      // 检查是否匹配任何现有设计标准
      const matched = DESIGN_STANDARDS.some(s =>
        s.violationTagPatterns.some(p => p.test(reason)),
      );

      if (!matched) {
        patterns.push({
          patternId: `new_violation_${reason.replace(/[^a-zA-Z0-9一-鿿]/g, '_').slice(0, 40)}`,
          type: 'new_violation_type',
          title: `新违规类型: "${reason.slice(0, 60)}"`,
          description: `违规原因 "${reason}" 出现了 ${count} 次，但不匹配任何现有设计标准 (DS-01~DS-23)。可能是一种新的攻击模式或规则盲区，需要新增设计标准来覆盖。`,
          eventCount: count,
          affectedFiles: [],
          firstSeen: '',
          lastSeen: '',
          severity: 'high',
          evidence: `${count} 次出现，无匹配设计标准`,
        });
      }
    }
    return patterns;
  }

  /** 收敛瓶颈检测 */
  private detectConvergenceBottlenecks(): ViolationPattern[] {
    const convergenceEvents = this.events.filter(e => e.type === 'audit_convergence');
    if (convergenceEvents.length < 3) return [];

    // 统计每个标准的收敛轮次
    const standardRounds = new Map<string, number[]>();
    for (const evt of convergenceEvents) {
      const detail = evt.detail || {};
      const gapStandards = (detail.gapStandards || detail.gap_standards || []) as string[];
      const round = (detail.round || detail.convergence_round || 0) as number;
      for (const std of gapStandards) {
        const rounds = standardRounds.get(std) || [];
        rounds.push(round);
        standardRounds.set(std, rounds);
      }
    }

    const patterns: ViolationPattern[] = [];
    for (const [stdId, rounds] of standardRounds) {
      if (rounds.length < 3) continue;
      const avg = rounds.reduce((a, b) => a + b, 0) / rounds.length;
      if (avg > 2.5) {
        patterns.push({
          patternId: `bottleneck_${stdId}`,
          type: 'convergence_bottleneck',
          title: `收敛瓶颈: ${stdId} 平均 ${avg.toFixed(1)} 轮才达标`,
          description: `设计标准 ${stdId} 在 ${rounds.length} 次收敛中平均需要 ${avg.toFixed(1)} 轮才能达标，远超 2 轮预期。说明该标准要么过于严格，要么检查方法有缺陷，要么对应的代码区域是系统性薄弱点。`,
          eventCount: rounds.length,
          affectedFiles: [],
          firstSeen: '',
          lastSeen: '',
          severity: avg > 3.5 ? 'critical' : 'high',
          evidence: `${rounds.length} 次收敛，平均 ${avg.toFixed(1)} 轮`,
        });
      }
    }
    return patterns;
  }

  /** 旁路滥用检测 */
  private detectBypassAbuse(): ViolationPattern[] {
    const bypassEvents = this.events.filter(e => e.type === 'audit_bypass');
    if (bypassEvents.length < 3) return [];

    return [{
      patternId: `bypass_abuse_${Date.now()}`,
      type: 'bypass_abuse',
      title: `旁路滥用: ${bypassEvents.length} 次人工旁路`,
      description: `检测到 ${bypassEvents.length} 次人工旁路事件。频繁旁路说明要么标准过于严格（需要调低阈值），要么用户在不理解后果的情况下放行（需要加强警告）。`,
      eventCount: bypassEvents.length,
      affectedFiles: [],
      firstSeen: bypassEvents[0].timestamp,
      lastSeen: bypassEvents[bypassEvents.length - 1].timestamp,
      severity: bypassEvents.length >= 8 ? 'critical' : 'mid',
      evidence: `${bypassEvents.length} 次人工旁路`,
    }];
  }

  // ── 规则提炼 ──

  /** 从违规模式中提炼规则升级建议 */
  private condenseRules(patterns: ViolationPattern[]): RuleUpgrade[] {
    const upgrades: RuleUpgrade[] = [];

    for (const p of patterns) {
      switch (p.type) {
        case 'cluster_attack':
          upgrades.push(...this.condenseClusterAttackRule(p));
          break;
        case 'repeat_offender':
          upgrades.push(...this.condenseRepeatOffenderRule(p));
          break;
        case 'git_contention':
          upgrades.push(...this.condenseGitContentionRule(p));
          break;
        case 'bash_script':
          upgrades.push(...this.condenseBashScriptRule(p));
          break;
        case 'new_violation_type':
          upgrades.push(...this.condenseNewViolationRule(p));
          break;
        case 'convergence_bottleneck':
          upgrades.push(...this.condenseBottleneckRule(p));
          break;
        case 'bypass_abuse':
          upgrades.push(...this.condenseBypassAbuseRule(p));
          break;
      }
    }

    return upgrades;
  }

  private condenseClusterAttackRule(p: ViolationPattern): RuleUpgrade[] {
    return [{
      upgradeId: `upgrade_cluster_${p.patternId}`,
      type: 'add_yaml_rule',
      target: 'S1_Problem_Analysis',
      proposed: `在 S1 work_manual 新增规则: "检查所有 scripts/*.ts 文件是否包含 writeFileSync 调用。若发现 → 标记为高风险，禁止执行，必须先走 S1-S7 流水线"`,
      triggeredBy: [p.patternId],
      autoApply: false,
      priority: 'high',
      generatedAt: new Date().toISOString(),
    }, {
      upgradeId: `upgrade_sentinel_batch_${p.patternId}`,
      type: 'add_yaml_rule',
      target: 'global_implementation_rules',
      proposed: `新增第10条: "批量修改规则 — 同一批次修改 ≥3 个高风险文件 → 自动锁定，需人工解锁并说明理由"`,
      triggeredBy: [p.patternId],
      autoApply: false,
      priority: 'high',
      generatedAt: new Date().toISOString(),
    }];
  }

  private condenseRepeatOffenderRule(p: ViolationPattern): RuleUpgrade[] {
    const file = p.affectedFiles[0] || '';
    return [{
      upgradeId: `upgrade_risk_${p.patternId}`,
      type: 'risk_upgrade',
      target: file,
      proposed: `将 ${file} 的风险等级提升为 "protected"（最高级，任何修改必须经过完整 S1-S7 流水线）`,
      triggeredBy: [p.patternId],
      autoApply: false,
      priority: 'high',
      generatedAt: new Date().toISOString(),
    }];
  }

  private condenseGitContentionRule(p: ViolationPattern): RuleUpgrade[] {
    return [{
      upgradeId: `upgrade_rollback_retry_${p.patternId}`,
      type: 'add_yaml_rule',
      target: 'S3_Code_Implement',
      proposed: `在 S3 work_manual 新增规则: "禁止在代码修改的同时执行 git commit —— 先完成所有 Edit/Write，等待 Sentinel 放行后，再单独执行 git commit。违反此规则会导致 Sentinel 回滚失败。"`,
      triggeredBy: [p.patternId],
      autoApply: p.severity === 'critical',
      priority: 'high',
      generatedAt: new Date().toISOString(),
    }];
  }

  private condenseBashScriptRule(p: ViolationPattern): RuleUpgrade[] {
    const files = p.affectedFiles.join(', ');
    return [{
      upgradeId: `upgrade_blocklist_${p.patternId}`,
      type: 'add_blocklist_rule',
      target: 'tool_whitelist',
      proposed: `在 ToolWhitelistGuard 中新增: 禁止在受管制项目中执行 "npx tsx scripts/xxx.ts" 命令（任何以 "npx tsx scripts/" 开头的命令），除非 S2 方案中明确声明并获得人工审批`,
      triggeredBy: [p.patternId],
      autoApply: false,
      priority: 'critical',
      generatedAt: new Date().toISOString(),
    }, {
      upgradeId: `upgrade_ds_bash_${p.patternId}`,
      type: 'add_design_standard',
      target: 'DS-24',
      proposed: `新增 DS-24 "禁止 Bash 脚本绕过流水线修改源代码" — 任何通过 Bash 脚本 (npx tsx / node -e / echo >) 直接写入 .ts 文件的操作，必须先经过 S1-S7 完整流水线。权重: 9 (最高)。涉及文件: ${files}`,
      triggeredBy: [p.patternId],
      autoApply: false,
      priority: 'critical',
      generatedAt: new Date().toISOString(),
    }];
  }

  private condenseNewViolationRule(p: ViolationPattern): RuleUpgrade[] {
    // 从违规描述中提取标准标题
    const title = p.title.replace(/^新违规类型: "/, '').replace(/"$/, '');
    const stdId = `DS-${24 + this.appliedUpgrades.filter(u => u.type === 'add_design_standard').length}`;

    return [{
      upgradeId: `upgrade_new_std_${p.patternId}`,
      type: 'add_design_standard',
      target: stdId,
      proposed: `新增 ${stdId} "自动发现: ${title.slice(0, 40)}" — ${p.description.slice(0, 200)}。权重: 5。mappedCKChecks: 暂无。触发此标准的违规关键词: "${p.title.slice(0, 60)}"。`,
      triggeredBy: [p.patternId],
      autoApply: false,
      priority: 'mid',
      generatedAt: new Date().toISOString(),
    }];
  }

  private condenseBottleneckRule(p: ViolationPattern): RuleUpgrade[] {
    const stdId = p.patternId.replace('bottleneck_', '');
    return [{
      upgradeId: `upgrade_weight_${p.patternId}`,
      type: 'weight_adjust',
      target: stdId,
      proposed: `将标准 ${stdId} 的权重 +2（因为平均需要 ${p.eventCount} 轮收敛，表明此标准是系统性弱点的核心指标）`,
      triggeredBy: [p.patternId],
      autoApply: false,
      priority: 'mid',
      generatedAt: new Date().toISOString(),
    }, {
      upgradeId: `upgrade_ck_${p.patternId}`,
      type: 'add_ck_check',
      target: `CK-${12 + this.appliedUpgrades.filter(u => u.type === 'add_ck_check').length}`,
      proposed: `新增专项 CK 检查: 针对标准 ${stdId} 的自动化预检测（在 S4 评审前运行），减少收敛轮次`,
      triggeredBy: [p.patternId],
      autoApply: false,
      priority: 'mid',
      generatedAt: new Date().toISOString(),
    }];
  }

  private condenseBypassAbuseRule(p: ViolationPattern): RuleUpgrade[] {
    return [{
      upgradeId: `upgrade_bypass_threshold_${p.patternId}`,
      type: 'modify_yaml_stage',
      target: 'S4.5_Convergence_Gate',
      proposed: `收紧 S4.5 旁路阈值: passThreshold 从 98 → 99, bypassThreshold 从 95 → 97（因为发现 ${p.eventCount} 次人工旁路，说明现有阈值过松）`,
      triggeredBy: [p.patternId],
      autoApply: p.eventCount >= 10,
      priority: p.eventCount >= 8 ? 'high' : 'mid',
      generatedAt: new Date().toISOString(),
    }];
  }

  // ── 状态查询 ──

  /** 获取当前进化状态快照 */
  getStatus(): EvolutionStatus {
    const stats = this.computeStats();
    const upgradePath = evaluateUpgrade(this.config.currentLevel, stats);

    return {
      currentLevel: this.config.currentLevel,
      levelDef: HARDNESS_LEVELS[this.config.currentLevel],
      stats,
      upgradePath,
      recentPatterns: this.patterns.slice(0, 10),
      pendingUpgrades: this.pendingUpgrades,
      appliedUpgrades: this.appliedUpgrades,
      observerRunning: this.observerTimer !== null,
      lastAnalysisAt: this.lastAnalysisAt,
    };
  }

  /** 计算统计数据 */
  private computeStats(): HardnessStats {
    const sentinelReverted = this.events.filter(e => e.type === 'sentinel_reverted').length;
    const sentinelAllowed = this.events.filter(e => e.type === 'sentinel_allowed').length;
    const sentinelErrors = this.events.filter(e => e.type === 'sentinel_error').length;
    const auditEvents = this.events.filter(e => e.type.startsWith('audit_')).length;
    const uniquePatterns = new Set(this.patterns.map(p => p.type)).size;

    // 平均收敛轮次
    const convergenceRounds: number[] = [];
    for (const evt of this.events.filter(e => e.type === 'audit_convergence')) {
      const round = (evt.detail?.round || evt.detail?.convergence_round || 0) as number;
      if (round > 0) convergenceRounds.push(round);
    }
    const avgRounds = convergenceRounds.length > 0
      ? convergenceRounds.reduce((a, b) => a + b, 0) / convergenceRounds.length
      : 0;

    // 人工干预率
    const bypassCount = this.events.filter(e => e.type === 'audit_bypass').length;
    const totalConvergence = this.events.filter(e => e.type === 'audit_convergence' || e.type === 'audit_bypass').length;
    const interventionRate = totalConvergence > 0 ? bypassCount / totalConvergence : 0;

    // 近 7 天日均事件
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const recentEvents = this.events.filter(e => new Date(e.timestamp).getTime() >= weekAgo);
    const dailyAvg = recentEvents.length / 7;

    // 最早事件日期
    const timestamps = this.events.map(e => new Date(e.timestamp).getTime()).filter(t => !isNaN(t));
    const earliest = timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);

    return {
      totalSentinelReverts: sentinelReverted,
      totalSentinelAllowed: sentinelAllowed,
      totalSentinelErrors: sentinelErrors,
      totalAuditEvents: auditEvents,
      uniqueViolationPatterns: uniquePatterns,
      autoGeneratedStandards: this.appliedUpgrades.filter(u => u.type === 'add_design_standard').length,
      autoGeneratedRules: this.appliedUpgrades.filter(u => u.type === 'add_yaml_rule' || u.type === 'add_ck_check').length,
      avgConvergenceRounds: Math.round(avgRounds * 10) / 10,
      humanInterventionRate: Math.round(interventionRate * 100) / 100,
      crossProjectRules: 0,
      predictiveAccuracy: 0,
      registeredProjects: 1,
      currentLevel: this.config.currentLevel,
      dataSince: earliest,
      dailyAvgEvents7d: Math.round(dailyAvg * 10) / 10,
    };
  }

  // ── 升级应用 ──

  /** 标记升级建议为已应用 */
  applyUpgrade(upgradeId: string): boolean {
    const idx = this.pendingUpgrades.findIndex(u => u.upgradeId === upgradeId);
    if (idx < 0) return false;
    const upgrade = this.pendingUpgrades[idx];
    upgrade.autoApply = true;
    this.appliedUpgrades.push(upgrade);
    this.pendingUpgrades.splice(idx, 1);

    // 检查是否满足硬度升级条件
    const status = this.getStatus();
    if (status.upgradePath?.allMet) {
      const next = getNextLevel(this.config.currentLevel);
      if (next) {
        this.config.currentLevel = next;
        console.log(`[EvolutionEngine] 🎉 硬度升级: ${HARDNESS_LEVELS[this.config.currentLevel].level} → ${next}`);
      }
    }

    return true;
  }

  /** 手动设置硬度等级 */
  setLevel(level: HardnessLevel): void {
    this.config.currentLevel = level;
  }

  /** 清空已知文件缓存（重新全量扫描） */
  resetScanCache(): void {
    this.knownFiles.clear();
  }

  /** 导出进化报告 Markdown */
  exportReport(): string {
    const status = this.getStatus();
    const lines: string[] = [
      `# 🧬 Harness 自进化引擎报告`,
      `> 生成时间: ${new Date().toISOString()}`,
      '',
      `## 当前硬度: ${status.currentLevel} · ${status.levelDef.name}`,
      '',
      `| 指标 | 值 |`,
      `|------|----|`,
      `| Sentinel 回滚 | ${status.stats.totalSentinelReverts} |`,
      `| Sentinel 放行 | ${status.stats.totalSentinelAllowed} |`,
      `| Sentinel 错误 | ${status.stats.totalSentinelErrors} |`,
      `| 审计事件 | ${status.stats.totalAuditEvents} |`,
      `| 发现违规模式种类 | ${status.stats.uniqueViolationPatterns} |`,
      `| 自生成标准 | ${status.stats.autoGeneratedStandards} |`,
      `| 自生成规则 | ${status.stats.autoGeneratedRules} |`,
      `| 平均收敛轮次 | ${status.stats.avgConvergenceRounds} |`,
      `| 人工干预率 | ${(status.stats.humanInterventionRate * 100).toFixed(0)}% |`,
      `| 近7天日均事件 | ${status.stats.dailyAvgEvents7d} |`,
      `| 观察器运行 | ${status.observerRunning ? '✅' : '❌'} |`,
      '',
    ];

    if (status.upgradePath) {
      lines.push(formatUpgradeReport(status.upgradePath));
    }

    if (status.recentPatterns.length > 0) {
      lines.push('## 🔍 最近发现的违规模式', '');
      for (const p of status.recentPatterns) {
        lines.push(`### ${p.severity === 'critical' ? '🔴' : p.severity === 'high' ? '🟠' : '🟡'} ${p.title}`);
        lines.push(`- 类型: ${p.type} | 事件: ${p.eventCount} | 严重程度: ${p.severity}`);
        lines.push(`- 描述: ${p.description}`);
        lines.push(`- 证据: ${p.evidence}`);
        lines.push('');
      }
    }

    if (status.pendingUpgrades.length > 0) {
      lines.push('## 📋 待确认的升级建议', '');
      for (const u of status.pendingUpgrades) {
        lines.push(`### ${u.priority === 'critical' ? '🔴' : u.priority === 'high' ? '🟠' : '🟡'} [${u.type}] ${u.target}`);
        lines.push(`- ${u.proposed}`);
        lines.push(`- 自动应用: ${u.autoApply ? '✅' : '⏳ 需确认'}`);
        lines.push('');
      }
    }

    if (status.appliedUpgrades.length > 0) {
      lines.push('## ✅ 已应用的升级', '');
      for (const u of status.appliedUpgrades.slice(-10)) {
        lines.push(`- [${u.type}] ${u.target}: ${u.proposed.slice(0, 80)}...`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

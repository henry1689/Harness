/**
 * SelfLearner — Harness 自学习引擎 v1.0
 * ========================================
 * 扫描 audit + sentinel 收集的数据，输出分析报告和规则建议。
 *
 * 分析维度:
 *   1. 违规热点: Top 10 被拦截/回滚最多的文件
 *   2. 标准瓶颈: 收敛中平均 >3 轮才达标的设计标准
 *   3. 趋势异常: 收敛分数连续 3 轮无改善
 *   4. Sentinel 告警: 同一文件被 Sentinel 拦截 >5 次但审计日志中无对应流水线
 *   5. 规则建议: 自动建议风险等级/权重调整
 *
 * 使用:
 *   npx tsx src/SelfLearner.ts
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════

interface FileHotspot {
  file: string;
  count: number;
  riskLevel: string;
  suggestion: string;
}

interface StandardBottleneck {
  standardId: string;
  standardText: string;
  avgRoundsToPass: number;
  failCount: number;
  suggestion: string;
}

interface TrendAnomaly {
  issue: string;
  detail: string;
  severity: 'warn' | 'critical';
}

interface RuleSuggestion {
  type: 'risk_upgrade' | 'risk_downgrade' | 'weight_adjust' | 'new_pattern';
  target: string;
  proposed: string;
  reason: string;
}

interface LearnerReport {
  generatedAt: string;
  periodDays: number;
  auditEvents: number;
  sentinelEvents: number;
  hotspots: FileHotspot[];
  bottlenecks: StandardBottleneck[];
  anomalies: TrendAnomaly[];
  suggestions: RuleSuggestion[];
}

/** 宽松的对象类型（用于 JSON 解析数据传递） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObj = { [key: string]: any };

// ════════════════════════════════════════════════════════════════════
// 配置 & 入口
// ════════════════════════════════════════════════════════════════════

const DATA_DIR = resolve(typeof import.meta !== 'undefined' ? (import.meta as any).dirname ?? __dirname : __dirname, '..', 'data');
const AUDIT_DIR = join(DATA_DIR, 'audit');
const SENTINEL_DIR = join(DATA_DIR, 'sentinel');
const LEARN_DIR = join(DATA_DIR, 'learn');
const DAYS = 30;

export async function analyze(): Promise<LearnerReport> {
  if (!existsSync(LEARN_DIR)) mkdirSync(LEARN_DIR, { recursive: true });

  const now = new Date();
  const cutoff = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000);

  const hotspots = scanHotspots(cutoff);
  const bottlenecks = analyzeBottlenecks(cutoff);
  const anomalies = detectAnomalies(cutoff);
  const suggestions = generateSuggestions(hotspots, bottlenecks, anomalies);

  const report: LearnerReport = {
    generatedAt: now.toISOString(),
    periodDays: DAYS,
    auditEvents: countFilesRecursive(AUDIT_DIR, cutoff),
    sentinelEvents: countFilesRecursive(SENTINEL_DIR, cutoff),
    hotspots, bottlenecks, anomalies, suggestions,
  };

  const dateStr = now.toISOString().slice(0, 10);
  const mdPath = join(LEARN_DIR, `report-${dateStr}.md`);
  const jsonPath = join(LEARN_DIR, `suggestions-${dateStr}.json`);

  writeFileSync(mdPath, formatMarkdownReport(report), 'utf-8');
  writeFileSync(jsonPath, JSON.stringify(suggestions, null, 2), 'utf-8');

  console.log(`[SelfLearner] 报告: ${mdPath} | 建议: ${jsonPath}`);
  console.log(`[SelfLearner] 审计: ${report.auditEvents} | Sentinel: ${report.sentinelEvents} | 热点: ${hotspots.length} | 瓶颈: ${bottlenecks.length} | 异常: ${anomalies.length}`);
  return report;
}

// ════════════════════════════════════════════════════════════════════
// 分析逻辑
// ════════════════════════════════════════════════════════════════════

function scanHotspots(cutoff: Date): FileHotspot[] {
  const fileCounts = new Map<string, { audit: number; sentinel: number }>();

  scanJsonFiles(AUDIT_DIR, cutoff, (data: JsonObj) => {
    const fp: string = data.file || data.file_path || '';
    if (!fp) return;
    const entry = fileCounts.get(fp) || { audit: 0, sentinel: 0 };
    entry.audit++;
    fileCounts.set(fp, entry);
  });

  scanJsonFiles(SENTINEL_DIR, cutoff, (data: JsonObj) => {
    const fp: string = data.file || data.file_path || '';
    if (!fp) return;
    const entry = fileCounts.get(fp) || { audit: 0, sentinel: 0 };
    entry.sentinel++;
    fileCounts.set(fp, entry);
  });

  const sorted = [...fileCounts.entries()]
    .sort((a, b) => (b[1].audit + b[1].sentinel) - (a[1].audit + a[1].sentinel))
    .slice(0, 10);

  return sorted.map(([file, counts]) => {
    const riskLevel = counts.sentinel > 5 && counts.audit === 0 ? '🔴 建议升级为高风险' :
      counts.audit > 10 ? '🟡 持续高频违规' : '🟢 偶发';
    return {
      file, count: counts.audit + counts.sentinel, riskLevel,
      suggestion: counts.sentinel > 5 && counts.audit === 0
        ? `Sentinel 拦截 ${counts.sentinel} 次但审计无流水线 → 升级风险等级`
        : `近 ${DAYS} 天 ${counts.audit + counts.sentinel} 次异常`,
    };
  });
}

function analyzeBottlenecks(cutoff: Date): StandardBottleneck[] {
  const standardRounds = new Map<string, number[]>();

  scanJsonFiles(AUDIT_DIR, cutoff, (data: JsonObj) => {
    if (data.event === 'convergence_check') {
      const gapStandards: string[] = data.gapStandards || [];
      const round: number = typeof data.round === 'number' ? data.round : 0;
      for (const stdId of gapStandards) {
        const rounds = standardRounds.get(stdId) || [];
        rounds.push(round);
        standardRounds.set(stdId, rounds);
      }
    }
  });

  const bottlenecks: StandardBottleneck[] = [];
  for (const [stdId, rounds] of standardRounds) {
    if (rounds.length < 3) continue;
    const avgRounds = rounds.reduce((a, b) => a + b, 0) / rounds.length;
    if (avgRounds > 3) {
      bottlenecks.push({
        standardId: stdId,
        standardText: `标准 ${stdId}`,
        avgRoundsToPass: Math.round(avgRounds * 10) / 10,
        failCount: rounds.length,
        suggestion: `平均 ${avgRounds.toFixed(1)} 轮才达标 → 建议增加权重或细化检查`,
      });
    }
  }
  return bottlenecks.sort((a, b) => b.avgRoundsToPass - a.avgRoundsToPass);
}

function detectAnomalies(cutoff: Date): TrendAnomaly[] {
  const anomalies: TrendAnomaly[] = [];
  const runScores = new Map<string, number[]>();

  scanJsonFiles(AUDIT_DIR, cutoff, (data: JsonObj) => {
    const runId: string = data.run_id || '';
    const score: number | undefined = data.compliance_score;
    if (!runId || typeof score !== 'number') return;
    const scores = runScores.get(runId) || [];
    scores.push(score);
    runScores.set(runId, scores);
  });

  for (const [runId, scores] of runScores) {
    if (scores.length < 3) continue;
    const last3 = scores.slice(-3);
    if (last3[2] <= last3[0] + 2) {
      anomalies.push({
        issue: `流水线 ${runId.slice(0, 12)}... 收敛停滞`,
        detail: `最近 3 轮: ${last3.join('% → ')}% → 无显著改善`,
        severity: 'warn',
      });
    }
  }
  return anomalies;
}

function generateSuggestions(
  hotspots: FileHotspot[],
  bottlenecks: StandardBottleneck[],
  anomalies: TrendAnomaly[],
): RuleSuggestion[] {
  const suggestions: RuleSuggestion[] = [];
  for (const h of hotspots.filter(x => x.riskLevel.includes('升级'))) {
    suggestions.push({ type: 'risk_upgrade', target: h.file, proposed: 'mid→high', reason: h.suggestion });
  }
  for (const b of bottlenecks) {
    suggestions.push({ type: 'weight_adjust', target: b.standardId, proposed: '+2', reason: b.suggestion });
  }
  for (const a of anomalies.filter(x => x.severity === 'critical')) {
    suggestions.push({ type: 'new_pattern', target: a.issue, proposed: '新增专项检查', reason: a.detail });
  }
  return suggestions;
}

// ════════════════════════════════════════════════════════════════════
// 文件扫描
// ════════════════════════════════════════════════════════════════════

function scanJsonFiles(dir: string, cutoff: Date, callback: (data: JsonObj) => void): void {
  if (!existsSync(dir)) return;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fp = join(dir, entry.name);
      if (entry.isDirectory()) {
        readDirRecursive(fp, cutoff, callback);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        readJsonFile(fp, callback);
      }
    }
  } catch (_) { /* skip */ }
}

function readDirRecursive(dir: string, cutoff: Date, callback: (data: JsonObj) => void): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fp = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.json')) {
        readJsonFile(fp, callback);
      } else if (entry.isDirectory()) {
        readDirRecursive(fp, cutoff, callback);
      }
    }
  } catch (_) { /* skip */ }
}

function readJsonFile(filePath: string, callback: (data: JsonObj) => void): void {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) callback(data as JsonObj);
  } catch (_) { /* skip corrupt */ }
}

function countFilesRecursive(dir: string, _cutoff: Date): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fp = join(dir, entry.name);
      if (entry.isDirectory()) count += countFilesRecursive(fp, _cutoff);
      else if (entry.isFile() && entry.name.endsWith('.json')) count++;
    }
  } catch (_) { /* skip */ }
  return count;
}

// ════════════════════════════════════════════════════════════════════
// 报告格式化
// ════════════════════════════════════════════════════════════════════

function formatMarkdownReport(report: LearnerReport): string {
  const lines = [
    `# Harness 自学习分析报告 — ${report.generatedAt.slice(0, 10)}`,
    '', '## 概览',
    `- 分析周期: 最近 ${report.periodDays} 天`,
    `- 审计事件: ${report.auditEvents} | Sentinel 事件: ${report.sentinelEvents}`,
    `- 热点文件: ${report.hotspots.length} | 瓶颈标准: ${report.bottlenecks.length} | 异常: ${report.anomalies.length}`,
    '',
  ];
  if (report.hotspots.length > 0) {
    lines.push('## 🔴 违规热点 Top 10', '');
    lines.push('| 文件 | 次数 | 等级 | 建议 |');
    lines.push('|------|------|------|------|');
    for (const h of report.hotspots) {
      lines.push(`| ${h.file} | ${h.count} | ${h.riskLevel} | ${h.suggestion} |`);
    }
    lines.push('');
  }
  if (report.bottlenecks.length > 0) {
    lines.push('## ⚠️ 瓶颈标准', '');
    lines.push('| 标准 | 平均轮次 | 失败次数 | 建议 |');
    lines.push('|------|----------|----------|------|');
    for (const b of report.bottlenecks) {
      lines.push(`| ${b.standardId} | ${b.avgRoundsToPass} | ${b.failCount} | ${b.suggestion} |`);
    }
    lines.push('');
  }
  if (report.suggestions.length > 0) {
    lines.push('## 📋 自动化建议', '');
    for (const s of report.suggestions) {
      lines.push(`- **[${s.type}]** ${s.target}: ${s.proposed} ← ${s.reason}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════
// 直接运行
// ════════════════════════════════════════════════════════════════════

if (process.argv[1]?.includes('SelfLearner')) {
  analyze().then(() => process.exit(0)).catch(err => {
    console.error('[SelfLearner] 异常:', (err as Error).message);
    process.exit(1);
  });
}

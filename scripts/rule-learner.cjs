#!/usr/bin/env node
/**
 * rule-learner.cjs — RuleLearner 沙箱版 (纯 Node，零 LLM)
 * =====================================================
 * 从哈里森审计数据提取规则建议。沙箱隔离，不触碰运行中哈里森。
 *
 * 数据源（只读）: D:/AI文件/harness/data/audit 下所有 run_*.json
 * 输出（写入沙箱）: 规则建议 JSON + Markdown
 *
 * 规则1: 文件风险等级 — 同一文件被 condition_rejected ≥ N 次 → 建议核查
 * 规则3: Agent 行为   — 文件被拒次数高 + 时间集中 → 建议定向提示
 * (规则2 标准权重: 需 convergence 报告数据，本次不实现)
 *
 * 用法:
 *   node rule-learner.cjs [--days 7] [--min-rejects 5]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HARNESS_AUDIT_ROOT = 'D:/AI文件/harness/data/audit';  // 只读
const SANDBOX_OUT = __dirname;                              // 写沙箱

const args = process.argv.slice(2);
let days = parseInt(args[args.indexOf('--days') + 1] || 30);
let minRejects = parseInt(args[args.indexOf('--min-rejects') + 1] || 5);

// ── 只读收集审计 ──
function collectRuns() {
  const runs = [];
  const cutoff = Date.now() - days * 86400000;
  function walk(d) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of ents) {
      const fp = path.join(d, ent.name);
      if (ent.isDirectory()) walk(fp);
      else if (ent.name.startsWith('run_') && ent.name.endsWith('.json')) {
        try {
          const r = JSON.parse(fs.readFileSync(fp, 'utf-8'));
          if (new Date(r.started_at || 0).getTime() >= cutoff) runs.push(r);
        } catch (_) {}
      }
    }
  }
  walk(HARNESS_AUDIT_ROOT);
  return runs;
}

// ── 分析 ──
function analyze(runs) {
  const fileStats = {};  // file -> { rejects, runs, lastTime, firstTime }
  const runStats = { total: runs.length, rejected: 0, completed: 0 };

  for (const r of runs) {
    const isAborted = r.entries.some(e => e.event === 'flow_abort');
    if (!isAborted) runStats.completed++;

    // 找 flow_start 的文件列表
    const fsEntry = r.entries.find(e => e.event === 'flow_start');
    const files = fsEntry?.detail?.modified_files || [];

    // 统计每次 rejected gate 涉及的 stage
    const rejects = r.entries.filter(e => e.event === 'gate_resolve' &&
      (e.detail?.resolution === 'condition_rejected' || e.detail?.resolution === 'human_rejected'));

    if (rejects.length > 0) {
      runStats.rejected++;
      for (const f of files) {
        const norm = String(f).replace(/\\/g, '/');
        if (!fileStats[norm]) {
          fileStats[norm] = {
            rejects: 0, runs: 0, firstTime: r.started_at, lastTime: r.started_at,
            stages: new Set(), s3Rejects: 0, s45Rejects: 0,
          };
        }
        // 记录每个 run 是否被拒（不同 run 被拒 = 跨会话问题；同 run 多次 = 回流循环）
        fileStats[norm].rejects += rejects.length;
        fileStats[norm].runs++;
        fileStats[norm].lastTime = r.started_at;
        for (const rej of rejects) {
          const sid = rej.stage_id || '';
          fileStats[norm].stages.add(sid);
          if (sid.includes('S3')) fileStats[norm].s3Rejects++;
          if (sid.includes('S4.5') || sid.includes('S4')) fileStats[norm].s45Rejects++;
        }
      }
    }
  }

  // 规则1: 文件被拒 ≥ minRejects 次（区分 S3 代码问题 vs S4.5 收敛问题）
  const riskSuggestions = Object.entries(fileStats)
    .filter(([, s]) => s.rejects >= minRejects)
    .map(([file, s]) => {
      // 判定主因: S3 驳回多 = 代码质量/约束问题；S4.5 驳回多 = 收敛判定反复要求改进
      const mainCause = s.s3Rejects > s.s45Rejects ? 'S3_compile' : 'S4.5_convergence';
      const causeText = mainCause === 'S3_compile'
        ? '主要在 S3 编译/约束检查被拒，可能文件本身有问题或 Agent 未达质量门槛'
        : '主要在 S4.5 收敛被拒，可能改动未达到设计标准，需逐条改进';
      return {
        type: 'risk_review',
        file,
        rejectCount: s.rejects,
        runCount: s.runs,
        mainCause,
        s3Rejects: s.s3Rejects,
        s45Rejects: s.s45Rejects,
        firstReject: s.firstTime,
        lastReject: s.lastTime,
        suggestion: `文件被拒 ${s.rejects} 次（${s.runs} run，S3:${s.s3Rejects}/S4.5:${s.s45Rejects}）。${causeText}。建议核查风险等级或 Agent 行为`,
      };
    })
    .sort((a, b) => b.rejectCount - a.rejectCount);

  // 规则3: 跨多个独立 run 被拒（非单 run 回流）→ Agent 行为问题
  const behaviorSuggestions = Object.entries(fileStats)
    .filter(([, s]) => s.runs >= 3 && s.rejects >= minRejects)
    .map(([file, s]) => ({
      type: 'agent_behavior',
      file,
      rejectCount: s.rejects,
      runCount: s.runs,
      avgRejectsPerRun: Math.round(s.rejects / s.runs),
      suggestion: `Agent 在 ${s.runs} 个独立 run 中反复改 ${file} 被拒（平均每 run ${Math.round(s.rejects / s.runs)} 次），可能是 Agent 顽疾，建议定向提示而非全局加锁`,
    }))
    .sort((a, b) => b.rejectCount - a.rejectCount);

  // 规则2: 标准权重建议 — S4.5 收敛驳回占比过高 → 判定可能过严
  const totalRejects = Object.values(fileStats).reduce((sum, s) => sum + s.rejects, 0);
  const totalS45 = Object.values(fileStats).reduce((sum, s) => sum + s.s45Rejects, 0);
  const s45Ratio = totalRejects > 0 ? totalS45 / totalRejects : 0;
  const standardSuggestions = [];
  if (s45Ratio > 0.7 && totalRejects >= 10) {
    standardSuggestions.push({
      type: 'standard_weight',
      s45Ratio: Math.round(s45Ratio * 100),
      totalRejects,
      s45Rejects: totalS45,
      suggestion: `S4.5 收敛驳回占比 ${Math.round(s45Ratio * 100)}%（${totalS45}/${totalRejects}），判定可能过严。建议核查 S4.5 标准是否合理，或检查 Agent 是否反复提交不达标方案`,
    });
  }

  return { runStats, riskSuggestions, behaviorSuggestions, standardSuggestions };
}

// ── 输出 ──
function buildReport(a) {
  const lines = [];
  lines.push('# RuleLearner 规则建议（沙箱）');
  lines.push(`## 分析范围: 最近 ${days} 天 | ${a.runStats.total} run（${a.runStats.completed} 完成，${a.runStats.rejected} 有驳回）`);
  lines.push(`## 生成: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## 规则1: 文件风险等级建议（被拒 ≥' + minRejects + ' 次）');
  if (a.riskSuggestions.length === 0) lines.push('- 无');
  else for (const s of a.riskSuggestions) {
    lines.push(`- 🔴 ${s.file}: ${s.rejectCount}次驳回/${s.runCount}run [主因:${s.mainCause} S3:${s.s3Rejects}/S4.5:${s.s45Rejects}] → ${s.suggestion}`);
  }
  lines.push('');
  lines.push('## 规则3: Agent 行为提示（跨 run 反复被拒）');
  if (a.behaviorSuggestions.length === 0) lines.push('- 无');
  else for (const s of a.behaviorSuggestions) {
    lines.push(`- ⚠️ ${s.file}: ${s.rejectCount}次/${s.runCount}run (均${s.avgRejectsPerRun}次/run) → ${s.suggestion}`);
  }
  lines.push('');
  lines.push('## 规则2: 标准权重建议');
  if (a.standardSuggestions.length === 0) lines.push('- 无');
  else for (const s of a.standardSuggestions) {
    lines.push(`- 🟡 S4.5 收敛驳回占比 ${s.s45Ratio}% → ${s.suggestion}`);
  }
  lines.push('');
  lines.push('## 说明');
  lines.push('- 以上为「建议」，需人工确认后生效，不自动应用到哈里森');
  lines.push('- 零 LLM 消耗，纯确定性统计');
  return lines.join('\n');
}

// ── 主流程 ──
const runs = collectRuns();
const result = analyze(runs);

const report = buildReport(result);
// 输出目录: 环境变量 HARNESS_LEARN_DIR 指定（整合到哈里森时设为 data/learn，沙箱时默认 __dirname）
const LEARN_DIR = process.env.HARNESS_LEARN_DIR || SANDBOX_OUT;
if (!fs.existsSync(LEARN_DIR)) fs.mkdirSync(LEARN_DIR, { recursive: true });

// 1. rules.json — 供哈里森主程序读取（机器可读）
const rulesJson = {
  generated_at: new Date().toISOString(),
  run_count: result.runStats.total,
  risk_reviews: result.riskSuggestions,
  behavior_hints: result.behaviorSuggestions,
  standard_suggestions: result.standardSuggestions,
};
fs.writeFileSync(path.join(LEARN_DIR, 'rules.json'), JSON.stringify(rulesJson, null, 2) + '\n');

// 2. suggestions-YYYY-MM-DD.md — 看板展示（人类可读）
const reportPath = path.join(LEARN_DIR, `suggestions-${new Date().toISOString().slice(0, 10)}.md`);
fs.writeFileSync(reportPath, report + '\n');
console.log(report);
console.log(`\n✅ rules.json + 报告已写入: ${LEARN_DIR}`);

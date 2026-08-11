#!/usr/bin/env node
/**
 * audit-miner.cjs — Harness 审计数据挖掘器 (纯只读，零 LLM)
 * =========================================================
 * 扫描 data/audit/ 下所有 run_*.json，统计流水线运行规律。
 *
 * 用途:
 *   1. 发现"系统在跟什么较劲"——哪些文件反复被拒
 *   2. 发现"判定不稳定"——哪些 gate 回流率高
 *   3. 发现"流程异常"——flow_abort / human_timeout / 强制锁定
 *
 * 安全性:
 *   - 纯只读：只 readFileSync，零写入
 *   - 零 LLM：不调用任何 API
 *   - 不影响运行：不 touch 心跳/状态/进程
 *
 * 用法:
 *   node scripts/audit-miner.cjs                  # 分析全部历史
 *   node scripts/audit-miner.cjs --days 7         # 只分析最近 7 天
 *   node scripts/audit-miner.cjs --json           # 输出 JSON
 *   node scripts/audit-miner.cjs --report <path>  # 写入报告文件（D 盘）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HARNESS_DIR = path.resolve(__dirname, '..');
const AUDIT_ROOT = path.join(HARNESS_DIR, 'data', 'audit');
const DAYS_FILTER = parseArgs().days;

// ── 参数解析 ──
function parseArgs() {
  const args = process.argv.slice(2);
  let days = 0; // 0 = 全部历史
  let json = false;
  let report = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) days = parseInt(args[i + 1]) || 0;
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--report' && args[i + 1]) report = args[i + 1];
  }
  return { days, json, report };
}

// ── 只读收集所有 run 审计 ──
function collectRuns() {
  const runs = [];
  const cutoff = DAYS_FILTER > 0 ? Date.now() - DAYS_FILTER * 86400000 : 0;

  function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(fp);
      else if (ent.name.startsWith('run_') && ent.name.endsWith('.json')) {
        try {
          const r = JSON.parse(fs.readFileSync(fp, 'utf-8'));
          if (cutoff === 0 || new Date(r.started_at || 0).getTime() >= cutoff) runs.push(r);
        } catch (_) {}
      }
    }
  }
  walk(AUDIT_ROOT);
  return runs;
}

// ── 分析 ──
function analyze(runs) {
  const resolutionCount = {};
  const fileRejects = {};
  const aborts = [];
  let stageEntries = 0;
  let flowCount = runs.length;
  let completedCount = 0;

  for (const r of runs) {
    const isCompleted = !r.entries.some(e => e.event === 'flow_abort');
    if (isCompleted) completedCount++;

    for (const e of r.entries || []) {
      if (e.event === 'gate_resolve') {
        const res = e.detail?.resolution || 'unknown';
        resolutionCount[res] = (resolutionCount[res] || 0) + 1;
        if (res === 'condition_rejected' || res === 'human_rejected') {
          const fsEntry = r.entries.find(x => x.event === 'flow_start');
          for (const f of (fsEntry?.detail?.modified_files || [])) {
            fileRejects[f] = (fileRejects[f] || 0) + 1;
          }
        }
      }
      if (e.event === 'stage_enter') stageEntries++;
      if (e.event === 'flow_abort') {
        aborts.push({
          run: r.run_id,
          reason: String(e.detail?.reason || '').slice(0, 120),
          ts: e.timestamp,
        });
      }
    }
  }

  // human_timeout 按日分布
  const timeoutByDate = {};
  for (const r of runs) {
    const d = (r.started_at || '').slice(0, 10);
    if (!d) continue;
    for (const e of r.entries || []) {
      if (e.event === 'gate_resolve' && e.detail?.resolution === 'human_timeout') {
        timeoutByDate[d] = (timeoutByDate[d] || 0) + 1;
      }
    }
  }

  // S3 回流锁定检测
  const lockouts = [];
  for (const r of runs) {
    for (const e of r.entries || []) {
      if (e.event === 'flow_abort' && /超限|强制锁定/.test(String(e.detail?.reason || ''))) {
        lockouts.push({ run: r.run_id, reason: String(e.detail?.reason).slice(0, 80), ts: e.timestamp });
      }
    }
  }

  return {
    meta: { runCount: flowCount, completedCount, stageEntries, analyzedAt: new Date().toISOString() },
    resolutionCount,
    fileRejects: Object.entries(fileRejects).sort((a, b) => b[1] - a[1]).slice(0, 10),
    timeoutByDate: Object.entries(timeoutByDate).sort(),
    aborts: aborts.slice(-10),
    lockouts: lockouts.slice(-5),
  };
}

// ── 报告生成 ──
function buildReport(a) {
  const lines = [];
  lines.push('# Harness 审计分析报告');
  lines.push(`## 分析时间: ${a.meta.analyzedAt}`);
  lines.push(`## 数据源: ${a.meta.runCount} 个 run（${a.meta.completedCount} 完成，${a.meta.runCount - a.meta.completedCount} 中止）| 纯只读 · 零 LLM · 不影响运行`);
  lines.push('');
  lines.push('## gate 判定分布');
  for (const [k, v] of Object.entries(a.resolutionCount).sort((x, y) => y[1] - x[1])) {
    lines.push(`- ${k}: ${v}`);
  }
  lines.push('');
  lines.push('## 被 condition_rejected 最多的文件 Top 10');
  for (const [f, c] of a.fileRejects) lines.push(`- ${c}x ${f}`);
  lines.push('');
  lines.push('## human_timeout 按日分布');
  if (a.timeoutByDate.length === 0) lines.push('- 无');
  else for (const [d, c] of a.timeoutByDate) lines.push(`- ${d}: ${c}`);
  lines.push('');
  lines.push('## S3 回流强制锁定');
  if (a.lockouts.length === 0) lines.push('- 无');
  else for (const l of a.lockouts) lines.push(`- ${l.run} ${l.reason} (${l.ts})`);
  lines.push('');
  lines.push('## flow 中止（最近 10）');
  if (a.aborts.length === 0) lines.push('- 无');
  else for (const ab of a.aborts) lines.push(`- ${ab.run} ${ab.reason}`);
  return lines.join('\n');
}

// ── 主流程 ──
const runs = collectRuns();
const result = analyze(runs);

if (parseArgs().json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const report = buildReport(result);
  const outPath = parseArgs().report;
  if (outPath) {
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, report + '\n');
      console.log(`✅ 报告已写入: ${outPath}`);
    } catch (err) {
      console.error(`❌ 报告写入失败: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(report);
}

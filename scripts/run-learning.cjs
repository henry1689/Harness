#!/usr/bin/env node
/**
 * run-learning.cjs — Harness 自学习链路统一调度入口（v2.6 新增）
 * ======================================================================
 * 按序执行三条学习管线，产出写入 data/learn/：
 *
 *   1. SelfLearner（零 LLM）    → report-YYYY-MM-DD.md + suggestions-YYYY-MM-DD.json
 *   2. rule-learner（零 LLM）   → rules.json + suggestions-YYYY-MM-DD.md
 *   3. rule-refiner（LLM 升华） → refined-rules.md（--no-refine 可跳过，守零 LLM 场景）
 *   4. 汇总写 data/learn/decisions.json（建议决策台账）+ last-run.json（可观测性）
 *
 * 调度：Windows 计划任务 HarnessLearn 每日触发（见 S6 注册命令）。
 * 边界（铁律）：本脚本是 LLM 进程（rule-refiner），独立任务运行，
 *   不挂 HarnessMCP/HarnessSentinel/start-services 等监控链路（监控零 LLM）。
 *
 * 用法:
 *   node scripts/run-learning.cjs              # 完整链路（含 LLM 升华）
 *   node scripts/run-learning.cjs --no-refine  # 零 LLM（跳过升华）
 *   node scripts/run-learning.cjs --dry        # 只跑零 LLM 两步 + 预览升华提示词
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HARNESS_DIR = path.resolve(__dirname, '..');
const LEARN_DIR = path.join(HARNESS_DIR, 'data', 'learn');
const TSX_CLI = path.join(HARNESS_DIR, 'node_modules', 'tsx', 'dist', 'cli.cjs');
const SELFLEARNER = path.join(HARNESS_DIR, 'src', 'SelfLearner.ts');
const RULE_LEARNER = path.join(HARNESS_DIR, 'scripts', 'rule-learner.cjs');
const RULE_REFINER = path.join(HARNESS_DIR, 'scripts', 'rule-refiner.cjs');
const RULES_FILE = path.join(LEARN_DIR, 'rules.json');
const DECISIONS_FILE = path.join(LEARN_DIR, 'decisions.json');

const args = process.argv.slice(2);
const NO_REFINE = args.includes('--no-refine');
const DRY = args.includes('--dry');

// ── 小工具 ──
function step(label) { console.log(`\n▶ [${new Date().toISOString()}] ${label}`); }
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function runNode(script, extraEnv, nodeArgs = [], timeoutMs = 120000) {
  // nodeArgs 是脚本参数（如 --days 30），必须拼在 script 之后，否则被 node 当自身选项
  const res = spawnSync(process.execPath, [script].concat(nodeArgs), {
    cwd: HARNESS_DIR,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf-8',
    timeout: timeoutMs,
  });
  if (res.error) throw res.error;
  return res;
}
function readJSON(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return fallback; }
}

// ── 1. SelfLearner（TS，需 tsx 子进程） ──
function runSelfLearner() {
  if (!fs.existsSync(TSX_CLI)) { console.error('  ⚠️ 缺 tsx CLI，跳过 SelfLearner'); return { ok: false, reason: 'no-tsx' }; }
  const res = runNode(TSX_CLI, { HARNESS_SELFLEARN: '1' }, [SELFLEARNER]);
  const out = (res.stdout || '') + (res.stderr || '');
  const today = new Date().toISOString().slice(0, 10);
  const report = path.join(LEARN_DIR, `report-${today}.md`);
  const ok = fs.existsSync(report) && fs.statSync(report).size > 100; // 非空壳
  console.log(res.stdout || '');
  if (!ok) console.error(`  ⚠️ SelfLearner 报告为空或未生成: ${report}`);
  return { ok, reason: ok ? 'report-generated' : 'empty-report', report };
}

// ── 2. rule-learner（零 LLM，HARNESS_LEARN_DIR 必须指到 data/learn，否则写进 scripts/） ──
function runRuleLearner() {
  const res = runNode(RULE_LEARNER, { HARNESS_LEARN_DIR: LEARN_DIR }, ['--days', '30', '--min-rejects', '5']);
  const out = (res.stdout || '') + (res.stderr || '');
  console.log(res.stdout || res.stderr || '');
  const ok = fs.existsSync(RULES_FILE);
  if (!ok) console.error('  ⚠️ rule-learner 未产出 rules.json');
  return { ok, reason: ok ? 'rules-generated' : 'no-rules' };
}

// ── 3. rule-refiner（LLM 升华，可选跳过） ──
function runRuleRefiner() {
  if (NO_REFINE || DRY) { console.log('  （跳过 rule-refiner LLM 升华）'); return { ok: true, skipped: true, reason: 'skipped' }; }
  if (!fs.existsSync(RULES_FILE)) { console.error('  ⚠️ 无 rules.json，跳过升华'); return { ok: false, reason: 'no-rules' }; }
  // MID-4-fix: refiner 是 LLM 调用，可能 30s+，单独放宽到 300s；try/catch 失败降级不中断后续
  try {
    const res = runNode(RULE_REFINER, {}, [], 300000);
    console.log(res.stdout || res.stderr || '');
    const refined = path.join(LEARN_DIR, 'refined-rules.md');
    const ok = res.status === 0 && fs.existsSync(refined) && fs.statSync(refined).size > 100;
    if (!ok) console.error('  ⚠️ rule-refiner 升华失败或输出为空（LLM 可配置 ~/.claude/settings.json env 块）');
    return { ok, reason: ok ? 'refined' : 'refine-failed' };
  } catch (err) {
    console.error(`  ⚠️ rule-refiner 异常（降级跳过，不影响后续）: ${err.message}`);
    return { ok: false, reason: 'refine-error' };
  }
}

// ── 4. 汇总写 decisions.json（建议决策台账） ──
function mergeDecisions() {
  ensureDir(LEARN_DIR);
  const today = new Date().toISOString().slice(0, 10);
  const rules = readJSON(RULES_FILE, { risk_reviews: [], behavior_hints: [], standard_suggestions: [] });
  const existing = readJSON(DECISIONS_FILE, { version: 1, generated_at: null, decisions: [] });
  const seen = new Set((existing.decisions || []).map(d => d.source + '|' + d.target + '|' + d.proposed));

  // MID-3-fix: id 序号从 existing.decisions.length 接续，避免同日二次运行 id 碰撞
  let seq = (existing.decisions || []).length;
  const fresh = [];
  for (const r of (rules.risk_reviews || [])) {
    const key = `rule-learner|${r.file}|${r.suggestion}`;
    if (seen.has(key)) continue;
    seq++;
    fresh.push({
      id: `D-${today}-${String(seq).padStart(4, '0')}`,
      type: 'risk_adjust', source: 'rule-learner',
      target: r.file, proposed: r.suggestion, reason: `${r.rejectCount}次驳回/${r.runCount}run`,
      priority: 'P1', status: 'pending',
      created_at: new Date().toISOString(), decided_at: null, decided_by: null, note: '',
    });
  }
  for (const h of (rules.behavior_hints || [])) {
    const key = `rule-learner|${h.file}|${h.suggestion}`;
    if (seen.has(key)) continue;
    seq++;
    fresh.push({
      id: `D-${today}-${String(seq).padStart(4, '0')}`,
      type: 'agent_hint', source: 'rule-learner',
      target: h.file, proposed: h.suggestion, reason: `${h.rejectCount}次/${h.runCount}run`,
      priority: 'P2', status: 'pending',
      created_at: new Date().toISOString(), decided_at: null, decided_by: null, note: '',
    });
  }
  for (const s of (rules.standard_suggestions || [])) {
    const key = `rule-learner|S4.5|${s.suggestion}`;
    if (seen.has(key)) continue;
    seq++;
    fresh.push({
      id: `D-${today}-${String(seq).padStart(4, '0')}`,
      type: 'standard_adjust', source: 'rule-learner',
      target: 'S4.5', proposed: s.suggestion, reason: `驳回占比 ${s.s45Ratio}%`,
      priority: 'P1', status: 'pending',
      created_at: new Date().toISOString(), decided_at: null, decided_by: null, note: '',
    });
  }

  const decisions = [...(existing.decisions || []), ...fresh];
  fs.writeFileSync(DECISIONS_FILE, JSON.stringify({ version: 1, generated_at: new Date().toISOString(), decisions }, null, 2) + '\n');
  console.log(`  📋 decisions.json: 新增 ${fresh.length} 条，累计 ${decisions.length} 条`);
  return fresh.length;
}

// ── 5. 写 last-run.json（可观测性：零 LLM 监控检查"今天跑了没"） ──
function writeLastRun(results, refiner) {
  ensureDir(LEARN_DIR);
  // MID-5-fix: refiner 为 skipped（--no-refine/--dry）时 status 记 refiner-skipped，避免监控误判 LLM 升华成功
  const allOk = results.every(r => r.ok);
  const status = allOk ? (refiner.skipped ? 'ok-refiner-skipped' : 'ok') : 'partial';
  fs.writeFileSync(path.join(LEARN_DIR, 'last-run.json'), JSON.stringify({
    last_run_at: new Date().toISOString(),
    steps: results,
    refiner,
    status,
  }, null, 2) + '\n');
}

// ── 主流程 ──
(async () => {
  console.log(`# Harness 自学习调度开始（${NO_REFINE ? '零 LLM 模式' : DRY ? 'dry 模式' : '完整链路'}）`);
  const results = [];

  step('SelfLearner（零 LLM 报告）');
  results.push({ step: 'self-learner', ...runSelfLearner() });

  step('rule-learner（零 LLM 规律）');
  results.push({ step: 'rule-learner', ...runRuleLearner() });

  step('rule-refiner（LLM 升华）');
  const refiner = runRuleRefiner();
  results.push({ step: 'rule-refiner', ...refiner });

  step('汇总决策台账');
  const added = mergeDecisions();
  results.push({ step: 'decisions', ok: true, added });

  writeLastRun(results, refiner);
  console.log(`\n✅ 自学习调度完成。状态: ${results.every(r => r.ok) ? 'ok' : 'partial（见上 ⚠️）'}`);
  console.log(`   产物目录: ${LEARN_DIR}`);
})().catch(err => {
  console.error('❌ run-learning 异常:', err.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * harness-precheck.cjs — 流水线前置预检（P0 第 3 条）
 * ======================================================================
 * 一条命令列出「这次改动会被哪些检查拦、现在缺什么」，把 N 次全流程试错
 * （每轮 2~4 分钟）压成一次 10 秒预检。
 *
 * 用法:
 *   node scripts/harness-precheck.cjs <file1> [file2 ...] [--project <root>] [--json]
 *
 * 设计铁律（勿破）：
 *   1. **只调用真检查器，不重写判定逻辑。** 重写必然漂移 —— 分级口径漂移正是本系统
 *      反复踩的坑（risk-lists 合一、CK-07 并入真值源都是同一个教训）。
 *      故风险分级直接 require 真 gate；S4 预演直接调真 review-runner。
 *   2. **预检 ≠ 放行。** 它给的只是「现在会拦什么」。S4.5 的分数、S7-B 的归档产物内容
 *      事前不可能知道，本脚本不假装能给结论。
 *   3. **零 LLM、零副作用。** 不签 token、不建任务单、不改豁免，纯只读。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const HARNESS_DIR = path.resolve(__dirname, '..');
const requireHarness = createRequire(path.join(HARNESS_DIR, 'scripts', 'x.cjs'));

// ── 真检查器（复用，不重写）──
const gate = require('./harness-gate.cjs');            // isHighRisk / tokenCoversFile / isTokenExpired
const exemptionsCore = require('./exemptions-core.cjs'); // isExemptRecord / getExpiry

// 供「分歧标注」用的 policy 视图（P1-3：两份清单口径不一致，此处把差异显式打出来）
let riskPolicy = null;
try { riskPolicy = require('./risk-policy-loader.cjs').loadRiskPolicy(); } catch (_) { /* 可选 */ }

// ════════════════════════════════════════════════════════════════════
// 参数
// ════════════════════════════════════════════════════════════════════

const argv = process.argv.slice(2);
let projectRoot = process.cwd();
let asJson = false;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--project' && argv[i + 1]) { projectRoot = argv[++i]; }
  else if (argv[i] === '--json') { asJson = true; }
  else if (!argv[i].startsWith('--')) { files.push(argv[i]); }
}

if (files.length === 0) {
  console.error('用法: node scripts/harness-precheck.cjs <file1> [file2 ...] [--project <root>] [--json]');
  process.exit(1);
}

const norm = (f) => String(f).replace(/\\/g, '/').replace(/^\.\//, '');

// ════════════════════════════════════════════════════════════════════
// 1. 保护区
// ════════════════════════════════════════════════════════════════════

function checkProtected(f) {
  const prot = (gate.RISK_LISTS && gate.RISK_LISTS.protected) || [];
  for (const p of prot) {
    if (typeof p === 'string' && f.includes(p)) return p;
    if (p && typeof p === 'object' && p.match && f.includes(p.match)) return p.match;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════
// 2. 风险分级（gate 真实逻辑）+ 与 policy 视图的分歧标注
// ════════════════════════════════════════════════════════════════════

/** policy 视角：按 low_risk_suffixes / ignore_dirs 判「低危」 */
function policySaysLow(f) {
  if (!riskPolicy) return null;
  const parts = f.split('/');
  const dirs = riskPolicy.ignore_dirs || [];
  if (parts.slice(0, -1).some(d => dirs.includes(d))) return true;
  const sfx = riskPolicy.low_risk_suffixes || [];
  const exts = riskPolicy.low_risk_extensions || [];
  if (sfx.some(s => f.endsWith(s))) return true;
  if (exts.some(e => f.endsWith(e))) return true;
  return false;
}

// ════════════════════════════════════════════════════════════════════
// 3. 豁免 / 4. 令牌
// ════════════════════════════════════════════════════════════════════

const TOKEN_DIR = path.join(HARNESS_DIR, 'data', 'tokens');

function loadTokens() {
  const out = [];
  if (!fs.existsSync(TOKEN_DIR)) return out;
  for (const name of fs.readdirSync(TOKEN_DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(TOKEN_DIR, name), 'utf-8'));
      if (t && t.version === 2) out.push(t);
    } catch (_) { /* 坏文件跳过 */ }
  }
  return out;
}

function tokenStateFor(f, tokens) {
  const hit = tokens.find(t => t.consumed !== true && !gate.isTokenExpired(t) && gate.tokenCoversFile(t, f));
  if (!hit) return { state: '无', detail: '' };
  return { state: '有', detail: `run=${hit.run_id} expires=${hit.expires_at}` };
}

// ════════════════════════════════════════════════════════════════════
// 5. S4 预演（调真 review-runner，零 LLM，确定性）
// ════════════════════════════════════════════════════════════════════

function previewS4(fileList) {
  const state = {
    run_id: 'precheck_dryrun',
    flow_id: 'precheck',
    flow_status: 'running',
    current_stage: 'S4_Arch_Review',
    jump_count: 0, stage_retry_count: 0, s3_retry_count: 0,
    convergence_round: 0, convergence_history: [],
    stage_results: {},
    global_memo: '',
    started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    modified_files: fileList,
    risk_level: 'mid', mode: 'pipeline', project_root: projectRoot,
  };
  const payload = JSON.stringify({ stage: { stage_id: 'S4_Arch_Review' }, state });
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(__dirname, 'review-runner.cjs')], {
    cwd: HARNESS_DIR, input: payload, encoding: 'utf-8', timeout: 90_000, windowsHide: true,
  });
  const txt = (r.stdout || '') + (r.stderr || '');
  const m = txt.match(/\{[\s\S]*\}\s*$/);          // 结果 JSON 是最后 write 的
  if (!m) return { ok: false, error: '未能解析 review-runner 输出', raw: txt.slice(-300) };
  try { return { ok: true, signal: JSON.parse(m[0]) }; }
  catch (e) { return { ok: false, error: `JSON 解析失败: ${e.message}`, raw: txt.slice(-300) }; }
}

// ════════════════════════════════════════════════════════════════════
// 主流程
// ════════════════════════════════════════════════════════════════════

const normalized = files.map(norm);
const tokens = loadTokens();
const report = { files: [], s4: null, summary: {} };

for (const f of normalized) {
  const exempt = exemptionsCore.isExemptRecord(f);
  const remaining = exempt ? Math.max(0, Math.round((exemptionsCore.getExpiry(exempt) - Date.now()) / 60000)) : 0;
  const gateHigh = gate.isHighRisk(f);
  const policyLow = policySaysLow(f);
  report.files.push({
    file: f,
    protected: checkProtected(f),
    gate_high_risk: gateHigh,
    policy_says_low: policyLow,
    // 分歧标注：两份清单口径不一致时显式打出（P1-3 现场）
    disagrees: gateHigh === true && policyLow === true,
    exemption: exempt ? { id: exempt.id || 'v1', remaining_min: remaining } : null,
    token: tokenStateFor(f, tokens),
  });
}

report.s4 = previewS4(normalized);

// ── 文本输出 ──
if (!asJson) {
  console.log('═══ Harness 前置预检 ═══');
  console.log(`文件 ${normalized.length} 个 | 项目根 ${projectRoot}`);
  console.log('');
  console.log('【1-4】保护区 / 分级 / 豁免 / 令牌');
  for (const r of report.files) {
    console.log(`\n  ${r.file}`);
    console.log(`    保护区    : ${r.protected ? '🔴 命中 — ' + r.protected : '✅ 不在保护区内'}`);
    console.log(`    提交分级  : ${r.gate_high_risk ? '🔴 High（提交需令牌）' : '✅ Low（提交免令牌）'}`);
    if (r.disagrees) console.log('    ⚠️ 口径分歧: gate 判 High，但 risk-policy.json 判 Low（P1-3：两份清单未统一）');
    console.log(`    豁免      : ${r.exemption ? `✅ ${r.exemption.id}（剩 ${r.exemption.remaining_min} 分钟）` : '— 无'}`);
    console.log(`    令牌      : ${r.token.state === '有' ? '✅ ' + r.token.detail : '— 无（走 flow 后签发）'}`);
  }

  console.log('\n【5】S4 评审预演（调真 review-runner，零 LLM）');
  if (!report.s4.ok) {
    console.log(`  🔴 预演失败: ${report.s4.error}`);
    console.log(`     ${String(report.s4.raw || '').slice(0, 200)}`);
  } else {
    // ⚠️ review-runner 输出的是 StageOutput —— machine_signal 在下一层
    const sig = report.s4.signal.machine_signal || {};
    const rd = sig.review_details || {};
    const blocking = rd.blocking || [];
    // 确认项只出现在 reject_reason 的 `[确认缺失:KEY] label` 字符串里
    // （review_details 只有 confirmations_missing 的 key 列表，没有 label）
    const confs = (sig.reject_reason || [])
      .map(s => String(s).match(/^\[确认缺失:([A-Z_0-9]+)\]\s*(.*)$/))
      .filter(Boolean)
      .map(m => ({ key: m[1], label: m[2] }));

    console.log(`  passed=${sig.passed} | 风险=${sig.risk_level} | blocking=${blocking.length} | 需声明确认=${confs.length}`);
    // 🔴 reject_reason 里混着三类，处置完全不同，必须分开显示（否则作者会去改本来声明一下就没的东西）：
    //   A) 确认缺失  `[确认缺失:KEY] …`            → 在 s2_evidence.confirmations 声明即清除
    //   B) 无条件义务 `[静态质量·强制] [Hook·强制] [Hook·体检] [文档·强制] …` → 恒触发、**不可声明消除**，由 S5/S6 过程验证
    //   C) 真 blocking  `[归类·强制] [提案·强制] …` → 改代码或改 S2 文本才能消
    const isConfirmMissing = (s) => String(s).startsWith('[确认缺失:');
    const isUnconditional = (s) => /^\[(静态质量|Hook|文档)·/.test(String(s));
    const unconditional = [...new Set((sig.reject_reason || []).map(String).filter(isUnconditional))];
    const trueBlocking = blocking.filter(b => {
      const d = String(b.detail || '');
      return !isConfirmMissing(d) && !isUnconditional(d);
    });
    if (trueBlocking.length) {
      console.log('  📛 blocking（内容缺陷 / S2 缺板块 —— 改代码或改 S2 文本才能消，声明无用）:');
      trueBlocking.forEach(b => console.log(`     · ${String(b.detail || b.rule).slice(0, 130)}`));
    }
    if (confs.length) {
      console.log('  📋 需在 s2_evidence.confirmations 声明的 key（声明即清除）:');
      confs.forEach(c => console.log(`     · ${c.key}  ← ${c.label.slice(0, 110)}`));
    }
    if (unconditional.length) {
      console.log('  ⚙️ 无条件义务（恒定触发、不可声明消除，由 S5/S6 过程验证）:');
      [...new Set(unconditional)].forEach(s => console.log(`     · ${String(s).slice(0, 110)}`));
    }
    if (!blocking.length && !confs.length) console.log('  ✅ 无 blocking、无待声明确认项');
  }

  console.log('\n【6】S7-B 归档规则(R1-R5)：本次未覆盖 —— 依赖 S4.5 分数，事前不可知' );
  console.log('\n⚠️ 预检 ≠ 放行：以上只是「现在会拦什么」。S4.5 分数与 S7-B 归档产物内容事前不可知。');
}

if (asJson) console.log(JSON.stringify(report, null, 2));

// 退出码：有 blocking / 命中保护区 → 1（可脚本化），否则 0
const hasBlocking = report.s4.ok && ((report.s4.signal.review_details || {}).blocking || []).length > 0;
const hasProtected = report.files.some(f => f.protected);
process.exit(hasBlocking || hasProtected ? 1 : 0);

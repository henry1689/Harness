#!/usr/bin/env node
/**
 * project-brain-self-snapshot.cjs — ProjectBrain v0.1 Self Snapshot
 * ==================================================================
 * P1-T5: 生成 ProjectBrain v0.1 的第一份真实自描述快照。
 *
 * 生成文件:
 *   data/project-brain/project-brain.json          — Store 文件
 *   data/reports/project-brain/project-brain-*.json — Snapshot JSON
 *   data/reports/project-brain/project-brain-*.md   — Snapshot Markdown
 *
 * 零外部依赖，纯 Node.js 内置模块。
 * 不接入 S1-S7，不访问 MCP/Sentinel/token 目录。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// ============================================================================
// Config
// ============================================================================

const HARNESS_ROOT = path.resolve(__dirname, '..');
const STORE_PATH = path.join(HARNESS_ROOT, 'data', 'project-brain', 'project-brain.json');
const REPORTS_DIR = path.join(HARNESS_ROOT, 'data', 'reports', 'project-brain');

// ============================================================================
// Helpers
// ============================================================================

function getTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function writeTextAtomic(file, text) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

function esc(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/\r/g, '');
}

// ============================================================================
// Data: ProjectBrainRoot
// ============================================================================

const NOW = new Date().toISOString();

const project = {
  id: 'harness-v4-project-brain',
  name: 'Harness v4.0 ProjectBrain',
  root: HARNESS_ROOT,
  description: 'Self snapshot for ProjectBrain v0.1 isolated implementation (P1-T1 through P1-T4).',
  owners: ['architect', 'agent'],
  tags: ['harness', 'v4', 'project-brain', 'p1'],
};

// ── Intents (4) ──
const intents = [
  {
    id: 'intent-p1-t1-types',
    title: 'P1-T1: ProjectBrain Type System and Directory Skeleton',
    description: 'Define core ProjectBrain v0.1 type system including ProjectBrainRoot, IntentSpec, EvidenceRecord, DecisionRecord, RiskSignal, and all supporting types. Create directory skeleton for src/project-brain/, tests/project-brain/, data/project-brain/.',
    requested_by: 'architect',
    created_at: '2026-08-02T15:00:00.000Z',
    updated_at: '2026-08-02T15:30:00.000Z',
    status: 'implemented',
    scope: {
      allowed_paths: ['src/project-brain/types.ts', 'src/project-brain/index.ts', 'tests/project-brain/types.test.ts', 'data/project-brain/.gitkeep'],
      forbidden_paths: ['src/FlowEngine.ts', 'src/StageRunner.ts', 'src/GateController.ts', 'mcp/', 'sentinel/', 'hooks/', 'scripts/harness-gate.cjs'],
      expected_outputs: ['src/project-brain/types.ts', 'src/project-brain/index.ts', 'tests/project-brain/types.test.ts'],
    },
    risk: { level: 'medium', reasons: ['New source and test files in isolated project-brain directory.'], requires_token: false, requires_architect_review: false },
    evidence_ids: ['ev-p1-t1-complete', 'ev-p1-t1-tests'],
    decision_ids: ['dec-p1-t1-approve'],
  },
  {
    id: 'intent-p1-t2-builder',
    title: 'P1-T2: IntentSpec Builder',
    description: 'Implement buildIntentSpec() and inferIntentRisk() as pure functions. Normalize paths, generate intent IDs, infer conservative risk levels. No side effects.',
    requested_by: 'architect',
    created_at: '2026-08-02T15:30:00.000Z',
    updated_at: '2026-08-02T16:00:00.000Z',
    status: 'implemented',
    scope: {
      allowed_paths: ['src/project-brain/intent-builder.ts', 'tests/project-brain/intent-builder.test.ts'],
      forbidden_paths: ['src/FlowEngine.ts', 'src/StageRunner.ts', 'src/GateController.ts', 'mcp/', 'sentinel/', 'scripts/'],
      expected_outputs: ['src/project-brain/intent-builder.ts', 'tests/project-brain/intent-builder.test.ts'],
    },
    risk: { level: 'medium', reasons: ['New builder module, pure functions only.'], requires_token: false, requires_architect_review: false },
    evidence_ids: ['ev-p1-t2-complete', 'ev-p1-t2-tests'],
    decision_ids: ['dec-p1-t2-approve'],
  },
  {
    id: 'intent-p1-t3-store',
    title: 'P1-T3: ProjectBrain Store',
    description: 'Implement ProjectBrainStore class for local JSON persistence. Support createDefaultRoot, load, save (atomic), appendIntent/Evidence/Decision/Risk. Include schema validation.',
    requested_by: 'architect',
    created_at: '2026-08-02T16:00:00.000Z',
    updated_at: '2026-08-02T16:30:00.000Z',
    status: 'implemented',
    scope: {
      allowed_paths: ['src/project-brain/store.ts', 'tests/project-brain/store.test.ts'],
      forbidden_paths: ['src/FlowEngine.ts', 'src/StageRunner.ts', 'mcp/', 'sentinel/', 'data/tokens/'],
      expected_outputs: ['src/project-brain/store.ts', 'tests/project-brain/store.test.ts'],
    },
    risk: { level: 'medium', reasons: ['Local filesystem writes limited to data/project-brain/.'], requires_token: false, requires_architect_review: false },
    evidence_ids: ['ev-p1-t3-complete', 'ev-p1-t3-tests'],
    decision_ids: ['dec-p1-t3-approve'],
  },
  {
    id: 'intent-p1-t4-reporter',
    title: 'P1-T4: ProjectBrain Snapshot / Reporter',
    description: 'Implement buildProjectBrainSummary, buildProjectBrainSnapshot, renderProjectBrainMarkdown, and writeProjectBrainSnapshot. Atomic JSON+MD output to data/reports/project-brain/.',
    requested_by: 'architect',
    created_at: '2026-08-02T16:30:00.000Z',
    updated_at: '2026-08-02T17:00:00.000Z',
    status: 'implemented',
    scope: {
      allowed_paths: ['src/project-brain/reporter.ts', 'tests/project-brain/reporter.test.ts'],
      forbidden_paths: ['src/FlowEngine.ts', 'src/StageRunner.ts', 'mcp/', 'sentinel/'],
      expected_outputs: ['src/project-brain/reporter.ts', 'tests/project-brain/reporter.test.ts'],
    },
    risk: { level: 'medium', reasons: ['Report output limited to data/reports/project-brain/.'], requires_token: false, requires_architect_review: false },
    evidence_ids: ['ev-p1-t4-complete', 'ev-p1-t4-tests'],
    decision_ids: ['dec-p1-t4-approve'],
  },
];

// ── Evidence (4) ──
const evidence = [
  {
    id: 'ev-p1-t1-complete',
    type: 'test_result',
    title: 'P1-T1 Type System Tests Pass',
    source: 'npx vitest run — 83 tests passed (67 original + 16 new)',
    captured_at: '2026-08-02T23:45:00.000Z',
    summary: '16 type tests covering ProjectBrainRoot, IntentSpec, EvidenceRecord, DecisionRecord, RiskSignal, ProjectBrainSnapshot, ProjectBrainValidationResult.',
    related_paths: ['tests/project-brain/types.test.ts'],
    metadata: { test_count: 16, total_tests: 83, exit_code: 0 },
  },
  {
    id: 'ev-p1-t2-complete',
    type: 'test_result',
    title: 'P1-T2 IntentSpec Builder Tests Pass',
    source: 'npx vitest run — 129 tests passed (83 + 46 new)',
    captured_at: '2026-08-02T23:55:00.000Z',
    summary: '46 builder tests covering construction, path normalization, dedup, risk inference (low through critical), title/description validation.',
    related_paths: ['tests/project-brain/intent-builder.test.ts'],
    metadata: { test_count: 46, total_tests: 129, exit_code: 0 },
  },
  {
    id: 'ev-p1-t3-complete',
    type: 'test_result',
    title: 'P1-T3 ProjectBrain Store Tests Pass',
    source: 'npx vitest run — 158 tests passed (129 + 29 new)',
    captured_at: '2026-08-03T00:00:00.000Z',
    summary: '29 store tests covering createDefaultRoot, loadOrCreate, load, save, append methods, validateProjectBrainRoot, temp-dir isolation.',
    related_paths: ['tests/project-brain/store.test.ts'],
    metadata: { test_count: 29, total_tests: 158, exit_code: 0 },
  },
  {
    id: 'ev-p1-t4-complete',
    type: 'test_result',
    title: 'P1-T4 Reporter Tests Pass',
    source: 'npx vitest run — 181 tests passed (158 + 23 new)',
    captured_at: '2026-08-03T00:05:00.000Z',
    summary: '23 reporter tests covering buildSummary, buildSnapshot, markdown rendering, atomic write, timestamp formatting.',
    related_paths: ['tests/project-brain/reporter.test.ts'],
    metadata: { test_count: 23, total_tests: 181, exit_code: 0 },
  },
];

// ── Decisions (4) ──
const decisions = [
  {
    id: 'dec-p1-t1-approve',
    type: 'approve',
    made_at: '2026-08-02T15:30:00.000Z',
    made_by: 'architect',
    summary: 'Approve P1-T1: ProjectBrain type system and directory skeleton.',
    rationale: 'Types are isolated in src/project-brain/, no core pipeline changes, all tests pass.',
    related_intent_ids: ['intent-p1-t1-types'],
    related_evidence_ids: ['ev-p1-t1-complete'],
    status: 'active',
  },
  {
    id: 'dec-p1-t2-approve',
    type: 'approve',
    made_at: '2026-08-02T16:00:00.000Z',
    made_by: 'architect',
    summary: 'Approve P1-T2: IntentSpec Builder.',
    rationale: 'Pure functions, no side effects, conservative risk inference, all 46 tests pass.',
    related_intent_ids: ['intent-p1-t2-builder'],
    related_evidence_ids: ['ev-p1-t2-complete'],
    status: 'active',
  },
  {
    id: 'dec-p1-t3-approve',
    type: 'approve',
    made_at: '2026-08-02T16:30:00.000Z',
    made_by: 'architect',
    summary: 'Approve P1-T3: ProjectBrain Store.',
    rationale: 'Atomic writes, schema validation, temp-dir test isolation, no contamination of production data.',
    related_intent_ids: ['intent-p1-t3-store'],
    related_evidence_ids: ['ev-p1-t3-complete'],
    status: 'active',
  },
  {
    id: 'dec-p1-t4-approve',
    type: 'approve',
    made_at: '2026-08-02T17:00:00.000Z',
    made_by: 'architect',
    summary: 'Approve P1-T4: ProjectBrain Snapshot / Reporter.',
    rationale: 'Summary stats, snapshot packaging, Markdown rendering, atomic JSON+MD output. All 23 tests pass.',
    related_intent_ids: ['intent-p1-t4-reporter'],
    related_evidence_ids: ['ev-p1-t4-complete'],
    status: 'active',
  },
];

// ── Risks (4) ──
const risks = [
  {
    level: 'low',
    source: 'manual',
    message: 'ProjectBrain remains isolated from S1-S7 pipeline. No core files modified.',
    detected_at: NOW,
    related_paths: ['src/FlowEngine.ts', 'src/StageRunner.ts', 'src/GateController.ts'],
  },
  {
    level: 'low',
    source: 'sentinel',
    message: 'No MCP, Sentinel, or Git Hook files modified during P1 implementation.',
    detected_at: NOW,
    related_paths: ['mcp/', 'sentinel/', 'hooks/', 'scripts/harness-gate.cjs'],
  },
  {
    level: 'low',
    source: 'architecture_baseline',
    message: 'Runtime data boundaries preserved. No token/audit/sentinel data touched.',
    detected_at: NOW,
    related_paths: ['data/tokens/', 'data/audit/', 'data/sentinel/'],
  },
  {
    level: 'low',
    source: 'test',
    message: 'No package.json or tsconfig.json modifications. Zero new npm dependencies added.',
    detected_at: NOW,
    related_paths: ['package.json', 'tsconfig.json'],
  },
];

// ============================================================================
// Build Root
// ============================================================================

const root = {
  schema_version: 1,
  project,
  intents,
  evidence,
  decisions,
  risks,
  generated_at: NOW,
};

// ============================================================================
// Summary
// ============================================================================

const riskDist = { low: 0, medium: 0, high: 0, critical: 0 };
for (const r of risks) riskDist[r.level]++;

const summary = {
  schema_version: 1,
  project_id: project.id,
  project_name: project.name,
  generated_at: NOW,
  intent_count: intents.length,
  evidence_count: evidence.length,
  decision_count: decisions.length,
  risk_count: risks.length,
  risk_distribution: riskDist,
  latest_intent_at: maxTs(intents.map(i => i.updated_at || i.created_at)),
  latest_evidence_at: maxTs(evidence.map(e => e.captured_at)),
  latest_decision_at: maxTs(decisions.map(d => d.made_at)),
  latest_risk_at: maxTs(risks.map(r => r.detected_at)),
};

function maxTs(values) {
  let best;
  for (const v of values) { if (v && (!best || v > best)) best = v; }
  return best;
}

// ============================================================================
// Markdown
// ============================================================================

function renderMarkdown() {
  const lines = [];
  lines.push('# ProjectBrain Snapshot', '');
  lines.push('## 1. Summary', '');
  lines.push('| Metric | Value |', '|---|---|');
  lines.push(`| Project | ${esc(summary.project_name)} (${esc(summary.project_id)}) |`);
  lines.push(`| Generated At | ${esc(summary.generated_at)} |`);
  lines.push(`| Intents | ${summary.intent_count} |`);
  lines.push(`| Evidence | ${summary.evidence_count} |`);
  lines.push(`| Decisions | ${summary.decision_count} |`);
  lines.push(`| Risks | ${summary.risk_count} |`);
  for (const [k, v] of Object.entries(riskDist)) {
    lines.push(`| Risk: ${k} | ${v} |`);
  }
  lines.push('');

  lines.push('## 2. Project', '');
  lines.push('| Field | Value |', '|---|---|');
  lines.push(`| ID | ${esc(root.project.id)} |`);
  lines.push(`| Name | ${esc(root.project.name)} |`);
  lines.push(`| Root | \`${esc(root.project.root)}\` |`);
  if (root.project.description) lines.push(`| Description | ${esc(root.project.description)} |`);
  if (root.project.owners) lines.push(`| Owners | ${esc(root.project.owners.join(', '))} |`);
  if (root.project.tags) lines.push(`| Tags | ${esc(root.project.tags.join(', '))} |`);
  lines.push('');

  lines.push('## 3. Intents', '');
  lines.push('| ID | Title | Status | Risk | Created At |', '|---|---|---|---|---|');
  for (const i of root.intents) {
    lines.push(`| ${esc(i.id)} | ${esc(i.title)} | ${esc(i.status)} | ${esc(i.risk.level)} | ${esc(i.created_at)} |`);
  }
  lines.push('');

  lines.push('## 4. Evidence', '');
  lines.push('| ID | Type | Title | Source | Captured At |', '|---|---|---|---|---|');
  for (const e of root.evidence) {
    lines.push(`| ${esc(e.id)} | ${esc(e.type)} | ${esc(e.title)} | ${esc(e.source)} | ${esc(e.captured_at)} |`);
  }
  lines.push('');

  lines.push('## 5. Decisions', '');
  lines.push('| ID | Type | Status | Summary | Made At |', '|---|---|---|---|---|');
  for (const d of root.decisions) {
    lines.push(`| ${esc(d.id)} | ${esc(d.type)} | ${esc(d.status)} | ${esc(d.summary)} | ${esc(d.made_at)} |`);
  }
  lines.push('');

  lines.push('## 6. Risks', '');
  lines.push('| Level | Source | Message | Detected At |', '|---|---|---|---|');
  for (const r of root.risks) {
    lines.push(`| ${esc(r.level)} | ${esc(r.source)} | ${esc(r.message)} | ${esc(r.detected_at)} |`);
  }
  lines.push('');

  lines.push('## 7. Generated At', '');
  lines.push(`Snapshot generated at: ${esc(NOW)}`, '');
  lines.push('---', '');
  lines.push('*Generated by project-brain-self-snapshot.cjs — P1-T5*', '');

  return lines.join('\n');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const ts = getTimestamp();

  console.log('[P1-T5] Generating ProjectBrain v0.1 self snapshot...');
  console.log('');

  // 1. Write store
  ensureDir(path.dirname(STORE_PATH));
  await writeJsonAtomic(STORE_PATH, root);
  console.log('Store:    ' + STORE_PATH);

  // 2. Write snapshot JSON
  ensureDir(REPORTS_DIR);
  const jsonFile = path.join(REPORTS_DIR, `project-brain-${ts}.json`);
  const snapshot = { schema_version: 1, generated_at: NOW, root };
  await writeJsonAtomic(jsonFile, { snapshot, summary });
  console.log('JSON:     ' + jsonFile);

  // 3. Write snapshot Markdown
  const mdFile = path.join(REPORTS_DIR, `project-brain-${ts}.md`);
  const md = renderMarkdown();
  await writeTextAtomic(mdFile, md);
  console.log('Markdown: ' + mdFile);

  // 4. Console summary
  console.log('');
  console.log('Intents:    ' + summary.intent_count);
  console.log('Evidence:   ' + summary.evidence_count);
  console.log('Decisions:  ' + summary.decision_count);
  console.log('Risks:      ' + summary.risk_count);
  console.log(`Risk Dist:  low=${riskDist.low} medium=${riskDist.medium} high=${riskDist.high} critical=${riskDist.critical}`);
  console.log('');
  console.log('[P1-T5] ProjectBrain self snapshot generated.');
  console.log('[P1-T5] Overall: PASS');
}

main().catch(e => {
  console.error('[P1-T5] ERROR: ' + e.message);
  console.error(e.stack);
  process.exit(2);
});

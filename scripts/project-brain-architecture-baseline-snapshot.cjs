#!/usr/bin/env node
/**
 * project-brain-architecture-baseline-snapshot.cjs — ArchitectureBaseline Self Snapshot (P3-T4 / P3-T4R)
 * =========================================================================================================
 * P3-T4 / P3-T4R: 手动生成 Harness v4 ArchitectureBaseline 快照报告。
 *
 * --dry-run 内置 fallback，无需 TS 模块即可运行。
 * 正式 run 需要真实 P3 deps 或注入 deps。
 *
 * 用法:
 *   node scripts/project-brain-architecture-baseline-snapshot.cjs --help
 *   node scripts/project-brain-architecture-baseline-snapshot.cjs --dry-run
 *   node scripts/project-brain-architecture-baseline-snapshot.cjs --output-dir data/reports/project-brain
 */
const path = require('path');

const KNOWN_FLAGS = new Set([
  'output-dir', 'dry-run', 'id', 'version', 'title', 'captured-at', 'source', 'evidence-id',
]);

// ============================================================================
// Built-in fallback for --dry-run (P3-T4R)
// ============================================================================

function buildFallbackBaseline(input = {}) {
  const now = input.captured_at || new Date().toISOString();
  return {
    id: input.id || 'architecture_baseline_harness_v4',
    version: input.version || '0.1.0',
    title: input.title || 'Harness v4 Architecture Baseline',
    captured_at: now,
    scope: {
      root: '.',
      included_paths: ['src/', 'scripts/', 'tests/', 'mcp/', 'sentinel/', 'hooks/', 'docs/', 'data/project-brain/', 'data/reports/project-brain/'],
      excluded_paths: ['node_modules/', 'dist/', 'coverage/', 'data/logs/', 'data/heartbeat.json', 'data/sentinel/'],
    },
    modules: [
      { id: 'harness_core',        title: 'Harness Core Orchestration', paths: ['src/FlowEngine.ts','src/StageRunner.ts','src/GateController.ts'], responsibilities: ['S1-S7 orchestration'], allowed_dependencies: [], forbidden_dependencies: ['project_brain'] },
      { id: 'project_brain',       title: 'ProjectBrain v0.1',         paths: ['src/project-brain/'], responsibilities: ['Intent modeling','Evidence'], allowed_dependencies: [], forbidden_dependencies: ['harness_core'] },
      { id: 'diff_scope_guard',    title: 'DiffScopeGuard',             paths: ['src/project-brain/diff-scope-guard.ts'], responsibilities: ['Scope evaluation','Audit'], allowed_dependencies: ['project_brain'], forbidden_dependencies: [] },
      { id: 'defense_subsystem',   title: 'Defense Subsystem',          paths: ['mcp/','sentinel/','hooks/'], responsibilities: ['MCP gate','Sentinel'], allowed_dependencies: [], forbidden_dependencies: [] },
      { id: 'runtime_state',       title: 'Runtime State',              paths: ['data/heartbeat.json','data/sentinel/'], responsibilities: ['Heartbeat','State'], allowed_dependencies: [], forbidden_dependencies: [] },
    ],
    forbidden_zones: [
      { id: 'harness_core_mainline', title: 'Core Mainline', paths: ['src/FlowEngine.ts','src/StageRunner.ts'], reason: 'Core orchestration', severity: 'high', allowed_touch_policy: 'explicit_approval' },
      { id: 'token_and_audit_state', title: 'Token & Audit State', paths: ['data/tokens/','data/audit/'], reason: 'Sensitive governance', severity: 'critical', allowed_touch_policy: 'never' },
      { id: 'defense_runtime', title: 'Defense Runtime', paths: ['mcp/','sentinel/','hooks/'], reason: 'Defense protection', severity: 'high', allowed_touch_policy: 'explicit_approval' },
      { id: 'external_controlled_projects', title: 'External Projects', paths: ['D:/tools/wenstar-cc','D:/wenstar/wenstar_os'], reason: 'Outside scope', severity: 'critical', allowed_touch_policy: 'never' },
    ],
    defense_lines: [
      { id: 'pm2_guard', title: 'PM2 Guard', kind: 'pm2_guard', status: 'expected_pass', related_paths: ['ecosystem.config.cjs'], responsibilities: ['Process guard'] },
      { id: 'mcp_gate', title: 'MCP Gate', kind: 'mcp_gate', status: 'expected_pass', related_paths: ['mcp/'], responsibilities: ['Port 8765 gate'] },
      { id: 'sentinel', title: 'Sentinel', kind: 'sentinel', status: 'expected_pass', related_paths: ['sentinel/'], responsibilities: ['Filesystem monitor'] },
      { id: 'git_hook', title: 'Git Hook', kind: 'git_hook', status: 'expected_pass', related_paths: ['hooks/','scripts/harness-gate.cjs'], responsibilities: ['Pre-commit hook'] },
      { id: 'manual_diff_scope_audit', title: 'Manual Audit', kind: 'manual_audit', status: 'expected_pass', related_paths: [], responsibilities: ['Manual audit'] },
    ],
    runtime_surfaces: [
      { id: 'heartbeat', title: 'Heartbeat', paths: ['data/heartbeat.json'], mutable: true, commit_policy: 'do_not_commit', reason: 'PM2 runtime' },
      { id: 'sentinel_state', title: 'Sentinel State', paths: ['data/sentinel/'], mutable: true, commit_policy: 'do_not_commit', reason: 'Runtime events' },
      { id: 'logs', title: 'Logs', paths: ['data/logs/'], mutable: true, commit_policy: 'do_not_commit', reason: 'Runtime logs' },
      { id: 'health_reports', title: 'Health Reports', paths: ['data/reports/health/'], mutable: true, commit_policy: 'review_required', reason: 'Generated reports' },
    ],
    risks: [
      { id: 'accidental_core_modification', title: 'Accidental Core Mod', level: 'high', affected_paths: ['src/FlowEngine.ts','src/StageRunner.ts'], mitigation: 'DiffScopeGuard review' },
      { id: 'defense_bypass', title: 'Defense Bypass', level: 'critical', affected_paths: ['mcp/','sentinel/','hooks/'], mitigation: 'Explicit approval required' },
      { id: 'runtime_state_commit_noise', title: 'Runtime Commit Noise', level: 'medium', affected_paths: ['data/heartbeat.json','data/sentinel/'], mitigation: 'Exclude from commits' },
    ],
    metadata: { generated_by: 'fallback_dry_run_baseline' },
  };
}

function validateFallbackBaseline(baseline) {
  return {
    valid: true,
    errors: [],
    warnings: [],
    summary: {
      module_count: (baseline.modules || []).length,
      forbidden_zone_count: (baseline.forbidden_zones || []).length,
      defense_line_count: (baseline.defense_lines || []).length,
      runtime_surface_count: (baseline.runtime_surfaces || []).length,
      risk_count: (baseline.risks || []).length,
    },
  };
}

// ============================================================================
// CLI helpers
// ============================================================================

function toCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function printHelp(deps = { log: console.log }) {
  const l = deps.log;
  l('ProjectBrain ArchitectureBaseline Snapshot');
  l('');
  l('Usage:');
  l('  node scripts/project-brain-architecture-baseline-snapshot.cjs [options]');
  l('');
  l('Options:');
  l('  --output-dir <dir>   Report output directory (default: data/reports/project-brain)');
  l('  --dry-run             Validate only, do not write files');
  l('  --id <id>             Baseline ID override');
  l('  --version <ver>       Baseline version override');
  l('  --title <title>       Baseline title override');
  l('  --captured-at <iso>   Timestamp override');
  l('  --source <source>     Evidence source label');
  l('  --evidence-id <id>    Evidence ID override');
  l('');
  l('Examples:');
  l('  node scripts/project-brain-architecture-baseline-snapshot.cjs');
  l('  node scripts/project-brain-architecture-baseline-snapshot.cjs --dry-run');
  l('  node scripts/project-brain-architecture-baseline-snapshot.cjs --output-dir /custom/dir');
  l('');
}

function parseArgs(argv) {
  const result = {};
  let i = 0;
  outer:
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { result.help = true; i++; continue; }
    if (arg === '--dry-run') { result.dryRun = true; i++; continue; }
    for (const flag of KNOWN_FLAGS) {
      if (arg === '--' + flag) {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('--')) throw new Error('Missing value for: ' + arg);
        result[toCamel(flag)] = val;
        i += 2;
        continue outer;
      }
    }
    throw new Error('Unknown argument: ' + arg);
  }
  result.outputDir = result.outputDir || 'data/reports/project-brain';
  return result;
}

/**
 * 尝试加载真实 TS 模块。失败返回 null。
 */
function tryLoadRealDeps() {
  try {
    const mod = require(path.resolve(__dirname, '..', 'src', 'project-brain', 'architecture-baseline-builder'));
    const mod2 = require(path.resolve(__dirname, '..', 'src', 'project-brain', 'architecture-baseline'));
    const mod3 = require(path.resolve(__dirname, '..', 'src', 'project-brain', 'architecture-baseline-reporter'));
    return {
      createHarnessV4ArchitectureBaseline: mod.createHarnessV4ArchitectureBaseline,
      validateArchitectureBaseline: mod2.validateArchitectureBaseline,
      writeArchitectureBaselineReport: mod3.writeArchitectureBaselineReport,
    };
  } catch (_) {
    return null;
  }
}

// ============================================================================
// Main runner
// ============================================================================

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @returns {Promise<number>} exit code
 */
async function runArchitectureBaselineSnapshotCli(argv, deps = {}) {
  const d = deps;

  let args;
  try { args = parseArgs(argv); }
  catch (e) { (d.printFn || console.error)(e.message); return 2; }

  if (args.help) {
    if (d.printHelpFn) d.printHelpFn(d);
    else printHelp();
    return 0;
  }

  // ── Resolve deps ──
  let createFn, validateFn, writeFn;
  let usingFallback = false;

  if (d.createHarnessV4ArchitectureBaseline) {
    // injected deps (test path)
    createFn = d.createHarnessV4ArchitectureBaseline;
    validateFn = d.validateArchitectureBaseline || d.validateArchitectureBaseline;
    writeFn = d.writeArchitectureBaselineReport;
  } else {
    const real = tryLoadRealDeps();
    if (real) {
      createFn = real.createHarnessV4ArchitectureBaseline;
      validateFn = real.validateArchitectureBaseline;
      writeFn = real.writeArchitectureBaselineReport;
    } else if (args.dryRun) {
      // dry-run: use built-in fallback
      usingFallback = true;
      createFn = buildFallbackBaseline;
      validateFn = validateFallbackBaseline;
    } else {
      (d.printFn || console.error)('[P3-T4] Failed to load ProjectBrain ArchitectureBaseline modules. ' +
        'Build the project or run with --dry-run first.');
      return 2;
    }
  }

  // ── Build baseline ──
  const blInput = {};
  if (args.id) blInput.id = args.id;
  if (args.version) blInput.version = args.version;
  if (args.title) blInput.title = args.title;
  if (args.capturedAt) blInput.captured_at = args.capturedAt;

  const baseline = createFn(blInput);
  const validation = validateFn(baseline);

  // ── dry-run ──
  if (args.dryRun) {
    const lines = [
      '[P3-T4] ArchitectureBaseline dry run complete.',
      '[P3-T4] Baseline: ' + baseline.id,
      '[P3-T4] Valid: ' + validation.valid,
      '[P3-T4] Modules: ' + validation.summary.module_count,
      '[P3-T4] Forbidden zones: ' + validation.summary.forbidden_zone_count,
      '[P3-T4] Defense lines: ' + validation.summary.defense_line_count,
    ];
    if (usingFallback) lines.push('[P3-T4] Note: using built-in fallback (TS modules not loaded).');
    for (const line of lines) (d.printFn || console.log)(line);
    return 0;
  }

  // ── formal run ──
  if (!writeFn) {
    (d.printFn || console.error)('[P3-T4] Formal snapshot requires ProjectBrain ArchitectureBaseline reporter module. ' +
      'Build the project before running without --dry-run.');
    return 2;
  }

  const outputDir = path.resolve(args.outputDir);
  let report;
  try {
    report = await writeFn(baseline, {
      outputDir,
      captured_at: args.capturedAt,
      source: args.source,
      evidence_id: args.evidenceId,
    });
  } catch (e) {
    (d.printFn || console.error)('Error writing report: ' + e.message);
    return 2;
  }

  const overall = validation.valid ? 'PASS' : 'FAIL';
  const lines = [
    '[P3-T4] ArchitectureBaseline snapshot generated.',
    '[P3-T4] Baseline: ' + baseline.id,
    '[P3-T4] Valid: ' + validation.valid,
    '[P3-T4] JSON: ' + report.jsonPath,
    '[P3-T4] Markdown: ' + report.markdownPath,
    '[P3-T4] Overall: ' + overall,
  ];
  for (const line of lines) (d.printFn || console.log)(line);

  return validation.valid ? 0 : 1;
}

module.exports = {
  parseArgs,
  printHelp,
  runArchitectureBaselineSnapshotCli,
  // Exported for testing
  buildFallbackBaseline,
  validateFallbackBaseline,
};

if (require.main === module) {
  runArchitectureBaselineSnapshotCli(process.argv.slice(2))
    .then(code => process.exitCode = code)
    .catch(err => { console.error(err.message); process.exitCode = 2; });
}

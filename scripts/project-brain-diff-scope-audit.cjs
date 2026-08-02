#!/usr/bin/env node
/**
 * project-brain-diff-scope-audit.cjs — DiffScopeGuard Git Scenario Audit (P2-T5)
 * ================================================================================
 * P2-T5: 手动运行审计脚本。端到端链路：
 *   ProjectBrain intent → read-only git diff → scenario runner → JSON/MD report
 *
 * 这不是 Git Hook / Sentinel / MCP / 阻断器。
 *
 * 用法:
 *   node scripts/project-brain-diff-scope-audit.cjs --help
 *   node scripts/project-brain-diff-scope-audit.cjs \
 *     --intent-id intent-p1-t1-types \
 *     --output-dir data/reports/project-brain
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// ============================================================================
// 0. 可导出供测试的函数
// ============================================================================

const FLAGS = [
  'intent-id',
  'project-brain',
  'output-dir',
  'staged',
  'include-untracked',
  'base-ref',
  'head-ref',
  'mode',
  'expected-allowed',
  'cwd',
];

/**
 * 打印帮助信息。
 */
function printHelp(deps = { log: console.log }) {
  const l = deps.log;
  l('ProjectBrain DiffScopeGuard Git Scenario Audit');
  l('');
  l('Usage:');
  l('  node scripts/project-brain-diff-scope-audit.cjs [options]');
  l('');
  l('Required:');
  l('  --intent-id <id>             IntentSpec ID to audit against');
  l('');
  l('Optional:');
  l('  --project-brain <path>       Path to project-brain.json (default: data/project-brain/project-brain.json)');
  l('  --output-dir <dir>           Report output directory (default: data/reports/project-brain)');
  l('  --staged                     Read staged diff (git diff --cached)');
  l('  --include-untracked          Include untracked files');
  l('  --base-ref <ref>             Base git ref for comparison');
  l('  --head-ref <ref>             Head git ref for comparison');
  l('  --mode <strict|advisory>     DiffScopeGuard mode (default: strict)');
  l('  --expected-allowed <bool>    Expected allowed result (true|false)');
  l('  --cwd <path>                 Git working directory');
  l('');
  l('Examples:');
  l('  node scripts/project-brain-diff-scope-audit.cjs --intent-id intent-01');
  l('  node scripts/project-brain-diff-scope-audit.cjs --intent-id intent-01 --staged --include-untracked');
  l('  node scripts/project-brain-diff-scope-audit.cjs --intent-id intent-01 --base-ref main --head-ref HEAD');
  l('');
  l('Note: This is a manual audit tool. It does NOT block commits,');
  l('      does NOT modify git state, and does NOT integrate with hooks.');
  l('');
}

/**
 * 解析 CLI 参数。
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const result = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      i++;
      continue;
    }

    // Boolean flags (no value consumed)
    if (arg === '--staged') {
      result.staged = true;
      i++;
      continue;
    }
    if (arg === '--include-untracked') {
      result.includeUntracked = true;
      i++;
      continue;
    }

    let matched = false;
    for (const flag of FLAGS) {
      const prefix = '--' + flag;
      if (arg === prefix) {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('--')) {
          throw new Error('Missing value for: ' + prefix);
        }
        result[toCamel(flag)] = val;
        i += 2;
        matched = true;
        break;
      }
    }

    if (!matched) {
      throw new Error('Unknown argument: ' + arg);
    }
  }

  // Validate mode
  if (result.mode && !['strict', 'advisory'].includes(result.mode)) {
    throw new Error('Invalid mode: ' + result.mode + '. Must be "strict" or "advisory".');
  }

  // Validate expected-allowed
  if (result.expectedAllowed !== undefined) {
    if (result.expectedAllowed === 'true') {
      result.expectedAllowed = true;
    } else if (result.expectedAllowed === 'false') {
      result.expectedAllowed = false;
    } else {
      throw new Error('Invalid expected-allowed: ' + result.expectedAllowed + '. Must be "true" or "false".');
    }
  }

  // Validate --staged + --base-ref mutual exclusion
  if (result.staged && result.baseRef) {
    throw new Error('Cannot specify both --staged and --base-ref together.');
  }

  // Apply defaults
  result.projectBrain = result.projectBrain || 'data/project-brain/project-brain.json';
  result.outputDir = result.outputDir || 'data/reports/project-brain';
  result.mode = result.mode || 'strict';

  return result;
}

/**
 * 加载 ProjectBrain JSON。
 * @param {string} filePath
 * @param {object} [deps]
 * @returns {object}
 */
function loadProjectBrain(filePath, deps = { fs }) {
  const fsImpl = deps.fs || fs;

  if (!fsImpl.existsSync(filePath)) {
    throw new Error('ProjectBrain store file not found: ' + filePath);
  }

  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error('Failed to read ProjectBrain store: ' + e.message);
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('Failed to parse ProjectBrain store JSON: ' + e.message);
  }
}

/**
 * 在 ProjectBrain root 中按 ID 查找 intent。
 * @param {object} projectBrain
 * @param {string} intentId
 * @returns {object|undefined}
 */
function findIntent(projectBrain, intentId) {
  const intents = projectBrain.intents || [];
  return intents.find(i => i.id === intentId);
}

// ============================================================================
// 1. 运行时核心
// ============================================================================

/**
 * 延迟加载 TypeScript 模块。
 * 使用 tsx (项目已有依赖) 动态导入。
 */
async function loadProjectBrainModules() {
  // tsx registers TypeScript loader, then we can dynamically import
  try {
    await import('tsx/cjs');
  } catch (_) {
    // tsx/cjs may not be directly importable; try alternative
  }

  const harnessRoot = path.resolve(__dirname, '..');

  // Use child_process to load via tsx
  const { execFileSync } = require('child_process');

  // Strategy: build a small inline TS module via tsx eval
  // that re-exports what we need
  const { evaluateDiffScope } = await dynamicImportTsModule(
    harnessRoot,
    'src/project-brain/diff-scope-guard',
  );
  const { writeDiffScopeReport } = await dynamicImportTsModule(
    harnessRoot,
    'src/project-brain/diff-scope-reporter',
  );
  const { runDiffScopeScenario } = await dynamicImportTsModule(
    harnessRoot,
    'src/project-brain/diff-scope-scenario-runner',
  );
  const { getChangedPathsFromGitDiff } = await dynamicImportTsModule(
    harnessRoot,
    'src/project-brain/git-diff-adapter',
  );

  return {
    evaluateDiffScope,
    writeDiffScopeReport,
    runDiffScopeScenario,
    getChangedPathsFromGitDiff,
  };
}

/**
 * 通过 tsx 子进程动态导入 TS 模块。
 * 替代方案：直接 require 若 tsx 已注册 loader。
 */
async function dynamicImportTsModule(harnessRoot, modulePath) {
  // Try tsx-registered require first (works when tsx is the runtime)
  try {
    const mod = require(path.join(harnessRoot, modulePath));
    return mod;
  } catch (_) {
    // Fallback: use child process with tsx
  }
  throw new Error(
    'Cannot load TypeScript module: ' + modulePath +
    '. Run with: npx tsx scripts/project-brain-diff-scope-audit.cjs ' +
    'or ensure tsx is available.',
  );
}

/**
 * 主审计流程。
 *
 * @param {string[]} argv - CLI 参数
 * @param {object} [deps] - 依赖注入（测试用）
 */
async function runAuditCli(argv, deps) {
  const d = deps || {};

  // Parse args
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    d.printFn?.(e.message) || console.error(e.message);
    return { exitCode: 2, error: e.message };
  }

  // --help
  if (args.help) {
    if (d.printHelpFn) {
      d.printHelpFn({ log: d.printFn || console.log });
    } else {
      printHelp();
    }
    return { exitCode: 0 };
  }

  // Validate required args
  if (!args.intentId) {
    const msg = 'Error: --intent-id is required.';
    d.printFn?.(msg) || console.error(msg);
    return { exitCode: 2, error: msg };
  }

  // Load modules
  let getChangedPathsFromGitDiff, runDiffScopeScenario;
  if (d.getChangedPathsFromGitDiff) {
    getChangedPathsFromGitDiff = d.getChangedPathsFromGitDiff;
    runDiffScopeScenario = d.runDiffScopeScenario;
  } else {
    const modules = await loadProjectBrainModules();
    getChangedPathsFromGitDiff = modules.getChangedPathsFromGitDiff;
    runDiffScopeScenario = modules.runDiffScopeScenario;
  }

  const pbPath = path.resolve(args.projectBrain);
  const outputDir = path.resolve(args.outputDir);
  const loadFs = d.fs || fs;

  // Load ProjectBrain
  let projectBrain;
  try {
    projectBrain = loadProjectBrain(pbPath, { fs: loadFs });
  } catch (e) {
    const msg = 'Failed to load ProjectBrain: ' + e.message;
    d.printFn?.(msg) || console.error(msg);
    return { exitCode: 2, error: msg };
  }

  // Find intent
  const intent = findIntent(projectBrain, args.intentId);
  if (!intent) {
    const msg = 'Intent not found: ' + args.intentId;
    d.printFn?.(msg) || console.error(msg);
    return { exitCode: 2, error: msg };
  }

  // Get changed paths via read-only git diff
  let changedPaths;
  try {
    changedPaths = await getChangedPathsFromGitDiff({
      cwd: args.cwd,
      staged: args.staged,
      includeUntracked: args.includeUntracked,
      baseRef: args.baseRef,
      headRef: args.headRef,
    });
  } catch (e) {
    const msg = 'Failed to read git changed paths: ' + e.message;
    d.printFn?.(msg) || console.error(msg);
    return { exitCode: 2, error: msg };
  }

  // Run scenario
  let scenarioResult;
  try {
    scenarioResult = await runDiffScopeScenario(
      {
        id: 'git_audit_' + args.intentId,
        title: 'Git diff audit for ' + args.intentId,
        intent,
        changed_paths: changedPaths,
        mode: args.mode,
        expected_allowed: args.expectedAllowed,
        notes: [
          'Generated by project-brain-diff-scope-audit.cjs (P2-T5)',
          'Changed paths source: ' + (args.staged ? 'staged' : args.baseRef ? 'refs' : 'working tree'),
        ],
      },
      {
        outputDir,
        source: 'DiffScopeGitAudit',
      },
    );
  } catch (e) {
    const msg = 'Scenario runner failed: ' + e.message;
    d.printFn?.(msg) || console.error(msg);
    return { exitCode: 2, error: msg };
  }

  // Output summary
  const lines = [
    '',
    '[P2-T5] DiffScopeGuard Git Scenario Audit complete.',
    '[P2-T5] Intent: ' + args.intentId,
    '[P2-T5] Changed paths: ' + changedPaths.length,
    '[P2-T5] Allowed: ' + scenarioResult.actual_allowed,
    '[P2-T5] Passed: ' + scenarioResult.passed,
    '[P2-T5] JSON: ' + scenarioResult.report.jsonPath,
    '[P2-T5] Markdown: ' + scenarioResult.report.markdownPath,
  ];

  for (const line of lines) {
    d.printFn?.(line) || console.log(line);
  }

  const exitCode = scenarioResult.passed ? 0 : 1;
  return { exitCode, scenarioResult, changedPaths };
}

// ============================================================================
// 2. 入口
// ============================================================================

module.exports = {
  parseArgs,
  printHelp,
  loadProjectBrain,
  findIntent,
  runAuditCli,
  FLAGS,
  toCamel,
};

/** kebab-case → camelCase */
function toCamel(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// Only run when executed directly
if (require.main === module) {
  runAuditCli(process.argv.slice(2))
    .then((result) => {
      process.exit(result.exitCode || 0);
    })
    .catch((err) => {
      console.error('[P2-T5] Fatal error: ' + err.message);
      console.error(err.stack);
      process.exit(2);
    });
}

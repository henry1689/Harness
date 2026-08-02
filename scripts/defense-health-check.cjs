#!/usr/bin/env node
/**
 * defense-health-check.cjs — Harness 三道防线健康检查 v2
 * =======================================================
 * P0-T2: 对 Harness 的三道防线做专门健康检查。
 * 纯只读操作。不启动、不重启、不修复任何服务。
 *
 * 三道防线:
 *   第一道防线: MCP Server 闸门
 *   第二道防线: Sentinel 哨兵
 *   第三道防线: Git pre-commit Hook
 *
 * 用法:
 *   node scripts/defense-health-check.cjs          # 默认输出摘要
 *   node scripts/defense-health-check.cjs --json   # 额外打印 JSON 到 stdout
 *
 * 输出:
 *   data/reports/health/health-YYYYMMDD-HHmmss.json
 *   data/reports/health/health-YYYYMMDD-HHmmss.md
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execSync } = require('child_process');

// ============================================================================
// 0. 配置常量
// ============================================================================

const HARNESS_ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(HARNESS_ROOT, 'data', 'reports', 'health');
const MCP_PORT = 8765;

const STDOUT_TAIL_CHARS = 8000;
const STDERR_TAIL_CHARS = 8000;

const EXPECTED_PM2_PROCESSES = ['harness-mcp', 'harness-sentinel'];

const MCP_REQUIRED_FILES = [
  'mcp/server.ts',
  'mcp/start.cjs',
];

const SENTINEL_REQUIRED_FILES = [
  'sentinel/sentinel-service.cjs',
  'sentinel/watcher.cjs',
  'sentinel/rollback.cjs',
  'sentinel/escalation.cjs',
  'sentinel/sentinel-mcp-client.cjs',
];

const MANAGED_PROJECTS = [
  { name: 'wenstar-cc', root: 'D:/tools/wenstar-cc' },
  { name: 'wenstar_os', root: 'D:/wenstar/wenstar_os' },
];

// ============================================================================
// 1. 工具函数 (复用 baseline-report.cjs 成熟模式)
// ============================================================================

function getTimestampForFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    String(now.getFullYear()) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

function tailText(text, maxLen) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return '...(truncated, showing last ' + maxLen + ' chars)\n' + text.slice(-maxLen);
}

/**
 * 安全同步执行命令。命令失败不会 throw。
 */
function runCommand(label, command, options = {}) {
  const start = Date.now();
  const defaults = {
    timeout: 120000,
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  };
  const merged = { ...defaults, ...options };

  let stdout = '';
  let stderr = '';
  let exit_code = null;
  let error = null;

  try {
    stdout = execSync(command, merged);
    exit_code = 0;
  } catch (e) {
    exit_code = e.status !== undefined ? e.status : -1;
    stdout = e.stdout ? String(e.stdout) : '';
    stderr = e.stderr ? String(e.stderr) : '';
    error = e.message ? String(e.message).substring(0, 500) : 'Unknown error';
  }

  const duration_ms = Date.now() - start;

  return {
    ok: exit_code === 0,
    exit_code,
    stdout,                              // 完整原始输出，用于 JSON 解析等
    stderr,                              // 完整原始错误输出
    stdout_tail: tailText(stdout, STDOUT_TAIL_CHARS),  // 截断版本，仅用于报告展示
    stderr_tail: tailText(stderr, STDERR_TAIL_CHARS),
    stdout_length: stdout.length,
    duration_ms,
    error,
  };
}

/**
 * 检查文件是否存在。
 */
function fileExists(root, relativePath) {
  const full = path.join(root, relativePath);
  return fs.existsSync(full);
}

/**
 * 读取文件文本（不存在返回 null）。
 */
function readTextIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

/**
 * 获取文件修改时间的 ISO 字符串。
 */
function fileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch (_) {
    return null;
  }
}

/**
 * 递归列出目录下所有文件。
 */
function listFilesRecursive(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listFilesRecursive(full));
      } else {
        results.push(full);
      }
    }
  } catch (_) { /* skip */ }
  return results;
}

/**
 * 列出目录下直接文件（非递归）。
 */
function listDirectFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).map(f => path.join(dir, f)).filter(f => fs.statSync(f).isFile());
  } catch (_) {
    return [];
  }
}

/**
 * 获取目录中最新的文件修改时间。
 */
function latestMtime(dir) {
  const files = listFilesRecursive(dir);
  if (files.length === 0) return null;
  let latest = 0;
  for (const f of files) {
    try {
      const mtime = fs.statSync(f).mtimeMs;
      if (mtime > latest) latest = mtime;
    } catch (_) { /* skip */ }
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

// ============================================================================
// 2. PM2 检查模块
// ============================================================================

/**
 * 2.1 检查 PM2 守护进程状态。
 * 真实采集 exit_code 和 duration_ms，不使用合成值。
 */
function checkPm2() {
  const result = runCommand('pm2 jlist', 'npx pm2 jlist', {
    timeout: 15000,
    cwd: HARNESS_ROOT,
  });

  const processes = [];
  let parseOk = false;
  let parseError = null;

  if (result.ok && result.stdout) {
    try {
      const parsed = JSON.parse(result.stdout);
      if (Array.isArray(parsed)) {
        parseOk = true;
        for (const p of parsed) {
          processes.push({
            name: p.name || 'unknown',
            status: (p.pm2_env && p.pm2_env.status) || 'unknown',
            pid: p.pid || 0,
            uptime: (p.pm2_env && p.pm2_env.pm_uptime)
              ? Math.round((Date.now() - p.pm2_env.pm_uptime) / 1000)
              : 0,
            restart_time: (p.pm2_env && p.pm2_env.restart_time) || 0,
            memory: (p.monit && p.monit.memory) || 0,
          });
        }
      }
    } catch (e) {
      parseError = 'JSON 解析失败: ' + e.message.substring(0, 200);
    }
  }

  // 搜寻 expected processes
  const expectedProcesses = {};
  for (const name of EXPECTED_PM2_PROCESSES) {
    const found = processes.find(p => p.name === name);
    expectedProcesses[name] = {
      exists: !!found,
      online: found ? found.status === 'online' : false,
      pid: found ? found.pid : null,
      status: found ? found.status : null,
    };
  }

  return {
    available: result.ok,
    command: 'pm2 jlist',
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    stdout_length: result.stdout_length,
    stdout_tail: result.stdout_tail || '',
    stderr_tail: result.stderr_tail || '',
    parse_ok: parseOk,
    parse_error: parseError,
    processes,
    expected_processes: expectedProcesses,
  };
}

// ============================================================================
// 3. MCP 防线检查模块
// ============================================================================

function checkMcpDefense(root, pm2Info) {
  const findings = [];

  // 3.1 检查必要文件
  const filesCheck = {};
  for (const f of MCP_REQUIRED_FILES) {
    filesCheck[f] = fileExists(root, f);
    if (!filesCheck[f]) {
      findings.push({
        severity: 'critical',
        item: 'MCP 必要文件缺失',
        detail: f + ' 不存在',
      });
    }
  }

  // 3.2 检查 PM2 中 harness-mcp 进程
  const pm2Process = (pm2Info && pm2Info.expected_processes)
    ? pm2Info.expected_processes['harness-mcp']
    : { exists: false, online: false, pid: null, status: null };

  if (!pm2Process.exists) {
    findings.push({
      severity: 'warning',
      item: 'harness-mcp PM2 进程不存在',
      detail: 'PM2 中未找到 harness-mcp 进程记录',
    });
  } else if (!pm2Process.online) {
    findings.push({
      severity: 'warning',
      item: 'harness-mcp PM2 进程不在线',
      detail: 'harness-mcp 状态为: ' + pm2Process.status,
    });
  }

  // 3.3 端口检查 (真实采集 exit_code 和 duration_ms)
  const portResult = runCommand(
    'netstat check port ' + MCP_PORT,
    'netstat -ano | findstr :' + MCP_PORT,
    { timeout: 10000, cwd: root }
  );

  const portRaw = portResult.stdout || '';
  const portListening = portRaw.includes('LISTENING');

  const port = {
    port: MCP_PORT,
    listening: portListening,
    command: 'netstat -ano | findstr :' + MCP_PORT,
    exit_code: portResult.exit_code,
    duration_ms: portResult.duration_ms,
    raw_tail: tailText(portRaw, 2000),
  };

  if (!portListening) {
    findings.push({
      severity: 'critical',
      item: 'MCP 端口未监听',
      detail: '端口 ' + MCP_PORT + ' 未检测到 LISTENING 状态',
    });
  }

  // 3.4 Heartbeat 检查
  const hbPath = path.join(root, 'data', 'heartbeat.json');
  const hbExists = fs.existsSync(hbPath);
  let hbFresh = false;
  let hbAgeSeconds = null;
  let hbMtime = null;

  if (hbExists) {
    hbMtime = fileMtime(hbPath);
    if (hbMtime) {
      hbAgeSeconds = Math.round((Date.now() - new Date(hbMtime).getTime()) / 1000);
      hbFresh = hbAgeSeconds < 120;
    }
    if (!hbFresh) {
      findings.push({
        severity: 'warning',
        item: 'Heartbeat 过期',
        detail: hbAgeSeconds !== null
          ? 'Heartbeat 已过期 ' + hbAgeSeconds + 's（阈值 120s）'
          : 'Heartbeat 无法读取修改时间',
      });
    }
  } else {
    findings.push({
      severity: 'warning',
      item: 'Heartbeat 文件缺失',
      detail: 'data/heartbeat.json 不存在',
    });
  }

  const heartbeat = {
    exists: hbExists,
    fresh: hbFresh,
    age_seconds: hbAgeSeconds,
    last_modified: hbMtime,
  };

  // 3.5 判定 MCP 防线状态
  let status = 'PASS';
  const hasCritical = findings.some(f => f.severity === 'critical');
  const hasWarning = findings.some(f => f.severity === 'warning');

  if (hasCritical) {
    status = 'FAIL';
  } else if (hasWarning) {
    status = 'WARN';
  }

  return {
    status,
    risk: statusToRisk(status),
    files: filesCheck,
    pm2_process: {
      exists: pm2Process.exists,
      online: pm2Process.online,
      status: pm2Process.status,
      pid: pm2Process.pid,
    },
    port,
    heartbeat,
    findings,
  };
}

// ============================================================================
// 4. Sentinel 防线检查模块
// ============================================================================

function checkSentinelDefense(root, pm2Info) {
  const findings = [];

  // 4.1 检查必要文件
  const filesCheck = {};
  for (const f of SENTINEL_REQUIRED_FILES) {
    filesCheck[f] = fileExists(root, f);
    if (!filesCheck[f]) {
      findings.push({
        severity: 'critical',
        item: 'Sentinel 必要文件缺失',
        detail: f + ' 不存在',
      });
    }
  }

  // 4.2 检查 PM2 中 harness-sentinel 进程
  const pm2Process = (pm2Info && pm2Info.expected_processes)
    ? pm2Info.expected_processes['harness-sentinel']
    : { exists: false, online: false, pid: null, status: null };

  if (!pm2Process.exists) {
    findings.push({
      severity: 'warning',
      item: 'harness-sentinel PM2 进程不存在',
      detail: 'PM2 中未找到 harness-sentinel 进程记录',
    });
  } else if (!pm2Process.online) {
    findings.push({
      severity: 'warning',
      item: 'harness-sentinel PM2 进程不在线',
      detail: 'harness-sentinel 状态为: ' + pm2Process.status,
    });
  }

  // 4.3 检查 data/sentinel 目录
  const sentinelDir = path.join(root, 'data', 'sentinel');
  const dirExists = fs.existsSync(sentinelDir);
  let dirStats = null;

  if (dirExists) {
    const allFiles = listFilesRecursive(sentinelDir);
    const jsonFiles = allFiles.filter(f => f.endsWith('.json'));
    const logFiles = allFiles.filter(f => f.endsWith('.log'));

    // 最近 24 小时文件数
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let recent24h = 0;
    for (const f of allFiles) {
      try {
        if (fs.statSync(f).mtimeMs >= cutoff) recent24h++;
      } catch (_) { /* skip */ }
    }

    dirStats = {
      exists: true,
      file_count: allFiles.length,
      json_count: jsonFiles.length,
      log_count: logFiles.length,
      latest_modified: latestMtime(sentinelDir),
      recent_24h_file_count: recent24h,
    };
  } else {
    dirStats = {
      exists: false,
      file_count: 0,
      json_count: 0,
      log_count: 0,
      latest_modified: null,
      recent_24h_file_count: 0,
    };
    findings.push({
      severity: 'critical',
      item: 'Sentinel 数据目录不存在',
      detail: 'data/sentinel/ 目录不存在',
    });
  }

  // 4.4 判定 Sentinel 防线状态
  let status = 'PASS';
  const hasCritical = findings.some(f => f.severity === 'critical');
  const hasWarning = findings.some(f => f.severity === 'warning');

  if (hasCritical) {
    status = 'FAIL';
  } else if (hasWarning) {
    status = 'WARN';
  }

  return {
    status,
    risk: statusToRisk(status),
    files: filesCheck,
    pm2_process: {
      exists: pm2Process.exists,
      online: pm2Process.online,
      status: pm2Process.status,
      pid: pm2Process.pid,
    },
    data_dir: dirStats,
    findings,
  };
}

// ============================================================================
// 5. Git Hook 防线检查模块
// ============================================================================

function checkGitHookDefense(root) {
  const findings = [];
  const managedProjectsResults = [];

  // 5.1 检查 harness-gate.cjs
  const gatePath = path.join(root, 'scripts', 'harness-gate.cjs');
  const gateExists = fs.existsSync(gatePath);

  if (!gateExists) {
    findings.push({
      severity: 'critical',
      item: 'harness-gate.cjs 缺失',
      detail: 'scripts/harness-gate.cjs 不存在，第三道防线核心脚本缺失',
    });
  }

  // 5.2 检查 hooks 模板目录
  const hooksDir = path.join(root, 'hooks');
  const hooksDirExists = fs.existsSync(hooksDir);
  let hooksDirFiles = [];
  if (hooksDirExists) {
    hooksDirFiles = listDirectFiles(hooksDir).map(f => path.basename(f));
  }

  if (!hooksDirExists) {
    findings.push({
      severity: 'warning',
      item: 'hooks 模板目录不存在',
      detail: 'hooks/ 目录不存在，无 hook 模板参考',
    });
  }

  // 5.3 检查被管制项目 pre-commit hooks
  const HOOK_CONTENT_CHECKS = ['harness', 'harness-gate', 'node', 'tokens'];

  for (const proj of MANAGED_PROJECTS) {
    const projResult = {
      name: proj.name,
      root: proj.root,
      exists: false,
      is_git_repo: false,
      pre_commit_exists: false,
      pre_commit_size: 0,
      mentions_harness: false,
      mentions_harness_gate: false,
      mentions_node: false,
      mentions_tokens: false,
      findings: [],
    };

    if (!fs.existsSync(proj.root)) {
      projResult.findings.push({
        severity: 'warning',
        item: '项目目录不存在',
        detail: proj.root,
      });
      managedProjectsResults.push(projResult);
      continue;
    }
    projResult.exists = true;

    const dotGit = path.join(proj.root, '.git');
    if (!fs.existsSync(dotGit)) {
      projResult.findings.push({
        severity: 'warning',
        item: '项目不是 Git 仓库',
        detail: '.git 目录不存在于 ' + proj.root,
      });
      managedProjectsResults.push(projResult);
      continue;
    }
    projResult.is_git_repo = true;

    const preCommitPath = path.join(dotGit, 'hooks', 'pre-commit');
    if (!fs.existsSync(preCommitPath)) {
      projResult.findings.push({
        severity: 'critical',
        item: 'pre-commit hook 缺失',
        detail: proj.name + ' 的 .git/hooks/pre-commit 不存在，最后防线不可用',
      });
      managedProjectsResults.push(projResult);
      continue;
    }
    projResult.pre_commit_exists = true;

    // 读取并分析 hook 内容
    let content = null;
    try {
      content = fs.readFileSync(preCommitPath, 'utf8');
      projResult.pre_commit_size = content.length;

      // 内容特征检查
      projResult.mentions_harness = /harness/i.test(content);
      projResult.mentions_harness_gate = /harness-gate/i.test(content);
      projResult.mentions_node = /node/i.test(content);
      projResult.mentions_tokens = /tokens/i.test(content);

      if (!projResult.mentions_harness && !projResult.mentions_harness_gate) {
        projResult.findings.push({
          severity: 'warning',
          item: 'Hook 内容不包含 harness 引用',
          detail: proj.name + ' 的 pre-commit 内容未提及 harness 或 harness-gate',
        });
      }
    } catch (e) {
      projResult.findings.push({
        severity: 'warning',
        item: 'Hook 文件无法读取',
        detail: proj.name + ': ' + e.message.substring(0, 200),
      });
    }

    // 汇总到 findings
    for (const f of projResult.findings) {
      findings.push(f);
    }

    managedProjectsResults.push(projResult);
  }

  // 5.4 判定 Git Hook 防线状态
  let status = 'PASS';
  const hasCritical = findings.some(f => f.severity === 'critical');
  const hasWarning = findings.some(f => f.severity === 'warning');

  if (hasCritical) {
    status = 'FAIL';
  } else if (hasWarning) {
    status = 'WARN';
  }

  return {
    status,
    risk: statusToRisk(status),
    harness_gate: {
      path: 'scripts/harness-gate.cjs',
      exists: gateExists,
    },
    hook_templates: {
      hooks_dir_exists: hooksDirExists,
      file_count: hooksDirFiles.length,
      files: hooksDirFiles,
    },
    managed_projects: managedProjectsResults,
    findings,
  };
}

// ============================================================================
// 6. PM2 Guard 状态判定
// ============================================================================

function computePm2GuardStatus(pm2Info) {
  if (!pm2Info.available) return 'FAIL';
  if (!pm2Info.parse_ok) return 'FAIL';

  const eps = pm2Info.expected_processes;
  const mcpOk = eps['harness-mcp'] && eps['harness-mcp'].exists && eps['harness-mcp'].online;
  const sentinelOk = eps['harness-sentinel'] && eps['harness-sentinel'].exists && eps['harness-sentinel'].online;

  if (!mcpOk || !sentinelOk) return 'WARN';
  return 'PASS';
}

// ============================================================================
// 7. Defense Matrix 与 Summary
// ============================================================================

function buildDefenseMatrix(pm2GuardStatus, mcpStatus, sentinelStatus, gitHookStatus) {
  const matrix = {
    pm2_guard: pm2GuardStatus,
    mcp_gate: mcpStatus,
    sentinel: sentinelStatus,
    git_hook: gitHookStatus,
  };

  // Overall: 任一 FAIL → FAIL, 任一 WARN → WARN, 全是 PASS → PASS
  const criticalLines = ['mcp_gate', 'sentinel', 'git_hook'];
  let overall = 'PASS';

  if (criticalLines.some(k => matrix[k] === 'FAIL')) {
    overall = 'FAIL';
  } else if (Object.values(matrix).some(v => v === 'WARN')) {
    overall = 'WARN';
  }

  matrix.overall = overall;
  return matrix;
}

function buildSummary(defenseMatrix, pm2Info, mcpDefense, sentinelDefense, gitHookDefense) {
  const criticalFindings = [];
  const warnings = [];
  const recommendations = [];

  // 收集各防线 findings
  for (const section of [mcpDefense, sentinelDefense, gitHookDefense]) {
    for (const f of (section.findings || [])) {
      if (f.severity === 'critical') {
        criticalFindings.push(f.item + ': ' + f.detail);
      } else {
        warnings.push(f.item + ': ' + f.detail);
      }
    }
  }

  // PM2 相关
  if (!pm2Info.available) {
    criticalFindings.push('PM2 命令不可用: exit_code=' + pm2Info.exit_code);
    recommendations.push('PM2 daemon 未运行。建议在架构师确认后，通过 pm2 resurrect 或 pm2 start ecosystem.config.cjs 恢复 PM2 守护；本任务不执行自动恢复。');
  } else if (pm2Info.processes.length === 0) {
    warnings.push('PM2 可用但进程列表为空');
    recommendations.push('PM2 daemon 在线但无 Harness 进程。建议通过 pm2 start ecosystem.config.cjs 创建进程；本任务不执行自动启动。');
  }

  // 生成推荐操作
  const recSet = new Set(recommendations);

  if (defenseMatrix.mcp_gate === 'FAIL') {
    recSet.add('MCP 第一道防线 FAIL。建议在后续防线恢复任务中优先恢复 MCP Server 和 PM2 harness-mcp 进程。');
  } else if (defenseMatrix.mcp_gate === 'WARN') {
    recSet.add('MCP 第一道防线 WARN。建议检查 PM2 harness-mcp 进程状态和 heartbeat 新鲜度。');
  }

  if (defenseMatrix.sentinel === 'FAIL') {
    recSet.add('Sentinel 第二道防线 FAIL。建议在后续恢复任务中恢复 Sentinel 必要文件或进程。');
  } else if (defenseMatrix.sentinel === 'WARN') {
    recSet.add('Sentinel 第二道防线 WARN。建议检查 harness-sentinel PM2 进程状态和 data/sentinel 数据目录。');
  }

  if (defenseMatrix.git_hook === 'FAIL') {
    recSet.add('Git Hook 第三道防线 FAIL。建议优先恢复 scripts/harness-gate.cjs 和被管制项目的 pre-commit hooks。');
  } else if (defenseMatrix.git_hook === 'WARN') {
    recSet.add('Git Hook 第三道防线 WARN。建议补齐缺失的项目 pre-commit hooks 或 hooks 模板目录。');
  }

  // 默认备注
  recSet.add('本任务为只读健康检查，未执行任何启动、重启、停止或修复操作。所有恢复操作应由后续专门任务执行。');

  return {
    overall_status: defenseMatrix.overall,
    critical_findings: criticalFindings,
    warnings,
    recommendations: [...recSet],
  };
}

function statusToRisk(status) {
  switch (status) {
    case 'PASS': return 'low';
    case 'WARN': return 'high';
    case 'FAIL': return 'critical';
    default: return 'unknown';
  }
}

// ============================================================================
// 8. Markdown 渲染
// ============================================================================

function renderMarkdown(report, jsonRelPath, mdRelPath) {
  const statusEmoji = (s) => s === 'PASS' ? '✅' : s === 'WARN' ? '⚠️' : '❌';
  const riskBadge = (r) => r === 'low' ? '🟢 low' : r === 'high' ? '🟡 high' : '🔴 critical';

  let md = '# Harness Defense Health Report\n\n';

  // ---- 1. Summary ----
  md += '## 1. Summary\n\n';
  md += '| Metric | Value |\n|---|---|\n';
  md += '| Overall Status | **' + report.defense_matrix.overall + '** |\n';
  md += '| PM2 Guard | ' + statusEmoji(report.defense_matrix.pm2_guard) + ' ' + report.defense_matrix.pm2_guard + ' |\n';
  md += '| MCP Gate | ' + statusEmoji(report.defense_matrix.mcp_gate) + ' ' + report.defense_matrix.mcp_gate + ' |\n';
  md += '| Sentinel | ' + statusEmoji(report.defense_matrix.sentinel) + ' ' + report.defense_matrix.sentinel + ' |\n';
  md += '| Git Hook | ' + statusEmoji(report.defense_matrix.git_hook) + ' ' + report.defense_matrix.git_hook + ' |\n';
  md += '| Generated At | ' + report.generated_at + ' |\n';
  md += '| Duration (ms) | ' + report.duration_ms + ' |\n';
  md += '\n';

  // ---- 2. Defense Matrix ----
  md += '## 2. Defense Matrix\n\n';
  md += '| Defense | Status | Risk | Detail |\n|---|---|---|---|\n';
  md += '| PM2 Guard | ' + statusEmoji(report.defense_matrix.pm2_guard) + ' ' + report.defense_matrix.pm2_guard + ' | ' + riskBadge(report.pm2.available ? 'low' : 'high') + ' | pm2 jlist exit_code=' + report.pm2.exit_code + ', parse_ok=' + report.pm2.parse_ok + ' |\n';
  md += '| MCP Gate | ' + statusEmoji(report.defense_matrix.mcp_gate) + ' ' + report.defense_matrix.mcp_gate + ' | ' + riskBadge(report.mcp_defense.risk) + ' | port ' + MCP_PORT + ' listening=' + report.mcp_defense.port.listening + ', heartbeat fresh=' + report.mcp_defense.heartbeat.fresh + ' |\n';
  md += '| Sentinel | ' + statusEmoji(report.defense_matrix.sentinel) + ' ' + report.defense_matrix.sentinel + ' | ' + riskBadge(report.sentinel_defense.risk) + ' | files complete, PM2 online=' + report.sentinel_defense.pm2_process.online + ' |\n';
  md += '| Git Hook | ' + statusEmoji(report.defense_matrix.git_hook) + ' ' + report.defense_matrix.git_hook + ' | ' + riskBadge(report.git_hook_defense.risk) + ' | harness-gate.cjs exists=' + report.git_hook_defense.harness_gate.exists + ' |\n';
  md += '\n';

  // ---- 3. PM2 Guard ----
  md += '## 3. PM2 Guard\n\n';
  md += '| Field | Value |\n|---|---|\n';
  md += '| Available | ' + report.pm2.available + ' |\n';
  md += '| Command | `' + report.pm2.command + '` |\n';
  md += '| Exit Code | ' + report.pm2.exit_code + ' |\n';
  md += '| Duration (ms) | ' + report.pm2.duration_ms + ' |\n';
  if (report.pm2.stdout_length != null) {
    md += '| stdout Length | ' + report.pm2.stdout_length + ' bytes |\n';
  }
  md += '| Parse OK | ' + report.pm2.parse_ok + ' |\n';
  if (report.pm2.parse_error) {
    md += '| Parse Error | `' + report.pm2.parse_error + '` |\n';
  }
  md += '| Process Count | ' + report.pm2.processes.length + ' |\n';
  md += '\n';

  if (report.pm2.processes.length > 0) {
    md += '| Name | Status | PID | Uptime (s) | Memory (bytes) |\n';
    md += '|---|---|---|---|---|\n';
    for (const p of report.pm2.processes) {
      md += '| ' + p.name + ' | ' + p.status + ' | ' + p.pid + ' | ' + p.uptime + ' | ' + p.memory + ' |\n';
    }
    md += '\n';
  }

  md += '### Expected Processes\n\n';
  md += '| Process | Exists | Online | PID | Status |\n|---|---|---|---|---|\n';
  for (const [name, ep] of Object.entries(report.pm2.expected_processes)) {
    md += '| ' + name + ' | ' + ep.exists + ' | ' + ep.online + ' | ' + (ep.pid || 'N/A') + ' | ' + (ep.status || 'N/A') + ' |\n';
  }
  md += '\n';

  // ---- 4. MCP Gate Defense ----
  md += '## 4. MCP Gate Defense\n\n';
  md += 'Status: ' + statusEmoji(report.mcp_defense.status) + ' **' + report.mcp_defense.status + '** (Risk: ' + riskBadge(report.mcp_defense.risk) + ')\n\n';

  md += '### Required Files\n\n';
  md += '| File | Exists |\n|---|---|\n';
  for (const [f, exists] of Object.entries(report.mcp_defense.files)) {
    md += '| `' + f + '` | ' + (exists ? '✅' : '❌') + ' |\n';
  }
  md += '\n';

  md += '### PM2 Process\n\n';
  const mcpProc = report.mcp_defense.pm2_process;
  md += '| Field | Value |\n|---|---|\n';
  md += '| Exists | ' + mcpProc.exists + ' |\n';
  md += '| Online | ' + mcpProc.online + ' |\n';
  md += '| Status | ' + (mcpProc.status || 'N/A') + ' |\n';
  md += '| PID | ' + (mcpProc.pid || 'N/A') + ' |\n';
  md += '\n';

  md += '### Port ' + MCP_PORT + '\n\n';
  const port = report.mcp_defense.port;
  md += '| Field | Value |\n|---|---|\n';
  md += '| Listening | ' + port.listening + ' |\n';
  md += '| Command | `' + port.command + '` |\n';
  md += '| Exit Code | ' + port.exit_code + ' |\n';
  md += '| Duration (ms) | ' + port.duration_ms + ' |\n';
  if (port.raw_tail) {
    md += '\n```\n' + port.raw_tail.trim() + '\n```\n';
  }
  md += '\n';

  md += '### Heartbeat\n\n';
  const hb = report.mcp_defense.heartbeat;
  md += '| Field | Value |\n|---|---|\n';
  md += '| Exists | ' + hb.exists + ' |\n';
  md += '| Fresh (<120s) | ' + hb.fresh + ' |\n';
  md += '| Age (seconds) | ' + (hb.age_seconds !== null ? hb.age_seconds : 'N/A') + ' |\n';
  md += '| Last Modified | ' + (hb.last_modified || 'N/A') + ' |\n';
  md += '\n';

  if (report.mcp_defense.findings.length > 0) {
    md += '### MCP Findings\n\n';
    for (const f of report.mcp_defense.findings) {
      md += '- ' + (f.severity === 'critical' ? '❌' : '⚠️') + ' **' + f.item + '**: ' + f.detail + '\n';
    }
    md += '\n';
  }

  // ---- 5. Sentinel Defense ----
  md += '## 5. Sentinel Defense\n\n';
  md += 'Status: ' + statusEmoji(report.sentinel_defense.status) + ' **' + report.sentinel_defense.status + '** (Risk: ' + riskBadge(report.sentinel_defense.risk) + ')\n\n';

  md += '### Required Files\n\n';
  md += '| File | Exists |\n|---|---|\n';
  for (const [f, exists] of Object.entries(report.sentinel_defense.files)) {
    md += '| `' + f + '` | ' + (exists ? '✅' : '❌') + ' |\n';
  }
  md += '\n';

  md += '### PM2 Process\n\n';
  const sentProc = report.sentinel_defense.pm2_process;
  md += '| Field | Value |\n|---|---|\n';
  md += '| Exists | ' + sentProc.exists + ' |\n';
  md += '| Online | ' + sentProc.online + ' |\n';
  md += '| Status | ' + (sentProc.status || 'N/A') + ' |\n';
  md += '| PID | ' + (sentProc.pid || 'N/A') + ' |\n';
  md += '\n';

  md += '### Data Directory (data/sentinel)\n\n';
  const dd = report.sentinel_defense.data_dir;
  md += '| Field | Value |\n|---|---|\n';
  md += '| Exists | ' + dd.exists + ' |\n';
  md += '| File Count | ' + dd.file_count + ' |\n';
  md += '| JSON Count | ' + dd.json_count + ' |\n';
  md += '| Log Count | ' + dd.log_count + ' |\n';
  md += '| Latest Modified | ' + (dd.latest_modified || 'N/A') + ' |\n';
  md += '| Recent 24h Files | ' + dd.recent_24h_file_count + ' |\n';
  md += '\n';

  if (report.sentinel_defense.findings.length > 0) {
    md += '### Sentinel Findings\n\n';
    for (const f of report.sentinel_defense.findings) {
      md += '- ' + (f.severity === 'critical' ? '❌' : '⚠️') + ' **' + f.item + '**: ' + f.detail + '\n';
    }
    md += '\n';
  }

  // ---- 6. Git Hook Defense ----
  md += '## 6. Git Hook Defense\n\n';
  md += 'Status: ' + statusEmoji(report.git_hook_defense.status) + ' **' + report.git_hook_defense.status + '** (Risk: ' + riskBadge(report.git_hook_defense.risk) + ')\n\n';

  md += '### Harness Gate\n\n';
  md += '| Field | Value |\n|---|---|\n';
  md += '| Path | `' + report.git_hook_defense.harness_gate.path + '` |\n';
  md += '| Exists | ' + report.git_hook_defense.harness_gate.exists + ' |\n';
  md += '\n';

  md += '### Hook Templates\n\n';
  md += '| Field | Value |\n|---|---|\n';
  md += '| hooks/ Exists | ' + report.git_hook_defense.hook_templates.hooks_dir_exists + ' |\n';
  md += '| Template Count | ' + report.git_hook_defense.hook_templates.file_count + ' |\n';
  if (report.git_hook_defense.hook_templates.files.length > 0) {
    md += '| Files | `' + report.git_hook_defense.hook_templates.files.join('`, `') + '` |\n';
  }
  md += '\n';

  if (report.git_hook_defense.findings.length > 0) {
    md += '### Git Hook Findings\n\n';
    for (const f of report.git_hook_defense.findings) {
      md += '- ' + (f.severity === 'critical' ? '❌' : '⚠️') + ' **' + f.item + '**: ' + f.detail + '\n';
    }
    md += '\n';
  }

  // ---- 7. Managed Projects Hook Status ----
  md += '## 7. Managed Projects Hook Status\n\n';
  for (const proj of report.git_hook_defense.managed_projects) {
    md += '### ' + proj.name + '\n\n';
    md += '| Field | Value |\n|---|---|\n';
    md += '| Root | `' + proj.root + '` |\n';
    md += '| Exists | ' + proj.exists + ' |\n';
    md += '| Is Git Repo | ' + proj.is_git_repo + ' |\n';
    md += '| pre-commit Exists | ' + proj.pre_commit_exists + ' |\n';
    md += '| pre-commit Size | ' + proj.pre_commit_size + ' bytes |\n';
    if (proj.pre_commit_exists) {
      md += '| Mentions harness | ' + proj.mentions_harness + ' |\n';
      md += '| Mentions harness-gate | ' + proj.mentions_harness_gate + ' |\n';
      md += '| Mentions node | ' + proj.mentions_node + ' |\n';
      md += '| Mentions tokens | ' + proj.mentions_tokens + ' |\n';
    }
    if (proj.findings.length > 0) {
      md += '\n**Findings:**\n\n';
      for (const f of proj.findings) {
        md += '- ' + (f.severity === 'critical' ? '❌' : '⚠️') + ' ' + f.item + ': ' + f.detail + '\n';
      }
    }
    md += '\n';
  }

  // ---- 8. Critical Findings ----
  md += '## 8. Critical Findings\n\n';
  if (report.summary.critical_findings.length === 0) {
    md += '✅ 没有严重发现。\n\n';
  } else {
    for (const f of report.summary.critical_findings) {
      md += '- ❌ ' + f + '\n';
    }
    md += '\n';
  }

  // ---- 9. Warnings ----
  md += '## 9. Warnings\n\n';
  if (report.summary.warnings.length === 0) {
    md += '✅ 没有警告。\n\n';
  } else {
    for (const w of report.summary.warnings) {
      md += '- ⚠️ ' + w + '\n';
    }
    md += '\n';
  }

  // ---- 10. Recommendations ----
  md += '## 10. Recommendations\n\n';
  for (const r of report.summary.recommendations) {
    md += '- ' + r + '\n';
  }
  md += '\n';

  // ---- 11. Generated Files ----
  md += '## 11. Generated Files\n\n';
  md += '| File | Path |\n|---|---|\n';
  md += '| JSON | `' + jsonRelPath + '` |\n';
  md += '| Markdown | `' + mdRelPath + '` |\n';
  md += '\n';

  md += '---\n';
  md += '*Generated by defense-health-check.cjs at ' + report.generated_at + '*\n';
  md += '*Harness Defense Health Check v2 — P0-T2*\n';
  md += '\n';
  md += '> ⚠️ 本任务为只读健康检查。未执行任何启动、重启、停止或修复操作。\n';

  return md;
}

// ============================================================================
// 9. 主入口
// ============================================================================

async function main() {
  const startTime = Date.now();
  const errors = [];

  const timestamp = getTimestampForFilename();
  ensureDirSync(REPORTS_DIR);

  const jsonFile = path.join(REPORTS_DIR, 'health-' + timestamp + '.json');
  const mdFile = path.join(REPORTS_DIR, 'health-' + timestamp + '.md');
  const jsonRelPath = 'data/reports/health/health-' + timestamp + '.json';
  const mdRelPath = 'data/reports/health/health-' + timestamp + '.md';

  console.log('[DefenseHealth] 开始 Harness 三道防线健康检查...');
  console.log('[DefenseHealth] 报告目录: ' + REPORTS_DIR);
  console.log('[DefenseHealth] 注意: 本任务为只读检查，不执行任何修复操作。');
  console.log('');

  // ── 1. PM2 检查 ──
  console.log('[1/4] 检查 PM2 守护状态...');
  const pm2Info = checkPm2();

  // ── 2. MCP 防线 ──
  console.log('[2/4] 检查 MCP Gate 第一道防线...');
  const mcpDefense = checkMcpDefense(HARNESS_ROOT, pm2Info);

  // ── 3. Sentinel 防线 ──
  console.log('[3/4] 检查 Sentinel 第二道防线...');
  const sentinelDefense = checkSentinelDefense(HARNESS_ROOT, pm2Info);

  // ── 4. Git Hook 防线 ──
  console.log('[4/4] 检查 Git Hook 第三道防线...');
  const gitHookDefense = checkGitHookDefense(HARNESS_ROOT);

  // ── 组装报告 ──
  const pm2GuardStatus = computePm2GuardStatus(pm2Info);
  const defenseMatrix = buildDefenseMatrix(
    pm2GuardStatus,
    mcpDefense.status,
    sentinelDefense.status,
    gitHookDefense.status
  );

  const report = {
    schema_version: 1,
    report_type: 'harness_defense_health',
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    harness: {
      root: HARNESS_ROOT,
    },
    pm2: {
      available: pm2Info.available,
      command: pm2Info.command,
      exit_code: pm2Info.exit_code,
      duration_ms: pm2Info.duration_ms,
      stdout_length: pm2Info.stdout_length,
      stdout_tail: pm2Info.stdout_tail,
      stderr_tail: pm2Info.stderr_tail,
      parse_ok: pm2Info.parse_ok,
      parse_error: pm2Info.parse_error,
      processes: pm2Info.processes,
      expected_processes: pm2Info.expected_processes,
    },
    mcp_defense: mcpDefense,
    sentinel_defense: sentinelDefense,
    git_hook_defense: gitHookDefense,
    defense_matrix: defenseMatrix,
    summary: {},
    errors: [],
  };

  report.summary = buildSummary(defenseMatrix, pm2Info, mcpDefense, sentinelDefense, gitHookDefense);

  // ── 写入 JSON ──
  try {
    await writeJsonAtomic(jsonFile, report);
    console.log('[DefenseHealth] JSON 报告已生成: ' + jsonFile);
  } catch (e) {
    const msg = 'JSON 报告写入失败: ' + e.message;
    console.error('[DefenseHealth] ' + msg);
    errors.push(msg);
  }

  // ── 写入 Markdown ──
  try {
    const md = renderMarkdown(report, jsonRelPath, mdRelPath);
    await writeTextAtomic(mdFile, md);
    console.log('[DefenseHealth] Markdown 报告已生成: ' + mdFile);
  } catch (e) {
    const msg = 'Markdown 报告写入失败: ' + e.message;
    console.error('[DefenseHealth] ' + msg);
    errors.push(msg);
  }

  // ── 控制台输出 ──
  const dm = report.defense_matrix;
  const s = report.summary;

  console.log('');
  console.log('[DefenseHealth] Harness defense health report generated.');
  console.log('');
  console.log('Overall: ' + dm.overall);
  console.log('');
  console.log('Defense Matrix:');
  console.log('  - PM2 Guard:   ' + dm.pm2_guard);
  console.log('  - MCP Gate:    ' + dm.mcp_gate);
  console.log('  - Sentinel:    ' + dm.sentinel);
  console.log('  - Git Hook:    ' + dm.git_hook);
  console.log('');
  console.log('JSON:     ' + jsonRelPath);
  console.log('Markdown: ' + mdRelPath);
  console.log('');

  if (s.warnings.length > 0) {
    console.log('Warnings (' + s.warnings.length + '):');
    for (const w of s.warnings) {
      console.log('  ⚠  ' + w);
    }
    console.log('');
  }

  if (s.critical_findings.length > 0) {
    console.log('Critical (' + s.critical_findings.length + '):');
    for (const f of s.critical_findings) {
      console.log('  ❌ ' + f);
    }
    console.log('');
  }

  if (s.recommendations.length > 0) {
    console.log('Recommendations (' + s.recommendations.length + '):');
    for (const r of s.recommendations) {
      console.log('  → ' + r);
    }
    console.log('');
  }

  console.log('Note:');
  console.log('  This task is health-check only. No service was started, stopped, restarted, or modified.');
  console.log('');

  // ── --json 模式 ──
  if (process.argv.includes('--json')) {
    console.log('[DefenseHealth] --json 模式，输出报告 JSON:');
    console.log(JSON.stringify(report, null, 2));
  }

  // ── 退出码 ──
  if (errors.length > 0 && dm.overall === 'FAIL') {
    console.error('[DefenseHealth] 报告生成有错误，且整体状态为 FAIL');
    process.exit(2);
  }

  if (dm.overall === 'FAIL') {
    console.log('[DefenseHealth] 报告生成成功，但整体状态为 FAIL (关键防线未通过)');
    process.exit(1);
  }

  console.log('[DefenseHealth] 完成。');
  process.exit(0);
}

main().catch((err) => {
  console.error('[DefenseHealth] 未捕获异常: ' + err.message);
  console.error(err.stack);
  process.exit(2);
});

#!/usr/bin/env node
/**
 * baseline-report.cjs — Harness v3.0 当前基线快照
 * ==================================================
 * P0-T1: Harness v4.0 升级前的"拍照任务"。
 * 纯只读操作，不修改任何核心逻辑。
 *
 * 用法:
 *   node scripts/baseline-report.cjs          # 默认输出摘要
 *   node scripts/baseline-report.cjs --json   # 额外打印 JSON 到 stdout
 *
 * 输出:
 *   data/reports/baseline/baseline-YYYYMMDD-HHmmss.json
 *   data/reports/baseline/baseline-YYYYMMDD-HHmmss.md
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

// ============================================================================
// 0. 配置常量
// ============================================================================

const HARNESS_ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(HARNESS_ROOT, 'data', 'reports', 'baseline');
const HEARTBEAT_FILE = path.join(HARNESS_ROOT, 'data', 'heartbeat.json');
const TOKEN_DIR = path.join(HARNESS_ROOT, 'data', 'tokens');
const AUDIT_DIR = path.join(HARNESS_ROOT, 'data', 'audit');
const SENTINEL_DIR = path.join(HARNESS_ROOT, 'data', 'sentinel');
const LOGS_DIR = path.join(HARNESS_ROOT, 'data', 'logs');
const MCP_PORT = 8765;

const MANAGED_PROJECTS = [
  { name: 'wenstar-cc', root: 'D:/tools/wenstar-cc' },
  { name: 'wenstar_os', root: 'D:/wenstar/wenstar_os' },
];

const STDOUT_TAIL_CHARS = 8000;
const STDERR_TAIL_CHARS = 8000;

// ============================================================================
// 1. 工具函数
// ============================================================================

/**
 * 生成安全的文件名时间戳: YYYYMMDD-HHmmss
 * 基于本地时间。
 */
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

/**
 * 确保目录存在（递归创建）。
 */
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 原子写入 JSON 文件。
 */
async function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * 原子写入文本文件。
 */
async function writeTextAtomic(file, text) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * 截断文本到指定长度（从尾部截取）。
 */
function tailText(text, maxLen) {
  if (text.length <= maxLen) return text;
  return '...(truncated, showing last ' + maxLen + ' chars)\n' + text.slice(-maxLen);
}

/**
 * 同步执行命令并捕获结果。
 * 命令失败不会 throw，而是返回包含 exit_code 和错误信息的对象。
 *
 * @param {string} label - 用于日志的人类可读标签
 * @param {string} command - 要执行的命令字符串
 * @param {object} [options] - execSync 选项
 * @returns {{ ok: boolean, exit_code: number | null, stdout: string, stderr: string, duration_ms: number, error: string | null }}
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
    stdout: tailText(stdout, STDOUT_TAIL_CHARS),
    stderr: tailText(stderr, STDERR_TAIL_CHARS),
    duration_ms,
    error,
  };
}

/**
 * 在指定目录执行 git 命令。
 */
function gitCommand(cwd, args) {
  try {
    return execSync('git ' + args, { cwd, timeout: 15000, encoding: 'utf8', windowsHide: true }).trim();
  } catch (_) {
    return null;
  }
}

/**
 * 安全读取 JSON 文件，失败返回 null。
 */
function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * 列出目录下所有文件（递归），返回文件路径数组。
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
  } catch (_) {
    // 权限问题等，返回空数组
  }
  return results;
}

/**
 * 列出目录下的直接文件（非递归）。
 */
function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).map(f => path.join(dir, f));
  } catch (_) {
    return [];
  }
}

/**
 * 获取文件的最近修改时间（ISO 字符串），不存在返回 null。
 */
function fileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch (_) {
    return null;
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
// 2. 数据收集模块
// ============================================================================

/**
 * 2.1 收集 Harness 自身 Git 状态。
 */
function collectHarnessGit(root) {
  const commit = gitCommand(root, 'rev-parse HEAD');
  const branch = gitCommand(root, 'branch --show-current');
  const statusRaw = gitCommand(root, 'status --porcelain');
  const statusLines = statusRaw ? statusRaw.split('\n').filter(Boolean) : [];
  const dirty = statusLines.length > 0;

  return {
    commit: commit || 'unknown',
    branch: branch || 'unknown',
    dirty,
    status_porcelain: statusLines,
  };
}

/**
 * 2.2 收集运行时信息。
 */
function collectRuntimeInfo() {
  return {
    node_version: process.version,
    npm_version: (() => {
      try { return execSync('npm -v', { timeout: 5000, encoding: 'utf8', windowsHide: true }).trim(); }
      catch (_) { return 'unknown'; }
    })(),
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
  };
}

/**
 * 2.3 收集 package.json 信息。
 */
function collectPackageInfo(root) {
  const pkgPath = path.join(root, 'package.json');
  const pkg = readJsonSafe(pkgPath);

  if (!pkg) {
    return {
      name: 'unknown',
      version: 'unknown',
      typescript_version: 'unknown',
      vitest_version: 'unknown',
      pm2_version: 'unknown',
      ok: false,
    };
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  return {
    name: pkg.name || 'unknown',
    version: pkg.version || 'unknown',
    typescript_version: deps['typescript'] || 'unknown',
    vitest_version: deps['vitest'] || 'unknown',
    pm2_version: deps['pm2'] || 'not in package.json',
    ok: true,
  };
}

/**
 * 2.4 运行 tsc --noEmit 编译检查。
 */
function runTscCheck(root) {
  const tsconfig = path.join(root, 'tsconfig.json');
  if (!fs.existsSync(tsconfig)) {
    return {
      ok: false,
      command: 'npx tsc --noEmit',
      exit_code: null,
      duration_ms: 0,
      stdout_tail: '',
      stderr_tail: 'tsconfig.json not found',
      message: 'tsconfig.json 不存在，跳过编译检查',
    };
  }

  const result = runCommand('tsc --noEmit', 'npx tsc --noEmit', {
    timeout: 120000,
    cwd: root,
  });

  return {
    ok: result.ok,
    command: 'npx tsc --noEmit',
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    stdout_tail: result.stdout || '',
    stderr_tail: result.stderr || '',
    message: result.ok ? '编译通过' : '编译失败: exit_code=' + result.exit_code,
  };
}

/**
 * 2.5 运行 vitest run 测试检查。
 */
function runVitestCheck(root) {
  const result = runCommand('vitest run', 'npx vitest run --reporter=verbose', {
    timeout: 180000,
    cwd: root,
  });

  return {
    ok: result.ok,
    command: 'npx vitest run',
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    stdout_tail: result.stdout || '',
    stderr_tail: result.stderr || '',
    message: result.ok ? '测试全部通过' : '测试失败: exit_code=' + result.exit_code,
  };
}

/**
 * 2.6 收集 PM2 进程状态。
 */
function collectPm2Status() {
  const result = runCommand('pm2 jlist', 'npx pm2 jlist', {
    timeout: 15000,
    cwd: HARNESS_ROOT,
  });

  const timing = { duration_ms: result.duration_ms, exit_code: result.exit_code };

  if (!result.ok) {
    return {
      available: false,
      processes: [],
      raw_error: result.error || 'pm2 jlist failed',
      duration_ms: timing.duration_ms,
      exit_code: timing.exit_code,
    };
  }

  let parsed = [];
  try {
    parsed = JSON.parse(result.stdout);
  } catch (_) {
    return {
      available: true,
      processes: [],
      parse_error: 'Failed to parse pm2 jlist JSON output',
      duration_ms: timing.duration_ms,
      exit_code: timing.exit_code,
    };
  }

  const processes = parsed.map((p) => ({
    name: p.name || 'unknown',
    status: (p.pm2_env && p.pm2_env.status) || 'unknown',
    pid: p.pid || 0,
    uptime: (p.pm2_env && p.pm2_env.pm_uptime) ? Math.round((Date.now() - p.pm2_env.pm_uptime) / 1000) : 0,
    restart_time: (p.pm2_env && p.pm2_env.restart_time) || 0,
    memory: (p.monit && p.monit.memory) || 0,
  }));

  return {
    available: true,
    processes,
    duration_ms: timing.duration_ms,
    exit_code: timing.exit_code,
  };
}

/**
 * 2.7 检查 MCP 端口 8765 是否在监听。
 */
function checkMcpPort() {
  const result = runCommand(
    'netstat check port ' + MCP_PORT,
    'netstat -ano | findstr :' + MCP_PORT,
    { timeout: 10000, cwd: HARNESS_ROOT }
  );

  const raw = result.stdout || '';
  const listening = raw.includes('LISTENING');

  return {
    ok: listening,
    listening,
    exit_code: result.exit_code,
    raw: raw,
    message: listening ? '端口 ' + MCP_PORT + ' 正在监听' : '端口 ' + MCP_PORT + ' 未监听',
  };
}

/**
 * 2.8 检查 Heartbeat 文件。
 */
function checkHeartbeat(root) {
  const hbPath = path.join(root, 'data', 'heartbeat.json');
  const exists = fs.existsSync(hbPath);

  if (!exists) {
    return {
      ok: false,
      exists: false,
      path: hbPath,
      last_modified: null,
      age_seconds: null,
      fresh: false,
      message: 'heartbeat.json 文件不存在',
      content: null,
    };
  }

  const mtimeStr = fileMtime(hbPath);
  const content = readJsonSafe(hbPath);
  let ageSeconds = null;
  let fresh = false;

  if (mtimeStr) {
    const mtimeMs = new Date(mtimeStr).getTime();
    ageSeconds = Math.round((Date.now() - mtimeMs) / 1000);
    fresh = ageSeconds < 120;
  }

  // 也尝试从内容 ts 字段计算
  if (content && content.ts) {
    const contentAge = Math.round((Date.now() - content.ts) / 1000);
    if (ageSeconds === null || contentAge < ageSeconds) {
      ageSeconds = contentAge;
    }
    fresh = ageSeconds < 120;
  }

  return {
    ok: fresh,
    exists: true,
    path: hbPath,
    last_modified: mtimeStr,
    age_seconds: ageSeconds,
    fresh,
    message: fresh
      ? 'Heartbeat 新鲜 (' + ageSeconds + 's 前)'
      : 'Heartbeat 过期 (' + ageSeconds + 's 前)',
    content,
  };
}

/**
 * 2.9 统计 data 下各目录的通用信息。
 */
function collectDirStats(dirPath) {
  const exists = fs.existsSync(dirPath);

  if (!exists) {
    return {
      path: dirPath,
      exists: false,
      file_count: 0,
      json_count: 0,
      latest_modified: null,
    };
  }

  const allFiles = listFilesRecursive(dirPath);
  const jsonFiles = allFiles.filter(f => f.endsWith('.json'));
  const latest = latestMtime(dirPath);

  return {
    path: dirPath,
    exists: true,
    file_count: allFiles.length,
    json_count: jsonFiles.length,
    latest_modified: latest,
  };
}

/**
 * 2.10 粗略统计 Token 目录（consumed / expired）。
 */
function collectTokenStats(tokensDir) {
  const base = collectDirStats(tokensDir);

  if (!base.exists) {
    return { ...base, consumed_guess_count: 0, expired_guess_count: 0 };
  }

  let consumed = 0;
  let expired = 0;
  const now = Date.now();

  const allFiles = listFilesRecursive(tokensDir);
  for (const f of allFiles) {
    if (!f.endsWith('.json')) continue;
    const content = readJsonSafe(f);
    if (!content) continue;

    try {
      if (content.consumed === true) consumed++;

      // expires_at 或 expiresAt
      const expAt = content.expires_at || content.expiresAt;
      if (expAt) {
        const expMs = new Date(expAt).getTime();
        if (!isNaN(expMs) && expMs < now) expired++;
      }
    } catch (_) {
      // JSON 解析后的字段访问异常，跳过
    }
  }

  return {
    ...base,
    consumed_guess_count: consumed,
    expired_guess_count: expired,
  };
}

/**
 * 2.11 粗略统计 Sentinel 目录（含最近 24h 事件估算）。
 */
function collectSentinelStats(sentinelDir) {
  const base = collectDirStats(sentinelDir);

  if (!base.exists) {
    return { ...base, last_24h_event_guess_count: 0 };
  }

  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  let last24hFiles = 0;

  const allFiles = listFilesRecursive(sentinelDir);
  for (const f of allFiles) {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs >= cutoff) last24hFiles++;
    } catch (_) { /* skip */ }
  }

  return {
    ...base,
    last_24h_event_guess_count: last24hFiles,
  };
}

/**
 * 2.12 收集被管制项目的 Git 状态。
 */
function collectManagedProjects() {
  const results = [];

  for (const proj of MANAGED_PROJECTS) {
    const exists = fs.existsSync(proj.root);
    const entry = {
      name: proj.name,
      root: proj.root,
      exists,
      git: null,
    };

    if (exists) {
      const isRepo = fs.existsSync(path.join(proj.root, '.git'));
      if (isRepo) {
        const commit = gitCommand(proj.root, 'rev-parse HEAD');
        const branch = gitCommand(proj.root, 'branch --show-current');
        const statusRaw = gitCommand(proj.root, 'status --porcelain');
        const statusLines = statusRaw ? statusRaw.split('\n').filter(Boolean) : [];
        entry.git = {
          is_repo: true,
          commit: commit || 'unknown',
          branch: branch || 'unknown',
          dirty: statusLines.length > 0,
          status_porcelain: statusLines,
        };
      } else {
        entry.git = {
          is_repo: false,
          commit: null,
          branch: null,
          dirty: null,
          status_porcelain: [],
        };
      }
    }

    results.push(entry);
  }

  return results;
}

// ============================================================================
// 3. Summary 计算
// ============================================================================

function buildSummary(report) {
  const checks = report.checks;
  let pass = 0, fail = 0, warn = 0, skipped = 0;
  const criticalFindings = [];
  const warnings = [];

  // 辅助: 评估单个 check
  function evalCheck(key, isCritical, label) {
    const check = checks[key];
    if (!check) { skipped++; return; }
    if (check.ok) {
      pass++;
    } else {
      if (isCritical) {
        fail++;
        criticalFindings.push(label + ': ' + (check.message || 'FAIL'));
      } else {
        warn++;
        warnings.push(label + ': ' + (check.message || 'WARN'));
      }
    }
  }

  // 关键检查
  evalCheck('git_ok', true, 'Git 仓库状态');
  evalCheck('package_json_ok', true, 'package.json');
  evalCheck('tsc_no_emit', true, 'tsc --noEmit');
  evalCheck('pm2_jlist', true, 'PM2 进程');
  evalCheck('mcp_port_8765', true, 'MCP 端口 ' + MCP_PORT);

  // 非关键检查
  evalCheck('vitest_run', false, 'vitest run');
  evalCheck('heartbeat', false, 'Heartbeat');

  // 数据目录
  for (const [key, dirData] of Object.entries(report.data_dirs)) {
    if (!dirData.exists) {
      warn++;
      warnings.push('数据目录不存在: data/' + key);
    } else {
      pass++;
    }
  }

  // 被管制项目
  for (const proj of report.managed_projects || []) {
    if (!proj.exists) {
      warn++;
      warnings.push('被管制项目不存在: ' + proj.name);
    } else if (proj.git && proj.git.dirty) {
      warn++;
      warnings.push('被管制项目有未提交变更: ' + proj.name);
    } else if (proj.git && proj.git.is_repo) {
      pass++;
    } else {
      pass++;
    }
  }

  // PM2 核心进程检查
  if (report.pm2 && report.pm2.available) {
    const procs = report.pm2.processes || [];
    const mcpProc = procs.find(p => p.name === 'harness-mcp');
    const sentinelProc = procs.find(p => p.name === 'harness-sentinel');

    if (!mcpProc || mcpProc.status !== 'online') {
      fail++;
      criticalFindings.push('harness-mcp 进程不在线');
    }
    if (!sentinelProc || sentinelProc.status !== 'online') {
      fail++;
      criticalFindings.push('harness-sentinel 进程不在线');
    }
  }

  // 确定 overall_status
  let overallStatus = 'PASS';
  if (fail > 0) {
    overallStatus = 'FAIL';
  } else if (warn > 0) {
    overallStatus = 'WARN';
  }

  return {
    overall_status: overallStatus,
    pass_count: pass,
    fail_count: fail,
    warn_count: warn,
    skipped_count: skipped,
    critical_findings: criticalFindings,
    warnings,
  };
}

// ============================================================================
// 4. Markdown 渲染
// ============================================================================

function renderMarkdown(report, jsonRelPath, mdRelPath) {
  const c = report.checks;
  const s = report.summary;

  const statusEmoji = (ok) => ok ? '✅' : '❌';

  let md = '# Harness Baseline Report\n\n';

  // ---- 1. Summary ----
  md += '## 1. Summary\n\n';
  md += '| Metric | Value |\n';
  md += '|---|---|\n';
  md += '| Overall Status | **' + s.overall_status + '** |\n';
  md += '| Pass Count | ' + s.pass_count + ' |\n';
  md += '| Fail Count | ' + s.fail_count + ' |\n';
  md += '| Warn Count | ' + s.warn_count + ' |\n';
  md += '| Skipped Count | ' + s.skipped_count + ' |\n';
  md += '| Generated At | ' + report.generated_at + ' |\n';
  md += '| Duration (ms) | ' + report.duration_ms + ' |\n';
  md += '\n';

  if (s.critical_findings.length > 0) {
    md += '### Critical Findings\n\n';
    for (const f of s.critical_findings) {
      md += '- ❌ ' + f + '\n';
    }
    md += '\n';
  }

  if (s.warnings.length > 0) {
    md += '### Warnings\n\n';
    for (const w of s.warnings) {
      md += '- ⚠️ ' + w + '\n';
    }
    md += '\n';
  }

  // ---- 2. Harness Git Status ----
  md += '## 2. Harness Git Status\n\n';
  md += '| Field | Value |\n';
  md += '|---|---|\n';
  md += '| Commit | `' + report.harness.git.commit.substring(0, 12) + '` |\n';
  md += '| Branch | `' + report.harness.git.branch + '` |\n';
  md += '| Dirty | ' + report.harness.git.dirty + ' |\n';
  if (report.harness.git.dirty && report.harness.git.status_porcelain.length > 0) {
    md += '\n**Uncommitted changes:**\n\n';
    md += '```\n' + report.harness.git.status_porcelain.join('\n') + '\n```\n';
  }
  md += '\n';

  // ---- 3. Runtime ----
  md += '## 3. Runtime\n\n';
  md += '| Field | Value |\n';
  md += '|---|---|\n';
  md += '| Node.js | ' + report.harness.runtime.node_version + ' |\n';
  md += '| npm | ' + report.harness.runtime.npm_version + ' |\n';
  md += '| Platform | ' + report.harness.runtime.platform + ' |\n';
  md += '| Arch | ' + report.harness.runtime.arch + ' |\n';
  md += '| Working Dir | `' + report.harness.root + '` |\n';
  md += '\n';

  // ---- 4. Build & Test Checks ----
  md += '## 4. Build & Test Checks\n\n';
  md += '| Check | Status | Detail |\n';
  md += '|---|---|---|\n';
  md += '| git_ok | ' + statusEmoji(c.git_ok.ok) + ' ' + (c.git_ok.ok ? 'PASS' : 'FAIL') + ' | ' + (c.git_ok.message || '') + ' |\n';
  md += '| package_json_ok | ' + statusEmoji(c.package_json_ok.ok) + ' ' + (c.package_json_ok.ok ? 'PASS' : 'FAIL') + ' | ' + (c.package_json_ok.message || '') + ' |\n';
  md += '| tsc --noEmit | ' + statusEmoji(c.tsc_no_emit.ok) + ' ' + (c.tsc_no_emit.ok ? 'PASS' : 'FAIL') + ' | exit_code=' + c.tsc_no_emit.exit_code + ', ' + c.tsc_no_emit.duration_ms + 'ms |\n';
  md += '| vitest run | ' + statusEmoji(c.vitest_run.ok) + ' ' + (c.vitest_run.ok ? 'PASS' : 'FAIL') + ' | exit_code=' + c.vitest_run.exit_code + ', ' + c.vitest_run.duration_ms + 'ms |\n';
  md += '\n';

  // TSC output details
  if (c.tsc_no_emit.stdout_tail || c.tsc_no_emit.stderr_tail) {
    md += '### tsc --noEmit Output\n\n```\n';
    if (c.tsc_no_emit.stderr_tail) md += c.tsc_no_emit.stderr_tail + '\n';
    if (c.tsc_no_emit.stdout_tail) md += c.tsc_no_emit.stdout_tail + '\n';
    md += '```\n\n';
  }

  // ---- 5. PM2 Processes ----
  md += '## 5. PM2 Processes\n\n';
  if (!report.pm2.available) {
    md += '⚠️ PM2 不可用\n\n';
  } else {
    md += '| Name | Status | PID | Uptime (s) | Memory (bytes) |\n';
    md += '|---|---|---|---|---|\n';
    for (const p of report.pm2.processes) {
      md += '| ' + p.name + ' | ' + p.status + ' | ' + p.pid + ' | ' + p.uptime + ' | ' + p.memory + ' |\n';
    }
    md += '\n';
  }

  // ---- 6. MCP Status ----
  md += '## 6. MCP Status\n\n';
  md += '| Field | Value |\n';
  md += '|---|---|\n';
  md += '| Port | ' + MCP_PORT + ' |\n';
  md += '| Listening | ' + c.mcp_port_8765.listening + ' |\n';
  md += '| Check Status | ' + statusEmoji(c.mcp_port_8765.ok) + ' ' + (c.mcp_port_8765.ok ? 'PASS' : 'FAIL') + ' |\n';
  if (c.mcp_port_8765.raw) {
    md += '\n```\n' + c.mcp_port_8765.raw.trim() + '\n```\n';
  }
  md += '\n';

  // ---- 7. Heartbeat ----
  md += '## 7. Heartbeat\n\n';
  md += '| Field | Value |\n';
  md += '|---|---|\n';
  md += '| File Exists | ' + c.heartbeat.exists + ' |\n';
  md += '| Fresh (<120s) | ' + c.heartbeat.fresh + ' |\n';
  md += '| Age (seconds) | ' + (c.heartbeat.age_seconds !== null ? c.heartbeat.age_seconds : 'N/A') + ' |\n';
  md += '| Last Modified | ' + (c.heartbeat.last_modified || 'N/A') + ' |\n';
  if (c.heartbeat.content) {
    md += '| Content | `' + JSON.stringify(c.heartbeat.content) + '` |\n';
  }
  md += '| Check Status | ' + statusEmoji(c.heartbeat.ok) + ' ' + (c.heartbeat.ok ? 'PASS' : 'FAIL') + ' |\n';
  md += '\n';

  // ---- 8. Data Directories ----
  md += '## 8. Data Directories\n\n';
  md += '| Directory | Exists | Files | JSON Files | Latest Modified |\n';
  md += '|---|---|---|---|---|\n';
  for (const [key, dirData] of Object.entries(report.data_dirs)) {
    md += '| data/' + key + ' | ' + dirData.exists + ' | ' + (dirData.file_count || 0) + ' | ' + (dirData.json_count || 0) + ' | ' + (dirData.latest_modified || 'N/A') + ' |\n';
    // 额外字段
    if (key === 'tokens') {
      md += '|  ↳ consumed (est.) | ' + (dirData.consumed_guess_count || 0) + ' |  |  |  |\n';
      md += '|  ↳ expired (est.) | ' + (dirData.expired_guess_count || 0) + ' |  |  |  |\n';
    }
    if (key === 'sentinel') {
      md += '|  ↳ last 24h events (est.) | ' + (dirData.last_24h_event_guess_count || 0) + ' |  |  |  |\n';
    }
  }
  md += '\n';

  // ---- 9. Managed Projects ----
  md += '## 9. Managed Projects\n\n';
  for (const proj of report.managed_projects) {
    md += '### ' + proj.name + '\n\n';
    md += '| Field | Value |\n';
    md += '|---|---|\n';
    md += '| Root | `' + proj.root + '` |\n';
    md += '| Exists | ' + proj.exists + ' |\n';
    if (proj.exists && proj.git) {
      md += '| Is Git Repo | ' + proj.git.is_repo + ' |\n';
      if (proj.git.is_repo) {
        md += '| Commit | `' + (proj.git.commit || 'N/A').substring(0, 12) + '` |\n';
        md += '| Branch | `' + (proj.git.branch || 'N/A') + '` |\n';
        md += '| Dirty | ' + proj.git.dirty + ' |\n';
        if (proj.git.dirty && proj.git.status_porcelain.length > 0) {
          md += '\n```\n' + proj.git.status_porcelain.join('\n') + '\n```\n';
        }
      }
    }
    md += '\n';
  }

  // ---- 10. Findings ----
  md += '## 10. Findings\n\n';
  if (s.critical_findings.length === 0 && s.warnings.length === 0) {
    md += '✅ 没有发现重大问题。\n\n';
  } else {
    if (s.critical_findings.length > 0) {
      md += '### Critical\n\n';
      for (const f of s.critical_findings) {
        md += '- ❌ ' + f + '\n';
      }
      md += '\n';
    }
    if (s.warnings.length > 0) {
      md += '### Warnings\n\n';
      for (const w of s.warnings) {
        md += '- ⚠️ ' + w + '\n';
      }
      md += '\n';
    }
  }

  // ---- 11. Generated Files ----
  md += '## 11. Generated Files\n\n';
  md += '| File | Path |\n';
  md += '|---|---|\n';
  md += '| JSON | `' + jsonRelPath + '` |\n';
  md += '| Markdown | `' + mdRelPath + '` |\n';
  md += '\n';

  md += '---\n';
  md += '*Generated by baseline-report.cjs at ' + report.generated_at + '*\n';
  md += '*Harness v3.0 Baseline Snapshot — P0-T1*\n';

  return md;
}

// ============================================================================
// 5. 主入口
// ============================================================================

async function main() {
  const startTime = Date.now();
  const errors = [];

  // ── 准备时间戳和输出目录 ──
  const timestamp = getTimestampForFilename();
  ensureDirSync(REPORTS_DIR);

  const jsonFile = path.join(REPORTS_DIR, 'baseline-' + timestamp + '.json');
  const mdFile = path.join(REPORTS_DIR, 'baseline-' + timestamp + '.md');

  // 相对路径（用于 Markdown 报告内引用）
  const jsonRelPath = 'data/reports/baseline/baseline-' + timestamp + '.json';
  const mdRelPath = 'data/reports/baseline/baseline-' + timestamp + '.md';

  console.log('[Baseline] 开始生成 Harness 基线快照...');
  console.log('[Baseline] 报告目录: ' + REPORTS_DIR);
  console.log('');

  // ── 逐模块收集数据 ──

  // 2.1 Git
  console.log('[1/13] 收集 Harness Git 状态...');
  const gitInfo = collectHarnessGit(HARNESS_ROOT);

  // 2.2 Runtime
  console.log('[2/13] 收集运行时信息...');
  const runtimeInfo = collectRuntimeInfo();

  // 2.3 Package
  console.log('[3/13] 收集 package.json 信息...');
  const pkgInfo = collectPackageInfo(HARNESS_ROOT);

  // 2.4 tsc
  console.log('[4/13] 运行 tsc --noEmit...');
  const tscCheck = runTscCheck(HARNESS_ROOT);

  // 2.5 vitest
  console.log('[5/13] 运行 vitest run...');
  const vitestCheck = runVitestCheck(HARNESS_ROOT);

  // 2.6 PM2
  console.log('[6/13] 收集 PM2 进程状态...');
  const pm2Status = collectPm2Status();

  // 2.7 MCP port
  console.log('[7/13] 检查 MCP 端口 ' + MCP_PORT + '...');
  const mcpCheck = checkMcpPort();

  // 2.8 Heartbeat
  console.log('[8/13] 检查 Heartbeat...');
  const heartbeatCheck = checkHeartbeat(HARNESS_ROOT);

  // 2.9 data/tokens
  console.log('[9/13] 统计 data/tokens...');
  const tokenStats = collectTokenStats(TOKEN_DIR);

  // 2.10 data/audit
  console.log('[10/13] 统计 data/audit...');
  const auditStats = collectDirStats(AUDIT_DIR);

  // 2.11 data/sentinel
  console.log('[11/13] 统计 data/sentinel...');
  const sentinelStats = collectSentinelStats(SENTINEL_DIR);

  // 2.12 data/logs
  console.log('[12/13] 统计 data/logs...');
  const logsStats = collectDirStats(LOGS_DIR);

  // 2.13 managed projects
  console.log('[13/13] 检查被管制项目...');
  const managedProjects = collectManagedProjects();

  // ── 组装报告 ──
  const report = {
    schema_version: 1,
    report_type: 'harness_baseline',
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    harness: {
      root: HARNESS_ROOT,
      git: gitInfo,
      runtime: runtimeInfo,
      package: pkgInfo,
    },
    checks: {
      git_ok: {
        ok: gitInfo.commit !== 'unknown',
        message: gitInfo.commit !== 'unknown'
          ? 'Git 仓库正常, branch=' + gitInfo.branch
          : 'Git 状态异常',
      },
      package_json_ok: {
        ok: pkgInfo.ok,
        message: pkgInfo.ok
          ? 'package.json 正常, version=' + pkgInfo.version
          : 'package.json 不存在或解析失败',
      },
      tsc_no_emit: tscCheck,
      vitest_run: vitestCheck,
      pm2_jlist: {
        ok: pm2Status.available && pm2Status.processes.length > 0,
        command: 'pm2 jlist',
        exit_code: pm2Status.exit_code != null ? pm2Status.exit_code : (pm2Status.available ? 0 : 1),
        duration_ms: pm2Status.duration_ms != null ? pm2Status.duration_ms : 0,
        stdout_tail: pm2Status.available ? JSON.stringify(pm2Status.processes.map(p => p.name + '=' + p.status)) : '',
        stderr_tail: pm2Status.available ? '' : (pm2Status.raw_error || 'PM2 not available'),
        message: pm2Status.available
          ? pm2Status.processes.length + ' 个进程'
          : 'PM2 不可用',
      },
      mcp_port_8765: mcpCheck,
      heartbeat: heartbeatCheck,
    },
    pm2: pm2Status,
    mcp: {
      port: MCP_PORT,
      listening: mcpCheck.listening,
    },
    data_dirs: {
      tokens: tokenStats,
      audit: auditStats,
      sentinel: sentinelStats,
      logs: logsStats,
    },
    managed_projects: managedProjects,
    summary: {},
    errors: [],
  };

  // 构建 summary
  report.summary = buildSummary(report);

  // ── 写入 JSON ──
  try {
    await writeJsonAtomic(jsonFile, report);
    console.log('[Baseline] JSON 报告已生成: ' + jsonFile);
  } catch (e) {
    const msg = 'JSON 报告写入失败: ' + e.message;
    console.error('[Baseline] ' + msg);
    errors.push(msg);
  }

  // ── 写入 Markdown ──
  try {
    const md = renderMarkdown(report, jsonRelPath, mdRelPath);
    await writeTextAtomic(mdFile, md);
    console.log('[Baseline] Markdown 报告已生成: ' + mdFile);
  } catch (e) {
    const msg = 'Markdown 报告写入失败: ' + e.message;
    console.error('[Baseline] ' + msg);
    errors.push(msg);
  }

  // ── 控制台输出 ──
  const c = report.checks;
  const s = report.summary;

  console.log('');
  console.log('========================================');
  console.log('  Harness Baseline Report');
  console.log('========================================');
  console.log('');
  console.log('Status: ' + s.overall_status);
  console.log('JSON:   ' + jsonRelPath);
  console.log('MD:     ' + mdRelPath);
  console.log('');
  console.log('Key Checks:');
  console.log('  - git:             ' + (c.git_ok.ok ? 'PASS' : 'FAIL'));
  console.log('  - package.json:    ' + (c.package_json_ok.ok ? 'PASS' : 'FAIL'));
  console.log('  - tsc --noEmit:    ' + (c.tsc_no_emit.ok ? 'PASS' : 'FAIL') + ' (exit=' + c.tsc_no_emit.exit_code + ', ' + c.tsc_no_emit.duration_ms + 'ms)');
  console.log('  - vitest run:      ' + (c.vitest_run.ok ? 'PASS' : 'FAIL') + ' (exit=' + c.vitest_run.exit_code + ', ' + c.vitest_run.duration_ms + 'ms)');
  console.log('  - pm2:             ' + (c.pm2_jlist.ok ? 'PASS' : 'FAIL'));
  console.log('  - mcp :' + MCP_PORT + ':       ' + (c.mcp_port_8765.ok ? 'PASS' : 'FAIL'));
  console.log('  - heartbeat:       ' + (c.heartbeat.ok ? 'PASS' : 'FAIL'));
  console.log('');

  if (s.warnings.length > 0) {
    console.log('Warnings (' + s.warn_count + '):');
    for (const w of s.warnings) {
      console.log('  ⚠  ' + w);
    }
    console.log('');
  }

  if (s.critical_findings.length > 0) {
    console.log('Critical (' + s.fail_count + '):');
    for (const f of s.critical_findings) {
      console.log('  ❌ ' + f);
    }
    console.log('');
  }

  // ── --json 模式: 额外打印 JSON 到 stdout ──
  if (process.argv.includes('--json')) {
    console.log('[Baseline] --json 模式，输出报告 JSON:');
    console.log(JSON.stringify(report, null, 2));
  }

  // ── 退出码 ──
  if (errors.length > 0 && s.overall_status === 'FAIL') {
    console.error('[Baseline] 报告生成有错误，且整体状态为 FAIL');
    process.exit(2);
  }

  if (s.overall_status === 'FAIL') {
    console.log('[Baseline] 报告生成成功，但整体状态为 FAIL (关键检查未通过)');
    process.exit(1);
  }

  console.log('[Baseline] 完成。');
  process.exit(0);
}

// ── 启动 ──
main().catch((err) => {
  console.error('[Baseline] 未捕获异常: ' + err.message);
  console.error(err.stack);
  process.exit(2);
});

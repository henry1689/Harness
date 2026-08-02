/**
 * harness-post-check.cjs v3.0 — 后置审计 + 令牌强制销毁 + 异常闭环
 * ==================================================================
 * PostToolUse hook: 每个 Edit/Write 成功后自动执行。
 *
 * (五) 后置 PostHook & 异常闭环:
 *   1. Token 强制消费（一次性删除）
 *   2. 写入失败也销毁令牌 + 异常卷宗独立归档
 *   3. 绕过检测告警
 *   4. 熔断冷却违规检测
 *   5. 保护区变更记录
 *
 * Failsafe: 崩溃静默，绝不阻塞 Edit 本身
 */

'use strict';
var fs = require('fs');
var path = require('path');

var PROTECTED = ['.claude/settings.json', '.claude/harness', '.claude/workflows', '.claude/hooks'];

var SCRIPT_DIR = typeof __dirname !== 'undefined' ? __dirname : '.';
var AUDIT_DIR = path.resolve(SCRIPT_DIR, '..', 'data', 'audit');
var TOKEN_DIR = path.resolve(SCRIPT_DIR, '..', 'data', 'tokens');
var ALERT_DIR = path.resolve(SCRIPT_DIR, '..', 'data', 'alerts');
var BREAKER_DIR = path.resolve(SCRIPT_DIR, '..', 'data', 'breaker');
var ABNORMAL_DIR = path.resolve(AUDIT_DIR, 'abnormal');

/* ── Read input from stdin (Claude Code passes tool data via stdin, not env var) ── */
var HOOK_INPUT = '';
try {
  var stdinData = fs.readFileSync(process.stdin.fd, 'utf-8');
  if (stdinData && stdinData.trim()) HOOK_INPUT = stdinData.trim();
} catch (_) {
  HOOK_INPUT = process.env.CLAUDE_TOOL_INPUT || '';
}

/* ── Failsafe ── */
try {
  run();
} catch (_) {
  console.log(JSON.stringify({ description: '' }));
}

/* ── Main ── */
function run() {
  var raw = HOOK_INPUT;
  var input = {};
  try {
    var p = JSON.parse(raw);
    if (p && typeof p === 'object') input = p;
  } catch (_) {}

  var fp = input.file_path || input.path || '';
  if (!fp) { console.log(JSON.stringify({ description: '' })); return; }
  var n = String(fp).replace(/\\/g, '/');

  // 🔴 路径归一化：将绝对路径 D:/AI文件/harness/xxx → 相对路径 src/xxx
  // 保证与 token 哈希一致（token 由 MCP 签发时使用相对路径）
  var HARNESS_ROOT = 'D:/AI文件/harness';
  if (n.toUpperCase().indexOf(HARNESS_ROOT.toUpperCase() + '/') === 0) {
    n = n.slice(HARNESS_ROOT.length + 1);
  }

  var isSourceFile = /\.ts$/.test(n) && !/\.test\.ts$|\.spec\.ts$|\.d\.ts$/.test(n);
  var isConfigFile = /\.yaml$|\.json$/.test(n) && !/\.test\./.test(n);

  // (五) 检测写入是否失败
  var writeFailed = input.error || input.exitCode || false;
  var hadError = !!(input.error || (input.exitCode && input.exitCode !== 0));

  /* ── 1. Token 强制消费（无论写入成功/失败，一律销毁） ── */
  if (isSourceFile) {
    var tokenExisted = consumeToken(n);

    // (五) 写入失败 → 异常归档
    if (hadError) {
      archiveAbnormal('write_failure', {
        file: n,
        error: input.error || 'exitCode:' + input.exitCode,
        token_was_present: tokenExisted,
        timestamp: new Date().toISOString()
      });
      console.error('[Harness] WRITE FAILURE on ' + n + '. Token destroyed. Abnormal event archived.');
    }
  }

  /* ── 2. 变更审计 ── */
  if (isSourceFile || isConfigFile) {
    archiveChange('business', n);
  }

  /* ── 3. 绕过检测 ── */
  if (isSourceFile) {
    var hadToken = tokenWasRecentlyConsumed(n);
    if (!hadToken && !hadError) {
      pushAlert('BYPASS', n, 'Source file modified without valid pipeline pass token. Possible pipeline bypass.');
      archiveChange('bypass', n);
    }

    if (isOnCooldown(n)) {
      pushAlert('COOLDOWN_VIOLATION', n, 'File under cooldown lockout was modified.');
      archiveChange('cooldown_violation', n);
    }
  }

  /* ── 4. 保护区告警 ── */
  var hit = false;
  for (var j = 0; j < PROTECTED.length; j++) {
    if (n.indexOf(PROTECTED[j]) === 0 || n.indexOf('/' + PROTECTED[j]) !== -1) {
      hit = true; break;
    }
  }
  if (hit) {
    archiveChange('protected', n);
  }

  /* ── 5. 输出 ── */
  if (hadError) {
    console.log(JSON.stringify({
      description: '[SelfGuard] Write FAILED on ' + n + '. Token destroyed, abnormal event archived. Error: ' + (input.error || 'exit:' + input.exitCode)
    }));
  } else if (hit) {
    console.log(JSON.stringify({
      description: '[Harness] Infrastructure file modified: ' + n + '. Logged to SelfGuard audit.'
    }));
  } else if (isSourceFile) {
    console.log(JSON.stringify({
      description: '[Harness] File changed: ' + n + '. Token consumed. Re-pipeline for next change.'
    }));
  } else {
    console.log(JSON.stringify({ description: '' }));
  }
}

/* ── Token ── */
function consumeToken(filePath) {
  try {
    if (!fs.existsSync(TOKEN_DIR)) return false;
    var hash = hashPath(filePath);
    var tp = path.join(TOKEN_DIR, hash + '.json');
    if (!fs.existsSync(tp)) return false;

    var raw = fs.readFileSync(tp, 'utf-8');
    var token = JSON.parse(raw);
    token.consumed = true;
    token.consumed_at = new Date().toISOString();

    // 先写 consumed 记录，再删 token
    saveConsumedRecord(filePath, token);
    fs.unlinkSync(tp);

    console.error('[Harness] Token consumed: ' + filePath + ' (run: ' + token.run_id + '). One-time use, now destroyed.');

    // 也清理同 run_id 的其他文件 token（防止残留）
    try {
      var files = token.files || [];
      for (var i = 0; i < files.length; i++) {
        var fh = hashPath(files[i]);
        var ftp = path.join(TOKEN_DIR, fh + '.json');
        if (ftp !== tp && fs.existsSync(ftp)) {
          try { fs.unlinkSync(ftp); } catch (_) {}
        }
      }
    } catch (_) {}

    return true;
  } catch (_) { return false; }
}

function tokenWasRecentlyConsumed(filePath) {
  try {
    var rp = path.join(TOKEN_DIR, hashPath(filePath) + '.consumed');
    if (fs.existsSync(rp)) {
      var stat = fs.statSync(rp);
      if (Date.now() - stat.mtimeMs < 120000) return true; // 2min窗口
    }
    return false;
  } catch (_) { return false; }
}

function saveConsumedRecord(filePath, token) {
  try {
    var rp = path.join(TOKEN_DIR, hashPath(filePath) + '.consumed');
    fs.writeFileSync(rp, JSON.stringify({
      file: filePath,
      run_id: token.run_id,
      token_id: token.token_id,
      consumed_at: new Date().toISOString(),
      write_success: true
    }), 'utf-8');
  } catch (_) {}
}

function isOnCooldown(filePath) {
  try {
    if (!fs.existsSync(BREAKER_DIR)) return false;
    var lp = path.join(BREAKER_DIR, hashPath(filePath) + '.lockout.json');
    if (!fs.existsSync(lp)) return false;
    var lockout = JSON.parse(fs.readFileSync(lp, 'utf-8'));
    return Date.now() < (lockout.cooldown_until || 0);
  } catch (_) { return false; }
}

/* ── Alerts ── */
function pushAlert(type, file, detail) {
  try {
    if (!fs.existsSync(ALERT_DIR)) fs.mkdirSync(ALERT_DIR, { recursive: true });
    var d = path.join(ALERT_DIR, new Date().toISOString().slice(0, 10));
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, type + '_' + Date.now() + '.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), type: type, file: file, detail: detail }, null, 2), 'utf-8');
  } catch (_) {}
}

/* ── Audit ── */
function archiveChange(tag, file) {
  try {
    var d = path.join(AUDIT_DIR, tag, new Date().toISOString().slice(0, 10));
    ensureDir(d);
    fs.writeFileSync(path.join(d, 'change_' + Date.now() + '.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), source: 'harness-post-check.cjs', tag: tag, file: file, recorded: true }, null, 2), 'utf-8');
  } catch (_) {}
}

/* ── (五) 异常事件独立归档 ── */
function archiveAbnormal(type, detail) {
  try {
    if (!fs.existsSync(ABNORMAL_DIR)) fs.mkdirSync(ABNORMAL_DIR, { recursive: true });
    var d = path.join(ABNORMAL_DIR, new Date().toISOString().slice(0, 10));
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, type + '_' + Date.now() + '.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), source: 'harness-post-check.cjs', type: type, detail: detail }, null, 2), 'utf-8');
  } catch (_) {}
}

/* ── Utils ── */
function hashPath(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function ensureDir(p) {
  if (fs.existsSync(p)) return;
  var parts = p.replace(/\\/g, '/').split('/');
  var built = '';
  for (var i = 0; i < parts.length; i++) {
    built = built ? path.join(built, parts[i]) : parts[i];
    if (built && !fs.existsSync(built)) fs.mkdirSync(built);
  }
}

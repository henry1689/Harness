#!/usr/bin/env node
/**
 * harness-gate.cjs — Harness Git pre-commit 最后防线 (v3 恢复版)
 * =================================================================
 * P0-T2R: 恢复 Harness v3.0 第三道防线。
 *
 * 职责:
 *   1. 检测当前 Git 仓库 staged files
 *   2. 识别高风险文件
 *   3. 检查 Harness token 目录
 *   4. 无 token 时阻止提交
 *   5. 有匹配 token 时放行
 *   6. 保守策略: 宁可误拦截，不可误放行
 *
 * 使用方式 (由 Git pre-commit hook 调用):
 *   node scripts/harness-gate.cjs
 *
 * 退出码:
 *   0 — 放行 (无高风险文件 或 有匹配 token)
 *   1 — 阻断 (高风险文件无匹配 token)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// P4-C: DiffScopeGuard runtime enforcement for CJS gate
const diffScope = require('../src/project-brain/diff-scope-runtime.cjs');

// 🔴 P4-AB: Token v2 HMAC 验证模块
let tokenVerify = null;
try {
  tokenVerify = require('../src/security/token-verify.cjs');
} catch (_) {
  // P4-AB 前期可能还未安装 — 降级为仅 v1 检查
}

// ============================================================================
// 0. 配置
// ============================================================================

const HARNESS_ROOT = path.resolve(__dirname, '..');
const TOKEN_DIR = path.join(HARNESS_ROOT, 'data', 'tokens');

/**
 * 高风险路径模式列表。
 * 路径已统一转为正斜杠 `/`。
 * 这里的匹配是"高风险"，意味着必须要有 token 才能提交。
 */
const HIGH_RISK_PATTERNS = [
  /^src\/webui\/chat\.ts$/,
  /^src\/m2\//,
  /^src\/m4\//,
  /^src\/m5\//,
  /^src\/engine\//,
  /^src\/core\//,
  /^src\/main_harness_checker\.ts$/,
  /^src\/FlowEngine\.ts$/,
  /^src\/StageRunner\.ts$/,
  /^src\/GateController\.ts$/,
  /^mcp\//,
  /^sentinel\//,
  /^scripts\/harness-gate\.cjs$/,
  /^data\/flows\//,
];

// ============================================================================
// 1. 工具函数
// ============================================================================

/**
 * 从目录递归读取所有 JSON 文件。
 */
function listJsonFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listJsonFiles(full));
      } else if (entry.name.endsWith('.json')) {
        results.push(full);
      }
    }
  } catch (_) { /* skip */ }
  return results;
}

/**
 * 安全解析 JSON，失败返回 null。
 */
function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * 判断文件是否匹配高风险模式。
 * @param {string} relPath - 相对仓库根目录的路径 (使用 / 分隔符)
 * @returns {boolean}
 */
function isHighRisk(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }
  return false;
}

/**
 * 检查 token 是否已过期。
 */
function isTokenExpired(token) {
  const now = Date.now();
  // 检查多种可能的过期字段
  const expCandidates = [
    token.expires_at,
    token.expiresAt,
    token.expires,
  ];
  for (const exp of expCandidates) {
    if (exp) {
      const expMs = new Date(exp).getTime();
      if (!isNaN(expMs) && expMs < now) return true;
    }
  }
  return false;
}

/**
 * 检查 token 是否包含指定文件的授权。
 * @param {object} token - 解析后的 token JSON
 * @param {string} stagedFile - 相对路径 (已标准化为 /)
 * @returns {boolean}
 */
function tokenCoversFile(token, stagedFile) {
  const n = stagedFile.replace(/\\/g, '/');

  // P7-B4: Token v2 的 allowed_paths 字段（优先检查）
  if (Array.isArray(token.allowed_paths) && token.allowed_paths.length > 0) {
    for (const p of token.allowed_paths) {
      const tp = String(p).replace(/\\/g, '/');
      // 精确匹配
      if (tp === n) return true;
      // 目录前缀: src/m5/ → 匹配 src/m5/file.ts
      if (tp.endsWith('/') && n.startsWith(tp)) return true;
      // 递归 glob: src/engine/** → 匹配所有子路径
      if (tp.endsWith('/**') && n.startsWith(tp.slice(0, -3))) return true;
      // 后缀匹配 /src/file.ts 匹配 src/file.ts
      if (n.endsWith('/' + tp) || tp.endsWith('/' + n)) return true;
    }
  }

  // 检查 file (单文件)
  if (token.file) {
    const tf = String(token.file).replace(/\\/g, '/');
    if (tf === stagedFile || tf.endsWith('/' + stagedFile) || stagedFile.endsWith('/' + tf)) {
      return true;
    }
  }

  // 检查 files (文件数组)
  if (Array.isArray(token.files)) {
    for (const f of token.files) {
      const tf = String(f).replace(/\\/g, '/');
      if (tf === stagedFile || tf.endsWith('/' + stagedFile) || stagedFile.endsWith('/' + tf)) {
        return true;
      }
    }
  }

  // 检查 allowed_files
  if (Array.isArray(token.allowed_files)) {
    for (const f of token.allowed_files) {
      const tf = String(f).replace(/\\/g, '/');
      if (tf === stagedFile || tf.endsWith('/' + stagedFile) || stagedFile.endsWith('/' + tf)) {
        return true;
      }
    }
  }

  return false;
}

// ============================================================================
// 2. 主逻辑
// ============================================================================

function main() {
  const repoRoot = (() => {
    try {
      return execSync('git rev-parse --show-toplevel', {
        timeout: 5000,
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
    } catch (_) {
      return null;
    }
  })();

  // 不是 Git 仓库 → 不拦截
  if (!repoRoot) {
    console.log('[Harness Gate] SKIP — not a Git repository.');
    process.exit(0);
  }

  // 获取 staged files
  let stagedRaw;
  try {
    stagedRaw = execSync('git diff --cached --name-only', {
      timeout: 5000,
      encoding: 'utf8',
      cwd: repoRoot,
      windowsHide: true,
    }).trim();
  } catch (e) {
    // P6-SECURITY: fail-close — git 命令失败时也拒绝提交，防止攻击者通过破坏 .git 绕过防线
    // 与其他防线（PreToolUse/Sentinel）的 fail-close 策略保持一致
    console.log('[Harness Gate] BLOCKED — git diff command failed: ' + e.message.substring(0, 100));
    console.log('[Harness Gate] 与其他防线一致，采用 fail-close 策略：不确定 → 拒绝');
    process.exit(1);
  }

  const stagedFiles = stagedRaw
    .split('\n')
    .map(f => f.trim())
    .filter(Boolean);

  // 无 staged files → 放行
  if (stagedFiles.length === 0) {
    console.log('[Harness Gate] PASS — no staged files.');
    process.exit(0);
  }

  // 识别高风险文件
  const highRiskFiles = stagedFiles.filter(isHighRisk);

  // 无高风险文件 → 放行
  if (highRiskFiles.length === 0) {
    console.log('[Harness Gate] PASS — no high-risk staged files.');
    process.exit(0);
  }

  // ── 有高风险文件 → 必须检查 token ──

  console.log('[Harness Gate] High-risk staged files detected:');
  for (const f of highRiskFiles) {
    console.log('  - ' + f);
  }
  console.log('');

  // 检查 token 目录
  if (!fs.existsSync(TOKEN_DIR)) {
    block(highRiskFiles, 'Token directory not found: ' + TOKEN_DIR);
  }

  const tokenFiles = listJsonFiles(TOKEN_DIR);
  if (tokenFiles.length === 0) {
    block(highRiskFiles, 'No token files found in: ' + TOKEN_DIR);
  }

  // 加载所有 token
  const tokens = [];
  for (const tf of tokenFiles) {
    const t = readJsonSafe(tf);
    if (t) tokens.push({ path: tf, data: t });
  }

  if (tokens.length === 0) {
    block(highRiskFiles, 'No valid tokens could be parsed from: ' + TOKEN_DIR);
  }

  // 对每个高风险文件检查是否有有效 token
  const now = Date.now();
  const blockedFiles = [];

  for (const stagedFile of highRiskFiles) {
    let covered = false;

    for (const { path: tokenPath, data: token } of tokens) {
      // 1. 已消费 → 跳过
      if (token.consumed === true) continue;

      // 2. 已过期 → 跳过
      if (isTokenExpired(token)) continue;

      // 3. 检查文件绑定
      if (!tokenCoversFile(token, stagedFile)) continue;

      // 🔴 4. P6-SECURITY: 仅接受 Token v2 (HMAC 签名)
      // 完全移除 v1 明文 token 支持 + secret 缺失时 fail-close
      if (token.version !== 2) {
        console.error(`[Harness Gate] 🚫 Token v1 已禁用 — 仅接受 HMAC 签名的 v2 令牌 (file: ${stagedFile})`);
        try { fs.unlinkSync(tokenPath); } catch (_) {}
        continue;
      }

      if (!tokenVerify || !tokenVerify.isTokenSecretAvailable()) {
        console.error('[Harness Gate] 🔴 HARNESS_TOKEN_SECRET 不可用 — Token 签名验证无法执行，拒绝所有提交');
        // fail-close: secret 缺失时拒绝所有高风险提交，不做安全降级
        block(highRiskFiles, 'HARNESS_TOKEN_SECRET 环境变量未设置 — Token v2 HMAC 签名验证无法执行。请配置 HARNESS_TOKEN_SECRET（至少 32 字节）。');
      }

      const v2Result = tokenVerify.verifyTokenV2(token, stagedFile, { requireStrength: 'strong' });
      if (!v2Result.allowed) {
        console.error(`[Harness Gate] Token v2 验证失败: ${v2Result.reason} (file: ${stagedFile})`);
        continue;
      }

      // 通过所有检查 → 此文件有有效 token
      // P4-C: DiffScopeGuard runtime enforcement.
      // The token must cover not only this high-risk file, but the whole staged diff.
      const scopeResult = diffScope.evaluateTokenScope(token, stagedFiles, { mode: 'strict' });
      if (!scopeResult.allowed) {
        console.error('[Harness Gate] DiffScopeGuard rejected token scope for file: ' + stagedFile);
        console.error(diffScope.formatScopeResult(scopeResult));
        continue;
      }

      // Passed token + HMAC + strength + full staged scope checks.
      covered = true;
      break;
    }

    if (!covered) {
      blockedFiles.push(stagedFile);
    }
  }

  if (blockedFiles.length > 0) {
    block(blockedFiles, 'No valid Harness approval token found for the above high-risk files.');
  }

  // 全部通过
  console.log('[Harness Gate] PASS');
  console.log('All high-risk files have matching Harness approval tokens.');
  process.exit(0);
}

/**
 * 阻断提交，输出清晰提示。
 */
function block(files, reason) {
  console.log('[Harness Gate] BLOCKED');
  console.log('');
  console.log('High-risk staged files require Harness approval token:');
  console.log('');
  for (const f of (Array.isArray(files) ? files : [files])) {
    console.log('  - ' + f);
  }
  console.log('');
  console.log('Reason: ' + reason);
  console.log('');
  console.log('Please run Harness S1→S7 flow first to obtain approval tokens.');
  console.log('');
  console.log('Token directory:');
  console.log('  ' + TOKEN_DIR);
  console.log('');
  console.log('This is the Git pre-commit last defense.');
  process.exit(1);
}

main();

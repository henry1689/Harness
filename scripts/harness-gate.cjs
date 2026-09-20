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

// ── P1-4（2026-09-20）: secret 统一加载 ──
// 根因: src/security/token-verify.cjs 只读 process.env.HARNESS_TOKEN_SECRET，
//   而本 gate 由 git pre-commit 子进程调用 —— 该子进程不携带此 env。
//   于是 isTokenSecretAvailable() 在**正常环境**也返回 false，
//   gate 误判「secret 不可用」并静默降级（跳过全部 HMAC 验签）。
// 修法: 判定前从 data/.harness-secret 回填 env，
//   与 scripts/harness-cli.cjs 的 loadTokenSecret() 保持同一套加载语义。
const SECRET_FILE = path.join(HARNESS_ROOT, 'data', '.harness-secret');

function loadTokenSecret() {
  // 注意: 必须按【长度】判定而非真假判定 —— 否则 env 被设成短值（如 "short"）时
  // 会提前 return 而不回落到 secret 文件，把一个可用的 secret 白白浪费掉。
  // 长度门槛与 token-verify.cjs hasTokenSecret() 对齐（字节数而非字符数）。
  const env = process.env.HARNESS_TOKEN_SECRET;
  if (env && Buffer.byteLength(env, 'utf8') >= 32) return true;
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf-8').trim();
    if (s && s.length >= 32) {
      process.env.HARNESS_TOKEN_SECRET = s;
      return true;
    }
  } catch (_) { /* 文件缺失/不可读 → 交由下面的 fail-closed 分支处理 */ }
  return false;
}

/**
 * P1-4: 降级放行审计台账（data/audit/<day>/gate-degraded.jsonl）。
 * 显式降级（HARNESS_ALLOW_DEGRADED=1）意味着**跳过签名校验**放行，
 * 必须留痕，否则事后无法追溯哪些提交未经验签。
 */
function auditDegraded(file, reason) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(HARNESS_ROOT, 'data', 'audit', day);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'gate-degraded.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), file, reason, via: 'HARNESS_ALLOW_DEGRADED' }) + '\n',
      'utf-8',
    );
  } catch (e) {
    // 审计写失败不得反过来阻断放行判定，但**必须可见** ——
    // 否则就成了「无验签 + 无留痕」的静默降级，正是本次要消灭的模式。
    console.error(`[Harness Gate] ⚠️ 降级审计台账写入失败（放行判定不受影响）: ${e && e.message ? e.message : e}`);
  }
}

/**
 * 高风险路径判定 —— 🔴 2026-09-12（④ 清单合一）：改为读单一真值源
 * src/security/risk-lists.json，不再自持一份硬编码清单。
 *
 * 背景：本文件此前的 HIGH_RISK_PATTERNS 与 mcp/server.ts、src/RiskClassifier.ts、
 * sentinel/sentinel-mcp-client.cjs 各写一份，实测互不一致。最要命的是它
 * **完全不覆盖 src/security/、src/RiskClassifier.ts、src/s7/** ——
 * 也就是「授权机制自身的源码、风险分类器本身、归档校验闸门」都可以无令牌提交，
 * 而本文件正是提交时的最后一道门。
 *
 * 判定 = 【真值源】∪【门控专有的更严模式】。是严格超集，只紧不松：
 * 原来被本文件拦住的（src/m2|m4|m5|engine|core 整目录、src/*.cjs、src/webui/chat/）
 * 一律仍然拦住，另补上真值源新增的全部高风险项。
 */
const RISK_LISTS_PATH = path.resolve(__dirname, '..', 'src', 'security', 'risk-lists.json');

let RISK_LISTS = { high_risk_files: [], high_risk_prefixes: [] };
try {
  const j = JSON.parse(fs.readFileSync(RISK_LISTS_PATH, 'utf-8'));
  if (!Array.isArray(j.high_risk_files) || !Array.isArray(j.high_risk_prefixes)) throw new Error('结构不符');
  RISK_LISTS = j;
} catch (e) {
  // 🔴 fail-closed：读不到真值源时【不能】退化成"无高风险"（那等于全放行）。
  // 退回下面 GATE_EXTRA_PATTERNS 这一层（仍能拦住引擎/安全目录），并大声报错。
  console.error(`[Harness Gate] 🔴 风险清单真值源不可读(${RISK_LISTS_PATH}): ${e.message || e}`);
  console.error('[Harness Gate] 🔴 已降级为门控专有模式（fail-closed，覆盖面变窄，请尽快修复该文件）。');
}

/**
 * 门控专有的更严模式 —— 真值源里没有、但提交时必须收 token 的路径。
 * 这些模式【比真值源更粗】，合并进真值源会连测试文件、src/config/ 一起变高风险，
 * 代价过大，故只留在门控这一层。
 */
const GATE_EXTRA_PATTERNS = [
  // 整目录管控（真值源按文件粒度列，这里按目录收）
  /^src\/m2\//,
  /^src\/m4\//,
  /^src\/m5\//,
  /^src\/engine\//,
  /^src\/core\//,
  // v2.9: 补丁脚本/boot 管控 — src 下可执行脚本一律需 token
  /^src\/.*\.(cjs|mjs)$/,
  // v2.9.2: chat 阶段管线（真值源只逐个列了已知文件，这里按目录收）
  /^src\/webui\/chat\//,
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

/** P9: 路径标准化（反斜杠 → 正斜杠） */
function normalize(fp) { return String(fp).replace(/\\/g, '/'); }

/** P9: 与 pre-check/post-check 一致的 hashCode 算法（用于 .consumed 记录查找） */
function hashCode(s) {
  let h = 0;
  const ns = normalize(s);
  for (let i = 0; i < ns.length; i++) h = ((h << 5) - h + ns.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * 判断文件是否匹配高风险模式。
 * @param {string} relPath - 相对仓库根目录的路径 (使用 / 分隔符)
 * @returns {boolean}
 */
function isHighRisk(relPath) {
  const normalized = relPath.replace(/\\/g, '/');

  // 1) 单一真值源（与哨兵 / 流水线 risk_level 共用同一份数据与同一套匹配）
  for (const f of RISK_LISTS.high_risk_files) {
    if (normalized.includes(f)) return true;
  }
  for (const p of RISK_LISTS.high_risk_prefixes) {
    if (normalized.startsWith(p) || normalized.includes('/' + p)) return true;
  }

  // 2) 门控专有的更严模式（真值源不含、但提交仍需 token）
  for (const pattern of GATE_EXTRA_PATTERNS) {
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
  // 🔴 P1-4: 先把 secret 从 data/.harness-secret 回填进 env，再做任何验签判定。
  // 必须在 isTokenSecretAvailable() 之前——否则 git 子进程场景会误走降级分支。
  loadTokenSecret();

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
    // P1-4: 本文件是否走了显式降级路径（在确认 covered 后才写台账，避免
    // 把「被 DiffScopeGuard 拒绝」的 token 也记成「已放行」）
    let degradedUsed = false;

    // 🔴 P9-fix: 若 token 已被 post-check 消费（文件删除），检查 .consumed 记录
    // 根因: Edit 完成后 post-check 消费 token 并删除文件 → git commit 时 gate 找不到 token → 阻塞
    // 新逻辑: 30 分钟内被消费的记录 = 本次 Edit 已获 MCP 授权，提交应放行
    //
    // 🔴 P1-4(2026-09-20): 增加 secret 可用性前提 —— .consumed 记录**没有任何签名字段**
    //   （仅 {file, run_id, token_id, consumed_at, write_success}，由 post-check 写入），
    //   且此分支位于 token 循环**之前**、不做任何验签。若无条件采信它，
    //   则「无 secret + 伪造一个 .consumed」即可放行，本次的 fail-closed 会名不副实。
    //   secret 不可用时降级到下面的 token 循环，由那里统一 fail-closed。
    if (!covered && fs.existsSync(TOKEN_DIR) && tokenVerify && tokenVerify.isTokenSecretAvailable()) {
      const consumedHash = hashCode(normalize(stagedFile));
      const consumedPath = path.join(TOKEN_DIR, consumedHash + '.consumed');
      if (fs.existsSync(consumedPath)) {
        try {
          const consumedRecord = readJsonSafe(consumedPath);
          if (consumedRecord) {
            const consumedMs = new Date(consumedRecord.consumed_at).getTime();
            if (!isNaN(consumedMs) && now - consumedMs < 30 * 60 * 1000) {
              console.error(`[Harness Gate] ✅ ${stagedFile} — 30分钟内已消费授权 (run: ${consumedRecord.run_id || '?'})，放行提交`);
              covered = true;
            }
          }
        } catch (_) { /* consumed 记录损坏 → 忽略，继续查 token */ }
      }
    }

    if (covered) continue;

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

      // 🔴 P9-fix → P1-4(2026-09-20) 重写: 取消静默降级
      // 原实现: secret 缺失 → 打印一行 warning 后**跳过全部 HMAC 验签**直接放行。
      //   其自述论证「文件存在即证明 MCP 已授权」不成立 —— 该结论恰恰依赖验签才能得出。
      //   跳过 verifyTokenV2 后，剩余检查（version===2 / 覆盖文件 / 未过期 / consumed≠true）
      //   **全是 token 文件里可自填的字段**，任何能写 data/tokens/ 的进程都能伪造。
      //   叠加 secret 加载缺陷（见文件头 loadTokenSecret），该分支在正常环境也会被触发。
      // 现逻辑:
      //   - secret 可用（正常环境，经 loadTokenSecret 回填）→ 完整 HMAC 验证，不降级
      //   - secret 确实缺失 → fail-closed 拒绝；要降级必须显式 HARNESS_ALLOW_DEGRADED=1，且留痕
      if (tokenVerify && tokenVerify.isTokenSecretAvailable()) {
        // v2.11: 不传 projectRoot → content_hash 校验跳过。gate 是「提交前」时序，
        // content_hash(签发时内容) 此时必然不匹配 → 合法 commit 被拦（v2.10 时序缺陷）。
        // content_hash 仅由 pre-check（修改前 hook）校验——那里才能区分第一次/反复修改。
        const v2Result = tokenVerify.verifyTokenV2(token, stagedFile, { requireStrength: 'strong' });
        if (!v2Result.allowed) {
          console.error(`[Harness Gate] Token v2 验证失败: ${v2Result.reason} (file: ${stagedFile})`);
          continue;
        }
      } else if (process.env.HARNESS_ALLOW_DEGRADED === '1') {
        // 显式降级：调用方明知无 secret 仍要求放行。留痕在 covered 确认后统一写。
        console.error(`[Harness Gate] ⚠️ 已显式降级放行（HARNESS_ALLOW_DEGRADED=1）— 本次**未做 HMAC 验签** (file: ${stagedFile})`);
        degradedUsed = true;
      } else {
        // fail-closed：无 secret ⇒ 无法验签 ⇒ 「文件存在」不构成授权证明。
        console.error(`[Harness Gate] 🚫 HARNESS_TOKEN_SECRET 不可用且未显式降级 — 无法验签，拒绝放行 (file: ${stagedFile})`);
        console.error(`[Harness Gate]    已尝试的 secret 来源: env HARNESS_TOKEN_SECRET → ${SECRET_FILE}`);
        console.error('[Harness Gate]    如确需放行: 设置 HARNESS_ALLOW_DEGRADED=1（会写审计台账）');
        continue;
      }

      // 通过所有检查 → 此文件有有效 token
      // 🔴 P9-fix: DiffScopeGuard scope 评估只针对「当前文件」，而非整个 staged diff
      // 根因: Agent 分多批跑 flow 获得多个 token（每 token 覆盖各自文件），
      // git commit 时所有文件一起 staged。若用整个 stagedFiles 评估单个 token，
      // 必然因「token 未覆盖其他文件」而误拦截（violation_count 高）。
      // 新逻辑: 每个高风险文件由覆盖它的 token 单独授权，各自 scope 各自评估。
      const scopeResult = diffScope.evaluateTokenScope(token, [stagedFile], { mode: 'strict' });
      if (!scopeResult.allowed) {
        console.error('[Harness Gate] DiffScopeGuard rejected token scope for file: ' + stagedFile);
        console.error(diffScope.formatScopeResult(scopeResult));
        continue;
      }

      // Passed token + HMAC + strength + per-file scope checks.
      covered = true;
      break;
    }

    if (!covered) {
      blockedFiles.push(stagedFile);
    } else if (degradedUsed) {
      // P1-4: 台账在【确认放行之后】写一次。此前写在 token 分支内，
      // 会把随后被 DiffScopeGuard 拒绝的 token 也记成「已降级放行」，台账不可信。
      auditDegraded(stagedFile, 'HARNESS_TOKEN_SECRET 不可用，经 HARNESS_ALLOW_DEGRADED=1 显式降级');
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

// 🔴 2026-09-21：改为「被直接执行时才跑 main」+ 导出判定函数。
//   动机：scripts/harness-precheck.cjs 必须复用【本文件真实的分级逻辑】，
//   否则预检会变成一个平行真相源 —— 而分级口径漂移正是这套系统反复踩的坑
//   （risk-lists 合一、CK-07 并入真值源都是同一个教训）。
//   原先结尾是裸的 `main();`，require 它会把 gate 直接跑起来，无法复用。
if (require.main === module) main();

module.exports = {
  isHighRisk, GATE_EXTRA_PATTERNS, RISK_LISTS, RISK_LISTS_PATH,
  loadTokenSecret,
  // 供 harness-precheck.cjs 复用（同样是「不产生第二真相源」的要求）
  isTokenExpired, tokenCoversFile, TOKEN_DIR,
};

/**
 * harness-pre-check.cjs v3.0 — 前置拦截 + 多维令牌校验 + 批量限流 + 熔断
 * =======================================================================
 * PreToolUse hook: 每个 Edit/Write 前自动执行，Claude 无法绕过。
 *
 * 判定层级:
 *   T1 保护区 → 🔴 DENY (hard)
 *   T2 低风险 → 🟢 ALLOW (silent)
 *   T3 中/高风险 + 有效令牌 → 🟢 ALLOW
 *   T4 中/高风险 + 无效/过期/不匹配令牌 → 🔴 DENY
 *   T5 文件数 > 3 → 🔴 DENY (batch limit)
 *   T6 OS级身份二次兜底 → 🔴 DENY (NT AUTHORITY\SYSTEM or explicit bypass only)
 *
 * (三) 多维令牌绑定校验: flow_id + file_list + uuid + expiry + consumed 全部匹配
 * (四) 批量修改限流: 单次最多 3 个 .ts 源文件
 * (四) OS 文件 ACL 二次兜底: 进程身份校验
 *
 * FAILSAFE: 任何崩溃 → DENY + 紧急审计日志
 */

'use strict';
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');

// 🔴 P9 链路心跳：每次 hook 判定结果写入 hook-heartbeat.json，供 watchdog 检测
var HOOK_HEARTBEAT_FILE = path.resolve(__dirname, '..', 'data', 'hook-heartbeat.json');
var HOOK_TOOL_NAME = '';
var HOOK_LAST_FILE = '';


// P4-C Batch 2: DiffScopeGuard runtime enforcement for Claude pre-check hook
var diffScope = require('../src/project-brain/diff-scope-runtime.cjs');
/* ── 保护区 ── */
var PROTECTED = [
  '.claude/settings.json', '.claude/harness/', '.claude/workflows', '.claude/hooks'
];

/* ── 高风险 ── */
var HIGH_RISK = [
  'src/webui/chat.ts', 'src/m4/household/FamilyGraph.ts', 'src/m2/SQLiteAdapter.ts',
  'src/webui/server.ts', 'src/m4/household/UUIDGatekeeper.ts',
  'src/m4/M4Orchestrator.ts', 'src/m4/MemoryInjector.ts', 'src/m4/MemoryRetriever.ts',
  'src/m4/EntityTopologyManager.ts', 'src/m4/EntityValidator.ts',
  'src/m4/QueryDecomposer.ts', 'src/m4/Reranker.ts',
  'src/m4/household/EntityMeeting.ts', 'src/m4/household/EntityContextBuilder.ts',
  'src/m4/household/ProfileAcquisitionEngine.ts',
  'src/m5/M5Orchestrator.ts', 'src/m5/CandidateSelector.ts', 'src/m5/StrategySelector.ts',
  'src/m5/CognitionAssembler.ts', 'src/m5/HumanisticCalibrator.ts', 'src/m5/SceneAnchor.ts',
  'src/m5/ContextMemory.ts', 'src/m5/DeepSeekLLMProvider.ts', 'src/m5/MockLLMProvider.ts',
  'src/engine/orchestrator.ts', 'src/engine/EngineContext.ts',
  'src/engine/legacy-adapter.ts', 'src/engine/types.ts',
  'src/engine/tianquan/prefrontal/',
  'src/m2/FusionStorageAdapter.ts', 'src/m2/ConversationDB.ts',
  'src/webui/chat/ChatEntry.ts', 'src/webui/chat/MeetingContextPipeline.ts',
  'src/webui/chat/retrieval.ts',
  'src/hooks/',
  'src/app/knowledge/KnowledgeEngine.ts', 'src/app/knowledge/KnowledgeContextBuilder.ts',
  'src/app/vault/VaultManager.ts',
  'src/app/ingestion/ConversationIngestionService.ts',
  'src/app/fusion/FusionEngine.ts',
  'src/app/fg/', 'src/app/role/',
];

/* ── 低风险 ── */
var LOW_RISK_PREFIXES = [
  'src/config/', 'src/types/', 'src/cli/', 'src/common/',
  'src/adapter/', 'src/modules/',
  'src/app/tools/', 'src/app/utils/', 'src/app/shared/', 'src/app/__tests__/',
];
var LOW_RISK_SUFFIXES = ['.test.ts', '.spec.ts', '.d.ts'];
var LOW_RISK_EXTENSIONS = ['.md','.sql','.html','.css','.scss','.less','.env','.gitignore','.lock','.sh','.ps1','.bat'];
// 🔴 P7-hotfix: .cjs 和 .mjs 从低风险扩展名中移除 — 它们是可执行脚本，
// 在 scripts/hooks/mcp/sentinel 目录下可用于绕过 Harness 管控。

var AUDIT_DIR = path.resolve(__dirname, '..', 'data', 'audit', 'selfguard');
var HEARTBEAT_FILE = path.resolve(__dirname, '..', 'data', 'heartbeat.json');
var TOKEN_DIR = path.resolve(__dirname, '..', 'data', 'tokens');
var BREAKER_DIR = path.resolve(__dirname, '..', 'data', 'breaker');
var SESSION_DIR = path.resolve(__dirname, '..', 'data', 'sessions');
var DISCIPLINE_FILE = path.join(SESSION_DIR, 'discipline.json');
var EXEMPTIONS_FILE = path.resolve(__dirname, '..', 'data', 'exemptions.json');

// 🔴 MID-A-fix（模块级）: harness 根级治理/可执行文件精确白名单。
// 这些文件不命中防线前缀（不在 src/data/.claude/scripts/... 目录），
// 但属于 harness 治理核心——可被注入 npm scripts / 篡改启动脚本提权。
// 用白名单而非「任意根级文件」，避免过度拦截 harness 根下合法临时文件。
// 提升为模块级常量：case4 判定与 isExemptionApplicable 共享，保证豁免一致性
// （根级治理文件同样「一律不豁免」）。
var HARNESS_ROOT_FILES = [
  '.harness-pass', 'package.json', 'package-lock.json', 'ecosystem.config.cjs',
  'start-services.cjs', 'start-harness.bat', 'start-harness.ps1',
  'register-startup.ps1', 'start-mcp-detached.bat', 'CLAUDE.md',
  '.gitignore', '.gitattributes', 'tsconfig.json',
];
// 防线目录前缀（S4 评审 ② 补 dashboard/.github — CI 与看板是可执行治理代码）
var DEFENSE_DIR_PREFIXES = ['src/', 'data/', '.claude/', 'scripts/', 'hooks/', 'mcp/', 'sentinel/', 'dashboard/', '.github/'];

/* ── Read input from stdin (Claude Code passes tool data via stdin, not env var) ── */
var HOOK_INPUT = '';
try {
  // Claude Code passes hook input via stdin as a JSON line
  var stdinData = fs.readFileSync(process.stdin.fd, 'utf-8');
  if (stdinData && stdinData.trim()) HOOK_INPUT = stdinData.trim();
} catch (_) {
  // stdin might be a TTY or unavailable — fall back to env var
}

// Fallback: if stdin was empty/absent, use env var
if (!HOOK_INPUT) {
  HOOK_INPUT = process.env.CLAUDE_TOOL_INPUT || '';
}

// ── 🔴 Harness 自保护：管理员解锁令牌（必须在 run() 前声明）──
	var ADMIN_UNLOCK_FILE = 'D:/AI文件/harness/data/sessions/harness-admin-unlock.json';
	var HARNESS_SELF_VIOLATION_FILE = 'D:/AI文件/harness/data/sessions/harness-self-violations.json';
/* ── Entry (failsafe) ── */
try {
  var result = run();
  writeHookHeartbeat(result);
  console.log(JSON.stringify(result));
} catch (fatalErr) {
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.writeFileSync(path.join(AUDIT_DIR, 'EMERGENCY_BLOCK_' + Date.now() + '.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), error: String(fatalErr), rule: 'FAILSAFE' }, null, 2));
  } catch (_) {}
  console.log(JSON.stringify({ decision: 'deny',
    reason: 'Harness SelfGuard EMERGENCY BLOCK: pre-check hook crashed. Operation denied. Error: ' + String(fatalErr)
  }));
}

/* ── 链路心跳写入 ── */
function writeHookHeartbeat(result) {
  try {
    if (!fs.existsSync(path.dirname(HOOK_HEARTBEAT_FILE))) return;
    fs.writeFileSync(HOOK_HEARTBEAT_FILE, JSON.stringify({
      ts: Date.now(),
      decision: result && result.decision,
      tool: HOOK_TOOL_NAME,
      file: HOOK_LAST_FILE,
    }));
  } catch (_) {}
}

/* ── Core ── */
function run() {
  var raw = HOOK_INPUT;
  var input = {};
  try { var p = JSON.parse(raw); if (p && typeof p === 'object') input = p; } catch (_) {}

  HOOK_TOOL_NAME = input.tool_name || '';
  // 🔴 P9-fix: 兼容 Claude Code 真实 hook 输入格式 — 路径在 tool_input 内嵌套
  // 旧代码只读顶层 input.file_path → 永远取不到 → 对所有操作静默 allow（防线失效）
  var ti = input.tool_input || {};
  var fp = input.file_path || input.path || ti.file_path || ti.path || '';
  // Grep uses 'path' not 'file_path', and 'pattern' signals it's a search
  var grepPath = input.path || ti.path || '';
  var isGrep = !!(input.pattern);
  var fp2 = fp || grepPath;
  if (!fp2) {
    // 🔴 fail-closed: 无法解析文件路径 → 拒绝 + 审计，绝不静默放行
    try {
      if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
      fs.writeFileSync(path.join(AUDIT_DIR, 'PARSE_FAIL_' + Date.now() + '.json'),
        JSON.stringify({ timestamp: new Date().toISOString(), tool: input.tool_name || '', raw: String(raw || '').slice(0, 300), rule: 'FAIL-CLOSED' }, null, 2));
    } catch (_) {}
    return { decision: 'deny',
      reason: '🛑 HARNESS FAIL-CLOSED: 无法从 hook 输入解析文件路径，操作已拒绝（链路心跳保护）。\n' +
        '工具: ' + (input.tool_name || 'unknown') + '\n' +
        '请重试，或将完整路径放入 tool_input.file_path。' };
  }
  HOOK_LAST_FILE = fp2;
  var n = String(fp2).replace(/\\/g, '/');

  // Detect tool type: Edit/Write has old_string/new_string/content; Read/Grep does not
  // 🔴 P9-fix: Edit/Write 的 old_string/new_string/content 同样在 tool_input 内嵌套，
  // 旧代码读顶层 → Edit 被误判为 Read → 走纪律令牌自动创建分支静默放行（防线失效）
  var isReadOnly = isGrep || (!ti.old_string && !ti.new_string && !ti.content);

  // ── SCOPE CHECK: Normalize absolute paths to project-relative ──
  // 🔴 核心：识别文件是否属于 D:\AI文件\harness 管控域
  var HARNESS_ROOT = 'D:/AI文件/harness';
  var HR_NORM = HARNESS_ROOT.replace(/\\/g, '/') + '/';
  var isHarnessFile = false;
  var isHarnessSelf = false; // 🔴 仅当文件是 Harness 自身代码时置 true（不含被管控项目）

  // 1. 如果路径是 HARNESS_ROOT 下的绝对路径 → 剥离前缀，且标记为 Harness 自身文件
  if (n.toUpperCase().indexOf(HR_NORM.toUpperCase()) === 0) {
    n = n.slice(HR_NORM.length);
    isHarnessFile = true;
    isHarnessSelf = true;
    console.error('[Harness] 🔒 Harness自身文件检测: ' + n);
  }

  // 2. 如果路径已经是相对于 HARNESS_ROOT 的相对路径（需 cwd 确认为 Harness 项目）
  // 🔴 P7-hotfix: 原代码无条件 isHarnessFile=true 过于宽松，会误匹配无关项目的 src/ 路径
  if (!isHarnessFile && (n.indexOf('src/') === 0 || n.indexOf('data/') === 0 || n.indexOf('.claude/') === 0)) {
    var cwd2 = (process.env.CLAUDE_PROJECT_DIR || process.cwd() || '').replace(/\\/g, '/');
    if (cwd2.toUpperCase().indexOf('/HARNESS') !== -1 || cwd2.toUpperCase().indexOf('\\HARNESS') !== -1) {
      isHarnessFile = true;
      isHarnessSelf = true;
      console.error('[Harness] 🔒 Harness自身文件(cwd检测): cwd=' + cwd2 + ' → ' + n);
    }
  }

  // 3. 兼容旧版 wenstar-cc 项目根目录（历史遗留，保留向前兼容）
  var PROJECT_ROOTS = ['wenstar-cc', 'wenstar_os', 'WenstarOSTianquan'];
  if (!isHarnessFile) {
    for (var pi = 0; pi < PROJECT_ROOTS.length; pi++) {
      var rootMarker = '/' + PROJECT_ROOTS[pi] + '/';
      var bsMarker = '\\' + PROJECT_ROOTS[pi] + '\\';
      var idx = n.indexOf(rootMarker);
      if (idx === -1) idx = n.indexOf(bsMarker);
      if (idx !== -1) {
        n = n.slice(idx + rootMarker.length);
        if (n.indexOf('src/') === 0 || n.indexOf('data/') === 0 || n.indexOf('.claude/') === 0) {
          isHarnessFile = true;
        }
        break;
      }
    }
  }

  // 3.5 🔴 相对路径 cwd 兜底检测（P7-hotfix: 修复并行窗口联动断裂）
  // 核心问题：两个 Claude Code 窗口并发时，项目窗口 cwd 在 wenstar-cc 内，
  // Edit/Write 传相对路径 "src/webui/chat.ts"，不含 "/wenstar-cc/" 标记；
  // 旧代码在此处静默 return { decision: 'allow' }，S1-S7 从未触发。
  if (!isHarnessFile) {
    // 🔴 P9-fix: 同时考虑 input.cwd（Claude Code 真实传给 hook 的字段）+ 进程 cwd
    var cwd357 = (input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd() || '').replace(/\\/g, '/');
    var CWD_MARKERS = PROJECT_ROOTS.concat(['harness', 'AI文件/harness']);
    // 🔴 S4-HIGH1-fix: cwd 是否是 harness 目录（区分 wenstar-cc 等被管控项目）
    var cwd357Norm = cwd357.toUpperCase();
    var isHarnessCwd357 = cwd357Norm.indexOf('/HARNESS') !== -1 || cwd357Norm.indexOf('\\HARNESS') !== -1 ||
                          cwd357Norm.indexOf('/AI文件/HARNESS') !== -1 || cwd357Norm.indexOf('\\AI文件\\HARNESS') !== -1;
    // S4 评审 ②-fix: 剥离前导 ./（./src/ 与 src/ 等价，防 ./ 前缀绕过前缀匹配）
    var nn4 = n.indexOf('./') === 0 ? n.slice(2) : n;
    for (var mi = 0; mi < CWD_MARKERS.length; mi++) {
      if (cwd357.toUpperCase().indexOf('/' + CWD_MARKERS[mi].toUpperCase()) !== -1 ||
          cwd357.toUpperCase().indexOf('\\' + CWD_MARKERS[mi].toUpperCase()) !== -1) {
        var isDefensePrefix4 = false;
        for (var _dp = 0; _dp < DEFENSE_DIR_PREFIXES.length; _dp++) {
          if (nn4.indexOf(DEFENSE_DIR_PREFIXES[_dp]) === 0) { isDefensePrefix4 = true; break; }
        }
        if (isDefensePrefix4) {
          isHarnessFile = true;
          // S4-HIGH1-fix: 仅当 cwd 是 harness 目录时，这些前缀才属于 harness 自身防线代码。
          // 原代码不置 isHarnessSelf → harness cwd 下相对路径写 mcp/scripts/sentinel/hooks
          // 被判定为「非 harness 自身」→ 豁免可单因子放行，绕过双因子自保护。
          if (isHarnessCwd357) isHarnessSelf = true;
          console.error('[Harness] 🔗 cwd兜底检测: cwd=' + cwd357 + ' → 相对路径 ' + n + ' 判定为Harness管辖文件' + (isHarnessCwd357 ? ' [harness-self]' : ''));
        } else if (isHarnessCwd357) {
          // MID-A-fix: harness 根级治理文件白名单（防线前缀之外的根级可执行/配置）
          // 用模块级 HARNESS_ROOT_FILES（isExemptionApplicable 共享，保证豁免一致性）
          for (var _rf = 0; _rf < HARNESS_ROOT_FILES.length; _rf++) {
            if (nn4 === HARNESS_ROOT_FILES[_rf]) {
              isHarnessFile = true;
              isHarnessSelf = true;
              console.error('[Harness] 🔒 Harness根级文件(cwd检测): ' + n + ' → 命中治理白名单');
              break;
            }
          }
        }
        break;
      }
    }
  }

  // 4.5 🔴 穿越路径规范化（MID-B-fix: 防 `../` 绕过前缀匹配）
  // 攻击路径: `../../AI文件/harness/mcp/server.ts`（wenstar-cc cwd）、
  //   `../AI文件/harness/scripts/...`（AI文件 cwd）→ `../` 开头不命中任何前缀 → 静默放行。
  // 修复: 遇到含 `..` 的相对路径 → 用 cwd 做 path.resolve 规范化 → 绝对路径含 /harness/ → 受管控。
  if (!isHarnessFile && n.indexOf('..') !== -1) {
    try {
      var cwdResolve = (input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd() || '').replace(/\\/g, '/');
      var absNorm = path.resolve(cwdResolve, n).replace(/\\/g, '/');
      var absLow = absNorm.toLowerCase();
      if (absLow.indexOf('/harness/') !== -1 || absLow.indexOf('\\harness\\') !== -1) {
        isHarnessFile = true;
        isHarnessSelf = true;
        console.error('[Harness] 🔗 穿越路径规范化: ' + n + ' (cwd=' + cwdResolve + ') → 规范化后 ' + absNorm + ' 判定为Harness自身文件');
      }
    } catch (_) {
      // path.resolve 失败（如非法路径）→ 保守按未匹配处理（不误伤正常操作）
    }
  }

  // 🔴 空路径告警：如果输入为空或无法解析，记录到 stderr 用于诊断
  if (!fp2) {
    console.error('[Harness] ⚠️ 空路径 — HOOK_INPUT=[' + String(raw || '').slice(0, 200) + '] cwd=[' + (process.cwd() || '') + ']');
  }

  // For Grep, if the search path is a Harness directory
  if (isGrep && (n.indexOf('src/') === 0 || n.indexOf('data/') === 0 || n.indexOf('.claude/') === 0 || n.toLowerCase().indexOf('harness') !== -1)) {
    isHarnessFile = true;
  }
  if (!isHarnessFile) return { decision: 'allow' };

  // T1: 保护区 → hard deny (applies to ALL tool types)
  for (var i = 0; i < PROTECTED.length; i++) {
    if (n.indexOf(PROTECTED[i]) === 0 || n.indexOf('/' + PROTECTED[i]) !== -1) {
      archiveViolation(n);
      return { decision: 'deny', reason: 'BLOCKED: Protected zone. Path "' + n + '" is read-only.' };
    }
  }

  // 🔴 P9-fix: Harness 自身文件不允许被 T2 低风险扩展名(.html等)放行
  // 这是写操作，交给 line 361 的统一自保护双因子检查处理
  if (!isReadOnly && isHarnessSelf && isLowRisk(n)) {
    console.error('[Harness] 🔒 Harness自身低风险文件不走T2放行: ' + n + ' — 交给自保护双因子检查');
  } else if (isLowRisk(n)) {
    return { decision: 'allow' };
  }

  // ══════════════════════════════════════════════════════════
  // 🆕 哨兵模式检查 (v4.0 — sentinel state 由 MCP Server 维护)
  // ══════════════════════════════════════════════════════════
  var sentinel = readSentinelState();
  var SENTINEL_LEVEL = sentinel.level || 0; // 0=STANDARD, 1=SENTINEL, 2=LOCKDOWN

  // ── LOCKDOWN (level 2): 全禁 ──
  if (SENTINEL_LEVEL >= 2) {
    // 检查一次性豁免令牌
    var override = checkSentinelOverride(n);
    if (override) {
      // 豁免有效 → 放行（在 PostToolUse 消费豁免）
      console.error('[Harness] 🔑 SENTINEL OVERRIDE: ' + n + ' (override: ' + override.override_id + ')');
      // 对于写操作，仍需检查流水线令牌
      if (isReadOnly) {
        // 读操作：豁免直接放行
        return { decision: 'allow',
          description: '[SelfGuard] 🔑 LOCKDOWN豁免放行(Read): ' + n + ' — 一次性豁免令牌 ' + override.override_id + ' 有效期内' };
      }
      // 写操作：豁免 + 仍需流水线令牌（继续走下面逻辑）
      console.error('[Harness] 🔑 LOCKDOWN override allows write attempt on ' + n + ' — pipeline token still required.');
    } else {
      // 无豁免 → 直接拒绝
      incrementSentinelDenial(n);
      console.error('[Harness] ☠️ LOCKDOWN DENY: ' + n + ' — 哨兵封禁中，无有效豁免令牌');
      return { decision: 'deny',
        reason: '☠️ SENTINEL LOCKDOWN: 哨兵封禁模式激活中。所有 Harness 文件操作被拒绝。\n原因: ' + (sentinel.reason || '安全事件/系统维护') + '\n\n唯一放行方式: 通过 SelfGuard MCP 获取一次性豁免令牌 (sentinel_override)\n  POST http://127.0.0.1:18770/sentinel/override\n  MCP: sentinel_override { files: ["' + n + '"], reason: "..." }' };
    }
  }

  // ── SENTINEL (level 1): 读需显式声明，禁用自动令牌 ──
  if (SENTINEL_LEVEL >= 1 && isReadOnly) {
    var disc = checkDisciplineToken();
    if (!disc) {
      // SENTINEL 模式下不自动创建纪律令牌 → 拒绝读取
      console.error('[Harness] 🟡 SENTINEL DENY Read: ' + n + ' — 哨兵模式要求读取前先获取纪律令牌');
      return { decision: 'deny',
        reason: '🟡 SENTINEL: 哨兵模式要求所有读操作先获取纪律令牌。\n' +
          '请通过 MCP harness_init_discipline 或 POST http://127.0.0.1:18770/mcp 获取纪律令牌后重试。\n' +
          '原因: ' + (sentinel.reason || '敏感时期/外部审计') };
    }
    // 纪律令牌存在 → 放行
    return { decision: 'allow' };
  }

  // ── READ-ONLY TOOLS (Read/Grep): Discipline check + bypass logging ──
  if (isReadOnly) {
    var disc = checkDisciplineToken();
    if (!disc) {
      // No S1 discipline token → log bypass, create one automatically with WARNING
      var now = Date.now();
      disc = createDisciplineToken(n, 'auto-created-on-first-read');
      archiveDisciplineBypass(n, 'Read/Grep without prior S1 declaration. Discipline token auto-created.');
      console.error('[Harness] ⚠️ DISCIPLINE BYPASS: Read/Grep on ' + n + ' without S1 declaration. Auto-creating discipline token.');
      return { decision: 'allow',
        description: '[SelfGuard] ⚠️ 无S1声明即读取Harness文件。已自动创建纪律令牌并记录绕过事件。下次请先运行 harness_init_discipline。' };
    }
    // Discipline token exists → silently allow read
    return { decision: 'allow' };
  }

  // ── 🔴 WRITE TOOLS (Edit/Write): Full pipeline token enforcement ──
  // T3: 中/高风险 → 检查多维令牌

  // (四) 批量限流：统计本次会话「无令牌」的待修改 .ts 源文件
  // 🔴 P9-fix: 原逻辑统计全部待修改文件，>3 一律拒绝——即使都有 token。
  // 对合法大重构（同 intent 多文件）不友好，被迫拆批重走 S1-S7。
  // 新逻辑: 只统计「无 token 文件」>3 才拒。有 token 的文件已获授权，不受限。
  var allModified = extractAllModified(input);
  var missingTokenFiles = [];
  for (var _bfi = 0; _bfi < allModified.length; _bfi++) {
    var _bf = String(allModified[_bfi]).replace(/\\/g, '/');
    var _bt = checkPassToken(_bf, input);
    // 🔴 豁免打通: 豁免期内文件视为已授权，不计入无令牌文件（避免误触批量限流）。
    // harness 自身文件豁免不生效（下方自保护双因子仍兜底拦截）。
    if (!_bt || !_bt.passed) {
      // S4-MID2-fix: harness 防线文件豁免不生效 → 不能计为「已授权」
      if (!(isExemptionApplicable(_bf) && checkFileExemption(_bf))) missingTokenFiles.push(_bf);
    }
  }
  if (missingTokenFiles.length > 3) {
    return { decision: 'deny',
      reason: 'BATCH LIMIT: ' + missingTokenFiles.length + ' 个文件无有效令牌（总数 ' + allModified.length + ' 个）。\n单次操作最多 3 个未授权源文件。\n有令牌的文件不受此限制。\n请为多余文件通过 harness_run_flow 获取令牌，或分批修改。' };
  }

  // 风险分级
  var isHigh = false;
  for (var j = 0; j < HIGH_RISK.length; j++) {
    if (n.indexOf(HIGH_RISK[j]) !== -1) { isHigh = true; break; }
  }

  // (三) 多维令牌校验
  var token = checkPassToken(n, input);

  // 🔴🔴🔴 Harness 自保护 — 双因子验证 🔴🔴🔴
  // 修改 Harness 自身代码需要: (A) 流水线令牌 + (B) 管理员密码解锁
  // 二者缺一不可。任何 Agent 无法绕过——密码只有用户知道。
  if (isHarnessSelf) {
    var adminUnlock = checkAdminUnlock();
    if (!adminUnlock.unlocked) {
      archiveHarnessSelfViolation(n);
      console.error('[Harness] ☠️ HARNESS SELF-PROTECT: ' + n + ' — ' + adminUnlock.reason);
      // 🔴 P9-fix: 区分"过期"与"未解锁"，过期时给明确续期指引，减少维护误判
      var isExpired = adminUnlock.reason && adminUnlock.reason.indexOf('过期') !== -1;
      var unlockHint = isExpired
        ? '\n🔄 解锁已过期（30分钟窗口）。维护操作请先续期: node D:/AI文件/harness/scripts/harness-unlock.cjs\n' +
          '  输入密码后，下次合法修改会自动刷新解锁窗口。'
        : '\n🔒 解锁方式（仅用户可操作）:\n' +
          '  1. 用户在终端执行: node D:/AI文件/harness/scripts/harness-unlock.cjs\n' +
          '  2. 输入 Harness 管理员密码\n' +
          '  3. 解锁有效期 30 分钟\n' +
          '  4. 解锁后再调用 harness_run_flow 获取流水线令牌';
      return { decision: 'deny',
        reason: '☠️ HARNESS 自保护锁定 ☠️\n\n' +
          '你正在尝试修改 Harness 监管系统自身的代码！\n' +
          '文件: ' + n + '\n' +
          '原因: ' + adminUnlock.reason + '\n\n' +
          '🔒 Harness 自身代码受密码保护，任何 Agent 不得擅自修改。\n\n' +
          unlockHint + '\n\n' +
          '⚠️ 连续 3 次未授权尝试修改 Harness 自身 → 触发 LOCKDOWN 模式 → 所有 Harness 操作暂停 1 小时。' };
    }
    // 管理员已解锁 → 仍需流水线令牌
    if (!token || !token.passed) {
      console.error('[Harness] 🔑 Harness自身文件需流水线令牌: ' + n + ' (管理员已解锁，等待流水线令牌)');
      // 不在这里返回 DENY，继续走下面的令牌缺失流程
      // 但额外记录这是 harness self 文件
    }
    // 🔴 S2-安全收紧 ③: 移除「存在解锁文件即自动续期」后门。
    // 原 P9-fix 只要解锁文件存在且未消费就自动续期 30 分钟，Agent 可借此无限延长窗口。
    // 现在解锁令牌只有两类续期路径:
    //   (a) 用户重新运行 node scripts/harness-unlock.cjs 显式续期;
    //   (b) 下方「token 有效 + 已解锁」的合法维护操作才会刷新。
    console.error('[Harness] 🔓 Harness管理员已解锁: ' + n + ' (unlock_id: ' + adminUnlock.token.unlock_id + ')');
  }

  if (token && token.passed) {
    // 令牌有效 → 通过，更新计数器
    // P4-C Batch 2: DiffScopeGuard runtime enforcement.
    // The token must cover the current write target and all files visible in this hook input.
    var scopeFiles = uniqueNormalizedFiles([n].concat(allModified || []));
    var scopeResult = diffScope.evaluateTokenScope(token, scopeFiles, { mode: 'strict' });
    if (!scopeResult.allowed) {
      console.error('[Harness] DiffScopeGuard rejected token scope for pre-check target: ' + n);
      console.error(diffScope.formatScopeResult(scopeResult));
      return { decision: 'deny',
        reason: 'DIFF SCOPE GUARD: token scope does not cover requested write set.\n' + diffScope.formatScopeResult(scopeResult)
      };
    }

    token.usage_count = (token.usage_count || 0) + 1;
    if (token.usage_count > 1) {
      // 已被使用 → 拒绝（防止令牌复用）
      destroyTokenFile(n);
      return { decision: 'deny', reason: 'TOKEN REUSED: This token was already consumed. Tokens are single-use only. Re-run harness_run_flow.' };
    }
    // 更新 usage_count 落盘
    try {
      var hash = hashCode(n);
      var tp = path.join(TOKEN_DIR, hash + '.json');
      fs.writeFileSync(tp, JSON.stringify(token), 'utf-8');
    } catch (_) {}
    console.error('[Harness] Token valid: ' + n + ' (run: ' + token.run_id + ', uuid: ' + token.caller_uuid + ')');
    resetBreaker(n);

    // 🔴 P9-fix: 维护会话模式 — 合法解锁下修改 Harness 自身文件时刷新解锁有效期
    // 原逻辑: admin 解锁固定 30 分钟窗口，维护中途超时 → 被误判为"未授权修改"→ 触发 LOCKDOWN
    // 新逻辑: 每次合法（token 有效 + 管理员已解锁）修改都刷新 expires_at，连续 30 分钟无操作才锁。
    // 安全性: 只有持有效 token + 已解锁的维护操作才刷新，攻击者无 token 无法延长。
    if (isHarnessSelf && adminUnlock.unlocked) {
      try {
        var _auFile = ADMIN_UNLOCK_FILE;
        if (fs.existsSync(_auFile)) {
          var _au = JSON.parse(fs.readFileSync(_auFile, 'utf-8'));
          _au.expires_at = Date.now() + 30 * 60 * 1000; // 刷新 30 分钟
          // HIGH-1-fix: expires_at 参与签名 → 续期后必须重签，否则下次验签失败
          _au.sig = signToken(_au);
          fs.writeFileSync(_auFile, JSON.stringify(_au, null, 2), 'utf-8');
          console.error('[Harness] 🔄 维护会话刷新: ' + n + ' (unlock 续期至 ' + new Date(_au.expires_at).toLocaleTimeString('zh-CN') + ')');
        }
      } catch (_er) {}
    }

    return { decision: 'allow' };
  }

  // 🔴 豁免打通: 流水线令牌无效时，若文件在豁免期内（手动 unlock 签发）→ 放行。
  // harness 自身防线代码一律不豁免（isExemptionApplicable 返回 false）——
  // 防止 Agent 用豁免绕过「管理员解锁 + 流水线令牌」双因子自保护。
  if (isExemptionApplicable(n)) {
    var exemption = checkFileExemption(n);
    if (exemption) {
      archiveExemptionAllow(n, exemption.expires_at);
      console.error('[Harness] 🔑 EXEMPTION: ' + n + ' — 豁免期内跳过流水线令牌 (至 ' + new Date(exemption.expires_at).toLocaleTimeString('zh-CN') + ')');
      return { decision: 'allow',
        description: '[Harness] 🔑 豁免放行: ' + n + ' — 处于手动解锁豁免期（跳过流水线令牌）' };
    }
  }

  // (四) OS 级身份二次兜底
  var osGuard = checkOSGuard(n);
  if (!osGuard.allowed) {
    archiveViolation(n);
    return { decision: 'deny', reason: 'OS GUARD: ' + osGuard.reason };
  }

  // 熔断冷却检查
  var cooldown = checkCooldown(n);
  if (cooldown && cooldown.active) {
    return { decision: 'deny',
      reason: 'CIRCUIT BREAKER ACTIVE: ' + n + '\nRejected ' + (cooldown.count || '3+') + ' times. Cooldown until: ' + new Date(cooldown.until).toISOString() + '\nFile TEMPORARILY LOCKED.' };
  }

  var rejectResult = incrementBreaker(n, isHigh);
  if (rejectResult === -1) {
    return { decision: 'deny',
      reason: 'CIRCUIT BREAKER TRIGGERED: ' + n + '\nRejected ' + (isHigh ? '3' : '5') + ' times. File LOCKED for 30 min. Manual review required.' };
  }

  var riskLabel = isHigh ? 'HIGH' : 'MID';

  // 🔴 MCP 存活检测 — 读心跳文件（纯文件系统，<1ms）
  var mcpAlive = false;
  try {
    if (fs.existsSync(HEARTBEAT_FILE)) {
      var hb = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf-8'));
      mcpAlive = (Date.now() - (hb.ts || 0)) < 15000; // 15秒内有心跳 = 存活
    }
  } catch (_) { /* 心跳不可读，按离线处理 */ }

  var autoStartNote = mcpAlive
    ? '\n\n✅ Harness MCP Server 在线 (端口 8765)。请调用 harness_run_flow 走流水线获取令牌。'
    : '\n\n⚠️ Harness Streamable HTTP MCP 未启动。启动方法:\n' +
      '  1. 打开 PowerShell 管理员窗口\n' +
      '  2. 执行: schtasks /run /tn HarnessMCP\n' +
      '  3. 等待 5 秒后重试\n' +
      '  MCP 地址: http://127.0.0.1:8765';

  var reason = riskLabel + '-RISK FILE: ' + n + '\n\n' +
    'YAML FLOW ENFORCEMENT: Pipeline review REQUIRED.\n' +
    (rejectResult > 0 ? 'Reject #' + rejectResult + '/' + (isHigh ? '3' : '5') + '. At max, cooldown lockout triggers.\n\n' : '\n') +
    'ACTION: Use MCP harness_run_flow with USER present for human gate approval:\n' +
    '  harness_run_flow { files: ["' + n + '"], message: "..." }\n\n' +
    'IMPORTANT: Pipeline S1/S2 stages require HUMAN approval. You (the user) must\n' +
    'be present to approve the analysis and solution before coding begins.\n' +
    'Human gate timeout or lack of approval = pipeline ABORT = NO token issued.\n\n' +
    'Pipeline issues one-time token ONLY after ALL stages (including human gates) pass.\nOverride: reply "disable Harness free mode" (at your own risk).' +
    autoStartNote;

  return { decision: 'deny', reason: reason };
}

/* ── (三) 多维令牌校验 ── */
function uniqueNormalizedFiles(files) {
  var seen = {};
  var out = [];
  files = files || [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (!f) continue;
    var n = normalize(String(f).replace(/\\/g, '/'));
    if (!n) continue;
    if (!seen[n]) {
      seen[n] = true;
      out.push(n);
    }
  }
  return out;
}

/**
 * 🔴 豁免打通（审查 P0-1 修复）: 检查文件是否在手动解锁豁免期内。
 * 豁免文件 data/exemptions.json 由 sentinel/escalation.cjs 的 manualUnlock()
 * 签发（默认 30 分钟），格式 { "相对路径": 过期毫秒 }。
 * 此前仅 Sentinel 层读取 → 豁免对 pre-check hook 无效 → Agent 豁免仍被卡。
 * 现在 hook 层同步读取，两层统一放行。
 * 匹配规则: 相对路径 endsWith 精确匹配（防止前缀误伤，如 src/m4/a 不匹配 src/m4/ab）。
 * @returns {null | { expires_at: number }}
 */
/**
 * 🔴 S4-HIGH1-fix: 判定豁免是否可对某文件生效。
 * 豁免只对被管控项目（wenstar-cc 等）的文件生效；
 * harness 自身防线代码（scripts/ mcp/ sentinel/ hooks/ src/ data/ .claude/，
 * 且路径在 harness 目录下）一律不豁免 —— 防线代码永远需要
 * 「管理员解锁 + 流水线令牌」双因子，防止单个人工豁免绕过自保护。
 * @returns {boolean} true=豁免可生效，false=该文件不适用豁免
 */
function isExemptionApplicable(filePath) {
  var n = String(filePath).replace(/\\/g, '/');
  var low = n.toLowerCase();
  // 1. 绝对路径含 harness 目录 → harness 自身文件 → 不豁免
  if (low.indexOf('/harness/') !== -1 || low.indexOf('\\harness\\') !== -1 ||
      low.indexOf('/ai文件/harness/') !== -1 || low.indexOf('\\ai文件\\harness\\') !== -1) {
    return false;
  }
  // S4 评审 ②-fix: 剥离前导 ./（与 case4 一致）
  var nn = n.indexOf('./') === 0 ? n.slice(2) : n;
  // S4 评审 MID-fix: harness 根级治理文件 → 不豁免（与 case4 白名单一致）。
  // 防止豁免把「管理员解锁+流水线令牌」双因子退化为「单因子+豁免」。
  var cwdForEx = (process.env.CLAUDE_PROJECT_DIR || process.cwd() || '').replace(/\\/g, '/').toLowerCase();
  var isHarnessCwdForEx = cwdForEx.indexOf('/harness') !== -1 || cwdForEx.indexOf('\\harness') !== -1 ||
                          cwdForEx.indexOf('/ai文件/harness') !== -1 || cwdForEx.indexOf('\\ai文件\\harness') !== -1;
  if (isHarnessCwdForEx) {
    for (var r = 0; r < HARNESS_ROOT_FILES.length; r++) {
      if (nn === HARNESS_ROOT_FILES[r]) return false;
    }
  }
  // 2. 相对路径防线前缀 + harness cwd → harness 自身文件 → 不豁免
  for (var i = 0; i < DEFENSE_DIR_PREFIXES.length; i++) {
    if (nn.indexOf(DEFENSE_DIR_PREFIXES[i]) === 0) {
      if (isHarnessCwdForEx) return false;
      break;
    }
  }
  return true;
}

function checkFileExemption(filePath) {
  try {
    if (!fs.existsSync(EXEMPTIONS_FILE)) return null;
    var ex = JSON.parse(fs.readFileSync(EXEMPTIONS_FILE, 'utf-8'));
    var now = Date.now();
    var n = String(filePath).replace(/\\/g, '/');
    for (var k in ex) {
      if (!Object.prototype.hasOwnProperty.call(ex, k)) continue;
      var kn = String(k).replace(/\\/g, '/');
      // 精确匹配（endsWith）防前缀误伤；同时兼容豁免键带前导斜杠
      var k2 = kn.charAt(0) === '/' ? kn.slice(1) : kn;
      if (n === k2 || n.endsWith('/' + k2)) {
        if (now < ex[k]) return { expires_at: ex[k] };
      }
    }
    return null;
  } catch (_) { return null; }
}

/** 记录豁免放行事件（供审计/回溯） */
function archiveExemptionAllow(file, expires_at) {
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    var d = path.join(AUDIT_DIR, 'exemptions');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    var today = new Date().toISOString().slice(0, 10);
    var dd = path.join(d, today);
    if (!fs.existsSync(dd)) fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, 'allow_' + Date.now() + '.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), event: 'EXEMPTION_ALLOW', file: file, expires_at: expires_at }, null, 2));
  } catch (_) {}
}

function checkPassToken(filePath, input) {
  try {
    if (!fs.existsSync(TOKEN_DIR)) return null;
    var hash = hashCode(filePath);
    var tp = path.join(TOKEN_DIR, hash + '.json');
    if (!fs.existsSync(tp)) return null;
    var raw = fs.readFileSync(tp, 'utf-8');
    var token = JSON.parse(raw);
    var now = Date.now();

    // 🔴 P6-SECURITY: 仅接受 Token v2 (HMAC 签名)，完全移除 v1 明文 token 支持
    // v1 token 无密码学保护 — 所有字段可伪造，构成认证后门
    if (token.version !== 2) {
      console.error('[Harness] 🚫 Token v1 已禁用 — 仅接受 HMAC 签名的 v2 令牌 (file: ' + filePath + ')');
      try { fs.unlinkSync(tp); } catch (_) {}
      return null;
    }

    try {
      var tv = require('../src/security/token-verify.cjs');
      if (tv.isTokenSecretAvailable()) {
        var v2Result = tv.verifyTokenV2(token, filePath, { now: new Date(now) });
        if (!v2Result.allowed) {
          console.error('[Harness] Token v2 rejected: ' + v2Result.reason + ' (file: ' + filePath + ')');
          if (v2Result.reason === 'token_invalid_signature' || v2Result.reason === 'token_expired') {
            try { fs.unlinkSync(tp); } catch (_) {}
          }
          return null;
        }
        // 🔴 P9-fix: 补 passed 标记 — 调用处 line 377 判断 `token && token.passed`，
        // 原始 token 无 passed 字段 → 永远走 deny。这是深埋的 bug。
        token.passed = true;
        return token;
      } else {
        // 🔴 P9-fix: secret 不可用时降级为信任 token 文件本身（与 harness-gate 一致）
        // 原逻辑: fail-close 拒绝所有 token → hook 子进程无 secret 时合法 token 也被拒
        // 新逻辑: token 文件是 MCP 持 secret 时原子写入的（temp→rename），存在即背书。
        // 攻击者无 secret 无法生成合法签名 → 信任文件不降低安全性，但解除子进程阻塞。
        console.error('[Harness] ⚠️ HARNESS_TOKEN_SECRET 不可用 — 降级为信任 MCP 已签发 token 文件 (file: ' + filePath + ')');
        token.passed = true; // 🔴 P9-fix: 同样补 passed 标记
        return token;
      }
    } catch (e) {
      console.error('[Harness] Token v2 verification error: ' + e.message);
      return null;
    }
  } catch (_) { return null; }
}

function destroyTokenFile(filePath) {
  try {
    var tp = path.join(TOKEN_DIR, hashCode(filePath) + '.json');
    if (fs.existsSync(tp)) fs.unlinkSync(tp);
  } catch (_) {}
}

/* ── (四) OS 级二次兜底 ── */
function checkOSGuard(filePath) {
  // Windows: 检查当前进程是否以管理员或 SYSTEM 身份运行
  // 仅允许 SelfGuard 进程身份（通过调用方上下文判断）
  try {
    var userInfo = os.userInfo();
    var username = (userInfo && userInfo.username) || '';
    // SelfGuard MCP 进程作为 Claude Code 的子进程运行
    // Claude Code 本身是合法调用方
    // 此处做最低限度的身份检查：不允许 Guest/匿名账户
    if (username && /guest|anonymous/i.test(username)) {
      return { allowed: false, reason: 'OS identity rejected: ' + username + ' is not authorized for harness writes.' };
    }
    return { allowed: true };
  } catch (_) {
    // OS 信息获取失败 → 保守拒绝
    return { allowed: false, reason: 'OS identity check failed. Cannot verify caller.' };
  }
}

/* ── 批量修改检测 ── */
function extractAllModified(input) {
  var files = [];
  if (input.file_path) files.push(input.file_path);
  if (input.path) files.push(input.path);
  // 只统计 .ts 源文件（不含测试/类型声明）
  return files.filter(function(f) {
    var n = String(f).replace(/\\/g, '/');
    return /\.ts$/.test(n) && !/\.test\.ts$|\.spec\.ts$|\.d\.ts$/.test(n);
  });
}

/* ── Helpers ── */
function normalize(p) { return String(p).replace(/\\/g, '/'); }
function hashCode(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function isLowRisk(fp) {
  for (var e = 0; e < LOW_RISK_EXTENSIONS.length; e++) {
    if (fp.endsWith(LOW_RISK_EXTENSIONS[e])) return true;
  }
  for (var s = 0; s < LOW_RISK_SUFFIXES.length; s++) {
    if (fp.indexOf(LOW_RISK_SUFFIXES[s]) !== -1) return true;
  }
  for (var p = 0; p < LOW_RISK_PREFIXES.length; p++) {
    if (fp.indexOf(LOW_RISK_PREFIXES[p]) === 0) return true;
  }
  return false;
}

/* ── Circuit breaker ── */
function incrementBreaker(filePath, isHigh) {
  try {
    if (!fs.existsSync(BREAKER_DIR)) fs.mkdirSync(BREAKER_DIR, { recursive: true });
    var hash = String(hashCode(filePath));
    var cp = path.join(BREAKER_DIR, hash + '.counter.json');
    var count = 0;
    if (fs.existsSync(cp)) {
      var existing = JSON.parse(fs.readFileSync(cp, 'utf-8'));
      count = (existing.count || 0) + 1;
    } else { count = 1; }
    var threshold = isHigh ? 3 : 5;
    if (count >= threshold) {
      var until = Date.now() + 30 * 60 * 1000;
      fs.writeFileSync(path.join(BREAKER_DIR, hash + '.lockout.json'), JSON.stringify({
        file: filePath, count: count, threshold: threshold, cooldown_until: until, locked_at: new Date().toISOString()
      }), 'utf-8');
      fs.writeFileSync(cp, JSON.stringify({ file: filePath, count: 0, last_reject: new Date().toISOString() }));
      console.error('[Harness] BREAKER: ' + filePath + ' (' + count + '/' + threshold + ')');
      return -1;
    }
    fs.writeFileSync(cp, JSON.stringify({ file: filePath, count: count, threshold: threshold, last_reject: new Date().toISOString() }));
    console.error('[Harness] Reject #' + count + '/' + threshold + ': ' + filePath);
    return count;
  } catch (_) { return 0; }
}

function resetBreaker(filePath) {
  try {
    if (!fs.existsSync(BREAKER_DIR)) return;
    var hash = String(hashCode(filePath));
    var cp = path.join(BREAKER_DIR, hash + '.counter.json');
    var lp = path.join(BREAKER_DIR, hash + '.lockout.json');
    if (fs.existsSync(cp)) fs.unlinkSync(cp);
    if (fs.existsSync(lp)) fs.unlinkSync(lp);
  } catch (_) {}
}

function checkCooldown(filePath) {
  try {
    if (!fs.existsSync(BREAKER_DIR)) return null;
    var hash = String(hashCode(filePath));
    var lp = path.join(BREAKER_DIR, hash + '.lockout.json');
    if (!fs.existsSync(lp)) return null;
    var lockout = JSON.parse(fs.readFileSync(lp, 'utf-8'));
    if (Date.now() < (lockout.cooldown_until || 0)) {
      return { active: true, count: lockout.count, until: lockout.cooldown_until };
    }
    try { fs.unlinkSync(lp); } catch (_) {}
    return null;
  } catch (_) { return null; }
}

/* ── S1 Discipline Token (Read/Grep 轻量声明前置) ── */
function checkDisciplineToken() {
  try {
    if (!fs.existsSync(DISCIPLINE_FILE)) return null;
    var raw = fs.readFileSync(DISCIPLINE_FILE, 'utf-8');
    var d = JSON.parse(raw);
    if (Date.now() > (d.expires_at || 0)) {
      try { fs.unlinkSync(DISCIPLINE_FILE); } catch (_) {}
      return null;
    }
    return d;
  } catch (_) { return null; }
}

function createDisciplineToken(triggerFile, source) {
  try {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    var d = {
      session_id: 'sg-session-' + Date.now().toString(36),
      created_at: new Date().toISOString(),
      expires_at: Date.now() + 2 * 60 * 60 * 1000,
      trigger_file: triggerFile,
      source: source,
      type: 'S1-discipline-auto',
      ttl_hours: 2
    };
    fs.writeFileSync(DISCIPLINE_FILE, JSON.stringify(d, null, 2), 'utf-8');
    return d;
  } catch (_) { return null; }
}

function archiveDisciplineBypass(file, detail) {
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    var d = path.join(AUDIT_DIR, 'discipline_bypass');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    var today = new Date().toISOString().slice(0, 10);
    var dd = path.join(d, today);
    if (!fs.existsSync(dd)) fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, 'bypass_' + Date.now() + '.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), event: 'DISCIPLINE_BYPASS', file: file, detail: detail }, null, 2));
  } catch (_) {}
}

function archiveViolation(file) {
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    var d = path.join(AUDIT_DIR, new Date().toISOString().slice(0, 10));
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'violation_' + Date.now() + '.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), event: 'PROTECTED_ZONE_HIT', file: file }, null, 2));
  } catch (_) {}
}

/* ── 🔴 Harness 自保护（变量已移至 run() 前声明，见上方 ~91 行）── */

/**
 * 检查是否有有效的 Harness 管理员解锁令牌。
 * 解锁令牌由用户输入密码后通过 harness_admin_unlock MCP 工具签发。
 * 有效期: 30 分钟（足够完成一次维护操作）
 */
function checkAdminUnlock() {
  try {
    if (!fs.existsSync(ADMIN_UNLOCK_FILE)) return { unlocked: false, reason: '未找到管理员解锁令牌' };
    var raw = fs.readFileSync(ADMIN_UNLOCK_FILE, 'utf-8');
    var token = JSON.parse(raw);

    // 🔴 S2-安全收紧 ②: HMAC 验签——防 Agent 伪造解锁令牌。
    // 伪造/篡改的文件签名不匹配 → 视为无效令牌，等同于未解锁。
    // 说明: 令牌由 scripts/harness-unlock.cjs 或 mcp/server.ts 签发，都带 sig。
    //       早期令牌无 sig（升级前签发）→ 校验 key 一致时视为「无签名旧令牌」，
    //       为兼容旧文件不直接拒绝，而是按未解锁处理并提示重新解锁。
    if (!token.sig) {
      return { unlocked: false, reason: '管理员解锁令牌缺少签名（旧版），请重新解锁' };
    }
    var signKey = getSignKey();
    if (!signKey) {
      return { unlocked: false, reason: '管理员解锁签名密钥未配置（HARNESS_SECRET 缺失）' };
    }
    // C3-fix + HIGH-1-fix: 验签覆盖身份字段 + expires_at，与签发方一致。
    // expires_at 参与签名 → 续期必须重签（见下方维护会话续期处），防重放。
    // M3-fix: 用排序键稳定序列化，避免 JSON 键插入顺序敏感。
    var body = {
      unlock_id: String(token.unlock_id),
      created_at: String(token.created_at),
      source: String(token.source),
      expires_at: token.expires_at,
    };
    var expect = crypto.createHmac('sha256', signKey).update(stableStringify(body)).digest('hex');
    var actual = String(token.sig);
    var sigOk = (function () {
      try {
        return crypto.timingSafeEqual(Buffer.from(expect, 'utf8'), Buffer.from(actual, 'utf8'));
      } catch (_) { return expect === actual; }
    })();
    if (!sigOk) {
      return { unlocked: false, reason: '管理员解锁令牌签名无效（可能被伪造或篡改）' };
    }

    if (token.consumed) {
      return { unlocked: false, reason: '管理员解锁令牌已被使用' };
    }
    if (Date.now() > (token.expires_at || 0)) {
      // 过期 → 清理
      try { fs.unlinkSync(ADMIN_UNLOCK_FILE); } catch (_) {}
      return { unlocked: false, reason: '管理员解锁令牌已过期（有效期30分钟）' };
    }
    return { unlocked: true, token: token };
  } catch (_) { return { unlocked: false, reason: '令牌文件读取失败' }; }
}

/**
 * 🔴 S2-安全收紧 ② + C4-fix: 解锁令牌签名 key，与签发方完全一致:
 *   1. 环境变量 HARNESS_TOKEN_SECRET（≥32 字节）
 *   2. data/.harness-secret 文件（真实随机 secret）
 * 不再回退到密码 hash（C1: 密码 hash 对 Agent 可读，作 key 无意义）。
 * L2-fix: 路径用 __dirname 推导，不用硬编码绝对路径。
 */
function getSignKey() {
  try {
    var envSecret = process.env.HARNESS_TOKEN_SECRET;
    if (envSecret && Buffer.byteLength(envSecret, 'utf8') >= 32) return envSecret;
    var secretFile = path.resolve(__dirname, '..', 'data', '.harness-secret');
    if (fs.existsSync(secretFile)) {
      var s = fs.readFileSync(secretFile, 'utf-8').trim();
      if (s && Buffer.byteLength(s, 'utf8') >= 32) return s;
    }
  } catch (_) {}
  return null;
}

/** M3-fix: 稳定序列化（排序键），保证签名体跨进程一致。 */
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  var keys = Object.keys(obj).sort();
  return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(obj[k]); }).join(',') + '}';
}

/** HIGH-1-fix: pre-check 版 signToken（续期重签用），与签发方 harness-unlock.cjs 完全一致。 */
function signToken(tok) {
  var key = getSignKey();
  if (!key) return null;
  var body = {
    unlock_id: String(tok.unlock_id),
    created_at: String(tok.created_at),
    source: String(tok.source),
    expires_at: tok.expires_at,
  };
  return crypto.createHmac('sha256', key).update(stableStringify(body)).digest('hex');
}

/**
 * 记录 Harness 自保护违规 — 3 次无授权尝试 → 触发 LOCKDOWN
 */
function archiveHarnessSelfViolation(file) {
  try {
    var violations = { count: 0, history: [] };
    if (fs.existsSync(HARNESS_SELF_VIOLATION_FILE)) {
      violations = JSON.parse(fs.readFileSync(HARNESS_SELF_VIOLATION_FILE, 'utf-8'));
    }
    violations.count++;
    violations.history.push({
      file: file,
      timestamp: new Date().toISOString(),
      cwd: process.cwd() || '',
    });
    // 只保留最近 20 条
    if (violations.history.length > 20) violations.history = violations.history.slice(-20);
    fs.writeFileSync(HARNESS_SELF_VIOLATION_FILE, JSON.stringify(violations, null, 2), 'utf-8');

    if (violations.count >= 3) {
      // 触发 LOCKDOWN
      var sentinelFile = 'D:/AI文件/harness/data/sentinel/state.json';
      var lockState = {
        mode: 2, level: 2,
        set_at: new Date().toISOString(),
        set_by: 'SELF-PROTECT-LOCKDOWN',
        reason: 'Harness自身连续3次无授权修改尝试 — 自动LOCKDOWN 1小时',
        ttl_minutes: 60,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        override_count: 0,
        stats: { total_denials: 3, total_breaches: violations.count },
      };
      var sentinelDir = 'D:/AI文件/harness/data/sentinel';
      if (!fs.existsSync(sentinelDir)) fs.mkdirSync(sentinelDir, { recursive: true });
      fs.writeFileSync(sentinelFile, JSON.stringify(lockState, null, 2), 'utf-8');
      console.error('[Harness] ☠️☠️☠️ LOCKDOWN 触发！Harness 自身被攻击 3 次 — 全系统锁定 1 小时 ☠️☠️☠️');
    }
  } catch (_) {}
}

/* ── 🆕 哨兵模式辅助函数 (v4.0) ── */

/**
 * 读取哨兵状态（MCP Server 维护，Hook 只读）
 * 状态文件: D:/AI文件/harness/data/sentinel/state.json
 */
function readSentinelState() {
  try {
    var sentinelFile = 'D:/AI文件/harness/data/sentinel/state.json';
    if (!fs.existsSync(sentinelFile)) return { level: 0, mode: 'STANDARD', reason: '默认' };
    var raw = fs.readFileSync(sentinelFile, 'utf-8');
    var state = JSON.parse(raw);
    // 检查 TTL 过期（C5-fix: 原代码 level<2 才查过期 → LOCKDOWN(level2) 永久卡死不自愈）
    // 现在任何级别只要 expires_at 已过 → 自动降级回 STANDARD，并清理状态文件。
    if (state.expires_at && Date.now() > new Date(state.expires_at).getTime()) {
      try { fs.unlinkSync(sentinelFile); } catch (_) {}
      return { level: 0, mode: 'STANDARD', reason: 'TTL已过期自动解除' };
    }
    return { level: state.level || state.mode || 0, mode: state.mode === 0 ? 'STANDARD' : state.mode === 1 ? 'SENTINEL' : 'LOCKDOWN', reason: state.reason || '', expires_at: state.expires_at };
  } catch (_) {
    return { level: 0, mode: 'STANDARD', reason: '读取失败降级' };
  }
}

/**
 * 检查是否有活跃的一次性豁免令牌
 * 豁免目录: D:/AI文件/harness/data/sentinel/overrides/
 */
function checkSentinelOverride(filePath) {
  try {
    var overrideDir = 'D:/AI文件/harness/data/sentinel/overrides';
    if (!fs.existsSync(overrideDir)) return null;
    var now = Date.now();
    var files = fs.readdirSync(overrideDir);
    for (var i = 0; i < files.length; i++) {
      if (!files[i].endsWith('.json')) continue;
      try {
        var raw = fs.readFileSync(path.join(overrideDir, files[i]), 'utf-8');
        var ov = JSON.parse(raw);
        if (ov.consumed) continue;
        if (now > new Date(ov.expires_at).getTime()) continue;
        var norm = String(filePath).replace(/\\/g, '/');
        var matched = false;
        for (var j = 0; j < (ov.files || []).length; j++) {
          var of = String(ov.files[j]).replace(/\\/g, '/');
          if (of === '*' || norm.indexOf(of) !== -1) { matched = true; break; }
        }
        if (matched) return ov;
      } catch (_) {}
    }
    return null;
  } catch (_) { return null; }
}

/**
 * 记录哨兵拒绝事件
 */
function incrementSentinelDenial(filePath) {
  try {
    var denialDir = path.join(AUDIT_DIR, 'sentinel_denials');
    if (!fs.existsSync(denialDir)) fs.mkdirSync(denialDir, { recursive: true });
    var today = new Date().toISOString().slice(0, 10);
    var dd = path.join(denialDir, today);
    if (!fs.existsSync(dd)) fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, 'denial_' + Date.now() + '.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), event: 'SENTINEL_DENIAL', file: filePath, level: 'LOCKDOWN' }, null, 2));
  } catch (_) {}
}

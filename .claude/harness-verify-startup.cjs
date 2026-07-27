#!/usr/bin/env node
/**
 * harness-verify-startup.cjs — SelfGuard 启动验证脚本
 * =====================================================
 *
 * 会话启动后运行此脚本，验证整套管控体系是否正常加载并工作。
 *
 * 用法:
 *   node D:/AI文件/harness/.claude/harness-verify-startup.cjs
 *
 * 检查项（共 8 项）:
 *   1. 用户级 settings.json hooks 已注册
 *   2. PreToolUse hook 脚本存在且可执行
 *   3. PostToolUse hook 脚本存在且可执行
 *   4. 数据目录结构完整（tokens/breaker/audit/sessions/）
 *   5. self_guard_checker.ts 可执行
 *   6. SelfGuard MCP 配置存在
 *   7. GlobalWatchdog 快照文件正常
 *   8. 模拟一次完整的 Read → Discipline + Write → DENY 链路
 *
 * 退出码:
 *   0 — 全部通过
 *   1 — 存在警告（不影响核心功能）
 *   2 — 存在致命错误（管控失效）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

let errors = 0;
let warnings = 0;
let passed = 0;

// 共享常量
const DATA_DIR = 'D:/AI文件/harness/data';
const PRE_CHECK = 'D:/AI文件/harness/.claude/harness-pre-check.cjs';
const POST_CHECK = 'D:/AI文件/harness/.claude/harness-post-check.cjs';

function ok(msg) { passed++; console.log(`  ${GREEN}✅${RESET} ${msg}`); }
function warn(msg) { warnings++; console.log(`  ${YELLOW}⚠️${RESET}  ${msg}`); }
function fail(msg) { errors++; console.log(`  ${RED}❌${RESET} ${msg}`); }

console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${CYAN}║   🛡️  SelfGuard 启动验证 v1.0                        ║${RESET}`);
console.log(`${BOLD}${CYAN}║   ${new Date().toISOString()}                         ║${RESET}`);
console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════╝${RESET}\n`);

// ═══════════════════════════════════════════════════════════════
// 1. 用户级 settings.json hooks 注册
// ═══════════════════════════════════════════════════════════════
console.log(`${BOLD}[1/8] 用户级 settings.json hooks 注册${RESET}`);

const USER_SETTINGS = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'settings.json');
try {
  const raw = fs.readFileSync(USER_SETTINGS, 'utf-8');
  const settings = JSON.parse(raw);
  const hooks = settings.hooks;

  if (!hooks) {
    fail(`hooks 字段不存在于 ${USER_SETTINGS}`);
  } else {
    const preHooks = hooks.PreToolUse || [];
    const postHooks = hooks.PostToolUse || [];

    if (preHooks.length === 0) {
      fail('PreToolUse hooks 未注册');
    } else {
      const matchers = preHooks.map(h => h.matcher);
      ok(`PreToolUse: ${preHooks.length} 条 (matchers: ${matchers.join(', ')})`);

      // 检查每条 hook 的 hooks 数组结构
      for (let i = 0; i < preHooks.length; i++) {
        const h = preHooks[i];
        if (!h.hooks || !Array.isArray(h.hooks) || h.hooks.length === 0) {
          fail(`PreToolUse[${i}] (matcher: ${h.matcher}): hooks 数组缺失或为空`);
        } else {
          for (let j = 0; j < h.hooks.length; j++) {
            const cmd = h.hooks[j].command;
            if (!cmd) {
              fail(`PreToolUse[${i}].hooks[${j}]: command 缺失`);
            } else {
              ok(`  └─ ${h.matcher} → ${cmd}`);
            }
          }
        }
      }
    }

    if (postHooks.length === 0) {
      warn('PostToolUse hooks 未注册（不影响核心拦截，审计链路缺失）');
    } else {
      ok(`PostToolUse: ${postHooks.length} 条`);
      for (let i = 0; i < postHooks.length; i++) {
        const h = postHooks[i];
        if (h.hooks && h.hooks.length > 0) {
          ok(`  └─ ${h.matcher} → ${h.hooks[0].command}`);
        }
      }
    }
  }
} catch (e) {
  fail(`读取 settings.json 失败: ${e.message}`);
}

// ═══════════════════════════════════════════════════════════════
// 2. PreToolUse hook 脚本
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[2/8] PreToolUse hook 脚本${RESET}`);
if (!fs.existsSync(PRE_CHECK)) {
  fail(`PreToolUse 脚本不存在: ${PRE_CHECK}`);
} else {
  const stat = fs.statSync(PRE_CHECK);
  ok(`harness-pre-check.cjs 存在 (${(stat.size / 1024).toFixed(1)}KB)`);

  // 语法检查
  try {
    execSync(`node --check "${PRE_CHECK}"`, { encoding: 'utf-8', timeout: 5000 });
    ok('  语法检查通过');
  } catch (e) {
    fail(`  语法错误: ${e.stderr || e.message}`);
  }

  // 模拟 Read (无 write 参数 → 应返回 allow)
  const tmpIn = path.join(DATA_DIR, 'tmp_test_input.json');
  try {
    fs.writeFileSync(tmpIn, JSON.stringify({file_path: "src/FlowEngine.ts"}), 'utf-8');
    const result = execSync(`node "${PRE_CHECK}" < "${tmpIn}"`, { encoding: 'utf-8', timeout: 5000, cwd: 'D:/AI文件/harness' });
    const lines = result.trim().split('\n');
    const jsonLine = lines.find(l => l.trim().startsWith('{'));
    const decision = jsonLine ? JSON.parse(jsonLine) : { decision: 'unknown' };
    if (decision.decision === 'allow') {
      ok('  模拟 Read: ✅ ALLOW (纪律令牌自动创建)');
    } else {
      fail(`  模拟 Read: 预期 allow，实际 ${decision.decision}`);
    }
  } catch (e) {
    fail(`  模拟 Read 失败: ${e.message}`);
  }

  // 模拟 Write (有 old_string → 应返回 deny)
  try {
    fs.writeFileSync(tmpIn, JSON.stringify({file_path: "src/FlowEngine.ts", old_string: "a", new_string: "b"}), 'utf-8');
    const result = execSync(`node "${PRE_CHECK}" < "${tmpIn}"`, { encoding: 'utf-8', timeout: 5000, cwd: 'D:/AI文件/harness' });
    const lines = result.trim().split('\n');
    const jsonLine = lines.find(l => l.trim().startsWith('{'));
    const decision = jsonLine ? JSON.parse(jsonLine) : { decision: 'unknown' };
    if (decision.decision === 'deny') {
      ok('  模拟 Write: ✅ DENY (无Token，正确拦截)');
    } else {
      fail(`  模拟 Write: 预期 deny，实际 ${decision.decision || 'parse error'}`);
    }
  } catch (e) {
    fail(`  模拟 Write 失败: ${e.message}`);
  }

  // 模拟保护区 Write (.claude/settings.json → 应返回 deny)
  try {
    fs.writeFileSync(tmpIn, JSON.stringify({file_path: ".claude/settings.json", old_string: "a", new_string: "b"}), 'utf-8');
    const result = execSync(`node "${PRE_CHECK}" < "${tmpIn}"`, { encoding: 'utf-8', timeout: 5000, cwd: 'D:/AI文件/harness' });
    const lines = result.trim().split('\n');
    const jsonLine = lines.find(l => l.trim().startsWith('{'));
    const decision = jsonLine ? JSON.parse(jsonLine) : { decision: 'unknown' };
    if (decision.decision === 'deny' && (decision.reason || '').includes('Protected')) {
      ok('  模拟保护区 Write: ✅ DENY (Protected zone)');
    } else {
      fail(`  模拟保护区 Write: 预期 DENY+Protected，实际 ${decision.decision}: ${(decision.reason||'').slice(0,50)}`);
    }
  } catch (e) {
    fail(`  模拟保护区 Write 失败: ${e.message}`);
  }

  // 清理临时文件
  try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// 3. PostToolUse hook 脚本
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[3/8] PostToolUse hook 脚本${RESET}`);
if (!fs.existsSync(POST_CHECK)) {
  fail(`PostToolUse 脚本不存在: ${POST_CHECK}`);
} else {
  const stat = fs.statSync(POST_CHECK);
  ok(`harness-post-check.cjs 存在 (${(stat.size / 1024).toFixed(1)}KB)`);

  // 语法检查
  try {
    execSync(`node --check "${POST_CHECK}"`, { encoding: 'utf-8', timeout: 5000 });
    ok('  语法检查通过');
  } catch (e) {
    fail(`  语法错误: ${e.stderr || e.message}`);
  }

  // 模拟正常执行
  try {
    const result = execSync(`echo '{"file_path":"src/FlowEngine.ts"}' | node "${POST_CHECK}"`, { encoding: 'utf-8', timeout: 5000 });
    ok(`  模拟执行: 正常 (output: ${result.trim().slice(0, 80)})`);
  } catch (e) {
    fail(`  模拟执行失败: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// 4. 数据目录结构
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[4/8] 数据目录结构${RESET}`);
const requiredDirs = [
  'tokens',
  'breaker',
  'sessions',
  'audit/selfguard',
  'audit/selfguard/discipline_bypass',
];

for (const dir of requiredDirs) {
  const full = path.join(DATA_DIR, dir);
  if (fs.existsSync(full)) {
    ok(`data/${dir}/ 存在`);
  } else {
    // 自动创建
    try {
      fs.mkdirSync(full, { recursive: true });
      ok(`data/${dir}/ 自动创建`);
    } catch (e) {
      fail(`data/${dir}/ 不存在且无法创建: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 5. self_guard_checker.ts
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[5/8] self_guard_checker.ts 本地校验脚本${RESET}`);

const CHECKER_SCRIPT = 'D:/AI文件/SelfGuard/self_guard_checker.ts';
if (!fs.existsSync(CHECKER_SCRIPT)) {
  fail(`checker 脚本不存在: ${CHECKER_SCRIPT}`);
} else {
  const stat = fs.statSync(CHECKER_SCRIPT);
  ok(`self_guard_checker.ts 存在 (${(stat.size / 1024).toFixed(1)}KB)`);

  // 执行 quick 模式测试
  try {
    const result = execSync(`npx tsx "${CHECKER_SCRIPT}" --files "src/config/test.ts" --mode quick --format text --no-cache`, {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: 'D:/AI文件/SelfGuard',
    });
    ok(`quick 模式执行正常 (exit 0 = 全部通过)`);
  } catch (e) {
    // 预期可能 exit 1 (有违规) 但脚本本身运行正常
    if (e.stdout && e.stdout.includes('SelfGuard S4')) {
      ok(`quick 模式执行正常 (exit ${e.status} = 检测到违规，这是预期行为)`);
    } else {
      warn(`quick 模式执行异常: ${e.message.slice(0, 100)}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 6. SelfGuard MCP 配置
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[6/8] SelfGuard MCP 配置${RESET}`);

const MCP_CONFIG = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'mcp.json');
const HARNESS_MCP = 'D:/AI文件/harness/.claude/mcp.json';

for (const cfg of [MCP_CONFIG, HARNESS_MCP]) {
  if (!fs.existsSync(cfg)) {
    warn(`MCP 配置不存在: ${cfg}`);
  } else {
    try {
      const raw = fs.readFileSync(cfg, 'utf-8');
      const config = JSON.parse(raw);
      const servers = config.mcpServers || {};
      const selfguard = servers.selfguard;
      if (selfguard) {
        ok(`${path.basename(path.dirname(cfg))}/${path.basename(cfg)}: selfguard MCP 已配置 → ${selfguard.command} ${(selfguard.args||[]).join(' ')}`);
      } else {
        warn(`${path.basename(path.dirname(cfg))}/${path.basename(cfg)}: selfguard MCP 未配置`);
      }
    } catch (e) {
      fail(`解析 ${cfg} 失败: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 7. GlobalWatchdog
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[7/8] GlobalWatchdog 状态${RESET}`);

const SELFGUARD_DATA = 'D:/AI文件/SelfGuard/data';
const watcherDirs = ['audit', 'breach_alerts'];
for (const dir of watcherDirs) {
  const full = path.join(SELFGUARD_DATA, dir);
  if (fs.existsSync(full)) {
    ok(`SelfGuard/${dir}/ 存在`);
  } else {
    try {
      fs.mkdirSync(full, { recursive: true });
      ok(`SelfGuard/${dir}/ 自动创建`);
    } catch (e) {
      warn(`SelfGuard/${dir}/ 不存在: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 8. 端到端链路验证小结
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}[8/8] 端到端链路验证${RESET}`);

// 清理测试残留
try {
  const breakerDir = path.join(DATA_DIR, 'breaker');
  if (fs.existsSync(breakerDir)) {
    for (const f of fs.readdirSync(breakerDir)) {
      fs.unlinkSync(path.join(breakerDir, f));
    }
  }
  const discFile = path.join(DATA_DIR, 'sessions', 'discipline.json');
  if (fs.existsSync(discFile)) fs.unlinkSync(discFile);
} catch {}

console.log(`  ${CYAN}链路追踪:${RESET}`);
console.log(`  ${CYAN}  Claude Code Edit/Write → PreToolUse hook → harness-pre-check.cjs →${RESET}`);
console.log(`  ${CYAN}    → T1 保护区拦截 (Protected zone)${RESET}`);
console.log(`  ${CYAN}    → T2 低风险放行 (.md/.test.ts/.config/)${RESET}`);
console.log(`  ${CYAN}    → T3 写操作：多维Token校验 (flow_id+files+uuid+expiry+consumed)${RESET}`);
console.log(`  ${CYAN}    → T4 无Token → DENY → 提示走 MCP harness_run_flow${RESET}`);
console.log(`  ${CYAN}    → T5 批量限流 (≤3文件)${RESET}`);
console.log(`  ${CYAN}    → T6 OS身份兜底${RESET}`);
console.log(`  ${CYAN}  Claude Code Read/Grep → PreToolUse hook → Discipline token 自动签发${RESET}`);
console.log(`  ${CYAN}  Claude Code Edit/Write 完成 → PostToolUse hook → 令牌强制消费+审计${RESET}`);

// ═══════════════════════════════════════════════════════════════
// 总结
// ═══════════════════════════════════════════════════════════════
console.log(`\n${BOLD}${'═'.repeat(54)}${RESET}`);
console.log(`${BOLD}  验证结果: ${passed} 通过  ${warnings} 警告  ${errors} 错误${RESET}`);
console.log(`${BOLD}${'═'.repeat(54)}${RESET}`);

if (errors > 0) {
  console.log(`\n${RED}${BOLD}🔴 管控体系存在致命缺陷！${RESET}`);
  console.log(`${RED}   请修复以上 ${errors} 个错误后重新运行此脚本。${RESET}`);
  console.log(`${RED}   在错误修复前，Harness 文件可能缺乏强制保护。${RESET}\n`);
  process.exit(2);
} else if (warnings > 0) {
  console.log(`\n${YELLOW}${BOLD}⚠️  管控体系基本就绪，但存在 ${warnings} 个警告。${RESET}`);
  console.log(`${YELLOW}   核心拦截功能正常，建议检查警告项。${RESET}\n`);
  process.exit(1);
} else {
  console.log(`\n${GREEN}${BOLD}✅ 全部 ${passed} 项检查通过。SelfGuard 管控体系就绪。${RESET}`);
  console.log(`${GREEN}${BOLD}╔══════════════════════════════════════════════╗${RESET}`);
  console.log(`${GREEN}${BOLD}║  🔒 读自由  │  🔴 写锁死  │  🛡️ 永锁保护区 ║${RESET}`);
  console.log(`${GREEN}${BOLD}╚══════════════════════════════════════════════╝${RESET}\n`);
  process.exit(0);
}

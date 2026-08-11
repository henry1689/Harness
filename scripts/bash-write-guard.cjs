/**
 * scripts/bash-write-guard.cjs — Bash 写盘拦截 hook (C1/C2 根子修复)
 * ==================================================================
 * 独立防线：匹配 Bash 工具，拦截对 Harness 关键安全文件的写操作。
 *
 * 背景（S4 评审 C2）:
 *   PreToolUse 原 hook 只覆盖 Edit|Write 和 Read|Grep，**Bash 不被拦截**。
 *   Agent 可用 Bash 直接覆写 .harness-pass / data/sessions/* / data/exemptions.json
 *   等文件，既无 hook 拦截也无 Sentinel 回滚 → 一键绕过所有文件级防线。
 *
 * 本 hook 检测 Bash 命令中是否出现对关键路径的写操作（echo>/cat>/tee/rm/mv/cp 等），
 * 命中则 DENY。fail-closed：无法解析命令 → 拒绝 + 审计。
 *
 * 关键路径清单（可扩展）:
 *   .harness-pass           — 管理员密码哈希
 *   data/.harness-secret    — 签名密钥
 *   data/sessions/          — 解锁令牌
 *   data/exemptions.json    — 豁免清单
 *   data/sentinel/          — 哨兵状态
 *   scripts/ mcp/ sentinel/ .claude/ hooks/  — Harness 防线代码
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 读取 stdin（Claude Code 通过 stdin 传 hook 输入）
let raw = '';
try { raw = fs.readFileSync(0, 'utf-8'); } catch (_) {}

const AUDIT_DIR = path.resolve(__dirname, '..', 'data', 'sentinel');
const SECRET_FILE = path.resolve(__dirname, '..', 'data', '.harness-secret');
const PASS_FILE = path.resolve(__dirname, '..', '.harness-pass');
const SESSIONS_DIR = path.resolve(__dirname, '..', 'data', 'sessions');
const EXEMPTIONS_FILE = path.resolve(__dirname, '..', 'data', 'exemptions.json');

/** 关键路径匹配规则（目录前缀 或 精确文件） */
const CRITICAL_TARGETS = [
  { type: 'file', match: PASS_FILE, label: '管理员密码 (.harness-pass)' },
  { type: 'file', match: SECRET_FILE, label: '签名密钥 (data/.harness-secret)' },
  { type: 'dir', match: SESSIONS_DIR, label: '解锁令牌目录 (data/sessions/)' },
  { type: 'file', match: EXEMPTIONS_FILE, label: '豁免清单 (data/exemptions.json)' },
  { type: 'dir', match: path.resolve(__dirname, '..', 'data', 'tokens'), label: '流水线令牌 (data/tokens/)' },
  { type: 'dir', match: path.resolve(__dirname, '..', 'data', 'sentinel'), label: '哨兵数据 (data/sentinel/)' },
  { type: 'dir', match: path.resolve(__dirname, '..', 'data', 'flows'), label: '流水线定义 (data/flows/)' },
  { type: 'dir', match: path.resolve(__dirname, '..', 'scripts'), label: '防线脚本 (scripts/)' },
  { type: 'dir', match: path.resolve(__dirname, '..', 'mcp'), label: 'MCP 服务 (mcp/)' },
  { type: 'dir', match: path.resolve(__dirname, '..', 'sentinel'), label: '哨兵自身 (sentinel/)' },
  { type: 'dir', match: path.resolve(__dirname, '..', '.claude'), label: 'Hook 脚本 (.claude/)' },
  { type: 'dir', match: path.resolve(__dirname, '..', 'hooks'), label: 'Git hooks (hooks/)' },
  { type: 'dir', match: path.resolve(__dirname, '..', 'src', 'harness'), label: 'Harness 内核 (src/harness/)' },
];

// MED-4-fix: basename 级关键文件（无论路径怎么写，文件名命中即拦截）——用于相对路径绕过兜底
const CRITICAL_BASENAMES = [
  { name: '.harness-pass', label: '管理员密码 (.harness-pass)' },
  { name: '.harness-secret', label: '签名密钥 (.harness-secret)' },
  { name: 'harness-admin-unlock.json', label: '解锁令牌' },
  { name: 'exemptions.json', label: '豁免清单 (exemptions.json)' },
  { name: 'sentinel-state.json', label: '哨兵状态' },
  { name: 'state.json', label: '哨兵状态 (state.json)' },
];

/** 写操作命令模式（HIGH-3-fix: 扩充覆盖）+ MED-6-fix 词边界 */
const WRITE_OPS = [
  /\btee\b/i,                                        // tee 始终写文件（含 echo | tee file）
  /(^|[;&|]\s*)\b(echo|printf|cat)\b\s+.*[>»]/i,     // echo x > file / cat > file
  /(^|[;&|]\s*)\b(sed|perl|awk)\b\s+.*-i\b/i,        // sed -i / perl -i
  /(^|[;&|]\s*)\b(rm|mv|cp|install|ln|touch)\b\s+/i, // 删除/移动/复制/覆盖
  /\bnode\s+-e\b.*(writeFileSync|unlinkSync|rmSync|renameSync|copyFileSync|appendFileSync)/i,
  /(^|[;&|]\s*)(>>|[>»])/i,                          // 追加重定向
  /\b(curl|wget)\s+.*\s?(-o|-O|--output)\b/i,        // curl/wget 下载写入
  /\bpython(-3|3)?\b.*\bopen\s*\(.*['"][wa+x]/i,     // python open(w/a/x)
  /\bpython(-3|3)?\b.*(pathlib|Path\(.*\.write_text|os\.(remove|replace|rename)|shutil\.(copy|move|rmtree))/i, // python 文件操作
  /\bgit\s+(checkout|restore|apply|stash\s+(pop|apply)|merge|pull|cherry-pick|reset|revert|clean|checkout-index)\b/i, // git 改工作区
  /\bgit\s+clean\s+.*-f/i,                          // git clean -f (可含 -x 清空忽略文件)
  /\b(patch|unzip|tar)\b.*(-d|--directory|--output|-xf|-xzf)/i, // 解压/打补丁
  /\b(Set-Content|Out-File|Add-Content)\b/i,        // PowerShell 写
  /\[(System\.)?IO\.File\]::(WriteAllText|AppendAllText|Copy|Delete|Move|WriteAllBytes)/i, // PowerShell .NET API（含 [IO.File] 缩写）
  /\bdd\b.*of=/i,                                   // dd 写入
];

/** 解析命令中的路径，判断是否命中关键目标。cwd 用于补全相对路径（HIGH-2-fix）。 */
function hitsCritical(command, cwd) {
  // 归一化路径（正反斜杠 + 大小写）。Windows 路径可能是 \ 或 /，统一成 / 再小写。
  const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  const cmdNorm = norm(command);
  const cwdNorm = norm(cwd || '');

  // 先用 cwd 补全相对路径 → 生成「绝对路径版本」再匹配
  // 相对写法: "data/sessions/a.json" / ".harness-pass" / "scripts/x.cjs"（Bash 默认 cwd=项目根）
  const criticalNorm = CRITICAL_TARGETS.map(t => ({ ...t, norm: norm(t.match) }));

  // ① 绝对路径命中
  for (const t of criticalNorm) {
    if (t.type === 'file' && cmdNorm.includes(t.norm)) return t.label;
  }
  for (const t of criticalNorm) {
    if (t.type === 'dir' && cmdNorm.includes(t.norm + '/')) return t.label;
  }

  // ② 相对路径补全命中（HIGH-2-fix）: 若命令含相对路径片段，且 cwd 指向 harness 根 → 补全后匹配
  if (cwdNorm) {
    for (const t of criticalNorm) {
      // 目标目录的相对形式: 去掉绝对前缀后剩余的目录相对路径
      const rel = t.norm.startsWith(cwdNorm) ? t.norm.slice(cwdNorm.length).replace(/^\//, '') : null;
      if (!rel) continue;
      if (t.type === 'file' && (cmdNorm.includes(rel) || cmdNorm.includes(t.norm.slice(cwdNorm.length)))) return t.label;
      if (t.type === 'dir' && (cmdNorm.includes(rel + '/') || cmdNorm.includes(rel))) return t.label;
    }
  }

  // ③ basename 兜底（HIGH-2-fix 深层）: 文件名级别命中，防 cd + 相对路径、变量拼接等
  for (const b of CRITICAL_BASENAMES) {
    if (cmdNorm.includes(b.name)) return b.label;
  }
  return null;
}

/** 是否写操作 */
function isWriteOp(command) {
  // 误伤修复: 剥离 /dev/null 重定向（2>/dev/null、>/dev/null、&>/dev/null 等）。
  // 这些是「丢弃输出」，不是写关键文件。若不剥离，`node x.cjs 2>/dev/null` 这种
  // 标准 stderr 丢弃写法 + 命令提到关键路径 → 被误判为写操作 → 误伤正常诊断。
  let stripped = command.replace(/&?>?[12]?>?\s*\/dev\/null\b/g, '')
    .replace(/[12]?>>?\s*\/dev\/null\b/g, '');

  // 误伤修复2: 剥离 fd 复制/关闭重定向（2>&1、1>&2、3>&1、2>&-、0<&1 等）。
  // 这些是「文件描述符重定向」，把 stderr 并入 stdout / 关闭 fd，不写任何文件。
  // 若不剥离，`node x.cjs 2>&1` 里的 `&1` 会命中 WRITE_OPS 第 6 条 `[;&|]\s*[>»]`
  // （贪婪跨内容匹配），叠加路径关键词 → 被误判为写操作 → 误伤只读诊断命令。
  // 保留 `&>file` / `&>>file`（stdout+stderr 一并写文件，是真写操作）。
  // 判据: 只剥离「数字前缀 + 重定向 + & 」，如 2>&1；纯 `>file`/`2>file`（无 &，
  // 写文件）与 `&>file`（& 在前）一律保留。
  stripped = stripped.replace(/[0-9]+[<>]&[0-9\-]?/g, '');
  return WRITE_OPS.some(re => re.test(stripped));
}

/** 审计 */
function archive(type, detail) {
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.writeFileSync(path.join(AUDIT_DIR, `bash_${type}_${Date.now()}.json`),
      JSON.stringify({ timestamp: new Date().toISOString(), rule: 'bash-write-guard', type, ...detail }, null, 2));
  } catch (_) {}
}

function run() {
  let input = {};
  try { input = JSON.parse(raw); } catch (_) {}

  const toolName = input.tool_name || '';
  const ti = input.tool_input || {};
  const command = String(ti.command || '').trim();
  // HIGH-2-fix: 取 hook 输入的 cwd（Bash 工作目录），用于补全相对路径
  const cwd = String(ti.cwd || input.cwd || '').trim() || process.cwd();

  // 只拦截 Bash
  if (toolName !== 'Bash') return { decision: 'allow' };
  if (!command) {
    archive('parse_fail', { reason: 'empty command', tool: toolName });
    return { decision: 'deny', reason: '🛑 Bash-write-guard: 无法解析 Bash 命令（fail-closed）。' };
  }

  // 判断写操作 + 关键路径（HIGH-2-fix: 传 cwd 供相对路径补全）
  const hit = hitsCritical(command, cwd);
  if (hit && isWriteOp(command)) {
    archive('deny', { command: command.slice(0, 300), target: hit });
    return {
      decision: 'deny',
      reason: `🛑 Bash-write-guard: 检测到对 Harness 关键安全文件的写操作。\n` +
        `目标: ${hit}\n` +
        `命令: ${command.slice(0, 200)}\n\n` +
        `这些文件（密码/密钥/令牌/防线代码）受 Harness 双因子保护，只允许通过正式流程修改。\n` +
        `如需修改 Harness 自身代码，请走解锁流程（用户运行 harness-unlock.cjs）并使用 Edit/Write 工具。`,
    };
  }

  // 无条件危险命令: 不依赖路径字面量，仅凭命令本身即判定（在 harness 仓库 cwd 内时）。
  // 例: git clean -fdx（清空忽略文件含密钥/令牌）、git stash/merge/pull/cherry-pick（改工作区）。
  // 判定: cwd 指向 harness 仓库 + 命令匹配危险模式 → DENY。
  const isInHarnessRepo = (() => {
    const cwdN = cwd.replace(/\\/g, '/').toLowerCase();
    return cwdN.indexOf('ai文件/harness') !== -1 || cwdN.indexOf('/harness') !== -1;
  })();
  if (isInHarnessRepo) {
    const DANGEROUS_BLIND = [
      /\bgit\s+clean\s+.*-f/i,
      /\bgit\s+stash\s+(pop|apply)\b/i,
      /\bgit\s+(merge|pull|cherry-pick|rebase)\b/i,
      /\bgit\s+reset\s+--hard/i,
      /\brm\s+-rf\s+(\$|\/|\.|\.claude|scripts|mcp|sentinel|data)/i,
    ];
    const blindHit = DANGEROUS_BLIND.find(re => re.test(command));
    if (blindHit) {
      archive('deny', { command: command.slice(0, 300), target: '无条件危险命令 (blind)' });
      return {
        decision: 'deny',
        reason: `🛑 Bash-write-guard: 检测到无条件危险命令（harness 仓库 cwd 内）。\n` +
          `匹配: ${command.slice(0, 200)}\n\n` +
          `此类命令会清空/覆写工作区（含密钥、令牌、防线代码），即使未指定路径也不允许。\n` +
          `如需维护 Harness，请走解锁流程 + Edit/Write 工具。`,
      };
    }
  }

  // 允许（读操作 / 非关键路径写操作 / 正常项目操作）
  return { decision: 'allow' };
}

process.stdout.write(JSON.stringify(run()));

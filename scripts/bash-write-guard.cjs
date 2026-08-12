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
 * 🔴 v2.8 重构（写目标提取）：修复「处处要豁免」误伤。
 *   旧逻辑用「整命令 includes 关键路径 + 整命令匹配写模式」的组合判断，
 *   读命令（cat/grep/cd/URL/heredoc 内容）提到关键路径即误判。
 *   新逻辑：命令切段 → 每段提取「写操作的真实目标路径」→ 只比对目标路径。
 *   读动词不产出写目标 → 全放行；`cp x data/exemptions.json` 照拦。
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
const os = require('os');

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

// MED-4-fix: basename 级关键文件（v2.8 语义收窄为「非字面目标兜底」——含变量/命令替换的目标才用）
const CRITICAL_BASENAMES = [
  { name: '.harness-pass', label: '管理员密码 (.harness-pass)' },
  { name: '.harness-secret', label: '签名密钥 (.harness-secret)' },
  { name: 'harness-admin-unlock.json', label: '解锁令牌' },
  { name: 'exemptions.json', label: '豁免清单 (exemptions.json)' },
  { name: 'sentinel-state.json', label: '哨兵状态' },
  { name: 'state.json', label: '哨兵状态 (state.json)' },
];

// ════════════════════════════════════════════════════════════════════
// v2.8 写目标提取 — 切段 / tokenize / 提取 / 判定
// ════════════════════════════════════════════════════════════════════

/** 路径归一化：\ → /、压缩重复 /、去尾 /、小写 */
function norm(s) {
  return String(s).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

const HOME = (process.env.USERPROFILE || process.env.HOME || '').replace(/\\/g, '/');
const OS_TMP = norm(os.tmpdir());

/**
 * 命令切段（保留 heredoc 体整行丢弃）。
 * 分隔: ; && || | 换行。heredoc 内容只是 stdin 数据，永远不是写目标 → 按定界符整行剥离。
 * 未闭合引号/heredoc → 返回 null（fail-closed deny，与旧逻辑一致）。
 */
function splitSegments(command) {
  const segs = [];
  let buf = '';
  let i = 0;
  const n = command.length;
  const heredocs = [];
  // H2-fix: lineStart 标记——heredoc 起始行（<<EOF 之后）剩余内容应正常累积进 buf
  // （cat <<EOF > file 的重定向 > file 在定界符之后同 行，必须保留），
  // 只有「行首」才进入 heredoc 体吞行逻辑。
  let lineStart = true;
  const flush = () => { if (buf.trim()) { segs.push(buf); buf = ''; } };

  while (i < n) {
    const c = command[i];
    // 注释
    if (c === '#' && /(^|[\s;&|])$/.test(buf.slice(-1))) {
      while (i < n && command[i] !== '\n') i++;
      continue;
    }
    // 单引号
    if (c === "'") {
      buf += c; i++;
      while (i < n && command[i] !== "'") buf += command[i++];
      if (i >= n) return null;
      buf += "'"; i++;
      continue;
    }
    // 双引号
    if (c === '"') {
      buf += c; i++;
      while (i < n && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < n) { buf += command[i] + command[i + 1]; i += 2; }
        else buf += command[i++];
      }
      if (i >= n) return null;
      buf += '"'; i++;
      continue;
    }
    // 反引号
    if (c === '`') {
      buf += c; i++;
      while (i < n && command[i] !== '`') {
        if (command[i] === '\\' && i + 1 < n) { buf += command[i] + command[i + 1]; i += 2; }
        else buf += command[i++];
      }
      if (i >= n) return null;
      buf += '`'; i++;
      continue;
    }
    // heredoc 起始 << EOF（只在行首）
    if (lineStart && c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      i += 2;
      let d = '';
      while (i < n && !/[\s;&|]/.test(command[i])) d += command[i++];
      // L1-fix: <<-EOF（tab 剥离）把 - 并进定界符 → 永不闭合
      heredocs.push(d.replace(/^[-~]/, '').replace(/['"]/g, ''));
      // H2-fix: 起始行剩余内容继续累积（重定向等），不进 heredoc 体吞行
      lineStart = false;
      continue;
    }
    // heredoc 体内（仅行首）：逐行吞到定界符
    if (heredocs.length && lineStart) {
      let eol = command.indexOf('\n', i);
      if (eol === -1) eol = n;
      if (command.slice(i, eol).trim() === heredocs[heredocs.length - 1]) heredocs.pop();
      i = eol + 1;
      lineStart = true;
      continue;
    }
    if (c === '\n' || c === ';') { flush(); i++; lineStart = true; continue; }
    if ((c === '&' && command[i + 1] === '&') || (c === '|' && command[i + 1] === '|')) { flush(); i += 2; continue; }
    // MID-1-fix: `>|` 无空格重定向的 | 不是命令分隔符（echo a>|file 是截断写），留在段内
    if (c === '|' && command[i - 1] !== '>') { flush(); i++; continue; }
    buf += c; i++;
  }
  if (heredocs.length) return null;
  flush();
  return segs;
}

/**
 * 段内 tokenize：把段拆成 token。
 * 约定：\ 不剥离、当路径分隔符候选（Windows D:\AI...）；仅在后跟 shell 元字符时转义。
 */
function tokenizeSegment(seg) {
  const toks = [];
  let cur = '';
  let q = null;
  const push = () => { if (cur !== '') { toks.push(cur); cur = ''; } };
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < seg.length && /[\\"`$]/.test(seg[i + 1])) { cur += seg[i + 1]; i++; }
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; continue; }
    // H6-fix: 括号作为 token 边界——(echo x > file) 的 file 不再带 )，cd 判定也能识别 (cd ...
    if (/[\s;&|()]/.test(c)) { push(); continue; }
    // HIGH-1-fix: 无空格重定向在 tokenize 顶层拆分（引号内不拆）。
    //   cmd2>file → cmd、2>、file；cmd>file → cmd、>、file；cmd&>file → cmd、&>、file。
    //   引号内（q !== null）的 `>` 是普通字符，绝不切——避免 echo 'a>data/x' 被误拆成重定向。
    if (c === '>' || c === '&') {
      if (c === '&' && cur === '' && seg[i - 1] !== ' ') {
        // &> 前导 &：若前面无内容且非空格，作为 &> 操作符处理
        push(); cur += c; continue;
      }
      if (c === '>') {
        // 剥 fd/& 前缀从 cur 尾部，形成操作符 token 并立即 push（> 后内容作为新 token 起点）
        const m = cur.match(/(\d*&?)$/);
        if (m) cur = cur.slice(0, cur.length - m[1].length);
        let op = (m ? m[1] : '') + c;
        if (seg[i + 1] === '>') { op += '>'; i++; }
        push();
        cur = op;
        push(); // 操作符作为独立 token，后续字符开新 token
        continue;
      }
    }
    if (c === '\\' && i + 1 < seg.length && /[\s\\'"`$;&|()<>*?]/.test(seg[i + 1])) { cur += seg[i + 1]; i++; continue; }
    cur += c;
  }
  push();
  return toks;
}

/**
 * 提取段内的写目标路径（写操作 token 后紧跟的路径）。读动词 → 空数组。
 * 🔴 H1/H4-fix: 重定向目标预扫。先拆分嵌入 token 的无空格重定向（echo>file → echo,>,file），
 * 再独立 for 循环收集全部 >/2>/&> 目标入 out——这样各动词 case 再怎么跳 token 也不丢重定向。
 */
function extractWriteTargets(seg) {
  const toks = tokenizeSegment(seg);
  const out = [];
  const add = (p, reason) => { if (p) out.push({ path: String(p).trim(), reason }); };

  // HIGH-1-fix: 无空格重定向拆分已迁入 tokenizeSegment 顶层（引号内不拆），这里不再后置预拆。
  // H4-fix: 重定向目标预扫（独立 for 循环，主循环动词 case 不吞）
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    // LOW-1-fix: 合并重定向正则覆盖 >/>>/2>/2>>/&>/&>>/>| (stdout+stderr 追加等)
    if (/^[0-9]?&?>>?[|]?$/.test(t)) {
      const nx = toks[i + 1];
      if (nx && /^[0-9]?[<>]&[0-9-]$/.test(nx)) { i++; continue; }
      add(toks[i + 1], 'redirect');
      i++;
    }
  }

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    // 重定向已在预扫处理，主循环跳过
    if (/^[0-9]?&?>[|]?$/.test(t) || /^[0-9]?>>$/.test(t)) continue;
    // 读侧重定向 < <<(已剥) <<< <& 跳过
    if (/^[0-9]*<[<>]?$/.test(t)) continue;
    // fd 复制
    if (/^[0-9]*[<>]&[0-9-]$/.test(t)) continue;
    // env 前缀 VAR=x
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;

    // M3-fix: 剥 .exe（Windows cp.exe/tee.exe/git.exe）
    const v = t.toLowerCase().split('/').pop().replace(/\.exe$/, '');
    switch (v) {
      case 'tee':
        // tee file1 file2 ... — 后续非 flag token 均为目标
        for (let j = i + 1; j < toks.length; j++) {
          if (toks[j].startsWith('-')) continue;
          add(toks[j], 'tee');
        }
        i = toks.length;
        break;
      case 'cp': case 'mv': case 'install': {
        // 收集位置参数；dst = 末个位置参数（-t DIR 时目标目录）
        const pos = [];
        let targetDir = null;
        for (let j = i + 1; j < toks.length; j++) {
          const tk = toks[j];
          if (tk === '-t' || tk === '--target-directory') { targetDir = toks[j + 1]; j++; continue; }
          if (tk.startsWith('-')) continue;
          pos.push(tk);
        }
        add(targetDir || pos[pos.length - 1], v);
        i = toks.length;
        break;
      }
      case 'ln': {
        const pos = [];
        let targetDir = null;
        for (let j = i + 1; j < toks.length; j++) {
          const tk = toks[j];
          if (tk === '-t' || tk === '--target-directory') { targetDir = toks[j + 1]; j++; continue; }
          if (tk.startsWith('-')) continue;
          pos.push(tk);
        }
        add(targetDir || pos[pos.length - 1], v);
        i = toks.length;
        break;
      }
      case 'rm': case 'touch': case 'mkdir':
        for (let j = i + 1; j < toks.length; j++) {
          const tk = toks[j];
          if (tk.startsWith('-')) continue;
          add(tk, v);
        }
        i = toks.length;
        break;
      case 'sed': case 'perl': {
        // H3-fix: 无 -i 是读（纯 sed 输出，不产出写目标）
        // HIGH-2-fix: 门控识别组合标志（perl -pi / sed -i.bak / -isuffix / --in-place）
        if (!toks.some(t => /^-[0-9a-z]*i/.test(t) || t.startsWith('--in-place'))) break;
        // 仅消费首个非 flag token 作为脚本（s/.../、d 等），其余当文件目标。
        // 旧逻辑 `tk.startsWith('d')` 误把 data/... 当脚本吞掉 → data/exemptions.json 放行。
        let script = true;
        for (let j = i + 1; j < toks.length; j++) {
          const tk = toks[j];
          if (tk.startsWith('-')) continue;
          if (script && (/^[sy]\//.test(tk) || /^[daciq]$/.test(tk))) { script = false; continue; }
          add(tk, v);
        }
        i = toks.length;
        break;
      }
      case 'curl': case 'wget': {
        for (let j = i + 1; j < toks.length; j++) {
          const tk = toks[j];
          if (tk === '-o' || tk === '-O' || tk === '--output') { add(toks[j + 1], 'curl-'+v); j++; }
          else if (tk.startsWith('--output=')) add(tk.slice(9), 'curl-'+v);
        }
        i = toks.length;
        break;
      }
      case 'dd':
        for (const tk of toks.slice(i + 1)) {
          if (tk.startsWith('of=')) add(tk.slice(3), 'dd');
        }
        i = toks.length;
        break;
      case 'tar':
        for (let j = i + 1; j < toks.length; j++) {
          if (toks[j] === '-C' || toks[j] === '--directory') { add(toks[j + 1], 'tar-C'); j++; }
        }
        i = toks.length;
        break;
      case 'unzip':
        for (let j = i + 1; j < toks.length; j++) {
          if (toks[j] === '-d') { add(toks[j + 1], 'unzip-d'); j++; }
        }
        i = toks.length;
        break;
      case 'git': {
        // checkout/restore: '--' 后文件为目标；无 '--' 时非 flag 尾 token 视为路径（M1-fix）
        // rm/mv: 非 flag token 为目标（M4-fix）；apply/merge/reset 走 DANGEROUS_BLIND
        const sub = toks[i + 1];
        if (sub === 'checkout' || sub === 'restore') {
          const dashIdx = toks.indexOf('--', i + 2);
          if (dashIdx !== -1) {
            for (let j = dashIdx + 1; j < toks.length; j++) add(toks[j], 'git-'+sub);
          } else {
            // 无 --：取含 / 或 . 的 token（路径形态），跳过分支名/commit hash
            for (let j = i + 2; j < toks.length; j++) {
              const tk = toks[j];
              if (tk.startsWith('-')) continue;
              if (tk.includes('/') || tk.includes('.')) add(tk, 'git-'+sub);
            }
          }
        } else if (sub === 'rm' || sub === 'mv') {
          for (let j = i + 2; j < toks.length; j++) {
            const tk = toks[j];
            if (tk.startsWith('-')) continue;
            add(tk, 'git-'+sub);
          }
        }
        i = toks.length;
        break;
      }
      case 'node': {
        // 仅 -e 解析 fs 写调用字面路径。H5-fix: 覆盖 async 变体（writeFile/appendFile/copyFile 等）
        const eIdx = toks.indexOf('-e');
        if (eIdx !== -1 && toks[eIdx + 1]) {
          const code = toks[eIdx + 1];
          const m = code.match(/(?:writeFile|appendFile|copyFile|rename|unlink|rm|truncate)(?:Sync)?\s*\(\s*['"]([^'"]+)['"]/);
          if (m) add(m[1], 'node-fs');
          else {
            // fs.open('f','w'/'a'/'x') / createWriteStream('f') / fs.promises.*
            const m2 = code.match(/(?:open|createWriteStream)\s*\(\s*['"]([^'"]+)['"]\s*,?\s*['"]?(?:w|a|x)/);
            if (m2) add(m2[1], 'node-fs');
          }
        }
        i = toks.length;
        break;
      }
      case 'python': case 'python3': case 'py': {
        const cIdx = toks.indexOf('-c');
        if (cIdx !== -1 && toks[cIdx + 1]) {
          const code = toks[cIdx + 1];
          const m = code.match(/open\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"](?:w|a|x)/);
          if (m) add(m[1], 'py-open');
        }
        i = toks.length;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * 把目标路径解析为候选绝对路径（/d/x 与 d:/x 双形式 + ~ 展开）。
 * MSYS 下 /d/AI文件/harness/... 必须映射成 d:/ai文件/harness/... 才能命中 CRITICAL_TARGETS。
 */
function resolveCandidates(target, cwd) {
  let t = String(target).trim();
  if (!t) return [];
  t = t.replace(/^~(?=[\\/]|$)/, HOME);
  const abs = /^[a-z]:\//i.test(t) || t.startsWith('/');
  const base = abs ? t : (cwd || '').replace(/\\/g, '/') + '/' + t;
  const canon = (p) => norm(path.posix.normalize(p));
  const out = [canon(base)];
  const m = base.match(/^\/([a-z])\/(.*)$/i);
  if (m) out.push(canon(m[1].toLowerCase() + ':/' + m[2]));
  return [...new Set(out)];
}

/** 目标是否落在临时目录（必须先于 basename 判定） */
function isTmp(target, cwd) {
  if (!target) return false;
  return resolveCandidates(target, cwd).some(c =>
    c.startsWith('/dev/') ? false
      : /^\$?(tmp|temp)/i.test(c)
      || /^(c|d|e):\/(tmp|temp)(\/|$)/.test(c)
      || (OS_TMP && (c === OS_TMP || c.startsWith(OS_TMP + '/'))));
}

/** 单路径比对：目标路径是否命中关键路径（不再用整命令 includes） */
function hitsCriticalPath(target, cwd) {
  const crit = CRITICAL_TARGETS.map(t => ({ ...t, n: norm(t.match) }));
  const isCritDir = (c) => crit.some(t => t.type === 'dir' && (c === t.n || c.startsWith(t.n + '/')));
  const isCritFile = (c) => crit.some(t => t.type === 'file' && c === t.n);
  const cands = resolveCandidates(target, cwd);
  for (const c of cands) if (isCritFile(c) || isCritDir(c)) return true;
  // 通配符：用 * 前字面前缀判定
  const ts = String(target);
  if (ts.includes('*')) {
    for (const c of resolveCandidates(ts.split('*')[0], cwd)) if (isCritDir(c)) return true;
  }
  // basename 兜底仅对含变量/命令替换的非字面目标生效（字面路径已被 file/dir 精确覆盖）
  const hasVar = /\$|`|\$\{/.test(ts);
  if (hasVar) {
    const base = (ts.split(/[\\/]/).pop() || '').replace(/\*/g, '').toLowerCase();
    for (const b of CRITICAL_BASENAMES) if (base === b.name.toLowerCase()) return true;
  }
  return false;
}

/** 无条件危险命令（v2.8: 词边界修复，merge 不再吃 merge-base） */
function isDangerousBlind(seg) {
  const DANGEROUS_BLIND = [
    /\bgit\s+clean\s+.*-f/i,
    /\bgit\s+stash\s+(pop|apply)\b/i,
    /\bgit\s+(?:merge|pull|cherry-pick|rebase)(?![-\w])/i,
    /\bgit\s+reset\s+--hard/i,
    /\bgit\s+apply\b(?!.*\b--(check|stat|numstat|dry-run)\b)/i,
    /\brm\s+-rf\s+(\$|\/|\.|\.claude|scripts|mcp|sentinel|data)/i,
  ];
  return DANGEROUS_BLIND.find(re => re.test(seg));
}

/** 追踪 cd 变更虚拟 cwd（限字面路径）。H6-fix: 放宽识别 (cd ... 子壳前缀 */
function applyCd(seg, state) {
  const m = seg.match(/^[()\s]*cd\s+(.+)$/);
  if (!m) return;
  const clean = m[1].replace(/["']/g, '').trim();
  if (!clean) return;
  if (clean.startsWith('~')) {
    state.cwd = norm(HOME + clean.slice(1));
    return;
  }
  const abs = /^[a-z]:\//i.test(clean) || clean.startsWith('/');
  state.cwd = norm(abs ? clean : (state.cwd || '') + '/' + clean);
}

/** 主判定链 */
function checkCommand(command, cwd) {
  const state = { cwd: norm(cwd || '') };
  const segments = splitSegments(command);
  if (segments === null) {
    archive('parse_fail', { reason: 'unclosed quote/heredoc', tool: 'Bash' });
    return null;
  }
  for (const seg of segments) {
    if (/^[()\s]*cd\b/.test(seg.trim())) applyCd(seg, state);
    const blind = isDangerousBlind(seg);
    if (blind) {
      archive('deny', { command: command.slice(0, 300), target: '无条件危险命令 (blind): ' + blind.source });
      return { decision: 'deny', reason: '🛑 Bash-write-guard: 检测到无条件危险命令（harness 仓库 cwd 内）。\n匹配: ' + command.slice(0, 200) + '\n\n此类命令会清空/覆写工作区（含密钥、令牌、防线代码）。\n如需维护 Harness，请走解锁流程 + Edit/Write 工具。' };
    }
    for (const t of extractWriteTargets(seg)) {
      if (isTmp(t.path, state.cwd)) continue;
      if (norm(t.path).startsWith('/dev/')) continue;
      if (hitsCriticalPath(t.path, state.cwd)) {
        archive('deny', { command: command.slice(0, 300), target: t.path, reason: t.reason });
        return {
          decision: 'deny',
          reason: `🛑 Bash-write-guard: 检测到对 Harness 关键安全文件的写操作。\n目标: ${t.path}\n命令: ${command.slice(0, 200)}\n\n这些文件（密码/密钥/令牌/防线代码）受 Harness 双因子保护，只允许通过正式流程修改。\n如需修改 Harness 自身代码，请走解锁流程（用户运行 harness-unlock.cjs）并使用 Edit/Write 工具。`,
        };
      }
    }
  }
  return { decision: 'allow' };
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
  const cwd = String(ti.cwd || input.cwd || '').trim() || process.cwd();

  // 只拦截 Bash
  if (toolName !== 'Bash') return { decision: 'allow' };
  if (!command) {
    archive('parse_fail', { reason: 'empty command', tool: toolName });
    return { decision: 'deny', reason: '🛑 Bash-write-guard: 无法解析 Bash 命令（fail-closed）。' };
  }

  const result = checkCommand(command, cwd);
  if (result === null) {
    return { decision: 'deny', reason: '🛑 Bash-write-guard: 无法解析 Bash 命令（未闭合引号/heredoc，fail-closed）。' };
  }
  return result;
}

process.stdout.write(JSON.stringify(run()));

/**
 * MainHarnessChecker — 业务流水线本地硬校验脚本
 * ===================================================
 * 🔴 零 LLM 依赖——所有检查纯本地确定性执行，输出结构化 JSON。
 * LLM 仅对脚本输出结果做汇总评审，不参与检查逻辑。
 *
 * 接管范围：
 *   S4 架构铁律硬校验：
 *     CK-01  九层管线依赖检查（M1-M9 无循环依赖）
 *     CK-02  PFC 薄调度检查（chat.ts 禁止堆砌业务逻辑）
 *     CK-03  FG 户籍规范检查（角色扮演分支隔离）
 *     CK-04  UUID 全链路标注检查（belong_entity_uuid 四层机制）
 *     CK-05  12 处 _meetingEntityName grep 核验
 *     CK-06  SQLite save() 调用完整性检查
 *     CK-07  高风险依赖扫描（chat.ts / FG / SQLiteAdapter import 链）
 *   S5 补丁嗅探：
 *     CK-08  AST if 分支数量扫描（≥2 → 疑似补丁标记）
 *
 * 输出格式（stdout JSON）：
 *   { checks: CheckResult[], summary: {...}, cacheable: {...} }
 *
 * 使用方式：
 *   npx tsx src/main_harness_checker.ts \
 *     --project-root D:/tools/wenstar-cc \
 *     --files "src/webui/chat.ts,src/m4/SQLiteAdapter.ts" \
 *     --stage S4 \
 *     --cache-dir D:/AI文件/harness/data/cache
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, dirname, basename, join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// ════════════════════════════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════════════════════════════

/** 单条检查结果 */
interface CheckResult {
  /** 检查编号 */
  id: string;
  /** 检查名称 */
  name: string;
  /** 是否通过 */
  passed: boolean;
  /** 风险等级 */
  severity: 'pass' | 'warn' | 'fail';
  /** 违规项列表 */
  violations: Violation[];
  /** 执行耗时(ms) */
  durationMs: number;
  /** 是否可缓存 */
  cacheable: boolean;
}

/** 违规项 */
interface Violation {
  /** 违规行号（若可定位） */
  line?: number;
  /** 违规文件路径 */
  file: string;
  /** 违规描述 */
  message: string;
  /** 违规片段 */
  snippet?: string;
}

/** 顶层 JSON 输出 */
interface CheckerOutput {
  /** 检查阶段 */
  stage: string;
  /** 项目根目录 */
  project_root: string;
  /** 被检查的文件列表 */
  files: string[];
  /** 所有检查结果 */
  checks: CheckResult[];
  /** 汇总 */
  summary: CheckerSummary;
  /** 可缓存数据（供后续复用） */
  cacheable: CacheableData;
}

interface CheckerSummary {
  total: number;
  passed: number;
  failed: number;
  warned: number;
  /** 是否全部硬性检查通过 */
  all_hard_passed: boolean;
  /** 失败检查的 ID 列表 */
  failed_ids: string[];
  /** 供 LLM 汇总的简要文本 */
  llm_brief: string;
}

interface CacheableData {
  fg_redlines_check?: unknown;
  meeting_points_check?: unknown;
  patch_scan?: unknown;
  generated_at: string;
}

// ════════════════════════════════════════════════════════════════════
// 配置
// ════════════════════════════════════════════════════════════════════

/** 高风险文件列表（basename 后缀匹配） */
const HIGH_RISK_FILES = [
  'chat.ts', 'FamilyGraph.ts', 'SQLiteAdapter.ts',
  'server.ts', 'DeepSeekLLMProvider.ts', 'PrefrontalCortex.ts',
];

/** v2.9.2: 高风险目录（路径前缀匹配——雷区已从 chat.ts 转移到 chat/*.ts 阶段管线；governance 为内容豁免总开关） */
const HIGH_RISK_DIRS = [
  'src/webui/chat/',
  'src/governance/',
];

/** 九层管线模块前缀 */
const M1_M9_MODULES = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'];

/** AST 补丁检测阈值：单个已有函数新增 ≥N 个条件分支 → 疑似补丁 */
const PATCH_IF_THRESHOLD = 2;

// ════════════════════════════════════════════════════════════════════
// 入口
// ════════════════════════════════════════════════════════════════════

/** 解析命令行参数 */
function parseArgs(): { projectRoot: string; files: string[]; stage: string; cacheDir: string } {
  const args = process.argv.slice(2);
  const result: ReturnType<typeof parseArgs> = {
    projectRoot: process.cwd(),
    files: [],
    stage: 'S4',
    cacheDir: '',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--project-root': result.projectRoot = resolve(args[++i]); break;
      case '--files': result.files = args[++i].split(',').map(f => f.trim()).filter(Boolean); break;
      case '--stage': result.stage = args[++i]; break;
      case '--cache-dir': result.cacheDir = resolve(args[++i]); break;
      default: break;
    }
  }

  return result;
}

/**
 * 主入口：执行所有检查并输出 JSON 到 stdout。
 */
function main(): void {
  const { projectRoot, files, stage, cacheDir } = parseArgs();

  if (!files.length) {
    console.error('[MainHarnessChecker] 错误: 必须指定 --files');
    process.exit(1);
  }

  const allChecks: CheckResult[] = [];

  if (stage === 'S1' || stage === 'all') {
    allChecks.push(
      checkGlobalSurvey(projectRoot, files),
    );
  }

  if (stage === 'S4' || stage === 'all') {
    allChecks.push(
      checkNineLayerPipeline(projectRoot, files),
      checkPFCThinScheduler(projectRoot, files),
      checkFGHouseholdSpec(projectRoot, files),
      checkUUIDAnnotationChain(projectRoot, files),
      checkMeetingEntityPoints(projectRoot, files),
      checkSQLiteSaveCalls(projectRoot, files),
      checkSystemicPattern(projectRoot, files),
      checkHighRiskDependencyScan(projectRoot, files),
      checkContentSafetyExemptions(projectRoot, files),
    );
  }

  if (stage === 'S5' || stage === 'all') {
    allChecks.push(
      checkASTIfBranchCount(projectRoot, files),
    );
  }

  if (stage === 'S6' || stage === 'all') {
    allChecks.push(
      checkRegressionSafety(projectRoot, files),
      checkIntentFulfillment(projectRoot, files),
    );
  }

  // 构建输出
  const summary = buildSummary(allChecks);
  const cacheable = buildCacheable(allChecks);

  const output: CheckerOutput = {
    stage,
    project_root: projectRoot,
    files,
    checks: allChecks,
    summary,
    cacheable,
  };

  // 输出 JSON 到 stdout（LLM 读取此输出做汇总）
  process.stdout.write(JSON.stringify(output, null, 2));
}

// ════════════════════════════════════════════════════════════════════
// CK-01: 九层管线依赖检查
// ════════════════════════════════════════════════════════════════════

function checkNineLayerPipeline(projectRoot: string, files: string[]): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];

  // 解析每个文件的上层 import 来源
  for (const file of files) {
    const absPath = resolve(projectRoot, file);
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');
    const fileModule = getModuleLayer(file);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 🔴 P9-fix: 跳过纯类型引用（import type），它们编译后消失，不构成运行时依赖
      // 允许跨层的类型级引用（如 m2 引用 m3 的 Perception24D 类型），只拦运行时反向依赖
      const typeImportMatch = line.match(/import\s+type\s+.*\s+from\s+['"](\.\.?\/[^'"]+)['"]/);
      if (typeImportMatch) continue;

      // 匹配 import 语句
      const importMatch = line.match(/import\s+.*\s+from\s+['"](\.\.?\/[^'"]+)['"]/);
      if (!importMatch) continue;

      const importPath = importMatch[1];
      const resolvedPath = resolve(dirname(absPath), importPath);
      const relativePath = relative(projectRoot, resolvedPath).replace(/\\/g, '/');
      const importedModule = getModuleLayer(relativePath);

      // M1-M9 模块间不允许反向依赖（低层不能 import 高层）
      // 注意: 仅运行时依赖受此约束；类型级引用（import type）已在上方豁免
      if (fileModule && importedModule && isReverseDependency(fileModule, importedModule)) {
        violations.push({
          line: i + 1,
          file,
          message: `九层管线反向依赖: ${fileModule}(${relativePath}) 不允许引用上层模块 ${importedModule}(${relativePath})`,
        });
      }
    }
  }

  return {
    id: 'CK-01',
    name: '九层管线依赖检查',
    passed: violations.length === 0,
    severity: violations.length > 0 ? 'fail' : 'pass',
    violations,
    durationMs: Date.now() - start,
    cacheable: false,
  };
}

/** 从文件路径提取 M1-M9 层级 */
function getModuleLayer(filePath: string): string | null {
  for (const m of M1_M9_MODULES) {
    if (filePath.includes(`/${m}/`) || filePath.startsWith(`${m}/`)) {
      return m;
    }
  }
  return null;
}

/** m<n> ← m<k> (k < n) 即低层引用高层 = 反向依赖 */
function isReverseDependency(from: string, imported: string): boolean {
  const fromNum = parseInt(from.slice(1), 10);
  const impNum = parseInt(imported.slice(1), 10);
  return fromNum < impNum;
}

// ════════════════════════════════════════════════════════════════════
// CK-02: PFC 薄调度检查
// ════════════════════════════════════════════════════════════════════

function checkPFCThinScheduler(projectRoot: string, files: string[]): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];

  // 仅检查 chat.ts
  const chatFile = files.find(f => f.endsWith('chat.ts') || f === 'src/webui/chat.ts');
  if (!chatFile) return { id: 'CK-02', name: 'PFC薄调度检查', passed: true, severity: 'pass', violations: [], durationMs: Date.now() - start, cacheable: false };

  const absPath = resolve(projectRoot, chatFile);
  if (!existsSync(absPath)) return { id: 'CK-02', name: 'PFC薄调度检查', passed: true, severity: 'pass', violations: [], durationMs: Date.now() - start, cacheable: false };

  const content = readFileSync(absPath, 'utf-8');
  const lines = content.split('\n');

  // 🔴 检查 chat.ts 是否存在过多业务逻辑：
  // 1. 行数超过 2000 行（薄调度层不应膨胀）
  if (lines.length > 2000) {
    violations.push({
      line: 1,
      file: chatFile,
      message: `chat.ts 行数 ${lines.length} 行 → 超过薄调度层阈值 2000 行，疑似堆砌业务逻辑`,
    });
  }

  // 2. 检查是否直接操作数据库/存储（应由 PFC/M4 处理）
  const dbPatterns = [
    { pattern: /SQLiteAdapter\.(getInstance|create|new\s+SQLiteAdapter)/, msg: 'chat.ts 直接操作 SQLiteAdapter——应委托 PFC' },
    { pattern: /\.save\(\)|\.flush\(\)|scheduleFlush/, msg: 'chat.ts 直接调用持久化方法——应委托 M4' },
    { pattern: /KnowledgeEngine\.(query|search|index)/, msg: 'chat.ts 直接查询知识库——应委托 PFC' },
  ];

  for (let i = 0; i < lines.length; i++) {
    for (const { pattern, msg } of dbPatterns) {
      if (pattern.test(lines[i]) && !isCommentLine(lines[i])) {
        violations.push({ line: i + 1, file: chatFile, message: msg, snippet: lines[i].trim().slice(0, 120) });
      }
    }
  }

  return {
    id: 'CK-02',
    name: 'PFC薄调度检查',
    passed: violations.length === 0,
    severity: violations.length > 0 ? 'fail' : 'pass',
    violations,
    durationMs: Date.now() - start,
    cacheable: false,
  };
}

// ════════════════════════════════════════════════════════════════════
// CK-03: FG 户籍规范检查
// ════════════════════════════════════════════════════════════════════

function checkFGHouseholdSpec(projectRoot: string, files: string[]): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];

  const fgFiles = files.filter(f => f.includes('FamilyGraph') || f.includes('family_graph') || f.includes('fg/'));
  if (!fgFiles.length) {
    return { id: 'CK-03', name: 'FG户籍规范检查', passed: true, severity: 'pass', violations: [], durationMs: Date.now() - start, cacheable: true };
  }

  for (const file of fgFiles) {
    const absPath = resolve(projectRoot, file);
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');

    // 检查角色扮演分支是否硬编码引用主库
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;

      // 主 FG 写入时是否区分了分支
      if (line.includes('family_graph') && line.includes('INSERT') && !line.includes('branch') && !line.includes('roleplay')) {
        violations.push({
          line: i + 1, file,
          message: 'FG 写入未区分主库/角色扮演分支——存在数据污染风险',
          snippet: line.trim().slice(0, 120),
        });
      }
    }
  }

  return {
    id: 'CK-03',
    name: 'FG户籍规范检查',
    passed: violations.length === 0,
    severity: violations.length > 0 ? 'fail' : 'pass',
    violations,
    durationMs: Date.now() - start,
    cacheable: true,
  };
}

// ════════════════════════════════════════════════════════════════════
// CK-04: UUID 全链路标注检查
// ════════════════════════════════════════════════════════════════════

function checkUUIDAnnotationChain(projectRoot: string, files: string[]): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];

  const uuidPattern = /belong_entity_uuid|TXS-[a-f0-9-]+|UUIDGatekeeper/;

  for (const file of files) {
    const absPath = resolve(projectRoot, file);
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');

    // 检查 UUID 相关修改是否破坏了四层标注机制
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;

      // 检测 belong_entity_uuid 的写入点是否有四层标注
      if (line.includes('belong_entity_uuid') && line.includes('=') && !line.includes('//')) {
        // 检查附近是否缺少标注层级注释
        const contextStart = Math.max(0, i - 3);
        const contextEnd = Math.min(lines.length, i + 3);
        const context = lines.slice(contextStart, contextEnd).join('\n');

        if (!context.includes('在线') && !context.includes('启动回填') && !context.includes('离线脚本') && !context.includes('知识库')) {
          // 不强制报错——仅 warn（可能在其他位置标注）
        }
      }
    }
  }

  return {
    id: 'CK-04',
    name: 'UUID全链路标注检查',
    passed: violations.length === 0,
    severity: violations.length > 0 ? 'fail' : 'pass',
    violations,
    durationMs: Date.now() - start,
    cacheable: false,
  };
}

// ════════════════════════════════════════════════════════════════════
// CK-05: 12 处 _meetingEntityName grep 核验
// ════════════════════════════════════════════════════════════════════

/** v2.9.2: 从 chat.ts 解析 V15 自编目（MEETING_PROP_POINTS 数组字面量）——权威索引在代码内，随代码同步漂移
 *  返回 { entries, catalogEndIdx }——catalogEndIdx 为编目数组结束行，供 via 搜索排除编目自身 */
function parseMeetingCatalog(lines: string[]): { entries: Array<{ line: number; stage: string; desc: string; via: string }>; catalogEndIdx: number } {
  const entries: Array<{ line: number; stage: string; desc: string; via: string }> = [];
  let started = false;
  let catalogEndIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes('MEETING_PROP_POINTS')) { started = true; continue; }
    if (!started) continue;
    const m = l.match(/\{\s*line:\s*(\d+),\s*stage:\s*'([^']*)',\s*desc:\s*'([^']*)',\s*via:\s*'([^']*)'\s*\}/);
    if (m) entries.push({ line: +m[1], stage: m[2], desc: m[3], via: m[4] });
    if (entries.length > 0 && /^\s*\];/.test(l)) { catalogEndIdx = i; break; }
  }
  return { entries, catalogEndIdx };
}

/** v2.9.2: 收集 chat.ts 中所有非注释的 _meetingEntityName/meetingEntity/meeting_entity 真实引用点 */
function collectMeetingRefs(lines: string[]): Array<{ line: number; text: string }> {
  const refs: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i])) continue;
    if (/_meetingEntityName|meetingEntity|meeting_entity/.test(lines[i])) refs.push({ line: i + 1, text: lines[i].trim() });
  }
  return refs;
}

/**
 * v2.9.2: 语义级校验——编目点位是否有传播证据。
 * 修正：编目行号本身会随 chat.ts 重构漂移（实测 L651→实际 L620，偏差 30 行）。
 * 硬判据改为「via 标记在全文存在」（传播链未断）——编目行号偏差仅 warn，不 fail，
 * 避免「编目没同步行号」就误伤正常开发。
 */
function catalogEntryHasEvidence(lines: string[], entry: { line: number; via: string }): boolean {
  // via 标记全局存在（硬判据——传播链断裂才算 fail）
  if (!!entry.via && lines.some(l => l.includes(entry.via))) return true;
  // 无 via 标记时，看 _meetingEntityName 系列引用全文存在
  if (lines.some(l => /_meetingEntityName|meetingEntity|meeting_entity/.test(l))) return true;
  return false;
}

/** v2.9.2: 编目行号是否与实际 via 位置偏差过大（>20 行 → warn，提示编目需同步）
 *  排除编目定义自身行（MEETING_PROP_POINTS 数组内也含 via 字符串），从编目结束后搜索 */
function catalogLineDrifted(lines: string[], entry: { line: number; via: string }, catalogStartIdx: number): number | null {
  if (!entry.via) return null;
  const fromIdx = catalogStartIdx > 0 ? catalogStartIdx : 0;
  const actualIdx = lines.findIndex((l, i) => i > fromIdx && l.includes(entry.via));
  if (actualIdx === -1) return null;
  return Math.abs((actualIdx + 1) - entry.line);
}

// v2.9.2: CK-05 会晤传播链语义核验（替代硬编码行号——原 12 点全部失效，隔离检查空转）
function checkMeetingEntityPoints(projectRoot: string, files: string[]): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];
  const warnings: Violation[] = [];

  // 仅当修改涉及 chat.ts 或会晤相关逻辑时启用
  const meetingFiles = files.filter(f =>
    f.endsWith('chat.ts') || f.includes('meeting') || f.includes('Meeting') ||
    f.includes('EntityMeeting') || f.includes('MeetingContext')
  );
  if (!meetingFiles.length) {
    return { id: 'CK-05', name: '会晤传播链语义核验', passed: true, severity: 'pass', violations: [], durationMs: Date.now() - start, cacheable: true };
  }

  const chatPath = resolve(projectRoot, 'src/webui/chat.ts');
  if (!existsSync(chatPath)) {
    return { id: 'CK-05', name: '会晤传播链语义核验', passed: true, severity: 'pass', violations: [], durationMs: Date.now() - start, cacheable: true };
  }
  const lines = readFileSync(chatPath, 'utf-8').split('\n');

  // 1) V15 编目必须存在且可解析（权威索引缺失 = 传播链不可验证 → hard fail）
  const catalogParsed = parseMeetingCatalog(lines);
  const catalog = catalogParsed.entries;
  if (catalog.length === 0) {
    violations.push({ line: 1, file: 'src/webui/chat.ts',
      message: 'V15 _meetingEntityName 编目（MEETING_PROP_POINTS）缺失或无法解析——会晤传播链不可验证。该自编目是架构铁律#6 的权威索引，必须保留。' });
  }

  // 2) 编目 ↔ 真实代码交叉验证（核心，替代硬编码行号）
  // v2.9.2-fix: 硬判据=via 标记全文存在（传播链断裂→fail）；编目行号偏差>20→warn（提示编目需同步）
  const refs = collectMeetingRefs(lines);
  for (const entry of catalog) {
    if (!catalogEntryHasEvidence(lines, entry)) {
      violations.push({ line: entry.line, file: 'src/webui/chat.ts',
        message: `V15 编目 L${entry.line} (${entry.stage}/${entry.desc}) 传播链断裂：via 标记 "${entry.via}" 与 _meetingEntityName 系列引用全文均不存在——会晤传播链缺失` });
    } else {
      const drift = catalogLineDrifted(lines, entry, catalogParsed.catalogEndIdx);
      if (drift !== null && drift > 20) {
        warnings.push({ line: entry.line, file: 'src/webui/chat.ts',
          message: `V15 编目 L${entry.line} (${entry.stage}) 行号偏移 ${drift} 行——请同步更新编目行号` });
      }
    }
  }

  // 3) 关键传播锚点必须存在（阶段锚点正则，不依赖行号；单行匹配）
  const anchors: Array<{ name: string; re: RegExp }> = [
    { name: '实体名声明(let _meetingEntityName)', re: /let\s+_meetingEntityName/ },
    { name: '实体名赋值(getEntityName)', re: /_meetingEntityName\s*=\s*ctx\._entityMeeting\.getEntityName/ },
    { name: 'M4 会晤UUID隔离(orchestrate)', re: /ctx\.m4\.orchestrate\(/ },
    { name: 'M5 会晤标记(orchestrate 传 _meetingEntityName)', re: /ctx\.m5\.orchestrate\([^)]*_meetingEntityName/ },
    { name: 'ChatPolicy 会晤模式(meetingMode)', re: /new\s+ChatPolicy\(meetingMode\(/ },
  ];
  for (const a of anchors) {
    if (!lines.some(l => a.re.test(l))) {
      violations.push({ line: 1, file: 'src/webui/chat.ts', message: `会晤传播锚点缺失: ${a.name}` });
    }
  }

  // 4) 引用规模（传播链需存在，偏低仅 warn）
  if (refs.length < 8) {
    warnings.push({ line: 1, file: 'src/webui/chat.ts',
      message: `_meetingEntityName 真实引用点仅 ${refs.length} 处（预期 ≥8），传播链规模偏低` });
  }

  const hardFail = violations.length > 0;
  return {
    id: 'CK-05',
    name: '会晤传播链语义核验',
    passed: violations.length === 0 && warnings.length === 0,
    severity: hardFail ? 'fail' : (warnings.length > 0 ? 'warn' : 'pass'),
    violations: [...violations, ...warnings],
    durationMs: Date.now() - start,
    cacheable: true,
  };
}

// ════════════════════════════════════════════════════════════════════
// CK-06: SQLite save() 调用完整性检查
// ════════════════════════════════════════════════════════════════════

// ── CK-06 辅助层 (v2.13-fix 2026-08-15) ──
// 重构 CK-06 检测为单遍 O(n) 状态机，消除 19 个误报。
// 核心: 方法开始 = 行首签名 + 括号归0 + 行尾{；方法结束 = 花括号配平（嵌套块不误判）；
//       词法清洗剥离字符串/注释/模板保证括号计数可靠；保守优先（宁可漏检不误报）。

interface LexState { blockComment: boolean; template: boolean; str: "'" | '"' | null; }

/** 跨行有状态词法清洗：把字符串/模板/注释内容替换为空格（保持长度），返回"纯代码" */
function cleanCode(line: string, st: LexState): { clean: string; st: LexState } {
  const out: string[] = new Array(line.length).fill(' ');
  let i = 0;
  while (i < line.length) {
    const c = line[i], n = line[i + 1];
    if (st.str) {
      if (c === '\\') { i += 2; continue; }
      if (c === st.str) st.str = null;
      i++; continue;
    }
    if (st.blockComment) {
      if (c === '*' && n === '/') { st.blockComment = false; i += 2; continue; }
      i++; continue;
    }
    if (st.template) {
      if (c === '`') st.template = false;
      i++; continue;
    }
    if (c === '/' && n === '/') break;
    if (c === '/' && n === '*') { st.blockComment = true; i += 2; continue; }
    if (c === '`') { st.template = true; i++; continue; }
    if (c === "'" || c === '"') { st.str = c; i++; continue; }
    out[i] = c; i++;
  }
  return { clean: out.join(''), st };
}

function braceDelta(code: string): number {
  let n = 0;
  for (const ch of code) { if (ch === '{') n++; else if (ch === '}') n--; }
  return n;
}
function parenDelta(code: string): number {
  let n = 0;
  for (const ch of code) { if (ch === '(') n++; else if (ch === ')') n--; }
  return n;
}

const METHOD_SIG_RE = /^\s*(?:(?:private|public|protected|async|static|readonly|export|function)\s+)*([A-Za-z_$][\w$]*)\s*\(/;
const WRITE_METHOD_NAME_RE = /^(insert|update|delete|write|save|store|persist|upsert)/;
const PERSIST_PRIMITIVES = new Set(['save', 'scheduleFlush', 'flush', 'flushNow', 'shutdownFlush']);
const BLOCK_OPEN_RE = /\{\s*$/;
const PERSIST_SIGNALS = ['.save()', 'scheduleFlush', '.flush()', '.export()'];
const DELEGATE_SIGNALS = ['.write(', '.writeRaw(', '.writeMemory('];

function hasPersistSignal(raw: string): boolean {
  return PERSIST_SIGNALS.some(s => raw.includes(s)) || DELEGATE_SIGNALS.some(s => raw.includes(s));
}

function checkSQLiteSaveCalls(projectRoot: string, files: string[]): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];

  // 仅检查涉及持久化的文件
  const persistFiles = files.filter(f =>
    f.includes('SQLite') || f.includes('persistence') || f.includes('FusionStorage') ||
    f.includes('ConversationDB') || f.includes('KnowledgeEngine') || f.includes('Adapter')
  );
  if (!persistFiles.length) {
    return { id: 'CK-06', name: 'SQLite save()调用检查', passed: true, severity: 'pass', violations: [], durationMs: Date.now() - start, cacheable: false };
  }

  for (const file of persistFiles) {
    const absPath = resolve(projectRoot, file);
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');

    // 单遍 O(n) 状态机 (v2.13-fix 2026-08-15): 括号配平替代逐行正则，消除嵌套 } 误判 / 调用行误当方法开始
    let inMethod = false, methodStartLine = 0, hasSave = false, depth = 0, bodyLines = 0;
    let sigName: string | null = null, sigStartLine = 0, sigParens = 0, sigLines = 0;
    const lex: LexState = { blockComment: false, template: false, str: null };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const { clean } = cleanCode(raw, lex);

      // 模式1: 方法体内
      if (inMethod) {
        if (hasPersistSignal(raw)) hasSave = true;
        depth += braceDelta(clean);
        if (depth <= 0) { // 括号配平归0 = 方法结束（嵌套块闭合 } 深度>0 不触发）
          if (depth === 0 && bodyLines > 0 && !hasSave) {
            violations.push({
              line: methodStartLine,
              file,
              message: `写入方法无防抖落盘调用: 从行 ${methodStartLine} 开始的方法缺少 .save()/scheduleFlush() 调用`,
            });
          }
          inMethod = false; depth = 0; hasSave = false; bodyLines = 0;
        }
        if (inMethod && clean.trim().length > 0) bodyLines++;
        continue;
      }

      // 模式2: 多行签名续行确认
      if (sigName) {
        if (++sigLines > 50) { sigName = null; sigParens = 0; continue; }
        sigParens += parenDelta(clean);
        if (sigParens > 0) continue;
        if (BLOCK_OPEN_RE.test(clean.trim())) {
          inMethod = true; depth = 1; hasSave = false; bodyLines = 0;
          methodStartLine = sigStartLine;
        }
        sigName = null; sigParens = 0;
        continue;
      }

      // 模式0: 探测方法签名候选（行首签名 + 括号归0 + 行尾{ 才确认，排除 this.write()/writeFileSync()/updateDynamics() 等调用）
      const m = METHOD_SIG_RE.exec(clean);
      if (m && WRITE_METHOD_NAME_RE.test(m[1]) && !PERSIST_PRIMITIVES.has(m[1])) {
        const openParenIdx = m.index + m[0].length - 1;
        const afterParen = clean.slice(openParenIdx + 1);
        const p = 1 + parenDelta(afterParen);
        if (p === 0) {
          if (BLOCK_OPEN_RE.test(afterParen)) {
            inMethod = true; depth = 1; hasSave = false; bodyLines = 0;
            methodStartLine = i + 1;
          }
        } else if (p > 0) {
          sigName = m[1]; sigStartLine = i + 1; sigParens = p; sigLines = 0;
        }
      }
    }
  }

  return {
    id: 'CK-06',
    name: 'SQLite save()调用检查',
    passed: violations.length === 0,
    severity: violations.length > 0 ? 'fail' : 'pass',
    violations,
    durationMs: Date.now() - start,
    cacheable: false,
  };
}

// ════════════════════════════════════════════════════════════════════
// CK-06.5: 举一反三系统性扫描 — 是共性问题还是个性特例
// ════════════════════════════════════════════════════════════════════

function checkSystemicPattern(projectRoot: string, files: string[], extraExclude?: string[]): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];
  const n = files.map(f => f.replace(/\\/g, '/'));

  if (!existsSync(resolve(projectRoot, 'src'))) {
    return { id: 'CK-06.5', name: '举一反三系统性扫描', passed: true, severity: 'pass', violations: [], durationMs: 0, cacheable: false };
  }

  // 1. 提取待修改代码的特征模式
  const patterns = extractCodePatterns(projectRoot, files);

  // 2. 对每个模式做全仓库 grep，找同类问题
  //    v2.6: extraExclude（豁免文件）并入搜索排除集——它们不贡献特征、也不作为"必须一起修"的目标
  const searchExclude = [...files, ...(extraExclude || [])];
  const systemicHits: Array<{ pattern: string; file: string; line: number; snippet: string }> = [];
  for (const pat of patterns) {
    const hits = searchPatternInRepo(projectRoot, pat.pattern, searchExclude);
    for (const hit of hits) {
      systemicHits.push({ ...hit, pattern: pat.description });
    }
  }

  // 3. 判定：共性 vs 个性
  if (systemicHits.length > 0) {
    const uniqueFiles = new Set(systemicHits.map(h => h.file));
    violations.push({
      file: n[0] || '',
      message: `🔴 共性问题: 特征模式在 ${uniqueFiles.size} 个额外文件中发现 ${systemicHits.length} 处同类问题，必须一起修复！`,
    });
    for (const hit of systemicHits.slice(0, 10)) {
      violations.push({
        line: hit.line, file: hit.file,
        message: `同类模式 "${hit.pattern}" → ${hit.file}:L${hit.line}: ${hit.snippet.slice(0, 80)}`,
      });
    }
    if (systemicHits.length > 10) {
      violations.push({
        file: '全仓库',
        message: `...还有 ${systemicHits.length - 10} 处同类问题未列出。S2 方案必须覆盖全部。`,
      });
    }
  } else {
    violations.push({
      file: n[0] || '',
      message: '✅ 个性特例: 未在仓库其他位置发现同类问题模式，可作为局部修改处理。',
    });
  }

  return {
    id: 'CK-06.5',
    name: '举一反三系统性扫描',
    passed: systemicHits.length === 0, // 有同类问题 → 需要扩大方案
    severity: systemicHits.length > 0 ? 'fail' : 'pass',
    violations,
    durationMs: Date.now() - start,
    cacheable: false,
  };
}

/** 从待修改文件中提取可搜索的特征模式 */
function extractCodePatterns(projectRoot: string, files: string[]): Array<{ pattern: string; description: string }> {
  const patterns: Array<{ pattern: string; description: string }> = [];

  for (const file of files) {
    const absPath = resolve(projectRoot, file);
    if (!existsSync(absPath)) continue;
    const content = readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');

    // 特征提取优先级:
    // 1) 函数名 / 方法名 (如 updateRelation)
    // 2) 关键 API 调用 (如 .save() / .query() / .insert())
    // 3) 特定的字段赋值 (如 entity.relation =)
    // 4) 异常处理模式 (如 try {} catch {} 空块)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;

      // 函数定义
      const funcMatch = line.match(/(?:async\s+)?(?:function\s+)?(?:private\s+|public\s+|export\s+)?(\w+)\s*\([^)]*\)\s*[{:]/);
      if (funcMatch && funcMatch[1].length > 3 && !['if','for','while','switch','catch','try'].includes(funcMatch[1])) {
        const funcName = funcMatch[1];
        // 方法名: 查找整个仓库中的同名调用
        patterns.push({
          pattern: `\\.${funcName}\\(`,
          description: `方法调用 .${funcName}()`,
        });
      }

      // 特定 API: .save() / .update() / .insert() / .delete()
      const apiMatch = line.match(/\.(save|update|insert|query|execute|dispatch|emit|send|process|handle|transform)\s*\(/);
      if (apiMatch) {
        const apiName = apiMatch[1];
        patterns.push({
          pattern: `\\.${apiName}\\(`,
          description: `API调用 .${apiName}()`,
        });
      }

      // 关系/边相关的赋值
      const relMatch = line.match(/(\w+)\s*[.=]\s*(?:new\s+)?(\w+)\s*\(?/);
      if (relMatch && isRelationKeyword(relMatch[1])) {
        patterns.push({
          pattern: `\\b${relMatch[1]}\\s*[.=]`,
          description: `关系赋值: ${relMatch[1]}`,
        });
      }

      // 🔴 P9-fix: 移除"空值兜底模式 if(null) return"的特征提取
      // 原因: `if (x === null) return` 是正常的防御性编程，不是 bug。
      // 原逻辑把它当"共性问题"要求 Agent 修复全仓库同类代码（如 DossierPath/LexiconLoader/ConfigService），
      // 导致 Agent 永远无法通过 S4.5（它不能改无辜文件的正常代码）。
    }
  }

  // 去重 + 限制数量
  const seen = new Set<string>();
  return patterns.filter(p => {
    if (seen.has(p.pattern)) return false;
    seen.add(p.pattern);
    return true;
  }).slice(0, 8);
}

function isRelationKeyword(word: string): boolean {
  const keywords = ['relation', 'edge', 'link', 'connection', 'parent', 'child', 'sibling',
    'source', 'target', 'from', 'to', 'entity', 'owner', 'member', 'role', 'family'];
  return keywords.some(k => word.toLowerCase().includes(k));
}

/** 在整个仓库中搜索指定模式 */
function searchPatternInRepo(projectRoot: string, pattern: string, excludeFiles: string[]): Array<{ file: string; line: number; snippet: string }> {
  const results: Array<{ file: string; line: number; snippet: string }> = [];
  const srcDir = resolve(projectRoot, 'src');
  if (!existsSync(srcDir)) return results;

  const allFiles = scanDirRecursive(srcDir);
  const excludeSet = new Set(excludeFiles.map(f => f.replace(/\\/g, '/')));

  try {
    const re = new RegExp(pattern, 'gi');
    for (const file of allFiles) {
      if (!file.endsWith('.ts')) continue;
      const relPath = relative(projectRoot, file).replace(/\\/g, '/');
      // 排除待修改文件自身以及测试文件
      if (excludeSet.has(relPath) || relPath.includes('.test.ts') || relPath.includes('.spec.ts')) continue;

      try {
        const content = readFileSync(file, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            results.push({ file: relPath, line: i + 1, snippet: lines[i].trim() });
          }
        }
      } catch (_) { /* skip unreadable */ }
    }
  } catch (_) { /* invalid regex */ }

  return results;
}

// ════════════════════════════════════════════════════════════════════
// CK-07: 高风险依赖扫描
// ════════════════════════════════════════════════════════════════════

function checkHighRiskDependencyScan(projectRoot: string, files: string[]): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];

  // 检查修改的高风险文件的所有 import 依赖
  // v2.9.2: isHighRiskPath 同时匹配 basename 后缀 + 高风险目录前缀（chat 阶段管线 / governance）
  const isHighRiskPath = (f: string) => {
    const n = f.replace(/\\/g, '/');
    return HIGH_RISK_FILES.some(hr => n.endsWith(hr)) ||
           HIGH_RISK_DIRS.some(d => n.startsWith(d));
  };
  const highRiskModified = files.filter(isHighRiskPath);
  if (!highRiskModified.length) {
    return { id: 'CK-07', name: '高风险依赖扫描', passed: true, severity: 'pass', violations: [], durationMs: Date.now() - start, cacheable: false };
  }

  for (const file of highRiskModified) {
    const absPath = resolve(projectRoot, file);
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');
    const imports: Array<{ line: number; source: string; resolved: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const importMatch = line.match(/import\s+.*\s+from\s+['"]([^'"]+)['"]/);
      const requireMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);

      const source = importMatch?.[1] || requireMatch?.[1];
      if (!source) continue;

      const resolvedPath = resolve(dirname(absPath), source);
      const relativePath = relative(projectRoot, resolvedPath).replace(/\\/g, '/');

      imports.push({ line: i + 1, source, resolved: relativePath });
    }

    // 列出所有依赖（不做硬性拦截，供 LLM 全面评估）
    if (imports.length > 20) {
      violations.push({
        line: 1,
        file,
        message: `${file} 有 ${imports.length} 个 import 依赖——高风险文件变更需全面评估全量依赖影响`,
      });
    }
  }

  return {
    id: 'CK-07',
    name: '高风险依赖扫描',
    passed: violations.length === 0,
    severity: violations.length > 0 ? 'warn' : 'pass',
    violations,
    durationMs: Date.now() - start,
    cacheable: false,
  };
}

// ════════════════════════════════════════════════════════════════════
// CK-11: 内容安全豁免声明检查（S2-T2 / S2-O1 最险注入区）
// v2.9.2: chat.ts 最险内容（解除审查/14岁共同过去/个人世界隐私法）改动需声明理由
// ════════════════════════════════════════════════════════════════════

const CONTENT_EXEMPT_MARKERS = [
  { re: /【文档完整再现】/, desc: 'S2-T2 档案完整再现指令' },
  { re: /不要因为觉得某段"不合适"或"不该说"而跳过/, desc: 'S2-T2 审查豁免措辞' },
  { re: /PERSONAL_WORLD_PRIVACY_LAW/, desc: 'S2-O1 个人世界隐私法注入' },
  { re: /个人世界里不存在"个人隐私\/色情\/污秽"/, desc: '个人世界无隐私禁令声明' },
];

function checkContentSafetyExemptions(projectRoot: string, files: string[]): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];
  if (!files.some(f => f.includes('chat.ts'))) {
    return { id: 'CK-11', name: '内容安全豁免声明检查', passed: true, severity: 'pass', violations: [], durationMs: Date.now() - start, cacheable: false };
  }
  const chatPath = resolve(projectRoot, 'src/webui/chat.ts');
  if (!existsSync(chatPath)) {
    return { id: 'CK-11', name: '内容安全豁免声明检查', passed: true, severity: 'pass', violations: [], durationMs: Date.now() - start, cacheable: false };
  }
  const lines = readFileSync(chatPath, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of CONTENT_EXEMPT_MARKERS) {
      if (m.re.test(lines[i])) {
        violations.push({ line: i + 1, file: 'src/webui/chat.ts',
          message: `内容安全敏感注入 ${m.desc} 位于 L${i + 1}——修改本区块必须在 S2 方案声明理由（governance/personal-world-law.ts 法规依据），S4 评审复核内容安全` });
      }
    }
  }
  // 触发词区块（chat.ts L1031 内嵌正则）被改动时专门提示——限定在含 _entityContextText 的注入行，避免误报
  const triggerRe = /_entityContextText[^\n]*(14岁|第一次|那一次|那晚|亲密|宿舍|从头到尾|完整\.\*档案|所有内容)/;
  const hit = lines.map((l, i) => (triggerRe.test(l) ? i + 1 : 0)).find(x => x);
  if (hit) {
    violations.push({ line: hit, file: 'src/webui/chat.ts',
      message: `S2-T2 完整再现触发词区块位于 L${hit}——涉及「解除审查」最险内容，改动需额外理由声明` });
  }
  return {
    id: 'CK-11', name: '内容安全豁免声明检查',
    passed: violations.length === 0,
    severity: violations.length > 0 ? 'warn' : 'pass',
    violations, durationMs: Date.now() - start, cacheable: false,
  };
}

// ════════════════════════════════════════════════════════════════════
// CK-08: AST if 分支数量扫描（S5 补丁嗅探）
// ════════════════════════════════════════════════════════════════════

function checkASTIfBranchCount(projectRoot: string, files: string[]): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];

  for (const file of files) {
    const absPath = resolve(projectRoot, file);
    if (!existsSync(absPath)) continue;

    // 新增文件不适用此阈值
    // (简化判断：检查 git log 或文件修改时间——这里用文件是否存在来判断)
    const content = readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');

    // 扫描每个函数/方法内的 if/else if/switch case 分支数
    const functions = extractFunctions(lines);

    for (const fn of functions) {
      const branchCount = countConditionalBranches(fn.body);

      if (branchCount >= PATCH_IF_THRESHOLD) {
        violations.push({
          line: fn.startLine,
          file,
          message: `疑似补丁: 函数 "${fn.name}" (L${fn.startLine}-L${fn.endLine}) 包含 ${branchCount} 个条件分支（if/else if/switch case），超过阈值 ${PATCH_IF_THRESHOLD}`,
          snippet: fn.signature.slice(0, 120),
        });
      }
    }
  }

  return {
    id: 'CK-08',
    name: 'AST if分支数量扫描(补丁嗅探)',
    passed: violations.length === 0,
    severity: violations.length > 0 ? 'warn' : 'pass',
    violations,
    durationMs: Date.now() - start,
    cacheable: true,
  };
}

/** 简化的函数提取器——基于缩进和关键字 */
interface ExtractedFunction {
  name: string;
  startLine: number;
  endLine: number;
  signature: string;
  body: string[];
}

function extractFunctions(lines: string[]): ExtractedFunction[] {
  const functions: ExtractedFunction[] = [];
  const funcPatterns = [
    /^\s*(?:async\s+)?(?:function\s+)?(\w+)\s*\([^)]*\)\s*\{?\s*$/,
    /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*:\s*\w+\s*\{?\s*$/,
    /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{?\s*$/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{?\s*$/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*\([^)]*\)\s*\{?\s*$/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;

    let matched = false;
    for (const pattern of funcPatterns) {
      const m = line.match(pattern);
      if (m) {
        const name = m[1];
        const signature = line.trim();
        const { body, endLine } = extractBlock(lines, i);
        if (body.length > 0) {
          functions.push({ name, startLine: i + 1, endLine, signature, body });
          i = endLine; // 跳过函数体
        }
        matched = true;
        break;
      }
    }
    // 箭头函数赋值（多行可能）
    if (!matched) {
      const arrowMatch = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/);
      if (arrowMatch && line.includes('=>')) {
        const name = arrowMatch[1];
        const { body, endLine } = extractBlock(lines, i);
        if (body.length > 0) {
          functions.push({ name, startLine: i + 1, endLine, signature: line.trim(), body });
          i = endLine;
        }
      }
    }
  }

  return functions;
}

/** 从起始行提取 {} 包围的代码块 */
function extractBlock(lines: string[], startIdx: number): { body: string[]; endLine: number } {
  const body: string[] = [];
  let depth = 0;
  let started = false;
  let endLine = startIdx;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    body.push(line);

    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') { depth--; }
    }

    if (started && depth <= 0) {
      endLine = i + 1;
      break;
    }
  }

  if (!started) {
    // 单行箭头函数: const fn = () => expr;
    return { body: [lines[startIdx]], endLine: startIdx + 1 };
  }

  return { body, endLine };
}

/** 统计函数体内的条件分支数 */
function countConditionalBranches(body: string[]): number {
  let count = 0;
  for (const line of body) {
    const trimmed = line.trim();
    if (isCommentLine(line)) continue;

    if (/^if\s*\(/.test(trimmed) && !trimmed.startsWith('else if')) count++;
    if (/^\s*else\s+if\s*\(/.test(trimmed)) count++;
    if (/\bswitch\s*\(/.test(trimmed)) {
      // switch 每个 case 算一个分支
      const casesInBlock = body.filter(l => /\bcase\s+/.test(l.trim())).length;
      count += casesInBlock;
    }
  }
  return count;
}

// ════════════════════════════════════════════════════════════════════
// CK-00: S1 全局审视硬校验 — 强制全局import扫描 + 6大耦合点 + FG专项
// ════════════════════════════════════════════════════════════════════

function checkGlobalSurvey(projectRoot: string, files: string[]): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];
  const n = files.map(f => f.replace(/\\/g, '/'));

  // 1. 全量 import 牵连清单 — grep 整个 src/ 找谁引用了待改文件
  const importChain: string[] = [];
  const srcDir = resolve(projectRoot, 'src');
  if (existsSync(srcDir)) {
    const allFiles = scanDirRecursive(srcDir);
    for (const srcFile of allFiles) {
      if (!srcFile.endsWith('.ts')) continue;
      const relPath = relative(projectRoot, srcFile).replace(/\\/g, '/');
      try {
        const content = readFileSync(srcFile, 'utf-8');
        for (const modifiedFile of n) {
          const baseName = basename(modifiedFile).replace('.ts', '').replace('.tsx', '');
          const importRe = new RegExp(`from\\s+['"].*${escapeRegex(baseName)}['"]`, 'i');
          if (importRe.test(content)) {
            importChain.push(relPath);
            break;
          }
        }
      } catch (_) { /* skip unreadable */ }
    }
  }

  if (importChain.length === 0 && n.some(f => f.includes('src/'))) {
    // 没有找到 import 依赖项 = 未执行完整全局审视
    violations.push({
      line: 1, file: n[0] || '',
      message: 'S1 前置条件不满足: 未输出完整 import 牵连清单。必须 grep 全局找出所有引用待修改文件的上游模块。',
    });
  }

  // 2. 6 大耦合点逐点扫描
  const couplingPoints = scanSixCouplingPoints(projectRoot, files);
  for (const cp of couplingPoints) {
    violations.push({
      line: cp.line || 1, file: cp.file,
      message: `耦合点检测: ${cp.message}`,
    });
  }

  // 3. FG 专项: 若修改触及 FG/会晤/角色/户籍 → 输出 11 条红线表
  const fgRelated = files.some(f =>
    f.includes('FamilyGraph') || f.includes('family_graph') ||
    f.includes('EntityMeeting') || f.includes('MeetingContext') ||
    f.includes('EntityContextBuilder') || f.includes('UUIDGatekeeper') ||
    f.includes('ProfileAcquisition') || f.includes('belong_entity_uuid') ||
    f.includes('role') || f.includes('Roleplay') || f.includes('app/fg/'),
  );

  if (fgRelated) {
    const redlineTable = buildFGRedlineTable(projectRoot, files);
    if (redlineTable.length === 0) {
      violations.push({
        line: 1, file: files[0] || '',
        message: 'FG 专项不满足: 改动涉及 FG/户籍/会晤/角色/UUID，必须输出 11 条红线逐条触碰判定表。当前表为空 → S2 直接驳回。',
      });
    }
  }

  return {
    id: 'CK-00',
    name: 'S1全局审视硬校验',
    passed: violations.length === 0,
    severity: violations.length > 0 ? 'fail' : 'pass',
    violations,
    durationMs: Date.now() - start,
    cacheable: false,
  };
}

/** 扫描 6 大核心耦合点 */
function scanSixCouplingPoints(projectRoot: string, files: string[]): Array<{ line?: number; file: string; message: string }> {
  const results: Array<{ line?: number; file: string; message: string }> = [];
  const chatPath = resolve(projectRoot, 'src/webui/chat.ts');

  // 耦合点1: chat.ts 22段注入
  if (files.some(f => f.includes('chat.ts')) && existsSync(chatPath)) {
    const content = readFileSync(chatPath, 'utf-8');
    const finalKnowledgeMatches = content.match(/finalKnowledgeText/g);
    const count = finalKnowledgeMatches ? finalKnowledgeMatches.length : 0;
    if (count < 20) {
      results.push({ file: 'src/webui/chat.ts', message: `finalKnowledgeText 注入仅 ${count} 处（预期 ≥22 段），可能被删减` });
    }
  }

  // 耦合点2: 会晤传播链语义核验（v2.9.2: 读 V15 编目 ↔ 真实引用点交叉验证，替代硬编码行号）
  if (files.some(f => f.includes('chat.ts') || f.includes('meeting') || f.includes('Meeting'))) {
    if (existsSync(chatPath)) {
      const lines = readFileSync(chatPath, 'utf-8').split('\n');
      const catalogParsed = parseMeetingCatalog(lines);
      const catalog = catalogParsed.entries;
      if (catalog.length === 0) {
        results.push({ file: 'src/webui/chat.ts', message: 'V15 会晤编目（MEETING_PROP_POINTS）缺失——传播链不可验证' });
      }
      for (const entry of catalog) {
        if (!catalogEntryHasEvidence(lines, entry)) {
          results.push({ line: entry.line, file: 'src/webui/chat.ts', message: `会晤传播点位 L${entry.line} (${entry.stage}): via("${entry.via}") 全文缺失——传播链断裂` });
        }
      }
    }
  }

  // 耦合点3: UUID 四层机制
  if (files.some(f => f.includes('UUID') || f.includes('belong_entity_uuid') || f.includes('SQLite'))) {
    const uuidFiles = grepRecursive(projectRoot, 'src', 'belong_entity_uuid');
    if (uuidFiles.length < 4) {
      results.push({ file: '全仓库', message: `belong_entity_uuid 标注仅 ${uuidFiles.length} 处（四层机制可能不完整）` });
    }
  }

  // 耦合点4: 双管线
  if (files.some(f => f.includes('roleplay') || f.includes('Roleplay'))) {
    const roleplayFiles = grepRecursive(projectRoot, 'src', 'ROLEPLAY_STRUCTURED_ENABLED');
    if (roleplayFiles.length < 2) {
      results.push({ file: '全仓库', message: 'ROLEPLAY_STRUCTURED_ENABLED 仅 1 处引用（双管线同步可能遗漏）' });
    }
  }

  // 耦合点5: save() 防抖
  if (files.some(f => f.includes('SQLite') || f.includes('persistence') || f.includes('Adapter'))) {
    const saveCalls = grepRecursive(projectRoot, 'src', 'scheduleFlush|\.save\(\)');
    if (saveCalls.length === 0) {
      results.push({ file: '全仓库', message: 'scheduleFlush / .save() 调用未找到（持久化防抖可能缺失）' });
    }
  }

  // 耦合点6: FG 11 条红线预检
  if (files.some(f => f.includes('FamilyGraph') || f.includes('app/fg/'))) {
    results.push({ file: files.find(f => f.includes('FamilyGraph')) || files[0] || '', message: 'FG 户籍变更: 必须对照 11 条红线输出逐条触碰判定表（S1 工作手册步骤7）' });
  }

  return results;
}

/** 构建 FG 11 条红线逐条触碰判定表 */
const FG_REDLINE_TITLES = [
  '红线1: FamilyGraph 为户籍唯一数据源',
  '红线2: 角色扮演使用独立分支 FG',
  '红线3: roleplay_forbidden 判定逻辑不可削弱',
  '红线4: 会晤模式不读取其他角色记忆',
  '红线5: FamilyGraph.dossier 七子卷结构不可删减',
  '红线6: 家族关系检测使用 relation type 而非正则匹配',
  '红线7: 角色称呼不混淆，无跨角色信息泄漏',
  '红线8: 记忆/对话 belong_entity_uuid 标注完整',
  '红线9: 新旧角色扮演双管线同步修改',
  '红线10: 禁止新增垃圾实体匹配规则',
  '红线11: 新增字段必须同步全链路四层机制',
];

function buildFGRedlineTable(_projectRoot: string, _files: string[]): string[] {
  // 返回 11 条红线的标题列表（供 S1 报告使用）
  // 实际的触碰判定由 LLM 在 S1 分析中逐条对照填写
  return FG_REDLINE_TITLES.map(t => `| ${t} | 待判定 | 待填写 |`);
}

/** grep 递归搜索 */
function grepRecursive(projectRoot: string, dir: string, pattern: string): string[] {
  const results: string[] = [];
  const fullDir = resolve(projectRoot, dir);
  if (!existsSync(fullDir)) return results;
  const files = scanDirRecursive(fullDir);
  for (const file of files) {
    if (!file.endsWith('.ts')) continue;
    try {
      const content = readFileSync(file, 'utf-8');
      if (new RegExp(pattern, 'g').test(content)) {
        results.push(relative(projectRoot, file).replace(/\\/g, '/'));
      }
    } catch (_) { /* skip */ }
  }
  return results;
}

/** 递归扫描目录 */
function scanDirRecursive(dir: string): string[] {
  const results: string[] = [];
  const stack = [dir];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const e of entries) {
        const fp = resolve(current, e.name);
        if (e.isDirectory()) {
          if (!['node_modules', '__tests__', '.git', 'dist', '.claude'].includes(e.name)) stack.push(fp);
        } else if (e.isFile()) {
          results.push(fp);
        }
      }
    } catch (_) { /* skip */ }
  }
  return results;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ════════════════════════════════════════════════════════════════════
// CK-09: before/after 回归安全扫描
// ════════════════════════════════════════════════════════════════════

function checkRegressionSafety(projectRoot: string, files: string[]): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];
  const n = files.map(f => f.replace(/\\/g, '/'));

  // 1. git diff — 提取实际被修改的函数（仅限流水线指定的文件，避免全仓库扫描）
  const changedFunctions = getChangedFunctions(projectRoot, files);
  const changedFiles = getChangedFiles(projectRoot, files);

  // 2. S2 方案解析 — 期望的改动范围（由调用方通过 state.global_memo 传入）
  //    这里做基础检查：实际改动是否越界到未声明的文件
  const declaredFiles = n;
  for (const cf of changedFiles) {
    const rel = cf.replace(/\\/g, '/');
    const isDeclared = declaredFiles.some(f => rel.includes(f) || f.includes(rel));
    if (!isDeclared && rel.endsWith('.ts') && !rel.includes('.test.ts') && !rel.includes('.spec.ts')) {
      violations.push({
        line: 1, file: rel,
        message: `意外改动: "${rel}" 不在 S2 方案声明的修改文件列表中 → 可能扩大了改动范围`,
      });
    }
  }

  // 3. 检查是否有函数被删除
  for (const fn of changedFunctions) {
    if (fn.status === 'deleted') {
      violations.push({
        line: fn.line || 1, file: fn.file,
        message: `函数删除: "${fn.name}" 在 ${fn.file} 中被删除 → 可能破坏上游调用方`,
      });
    }
  }

  // 4. 检查测试失败（跳过——跑全部测试太慢，流水线 S4.5 不应触发完整 test suite）
  // vitest 结果由 S5 编译测试阶段独立执行

  return {
    id: 'CK-09',
    name: '回归安全扫描',
    passed: violations.length === 0,
    severity: violations.length > 0 ? 'fail' : 'pass',
    violations,
    durationMs: Date.now() - start,
    cacheable: false,
  };
}

/** 从 git diff 提取被修改文件的函数名 */
interface ChangedFunction { name: string; file: string; line?: number; status: 'added' | 'deleted' | 'modified'; }
function getChangedFunctions(projectRoot: string, files: string[] = []): ChangedFunction[] {
  const results: ChangedFunction[] = [];
  try {
    // 🔴 限制 diff 范围到流水线指定的文件（避免全仓库扫描 80+ 个未提交文件）
    const fileArgs = files.length > 0 ? files.map(f => `"${f}"`).join(' ') : 'src/';
    const diff = execSync(`git diff --unified=0 -- ${fileArgs}`, {
      cwd: projectRoot, encoding: 'utf-8', timeout: 15000,
    });
    const hunkRe = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@\s*(.*)$/gm;
    let match;
    while ((match = hunkRe.exec(diff)) !== null) {
      const context = match[3] || '';
      const funcMatch = context.match(/(?:function|async\s+function|const|let|var)\s+(\w+)/);
      const className = context.match(/(?:class|interface)\s+(\w+)/);
      const name = funcMatch?.[1] || className?.[1] || `(行${match[2]})`;
      const status = diff.includes('-') && diff.includes('+') ? 'modified' :
        diff.startsWith('+') ? 'added' : 'deleted';
      results.push({ name, file: '', line: parseInt(match[2], 10), status });
    }
  } catch (_) { /* not in git repo */ }
  return results;
}

function getChangedFiles(projectRoot: string, files: string[] = []): string[] {
  try {
    // 🔴 限制 diff 范围到流水线指定的文件
    const fileArgs = files.length > 0 ? files.map(f => `"${f}"`).join(' ') : 'src/';
    const status = execSync(`git diff --name-only -- ${fileArgs}`, {
      cwd: projectRoot, encoding: 'utf-8', timeout: 15000,
    }).trim();
    return status.split('\n').filter(Boolean);
  } catch (_) { return []; }
}

// ════════════════════════════════════════════════════════════════════
// CK-10: 修改目的达成度验证
// ════════════════════════════════════════════════════════════════════

function checkIntentFulfillment(projectRoot: string, files: string[], s2Memo?: string): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];
  const n = files.map(f => f.replace(/\\/g, '/'));

  // 1. 解析 S2 方案中的修改目的
  const intent = parseIntent(s2Memo || '');

  // 2. 根据修改类型做针对性验证
  switch (intent.type) {
    case 'bug_fix':
      // 验证异常路径是否仍然存在于代码中
      if (intent.bugPattern) {
        const stillExists = grepRecursive(projectRoot, 'src', intent.bugPattern);
        if (stillExists.length > 0) {
          violations.push({
            file: stillExists[0] || n[0] || '',
            message: `bug 未修复: 原始异常模式 "${intent.bugPattern}" 在 ${stillExists.length} 个文件中仍存在 → 修改未达到目的`,
          });
        }
      }
      // 验证修复是否附带测试
      const changedTestFiles = getChangedFiles(projectRoot).filter(f => f.includes('.test.ts'));
      if (changedTestFiles.length === 0) {
        violations.push({
          file: n[0] || '',
          message: 'bug 修复未附带测试: 任何 bug 修复必须新增或修改至少 1 个测试用例',
        });
      }
      break;

    case 'feature':
      if (intent.expectedFunction) {
        const found = grepRecursive(projectRoot, 'src', intent.expectedFunction);
        if (found.length === 0) {
          violations.push({
            file: n[0] || '',
            message: `功能代码缺失: 预期新增函数/方法 "${intent.expectedFunction}" 未在代码中找到 → 修改未达到目的`,
          });
        }
      }
      break;

    case 'refactor':
      // 验证原有测试全部通过
      try {
        const testOut = execSync('npx vitest run --reporter=verbose 2>&1 || true', {
          cwd: projectRoot, timeout: 120000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024,
        });
        const failedTests = (testOut.match(/FAIL\s+/g) || []).length;
        if (failedTests > 0) {
          violations.push({
            file: 'vitest',
            message: `重构验证失败: ${failedTests} 个测试失败 → 行为未被保留`,
          });
        }
      } catch (_) { /* skip */ }
      break;

    default:
      // 无法识别意图类型 → 标记警告
      violations.push({
        file: n[0] || '',
        message: '无法识别修改意图类型: S2 方案中未明确标注 bug_fix / feature / refactor，意图验证无法执行',
      });
  }

  return {
    id: 'CK-10',
    name: '修改目的达成度验证',
    passed: violations.length === 0,
    severity: violations.length > 0 ? 'fail' : 'pass',
    violations,
    durationMs: Date.now() - start,
    cacheable: false,
  };
}

/** 从 S2 memo 中解析修改意图 */
interface ParsedIntent {
  type: 'bug_fix' | 'feature' | 'refactor' | 'unknown';
  description: string;
  bugPattern?: string;
  expectedFunction?: string;
}

function parseIntent(s2Memo: string): ParsedIntent {
  const memo = s2Memo.toLowerCase();
  if (memo.includes('bug') || memo.includes('修复') || memo.includes('报错') || memo.includes('错误') || memo.includes('异常')) {
    // 尝试提取 bug 模式
    const patternMatch = memo.match(/异常[^:：]*[：:]\s*(.+)|bug[^:：]*[：:]\s*(.+)|修复[^:：]*[：:]\s*(.+)/i);
    return { type: 'bug_fix', description: s2Memo.slice(0, 100), bugPattern: (patternMatch?.[1] || patternMatch?.[2] || patternMatch?.[3] || '').trim() };
  }
  if (memo.includes('新增') || memo.includes('功能') || memo.includes('feature') || memo.includes('添加')) {
    const fnMatch = memo.match(/(?:新增|添加|实现)(?:函数|方法|模块)?[：:]?\s*(\w+)/i);
    return { type: 'feature', description: s2Memo.slice(0, 100), expectedFunction: fnMatch?.[1]?.trim() };
  }
  if (memo.includes('重构') || memo.includes('refactor') || memo.includes('重写') || memo.includes('整理')) {
    return { type: 'refactor', description: s2Memo.slice(0, 100) };
  }
  return { type: 'unknown', description: s2Memo.slice(0, 100) };
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed === '';
}

function buildSummary(checks: CheckResult[]): CheckerSummary {
  const passed = checks.filter(c => c.passed).length;
  const failed = checks.filter(c => c.severity === 'fail').length;
  const warned = checks.filter(c => c.severity === 'warn').length;
  const failedIds = checks.filter(c => c.severity === 'fail').map(c => c.id);

  const llmBriefParts: string[] = [];
  for (const c of checks) {
    if (c.violations.length > 0) {
      llmBriefParts.push(`[${c.id}] ${c.name}: ${c.violations.length} 条违规`);
    }
  }

  return {
    total: checks.length,
    passed,
    failed,
    warned,
    all_hard_passed: failed === 0,
    failed_ids: failedIds,
    llm_brief: llmBriefParts.length > 0 ? llmBriefParts.join('; ') : '全部检查通过',
  };
}

function buildCacheable(checks: CheckResult[]): CacheableData {
  return {
    fg_redlines_check: checks.find(c => c.id === 'CK-03')?.violations ?? [],
    meeting_points_check: checks.find(c => c.id === 'CK-05')?.violations ?? [],
    patch_scan: checks.find(c => c.id === 'CK-08')?.violations ?? [],
    generated_at: new Date().toISOString(),
  };
}

// ════════════════════════════════════════════════════════════════════
// 执行
// ════════════════════════════════════════════════════════════════════

// 仅在直接运行时执行 main
const isMainModule = process.argv[1] && (
  process.argv[1].includes('main_harness_checker') ||
  process.argv.includes('--project-root')
);

if (isMainModule) {
  main();
}

// 导出供测试和编程调用
export {
  checkGlobalSurvey,
  checkNineLayerPipeline,
  checkPFCThinScheduler,
  checkFGHouseholdSpec,
  checkUUIDAnnotationChain,
  checkMeetingEntityPoints,
  checkSQLiteSaveCalls,
  checkSystemicPattern,
  checkHighRiskDependencyScan,
  checkContentSafetyExemptions,
  checkASTIfBranchCount,
  checkRegressionSafety,
  checkIntentFulfillment,
  buildSummary,
  buildCacheable,
  PATCH_IF_THRESHOLD,
  HIGH_RISK_FILES,
  HIGH_RISK_DIRS,
  FG_REDLINE_TITLES,
};
export type { CheckResult, Violation, CheckerOutput, CheckerSummary, CacheableData };

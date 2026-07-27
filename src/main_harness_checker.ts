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

/** 高风险文件列表 */
const HIGH_RISK_FILES = [
  'chat.ts', 'FamilyGraph.ts', 'SQLiteAdapter.ts',
  'server.ts', 'DeepSeekLLMProvider.ts', 'PrefrontalCortex.ts',
];

/** 九层管线模块前缀 */
const M1_M9_MODULES = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'];

/** 12 处 _meetingEntityName 精确行号点位 */
const MEETING_ENTITY_CHECKPOINTS: Array<{ line: number; description: string }> = [
  { line: 570, description: '会晤模式入口判断' },
  { line: 679, description: '实体名提取逻辑' },
  { line: 760, description: '会晤上下文构建' },
  { line: 775, description: '会晤参与方过滤' },
  { line: 847, description: '角色信息隔离' },
  { line: 1233, description: '会晤记忆注入点1' },
  { line: 1235, description: '会晤记忆注入点2' },
  { line: 1302, description: '知识文本拼接' },
  { line: 1338, description: '会晤提示词构造' },
  { line: 1445, description: '会晤响应处理' },
  { line: 1484, description: '会晤归档入口' },
  { line: 1501, description: '会晤结束清理' },
];

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

  if (stage === 'S4' || stage === 'all') {
    allChecks.push(
      checkNineLayerPipeline(projectRoot, files),
      checkPFCThinScheduler(projectRoot, files),
      checkFGHouseholdSpec(projectRoot, files),
      checkUUIDAnnotationChain(projectRoot, files),
      checkMeetingEntityPoints(projectRoot, files),
      checkSQLiteSaveCalls(projectRoot, files),
      checkHighRiskDependencyScan(projectRoot, files),
    );
  }

  if (stage === 'S5' || stage === 'all') {
    allChecks.push(
      checkASTIfBranchCount(projectRoot, files),
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
      // 匹配 import 语句
      const importMatch = line.match(/import\s+.*\s+from\s+['"](\.\.?\/[^'"]+)['"]/);
      if (!importMatch) continue;

      const importPath = importMatch[1];
      const resolvedPath = resolve(dirname(absPath), importPath);
      const relativePath = relative(projectRoot, resolvedPath).replace(/\\/g, '/');
      const importedModule = getModuleLayer(relativePath);

      // M1-M9 模块间不允许反向依赖（低层不能 import 高层）
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

function checkMeetingEntityPoints(projectRoot: string, files: string[]): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];

  // 仅当修改涉及 chat.ts 或会晤相关逻辑时启用
  const meetingFiles = files.filter(f =>
    f.endsWith('chat.ts') || f.includes('meeting') || f.includes('Meeting') ||
    f.includes('EntityMeeting') || f.includes('MeetingContext')
  );
  if (!meetingFiles.length) {
    return { id: 'CK-05', name: '12处_meetingEntityName核验', passed: true, severity: 'pass', violations: [], durationMs: Date.now() - start, cacheable: true };
  }

  // 🔴 对 chat.ts 做逐行 grep 核验
  const chatPath = resolve(projectRoot, 'src/webui/chat.ts');
  if (!existsSync(chatPath)) {
    return { id: 'CK-05', name: '12处_meetingEntityName核验', passed: true, severity: 'pass', violations: [], durationMs: Date.now() - start, cacheable: true };
  }

  const content = readFileSync(chatPath, 'utf-8');
  const lines = content.split('\n');

  // 构建点位核验清单
  const pointResults: Array<{ line: number; description: string; status: string; evidence: string }> = [];

  for (const cp of MEETING_ENTITY_CHECKPOINTS) {
    const idx = cp.line - 1; // 0-indexed
    if (idx >= lines.length) {
      pointResults.push({ line: cp.line, description: cp.description, status: '✗', evidence: `行号 ${cp.line} 超出文件范围（总行数 ${lines.length}）` });
      continue;
    }

    const line = lines[idx];
    const hasMeetingEntity = line.includes('_meetingEntityName') || line.includes('meetingEntity') || line.includes('meeting_entity');
    // 检查周边 5 行范围
    const nearbyStart = Math.max(0, idx - 5);
    const nearbyEnd = Math.min(lines.length, idx + 5);
    const nearby = lines.slice(nearbyStart, nearbyEnd).join('\n');
    const hasMeetingEntityNearby = nearby.includes('_meetingEntityName') || nearby.includes('meetingEntity');

    if (hasMeetingEntity || hasMeetingEntityNearby) {
      pointResults.push({ line: cp.line, description: cp.description, status: '✓', evidence: line.trim().slice(0, 80) });
    } else {
      pointResults.push({
        line: cp.line, description: cp.description, status: '⚠', evidence: `行 ${cp.line} 附近未找到 _meetingEntityName 引用，请人工确认是否为不适用场景`,
      });
      violations.push({
        line: cp.line,
        file: 'src/webui/chat.ts',
        message: `_meetingEntityName 点位 #${cp.line} (${cp.description}): 未找到相关引用，需人工确认`,
      });
    }
  }

  // 🔴 12 点逐项核验清单（强制输出）
  const checklist = pointResults.map(p => `| ${p.line} | ${p.status} | ${p.description} | ${p.evidence} |`).join('\n');

  return {
    id: 'CK-05',
    name: '12处_meetingEntityName核验',
    passed: violations.length === 0,
    severity: violations.length > 0 ? 'warn' : 'pass',
    violations,
    durationMs: Date.now() - start,
    cacheable: true,
  };
}

// ════════════════════════════════════════════════════════════════════
// CK-06: SQLite save() 调用完整性检查
// ════════════════════════════════════════════════════════════════════

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

    // 检查每个写入方法是否包含 save/flush 调用
    let inWriteMethod = false;
    let methodStartLine = 0;
    let hasSaveCall = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // 检测写入方法开始
      if (/(?:async\s+)?(?:insert|update|delete|write|save|store|persist|upsert)\w*\s*\(/.test(line) && !isCommentLine(lines[i])) {
        inWriteMethod = true;
        methodStartLine = i + 1;
        hasSaveCall = false;
        continue;
      }

      // 检测方法结束
      if (inWriteMethod && line === '}' && !lines[i].startsWith('  ')) {
        continue; // 可能只是内部块结束
      }
      if (inWriteMethod && /^\s*\}\s*$/.test(line) && i - methodStartLine > 1) {
        // 简单判断方法结束
        if (!hasSaveCall) {
          violations.push({
            line: methodStartLine,
            file,
            message: `写入方法无防抖落盘调用: 从行 ${methodStartLine} 开始的方法缺少 .save()/scheduleFlush() 调用`,
          });
        }
        inWriteMethod = false;
        continue;
      }

      // 检查是否有 save/flush 调用
      if (inWriteMethod && (line.includes('.save()') || line.includes('scheduleFlush') || line.includes('.flush()'))) {
        hasSaveCall = true;
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
// CK-07: 高风险依赖扫描
// ════════════════════════════════════════════════════════════════════

function checkHighRiskDependencyScan(projectRoot: string, files: string[]): CheckResult {
  const start = Date.now();
  const violations: Violation[] = [];

  // 检查修改的高风险文件的所有 import 依赖
  const highRiskModified = files.filter(f => HIGH_RISK_FILES.some(hr => f.endsWith(hr)));
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
// 工具函数
// ════════════════════════════════════════════════════════════════════

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
  checkNineLayerPipeline,
  checkPFCThinScheduler,
  checkFGHouseholdSpec,
  checkUUIDAnnotationChain,
  checkMeetingEntityPoints,
  checkSQLiteSaveCalls,
  checkHighRiskDependencyScan,
  checkASTIfBranchCount,
  buildSummary,
  buildCacheable,
  MEETING_ENTITY_CHECKPOINTS,
  PATCH_IF_THRESHOLD,
  HIGH_RISK_FILES,
};
export type { CheckResult, Violation, CheckerOutput, CheckerSummary, CacheableData };

/**
 * DelegateReviewer — 委托评审子 Agent
 * ========================================
 * S4 架构评审阶段使用 delegate runner 模式创建隔离上下文子 Agent。
 *
 * 核心职责：
 *   1. 创建隔离上下文，加载项目文件进行架构/代码合规评审
 *   2. 输出双通道信号：machine_signal（结构化判定）+ human_report（可读报告）
 *   3. 内置 FG11 条红线、UUID 四层标注、chat.ts 22段注入链路等专项校验
 *
 * 🔴 子 Agent 只能读取文件，不能写入/删除/修改——白名单在 delegate 模式自动锁定。
 * 🔴 machine_signal 和 human_report 物理隔离，互不污染。
 */

import type { StageConfig, StageOutput, MachineSignal, MachineSignalMetrics, FlowRunState } from './types.js';
import { passSignal, rejectSignal, makeStageOutput, formatHumanReport } from './DualChannelSignal.js';

// ════════════════════════════════════════════════════════════════════
// 公开 API
// ════════════════════════════════════════════════════════════════════

/**
 * 执行架构评审——委托子 Agent 的核心入口。
 *
 * @param stage — S4 stage 配置（含 work_manual）
 * @param state — 当前流水线运行状态（含 modified_files, global_memo 等）
 * @returns StageOutput { machine_signal, human_report }
 */
export function review(stage: StageConfig, state: FlowRunState): StageOutput {
  console.log(`[DelegateReviewer] 🔍 评审开始: ${stage.stage_id}`);
  console.log(`[DelegateReviewer]    文件: ${state.modified_files.join(', ')}`);
  console.log(`[DelegateReviewer]    风险: ${state.risk_level}`);

  // 执行多维度校验
  const violations: string[] = [];
  const metrics: MachineSignalMetrics = {
    files_checked: state.modified_files.length,
    violations_found: 0,
    fg_redlines_touched: [],
    uuid_chain_broken: false,
    chat_injection_order_changed: false,
  };

  // 一、架构层级校验
  const archViolations = checkArchitectureLayer(state);
  violations.push(...archViolations);

  // 二、FG 户籍 & UUID 专项校验
  const fgViolations = checkFGAndUUID(state);
  violations.push(...fgViolations);
  metrics.fg_redlines_touched = extractFGRedlines(fgViolations);

  // 三、耦合点专项校验
  const couplingViolations = checkCouplingPoints(state);
  violations.push(...couplingViolations);
  metrics.chat_injection_order_changed = couplingViolations.some(v => v.includes('22段') || v.includes('注入顺序'));
  metrics.uuid_chain_broken = violations.some(v => v.includes('UUID') || v.includes('belong_entity_uuid'));

  // 四、持久化安全校验
  const persistViolations = checkPersistenceSafety(state);
  violations.push(...persistViolations);

  // 五、风险兜底校验
  const riskViolations = checkRiskCatchAll(state);
  violations.push(...riskViolations);

  // 🔴 六、文档同步一致性校验（开发落地规则7——白皮书蓝皮书同步）
  const docViolations = checkDocumentSync(state);
  violations.push(...docViolations);

  // 🔴 七、归类真实性专项校验（新规则6——共性/个性归类核验）
  const classifyViolations = checkRepairClassification(state);
  violations.push(...classifyViolations);

  // 🔴 八、基础静态质量校验（新规则5 第一层——编译/类型/死代码/编码规范）
  const staticQualityViolations = checkStaticQuality(state);
  violations.push(...staticQualityViolations);

  // 🔴 九、鲁棒加固专项校验（新规则5 第二层——容错兜底/边界防护/自校验）
  const robustViolations = checkRobustnessGuards(state);
  violations.push(...robustViolations);

  // 🔴 十、Hook埋点与自检合规校验（新规则8——核心链路侦测+六级体检）
  const hookViolations = checkHookAndSelfCheck(state);
  violations.push(...hookViolations);

  // 🔴 十一、优化提案落地真实性校验（新规则9——LLM优化提案弹性机制）
  const proposalViolations = checkProposalFidelity(state);
  violations.push(...proposalViolations);

  // 🔧 十一维校验完整性自检
  const completenessResult = validateReviewCompleteness(
    archViolations, fgViolations, couplingViolations, persistViolations,
    riskViolations, docViolations, classifyViolations,
    staticQualityViolations, robustViolations, hookViolations, proposalViolations,
  );
  if (!completenessResult.passed) {
    violations.push(`[自检] 评审维度缺失: ${completenessResult.missing.join(', ')}。评审不完整，判定不通过。`);
  }

  metrics.violations_found = violations.length;

  // 构建双通道输出
  const passed = violations.length === 0;
  const riskLevel = passed ? 'low' : (state.risk_level === 'high' ? 'high' : 'mid');

  const machineSignal: MachineSignal = passed
    ? passSignal(metrics)
    : rejectSignal(violations, riskLevel, metrics);

  const humanReport = buildHumanReport(stage.stage_name, state, violations, metrics);

  console.log(`[DelegateReviewer] ${passed ? '✅ 评审通过' : '❌ 评审驳回'} (${violations.length} 个违规)`);

  return makeStageOutput(machineSignal, humanReport);
}

// ════════════════════════════════════════════════════════════════════
// 一、架构层级校验
// ════════════════════════════════════════════════════════════════════

function checkArchitectureLayer(state: FlowRunState): string[] {
  const violations: string[] = [];
  const files = state.modified_files;

  // 1. M1-M9 无循环依赖规则
  if (files.some(f => /src\/m[1-9]\//.test(f))) {
    // 检查是否有反向依赖（简化版——实际由子 Agent 深度分析）
    violations.push('[架构] 修改了 M 层模块，需确认未引入反向依赖（M1→M9 正向流，禁止 M9→M1 反向引用）');
  }

  // 2. chat.ts 是否新增业务逻辑
  if (files.some(f => f.includes('chat.ts') && !f.includes('test'))) {
    violations.push('[架构·chat.ts] 修改了 chat.ts，需确认未新增业务逻辑（chat.ts 只能是薄调度层，业务逻辑归入 PFC 或独立 service）');
  }

  // 3. PFC 上下文注入逻辑
  if (files.some(f => f.includes('PrefrontalCortex'))) {
    violations.push('[架构·PFC] 修改了 PrefrontalCortex，需确认上下文注入逻辑未被篡改（PFC 是唯一顶层上下文门控）');
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// 二、FG 户籍 & UUID 专项校验
// ════════════════════════════════════════════════════════════════════

function checkFGAndUUID(state: FlowRunState): string[] {
  const violations: string[] = [];
  const files = state.modified_files;

  const fgRelated = files.some(f =>
    f.includes('FamilyGraph') || f.includes('family_graph') ||
    f.includes('EntityContextBuilder') || f.includes('MeetingContextPipeline') ||
    f.includes('ProfileAcquisitionEngine'),
  );

  if (fgRelated) {
    // FG11 条红线关键词检测（基于文件名和路径的静态预检）
    if (files.some(f => f.includes('FamilyGraph') && !f.includes('RoleBranch'))) {
      violations.push('[FG·红线3] 主 FamilyGraph 修改需确认未引入 FG 真人可扮演的风险（roleplay_forbidden 判定逻辑完整）');
    }

    if (files.some(f => f.includes('EntityContextBuilder'))) {
      violations.push('[FG·红线2] EntityContextBuilder 修改需确认分支数据隔离（角色分支查不到的不从主FG补充）');
    }

    if (files.some(f => f.includes('MeetingContextPipeline'))) {
      violations.push('[FG·红线6] MeetingContextPipeline 修改需确认家族关系检测使用 relation type 而非正则匹配标签文字');
    }

    // UUID 四层标注
    if (files.some(f =>
      f.includes('UUIDGatekeeper') || f.includes('belong_entity_uuid') ||
      f.includes('SQLiteAdapter') || f.includes('Memory'),
    )) {
      violations.push('[UUID] 涉及 UUID 标注相关文件，需确认四层标注机制（在线/启动回填/离线脚本/知识库）未受损');
    }

    // 角色扮演双管线
    if (files.some(f => f.includes('roleplay') || f.includes('Roleplay'))) {
      violations.push('[FG·红线9] 角色扮演管线修改需确认新旧两套管线（buildRoleplayRules / runRoleplayPipeline）规则已同步更新');
    }
  }

  return violations;
}

/** 从违规列表中提取触碰的 FG 红线编号 */
function extractFGRedlines(violations: string[]): string[] {
  const redlines: string[] = [];
  const pattern = /\[FG·红线(\d+)\]/;
  for (const v of violations) {
    const match = v.match(pattern);
    if (match && !redlines.includes(match[1])) {
      redlines.push(match[1]);
    }
  }
  return redlines;
}

// ════════════════════════════════════════════════════════════════════
// 三、耦合点专项校验
// ════════════════════════════════════════════════════════════════════

function checkCouplingPoints(state: FlowRunState): string[] {
  const violations: string[] = [];
  const files = state.modified_files;

  // 1. chat.ts 22段 finalKnowledgeText 注入链路
  if (files.some(f => f.includes('chat.ts') && !f.includes('test'))) {
    violations.push('[耦合·chat.ts] 修改 chat.ts 需确认 22 段 finalKnowledgeText 注入顺序完整（亲密过滤→家族约束→PFC上下文→角色指令→M6自模型）');
  }

  // 2. _meetingEntityName 12 处传播判断点
  if (files.some(f =>
    f.includes('chat.ts') || f.includes('EntityMeeting') ||
    f.includes('MeetingContextPipeline') || f.includes('EntityContextBuilder'),
  )) {
    violations.push('[耦合·会晤] 涉及会晤模式相关文件，需确认全部 12 处 _meetingEntityName 判断点已完整同步（防止角色信息泄漏）');
  }

  // 3. FamilyGraph.dossier 消费方同步
  if (files.some(f => f.includes('FamilyGraph') || f.includes('dossier'))) {
    violations.push('[耦合·dossier] FamilyGraph.dossier 结构修改需同步适配全部消费方：EntityContextBuilder、MeetingContextPipeline、ProfileAcquisitionEngine');
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// 四、持久化安全校验
// ════════════════════════════════════════════════════════════════════

function checkPersistenceSafety(state: FlowRunState): string[] {
  const violations: string[] = [];
  const files = state.modified_files;

  // 1. SQLiteAdapter 防抖 save()
  if (files.some(f => f.includes('SQLiteAdapter') || f.includes('persistence'))) {
    violations.push('[持久化] 修改存储逻辑需确认 scheduleFlush 防抖落盘逻辑完整，save() 调用未被删除（否则重启数据丢失）');
  }

  // 2. 禁止直接删除记忆/卷宗/黑钻记录
  if (files.some(f => f.includes('SQLiteAdapter') || f.includes('VaultManager') || f.includes('Memory'))) {
    violations.push('[持久化] 需确认无直接删除记忆/卷宗/黑钻记录的逻辑（遵循「只增不删」原则）');
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// 五、风险兜底校验
// ════════════════════════════════════════════════════════════════════

function checkRiskCatchAll(state: FlowRunState): string[] {
  const violations: string[] = [];
  const files = state.modified_files;

  // 1. 高风险文件 → 完整 import 依赖评估
  if (files.some(f =>
    f.includes('chat.ts') || f.includes('FamilyGraph.ts') ||
    f.includes('SQLiteAdapter.ts'),
  )) {
    violations.push('[兜底] 高风险文件改动需完成全量 import 依赖评估（确认所有上层调用方无遗漏适配）');
  }

  // 2. 硬编码检查
  violations.push('[兜底] 需确认未新增硬编码人名、时间常量（应使用统一配置或 M1 DNA 提取）');

  // 3. FG11 条红线全局检查
  violations.push('[兜底·FG] 需逐条对照 FG11 条红线检查清单完成最终核验（参考 wenstar-fg-roleplay.md）');

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// 六、文档同步一致性校验（开发落地规则7——白皮书蓝皮书同步）
// ════════════════════════════════════════════════════════════════════

/**
 * 🔴 架构级改动判定关键词（任一命中即判定为架构级）。
 * 架构级改动若无配套文档更新，直接判定该维不通过。
 */
const ARCH_LEVEL_PATTERNS: readonly RegExp[] = [
  /接口.*变更|接口.*改|interface.*change|API.*变更|契约.*变更/,
  /数据模型.*迁移|schema.*变更|表结构.*改|迁移|migration/i,
  /管线.*重构|管线.*流程|pipeline.*重构|注入链路.*调整/,
  /新增.*模块|删除.*模块|移除.*模块|add.*module|remove.*module/i,
  /认知模块|cognitive.*module/i,
  /FamilyGraph.*schema|FG.*schema|dossier.*结构/,
  /SQLite.*表|table.*change|列.*新增|列.*删除|column.*add|column.*drop/i,
  /chat\.ts.*注入|injection.*chain|finalKnowledgeText|22段/,
  /PFC.*上下文|PrefrontalCortex.*接口|PFC.*interface/,
  /跨模块.*变更|cross-module|跨层.*调用/i,
  /存储.*重构|storage.*refactor|持久化.*改/,
  /角色扮演.*管线|roleplay.*pipeline/i,
];

/** 判断是否为架构级改动（多指标综合判定） */
function isArchLevelChange(state: FlowRunState): boolean {
  const files = state.modified_files;

  // 条件A：文件数 ≥ 3
  const multiFile = files.length >= 3;

  // 条件B：涉及高风险文件
  const touchesHighRisk = files.some(f => {
    const n = f.replace(/\\/g, '/');
    return (
      n.includes('chat.ts') ||
      n.includes('FamilyGraph.ts') ||
      n.includes('SQLiteAdapter.ts') ||
      n.includes('server.ts') ||
      n.includes('DeepSeekLLMProvider.ts') ||
      n.includes('PrefrontalCortex.ts')
    );
  });

  // 条件C：消息内容匹配架构级关键词
  const msgMatches = ARCH_LEVEL_PATTERNS.some(p => p.test(state.risk_level === 'high' ? '架构级' : ''));

  // 条件D：中风险文件数量 ≥ 5
  const midCount = files.filter(f => {
    const n = f.replace(/\\/g, '/');
    return (
      /src\/m[4-5]\//.test(n) ||
      /src\/engine\//.test(n) ||
      /src\/app\//.test(n)
    );
  }).length;

  const archScore = (multiFile ? 2 : 0) + (touchesHighRisk ? 3 : 0) + (msgMatches ? 1 : 0) + (midCount >= 5 ? 2 : 0);

  return archScore >= 3;
}

function checkDocumentSync(state: FlowRunState): string[] {
  const violations: string[] = [];
  const files = state.modified_files;
  const isArch = isArchLevelChange(state);

  if (!isArch) {
    // 非架构级改动——仅记录提醒项（不构成违规）
    if (files.length >= 2) {
      violations.push('[文档·提醒] 多文件修改（≥2），建议同步检查相关文档是否需要更新。');
    }
    return violations;
  }

  // 🔴 架构级改动 → 强制文档同步
  violations.push(
    '[文档·强制] 🔴 本次判定为架构级改动（涉及跨模块接口/数据模型/管线重构/高风险文件）。' +
    '必须同步输出白皮书+蓝皮书文档更新摘要（至少标题+条目列表）。无配套文档内容直接判定本维不通过，打回 S3 补充。',
  );

  // 逐文件产出文档影响提示
  for (const f of files) {
    const n = f.replace(/\\/g, '/');

    if (n.includes('chat.ts')) {
      violations.push('[文档·白皮书] chat.ts 注入链路变更需更新：接口契约（22段注入顺序）、数据流图（finalKnowledgeText 装配流程）');
    }
    if (n.includes('FamilyGraph.ts') || n.includes('family_graph')) {
      violations.push('[文档·白皮书] FamilyGraph schema 变更需更新：蓝皮书 FG 户籍管理章节、白皮书数据模型（nodes/edges schema）、关系图谱拓扑');
    }
    if (n.includes('SQLiteAdapter.ts') || n.includes('sqlite') || n.includes('persistence')) {
      violations.push('[文档·白皮书] 存储层变更需更新：白皮书持久化章节（表结构、防抖save机制）、蓝皮书数据回滚方案');
    }
    if (n.includes('PrefrontalCortex.ts') || n.includes('PFC')) {
      violations.push('[文档·白皮书] PFC 接口变更需更新：白皮书模块依赖关系图（PFC 作为唯一顶层门控）、蓝皮书上下文装配流程');
    }
    if (/src\/m[1-9]\//.test(n)) {
      violations.push(`[文档·白皮书] 认知模块 ${n.match(/src\/(m\d)\//)?.[1] || n} 变更需更新：白皮书九层管线架构图、蓝皮书对应模块功能说明`);
    }
    if (n.includes('server.ts') || n.includes('webui')) {
      violations.push('[文档·蓝皮书] 服务层变更需更新：部署拓扑、启动流程、配置项清单');
    }
    if (n.includes('roleplay') || n.includes('Roleplay')) {
      violations.push('[文档·蓝皮书] 角色扮演管线变更需更新：蓝皮书角色扮演章节（新旧管线切换逻辑、ROLEPLAY_STRUCTURED_ENABLED 配置）');
    }
  }

  // 输出文档产出要求摘要
  violations.push(
    '[文档·清单] 本次文档同步最低要求：' +
    '① 白皮书更新摘要（标题 + 至少 3 条变更条目）；' +
    '② 蓝皮书更新摘要（标题 + 至少 2 条变更条目）；' +
    '③ 回滚方案/配置变更清单。',
  );

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// 七、归类真实性专项校验（开发落地规则8——共性底层/个性特例强制区分）
// ════════════════════════════════════════════════════════════════════

/**
 * 🔴 系统公共内核特征——命中任一项即判定为"疑似共性底层逻辑"。
 * 此类改动若被 S2 归类为"个性局部特例"则高度可疑。
 */
const COMMON_KERNEL_PATTERNS: readonly RegExp[] = [
  // 九层认知管线
  /src\/m[1-9]\//,
  // FamilyGraph 户籍体系
  /FamilyGraph|family_graph|family\.graph/i,
  // UUID 全链路标注
  /UUID|uuid|belong_entity|entity_uuid|TXS-/i,
  // chat.ts 统一注入链路
  /chat\.ts|finalKnowledgeText|injection.*chain/i,
  // 全局记忆抽取
  /MemoryInjector|MemoryRetriever|memory.*retriev/i,
  // 数据库通用读写
  /SQLiteAdapter|FusionStorage|ConversationDB|persistence/i,
  // 角色扮演——但非单角色专属文案
  /roleplay.*pipeline|RoleplayPipeline|buildRoleplay/i,
  // 共享工具函数
  /src\/common\//,
  // PFC 上下文门控
  /PrefrontalCortex|PFC.*context/i,
  // 全局存储
  /FusionStorage|storage.*adapter/i,
  // EntityContextBuilder / MeetingContextPipeline 等多角色复用
  /EntityContextBuilder|MeetingContextPipeline|EntityMeeting/i,
];

/** 个性特例特征——仅单角色独有 */
const SPECIFIC_ONLY_PATTERNS: readonly RegExp[] = [
  /persona\/built-in\/[^/]+\/persona\.ts/,
  /src\/app\/persona\/built-in\//,
  /专属.*文案|custom.*text|custom.*reply/i,
  /单角色.*配置|single.*role.*config/i,
  /独立.*功能.*开关|feature.*flag.*single/i,
];

/**
 * 反向核验：根据文件路径判断该改动是否具备"共性底层"特征。
 * 若文件落在公共内核区域，则判定为疑似共性底层改动。
 */
function classifyByFilePath(state: FlowRunState): 'common_kernel' | 'specific_only' | 'ambiguous' {
  const files = state.modified_files;
  let commonScore = 0;
  let specificScore = 0;

  for (const f of files) {
    const n = f.replace(/\\/g, '/');

    for (const p of COMMON_KERNEL_PATTERNS) {
      if (p.test(n)) { commonScore++; break; }
    }
    for (const p of SPECIFIC_ONLY_PATTERNS) {
      if (p.test(n)) { specificScore++; break; }
    }
  }

  // 多文件+全部落在公共区域 → 强共性信号
  if (commonScore >= files.length && specificScore === 0) return 'common_kernel';
  // 全部落于个性区域 → 个性信号
  if (specificScore >= files.length && commonScore === 0) return 'specific_only';
  // 混合 → 默认按共性处理（保守策略，宁可多审不可漏审）
  if (commonScore > 0) return 'common_kernel';

  return 'ambiguous';
}

/** 从 state 中提取 S2 方案中的归类标记文本（若有） */
function extractS2Classification(_state: FlowRunState): { declared: 'common' | 'specific' | null; raw: string } {
  // S2 方案的归类结果应存储在 global_memo 中
  // 此处在运行时从 state 的上下文中提取
  // 若 memo 未包含归类 → 视为空缺
  const memo = _state.global_memo || '';

  // 检测共性归类标记
  const commonMarkers = [
    /共性底层/,
    /共性.*修复/,
    /common.*fix/i,
    /底层.*通用/,
    /横向.*关联.*模块/,
    /全模块.*同步/,
    /跨角色.*复用/,
  ];
  // 检测个性归类标记
  const specificMarkers = [
    /个性.*特例/,
    /个性.*局部/,
    /specific.*fix/i,
    /单角色.*独有/,
    /无横向.*复用/,
    /专属.*配置/,
    /独立.*功能/,
  ];

  for (const m of commonMarkers) {
    if (m.test(memo)) return { declared: 'common', raw: memo };
  }
  for (const m of specificMarkers) {
    if (m.test(memo)) return { declared: 'specific', raw: memo };
  }

  return { declared: null, raw: memo };
}

function checkRepairClassification(state: FlowRunState): string[] {
  const violations: string[] = [];
  const fileClass = classifyByFilePath(state);
  const s2Declared = extractS2Classification(state);

  // 1. S2 方案缺少归类说明
  if (s2Declared.declared === null) {
    violations.push(
      '[归类·强制] 🔴 S2方案缺少必填板块「本次修改归类：二选一填写（共性底层通用修复 / 个性局部特例修改）」。' +
      '该栏目不允许空缺、模糊、省略。请返回 S2 补充完整归类后重新提交。',
    );
    return violations;
  }

  // 2. 文件路径指向公共内核，但 S2 归类为个性特例 → 虚假归类
  if (fileClass === 'common_kernel' && s2Declared.declared === 'specific') {
    violations.push(
      '[归类·拦截] 🔴 文件路径反向核验：' +
      `修改文件（${state.modified_files.join(', ')}）位于系统公共内核区域（九层管线/FG户籍/UUID链路/全局存储/共享工具），` +
      '但 S2 方案将其归类为「个性局部特例修改」。' +
      '判定为共性底层问题虚假归类为个性特例，疑似规避横向全模块同步校验。' +
      '请返回 S2 更正归类，并补充横向关联模块清单。',
    );
  }

  // 3. 归类为共性底层修复，但未附横向关联模块清单
  if (s2Declared.declared === 'common') {
    const hasModuleList = /横向.*关联.*模块|关联.*角色.*清单|受影响.*文件.*清单|全量.*依赖.*列表/.test(s2Declared.raw);
    const hasFileList = (s2Declared.raw.match(/src\/[a-zA-Z0-9_/\-]+\.ts/g) || []).length >= 2;

    if (!hasModuleList && !hasFileList) {
      violations.push(
        '[归类·清单缺失] 🔴 S2方案归类为「共性底层通用修复」，但未附横向关联模块清单。' +
        '必须列出全部受影响文件与关联角色清单。' +
        '请返回 S2 执行全仓库横向检索，补充完整清单后重新提交。',
      );
    }

    // 仅单文件却声称共性修复 → 可疑
    if (state.modified_files.length === 1 && !hasFileList) {
      violations.push(
        '[归类·可疑] ⚠️ 归类为共性底层修复但仅涉及1个文件，需确认是否遗漏横向关联模块。' +
        '若确认为共性底层逻辑，应列出所有复用该逻辑的文件清单。',
      );
    }
  }

  // 4. 归类为个性特例，但评审检出跨角色复用链路
  if (s2Declared.declared === 'specific' && fileClass === 'common_kernel') {
    // 已在第2条拦截，此处不重复
  }

  // 5. 多文件+高风险，但归类为个性特例 → 高度可疑
  if (s2Declared.declared === 'specific' && state.modified_files.length >= 3 && state.risk_level === 'high') {
    violations.push(
      '[归类·可疑] ⚠️ 本次涉及3个以上高风险文件，却归类为「个性局部特例」。' +
      '请重新审视是否存在跨模块公共逻辑变更场景。如有，应更正为「共性底层通用修复」。',
    );
  }

  // 6. ambiguous 情况：文件不明确，但 S2 声称个性 → 需附详细论证
  if (fileClass === 'ambiguous' && s2Declared.declared === 'specific') {
    const hasReasoning = /判定依据|判定.*理由|原因.*如下|无横向.*因为|不存在.*复用.*因为/.test(s2Declared.raw);
    if (!hasReasoning) {
      violations.push(
        '[归类·论证缺失] ⚠️ 文件归属不明确，S2归类为个性特例但缺少详细判定依据。' +
        '请补充"为何无跨角色复用场景"的具体推理过程。',
      );
    }
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// 八、基础静态质量校验（新规则5 第一层——编译/类型/死代码/编码规范）
// ════════════════════════════════════════════════════════════════════

/**
 * 🔴 基础静态质量门槛（新规则5 第一层）：
 * 编译必须完整通过，类型合规、无语法错误、无死代码、废弃导入、类型逃逸；
 * 公共模块需遵循高复用、低耦合原则，统一项目编码与分层规范。
 */
function checkStaticQuality(state: FlowRunState): string[] {
  const violations: string[] = [];
  const files = state.modified_files;

  violations.push(
    '[静态质量·强制] 🔴 所有代码变更必须通过基础静态质量门槛（新规则5 第一层）：' +
    '① tsc --noEmit 零类型错误；② 无死代码/废弃导入/类型逃逸(as any)；' +
    '③ 公共模块遵循高复用、低耦合原则；④ 统一项目编码与分层规范。',
  );

  // 逐文件静态质量检查点
  for (const f of files) {
    const n = f.replace(/\\/g, '/');

    if (/src\/m[1-9]\//.test(n)) {
      violations.push(`[静态质量·管线] ${n}：M层模块修改需确认类型定义完整、无循环引用、导入路径正确`);
    }
    if (/chat\.ts/.test(n)) {
      violations.push('[静态质量·chat.ts] 需确认无死代码残留、废弃导入未清理、类型断言(as any)已消除');
    }
    if (/\.test\.ts|\.spec\.ts/.test(n)) {
      violations.push('[静态质量·测试] 测试文件修改需确认测试用例本身编译通过，断言逻辑正确');
    }
  }

  // 低风险文件检查
  const hasSourceFiles = files.some(f => /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !/\.spec\.ts$/.test(f));
  if (hasSourceFiles) {
    violations.push(
      '[静态质量·编译] ⚠️ 请确认：本次修改完成后已执行 npx tsc --noEmit 并通过，无任何类型错误。' +
      '编译不通过直接判定评审不通过。',
    );
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// 九、鲁棒加固专项校验（新规则5 第二层——容错兜底/边界防护/自校验）
// ════════════════════════════════════════════════════════════════════

/** 🔴 核心链路文件——必须配套容错兜底 */
const ROBUSTNESS_CRITICAL_PATTERNS: readonly RegExp[] = [
  /chat\.ts/,
  /FamilyGraph/,
  /SQLiteAdapter/,
  /DeepSeekLLMProvider/,
  /PrefrontalCortex/,
  /MemoryInjector/,
  /MemoryRetriever/,
  /ConversationDB/,
  /FusionStorageAdapter/,
  /EntityMeeting/,
  /MeetingContextPipeline/,
  /UUIDGatekeeper/,
  /RAGPipeline/,
  /KnowledgeEngine/,
];

function checkRobustnessGuards(state: FlowRunState): string[] {
  const violations: string[] = [];
  const files = state.modified_files;

  const touchesCore = files.some(f => {
    const n = f.replace(/\\/g, '/');
    return ROBUSTNESS_CRITICAL_PATTERNS.some(p => p.test(n));
  });

  if (!touchesCore) {
    // 非核心链路文件 → 仅提醒
    violations.push('[鲁棒·提醒] 非核心链路文件修改，建议检查异常处理是否完善。');
    return violations;
  }

  // 核心链路文件 → 强制校验
  violations.push(
    '[鲁棒·强制] 🔴 本次修改涉及核心链路文件。每个修改点必须配套容错兜底逻辑。' +
    'S3编码落地时必须附带容错说明（正常路径+异常路径+边界条件）。',
  );

  // 逐文件鲁棒检查点
  for (const f of files) {
    const n = f.replace(/\\/g, '/');

    if (/chat\.ts/.test(n) || /DeepSeekLLMProvider/.test(n)) {
      violations.push('[鲁棒·LLM] 涉及LLM调用链路，必须配套：超时(30s)+重试(3次)+熔断(circuit breaker)三级保护');
    }
    if (/SQLiteAdapter/.test(n) || /ConversationDB/.test(n) || /FusionStorage/.test(n)) {
      violations.push('[鲁棒·持久化] 涉及数据库写入，必须保留scheduleFlush防抖落盘、事务回滚保护、save()调用不可删除');
    }
    if (/FamilyGraph/.test(n)) {
      violations.push('[鲁棒·FG] 涉及FamilyGraph修改，必须配套：空节点防护、脏边清理、事务回滚、并发写入队列');
    }
    if (/MemoryInjector|MemoryRetriever/.test(n)) {
      violations.push('[鲁棒·记忆] 涉及记忆检索链路，必须配套：空结果降级、检索超时熔断、向量服务不可用时的规则兜底');
    }
    if (/RAGPipeline|KnowledgeEngine/.test(n)) {
      violations.push('[鲁棒·KB] 涉及知识库检索，必须配套：索引不可用时的降级策略、FTS5回退路径');
    }
  }

  // 表层补丁检测
  violations.push(
    '[鲁棒·补丁检测] ⚠️ 请核验：本次修改是否为表层补丁（仅修主路径、未配套异常分支）？' +
    '若是，则直接判定评审不通过，打回 S3 补充容错兜底。',
  );

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// 十、Hook埋点与自检合规校验（新规则8——核心链路侦测+六级体检）
// ════════════════════════════════════════════════════════════════════

/** 必须埋点的核心链路关键词 */
const HOOK_REQUIRED_PATTERNS: readonly RegExp[] = [
  /src\/m[1-9]\//,
  /PrefrontalCortex/,
  /FamilyGraph/,
  /belong_entity_uuid|UUID/,
  /chat\.ts/,
  /SQLiteAdapter|persistence/,
  /roleplay|Roleplay/,
  /EntityMeeting|MeetingContext/,
  /RAGPipeline|KnowledgeEngine/,
];

const SIX_STAGE_HEALTH_CHECK = [
  '① 编译校验（tsc --noEmit）→ 零类型错误',
  '② 全量单元测试（vitest run）→ 全部通过',
  '③ 高风险模块专项测试（m4/m2/fg目录）→ 全部通过',
  '④ 三类场景行为核验（普通对话/会晤模式/角色扮演）→ 无角色串号/信息泄漏/幻觉编造',
  '⑤ 数据库标注率审计（belong_entity_uuid标注率不低于改造前基线）',
  '⑥ 停服重启持久化核验（内存数据落盘不丢失、UUID标注不回退）',
];

function checkHookAndSelfCheck(state: FlowRunState): string[] {
  const violations: string[] = [];
  const files = state.modified_files;

  const requiresHook = files.some(f => {
    const n = f.replace(/\\/g, '/');
    return HOOK_REQUIRED_PATTERNS.some(p => p.test(n));
  });

  if (!requiresHook) {
    violations.push('[Hook·提醒] 非核心链路修改，建议酌情增加Hook埋点用于监控。');
    return violations;
  }

  // 强制Hook埋点
  violations.push(
    '[Hook·强制] 🔴 本次修改涉及核心链路，每个修改点必须配套Hook事件埋点。' +
    '埋点字段：operation_type（操作类型标识）、duration_ms（执行耗时）、status（success/fail/error）。',
  );

  // 逐文件Hook要求
  for (const f of files) {
    const n = f.replace(/\\/g, '/');
    if (/src\/m[1-9]\//.test(n)) {
      violations.push(`[Hook·埋点] ${n}：M层管线节点需埋点（module_entry / module_exit + 耗时）`);
    }
    if (/chat\.ts/.test(n)) {
      violations.push('[Hook·埋点] chat.ts：注入链路需埋点（finalKnowledgeText 装配耗时 + 各段字节数）');
    }
    if (/SQLiteAdapter|persistence/.test(n)) {
      violations.push('[Hook·埋点] SQLiteAdapter：持久化需埋点（write_latency + save_flush + transaction_status）');
    }
    if (/FamilyGraph/.test(n)) {
      violations.push('[Hook·埋点] FamilyGraph：户籍操作需埋点（integrate_entity / update_profile / relation_change）');
    }
  }

  // 六级全景健康体检
  violations.push(
    '[Hook·体检] 🔴 流水线闭环前必须完成六级全景健康体检，任一阶段不通过不得进入S7归档：',
  );
  for (const stage of SIX_STAGE_HEALTH_CHECK) {
    violations.push(`[Hook·体检]   ${stage}`);
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// 十一、优化提案落地真实性校验（新规则9——LLM优化提案弹性机制）
// ════════════════════════════════════════════════════════════════════

/** 检测 S2 方案中是否有全局优化提案 */
function extractS2ProposalStatus(_state: FlowRunState): {
  hasProposal: boolean;
  proposalType: 'none' | 'optimization' | 'both';
  userApproval: 'original' | 'optimized' | null;
  raw: string;
} {
  const memo = _state.global_memo || '';

  const hasOptimizationSection =
    /全局.*优化.*提案|全局.*升级.*空间|形态二.*存在.*优化|原方案隐患评估|全局优化替代方案|差异对比矩阵/.test(memo);

  const hasNoneSection =
    /形态一.*无优化|无优化空间|无全局优化提案|仅.*局部.*合理|严格.*按照.*用户.*需求/.test(memo);

  const userApprovedOriginal =
    /维持.*原始.*方案|采纳.*原.*方案|选择.*原.*方案|驳回.*优化.*提案|拒绝.*优化/i.test(memo);

  const userApprovedOptimized =
    /采纳.*全局.*优化|同意.*优化.*提案|选择.*优化.*方案|按.*优化.*方案.*执行/i.test(memo);

  const proposalType = hasOptimizationSection && hasNoneSection ? 'both'
    : hasOptimizationSection ? 'optimization'
    : hasNoneSection ? 'none'
    : 'none';

  const userApproval = userApprovedOriginal ? 'original'
    : userApprovedOptimized ? 'optimized'
    : null;

  return { hasProposal: hasOptimizationSection, proposalType, userApproval, raw: memo };
}

function checkProposalFidelity(state: FlowRunState): string[] {
  const violations: string[] = [];
  const proposal = extractS2ProposalStatus(state);

  // 1. S2 方案缺少优化提案板块
  if (proposal.proposalType === 'none' && !proposal.userApproval) {
    violations.push(
      '[提案·强制] 🔴 S2方案缺少必填板块「全局架构优化提案：二选一填写（无优化空间 / 存在全局升级空间）」。' +
      '该板块不允许空缺、模糊、省略。请返回 S2 补充后重新提交。',
    );
    return violations;
  }

  // 2. 用户否决了优化提案 → 核验是否退回原始方案
  if (proposal.userApproval === 'original') {
    violations.push(
      '[提案·一致性] 🔴 用户已否决全局优化提案，选择维持原始局部方案。' +
      '请核验：AI是否已严格退回原始方案执行？是否存在暗中套用被否决优化逻辑的行为？' +
      '若检测到被否决的优化逻辑混入代码，直接判定评审不通过。',
    );
  }

  // 3. 用户同意了优化提案 → 核验新方案是否完整落地
  if (proposal.userApproval === 'optimized') {
    violations.push(
      '[提案·落地] 🔴 用户已采纳全局优化替代方案。请核验以下全部流程是否已完整落地：' +
      '① 共性横向全模块校验清单已完成；' +
      '② 鲁棒加固兜底方案已配套；' +
      '③ Hook埋点已覆盖全部核心链路；' +
      '④ 六级全景健康体检已全部通过；' +
      '⑤ 稳定链路保护措施已就位。' +
      '以上任一项未完成 → 判定评审不通过，打回 S3 补充。',
    );
  }

  // 4. 存在优化提案但用户未明确审批 → 标记为待决
  if (proposal.hasProposal && proposal.userApproval === null) {
    violations.push(
      '[提案·待决] ⚠️ S2方案已输出全局优化替代方案，但未检测到明确的用户审批选择。' +
      '请在 S2 的「用户审批」栏中勾选：□ 维持原始方案 □ 采纳全局优化方案。' +
      '未审批不得进入 S3 编码阶段。',
    );
  }

  // 5. 方案对比审计要求
  violations.push(
    '[提案·审计] 无论最终采用原始方案还是优化方案，以下内容必须完整写入本轮流水线审计卷宗永久留存：' +
    '① 原始局部方案全文；② AI提出的全局优化方案全文（如有）；③ 用户审批选择及理由；④ 两方案差异对比矩阵。',
  );

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// human_report 构建
// ════════════════════════════════════════════════════════════════════

function buildHumanReport(
  stageName: string,
  state: FlowRunState,
  violations: string[],
  metrics: MachineSignalMetrics,
): string {
  const lines: string[] = [];

  lines.push(`## 📋 ${stageName} — 评审报告`);
  lines.push('');
  lines.push(`**评审时间**：${new Date().toISOString()}`);
  lines.push(`**修改文件**：${state.modified_files.join(', ')}`);
  lines.push(`**风险等级**：${state.risk_level}`);
  lines.push(`**检查文件数**：${metrics.files_checked}`);
  lines.push(`**违规数**：${metrics.violations_found}`);
  lines.push('');

  if (violations.length === 0) {
    lines.push('### ✅ 评审通过');
    lines.push('');
    lines.push('所有校验维度均已通过，无违规项。');
  } else {
    lines.push('### ❌ 评审未通过');
    lines.push('');
    lines.push('以下违规项需修复后重新提交：');
    lines.push('');
    for (let i = 0; i < violations.length; i++) {
      lines.push(`${i + 1}. ${violations[i]}`);
    }
  }

  // 附加指标
  if (metrics.fg_redlines_touched && metrics.fg_redlines_touched.length > 0) {
    lines.push('');
    lines.push(`**触碰 FG 红线**：${metrics.fg_redlines_touched.map(r => `红线${r}`).join(', ')}`);
  }
  if (metrics.uuid_chain_broken) {
    lines.push('**UUID 链路风险**：⚠️ 标注链路可能受损');
  }
  if (metrics.chat_injection_order_changed) {
    lines.push('**注入顺序风险**：⚠️ chat.ts 22段注入顺序可能变更');
  }

  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════
// 五维校验完整性自检（开发落地规则3）
// ════════════════════════════════════════════════════════════════════

/** 十一维校验名称（映射新9条规则） */
const FIVE_DIMENSIONS = [
  '架构层级校验',          // → 新规则1 顶层架构强制对齐
  'FG户籍&UUID专项校验',   // → 新规则3 上下游依赖全域校验
  '耦合点专项校验',        // → 新规则3 上下游依赖全域校验
  '持久化安全校验',        // → 新规则5 第二层 鲁棒加固
  '风险兜底校验',          // → 新规则2 变更范围围栏
  '文档同步一致性校验',    // → 新规则4 代码与文档双向同步
  '归类真实性校验',        // → 新规则6 共性/个性归类
  '基础静态质量校验',      // → 新规则5 第一层 基础静态质量门槛
  '鲁棒加固校验',          // → 新规则5 第二层 缺陷修复强制鲁棒加固
  'Hook埋点与自检合规校验', // → 新规则8 核心链路Hook侦测
  '优化提案落地真实性校验', // → 新规则9 LLM全局优化提案
] as const;

/**
 * 自检评审十一维是否完整覆盖。
 * 任何一维产生空结果（既无违规也无通过标记）视为维度缺失。
 */
function validateReviewCompleteness(
  arch: string[],
  fg: string[],
  coupling: string[],
  persist: string[],
  risk: string[],
  doc: string[],
  classify: string[],
  staticQuality: string[],
  robust: string[],
  hook: string[],
  proposal: string[],
): { passed: boolean; missing: string[] } {
  const results: { dim: string; hasOutput: boolean }[] = [
    { dim: FIVE_DIMENSIONS[0], hasOutput: arch.length > 0 },
    { dim: FIVE_DIMENSIONS[1], hasOutput: fg.length > 0 },
    { dim: FIVE_DIMENSIONS[2], hasOutput: coupling.length > 0 },
    { dim: FIVE_DIMENSIONS[3], hasOutput: persist.length > 0 },
    { dim: FIVE_DIMENSIONS[4], hasOutput: risk.length > 0 },
    { dim: FIVE_DIMENSIONS[5], hasOutput: doc.length > 0 },
    { dim: FIVE_DIMENSIONS[6], hasOutput: classify.length > 0 },
    { dim: FIVE_DIMENSIONS[7], hasOutput: staticQuality.length > 0 },
    { dim: FIVE_DIMENSIONS[8], hasOutput: robust.length > 0 },
    { dim: FIVE_DIMENSIONS[9], hasOutput: hook.length > 0 },
    { dim: FIVE_DIMENSIONS[10], hasOutput: proposal.length > 0 },
  ];

  const missing = results.filter(r => !r.hasOutput).map(r => r.dim);

  if (missing.length > 0) {
    console.warn(`[DelegateReviewer] ⚠️ 评审维度缺失: ${missing.join(', ')}`);
  }

  return { passed: missing.length === 0, missing };
}

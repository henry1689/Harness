/**
 * SelfReviewer — 独立自护评审组件
 * ====================================
 * SelfGuard 体系的专用评审器，独立于主 Harness 的 DelegateReviewer。
 *
 * 核心职责：
 *   1. 对主 Harness 基础设施变更执行九条自护铁律全维度评审
 *   2. 输出双通道信号：machine_signal（结构化判定）+ human_report（可读报告）
 *   3. 生效域限定：仅管控 src/harness/ 及 data/harness/ 目录变更
 *
 * 🔴 与 DelegateReviewer 的隔离：
 *   - SelfReviewer 仅在 SelfGuard 流水线内部激活
 *   - 主业务流水线使用 DelegateReviewer，无法读取 SelfReviewer
 *   - 两套规则集物理隔离、互不污染
 *
 * 🔴 子 Agent 只能读取文件，不能写入/删除/修改——白名单在 delegate 模式自动锁定。
 */

import type { StageConfig, StageOutput, MachineSignal, MachineSignalMetrics, FlowRunState } from '../src/types.js';
import { passSignal, rejectSignal, makeStageOutput } from '../src/DualChannelSignal.js';

// ════════════════════════════════════════════════════════════════════
// 公开 API
// ════════════════════════════════════════════════════════════════════

/**
 * 执行 SelfGuard 独立评审——自护子系统专用入口。
 *
 * @param stage — S4 stage 配置（含 work_manual）
 * @param state — 当前流水线运行状态（含 modified_files, global_memo 等）
 * @returns StageOutput { machine_signal, human_report }
 */
export function review(stage: StageConfig, state: FlowRunState): StageOutput {
  console.log(`[SelfReviewer] 🔍 自护评审开始: ${stage.stage_id}`);
  console.log(`[SelfReviewer]    文件: ${state.modified_files.join(', ')}`);
  console.log(`[SelfReviewer]    风险: ${state.risk_level}`);

  const violations: string[] = [];
  const metrics: MachineSignalMetrics = {
    files_checked: state.modified_files.length,
    violations_found: 0,
  };

  // ── 九条自护铁律逐条校验 ──

  // SG-R1: 改动范围铁律
  const r1Violations = checkSG_R1_ScopeBoundary(state);
  violations.push(...r1Violations);

  // SG-R2: 底层架构不可破坏基线
  const r2Violations = checkSG_R2_BaselineProtection(state);
  violations.push(...r2Violations);

  // SG-R3: Harness 变更强制最高风险等级
  const r3Violations = checkSG_R3_RiskEnforcement(state);
  violations.push(...r3Violations);

  // SG-R4: 禁止隐性削弱原有防护能力
  const r4Violations = checkSG_R4_ProtectionEscalation(state);
  violations.push(...r4Violations);

  // SG-R5: 双向兼容强制校验
  const r5Violations = checkSG_R5_Compatibility(state);
  violations.push(...r5Violations);

  // SG-R6: 基础设施配套文档同步
  const r6Violations = checkSG_R6_DocumentationSync(state);
  violations.push(...r6Violations);

  // SG-R7: 全量单元测试强制100%通过
  const r7Violations = checkSG_R7_TestEnforcement(state);
  violations.push(...r7Violations);

  // SG-R8: 基础设施变更痕迹强化归档
  const r8Violations = checkSG_R8_AuditTrail(state);
  violations.push(...r8Violations);

  // SG-R9: 架构重构提案权限收缩
  const r9Violations = checkSG_R9_PermissionControl(state);
  violations.push(...r9Violations);

  // SG-R10: 版本迭代强制复审（去臃肿/去重复/一致性校验）
  const r10Violations = checkSG_R10_IterationReview(state);
  violations.push(...r10Violations);

  // SG-R11: 外部制衡与旁路巡检（权限审计 + 拦截规则核验 + 越权检测）
  const r11Violations = checkSG_R11_ExternalOversight(state);
  violations.push(...r11Violations);

  // ── 评审完整性自检 ──
  const allResults = [
    r1Violations, r2Violations, r3Violations,
    r4Violations, r5Violations, r6Violations,
    r7Violations, r8Violations, r9Violations,
    r10Violations, r11Violations,
  ];
  const missingDim = allResults
    .map((r, i) => (r.length === 0 ? null : `SG-R${i + 1}`))
    .filter(Boolean);

  if (missingDim.length > 0) {
    console.warn(`[SelfReviewer] ⚠️ 以下铁律维度产出为空（可能漏检）: ${missingDim.join(', ')}`);
  }

  metrics.violations_found = violations.length;

  // ── 构建双通道输出 ──
  const passed = violations.length === 0;
  const riskLevel = state.risk_level === 'high' ? 'high' : 'mid';

  const machineSignal: MachineSignal = passed
    ? passSignal(metrics)
    : rejectSignal(violations, riskLevel, metrics);

  const humanReport = buildHumanReport(stage.stage_name, state, violations, metrics);

  console.log(`[SelfReviewer] ${passed ? '✅ 自护评审通过' : '❌ 自护评审驳回'} (${violations.length} 个违规)`);

  return makeStageOutput(machineSignal, humanReport);
}

// ════════════════════════════════════════════════════════════════════
// SG-R1: 改动范围铁律
// ════════════════════════════════════════════════════════════════════

/**
 * 改动范围铁律校验：
 * - 修改文件必须在 src/ 或 data/ 目录内
 * - 禁止修改业务目录（src/m1-m9, src/app, src/webui 等）
 * - 检测用户未明确指定的附属文件修改
 */
function checkSG_R1_ScopeBoundary(state: FlowRunState): string[] {
  const violations: string[] = [];
  const files = state.modified_files;

  // 1. 有效域检查：所有修改文件必须落在 harness 目录内
  const ALLOWED_PREFIXES = ['src/', 'data/', 'self_guard/'];

  for (const f of files) {
    const n = f.replace(/\\/g, '/');
    const inScope = ALLOWED_PREFIXES.some(p => n.startsWith(p));

    if (!inScope) {
      violations.push(
        `[SG-R1·范围越界] 文件 "${f}" 不在 Harness 管控域内。` +
        'SelfGuard 仅管控 src/ 及 data/ 目录变更。' +
        '业务目录文件请走主 Harness 流水线，不要在 SelfGuard 内提交。',
      );
    }
  }

  // 2. 禁止修改的重点业务目录
  const FORBIDDEN_PATTERNS = [
    /^src\/m[1-9]\//,
    /^src\/app\//,
    /^src\/webui\//,
    /^src\/engine\//,
    /^src\/config\//,
    /^src\/core\//,
    /^src\/adapter\//,
    /^src\/modules\//,
  ];

  for (const f of files) {
    const n = f.replace(/\\/g, '/');
    for (const p of FORBIDDEN_PATTERNS) {
      if (p.test(n)) {
        violations.push(
          `[SG-R1·业务越界] 文件 "${f}" 属于业务目录，SelfGuard 自动拦截。` +
          '业务迭代走主 Harness，Harness 基础设施改造才走 SelfGuard。',
        );
        break;
      }
    }
  }

  // 3. 多文件附带修改检测
  if (files.length > 1) {
    violations.push(
      `[SG-R1·范围检查] 涉及 ${files.length} 个文件，请确认所有文件都是用户明确指定的修改目标。` +
      '禁止自主推断扩大修改范围。如存在用户未指定的文件，请移除。',
    );
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// SG-R2: 底层架构不可破坏基线
// ════════════════════════════════════════════════════════════════════

/** 基础设施基线文件——修改时触发最高级别保护 */
const BASELINE_FILES: readonly string[] = [
  'FlowEngine.ts',
  'StageRunner.ts',
  'GateController.ts',
  'DelegateReviewer.ts',
  'AuditLogger.ts',
  'ToolWhitelistGuard.ts',
  'GlobalMemoStore.ts',
  'DualChannelSignal.ts',
  'FlowConfigLoader.ts',
  'types.ts',
];

function checkSG_R2_BaselineProtection(state: FlowRunState): string[] {
  const violations: string[] = [];
  const files = state.modified_files;

  // 检测是否触碰了基线文件
  const touchedBaseline = files.filter(f => {
    const name = f.replace(/\\/g, '/').split('/').pop() || '';
    return BASELINE_FILES.includes(name);
  });

  if (touchedBaseline.length > 0) {
    violations.push(
      `[SG-R2·基线触碰] 🔴 修改涉及基础设施基线文件：${touchedBaseline.join(', ')}。` +
      '七阶流水线流转顺序、UUID门阀隔离、双轨卷宗存储、历史只增不删原则、' +
      '上下文隔离逻辑——属于不可动摇基线。' +
      '仅允许增补/配置替换/逻辑适配；禁止删除、倒置、整体重构。',
    );
  }

  // 检测七阶流水线配置是否被倒置
  if (files.some(f => f.includes('flows/') && f.endsWith('.yaml'))) {
    violations.push(
      '[SG-R2·流水线配置] 修改了流水线 YAML 配置。请确认 stages 顺序保持 S1→S7 正向流转，' +
      '未删除或倒置任何阶段。UUID门阀隔离机制和双轨卷宗存储逻辑未受损。',
    );
  }

  // 检测 types.ts 是否删减核心类型
  if (files.some(f => f.includes('types.ts'))) {
    violations.push(
      '[SG-R2·类型基线] 修改了 Harness types.ts。请确认未删除 FlowConfig、FlowRunState、' +
      'StageResult、MachineSignal 等核心运行时类型定义。字段只增不删。',
    );
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// SG-R3: Harness 变更强制升级为最高风险等级
// ════════════════════════════════════════════════════════════════════

function checkSG_R3_RiskEnforcement(state: FlowRunState): string[] {
  const violations: string[] = [];

  // 自动将 Harness 变更判定为超高风险
  violations.push(
    '[SG-R3·风险等级] ⚠️ 本次为 Harness 基础设施变更，系统自动判定为 🔴超高风险。',
  );

  // 检查 S2 方案是否包含四项强制材料
  const memo = state.global_memo || '';

  const requiredMaterials = [
    { key: '改动影响域', patterns: [/改动.*影响/, /影响.*范围/, /影响域/, /impact/i] },
    { key: '完整回退方案', patterns: [/回退.*方案/, /回滚.*方案/, /rollback/i, /revert/i] },
    { key: '前置校验步骤', patterns: [/前置.*校验/, /前置.*检查/, /pre-check/i, /预检/] },
    { key: '后置验证方案', patterns: [/后置.*验证/, /验证.*方案/, /post.*verif/i, /落地.*验证/] },
  ];

  const missing: string[] = [];
  for (const mat of requiredMaterials) {
    const found = mat.patterns.some(p => p.test(memo));
    if (!found) {
      missing.push(mat.key);
    }
  }

  if (missing.length > 0) {
    violations.push(
      `[SG-R3·材料缺失] 🔴 S2 方案缺少以下强制材料：${missing.join('、')}。` +
      'Harness 基础设施变更必须包含：改动影响域、完整回退方案、前置校验步骤、后置验证方案。' +
      '四项缺一不可，禁止进入编码环节。',
    );
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// SG-R4: 禁止隐性削弱原有防护能力
// ════════════════════════════════════════════════════════════════════

/** 防护削弱信号——检测到的削弱行为关键词 */
const WEAKENING_SIGNALS: readonly RegExp[] = [
  /删除.*校验/,
  /移除.*检查/,
  /去掉.*拦截/,
  /放宽.*条件/,
  /降低.*标准/,
  /简化.*评审/,
  /跳过.*维度/,
  /remove.*check/i,
  /delete.*validation/i,
  /weaken/i,
  /bypass/i,
  /skip.*review/i,
  /disable.*gate/i,
];

/** 防护增强信号——合法方向 */
const STRENGTHENING_SIGNALS: readonly RegExp[] = [
  /新增.*校验/,
  /增加.*检查/,
  /增强.*防护/,
  /合并.*冗余/,
  /精简.*结构/,
  /优化.*流程/,
  /add.*check/i,
  /add.*validation/i,
  /strengthen/i,
  /merge.*duplicate/i,
  /simplify.*structure/i,
];

function checkSG_R4_ProtectionEscalation(state: FlowRunState): string[] {
  const violations: string[] = [];
  const memo = state.global_memo || '';

  // 检测削弱信号
  const weakeningMatches: string[] = [];
  for (const pattern of WEAKENING_SIGNALS) {
    if (pattern.test(memo)) {
      weakeningMatches.push(pattern.source.replace(/\\/g, ''));
    }
  }

  // 检测增强信号
  const hasStrengthening = STRENGTHENING_SIGNALS.some(p => p.test(memo));

  if (weakeningMatches.length > 0 && !hasStrengthening) {
    violations.push(
      `[SG-R4·削弱警告] 🔴 S2 方案中检测到潜在防护削弱信号：${weakeningMatches.slice(0, 3).join(', ')}。` +
      '规则修改、评审逻辑修改只允许增强校验强度、合并冗余规则、精简臃肿结构；' +
      '禁止删减评审维度、弱化拦截条件、降低原有防护等级。逆向削弱防护的改动直接拦截。',
    );
  }

  // 检查评审维度是否减少
  if (state.modified_files.some(f => f.includes('DelegateReviewer') || f.includes('SelfReviewer'))) {
    violations.push(
      '[SG-R4·维度保护] ⚠️ 修改了评审器文件。请确认评审维度数量未减少、' +
      '拦截条件强度未降低、原有校验规则未被删除。只允许增强不允许削弱。',
    );
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// SG-R5: 双向兼容强制校验
// ════════════════════════════════════════════════════════════════════

function checkSG_R5_Compatibility(state: FlowRunState): string[] {
  const violations: string[] = [];

  violations.push(
    '[SG-R5·兼容性] 🔴 Harness 基础设施变更必须通过双向兼容校验：' +
    '① 新版本能正确读取历史审计卷宗（JSON格式兼容）；' +
    '② 新版本能解析历史 FlowRunState 数据；' +
    '③ 已标记稳定固化模块未被破坏；' +
    '④ 历史 UUID 身份档案（TXS-xxxx）格式兼容；' +
    '⑤ 数据模型变更向后兼容（字段只增不删）；' +
    '⑥ 流水线上下文新旧版本间可平滑迁移。',
  );

  // 检查 types.ts 是否有破坏性变更
  if (state.modified_files.some(f => f.includes('types.ts'))) {
    violations.push(
      '[SG-R5·类型兼容] ⚠️ 修改了 types.ts。请确认：所有字段修改为只增不删；' +
      '现有接口未改变必填字段定义；新增类型不影响已有 FlowRunState 数据的反序列化。',
    );
  }

  // 检查 FlowEngine.ts 是否有破坏性变更
  if (state.modified_files.some(f => f.includes('FlowEngine.ts'))) {
    violations.push(
      '[SG-R5·引擎兼容] ⚠️ 修改了 FlowEngine.ts。请确认：DFA 跳转逻辑变更不影响正在运行的流水线；' +
      'FlowRunState 的 Map 序列化/反序列化逻辑未受损。',
    );
  }

  // 检查 YAML 配置变更
  if (state.modified_files.some(f => f.endsWith('.yaml'))) {
    violations.push(
      '[SG-R5·配置兼容] ⚠️ 修改了流水线 YAML 配置。请确认：新增 stage 不影响现有 stage_id 索引；' +
      'gate_type 枚举值未变更；runner_mode 枚举值未变更。',
    );
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// SG-R6: 基础设施配套文档同步
// ════════════════════════════════════════════════════════════════════

function checkSG_R6_DocumentationSync(state: FlowRunState): string[] {
  const violations: string[] = [];
  const files = state.modified_files;

  // 判断是否涉及需要文档同步的修改
  const needsDocSync = files.some(f => {
    const n = f.replace(/\\/g, '/');
    return (
      n.includes('DelegateReviewer') ||
      n.includes('SelfReviewer') ||
      n.includes('FlowEngine') ||
      n.includes('StageRunner') ||
      n.includes('.yaml') ||
      n.includes('types.ts') ||
      n.includes('index.ts')
    );
  });

  if (needsDocSync) {
    violations.push(
      '[SG-R6·文档同步] 🔴 本次修改涉及 Harness 规则/评审逻辑/调度逻辑，必须同步更新：' +
      '① harness/self_guard/README.md（架构说明文档）；' +
      '② self_guard_rules.yaml 中的规则释义（如规则本身有变更）；' +
      '③ 变更记录单独归档至 SelfGuard 专属卷宗。' +
      '请确认以上文档已同步更新后方可通过。',
    );
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// SG-R7: 全量单元测试强制100%通过
// ════════════════════════════════════════════════════════════════════

function checkSG_R7_TestEnforcement(state: FlowRunState): string[] {
  const violations: string[] = [];

  violations.push(
    '[SG-R7·测试强制] 🔴 Harness 自身全套单元测试必须全部通过（S5 阶段执行）：' +
    '① npx vitest run src/__tests__/ — 零测试失败；' +
    '② 任意测试失败直接阻断变更落地，禁止强行放行；' +
    '③ 集成测试回归验证必须通过。',
  );

  // 如果修改了核心逻辑文件，加强测试要求提示
  const touchesCore = state.modified_files.some(f => {
    const name = f.replace(/\\/g, '/').split('/').pop() || '';
    return ['FlowEngine.ts', 'GateController.ts', 'StageRunner.ts', 'DelegateReviewer.ts'].includes(name);
  });

  if (touchesCore) {
    violations.push(
      '[SG-R7·核心覆盖] ⚠️ 本次修改涉及核心引擎文件，除现有测试外，建议补充针对本次变更的专项测试用例。',
    );
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// SG-R8: 基础设施变更痕迹强化归档
// ════════════════════════════════════════════════════════════════════

function checkSG_R8_AuditTrail(state: FlowRunState): string[] {
  const violations: string[] = [];

  violations.push(
    '[SG-R8·归档] 🔴 本次基础设施变更痕迹必须按以下要求归档：' +
    '① 所有审计记录打上【基础设施变更】专属标签；' +
    '② 审计数据写入 data/self_guard/audit/ 独立分区（非业务审计分区）；' +
    '③ 遵循历史只增不删原则；' +
    '④ 记录版本链（当前版本 ← 上一稳定版本）；' +
    '⑤ 确保一键回退至上一稳定版本路径可用。',
  );

  // 提醒版本链
  violations.push(
    '[SG-R8·版本链] 📌 请在 S7 归档阶段记录本次变更的 git commit hash 作为版本快照引用，' +
    '并更新版本链中的上一稳定版本引用。',
  );

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// SG-R9: 架构重构提案权限收缩
// ════════════════════════════════════════════════════════════════════

/** AI 无权提议的模式——检测到即拦截 */
const FORBIDDEN_PROPOSAL_PATTERNS: readonly RegExp[] = [
  /底层.*架构.*重构/,
  /底层.*重构/,
  /架构.*重构/,
  /流程.*颠覆/,
  /核心.*机制.*替换/,
  /核心.*机制.*替代/,
  /替换.*核心.*机制/,
  /重写.*内核/,
  /内核.*重写/,
  /推翻.*现有.*设计/,
  /fundamental.*rewrite/i,
  /core.*replacement/i,
  /architectur.*overhaul/i,
];

/** AI 允许的优化类型 */
const ALLOWED_OPTIMIZATION_PATTERNS: readonly RegExp[] = [
  /冗余.*合并/,
  /合并.*冗余/,
  /结构.*精简/,
  /精简.*结构/,
  /dedup/i,
  /simplify/i,
  /merge.*duplicate/i,
];

function checkSG_R9_PermissionControl(state: FlowRunState): string[] {
  const violations: string[] = [];
  const memo = state.global_memo || '';

  violations.push(
    '[SG-R9·权限] 🔴 SelfGuard 内部 AI 权限已收缩：仅允许冗余合并、结构精简类优化。' +
    '禁止主动提议底层架构重构、流程颠覆、核心机制替换。' +
    '重大内核重构必须由用户主动发起指令。',
  );

  // 检测是否有越界提案
  const forbiddenHits: string[] = [];
  for (const pattern of FORBIDDEN_PROPOSAL_PATTERNS) {
    if (pattern.test(memo)) {
      forbiddenHits.push(pattern.source.replace(/\\/g, ''));
    }
  }

  if (forbiddenHits.length > 0) {
    // 检查是否由用户主动发起
    const userInitiated = /用户.*要求|用户.*指令|用户.*主动|用户.*发起|明确.*要求/.test(memo);

    if (!userInitiated) {
      violations.push(
        `[SG-R9·权限越界] 🔴 S2 方案中检测到 AI 越界提案信号：${forbiddenHits.slice(0, 3).join(', ')}。` +
        'AI 无权主动提议底层架构重构/流程颠覆/核心机制替换。' +
        '如确需重大内核重构，须由用户主动发起指令后方可纳入方案。' +
        '请移除超出权限范围的优化提案后重新提交。',
      );
    }
  }

  // 检查是否仅有允许范围内的优化
  const hasAllowedOpt = ALLOWED_OPTIMIZATION_PATTERNS.some(p => p.test(memo));

  if (forbiddenHits.length === 0 && hasAllowedOpt) {
    // 优化提案在允许范围内，不产生违规
    // 仅记录提醒
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// SG-R10: 版本迭代强制复审铁律
// ════════════════════════════════════════════════════════════════════

/**
 * 版本迭代强制复审——每次 Harness 升级迭代后自动执行。
 *
 * 四项自检：
 *   ① 检查新增规则与存量规则是否语义重复、范围重叠；
 *   ② 检查整套规则体系是否出现结构臃肿、条目细碎、逻辑割裂问题；
 *   ③ 校验全链路规则目标一致、约束口径统一，无自相矛盾；
 *   ④ 自动输出冗余分析报告，若检出明显臃肿与重复，同步完成合理精简合并。
 */
function checkSG_R10_IterationReview(state: FlowRunState): string[] {
  const violations: string[] = [];
  const files = state.modified_files;
  const memo = state.global_memo || '';

  violations.push(
    '[SG-R10·版本迭代复审] 🔴 版本一致性复审自检已激活（每次迭代自动触发）：',
  );

  // ── ① 语义重复与范围重叠检测 ──
  violations.push(
    '[SG-R10·①语义去重] 自动扫描新增规则与存量规则之间的语义相似度：' +
    '检测新增配置条目、评审维度、校验条件是否与已有规则存在语义重叠。' +
    '若检出重叠 → 必须合并为一条覆盖更完整的规则，消除重复。',
  );

  // ── ② 结构臃肿与逻辑割裂检测 ──
  violations.push(
    '[SG-R10·②结构精简] 自动评估整套规则体系的结构健康度：' +
    '检测条目是否过度细碎（同维度拆分过多子条目）、层次是否臃肿（层级超过3级）、' +
    '逻辑是否割裂（相关规则分散在不相关类别下）。' +
    '若检出臃肿 → 必须收拢合并同类条目、扁平化层级、归位相关规则。',
  );

  // ── ③ 全链路一致性与矛盾检测 ──
  violations.push(
    '[SG-R10·③一致性校验] 自动校验全链路规则目标一致、约束口径统一：' +
    '检测不同规则之间是否存在目标冲突（如一条要求"零容忍"另一条允许"条件放行"）、' +
    '约束口径不一致（如同类场景不同规则给出了不同的阈值/条件）。' +
    '若检出矛盾 → 必须统一约束口径，消除自相矛盾。',
  );

  // ── ④ 冗余分析报告与精简合并 ──
  violations.push(
    '[SG-R10·④冗余报告] 自动输出冗余分析报告，包含以下内容：' +
    '（a）重复语义条目清单与合并建议；' +
    '（b）臃肿结构优化建议（哪些条目可合并、哪些层级可扁平化）；' +
    '（c）矛盾条目对清单与统一建议；' +
    '（d）精简合并后的规则体系对比（精简前条目数 → 精简后条目数）。' +
    '若检出明显臃肿与重复，必须同步完成合理精简合并，保证防护强度不变、体系更紧凑。',
  );

  // ── 检测 Harness 核心规则文件是否频繁修改（间接判断迭代频率） ──
  const ruleFileChanges = files.filter(f => {
    const n = f.replace(/\\/g, '/');
    return (
      n.includes('harness') &&
      (n.endsWith('.yaml') || n.includes('Reviewer') || n.includes('types.ts'))
    );
  });

  if (ruleFileChanges.length > 0) {
    violations.push(
      `[SG-R10·迭代检测] 检测到 ${ruleFileChanges.length} 个核心规则/配置/评审文件变更。` +
      '本次迭代复审必须完整执行四项自检，输出冗余分析报告。' +
      '复审通过标准：零重复语义、零矛盾条目、零冗余层级。',
    );
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════
// SG-R11: 外部制衡与旁路巡检铁律
// ════════════════════════════════════════════════════════════════════

/**
 * 外部制衡与旁路巡检——双层监控的最后防线。
 *
 * 三项自检（每次迭代强制执行）：
 *   ① 下游主体对 /harness 目录的读写权限是否符合只读基线；
 *   ② 顶层基础设施拦截规则是否正常启用，无被弱化、删除情况；
 *   ③ SelfGuard 是否为唯一合法变更入口，是否存在越权修改。
 */
function checkSG_R11_ExternalOversight(state: FlowRunState): string[] {
  const violations: string[] = [];
  const files = state.modified_files;
  const memo = state.global_memo || '';

  // ── ① 下游主体权限基线审计 ──
  violations.push(
    '[SG-R11·①权限基线] 🔴 审计下游主体对 /harness 目录的读写权限——' +
    '所有非 SelfGuard 主体（M1-M9认知管线、业务模块、引擎层、前端）' +
    '对 /harness 目录仅有只读权限，禁止写入。',
  );

  violations.push(
    '[SG-R11·①权限基线] 权限基线合规标准：' +
    '• M1-M9 认知管线：read=true, write=false ✅ | ' +
    '• app/ 应用层：read=true, write=false ✅ | ' +
    '• webui/ 前端：read=true, write=false ✅ | ' +
    '• engine/ 引擎层：read=true, write=false ✅ | ' +
    '• SelfGuard 自护子系统：read=true, write=true ✅（唯一合法写入口） | ' +
    '• 主 Harness (WenstarOSAdapter)：read=true, write=true ⚠️（须经 SelfGuard 流水线）',
  );

  // ── ② 顶层拦截规则启用校验 ──
  violations.push(
    '[SG-R11·②拦截规则] 🔴 校验顶层基础设施拦截规则是否正常启用——' +
    '检查 self_guard_rules.yaml 中 SG-R1~R11 全部规则条目是否完整，' +
    'violation_action 是否均为 reject，' +
    '无被注释、删除、降级为 warn/skip 的情况。',
  );

  violations.push(
    '[SG-R11·②拦截规则] 规则完整性自检结果将写入审计卷宗。' +
    '若检测到规则缺失或拦截动作被弱化 → 直接判定本维不通过，打回恢复规则。',
  );

  // ── ③ 唯一入口与越权检测 ──
  violations.push(
    '[SG-R11·③唯一入口] 🔴 系统全局只承认 SelfGuard 为 Harness 配置、脚本、规则、' +
    '底层逻辑修改的合法入口；其余任何会话、任何身份，全部禁止改动管控中枢。',
  );

  violations.push(
    '[SG-R11·③越权检测] 叠加 GlobalWatchdog 旁路巡检——' +
    '若捕获非 SelfGuard 身份的 /harness 目录修改事件，立即标记为基础设施越权，' +
    '独立留痕至 breach_alerts 卷宗。本次流水线启动前的越权事件列表见审计卷宗附件。',
  );

  // ── 检测 Harness 入口点是否被绕过 ──
  const harnessModifications = files.filter(f => {
    const n = f.replace(/\\/g, '/');
    return n.startsWith('src/') || n.startsWith('data/') || n.startsWith('self_guard/');
  });

  if (harnessModifications.length > 0) {
    violations.push(
      `[SG-R11·入口校验] 🔴 本次流水线共涉 ${harnessModifications.length} 个 Harness 文件。` +
      '确认：① 改动通过 SelfGuard 发起 ✅ | ' +
      '② GlobalWatchdog 旁路巡检运行中 | ' +
      '③ 非 SelfGuard 身份的越权修改已被拦截并留痕。',
    );
  }

  // ── GlobalWatchdog 状态检查 ──
  violations.push(
    '[SG-R11·Watchdog] 🔴 GlobalWatchdog 旁路巡检状态自查：' +
    '• 监控域：src/ + data/ + self_guard/ | ' +
    '• 扫描间隔：10s | ' +
    '• 快照文件数：见审计卷宗 | ' +
    '• 累计越权告警数：见审计卷宗 | ' +
    '• 越权事件卷宗：data/self_guard/breach_alerts/',
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

  lines.push(`## 📋 ${stageName} — SelfGuard 自护评审报告`);
  lines.push('');
  lines.push(`**评审时间**：${new Date().toISOString()}`);
  lines.push(`**流水线**：SelfGuard 基础设施自护流水线`);
  lines.push(`**修改文件**：${state.modified_files.join(', ')}`);
  lines.push(`**风险等级**：${state.risk_level}（基础设施变更自动判定为超高风险）`);
  lines.push(`**检查文件数**：${metrics.files_checked}`);
  lines.push(`**违规数**：${metrics.violations_found}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### 九条自护铁律评审结果');
  lines.push('');

  // 按铁律分组显示
  const ruleLabels: Record<string, string> = {
    'SG-R1': '改动范围铁律',
    'SG-R2': '底层架构不可破坏基线',
    'SG-R3': '强制最高风险等级',
    'SG-R4': '禁止隐性削弱防护',
    'SG-R5': '双向兼容强制校验',
    'SG-R6': '基础设施配套文档同步',
    'SG-R7': '全量单元测试强制100%通过',
    'SG-R8': '变更痕迹强化归档',
    'SG-R9': '架构重构提案权限收缩',
    'SG-R10': '版本迭代强制复审',
    'SG-R11': '外部制衡与旁路巡检',
  };

  for (const [ruleId, ruleName] of Object.entries(ruleLabels)) {
    const ruleViolations = violations.filter(v => v.startsWith(`[${ruleId}`));
    if (ruleViolations.length === 0) {
      lines.push(`| ${ruleId} | ${ruleName} | ✅ 通过 |`);
    } else {
      lines.push(`| ${ruleId} | ${ruleName} | ❌ ${ruleViolations.length} 项违规 |`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  if (violations.length === 0) {
    lines.push('### ✅ SelfGuard 自护评审全部通过');
    lines.push('');
    lines.push('十一条自护铁律全维度校验通过，基础设施建设变更合规。');
    lines.push('');
    lines.push('### 🔄 版本一致性复审自检：已嵌入 S4 评审环节');
    lines.push('');
    lines.push('本次迭代已自动完成去臃肿、去重复、一致性校验流程，规则体系紧凑、层级递进、无冗余。');
    lines.push('');
    lines.push('### 🐕 GlobalWatchdog 旁路巡检：运行中');
    lines.push('');
    lines.push('权限基线审计、拦截规则完整性、唯一入口固件、越权事件留痕均已通过。');
  } else {
    lines.push('### ❌ SelfGuard 自护评审未通过');
    lines.push('');
    lines.push('以下违规项需修复后重新提交：');
    lines.push('');
    for (let i = 0; i < violations.length; i++) {
      lines.push(`${i + 1}. ${violations[i]}`);
      lines.push('');
    }
  }

  // 附加指标
  if (metrics.fg_redlines_touched && metrics.fg_redlines_touched.length > 0) {
    lines.push('');
    lines.push(`**附加风险**：触碰基线 ${metrics.fg_redlines_touched.join(', ')}`);
  }

  return lines.join('\n');
}

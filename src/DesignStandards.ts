/**
 * DesignStandards — 19条设计标准结构化定义
 * =============================================
 * 将 YAML 中的 10 条架构铁律 + 9 条落地规则转化为可评分的结构化标准。
 *
 * 每条标准定义：
 *   - standardId: DS-01 ~ DS-19
 *   - category: arch（架构铁律） / impl（落地规则）
 *   - weight: 评分权重（总和归一化）
 *   - mappedCKChecks: 关联的 CK-01~CK-08 检查
 *   - mappedReviewDimensions: 关联的 DelegateReviewer 11 维度
 *   - violationTagPatterns: DelegateReviewer 违规标签匹配正则
 */

/** 标准类别 */
export type StandardCategory = 'arch' | 'impl';

/** 单条设计标准 */
export interface DesignStandard {
  standardId: string;
  standardNumber: number;
  category: StandardCategory;
  title: string;
  fullText: string;
  weight: number;
  mappedCKChecks: string[];
  mappedReviewDimensions: string[];
  violationTagPatterns: RegExp[];
}

// ════════════════════════════════════════════════════════════════════
// 19 条设计标准
// ════════════════════════════════════════════════════════════════════

export const DESIGN_STANDARDS: readonly DesignStandard[] = [
  // ── 10 条架构铁律 (DS-01 ~ DS-10) ──
  {
    standardId: 'DS-01',
    standardNumber: 1,
    category: 'arch',
    title: 'M1-M9 九层管线无循环依赖',
    fullText: 'M1-M9九层认知管线无循环依赖，仅chat.ts顶层编排，禁止反向依赖',
    weight: 8,
    mappedCKChecks: ['CK-01'],
    mappedReviewDimensions: ['架构层级校验'],
    violationTagPatterns: [/\[架构\]/, /\[架构·chat\.ts\]/, /\[架构·PFC\]/, /M[1-9]/],
  },
  {
    standardId: 'DS-02',
    standardNumber: 2,
    category: 'arch',
    title: 'PFC 薄调度层',
    fullText: 'PFC 为唯一顶层上下文门控，chat.ts 仅做薄调度层，禁止堆砌业务逻辑',
    weight: 7,
    mappedCKChecks: ['CK-02'],
    mappedReviewDimensions: ['架构层级校验'],
    violationTagPatterns: [/\[架构·chat\.ts\]/, /chat\.ts.*薄调度/, /PFC.*上下文/],
  },
  {
    standardId: 'DS-03',
    standardNumber: 3,
    category: 'arch',
    title: 'FG 户籍角色扮演分支隔离',
    fullText: 'FamilyGraph.ts 为太虚境户籍唯一数据源，角色扮演使用独立分支 FG，禁止污染主库',
    weight: 8,
    mappedCKChecks: ['CK-03'],
    mappedReviewDimensions: ['FG&UUID专项校验', '耦合点专项校验'],
    violationTagPatterns: [/\[FG·红线/, /\[FG·/, /\[耦合·dossier\]/, /FamilyGraph/],
  },
  {
    standardId: 'DS-04',
    standardNumber: 4,
    category: 'arch',
    title: 'UUID 四层标注全链路',
    fullText: 'UUID(TXS-xxxx) 全链路 belong_entity_uuid 四层标注机制不可删减',
    weight: 7,
    mappedCKChecks: ['CK-04'],
    mappedReviewDimensions: ['FG&UUID专项校验'],
    violationTagPatterns: [/\[UUID\]/, /belong_entity_uuid/, /UUIDGatekeeper/],
  },
  {
    standardId: 'DS-05',
    standardNumber: 5,
    category: 'arch',
    title: 'SQLiteAdapter 唯一持久化通道',
    fullText: 'SQLiteAdapter 为唯一持久写入通道，修改存储逻辑必须校验防抖 save() 落盘',
    weight: 6,
    mappedCKChecks: ['CK-06'],
    mappedReviewDimensions: ['持久化安全校验'],
    violationTagPatterns: [/\[持久化\]/, /save\(\)/, /scheduleFlush/, /SQLiteAdapter/],
  },
  {
    standardId: 'DS-06',
    standardNumber: 6,
    category: 'arch',
    title: '12 处 _meetingEntityName 完整同步',
    fullText: '会晤模式 12 处判断点必须完整同步，禁止角色信息泄漏',
    weight: 7,
    mappedCKChecks: ['CK-05'],
    mappedReviewDimensions: ['耦合点专项校验'],
    violationTagPatterns: [/\[耦合·会晤\]/, /_meetingEntityName/, /会晤/],
  },
  {
    standardId: 'DS-07',
    standardNumber: 7,
    category: 'arch',
    title: '新旧角色扮演双管线同步',
    fullText: 'ROLEPLAY_STRUCTURED_ENABLED 两边兼容，新旧两套管线规则必须同步修改',
    weight: 5,
    mappedCKChecks: [],
    mappedReviewDimensions: ['FG&UUID专项校验'],
    violationTagPatterns: [/roleplay/i, /Roleplay/, /角色扮演.*管线/, /ROLEPLAY_STRUCTURED/],
  },
  {
    standardId: 'DS-08',
    standardNumber: 8,
    category: 'arch',
    title: '数据「只增不删」原则',
    fullText: '历史卷宗、记忆、黑钻记录禁止直接删除',
    weight: 4,
    mappedCKChecks: [],
    mappedReviewDimensions: ['持久化安全校验'],
    violationTagPatterns: [/\[持久化\]/, /删除.*记忆/, /删除.*卷宗/, /删除.*黑钻/],
  },
  {
    standardId: 'DS-09',
    standardNumber: 9,
    category: 'arch',
    title: 'chat.ts 22 段 finalKnowledgeText 注入顺序',
    fullText: '22 段注入顺序不可随意调换，避免 LLM 提示词逻辑错乱',
    weight: 5,
    mappedCKChecks: [],
    mappedReviewDimensions: ['耦合点专项校验'],
    violationTagPatterns: [/\[耦合·chat\.ts\]/, /22段/, /注入顺序/, /finalKnowledgeText/],
  },
  {
    standardId: 'DS-10',
    standardNumber: 10,
    category: 'arch',
    title: '高风险文件全量 import 评估',
    fullText: '高风险文件修改必须完整评估全量 import 依赖',
    weight: 4,
    mappedCKChecks: ['CK-07'],
    mappedReviewDimensions: ['风险兜底校验'],
    violationTagPatterns: [/\[兜底\]/, /import.*依赖/],
  },

  // ── 9 条落地规则 (DS-11 ~ DS-19) ──
  {
    standardId: 'DS-11',
    standardNumber: 11,
    category: 'impl',
    title: '顶层架构强制对齐',
    fullText: '所有代码变更必须严格对齐白皮书/蓝皮书整体分层架构与底层管线设计，架构越界直接拦截',
    weight: 6,
    mappedCKChecks: [],
    mappedReviewDimensions: ['架构层级校验', 'Hook埋点与自检合规校验'],
    violationTagPatterns: [/\[架构\]/, /\[自检\]/, /白皮书/, /蓝皮书/],
  },
  {
    standardId: 'DS-12',
    standardNumber: 12,
    category: 'impl',
    title: '变更范围围栏与三级风险管控',
    fullText: '受文件白名单约束，S1 风险扫描锁定爆炸半径，禁止跨无关模块扩散修改',
    weight: 5,
    mappedCKChecks: [],
    mappedReviewDimensions: ['风险兜底校验'],
    violationTagPatterns: [/\[兜底\]/, /硬编码/, /跨模块/],
  },
  {
    standardId: 'DS-13',
    standardNumber: 13,
    category: 'impl',
    title: '上下游依赖全域校验',
    fullText: '完整检索上下游调用链路、间接依赖、跨模块复用关系，杜绝单点修复破坏上下游',
    weight: 5,
    mappedCKChecks: [],
    mappedReviewDimensions: ['风险兜底校验', 'Hook埋点与自检合规校验'],
    violationTagPatterns: [/\[自检\]/, /维度缺失/],
  },
  {
    standardId: 'DS-14',
    standardNumber: 14,
    category: 'impl',
    title: '代码与文档双向同步',
    fullText: '架构/公共底层/核心链路修改必须同步更新注释、业务文档、白皮书对应段落',
    weight: 4,
    mappedCKChecks: [],
    mappedReviewDimensions: ['文档同步一致性校验'],
    violationTagPatterns: [/\[文档·/, /文档同步/],
  },
  {
    standardId: 'DS-15',
    standardNumber: 15,
    category: 'impl',
    title: '双层代码质量准入（静态质量+鲁棒加固）',
    fullText: '第一层：编译通过+类型合规+无死代码；第二层：空值校验+异常捕获+边界防护+日志埋点',
    weight: 7,
    mappedCKChecks: ['CK-08'],
    mappedReviewDimensions: ['基础静态质量校验', '缺陷修复强制鲁棒加固'],
    violationTagPatterns: [/\[静态质量·/, /\[鲁棒·/, /编译/, /类型.*错误/],
  },
  {
    standardId: 'DS-16',
    standardNumber: 16,
    category: 'impl',
    title: '共性/个性归类强制核验',
    fullText: 'S2 方案必须二选一明确归类，共性问题伪装个性→直接退回重构',
    weight: 5,
    mappedCKChecks: [],
    mappedReviewDimensions: ['归类真实性专项校验'],
    violationTagPatterns: [/\[归类·/, /共性.*个性/, /归类.*缺失/],
  },
  {
    standardId: 'DS-17',
    standardNumber: 17,
    category: 'impl',
    title: '全流程审计卷宗永久归档',
    fullText: '风险分析、两套方案、审批决策、代码变更、评审结果、测试报告全部归档永久可追溯',
    weight: 2,
    mappedCKChecks: [],
    mappedReviewDimensions: [],
    violationTagPatterns: [/审计/],
  },
  {
    standardId: 'DS-18',
    standardNumber: 18,
    category: 'impl',
    title: '核心链路 Hook 侦测与运行态自检',
    fullText: '九大核心链路必须植入标准侦测 Hook，六级全景健康体检，黄色/红色告警不得闭环',
    weight: 4,
    mappedCKChecks: [],
    mappedReviewDimensions: ['Hook埋点与自检合规校验'],
    violationTagPatterns: [/\[Hook·/, /侦测/, /体检/],
  },
  {
    standardId: 'DS-19',
    standardNumber: 19,
    category: 'impl',
    title: 'LLM 全局优化提案弹性机制',
    fullText: 'S2 必须并行输出两套方案，最终决策权归用户，禁止暗中夹带被否决的优化逻辑',
    weight: 3,
    mappedCKChecks: [],
    mappedReviewDimensions: ['优化提案落地真实性校验'],
    violationTagPatterns: [/\[提案·/, /优化提案/],
  },
  {
    standardId: 'DS-20',
    standardNumber: 20,
    category: 'impl',
    title: '回归安全（不破坏原有功能）',
    fullText: '任何修改不得引入新的测试失败、不得删除公共函数、不得超过 S2 声明的改动范围',
    weight: 6,
    mappedCKChecks: ['CK-09'],
    mappedReviewDimensions: [],
    violationTagPatterns: [/意外改动/, /遗漏改动/, /失败用例/, /函数删除/],
  },
  {
    standardId: 'DS-21',
    standardNumber: 21,
    category: 'impl',
    title: '修改目的达成度——必须解决声称要解决的问题',
    fullText: 'bug fix 必须阻断原始异常路径 + 附带测试；feature 必须新功能代码存在 + 有测试；refactor 必须行为完全保留',
    weight: 8,
    mappedCKChecks: ['CK-10'],
    mappedReviewDimensions: ['优化提案落地真实性校验'],
    violationTagPatterns: [/bug.*未修复/, /功能.*缺失/, /行为.*未保留/, /测试失败/, /无测试/],
  },
  {
    standardId: 'DS-22',
    standardNumber: 22,
    category: 'impl',
    title: '改动范围精确匹配——不多改也不少改',
    fullText: '实际改动必须精确匹配 S2 方案声明的改动范围，不可扩大也不可遗漏',
    weight: 5,
    mappedCKChecks: ['CK-09'],
    mappedReviewDimensions: [],
    violationTagPatterns: [/扩大改动/, /范围.*超出/, /遗漏/, /未声明/],
  },
  {
    standardId: 'DS-23',
    standardNumber: 23,
    category: 'impl',
    title: '举一反三：共性/个性系统性分析——共性问题必须全仓修复',
    fullText: '每处修改必须做全仓库同类模式扫描。共性问题必须一次性覆盖全仓修复；个性特例必须写明无同类场景的判定依据。',
    weight: 7,
    mappedCKChecks: ['CK-06.5'],
    mappedReviewDimensions: [],
    violationTagPatterns: [/共性.*问题/, /同类.*模式/, /全仓/, /一起修复/, /举一反三/],
  },
];

// ════════════════════════════════════════════════════════════════════
// 工具函数
// ════════════════════════════════════════════════════════════════════

/** 权重总和——用于归一化 */
export const TOTAL_WEIGHT: number = DESIGN_STANDARDS.reduce((sum, s) => sum + s.weight, 0);

/** 根据 ID 查找标准 */
export function getStandardById(id: string): DesignStandard | undefined {
  return DESIGN_STANDARDS.find(s => s.standardId === id);
}

/** 按类别筛选标准 */
export function getStandardsByCategory(category: StandardCategory): DesignStandard[] {
  return DESIGN_STANDARDS.filter(s => s.category === category);
}

/** 构建 CK 检查到设计标准的映射表 */
export function getCKToStandardMapping(): Map<string, DesignStandard[]> {
  const map = new Map<string, DesignStandard[]>();
  for (const s of DESIGN_STANDARDS) {
    for (const ck of s.mappedCKChecks) {
      const existing = map.get(ck) || [];
      existing.push(s);
      map.set(ck, existing);
    }
  }
  return map;
}

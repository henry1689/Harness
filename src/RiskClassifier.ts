/**
 * RiskClassifier — 文件风险自动分级
 * ======================================
 * 根据文件路径自动区分 🔴高风险 / 🟡中风险 / 🟢低风险。
 *
 * 高风险文件：内核核心文件，修改任一必需走全流程
 * 中风险文件：业务模块，修改需审核但部分 stage 可加速
 * 低风险文件：配置/类型/测试/工具，微小修改可走自由裸奔模式
 */

import type { RiskLevel } from './types.js';

/** 🔴 高风险文件——修改任何一项都强制走 S1-S7 全流程 */
const HIGH_RISK_FILES: ReadonlySet<string> = new Set([
  'src/webui/chat.ts',
  'src/m4/household/FamilyGraph.ts',
  'src/m2/SQLiteAdapter.ts',
  'src/webui/server.ts',
  'src/m5/DeepSeekLLMProvider.ts',
  'src/engine/tianquan/prefrontal/PrefrontalCortex.ts',
]);

/** 🟡 中风险模式——匹配以下路径模式 */
const MID_RISK_PATTERNS: readonly RegExp[] = [
  /^src\/m4\//,
  /^src\/m5\//,
  /^src\/app\/knowledge\/KnowledgeEngine/,
  /^src\/app\/vault\/VaultManager/,
  /^src\/m4\/household\/EntityMeeting/,
  /^src\/webui\/chat\/MeetingContextPipeline/,
  /^src\/m4\/household\/UUIDGatekeeper/,
  /^src\/m2\/ConversationDB/,
  /^src\/m2\/FusionStorageAdapter/,
  /^src\/m4\/household\/EntityContextBuilder/,
  /^src\/m5\/CandidateSelector/,
  /^src\/m6\/M6Orchestrator/,
  /^src\/m7\/M7Orchestrator/,
  /^src\/app\/ingestion\/ConversationIngestionService/,
  /^src\/app\/role\//,
  /^src\/app\/fg\//,
  /^src\/engine\//,
  /^src\/hooks\//,
];

/** 🟢 低风险前缀——微小修改可直接跳过流水线 */
const LOW_RISK_PREFIXES: readonly string[] = [
  'src/config/',
  'src/types/',
  'src/cli/',
  'src/__tests__/',
  'src/common/',
  'src/modules/',
  'src/adapter/',
];

/** 🟢 低风险后缀 */
const LOW_RISK_SUFFIXES: readonly string[] = [
  '.test.ts',
  '.spec.ts',
  '.json',
  '.md',
  '.sql',
];

/** 微小修改的检测模式——仅这些类型的改动视为 trivial */
const TRIVIAL_CHANGE_PATTERNS: readonly RegExp[] = [
  /typo/i,
  /拼写错误/,
  /注释/,
  /comment/i,
  /换行/,
  /格式/,
  /format/i,
  /文案/,
  /copy change/i,
  /微小/,
  /micro/i,
  /minor/i,
  /trivial/i,
];

// ════════════════════════════════════════════════════════════════════
// 公开 API
// ════════════════════════════════════════════════════════════════════

/** 对单个文件路径进行风险分级 */
export function classifyFile(filePath: string): RiskLevel {
  // 规范化路径
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');

  // 1. 精确匹配高风险文件
  if (HIGH_RISK_FILES.has(normalized)) return 'high';

  // 2. 模式匹配中风险
  for (const pattern of MID_RISK_PATTERNS) {
    if (pattern.test(normalized)) return 'mid';
  }

  // 3. 低风险前缀
  for (const prefix of LOW_RISK_PREFIXES) {
    if (normalized.startsWith(prefix)) return 'low';
  }

  // 4. 低风险后缀
  for (const suffix of LOW_RISK_SUFFIXES) {
    if (normalized.endsWith(suffix)) return 'low';
  }

  // 默认中风险（保守策略）
  return 'mid';
}

/** 对文件列表进行风险分级——取最高等级 */
export function classifyFiles(filePaths: string[]): RiskLevel {
  if (filePaths.length === 0) return 'low';

  let hasHigh = false;
  let hasMid = false;

  for (const fp of filePaths) {
    const level = classifyFile(fp);
    if (level === 'high') hasHigh = true;
    if (level === 'mid') hasMid = true;
  }

  if (hasHigh) return 'high';
  if (hasMid) return 'mid';
  return 'low';
}

/** 判断是否为微小修改（自由裸奔判定用） */
export function isTrivialChange(message: string, filePaths: string[]): boolean {
  // 所有文件必须是低风险
  if (filePaths.some(fp => classifyFile(fp) !== 'low')) {
    return false;
  }

  // 消息中包含微小修改特征
  const hasTrivialSignal = TRIVIAL_CHANGE_PATTERNS.some(p => p.test(message));
  if (!hasTrivialSignal) return false;

  // 文件数不超过 1 个
  if (filePaths.length > 1) return false;

  return true;
}

/** 获取高风险文件列表（用于审计/展示） */
export function getHighRiskFiles(): readonly string[] {
  return [...HIGH_RISK_FILES];
}

/** 判断文件是否在高风险列表中 */
export function isHighRisk(filePath: string): boolean {
  return HIGH_RISK_FILES.has(filePath.replace(/\\/g, '/').replace(/^\.\//, ''));
}

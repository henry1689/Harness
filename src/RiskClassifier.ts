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
import riskLists from './security/risk-lists.json';

// ════════════════════════════════════════════════════════════════════
// 🔴 2026-09-12（④ 清单合一）：分类清单已收敛到 src/security/risk-lists.json 单一真值源。
//
// 此前同一件事有四份互相分叉的硬编码清单：本文件 / mcp/server.ts::SENTINEL_HIGH_RISK /
// sentinel/sentinel-mcp-client.cjs::HIGH_RISK_FILES / data/risk-policy.json(无人读取)。
// 实测后果：同一文件走服务端判 low、走本地降级判 mid；而 harness 自己的文件更是一条
// high 都没有。现在三个消费者共用同一份数据 + 同一套匹配顺序。
//
// ⚠️ CJS 侧（sentinel-mcp-client.cjs）无法 import TypeScript，只能镜像同一份 JSON 与
// 同一套顺序 —— 改本文件的判定逻辑时，必须同步改那一处。
// ════════════════════════════════════════════════════════════════════

interface RiskLists {
  protected: string[];
  high_risk_files: string[];
  high_risk_prefixes: string[];
  low_risk_files: string[];
  low_risk_prefixes: string[];
  low_risk_suffixes: string[];
  low_risk_extensions: string[];
}
const LISTS = riskLists as unknown as RiskLists;

/** 完整风险分类（含 protected）。RiskLevel 联合类型不含 protected，对外仍映射为 high。 */
export type RiskClass = 'protected' | 'high' | 'mid' | 'low';

/**
 * 全仓唯一的风险分类实现。匹配顺序（与 risk-lists.json::_match_order 一致）：
 *   protected → low_risk_files(调试豁免) → high_risk_* → low_* → 默认 mid
 * sentinel/sentinel-mcp-client.cjs::classifyRisk 必须与此逐条一致。
 *
 * 注：本文件另有一层 MID_RISK_PATTERNS（见下），哨兵侧没有对应物 —— 它只覆盖
 * 「高危目录下的测试文件」，影响面是 test/spec 文件 mid↔low，属历史遗留的局部细化。
 */
export function classifyPath(filePath: string): RiskClass {
  const n = String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');

  for (const p of LISTS.protected) {
    if (n === p || n.startsWith(p) || n.includes('/' + p)) return 'protected';
  }
  for (const f of LISTS.low_risk_files) {
    if (n.includes(f)) return 'low';
  }
  for (const f of LISTS.high_risk_files) {
    if (n.includes(f)) return 'high';
  }
  for (const p of LISTS.high_risk_prefixes) {
    if (n.startsWith(p) || n.includes('/' + p)) return 'high';
  }

  // 中风险模式（本文件专有，见上方说明）——必须排在低风险判定之前，
  // 否则 src/m4/xxx.test.ts 会被下面的 .test.ts 后缀抢判为 low。
  for (const pattern of MID_RISK_PATTERNS) {
    if (pattern.test(n)) return 'mid';
  }

  for (const p of LISTS.low_risk_prefixes) {
    if (n.startsWith(p)) return 'low';
  }
  for (const s of LISTS.low_risk_suffixes) {
    if (n.endsWith(s)) return 'low';
  }
  for (const e of LISTS.low_risk_extensions) {
    if (n.endsWith(e)) return 'low';
  }

  return 'mid';
}

/** 是否为「绝对不可写」保护区文件（任何令牌都不可越过） */
export function isProtectedPath(filePath: string): boolean {
  return classifyPath(filePath) === 'protected';
}

/** 🟡 中风险模式——匹配以下路径模式 */
const MID_RISK_PATTERNS: readonly RegExp[] = [
  /^src\/m4\//,
  /^src\/m5\//,
  /^src\/app\/knowledge\/KnowledgeEngine/,
  /^src\/app\/vault\/VaultManager/,
  /^src\/m4\/household\/EntityMeeting/,
  /^src\/webui\/chat\/MeetingContextPipeline/,
  /^src\/webui\/chat\//,   // v2.9.2: chat 阶段管线（retrieval-stage/persistence-stage 等雷区）mid
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

// 🟢 低风险前缀/后缀已移入 risk-lists.json（LISTS.low_risk_*）。
// 🔴 2026-09-12：原 LOW_RISK_SUFFIXES 含 `.json` —— 已移除。它使一切 JSON 判为低风险，
// 而本仓策略/配置/豁免台账都是 .json（data/risk-policy.json 等）。配合 isTrivialChange，
// 一个 85 行的 data/risk-policy.json + 「修正注释」这类文案即可开 free_mode 跳过整条流水线
// （free_mode 不签发令牌，故最终被哨兵以 protected 拦下，但判定本身是错的）。
// 同时它与哨兵的 .json→mid 判定分歧。现统一为：.json 不是低风险。

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

/**
 * 对单个文件路径进行风险分级。
 * 委托给 classifyPath（单一真值源）；RiskLevel 不含 protected，故映射为 high（fail-closed）。
 */
export function classifyFile(filePath: string): RiskLevel {
  const c = classifyPath(filePath);
  return c === 'protected' ? 'high' : c;
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

/** 判断是否为微小修改（自由裸奔判定用）。
 *  P6-FIX: 增加项目根目录参数，对目标文件做实际大小检查，
 *  防止 Agent 声称 "fix typo" 但实际修改大文件的绕过。
 */
export function isTrivialChange(message: string, filePaths: string[], projectRoot?: string): boolean {
  // 所有文件必须是低风险
  if (filePaths.some(fp => classifyFile(fp) !== 'low')) {
    return false;
  }

  // 消息中包含微小修改特征
  const hasTrivialSignal = TRIVIAL_CHANGE_PATTERNS.some(p => p.test(message));
  if (!hasTrivialSignal) return false;

  // 文件数不超过 1 个
  if (filePaths.length > 1) return false;

  // P6-FIX: 检查文件实际大小，超过阈值的文件不可能是"微小修改"
  const MAX_TRIVIAL_LINES = 200;
  if (projectRoot && filePaths.length === 1) {
    try {
      const { readFileSync } = require('node:fs');
      const { join } = require('node:path');
      const content = readFileSync(join(projectRoot, filePaths[0]), 'utf-8');
      const lineCount = content.split('\n').length;
      if (lineCount > MAX_TRIVIAL_LINES) {
        return false; // 大文件不能走 free mode
      }
    } catch (_) {
      // 文件不存在或不可读 → 不允许 free mode（保守）
      return false;
    }
  }

  return true;
}

/** 获取高风险文件列表（用于审计/展示）——来自单一真值源 */
export function getHighRiskFiles(): readonly string[] {
  return [...LISTS.high_risk_files];
}

/** 获取高风险目录前缀列表 */
export function getHighRiskPrefixes(): readonly string[] {
  return [...LISTS.high_risk_prefixes];
}

/**
 * 判断文件是否为高风险。
 * 语义：匹配 risk-lists.json 的 high_risk_files/prefixes，且未被调试豁免(low_risk_files)
 * 或保护区(protected)覆盖 —— 与 classifyPath 同序，避免出现「classifyFile 说 low 但
 * isHighRisk 说 true」这类自相矛盾。
 */
export function isHighRisk(filePath: string): boolean {
  return classifyPath(filePath) === 'high';
}

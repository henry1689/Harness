/**
 * risk-policy-loader.cjs — Harness 统一风险策略加载器 (P7-A)
 * ============================================================
 * 所有防线组件（PreToolUse / Sentinel / Git Hook）从此模块加载
 * data/risk-policy.json，替代各自的硬编码列表。
 *
 * 设计原则:
 *   - 缓存加载（进程中仅解析一次 JSON）
 *   - 同步接口（所有调用方均为 CJS 同步流程）
 *   - 回退：JSON 文件不存在时返回内嵌的保守默认值（fail-safe）
 *
 * 使用:
 *   const { loadRiskPolicy } = require('./risk-policy-loader.cjs');
 *   const policy = loadRiskPolicy(__dirname);
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** @type {object|null} 缓存 */
let _cache = null;

/**
 * 返回保守的默认策略（risk-policy.json 不存在时的回退）。
 * 默认策略将几乎所有 src/ 视为高风险 —— fail-safe 原则。
 */
function defaultPolicy() {
  return {
    protected_paths: [
      '.claude/settings.json',
      '.claude/harness',
      '.claude/workflows',
      '.claude/hooks',
    ],
    high_risk_files: [
      'src/webui/chat.ts',
      'src/webui/server.ts',
      'src/m2/SQLiteAdapter.ts',
      'src/m4/household/FamilyGraph.ts',
      'src/m5/DeepSeekLLMProvider.ts',
      'src/engine/tianquan/prefrontal/PrefrontalCortex.ts',
    ],
    high_risk_dirs: [
      'src/m2/', 'src/m4/', 'src/m5/', 'src/engine/', 'src/core/',
      'src/app/knowledge/', 'src/app/role/', 'src/app/fg/', 'src/hooks/',
    ],
    harness_self_protect: [
      'src/FlowEngine.ts', 'src/StageRunner.ts', 'src/GateController.ts',
      'src/ConvergenceGate.ts', 'src/main_harness_checker.ts',
      'mcp/', 'sentinel/', 'scripts/harness-gate.cjs',
      'scripts/defense-health-check.cjs', 'data/flows/',
    ],
    low_risk_prefixes: [
      'src/config/', 'src/types/', 'src/cli/', 'src/__tests__/',
      'src/common/', 'src/app/tools/', 'src/app/utils/',
      'src/app/shared/', 'src/app/__tests__/',
    ],
    low_risk_suffixes: ['.test.ts', '.spec.ts', '.d.ts'],
    low_risk_extensions: ['.json', '.md', '.sql', '.yaml', '.yml', '.css', '.html', '.svg', '.txt'],
    ignore_dirs: ['node_modules', '__tests__', '.git', 'dist'],
  };
}

/**
 * 加载统一风险策略。
 * @param {string} callerDir - 调用方的 __dirname（用于解析 JSON 路径）
 * @returns {object} 解析后的策略对象
 */
function loadRiskPolicy(callerDir) {
  if (_cache) return _cache;

  // 从调用方目录向上查找 data/risk-policy.json
  const jsonPath = path.resolve(callerDir, '..', 'data', 'risk-policy.json');

  try {
    if (fs.existsSync(jsonPath)) {
      const raw = fs.readFileSync(jsonPath, 'utf-8');
      _cache = JSON.parse(raw);
      console.error('[risk-policy] ✅ 已加载统一风险策略: ' + jsonPath);
      return _cache;
    }
  } catch (err) {
    console.error('[risk-policy] ⚠️ 加载失败，使用保守默认策略: ' + err.message);
  }

  _cache = defaultPolicy();
  console.error('[risk-policy] ⚠️ risk-policy.json 未找到，使用 fail-safe 默认策略');
  return _cache;
}

/**
 * 清空缓存（测试用）。
 */
function clearRiskPolicyCache() {
  _cache = null;
}

/**
 * 判断路径是否命中高风险目录（递归匹配）。
 * @param {string} filePath - 标准化后的路径（使用 / 分隔符）
 * @param {string[]} highRiskDirs - 高风险目录列表
 * @returns {boolean}
 */
function isHighRiskDir(filePath, highRiskDirs) {
  const n = filePath.replace(/\\/g, '/');
  for (const d of highRiskDirs) {
    const dp = d.replace(/\\/g, '/');
    if (n.startsWith(dp)) return true;
  }
  return false;
}

/**
 * 判断路径是否为低风险。
 * @param {string} filePath
 * @param {object} policy
 * @returns {boolean}
 */
function isLowRisk(filePath, policy) {
  const n = filePath.replace(/\\/g, '/');
  for (const ext of policy.low_risk_extensions || []) {
    if (n.endsWith(ext)) return true;
  }
  for (const suf of policy.low_risk_suffixes || []) {
    if (n.indexOf(suf) !== -1) return true;
  }
  for (const pre of policy.low_risk_prefixes || []) {
    if (n.indexOf(pre) === 0) return true;
  }
  return false;
}

module.exports = { loadRiskPolicy, clearRiskPolicyCache, defaultPolicy, isHighRiskDir, isLowRisk };

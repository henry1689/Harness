/**
 * SelfGuardIntegration — 自护子系统路由分发器
 * ================================================
 * 根据变更文件作用域自动分流至 SelfGuard（基础设施）或返回主 Harness 信号。
 *
 * 🔴 独立项目版本：不依赖任何外部宿主项目。
 *
 * 使用方式：
 *   const result = await SelfGuardIntegration.dispatch(message, files, { projectRoot });
 *   if (result.routedTo === 'self_guard') { ...走 SelfGuard 流水线 }
 *   if (result.routedTo === 'main_harness') { ...转交宿主项目处理 }
 */

import type { FlowResult } from '../src/FlowEngine.js';
import { SelfGuardEngine } from './SelfGuardEngine.js';
import type { SelfGuardTriggerInput } from './SelfGuardEngine.js';

// ════════════════════════════════════════════════════════════════════
/** SelfGuard 接管域前缀 */
const SELF_GUARD_SCOPE = [
  'src/',
  'data/',
  'self_guard/',
];

// ════════════════════════════════════════════════════════════════════
let _selfGuardActive = true;

/** 路由分发结果 */
export interface DispatchResult {
  routedTo: 'self_guard' | 'main_harness' | 'none';
  reply: string;
  result?: FlowResult;
  success: boolean;
}

/** 分发选项 */
export interface DispatchOptions {
  projectRoot: string;
  files: string[];
  message: string;
}

export async function dispatch(opts: DispatchOptions): Promise<DispatchResult> {
  const { projectRoot, files, message } = opts;

  if (files.length === 0) {
    return { routedTo: 'none', reply: '⚠️ 未指定目标文件', success: false };
  }

  // 作用域分析
  const harnessFiles: string[] = [];
  const businessFiles: string[] = [];

  for (const f of files) {
    const n = f.replace(/\\/g, '/');
    if (SELF_GUARD_SCOPE.some(p => n.startsWith(p))) {
      harnessFiles.push(f);
    } else {
      businessFiles.push(f);
    }
  }

  // 混合变更 → 拒绝
  if (harnessFiles.length > 0 && businessFiles.length > 0) {
    return {
      routedTo: 'none',
      reply: `🚫 混合变更拒绝（基础设施+业务混合）。请拆分为独立提交。`,
      success: false,
    };
  }

  // 纯基础设施 → SelfGuard
  if (harnessFiles.length > 0) {
    if (!_selfGuardActive) {
      return { routedTo: 'self_guard', reply: '⚠️ SelfGuard 未激活', success: false };
    }

    const input: SelfGuardTriggerInput = { message, modifiedFiles: harnessFiles };
    const engine = new SelfGuardEngine({ projectRoot });
    const result = await engine.trigger(input);

    return {
      routedTo: 'self_guard',
      reply: result.success
        ? `🛡️ SelfGuard 通过 ✅ (${result.stage_results.length} 阶段)`
        : `🛡️ SelfGuard 未通过 ❌ — ${result.end_reason}`,
      result,
      success: result.success,
    };
  }

  // 纯业务 → 转交宿主项目主 Harness
  return {
    routedTo: 'main_harness',
    reply: '→ 转交主 Harness 业务流水线',
    success: true,
  };
}

export function isSelfGuardActive(): boolean { return _selfGuardActive; }
export function setSelfGuardActive(active: boolean): void { _selfGuardActive = active; }

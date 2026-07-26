/**
 * DualChannelSignal — 双通道信号编解码
 * ========================================
 * machine_signal（结构化 JSON → 引擎 Gate 消费）与
 * human_report（Markdown 文本 → 用户可见）的物理隔离层。
 *
 * 核心设计：
 *   - 子 Agent 输出必须同时包含两个独立字段
 *   - encodeMachineSignal / encodeHumanReport 编码
 *   - decode / validate 解码并校验完整性
 *   - machine_signal 绝不被拼接到 human_report 中展示
 */

import type { MachineSignal, MachineSignalMetrics, StageOutput } from './types.js';

// ════════════════════════════════════════════════════════════════════
// 工厂函数 — 构造标准 signal
// ════════════════════════════════════════════════════════════════════

/** 构造"通过"的 machine_signal */
export function passSignal(metrics?: MachineSignalMetrics): MachineSignal {
  return {
    passed: true,
    risk_level: 'low',
    reject_reason: [],
    metrics,
  };
}

/** 构造"驳回"的 machine_signal */
export function rejectSignal(reasons: string[], riskLevel: MachineSignal['risk_level'] = 'high', metrics?: MachineSignalMetrics): MachineSignal {
  return {
    passed: false,
    risk_level: riskLevel,
    reject_reason: reasons,
    metrics,
  };
}

/** 构造完整的双通道 StageOutput */
export function makeStageOutput(
  machineSignal: MachineSignal,
  humanReport: string,
): StageOutput {
  return {
    machine_signal: machineSignal,
    human_report: humanReport,
  };
}

// ════════════════════════════════════════════════════════════════════
// 编解码
// ════════════════════════════════════════════════════════════════════

/**
 * 将 machine_signal 编码为 JSON 字符串（供子 Agent 传输）。
 * 🔴 此 JSON 不应展示给用户。
 */
export function encodeMachineSignal(signal: MachineSignal): string {
  return JSON.stringify(signal, null, 0);
}

/**
 * 从 JSON 字符串解码 machine_signal。
 * @throws 格式无效
 */
export function decodeMachineSignal(json: string): MachineSignal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('[DualChannelSignal] machine_signal JSON 解析失败');
  }

  return validateMachineSignal(parsed);
}

/**
 * 校验并标准化 machine_signal 对象。
 * 缺失字段自动填充默认值。
 */
export function validateMachineSignal(raw: unknown): MachineSignal {
  if (!raw || typeof raw !== 'object') {
    throw new Error('[DualChannelSignal] machine_signal 必须是对象');
  }

  const obj = raw as Record<string, unknown>;

  return {
    passed: Boolean(obj.passed),
    risk_level: validateRiskLevel(obj.risk_level),
    reject_reason: Array.isArray(obj.reject_reason)
      ? obj.reject_reason.filter((r): r is string => typeof r === 'string')
      : [],
    metrics: obj.metrics && typeof obj.metrics === 'object'
      ? obj.metrics as MachineSignalMetrics
      : undefined,
  };
}

/** 校验双通道输出完整性 */
export function validateStageOutput(output: unknown): StageOutput {
  if (!output || typeof output !== 'object') {
    throw new Error('[DualChannelSignal] StageOutput 必须是对象');
  }

  const obj = output as Record<string, unknown>;

  if (!obj.machine_signal) {
    throw new Error('[DualChannelSignal] 缺少 machine_signal 字段');
  }
  if (typeof obj.human_report !== 'string') {
    throw new Error('[DualChannelSignal] human_report 必须是字符串');
  }

  return {
    machine_signal: validateMachineSignal(obj.machine_signal),
    human_report: obj.human_report,
  };
}

// ════════════════════════════════════════════════════════════════════
// human_report 格式化工具
// ════════════════════════════════════════════════════════════════════

/**
 * 将 human_report 包装为标准 Markdown 格式。
 * 不包含任何 machine_signal 数据，确保展示层纯净。
 */
export function formatHumanReport(
  stageName: string,
  content: string,
  extra?: { summary?: string; warnings?: string[] },
): string {
  const lines: string[] = [];

  lines.push(`## 📋 ${stageName} — 评审报告`);
  lines.push('');

  if (extra?.summary) {
    lines.push(`**结论**：${extra.summary}`);
    lines.push('');
  }

  lines.push(content);

  if (extra?.warnings && extra.warnings.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('### ⚠️ 注意事项');
    for (const w of extra.warnings) {
      lines.push(`- ${w}`);
    }
  }

  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════
// 内部工具
// ════════════════════════════════════════════════════════════════════

function validateRiskLevel(raw: unknown): MachineSignal['risk_level'] {
  if (raw === 'high' || raw === 'mid' || raw === 'low') return raw;
  return 'mid'; // 默认
}

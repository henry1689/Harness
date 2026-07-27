/**
 * FlowConfigLoader — YAML 流水线配置加载器
 * =============================================
 * 从 YAML 文件加载 Flow 配置并校验完整性。
 * 使用简单行解析（零外部依赖），避免引入 js-yaml。
 *
 * 支持：
 *   - 基本 YAML 结构：key: value、列表项 "- "、多行字符串 "|"
 *   - 配置缓存（同进程内不重复读取）
 *   - 必填字段校验，缺失时抛出 FlowConfigError
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { FlowConfig, StageConfig, GateType, RunnerMode, WhitelistKey } from './types.js';
import { FlowConfigError } from './types.js';

/** 流量配置搜索路径 */
const FLOWS_DIR = resolve(join(import.meta.dirname ?? __dirname, '..', 'data', 'flows'));

/** 单例缓存 */
const _configCache = new Map<string, FlowConfig>();

/** 必填的 Stage 字段 */
const REQUIRED_STAGE_FIELDS = ['stage_id', 'stage_name', 'work_manual', 'gate_type', 'runner_mode'] as const;

/** 有效的 gate_type 枚举 */
const VALID_GATE_TYPES: GateType[] = ['auto', 'human', 'condition'];

/** 有效的 runner_mode 枚举 */
const VALID_RUNNER_MODES: RunnerMode[] = ['local', 'delegate'];

/** 有效的工具白名单键 */
const VALID_WHITELIST_KEYS: readonly string[] = [
  'read_file', 'write_file', 'delete_file', 'run_command',
  'run_db_script', 'truncate_db', 'run_modify_script',
  'search_code', 'grep_import', 'list_dir', 'run_cli_check',
];

// ════════════════════════════════════════════════════════════════════
// 公开 API
// ════════════════════════════════════════════════════════════════════

/**
 * 从文件名加载 Flow 配置。
 * @param flowFileName — YAML 文件名（不含路径），如 "wenstaros_core_repair_flow.yaml"
 * @returns 校验通过的 FlowConfig
 * @throws FlowConfigError 配置缺失/字段无效
 */
export function loadFlowConfig(flowFileName: string): FlowConfig {
  // 缓存命中
  if (_configCache.has(flowFileName)) {
    return _configCache.get(flowFileName)!;
  }

  const filePath = join(FLOWS_DIR, flowFileName);
  if (!existsSync(filePath)) {
    throw new FlowConfigError(`配置文件不存在: ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw);
  const config = validateFlowConfig(parsed as Record<string, unknown>, flowFileName);

  _configCache.set(flowFileName, config);
  console.log(`[Harness::ConfigLoader] 已加载: ${flowFileName} (${config.stages.length} 个阶段)`);
  return config;
}

/** 清除配置缓存（测试用） */
export function clearConfigCache(): void {
  _configCache.clear();
}

// ════════════════════════════════════════════════════════════════════
// 简单 YAML 行解析器（仅支持本项目 YAML 配置格式）
// ════════════════════════════════════════════════════════════════════

function parseYaml(raw: string): unknown {
  const lines = raw.split('\n');
  const root: Record<string, unknown> = {};
  const stages: unknown[] = [];
  let currentStage: Record<string, unknown> | null = null;
  let currentWhitelist: Record<string, boolean> | null = null;
  let inGlobalConstraint = false;
  let globalConstraintLines: string[] = [];
  let inImplRules = false;
  let implRulesLines: string[] = [];
  let inWorkManual = false;
  let workManualLines: string[] = [];
  let currentKey = '';

  function flushMultiLineBlocks(): void {
    if (inGlobalConstraint) {
      inGlobalConstraint = false;
      root['global_arch_constraint'] = globalConstraintLines.join('\n').trim();
      globalConstraintLines = [];
    }
    if (inImplRules) {
      inImplRules = false;
      root['global_implementation_rules'] = implRulesLines.join('\n').trim();
      implRulesLines = [];
    }
  }

  function flushStage(): void {
    if (!currentStage) return;
    if (workManualLines.length > 0) {
      currentStage['work_manual'] = workManualLines.join('\n').trim();
      workManualLines = [];
      inWorkManual = false;
    }
    stages.push(currentStage);
    currentStage = null;
    currentWhitelist = null;
  }

  function parseSimpleValue(val: string): string | number | boolean {
    const trimmed = val.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'END') return trimmed;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    // 去掉可能的前后引号
    return trimmed.replace(/^['"](.*)['"]$/, '$1');
  }

  for (const line of lines) {
    // 🔴 多行块内不跳过任何内容（包括 # 开头的行和空行）
    const inAnyBlock = inGlobalConstraint || inImplRules || inWorkManual;

    // 跳过注释行（仅非多行块模式）
    if (!inAnyBlock && /^\s*#/.test(line)) continue;

    if (/^\s*$/.test(line)) {
      if (inGlobalConstraint) globalConstraintLines.push('');
      if (inImplRules) implRulesLines.push('');
      if (inWorkManual) workManualLines.push('');
      continue;
    }

    // 全局约束多行文本（global_arch_constraint）
    if (inGlobalConstraint) {
      // 检测下一个顶层字段，可能开始 global_implementation_rules
      const nextTopMatch = line.match(/^(\w[\w_]*):\s*(.*)/);
      if (nextTopMatch && nextTopMatch[1] !== 'global_arch_constraint') {
        inGlobalConstraint = false;
        root['global_arch_constraint'] = globalConstraintLines.join('\n').trim();
        globalConstraintLines = [];
        // 如果下一个正是 global_implementation_rules: |，进入该多行模式
        if (nextTopMatch[1] === 'global_implementation_rules' && nextTopMatch[2].trim() === '|') {
          inImplRules = true;
          implRulesLines = [];
          continue;
        }
        // 否则回退到正常解析
      } else if (!/^\w[\w_]*:/.test(line) && !/^stages:/.test(line) && !/^\s{2}-\s/.test(line)) {
        globalConstraintLines.push(line);
        continue;
      } else {
        // 遇到 stages: 或其他非顶层key，结束
        inGlobalConstraint = false;
        root['global_arch_constraint'] = globalConstraintLines.join('\n').trim();
        globalConstraintLines = [];
      }
    }

    // 落地规则多行文本（global_implementation_rules）
    if (inImplRules) {
      // 仅顶层 key 或 stages: 或 stage 列表项（2空格+stage_id:）终止
      if (/^\w[\w_]*:/.test(line) || /^stages:/.test(line) || /^\s{2}-\s+stage_id:/.test(line)) {
        inImplRules = false;
        root['global_implementation_rules'] = implRulesLines.join('\n').trim();
        implRulesLines = [];
      } else {
        implRulesLines.push(line);
        continue;
      }
    }

    // work_manual 多行文本
    if (inWorkManual) {
      if (/^\s{4}\w[\w_]*:/.test(line) || /^\s{4}- stage_id:/.test(line) || /^\s{2}- stage_id:/.test(line)) {
        // 下一个字段或下一个 stage 开始
        inWorkManual = false;
        if (currentStage) {
          currentStage[currentKey] = workManualLines.join('\n').trim();
          workManualLines = [];
        }
        // 继续解析当前行
      } else {
        // 去掉缩进（4空格或2空格）
        workManualLines.push(line.replace(/^\s{6}/, '  ').replace(/^\s{4}/, ''));
        continue;
      }
    }

    // stages 列表开始
    if (/^stages:/.test(line)) {
      // stages 本身是一个顶层 key
      continue;
    }

    // 新的 stage 项开始
    if (/^\s{2}-\s*$/.test(line) || /^\s{2}-\s+stage_id:/.test(line)) {
      flushStage();
      currentStage = {};
      currentWhitelist = null;
      // 如果行内含 stage_id，解析它
      if (line.includes('stage_id:')) {
        const match = line.match(/stage_id:\s*(.+)/);
        if (match) currentStage['stage_id'] = match[1].trim();
      }
      continue;
    }

    // stage 内的字段
    if (currentStage !== null) {
      // tool_whitelist 开始
      if (/^\s{4}tool_whitelist:/.test(line)) {
        currentWhitelist = {};
        currentStage['tool_whitelist'] = currentWhitelist;
        continue;
      }

      // tool_whitelist 内的键值
      if (currentWhitelist !== null) {
        const twMatch = line.match(/^\s{6}(\w[\w_]*):\s*(.+)/);
        if (twMatch) {
          currentWhitelist[twMatch[1]] = twMatch[2].trim() === 'true';
          continue;
        }
        // tool_whitelist 结束（缩进变回 4 空格）
        if (/^\s{4}\w[\w_]*:/.test(line)) {
          currentWhitelist = null;
          // 继续解析
        } else {
          continue;
        }
      }

      // work_manual 多行文本开始
      const wmMatch = line.match(/^\s{4}work_manual:\s*(.*)/);
      if (wmMatch) {
        currentKey = 'work_manual';
        if (wmMatch[1].trim() === '|') {
          inWorkManual = true;
          workManualLines = [];
        } else if (wmMatch[1].trim()) {
          currentStage['work_manual'] = wmMatch[1].trim();
        }
        continue;
      }

      // stage 内普通键值
      const stageKvMatch = line.match(/^\s{4}(\w[\w_]*):\s*(.*)/);
      if (stageKvMatch) {
        const val = stageKvMatch[2].trim();
        if (val === '') {
          // 可能是多行值的开始
          continue;
        }
        currentStage[stageKvMatch[1]] = parseSimpleValue(val);
        continue;
      }

      continue;
    }

    // 顶层键值
    const topMatch = line.match(/^(\w[\w_]*):\s*(.*)/);
    if (topMatch) {
      const key = topMatch[1];
      const val = topMatch[2].trim();

      if (key === 'global_arch_constraint' && val === '|') {
        inGlobalConstraint = true;
        globalConstraintLines = [];
        continue;
      }
      if (key === 'global_implementation_rules' && val === '|') {
        inImplRules = true;
        implRulesLines = [];
        continue;
      }
      if (val === '') continue;

      root[key] = parseSimpleValue(val);
      continue;
    }
  }

  // 处理末尾残留
  flushMultiLineBlocks();
  flushStage();

  if (stages.length > 0) {
    root['stages'] = stages;
  }

  return root;
}

// ════════════════════════════════════════════════════════════════════
// 配置校验
// ════════════════════════════════════════════════════════════════════

function validateFlowConfig(raw: Record<string, unknown>, sourceFile: string): FlowConfig {
  // 顶层必填字段
  const requiredTop = ['flow_id', 'flow_name', 'version', 'max_jump_limit', 'stages'];
  for (const field of requiredTop) {
    if (raw[field] === undefined || raw[field] === null) {
      throw new FlowConfigError(`"${sourceFile}" 缺少顶层字段: ${field}`);
    }
  }

  if (raw.max_jump_limit !== undefined && (typeof raw.max_jump_limit !== 'number' || raw.max_jump_limit < 1)) {
    throw new FlowConfigError(`"${sourceFile}" max_jump_limit 必须 >= 1`);
  }

  const stages = raw.stages as Record<string, unknown>[];
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new FlowConfigError(`"${sourceFile}" stages 必须是非空数组`);
  }

  // 校验每个 stage
  const validatedStages: StageConfig[] = [];
  const stageIds = new Set<string>();

  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const idx = `stages[${i}]`;

    // 必填字段
    for (const field of REQUIRED_STAGE_FIELDS) {
      if (s[field] === undefined || s[field] === null || s[field] === '') {
        throw new FlowConfigError(`"${sourceFile}" ${idx} 缺少字段: ${field}`);
      }
    }

    const stage_id = String(s.stage_id);
    if (stageIds.has(stage_id)) {
      throw new FlowConfigError(`"${sourceFile}" ${idx} stage_id "${stage_id}" 重复`);
    }
    stageIds.add(stage_id);

    // gate_type 校验
    const gate_type = String(s.gate_type) as GateType;
    if (!VALID_GATE_TYPES.includes(gate_type)) {
      throw new FlowConfigError(`"${sourceFile}" ${idx} gate_type "${gate_type}" 无效，须为: ${VALID_GATE_TYPES.join('|')}`);
    }

    // runner_mode 校验
    const runner_mode = String(s.runner_mode) as RunnerMode;
    if (!VALID_RUNNER_MODES.includes(runner_mode)) {
      throw new FlowConfigError(`"${sourceFile}" ${idx} runner_mode "${runner_mode}" 无效，须为: ${VALID_RUNNER_MODES.join('|')}`);
    }

    // condition gate 必须有 next_stage_pass / next_stage_reject
    if (gate_type === 'condition') {
      if (!s.next_stage_pass || !s.next_stage_reject) {
        throw new FlowConfigError(`"${sourceFile}" ${idx} condition gate 必须定义 next_stage_pass 和 next_stage_reject`);
      }
    }

    // 工具白名单校验
    const whitelist = (s.tool_whitelist || {}) as Record<string, boolean>;
    const cleanWhitelist: Partial<Record<WhitelistKey, boolean>> = {};
    for (const [key, val] of Object.entries(whitelist)) {
      if (VALID_WHITELIST_KEYS.includes(key)) {
        cleanWhitelist[key as WhitelistKey] = Boolean(val);
      } else {
        console.warn(`[Harness::ConfigLoader] 忽略未知的 whitelist key: "${key}" (${sourceFile} ${idx})`);
      }
    }

    validatedStages.push({
      stage_id,
      stage_name: String(s.stage_name),
      work_manual: String(s.work_manual),
      tool_whitelist: cleanWhitelist,
      gate_type,
      next_stage: s.next_stage ? String(s.next_stage) : undefined,
      next_stage_pass: s.next_stage_pass ? String(s.next_stage_pass) : undefined,
      next_stage_reject: s.next_stage_reject ? String(s.next_stage_reject) : undefined,
      runner_mode,
      after_action: s.after_action as StageConfig['after_action'],
    });
  }

  return {
    flow_id: String(raw.flow_id),
    flow_name: String(raw.flow_name),
    version: String(raw.version),
    max_jump_limit: Number(raw.max_jump_limit),
    max_stage_retries: Number(raw.max_stage_retries || 5),
    max_s3_retries: Number(raw.max_s3_retries || 3),
    global_memo_key: String(raw.global_memo_key || `${raw.flow_id}_global_memo`),
    global_arch_constraint: String(raw.global_arch_constraint || ''),
    global_implementation_rules: String(raw.global_implementation_rules || ''),
    stages: validatedStages,
  };
}

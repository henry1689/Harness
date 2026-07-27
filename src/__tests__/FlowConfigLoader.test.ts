/**
 * Harness 引擎单元测试 — FlowConfigLoader
 * ===========================================
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loadFlowConfig, clearConfigCache } from '../FlowConfigLoader.js';
import { FlowConfigError } from '../types.js';

describe('FlowConfigLoader', () => {
  beforeEach(() => {
    clearConfigCache();
  });

  it('加载 wenstaros_core_repair_flow.yaml 并校验完整字段', () => {
    const config = loadFlowConfig('wenstaros_core_repair_flow.yaml');

    expect(config.flow_id).toBe('wenstaros_core_repair_flow');
    expect(config.version).toBe('2');  // YAML 2.0 → Number → String('2')
    expect(config.max_jump_limit).toBe(10);
    expect(config.stages).toHaveLength(7);

    // 验证 global_arch_constraint 被正确解析
    expect(config.global_arch_constraint.length).toBeGreaterThan(100);
    expect(config.global_arch_constraint).toContain('M1-M9九层认知管线');

    // 验证 global_implementation_rules 被正确解析（9条精简版规则）
    expect(config.global_implementation_rules.length).toBeGreaterThan(200);
    expect(config.global_implementation_rules).toContain('顶层架构强制对齐铁律');
    expect(config.global_implementation_rules).toContain('变更范围围栏与三级风险管控规则');
    expect(config.global_implementation_rules).toContain('上下游依赖全域校验规则');
    expect(config.global_implementation_rules).toContain('代码与文档双向同步规则');
    expect(config.global_implementation_rules).toContain('双层代码质量准入规则');
    expect(config.global_implementation_rules).toContain('基础静态质量门槛');
    expect(config.global_implementation_rules).toContain('缺陷修复强制鲁棒加固门槛');
    expect(config.global_implementation_rules).toContain('共性/个性归类强制核验规则');
    expect(config.global_implementation_rules).toContain('全流程审计卷宗永久归档规则');
    expect(config.global_implementation_rules).toContain('核心链路Hook侦测与运行态自检规则');
    expect(config.global_implementation_rules).toContain('LLM全局优化提案弹性机制');
    // S2 优化提案板块（维持不变）
    expect(config.stages[1].work_manual).toContain('全局架构优化提案');
    expect(config.stages[1].work_manual).toContain('原方案隐患评估');
    expect(config.stages[1].work_manual).toContain('全局优化替代方案');
    expect(config.stages[1].work_manual).toContain('用户审批');
  });

  it('验证 S1 阶段配置', () => {
    const config = loadFlowConfig('wenstaros_core_repair_flow.yaml');
    const s1 = config.stages[0];

    expect(s1.stage_id).toBe('S1_Problem_Analysis');
    expect(s1.gate_type).toBe('auto');
    expect(s1.runner_mode).toBe('local');
    expect(s1.next_stage).toBe('S2_Solution_Design');
    expect(s1.tool_whitelist.write_file).toBe(false);
    expect(s1.tool_whitelist.read_file).toBe(true);
  });

  it('验证 S2 方案模板包含归类比填板块', () => {
    const config = loadFlowConfig('wenstaros_core_repair_flow.yaml');
    const s2 = config.stages[1];

    expect(s2.stage_id).toBe('S2_Solution_Design');
    expect(s2.work_manual).toContain('本次修改归类');
    expect(s2.work_manual).toContain('二选一填写');
    expect(s2.work_manual).toContain('共性底层通用修复');
    expect(s2.work_manual).toContain('个性局部特例修改');
    expect(s2.work_manual).toContain('不允许空缺、模糊、省略');
  });

  it('验证 S4 条件门控配置', () => {
    const config = loadFlowConfig('wenstaros_core_repair_flow.yaml');
    const s4 = config.stages[3];

    expect(s4.stage_id).toBe('S4_Arch_Review');
    expect(s4.gate_type).toBe('condition');
    expect(s4.runner_mode).toBe('delegate');
    expect(s4.next_stage_pass).toBe('S5_Compile_Test');
    expect(s4.next_stage_reject).toBe('S3_Code_Implement');
    expect(s4.tool_whitelist.write_file).toBe(false);
    expect(s4.tool_whitelist.read_file).toBe(true);
  });

  it('验证 S7 最终阶段配置', () => {
    const config = loadFlowConfig('wenstaros_core_repair_flow.yaml');
    const s7 = config.stages[6];

    expect(s7.stage_id).toBe('S7_Change_Archive');
    expect(s7.gate_type).toBe('auto');
    expect(s7.next_stage).toBe('END');
  });

  it('配置加载使用缓存', () => {
    const config1 = loadFlowConfig('wenstaros_core_repair_flow.yaml');
    const config2 = loadFlowConfig('wenstaros_core_repair_flow.yaml');

    // 两次加载应返回同一个对象（缓存命中）
    expect(config1).toBe(config2);
  });

  it('不存在的配置文件抛出中文 FlowConfigError', () => {
    try {
      loadFlowConfig('non_existent_flow.yaml');
      // 不应到达这里
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(FlowConfigError);
      expect((err as Error).message).toContain('配置文件不存在');
    }
  });
});

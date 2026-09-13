/**
 * 风险清单合一(④) + S7-B 高风险禁 exemption 兜底(②) 回归测试
 * =================================================================
 * ① ④ 单一真值源：三个消费者对同一路径必须判出同一等级 —— 这是本次合一的全部意义。
 *    本测试直接把 TS 侧（RiskClassifier.classifyPath）与 CJS 侧
 *    （sentinel-mcp-client.classifyRisk）拉在一起做差分，任何一侧被改回硬编码都会失败。
 * ② ② S7-B：高风险改动 + S4.5<98 时 exemption 不再算数；非高风险路径的旧行为不变。
 *    以及 findExemptionIdForFiles 的三条收紧（未过期 / 用途匹配 / 覆盖最高风险文件）。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { classifyPath, classifyFile, isHighRisk, isProtectedPath, getHighRiskFiles } from '../RiskClassifier.js';
import { AUTO_GRANT_NEVER, isAutoGrantAllowed, checkAutoGrantScope } from '../security/flow-terminal-policy.js';
import { validateArchive, type S7ArchiveContext } from '../s7/S7ArchiveValidator.js';
import { findExemptionIdForFiles } from '../s7/s7AutoArchive.js';
import type { S7ArchivePayload } from '../schemas/s7-archive-payload.js';

const require_ = createRequire(import.meta.url);
const { classifyRisk: cjsClassifyRisk } = require_('../../sentinel/sentinel-mcp-client.cjs');

const TEST_EXEMPTIONS = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'test-exemptions-risk-gov.json',
);

// 🔴 测试数据清理：按精确路径删除，勿按时间窗（防误删用户并发数据）
function cleanupTestExemptions() {
  if (existsSync(TEST_EXEMPTIONS)) rmSync(TEST_EXEMPTIONS, { force: true });
}
afterAll(cleanupTestExemptions);

function writeExemptions(entries: Record<string, unknown>) {
  writeFileSync(TEST_EXEMPTIONS, JSON.stringify({ version: 1, exemptions: entries }, null, 2), 'utf-8');
}

// ════════════════════════════════════════════════════════════════════
// ④ 清单合一
// ════════════════════════════════════════════════════════════════════

describe('④ 风险清单单一真值源', () => {
  it('harness 自身的高风险文件不再全部落 mid —— 治理引擎核心判 high', () => {
    // 回归：合一之前 harness 自己的文件【一条 high 都没有】，①②两项因此无处落地
    for (const f of [
      'src/FlowEngine.ts', 'src/GateController.ts', 'src/ComplianceScorer.ts',
      'src/DelegateReviewer.ts', 'src/EvolutionEngine.ts', 'src/RiskClassifier.ts',
    ]) {
      expect(classifyPath(f), `${f} 应为 high`).toBe('high');
    }
  });

  it('防线控制面判 high（授权机制自身 / 哨兵 / MCP / 脚本 / 钩子 / 流水线定义）', () => {
    for (const f of [
      'src/security/flow-terminal-policy.ts',
      'sentinel/sentinel-service.cjs',
      'mcp/server.ts',
      'scripts/harness-gate.cjs',
      'data/flows/wenstaros_core_repair_flow.yaml',
      'data/exemptions.json',
    ]) {
      expect(classifyPath(f), `${f} 应为 high`).toBe('high');
    }
  });

  it('保护区绝对不可写，且清单文件保护自己（改清单 = 自我放行）', () => {
    for (const f of [
      'data/risk-policy.json',
      'src/security/risk-lists.json',
      '.claude/settings.json',
      '.claude/hooks/anything.cjs',
    ]) {
      expect(classifyPath(f), `${f} 应为 protected`).toBe('protected');
      expect(isProtectedPath(f)).toBe(true);
    }
    // RiskLevel 联合类型不含 protected → 对外映射为 high（fail-closed），绝不可降级为 low
    expect(classifyFile('data/risk-policy.json')).toBe('high');
    expect(classifyFile('src/security/risk-lists.json')).toBe('high');
  });

  it('🔴 回归：.json 不再是低风险（原后门：一切 JSON 免检即写，而策略/台账都是 .json）', () => {
    expect(classifyPath('data/some-config.json')).toBe('mid');
    expect(classifyPath('data/prompts/x.json')).toBe('mid');
    // 低风险扩展名只剩 .md / .sql
    expect(classifyPath('docs/readme.md')).toBe('low');
    expect(classifyPath('db/schema.sql')).toBe('low');
  });

  it('低风险仍按前缀/后缀判低（避免合一误伤正常流程）', () => {
    expect(classifyPath('src/config/x.ts')).toBe('low');
    expect(classifyPath('src/__tests__/foo.test.ts')).toBe('low');
    expect(classifyPath('src/some/deep/thing.spec.ts')).toBe('low');
  });

  it('🔴 差分：TS 侧与 CJS 侧对同一批路径判定必须完全一致（合一的核心断言）', () => {
    const paths = [
      // harness
      'data/risk-policy.json', 'src/security/risk-lists.json', 'src/security/flow-terminal-policy.ts',
      'src/FlowEngine.ts', 'src/GateController.ts', 'src/RiskClassifier.ts', 'src/main_harness_checker.ts',
      'mcp/server.ts', 'sentinel/sentinel-service.cjs', 'scripts/harness-gate.cjs',
      'data/flows/x.yaml', 'data/exemptions.json', '.claude/settings.json',
      'src/__tests__/x.test.ts', 'docs/x.md', 'db/x.sql', 'src/types.ts',
      // wenstar-cc
      'src/webui/chat.ts', 'src/m4/household/FamilyGraph.ts', 'src/m5/DeepSeekLLMProvider.ts',
      'src/governance/personal-world-law.ts', 'src/engine/tianquan/prefrontal/PrefrontalCortex.ts',
      'src/app/fg/x.ts', 'src/hooks/x.ts', 'src/m4/household/EntityContextBuilder.ts',
      'src/config/x.ts', 'src/m2/Whatever.ts',
    ];
    const diffs = paths
      .map(p => ({ p, ts: classifyPath(p), cjs: cjsClassifyRisk(p) }))
      .filter(r => r.ts !== r.cjs);
    expect(diffs, `两侧判定分歧: ${JSON.stringify(diffs)}`).toEqual([]);
  });

  it('wenstar-cc 侧原有高风险条目一个都不能丢（并集是 fail-closed 方向）', () => {
    const files = getHighRiskFiles();
    for (const f of [
      'src/webui/chat.ts', 'src/m4/household/FamilyGraph.ts', 'src/m2/SQLiteAdapter.ts',
      'src/m5/DeepSeekLLMProvider.ts',
      // 这两条只有原 RiskClassifier 有，另两份清单漏掉 —— 合一后必须补回来
      'src/engine/tianquan/prefrontal/PrefrontalCortex.ts', 'src/governance/personal-world-law.ts',
    ]) {
      expect(files, `${f} 不应从高风险清单消失`).toContain(f);
    }
  });

  it('isHighRisk 与 classifyPath 自洽（不会出现 classifyFile 说 low 而 isHighRisk 说 true）', () => {
    for (const f of ['src/FlowEngine.ts', 'src/config/x.ts', 'data/risk-policy.json', 'src/m4/household/EntityContextBuilder.ts']) {
      expect(isHighRisk(f)).toBe(classifyPath(f) === 'high');
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// ④ AUTO_GRANT_NEVER 由同一真值源派生
// ════════════════════════════════════════════════════════════════════

describe('④ AUTO_GRANT_NEVER 派生自真值源', () => {
  it('治理引擎核心 / 授权机制 / 防线控制面 一律不得经方案预审自动授权', () => {
    for (const f of [
      'src/security/flow-terminal-policy.ts',   // 授权机制自身 → 自引用绕过
      'src/FlowEngine.ts', 'src/RiskClassifier.ts', 'src/ComplianceScorer.ts',
      'data/flows/plan_review_flow.yaml', 'sentinel/sentinel-service.cjs', 'mcp/server.ts',
    ]) {
      const v = isAutoGrantAllowed(f);
      expect(v.allowed, `${f} 不应允许自动授权`).toBe(false);
      expect(v.code).toBe('never_auto_grant');
    }
  });

  it('🔴 治理门实现自身也不得自动授权 —— 否则可经预审拆掉刚加的 R4 闸门', () => {
    // 回归：src/s6/ 与 src/s7/ 一度既不是 high、也不在 AUTO_GRANT_NEVER，
    // 等于允许 Agent 自动授权去改 S7ArchiveValidator.ts —— 与 src/security/ 同类自引用绕过。
    for (const f of [
      'src/s7/S7ArchiveValidator.ts', 'src/s7/s7AutoArchive.ts', 'src/s7/S7ArchiveDelegate.ts',
      'src/s6/manualVerify.ts', 'src/s6/S6ManualVerifyDelegate.ts',
    ]) {
      expect(classifyPath(f), `${f} 应为 high`).toBe('high');
      expect(isAutoGrantAllowed(f).allowed, `${f} 不应允许自动授权`).toBe(false);
    }
  });

  it('普通业务代码仍在白名单内（边界内自动化）', () => {
    expect(isAutoGrantAllowed('src/utils/helper.ts').allowed).toBe(true);
    expect(isAutoGrantAllowed('src/engine/tianquan/foo.ts').allowed).toBe(true);
  });

  it('白名单外（非 src/）一律拒绝', () => {
    const v = isAutoGrantAllowed('docs/plan.md');
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('not_in_whitelist');
  });

  it('AUTO_GRANT_NEVER 确实由真值源派生 —— 含 harness 治理核心，不是空表', () => {
    expect(AUTO_GRANT_NEVER.length).toBeGreaterThan(20);
    expect(AUTO_GRANT_NEVER).toContain('src/FlowEngine.ts');
    expect(AUTO_GRANT_NEVER).toContain('src/security/');
    // 混合校验：一批文件里只有越界的被挑出来（边界内的不受影响）
    const violations = checkAutoGrantScope([
      'src/utils/helper.ts', 'src/FlowEngine.ts', 'src/security/x.ts', 'src/s7/S7ArchiveValidator.ts',
    ]);
    expect(violations.map(v => v.file).sort()).toEqual(
      ['src/FlowEngine.ts', 'src/s7/S7ArchiveValidator.ts', 'src/security/x.ts'],
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// ② S7-B 高风险禁 exemption 兜底
// ════════════════════════════════════════════════════════════════════

function payload(over: Partial<S7ArchivePayload> = {}): S7ArchivePayload {
  return {
    change_summary: '修X', audit_ref: 'run_x',
    rollback_plan: { modified_files: ['src/a.ts'], rollback_steps: '还原' },
    verification_checklist: [{ item: 'tsc' }],
    debt_marker: { is_patch: false, debt_item_id: null },
    ...over,
  } as S7ArchivePayload;
}
function ctx(over: Partial<S7ArchiveContext> = {}): S7ArchiveContext {
  return {
    diffFiles: ['src/a.ts'], s45score: 99, isLargeRefactor: false,
    ledgerGetDebt: () => null, exemptionExists: () => true, ...over,
  };
}

describe('② S7-B：高风险改动禁止用 exemption 兜底', () => {
  const HR = 'src/FlowEngine.ts';

  it('高风险 + S4.5<98 + 有合法 exemption → 仍然拒绝，且原因是可行动的', () => {
    const v = validateArchive(
      payload({ rollback_plan: { modified_files: [HR], rollback_steps: '还原' }, exemption_id: 'ex-real' }),
      ctx({ diffFiles: [HR], s45score: 90, highRiskFiles: [HR] }),
    );
    expect(v.archive_valid).toBe(false);
    const r4 = v.errors.find(e => e.startsWith('R4'));
    expect(r4).toBeDefined();
    expect(r4).toContain('不允许');
    expect(r4).toContain('≥98');           // 出口①
    expect(r4).toContain('arch_structural_defect'); // 出口②
  });

  it('高风险 + S4.5 ≥98 → 通过（正常路径不受影响）', () => {
    const v = validateArchive(
      payload({ rollback_plan: { modified_files: [HR], rollback_steps: '还原' } }),
      ctx({ diffFiles: [HR], s45score: 99, highRiskFiles: [HR] }),
    );
    expect(v.archive_valid).toBe(true);
  });

  it('高风险 + S4.5<98 + arch_structural_defect + 有轮次计划 → 放行走架构通道', () => {
    const v = validateArchive(
      payload({
        rollback_plan: { modified_files: [HR], rollback_steps: '还原' },
        debt_marker: { is_patch: false, debt_item_id: null, three_round_review_plan: '三轮' } as never,
      }),
      ctx({ diffFiles: [HR], s45score: 90, highRiskFiles: [HR], problemNature: 'arch_structural_defect' }),
    );
    expect(v.archive_valid).toBe(true);
  });

  it('高风险 + S4.5<98 + arch_structural_defect 但无轮次计划 → 仍拒绝', () => {
    const v = validateArchive(
      payload({ rollback_plan: { modified_files: [HR], rollback_steps: '还原' } }),
      ctx({ diffFiles: [HR], s45score: 90, highRiskFiles: [HR], problemNature: 'arch_structural_defect' }),
    );
    expect(v.archive_valid).toBe(false);
    expect(v.errors.some(e => e.startsWith('R4') && e.includes('three_round_review_plan'))).toBe(true);
  });

  it('非高风险 + S4.5<98 + 合法 exemption → 旧行为不变（不误伤）', () => {
    const v = validateArchive(payload({ exemption_id: 'ex-real' }), ctx({ s45score: 90, highRiskFiles: [] }));
    expect(v.archive_valid).toBe(true);
  });

  it('非高风险 + S4.5<98 + 无 exemption → 仍按原规则要求豁免', () => {
    const v = validateArchive(payload(), ctx({ s45score: 90, highRiskFiles: [] }));
    expect(v.errors.some(e => e.startsWith('R4') && e.includes('exemption_id'))).toBe(true);
  });

  it('未传 highRiskFiles（旧调用方）→ 保持旧行为，不炸', () => {
    const v = validateArchive(payload({ exemption_id: 'ex-real' }), ctx({ s45score: 90 }));
    expect(v.archive_valid).toBe(true);
  });
});

describe('② findExemptionIdForFiles 收紧', () => {
  beforeEach(cleanupTestExemptions);

  const future = () => Date.now() + 3600_000;
  const past = () => Date.now() - 3600_000;

  it('① 过期豁免不算数', () => {
    process.env.HARNESS_EXEMPTIONS_FILE = TEST_EXEMPTIONS;
    writeExemptions({ 'src/a.ts': { id: 'ex-old', expires_at: past(), relaxed_checks: ['S4.5_complexity'] } });
    expect(findExemptionIdForFiles(['src/a.ts'])).toBeNull();
  });

  it('② 用途不匹配（没放宽 S4.5）不算数 —— 豁免必须"为什么签"对得上', () => {
    process.env.HARNESS_EXEMPTIONS_FILE = TEST_EXEMPTIONS;
    writeExemptions({ 'src/a.ts': { id: 'ex-other', expires_at: future(), relaxed_checks: ['something_else'] } });
    expect(findExemptionIdForFiles(['src/a.ts'])).toBeNull();
  });

  it('🔴 ③ 只覆盖低风险沾边文件、不覆盖最高风险文件 → 不再被选中（原绕过点）', () => {
    process.env.HARNESS_EXEMPTIONS_FILE = TEST_EXEMPTIONS;
    // 台账里只有一条针对"低风险沾边文件"的历史豁免；本次改动的最高风险文件是 src/FlowEngine.ts
    writeExemptions({
      'src/config/loose.ts': { id: 'ex-stale', expires_at: future(), relaxed_checks: ['S4.5_complexity'] },
    });
    expect(findExemptionIdForFiles(['src/config/loose.ts', 'src/FlowEngine.ts'])).toBeNull();
  });

  it('三条同时成立 → 正确返回该豁免 id', () => {
    process.env.HARNESS_EXEMPTIONS_FILE = TEST_EXEMPTIONS;
    writeExemptions({
      'src/FlowEngine.ts': { id: 'ex-good', expires_at: future(), relaxed_checks: ['S4.5_complexity'] },
      'src/config/loose.ts': { id: 'ex-stale', expires_at: future(), relaxed_checks: ['S4.5_complexity'] },
    });
    expect(findExemptionIdForFiles(['src/config/loose.ts', 'src/FlowEngine.ts'])).toBe('ex-good');
  });

  it('台账不存在 / 为空 → 返回 null（不抛异常）', () => {
    process.env.HARNESS_EXEMPTIONS_FILE = TEST_EXEMPTIONS;
    expect(findExemptionIdForFiles(['src/a.ts'])).toBeNull();
    expect(findExemptionIdForFiles([])).toBeNull();
  });
});

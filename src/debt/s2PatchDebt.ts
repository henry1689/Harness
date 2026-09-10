/**
 * s2PatchDebt.ts — S2「选补丁方案」→ 自动登记技术债（H-03 / 07 计划 P1-1）
 * ================================================================
 * 台账设计（见 techDebtLedger.ts 头注释）的三环，本模块补上**第一环**：
 *   ① S2 选「补丁方案」→ createDebt + linkRun(created)        ← 本模块
 *   ② S4.5 DS 扣分     → addCandidate（候选池，人工确认后转正）   ← 已 live
 *   ③ S7-B 归档校验    → 补丁 run 必须存在对应 debt_id，否则校验失败 ← 已 live
 *
 * 为什么需要它：H-03 的意图是「欠债要可追」。若 S2 采纳补丁方案却不落账，
 * 则 ③ 的 R2 永远查不到债务 → S7-B 必然拒绝 —— 这条链就断在第一环上。
 * 本模块在 **S2 human gate 判定为 approved 之后** 建账（此刻方案已被批准，
 * 不存在「为未批准的方案建账」的污染），并把 debt_id 回传给调用方，
 * 供 Agent 写入 S7-A 的 `data/archives/<run_id>.json` → `debt_marker.debt_item_id`。
 *
 * 🔴 降级原则：node:sqlite 不可用 / 建账异常 → **跳过不阻断**（与 H-03 候选池一致），
 * 只在结果里给出 skipped_reason。绝不因为建账失败卡死一条已被批准的流程。
 */
import { hasSqlite, openLedger } from './techDebtLedger.js';

/** S2 证据的 v2 相关字段（宽松结构——来自 MCP 输入，不可信，逐项校验） */
export interface S2PatchLike {
  approval_ref?: string;
  approved_plan?: string;
  problem_nature?: string;
  final_approved_plan?: string;
  patch_plan?: {
    is_available?: boolean;
    change_scope?: string[];
    debt_risks?: string;
    associated_debt_id?: string | null;
    payback_milestone?: string | null;
  } | null;
}

export interface PatchDebtOutcome {
  /** 绑定到的债务 id（已存在则回填，新建则返回新 id；跳过时为 null） */
  debt_id: string | null;
  /** 是否本次新建 */
  created: boolean;
  /** 未建账/未绑定的原因（正常跳过时给出，便于审计解释） */
  skipped_reason?: string;
}

const VALID_NATURE = ['specific_bug', 'coupling_debt', 'arch_structural_defect'] as const;
type ValidNature = (typeof VALID_NATURE)[number];

function normalizeNature(n: string | undefined): ValidNature {
  return (VALID_NATURE as readonly string[]).includes(n ?? '') ? (n as ValidNature) : 'coupling_debt';
}

/**
 * 若 S2 采纳补丁方案且未绑定债务 → 自动建账并 linkRun。
 * 非补丁方案 / 已绑定 / sqlite 不可用 / 建账异常 → 返回相应 outcome，**不抛异常**。
 */
export function ensurePatchDebt(
  ev: S2PatchLike,
  opts: { runId?: string; dbPath?: string } = {},
): PatchDebtOutcome {
  const isPatch = ev.final_approved_plan === 'patch' || ev.patch_plan?.is_available === true;
  if (!isPatch) {
    return { debt_id: null, created: false, skipped_reason: '非补丁方案（未采纳 patch），无需登记债务' };
  }

  const existing = ev.patch_plan?.associated_debt_id;
  if (typeof existing === 'string' && existing.trim()) {
    return { debt_id: existing.trim(), created: false };
  }

  if (!hasSqlite()) {
    return { debt_id: null, created: false, skipped_reason: 'node:sqlite 不可用，跳过建账（不阻断审批）' };
  }

  try {
    const ledger = openLedger(opts.dbPath);
    try {
      const scope = Array.isArray(ev.patch_plan?.change_scope)
        ? ev.patch_plan!.change_scope!.filter(s => typeof s === 'string')
        : [];
      const rec = ledger.createDebt({
        debt_title: `[S2补丁] ${String(ev.approved_plan || ev.approval_ref || '未命名方案').slice(0, 60)}`,
        problem_nature: normalizeNature(ev.problem_nature),
        risk_level: 'medium',
        description: [
          'S2 采纳「补丁方案」时自动登记（H-03：欠债可追，供 S7-B R2 校验）。',
          scope.length > 0 ? `改动范围: ${scope.join(', ')}` : '',
          ev.patch_plan?.debt_risks ? `债务风险: ${ev.patch_plan.debt_risks}` : '',
        ].filter(Boolean).join('\n'),
        related_milestones: [],
        origin_audit_ref: String(ev.approval_ref || 'S2 补丁方案'),
        payback_plan: String(ev.patch_plan?.debt_risks || '按 S2 方案的 payback_milestone 偿还'),
        payback_milestone: ev.patch_plan?.payback_milestone ?? null,
      });
      if (opts.runId) {
        ledger.linkRun(rec.debt_id, opts.runId, 'created');
      }
      return { debt_id: rec.debt_id, created: true };
    } finally {
      ledger.close();
    }
  } catch (err) {
    return {
      debt_id: null,
      created: false,
      skipped_reason: `台账不可用/建账失败，跳过（不阻断审批）：${(err as Error).message}`,
    };
  }
}

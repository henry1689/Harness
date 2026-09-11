/**
 * manualVerify.ts — S6-B 人工验证任务单生成/确认纯逻辑（H-02）
 * ================================================================
 * 原则：不强行自动化全部行为测试，做「强制分层契约」：
 *   S6-A 机器必跑（tsc/vitest/CK-09/10/save grep）；
 *   S6-B 机器生成 manual_verification_ticket，人工逐项确认后才算 S6 收口。
 * 纯函数；不依赖引擎状态。接线（YAML S6-A/S6-B + FlowEngine await 语义）见 03 文档。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ManualVerificationItem, ManualVerificationTicket } from '../schemas/manual-verification-ticket.js';
import { allConfirmed } from '../schemas/manual-verification-ticket.js';

/** 默认人工验证项（wenstar-cc 行为级；仅当改动确实落在产品域时才使用，见 deriveManualItems） */
export const DEFAULT_MANUAL_ITEMS: Array<Omit<ManualVerificationItem, 'confirmed' | 'confirmed_at' | 'confirmed_note'>> = [
  { verify_item: 'WebUI 普通对话', precondition: '服务启动', expected_result: '对话正常、无幻觉/角色混淆', verifier: '' },
  { verify_item: '实体会晤模式', precondition: '≥2 个不同话题', expected_result: '不读取其他角色记忆', verifier: '' },
  { verify_item: '角色扮演分支', precondition: '角色扮演开启', expected_result: '不污染主 FamilyGraph 户籍', verifier: '' },
  { verify_item: 'DB 标注率抽样', precondition: '库可查', expected_result: 'belong_entity_uuid 标注正常', verifier: '' },
  { verify_item: '停服-重启一致性', precondition: '可停服', expected_result: '重启后数据仍在（save 落盘）', verifier: '' },
];

/**
 * 🔴 2026-09-11 去形式化：原实现**无条件**用上面 5 条 wenstar-cc 产品项当任务单，
 * 于是任何非产品改动（尤其 Harness 自身改动）都会拿到一张「WebUI 对话 / 角色扮演 /
 * DB 标注率」的验收单 —— **没有人能对其有意义地勾选**，只会逼出批量代签
 * （实测历史任务单 ck_04774a3fa3409d75 的 5 项在 0.5 秒内被一次性勾完）。
 * 正常静默不是事件、无关项不是验收 —— 同一类形式主义。
 *
 * 现在按**改动域**推导验收项：
 *   - 改动落在产品域（且在项目根下真实存在）→ 用产品行为项（产品行为可能受影响，保守）
 *   - 否则（Harness 基础设施 / 纯配置 / 路径在产品根下不存在）→ 用**与该改动真正相关**的通用项
 *
 * ⚠️ 注意：另一处有同名镜像常量 PRODUCT_DOMAIN_RE（src/DelegateReviewer.ts）——
 * 两处都必须同步修改（未抽公共模块是为了避免新增受管文件带来的豁免开销）。
 */
const PRODUCT_DOMAIN_RE = /^(src\/(webui|app|engine|kernel|m1|m2|m3|m4|m5)\/|start\.cjs$)/;

/** 与改动真正相关的通用验收项（任何域都成立，不假设产品行为） */
const GENERIC_MANUAL_ITEMS: typeof DEFAULT_MANUAL_ITEMS = [
  { verify_item: '改动范围核对', precondition: '已拿到本次 diff', expected_result: '实际改动文件与归档回滚清单逐项一致（无漏记/多记）', verifier: '' },
  { verify_item: '声称解决的问题已复现验证', precondition: '按 S2 方案的目标场景', expected_result: 'S2 声称要解决的问题已按要求复现并确认修复', verifier: '' },
  { verify_item: '静态质量门槛', precondition: '可执行命令', expected_result: 'tsc --noEmit 零类型错误；无死代码/废弃导入', verifier: '' },
  { verify_item: '回滚演练', precondition: '有基线快照', expected_result: '按基线还原后文件哈希与基线一致', verifier: '' },
];

/**
 * 按改动域推导人工验收项。
 * @param modifiedFiles 本次改动文件（相对被治理项目根）
 * @param opts.projectRoot 被治理项目根；提供时会额外核验「该产品路径确实存在」，
 *        避免把 Harness 自身路径（如 src/s7/xxx.ts）误判成产品改动。
 */
export function deriveManualItems(
  modifiedFiles: string[],
  opts: { projectRoot?: string } = {},
): Array<Omit<ManualVerificationItem, 'confirmed' | 'confirmed_at' | 'confirmed_note'>> {
  const hitsProduct = (modifiedFiles ?? []).some(f => {
    const n = String(f).replace(/\\/g, '/');
    if (!PRODUCT_DOMAIN_RE.test(n)) return false;
    if (opts.projectRoot) {
      try { return existsSync(join(opts.projectRoot, n)); } catch { return false; }
    }
    return true;
  });
  const src = hitsProduct ? DEFAULT_MANUAL_ITEMS : GENERIC_MANUAL_ITEMS;
  return src.map(i => ({ ...i, verifier: '' }));
}

/** 由 run 生成任务单（items 缺省用 DEFAULT_MANUAL_ITEMS） */
export function buildManualTicket(run_id: string, items?: ManualVerificationItem[]): ManualVerificationTicket {
  return {
    run_id,
    generated_at: new Date().toISOString(),
    items: (items ?? DEFAULT_MANUAL_ITEMS.map(i => ({ ...i, confirmed: false }))),
  };
}

/** 确认单条（返回是否全部完成） */
export function confirmItem(ticket: ManualVerificationTicket, index: number, verifier: string, note?: string): boolean {
  if (index < 0 || index >= ticket.items.length) return allConfirmed(ticket);
  const it = ticket.items[index]!;
  it.confirmed = true;
  it.confirmed_at = new Date().toISOString();
  it.verifier = verifier || it.verifier;
  if (note) it.confirmed_note = note;
  return allConfirmed(ticket);
}

/** S6-B 是否需人工等待：skip_manual_verification=true 或 ticket 已全确认 → false（自动放行） */
export function isAwaitingManual(skipManualVerification: boolean | undefined, ticket: ManualVerificationTicket | null): boolean {
  if (skipManualVerification === true) return false;
  if (!ticket) return true; // 无 ticket → 需先生成
  return !allConfirmed(ticket);
}

/** S6-B 门控决策（纯函数，无 IO——便于单测） */
export type ManualGateDecision =
  | { action: 'pass'; reason: string }
  | { action: 'await'; pending: number; total: number };

/**
 * S6-B 放行判定（顺序即优先级）：
 *   ① 总开关关闭 → pass（兼容/回滚）
 *   ② s2_evidence.skip_manual_verification=true → pass
 *   ③ 任务单不存在 → await（需先生成，由调用方落盘）
 *   ④ 任务单已全确认 → pass
 *   ⑤ 否则 → await
 */
export function decideManualGate(opts: {
  enabled: boolean;
  skipManualVerification?: boolean;
  ticket: ManualVerificationTicket | null;
}): ManualGateDecision {
  if (!opts.enabled) return { action: 'pass', reason: '总开关 manual_verification_enabled=false' };
  if (opts.skipManualVerification === true) return { action: 'pass', reason: 'skip_manual_verification=true' };
  if (!opts.ticket || opts.ticket.items.length === 0) return { action: 'await', pending: 0, total: 0 };
  if (allConfirmed(opts.ticket)) return { action: 'pass', reason: '人工验收任务单已全部确认' };
  const pending = opts.ticket.items.filter(i => i.confirmed !== true).length;
  return { action: 'await', pending, total: opts.ticket.items.length };
}

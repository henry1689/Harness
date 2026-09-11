/**
 * s7AutoArchive.ts — S7-A 进程内自动归档（P0-B，2026-09-11）
 * ================================================================
 * 【要解决什么问题】
 * S7-A 是 `gate_type: auto` + `runner_mode: local` 的 stage。看 StageRunner.runLocal：
 * 只有 `gate_type === 'condition'` 才跑前置检查，`auto` 门直接返回空转结果 ——
 * **既不写文件、也不调 LLM**。而 MCP 驱动的 run（harness_run_flow）**没有 agent 循环**
 * 去写 `data/archives/<run_id>.json`，于是 S7-B 必然因「归档产物不存在」拒绝 →
 * F3 硬止两轮 → `run_status=archive_invalid`。
 * **在 MCP 路径下这份归档永远不可能存在** —— 这是死结，本模块消除它。
 *
 * 【本模块做什么】
 * 纯进程内、零 LLM、确定性：从 FlowRunState 直接推导 `s7_archive_payload` 并落盘，
 * 让 S7-B 有东西可校验，把「永远无解」变成「有明确、可行动的失败原因」。
 *
 * 【本模块刻意不做什么（治理红线）】
 * 不生成、不伪造任何治理凭据：
 *   - `exemption_id`：只**引用** data/exemptions.json 里**已存在且未过期**的豁免记录
 *     （P0-B 选项 b）；查不到就留空（选项 a），交由 S7-B 的 R4 以「缺豁免」这个
 *     **可行动**的原因拒绝。**绝不自动签发豁免** —— 那等于让流水线自我授权，
 *     「S4.5<98 必须有人兜底」的设计意图会被彻底架空。
 *   - `debt_item_id`：只从台账**反查**本 run 已登记的债务，绝不自造 id。
 *   - `is_patch`：**如实**取自 s2_evidence；补丁却查不到债务 → R2 拒绝（H-03 语义，不绕过）。
 *
 * 唯一的判断题是 `three_round_review_plan`（R5 对 ≥3 文件强制）：本模块填的是**计划**
 * （引用真实的 S4.5 收敛轮次与文件数），不是「已执行三轮审计」的背书。若认为该字段
 * 必须人工填写，把 buildAutoArchive 里那一行改为 null 即可 —— 代价是多文件 run 仍会被
 * R5 拒绝（但至少失败原因可行动）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FlowRunState } from '../types.js';
import type { S7ArchivePayload } from '../schemas/s7-archive-payload.js';
import { hasSqlite, openLedger } from '../debt/techDebtLedger.js';

/** harness 自身的 data/ 目录（与 S7ArchiveDelegate.harnessDataDir 保持一致） */
function harnessDataDir(): string {
  const selfDir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
  return join(selfDir, '..', '..', 'data');
}

/** S7-A 落盘路径：data/archives/<run_id>.json（与 S7ArchiveDelegate.archivePathForRun 一致） */
export function autoArchivePathFor(run_id: string): string {
  return join(harnessDataDir(), 'archives', `${run_id}.json`);
}

/** 路径比较：容忍相对/绝对混用（豁免台账里的 key 两种形态都有） */
function pathsMatch(a: string, b: string): boolean {
  const na = String(a).replace(/\\/g, '/');
  const nb = String(b).replace(/\\/g, '/');
  return na === nb || na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

interface ExemptionRecord { id?: string; expires_at?: number }

/**
 * P0-B 选项 b：在豁免台账里找一条**覆盖本次改动文件且未过期**的豁免，返回其 id。
 * 找不到返回 null（选项 a）—— 调用方会把 exemption_id 留空，由 R4 报「缺豁免」。
 * 注意：这里**只读不写**，不会新增任何豁免。
 */
export function findExemptionIdForFiles(modifiedFiles: string[]): string | null {
  try {
    const fp = process.env.HARNESS_EXEMPTIONS_FILE || join(harnessDataDir(), 'exemptions.json');
    if (!existsSync(fp)) return null;
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as { exemptions?: Record<string, ExemptionRecord> };
    const entries = Object.entries(raw.exemptions ?? {});
    const now = Date.now();
    for (const [key, rec] of entries) {
      if (!rec || typeof rec.id !== 'string') continue;
      if (typeof rec.expires_at === 'number' && rec.expires_at <= now) continue; // 过期的不算
      if (modifiedFiles.some(f => pathsMatch(f, key))) return rec.id;
    }
    return null;
  } catch { return null; }
}

/**
 * 反查本 run 已登记的技术债 id（P1-1 的 ensurePatchDebt 会 linkRun(debt_id, runId, 'created')）。
 * 台账无反向索引，故遍历 + runsForDebt 匹配；**仅在 is_patch=true 时调用**（罕见路径），
 * 且台账不可用时返回 null（不阻断，交给 R2 报错）。
 */
export function findDebtIdForRun(runId: string): string | null {
  if (!hasSqlite()) return null;
  try {
    const ledger = openLedger();
    try {
      for (const d of ledger.listDebts()) {
        const runs = ledger.runsForDebt(d.debt_id);
        if (runs.some(r => r.audit_ref === runId)) return d.debt_id;
      }
      return null;
    } finally { ledger.close(); }
  } catch { return null; }
}

/** s2_evidence 的最小结构视图（仅取归档需要的字段，避免耦合完整类型） */
interface S2EvidenceLike {
  approval_ref?: string;
  approved_plan?: string;
  final_approved_plan?: string;
  problem_nature?: string;
  patch_plan?: { is_available?: boolean } | null;
}

/** 从 state 推导归档 payload。**纯函数**（不落盘），便于单测。 */
export function buildAutoArchive(state: FlowRunState): S7ArchivePayload {
  const runId = String(state.run_id);
  const files = (state.modified_files ?? []).map(f => String(f));
  const ev = (state.s2_evidence ?? undefined) as S2EvidenceLike | undefined;

  const isPatch = ev?.final_approved_plan === 'patch' || ev?.patch_plan?.is_available === true;
  const s45 = state.convergence_history?.[state.convergence_history.length - 1]?.overallScore;
  const rounds = state.convergence_history?.length ?? 0;

  const planLabel = ev?.approved_plan || ev?.approval_ref || '（S2 未声明方案）';
  const checklist: Array<Record<string, unknown>> = [
    { item: 'S3 改动落地', evidence: `本次 diff 共 ${files.length} 个文件` },
    { item: 'S5 编译与测试', evidence: '编译/测试结论见本次 run 审计卷宗' },
    { item: 'S6 机器校验', evidence: '见本 stage 之前 S6-A 的 machine_signal' },
    { item: 'S4.5 收敛', evidence: s45 === undefined ? '本次 run 未产生 S4.5 收敛记录' : `末轮综合分 ${s45}%，共 ${rounds} 轮` },
  ];

  return {
    change_summary: `[S7-A 自动归档] run ${runId}｜方案: ${planLabel}｜改动 ${files.length} 个文件`,
    rollback_plan: {
      // R3：必须与本次 diff 完全一致（漏记/多记均驳回）——故直接取自 state.modified_files
      modified_files: files,
      rollback_steps: [
        '回滚方式：Sentinel v3.0 基线恢复（不用 git checkout，避免销毁未暂存工作）。',
        `对以下 ${files.length} 个文件执行基线还原即可回到改动前状态：`,
        ...files.map(f => `  - ${f}`),
        '还原后核对哈希与基线 index.json 一致，并在 data/sentinel/ 确认 reverted 事件。',
      ].join('\n'),
    },
    verification_checklist: checklist,
    debt_marker: {
      is_patch: isPatch,
      // 补丁却查不到债务 → 保持 null，由 R2 以「未登记债务」拒绝（不绕过 H-03）
      debt_item_id: isPatch ? findDebtIdForRun(runId) : null,
      // R5：≥3 文件视为大重构。这里填的是**计划**（引用真实轮次数据），非完成背书。
      three_round_review_plan: files.length >= 3
        ? `三轮复审计划：① 架构评审（S4 记录，S4.5 共 ${rounds} 轮收敛）；② 逐文件 diff 复核（${files.length} 个文件）；③ 回滚演练（按基线还原后比对哈希）。`
        : null,
    },
    audit_ref: `data/audit/${new Date().toISOString().slice(0, 10)}/${runId}.json`,
    // R4：s45<98 时必须有真实存在的豁免 id —— 只引用台账已有记录，绝不新签
    exemption_id: findExemptionIdForFiles(files),
  };
}

export interface AutoArchiveResult {
  written: boolean;
  path: string;
  /** 未写入的原因（already_exists / 异常），写入成功时为 undefined */
  skipped_reason?: string;
  payload?: S7ArchivePayload;
}

/**
 * 落盘归档。**已有归档则不覆盖**（Agent/人工可能写了更完整的一份，不能被自动版冲掉）。
 * 任何异常都不抛出 —— 归档失败由下游 S7-B 以「产物不存在」拒绝，语义仍清晰。
 */
export function writeAutoArchive(state: FlowRunState): AutoArchiveResult {
  const path = autoArchivePathFor(String(state.run_id));
  try {
    if (existsSync(path)) {
      return { written: false, path, skipped_reason: '归档已存在，保留原产物不覆盖' };
    }
    const payload = buildAutoArchive(state);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8');
    return { written: true, path, payload };
  } catch (err) {
    return { written: false, path, skipped_reason: `自动归档异常: ${(err as Error).message}` };
  }
}

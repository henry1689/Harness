/**
 * S7ArchiveDelegate — S7-B 归档校验 delegate（H-01）
 * ================================================================
 * 进程内 delegate（无 LLM）：读取 S7-A 落盘的 s7_archive_payload →
 * S7ArchiveValidator 硬校验 → 双通道 signal（pass/reject）。
 * 由 FlowEngine 的 delegateFnMap 以 'S7_B_Archive_Validate' 注册（接线见 mcp/server.ts）。
 * 依赖：validateArchive（src/s7/S7ArchiveValidator.ts）+ 可选台账/豁免存在性注入。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StageConfig, FlowRunState, StageOutput } from '../types.js';
import { passSignal, rejectSignal, makeStageOutput } from '../DualChannelSignal.js';
import { validateArchive, type S7ArchiveContext } from './S7ArchiveValidator.js';
import { hasSqlite, openLedger } from '../debt/techDebtLedger.js';
import type { S7ArchivePayload } from '../schemas/s7-archive-payload.js';

function harnessDataDir(): string {
  const selfDir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
  return join(selfDir, '..', '..', 'data');
}

/** S7-A 落盘路径：data/archives/<run_id>.json */
export function archivePathForRun(run_id: string): string {
  return join(harnessDataDir(), 'archives', `${run_id}.json`);
}

export function loadArchivePayload(run_id: string): S7ArchivePayload | null {
  const p = archivePathForRun(run_id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')) as S7ArchivePayload; } catch { return null; }
}

/** 豁免存在性（按 record.id 匹配 data/exemptions.json） */
function exemptionExistsById(exemption_id: string): boolean {
  try {
    const raw = readFileSync(join(harnessDataDir(), 'exemptions.json'), 'utf-8');
    const j = JSON.parse(raw) as { exemptions?: Record<string, { id?: string }> };
    const ex = j.exemptions ?? {};
    return Object.values(ex).some(r => r.id === exemption_id);
  } catch { return false; }
}

/** ledger 债务存在性（node:sqlite 不可用 → 返回 undefined 表示无法校验，R2 由台账启用后强制） */
function ledgerGetDebtOrNull(debt_id: string): { debt_id: string } | null | undefined {
  if (!hasSqlite()) return undefined;
  try {
    const ledger = openLedger();
    try { return ledger.getDebt(debt_id) ?? null; } finally { ledger.close(); }
  } catch { return null; }
}

/** DelegateReviewFn 签名：S7-B 归档校验 */
export async function s7ArchiveValidateDelegate(_stage: StageConfig, state: FlowRunState): Promise<StageOutput> {
  const runId = state.run_id;
  const payload = loadArchivePayload(runId);
  if (!payload) {
    const msg =
      `[S7-B] 未找到 S7-A 归档产物 data/archives/${runId}.json。` +
      'S7-A 必须产出结构化 s7_archive_payload（change_summary/rollback_plan/verification_checklist/debt_marker/audit_ref）并写入该路径，否则 S7-B 无法机器校验。';
    return makeStageOutput(rejectSignal([msg], 'high', { files_checked: state.modified_files.length }), msg);
  }

  // S4.5 末轮分（若有收敛历史）
  const last = state.convergence_history?.[state.convergence_history.length - 1];

  // 🔴 2026-09-12（②）：R4 需要 S2 的问题性质，才能区分「高风险 + S4.5<98」的两种处理 ——
  // 缺省拒绝，但 problem_nature=arch_structural_defect 时可走架构通道（须另带三轮复审计划）。
  // 高风险文件名单无需在此传入：S7ArchiveValidator 会按单一真值源自行判定 diffFiles，
  // 此处只补上校验器拿不到的那个字段（s2_evidence 只在 state 上）。
  const problemNature = (state.s2_evidence as { problem_nature?: string } | undefined)?.problem_nature;

  const ctx: S7ArchiveContext = {
    diffFiles: state.modified_files,
    s45score: last?.overallScore ?? null,
    isLargeRefactor: (state.modified_files?.length ?? 0) >= 3,
    ledgerGetDebt: ledgerGetDebtOrNull,
    exemptionExists: exemptionExistsById,
    problemNature,
  };
  const verdict = validateArchive(payload, ctx);

  if (verdict.archive_valid) {
    const report = `## ✅ S7-B 归档校验通过（run ${runId}）\n- diff 文件 ${ctx.diffFiles.length} 个，回滚清单一致；补丁债务登记/豁免合法。`;
    return makeStageOutput(passSignal({ files_checked: state.modified_files.length }), report);
  }
  const report = `## ❌ S7-B 归档校验失败（run ${runId}）\n请返回 S7-A 补全归档产物：\n${verdict.errors.map(e => `- ${e}`).join('\n')}`;
  // 🔴 2026-09-21：reject_reason 此前只带 errors[0]，全量报告只落在 human_report ——
  //   而 human_report 在终局文案里往往只被指向、不被展开，作者实际只能看到**第一条** R 规则，
  //   修完重跑 2~4 分钟才发现下一条，于是把「1 次失败」放大成 N 次全流程（审计实证 12+ 轮）。
  //   验证器本就在一次 pass 内收集了全部 errors（见 S7ArchiveValidator 末尾 return），
  //   这里只是把已有信息原样送达机器可见通道 —— **不放松任何一条规则**。
  return makeStageOutput(
    rejectSignal(
      // 不加 `- ` 前缀：本数组是机器通道，消费方（FlowEngine / mcp/server.ts）只做
      // 去头部与过滤，加前缀会让「真实原因：- R4: … | - R2: …」多出噪音。
      [`S7-B 归档校验失败 ${verdict.errors.length} 项:`].concat(verdict.errors),
      'mid',
    ),
    report,
  );
}

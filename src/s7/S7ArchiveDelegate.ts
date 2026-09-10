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
  const ctx: S7ArchiveContext = {
    diffFiles: state.modified_files,
    s45score: last?.overallScore ?? null,
    isLargeRefactor: (state.modified_files?.length ?? 0) >= 3,
    ledgerGetDebt: ledgerGetDebtOrNull,
    exemptionExists: exemptionExistsById,
  };
  const verdict = validateArchive(payload, ctx);

  if (verdict.archive_valid) {
    const report = `## ✅ S7-B 归档校验通过（run ${runId}）\n- diff 文件 ${ctx.diffFiles.length} 个，回滚清单一致；补丁债务登记/豁免合法。`;
    return makeStageOutput(passSignal({ files_checked: state.modified_files.length }), report);
  }
  const report = `## ❌ S7-B 归档校验失败（run ${runId}）\n请返回 S7-A 补全归档产物：\n${verdict.errors.map(e => `- ${e}`).join('\n')}`;
  return makeStageOutput(
    rejectSignal([`S7-B 归档校验失败 ${verdict.errors.length} 项: ${verdict.errors[0]}`, '详见 human_report'], 'mid'),
    report,
  );
}

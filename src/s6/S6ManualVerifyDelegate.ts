/**
 * S6ManualVerifyDelegate — S6-B 人工验证门控 delegate（H-02）
 * ================================================================
 * 进程内 delegate（无 LLM）：S6-A 机器硬校验通过后，S6-B 决定是否放行 S7。
 *
 * 🔴 架构约束（决定了本实现形态，勿照字面实现「真阻塞」）：
 *   FlowEngine 是单程 `start()` 递归 DFA，**无运行中暂停/恢复原语**，且 run_id 每次
 *   调用重新生成。因此「人工确认签名后 condition 自动 pass → S7」无法在同一 run 内实现。
 *   落地形态 = **终局悬挂 + 确认后重跑**（与 E-02 的「重开 run」范式一致）：
 *     未确认 → reject 携带 metrics.await_manual_verification → FlowEngine 悬挂终局
 *              （run_status=await_manual_verification，不签发 token）；
 *     人工用 scripts/harness-manual-confirm.cjs 逐项确认 → 重跑同一批文件 →
 *              本次同 change_key 命中同一张已确认任务单 → pass → S7。
 *   故任务单必须按 change_key（稳定变更指纹）而非 run_id 寻址。
 *
 * 放行条件（任一）：
 *   ① data/harness_globals.json 中 manual_verification_enabled === false（总开关，兼容/回滚）
 *   ② 本次 s2_evidence.skip_manual_verification === true（方案声明免人工验收）
 *   ③ change_key 对应任务单已全部 confirmed
 */
import type { StageConfig, FlowRunState, StageOutput } from '../types.js';
import { passSignal, rejectSignal, makeStageOutput } from '../DualChannelSignal.js';
import { buildManualTicket, decideManualGate } from './manualVerify.js';
import {
  computeChangeKey,
  loadTicket,
  saveTicket,
  manualVerificationEnabled,
  ticketPathFor,
  type ManualTicketFile,
} from './manualVerifyIO.js';

/** 人工确认命令提示（非秘密，直接给操作者） */
function confirmHint(changeKey: string): string {
  const cli = 'node "D:\\AI文件\\harness\\scripts\\harness-manual-confirm.cjs"';
  return [
    '人工验收（逐项确认，全部确认后重跑 harness_run_flow 即自动放行 S7）：',
    `  ${cli} list ${changeKey}`,
    `  ${cli} confirm ${changeKey} <序号> <验收人> [备注]`,
  ].join('\n');
}

/** DelegateReviewFn 签名：S6-B 人工验证门控 */
export async function s6ManualVerifyDelegate(_stage: StageConfig, state: FlowRunState): Promise<StageOutput> {
  const files = state.modified_files ?? [];
  const changeKey = computeChangeKey(files);

  const skip = state.s2_evidence?.skip_manual_verification === true;
  const enabled = manualVerificationEnabled();

  // ①② 总开关关闭 / 方案声明免人工验收 → 放行（不落盘任务单，无副作用）
  const pre = decideManualGate({ enabled, skipManualVerification: skip, ticket: null });
  if (pre.action === 'pass') {
    const msg = `## ⏭ S6-B 人工验证已通过（${pre.reason}）\n放行 S7。`;
    return makeStageOutput(passSignal({ files_checked: files.length, await_manual_verification: false, manual_ticket_key: changeKey }), msg);
  }

  // ③ 读/建任务单（按稳定 change_key 寻址——重跑同一批文件命中同一张单）
  let ticket = loadTicket(changeKey);
  if (!ticket) {
    const fresh = buildManualTicket(state.run_id) as ManualTicketFile;
    ticket = { ...fresh, change_key: changeKey, last_run_id: state.run_id, run_status: 'await_manual_verification' };
    saveTicket(ticket);
  } else if (ticket.last_run_id !== state.run_id) {
    ticket.last_run_id = state.run_id;
    saveTicket(ticket);
  }

  // ④⑤ 已全确认 → 放行；否则悬挂
  const decision = decideManualGate({ enabled, skipManualVerification: skip, ticket });
  if (decision.action === 'pass') {
    const msg = `## ✅ S6-B 人工验证通过（${changeKey}）\n共 ${ticket.items.length} 项已全部由人工确认，放行 S7 归档。`;
    return makeStageOutput(passSignal({ files_checked: files.length, await_manual_verification: false, manual_ticket_key: changeKey }), msg);
  }

  const pending = ticket.items.filter(i => i.confirmed !== true);

  const report = [
    `## ⏸ S6-B 人工验证未完成（${changeKey}）`,
    `本次为 run ${state.run_id}；任务单已生成：${ticketPathFor(changeKey)}`,
    `待确认 ${pending.length}/${ticket.items.length} 项：`,
    ...ticket.items.map((it, i) => `  [${it.confirmed ? '✓' : ' '}] ${i}. ${it.verify_item} — 期望: ${it.expected_result}`),
    '',
    confirmHint(changeKey),
    '',
    '🔴 本 run 已悬挂终局（run_status=await_manual_verification），**不签发写入令牌**。',
  ].join('\n');

  return makeStageOutput(
    rejectSignal(
      [`S6-B 人工验证未完成：${pending.length}/${ticket.items.length} 项待人工确认（任务单 ${changeKey}）`, '详见 human_report'],
      'mid',
      { files_checked: files.length, await_manual_verification: true, manual_ticket_key: changeKey },
    ),
    report,
  );
}

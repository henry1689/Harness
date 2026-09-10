/**
 * manualVerifyIO.ts — S6-B 人工验证任务单的落盘/寻址（H-02）
 * ================================================================
 * 🔴 关键设计：任务单以「变更指纹 change_key」寻址，而非 run_id。
 *
 * 原因（架构约束，勿改）：FlowEngine 是单程 `start()`，无运行中暂停/恢复原语；
 * 且 run_id 每次调用重新生成。若按 run_id 寻址，人工确认后重跑会拿到新 run_id，
 * 找不到原任务单 → 永远无法收口。故以「排序后 modified_files 的哈希」作为稳定身份，
 * 同一批文件的重跑命中同一张任务单。
 *
 * 文件：data/manual_tickets/<change_key>.json
 * 开关：data/harness_globals.json → manual_verification_enabled（缺省 true）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ManualVerificationTicket } from '../schemas/manual-verification-ticket.js';
import { allConfirmed } from '../schemas/manual-verification-ticket.js';

/** 磁盘上的任务单：在 schema 基础上附加稳定身份与状态 */
export interface ManualTicketFile extends ManualVerificationTicket {
  change_key: string;
  /** 最后一次写入该任务单的 run（仅供溯源；寻址不用它） */
  last_run_id: string;
  run_status: 'await_manual_verification' | 'completed';
}

function harnessDataDir(): string {
  const selfDir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
  return join(selfDir, '..', '..', 'data');
}

export function ticketsDir(): string {
  return join(harnessDataDir(), 'manual_tickets');
}

/** 变更指纹：排序后文件列表的稳定短哈希（同批文件重跑 → 同 key） */
export function computeChangeKey(modifiedFiles: string[]): string {
  const normalized = [...modifiedFiles]
    .map(f => f.replace(/\\/g, '/').trim())
    .filter(Boolean)
    .sort();
  const h = createHash('sha256').update(normalized.join('\n'), 'utf-8').digest('hex');
  return `ck_${h.slice(0, 16)}`;
}

export function ticketPathFor(changeKey: string): string {
  return join(ticketsDir(), `${changeKey}.json`);
}

export function loadTicket(changeKey: string): ManualTicketFile | null {
  const p = ticketPathFor(changeKey);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8')) as ManualTicketFile;
    if (!Array.isArray(j.items)) return null;
    return j;
  } catch { return null; }
}

export function saveTicket(t: ManualTicketFile): void {
  const dir = ticketsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  t.run_status = allConfirmed(t) ? 'completed' : 'await_manual_verification';
  writeFileSync(ticketPathFor(t.change_key), JSON.stringify(t, null, 2), 'utf-8');
}

/** H-02 总开关：缺省 true（按方案语义阻塞）；显式 false 则 S6-B 自动放行（回滚/兼容用） */
export function manualVerificationEnabled(): boolean {
  try {
    const raw = readFileSync(join(harnessDataDir(), 'harness_globals.json'), 'utf-8');
    const j = JSON.parse(raw) as { manual_verification_enabled?: boolean };
    return j.manual_verification_enabled !== false;
  } catch { return true; }
}

/**
 * H-02 S6-B 门控：变更指纹寻址 + 任务单生命周期 + 门控决策 + delegate 端到端
 * 覆盖 03 文档 §4 回归用例：S6-A 过+S6-B 未确认→await_manual；确认后重跑→pass；
 * skip_manual_verification=true→全自动 completed。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import {
  computeChangeKey,
  loadTicket,
  saveTicket,
  manualVerificationEnabled,
  ticketPathFor,
  type ManualTicketFile,
} from '../s6/manualVerifyIO.js';
import { buildManualTicket, confirmItem, decideManualGate, isAwaitingManual } from '../s6/manualVerify.js';
import { s6ManualVerifyDelegate } from '../s6/S6ManualVerifyDelegate.js';

const FILE_SET = ['src/webui/chat.ts', 'src/m4/household/FamilyGraph.ts'];

afterAll(() => {
  // 🔴 测试数据清理：删除本测试创建的任务单，不留残留
  for (const s of [FILE_SET, ['src/only/a.ts'], ['src/only/b.ts']]) {
    const p = ticketPathFor(computeChangeKey(s));
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

describe('computeChangeKey（稳定变更指纹）', () => {
  it('同文件集 → 同 key（顺序无关、路径分隔符无关）', () => {
    const a = computeChangeKey(['src/b.ts', 'src/a.ts']);
    const b = computeChangeKey(['src/a.ts', 'src/b.ts']);
    const c = computeChangeKey(['src\\a.ts', 'src/b.ts']);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
  it('不同文件集 → 不同 key，且形如 ck_<16hex>', () => {
    const a = computeChangeKey(['src/only/a.ts']);
    const b = computeChangeKey(['src/only/b.ts']);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^ck_[0-9a-f]{16}$/);
  });
  it('空列表不抛异常', () => {
    expect(computeChangeKey([])).toMatch(/^ck_[0-9a-f]{16}$/);
  });
});

describe('decideManualGate（纯门控决策）', () => {
  const ticket = () => buildManualTicket('r1');
  it('总开关关闭 → pass', () => {
    expect(decideManualGate({ enabled: false, ticket: null }).action).toBe('pass');
  });
  it('skip_manual_verification=true → pass', () => {
    expect(decideManualGate({ enabled: true, skipManualVerification: true, ticket: null }).action).toBe('pass');
  });
  it('无任务单 → await', () => {
    expect(decideManualGate({ enabled: true, ticket: null }).action).toBe('await');
  });
  it('有任务单但未全确认 → await（带 pending/total）', () => {
    const t = ticket();
    confirmItem(t, 0, 'owner');
    const d = decideManualGate({ enabled: true, ticket: t });
    expect(d.action).toBe('await');
    if (d.action === 'await') {
      expect(d.total).toBe(t.items.length);
      expect(d.pending).toBe(t.items.length - 1);
    }
  });
  it('全确认 → pass', () => {
    const t = ticket();
    t.items.forEach((_, i) => confirmItem(t, i, 'owner'));
    expect(decideManualGate({ enabled: true, ticket: t }).action).toBe('pass');
  });
});

describe('manualVerificationEnabled', () => {
  it('globals 未声明 manual_verification_enabled → 缺省 true（按方案语义阻塞）', () => {
    expect(manualVerificationEnabled()).toBe(true);
  });
});

describe('s6ManualVerifyDelegate（端到端：确认后重跑同一批文件即放行）', () => {
  const state = (runId: string, skip?: boolean) => ({
    run_id: runId,
    modified_files: FILE_SET,
    s2_evidence: skip === undefined ? undefined : { skip_manual_verification: skip },
  }) as never;

  it('首次：生成任务单 + 悬挂（await_manual_verification 指标 + 不 pass）', async () => {
    const out = await s6ManualVerifyDelegate({} as never, state('run_first'));
    expect(out.machine_signal.passed).toBe(false);
    expect(out.machine_signal.metrics?.await_manual_verification).toBe(true);
    const key = computeChangeKey(FILE_SET);
    expect(out.machine_signal.metrics?.manual_ticket_key).toBe(key);
    expect(existsSync(ticketPathFor(key))).toBe(true);
  });

  it('重跑（新 run_id）：仍命中同一任务单，未确认 → 仍悬挂', async () => {
    const key = computeChangeKey(FILE_SET);
    const t = loadTicket(key)!;
    t.last_run_id = 'run_second_stale';
    saveTicket(t);
    const out = await s6ManualVerifyDelegate({} as never, state('run_second'));
    expect(out.machine_signal.passed).toBe(false);
    expect(loadTicket(key)!.last_run_id).toBe('run_second');
  });

  it('人工全确认后重跑（新 run_id）→ pass（change_key 寻址保证跨 run 命中）', async () => {
    const key = computeChangeKey(FILE_SET);
    const t: ManualTicketFile = loadTicket(key)!;
    t.items.forEach((_, i) => confirmItem(t, i, 'owner'));
    saveTicket(t);
    const out = await s6ManualVerifyDelegate({} as never, state('run_third'));
    expect(out.machine_signal.passed).toBe(true);
    expect(out.machine_signal.metrics?.await_manual_verification).toBe(false);
    expect(isAwaitingManual(false, loadTicket(key))).toBe(false);
  });

  it('skip_manual_verification=true → 全自动 pass，不落盘任务单', async () => {
    const only = ['src/only/a.ts'];
    const out = await s6ManualVerifyDelegate({} as never, { run_id: 'run_skip', modified_files: only, s2_evidence: { skip_manual_verification: true } } as never);
    expect(out.machine_signal.passed).toBe(true);
    expect(existsSync(ticketPathFor(computeChangeKey(only)))).toBe(false);
  });
});

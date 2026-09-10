/**
 * techDebtLedger — 统一技术负债台账（H-03）
 * =================================================
 * 机器可查询的治理数据库，独立于 wenstar-cc 业务库，位于 data/harness_db/harness_debt.sqlite。
 * 采集点（引擎接入时序由 FlowEngine/ConvergenceGate/S7 阶段负责）：
 *   - S2 选「补丁方案」→ createDebt + linkRun(created)
 *   - S4.5 DS 扣分 → addCandidate（结构性债务候选池，待人工确认转正）
 *   - S7-B 归档校验 → 补丁 run 必须存在对应 debt_id，否则校验失败
 * 存储：node:sqlite（Node 22 内置 DatabaseSync；mcp 运行 node 若缺则 isSqliteAvailable=false，
 *       调用方需降级处理——见 hasSqlite）。
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const _harnessRequire = createRequire(import.meta.url);

/** node:sqlite 是否可用（按运行 node 实际探测，不硬编码） */
export function hasSqlite(): boolean {
  try { _harnessRequire('node:sqlite'); return true; } catch { return false; }
}

// ── 类型 ──
export type DebtNature = 'specific_bug' | 'coupling_debt' | 'arch_structural_defect';
export type DebtRisk = 'low' | 'medium' | 'high' | 'critical';
export type DebtStatus = 'open' | 'deferred' | 'resolved' | 'archived';
export type DebtOccurType = 'created' | 'referenced' | 'modified' | 'resolved';

export interface DebtCreateInput {
  debt_title: string;
  problem_nature: DebtNature;
  risk_level: DebtRisk;
  description: string;
  related_milestones: string[];        // 如 ['P0-A','P2#8']
  origin_audit_ref: string;
  payback_plan: string;
  payback_milestone?: string | null;
  associated_exemption_id?: string | null;
}

export interface DebtRecord extends DebtCreateInput {
  debt_id: string;
  debt_status: DebtStatus;
  created_at: string;
  last_updated_at: string;
  resolved_at: string | null;
}

export interface DebtCandidateInput {
  source_audit_ref: string;
  ds_violate_list: string[];
  ck_violate_list: string[];
  risk_hint?: string;
}

/** 默认台账 DB 路径（harness 根/data/harness_db/harness_debt.sqlite） */
function defaultDbPath(): string {
  const selfDir = typeof import.meta !== 'undefined' && typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
  const root = join(selfDir, '..', '..');
  return join(root, 'data', 'harness_db', 'harness_debt.sqlite');
}

export class TechDebtLedger {
  private db: unknown; // DatabaseSync
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || defaultDbPath();
    if (!hasSqlite()) {
      throw new Error('[techDebtLedger] 当前 node 无 node:sqlite，台账不可用——请使用 Node ≥22.13 运行 harness');
    }
    const { DatabaseSync } = _harnessRequire('node:sqlite') as { DatabaseSync: new (p: string) => unknown };
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.ensureSchema();
  }

  /** 幂等建表（DDL 单一来源 scripts/harness-debt-schema.cjs） */
  ensureSchema(): void {
    const { LEDGER_DDL } = _harnessRequire('../../scripts/harness-debt-schema.cjs') as { LEDGER_DDL: string };
    (this.db as { exec: (sql: string) => void }).exec(LEDGER_DDL);
  }

  close(): void {
    (this.db as { close: () => void }).close();
  }

  private run(sql: string, params: Record<string, unknown>): { lastInsertRowid?: number | bigint } {
    const stmt = (this.db as { prepare: (s: string) => { run: (p: Record<string, unknown>) => { lastInsertRowid?: number | bigint } } }).prepare(sql);
    return stmt.run(params);
  }

  private all<T>(sql: string, params: Record<string, unknown> = {}): T[] {
    const stmt = (this.db as { prepare: (s: string) => { all: (p: Record<string, unknown>) => T[] } }).prepare(sql);
    return stmt.all(params);
  }

  private get<T>(sql: string, params: Record<string, unknown>): T | undefined {
    const stmt = (this.db as { prepare: (s: string) => { get: (p: Record<string, unknown>) => T | undefined } }).prepare(sql);
    return stmt.get(params);
  }

  // ── 债务主表 ──
  createDebt(input: DebtCreateInput): DebtRecord {
    const now = new Date().toISOString();
    const debt_id = `debt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.run(
      `INSERT INTO tech_debt_ledger
       (debt_id,debt_title,problem_nature,risk_level,description,related_milestones,origin_audit_ref,
        payback_plan,payback_milestone,debt_status,associated_exemption_id,created_at,last_updated_at)
       VALUES
       (:debt_id,:debt_title,:problem_nature,:risk_level,:description,:related_milestones,:origin_audit_ref,
        :payback_plan,:payback_milestone,'open',:associated_exemption_id,:created_at,:last_updated_at)`,
      {
        debt_id, debt_title: input.debt_title, problem_nature: input.problem_nature,
        risk_level: input.risk_level, description: input.description,
        related_milestones: JSON.stringify(input.related_milestones),
        origin_audit_ref: input.origin_audit_ref, payback_plan: input.payback_plan,
        payback_milestone: input.payback_milestone ?? null,
        associated_exemption_id: input.associated_exemption_id ?? null,
        created_at: now, last_updated_at: now,
      },
    );
    return this.getDebt(debt_id)!;
  }

  getDebt(debt_id: string): DebtRecord | undefined {
    return this.get<DebtRecord>(`SELECT * FROM tech_debt_ledger WHERE debt_id = :id`, { id: debt_id });
  }

  updateStatus(debt_id: string, status: DebtStatus): void {
    const now = new Date().toISOString();
    const resolved_at = status === 'resolved' ? now : null;
    this.run(
      `UPDATE tech_debt_ledger SET debt_status=:status, resolved_at=:resolved_at, last_updated_at=:now WHERE debt_id=:id`,
      { status, resolved_at, now, id: debt_id },
    );
  }

  listDebts(filter: { status?: DebtStatus; milestone?: string; risk?: DebtRisk } = {}): DebtRecord[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.status) { clauses.push('debt_status = :status'); params.status = filter.status; }
    if (filter.milestone) { clauses.push('payback_milestone = :milestone'); params.milestone = filter.milestone; }
    if (filter.risk) { clauses.push('risk_level = :risk'); params.risk = filter.risk; }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.all<DebtRecord>(`SELECT * FROM tech_debt_ledger ${where} ORDER BY created_at DESC`, params);
  }

  // ── run 关联 ──
  linkRun(debt_id: string, audit_ref: string, occur_type: DebtOccurType, comment?: string): void {
    const id = `drl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.run(
      `INSERT INTO debt_run_link (id,debt_id,audit_ref,debt_occur_type,comment,created_at)
       VALUES (:id,:debt_id,:audit_ref,:occur_type,:comment,:created_at)`,
      { id, debt_id, audit_ref, occur_type, comment: comment ?? null, created_at: new Date().toISOString() },
    );
  }

  runsForDebt(debt_id: string): Array<{ audit_ref: string; debt_occur_type: string; created_at: string }> {
    return this.all(`SELECT audit_ref,debt_occur_type,created_at FROM debt_run_link WHERE debt_id=:id ORDER BY created_at`, { id: debt_id });
  }

  // ── 候选池（S4.5 DS 扣分自动写入，人工确认转正） ──
  addCandidate(input: DebtCandidateInput): string {
    const candidate_id = `dc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.run(
      `INSERT INTO debt_candidate_pool (candidate_id,source_audit_ref,ds_violate_list,ck_violate_list,risk_hint,status,created_at)
       VALUES (:id,:audit,:ds,:ck,:hint,'pending',:now)`,
      {
        id: candidate_id, audit: input.source_audit_ref,
        ds: JSON.stringify(input.ds_violate_list), ck: JSON.stringify(input.ck_violate_list),
        hint: input.risk_hint ?? null, now: new Date().toISOString(),
      },
    );
    return candidate_id;
  }

  listCandidates(status: 'pending' | 'accepted' | 'discarded' = 'pending'): Array<{ candidate_id: string; source_audit_ref: string; ds_violate_list: string; risk_hint: string | null }> {
    return this.all(`SELECT candidate_id,source_audit_ref,ds_violate_list,ck_violate_list,risk_hint FROM debt_candidate_pool WHERE status=:status`, { status });
  }

  /** 人工确认转正：候选 → 开一条 open 债务（标题取 risk_hint 前 60 字兜底） */
  acceptCandidate(candidate_id: string, debt: Omit<DebtCreateInput, 'debt_title' | 'origin_audit_ref'> & { debt_title?: string }): DebtRecord | null {
    const cand = this.get<{ source_audit_ref: string; risk_hint: string | null; ds_violate_list: string }>(
      `SELECT source_audit_ref,risk_hint,ds_violate_list FROM debt_candidate_pool WHERE candidate_id=:id`, { id: candidate_id });
    if (!cand) return null;
    const rec = this.createDebt({
      debt_title: debt.debt_title ?? (cand.risk_hint ?? '结构性债务').slice(0, 60),
      problem_nature: debt.problem_nature,
      risk_level: debt.risk_level,
      description: debt.description,
      related_milestones: debt.related_milestones,
      origin_audit_ref: cand.source_audit_ref,
      payback_plan: debt.payback_plan,
      payback_milestone: debt.payback_milestone,
    });
    this.run(`UPDATE debt_candidate_pool SET status='accepted' WHERE candidate_id=:id`, { id: candidate_id });
    return rec;
  }

  discardCandidate(candidate_id: string): void {
    this.run(`UPDATE debt_candidate_pool SET status='discarded' WHERE candidate_id=:id`, { id: candidate_id });
  }
}

/** 默认单例便捷工厂 */
export function openLedger(dbPath?: string): TechDebtLedger {
  return new TechDebtLedger(dbPath);
}

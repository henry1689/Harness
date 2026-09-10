/**
 * harness-debt-schema.cjs — tech_debt_ledger 共享 DDL（单一事实源）
 * ================================================================
 * 被两处复用：
 *   1. src/debt/techDebtLedger.ts  —— 引擎进程内 ensureSchema（tsx 运行，经 createRequire 加载）
 *   2. scripts/harness-debt-migrate.cjs —— CLI 建表 / --validate-schema 校验
 *
 * 🔴 治理边界（防误用，勿删）：
 *   # 本 DB 为 harness 独立治理库（data/harness_db/harness_debt.sqlite），
 *   # 严禁被 wenstar-cc 业务代码直接导入 —— 债务台账只服务压模治理，禁止耦合业务逻辑。
 *
 * 向后兼容约束：本 schema 只增不改；旧表存在时 ensureSchema 幂等跳过；
 * 新增字段一律可选，历史行可读。
 */
'use strict';

// ── 表业务含义 ──
// tech_debt_ledger   债务主表：一笔债务一行。源头=S2 选补丁方案 / S4.5 候选转正 / S7 补丁归档校验。
//   problem_nature    债务根源分类：specific_bug(单点缺陷) | coupling_debt(耦合债) | arch_structural_defect(架构结构债)
//   risk_level        风险等级：low/medium/high/critical
//   related_milestones 归属里程碑 json 数组，如 ["P0-A","P2#8"]，对接 wenstar-cc 整改路线
//   origin_audit_ref  首产生该债务的 harness run 卷宗 id（可回溯）
//   payback_plan/payback_milestone  还债方案 + 计划清零里程碑
//   debt_status        open(未清) | deferred(延期) | resolved(已清) | archived(归档)
//   associated_exemption_id  关联豁免记录 id（临时补丁豁免 DS 扣分时绑定，允许空）
// debt_run_link      债务↔流水线运行 关联桥：一次 run 可引用/创建/修正/清偿多笔债，双向可溯
//   debt_occur_type   created(本次产生) | referenced(本次引用) | modified(本次修改) | resolved(本次清偿)
// debt_candidate_pool 结构性债务候选池：S4.5 DS 扣分自动写入；status=pending 待人工确认，
//                     acceptCandidate→转正写入 tech_debt_ledger；discarded 丢弃。防自动扣分直接变债务（人工兜底）。
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS tech_debt_ledger (
  debt_id TEXT PRIMARY KEY NOT NULL,                    -- 债务唯一ID，格式 debt_<ts36>_<rand>
  debt_title TEXT NOT NULL,                    -- 债务标题（≤可读长度）
  problem_nature TEXT NOT NULL,                -- specific_bug | coupling_debt | arch_structural_defect
  risk_level TEXT NOT NULL,                    -- low | medium | high | critical
  description TEXT NOT NULL,                   -- 债务详细描述（含为什么是债）
  related_milestones TEXT NOT NULL,            -- json array 如 ["P0-A","P2#8"]
  origin_audit_ref TEXT NOT NULL,              -- 首次产生该债务的 run 卷宗 id
  payback_plan TEXT NOT NULL,                  -- 还债方案说明（必须可执行）
  payback_milestone TEXT,                      -- 计划在哪一个里程碑清零
  debt_status TEXT NOT NULL DEFAULT 'open',    -- open | deferred | resolved | archived
  associated_exemption_id TEXT,                -- 关联豁免记录 id（允许空）
  created_at TEXT NOT NULL,                    -- ISO 时间
  last_updated_at TEXT NOT NULL,
  resolved_at TEXT                             -- 清偿时间（debt_status=resolved 时写）
);

CREATE TABLE IF NOT EXISTS debt_run_link (
  id TEXT PRIMARY KEY NOT NULL,                         -- drl_<ts36>_<rand>
  debt_id TEXT NOT NULL,                       -- → tech_debt_ledger.debt_id
  audit_ref TEXT NOT NULL,                     -- harness run 卷宗 id
  debt_occur_type TEXT NOT NULL,               -- created | referenced | modified | resolved
  comment TEXT,                                -- 该次关联说明
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS debt_candidate_pool (
  candidate_id TEXT PRIMARY KEY NOT NULL,               -- dc_<ts36>_<rand>
  source_audit_ref TEXT NOT NULL,              -- 产出候选的 run 卷宗 id
  ds_violate_list TEXT NOT NULL,               -- json array 触发的 DS 编号
  ck_violate_list TEXT NOT NULL,               -- json array 触发的 CK 编号
  risk_hint TEXT,                              -- 人工确认时的风险提示/建议标题
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | accepted | discarded
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_debt_status ON tech_debt_ledger(debt_status);
CREATE INDEX IF NOT EXISTS idx_debt_milestone ON tech_debt_ledger(payback_milestone);
CREATE INDEX IF NOT EXISTS idx_runlink_debt ON debt_run_link(debt_id);
CREATE INDEX IF NOT EXISTS idx_candidate_status ON debt_candidate_pool(status);
`;

module.exports = { LEDGER_DDL };

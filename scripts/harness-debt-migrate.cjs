/**
 * harness-debt-migrate.cjs — tech_debt_ledger 建表 + schema 校验 CLI（H-03 / B0）
 * ================================================================
 * 用法：
 *   node scripts/harness-debt-migrate.cjs init               # 建表（幂等）
 *   node scripts/harness-debt-migrate.cjs --validate-schema   # 校验表/字段/约束与 DDL 定义一致
 *   node scripts/harness-debt-migrate.cjs --list              # 各表行数快照
 *
 * 存储：node:sqlite（Node ≥22.13 内置 DatabaseSync）。
 * 独立治理库：data/harness_db/harness_debt.sqlite —— 严禁 wenstar-cc 业务代码导入。
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const { existsSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { LEDGER_DDL } = require('./harness-debt-schema.cjs');

const DB_PATH = join(__dirname, '..', 'data', 'harness_db', 'harness_debt.sqlite');

// 期望结构（与 harness-debt-schema.cjs DDL 一一对应，手改两处必须同步）
const EXPECTED = {
  tech_debt_ledger: {
    columns: {
      debt_id: { notnull: 1, pk: 1 }, debt_title: { notnull: 1 }, problem_nature: { notnull: 1 },
      risk_level: { notnull: 1 }, description: { notnull: 1 }, related_milestones: { notnull: 1 },
      origin_audit_ref: { notnull: 1 }, payback_plan: { notnull: 1 }, payback_milestone: { notnull: 0 },
      debt_status: { notnull: 1 }, associated_exemption_id: { notnull: 0 },
      created_at: { notnull: 1 }, last_updated_at: { notnull: 1 }, resolved_at: { notnull: 0 },
    },
  },
  debt_run_link: {
    columns: {
      id: { notnull: 1, pk: 1 }, debt_id: { notnull: 1 }, audit_ref: { notnull: 1 },
      debt_occur_type: { notnull: 1 }, comment: { notnull: 0 }, created_at: { notnull: 1 },
    },
  },
  debt_candidate_pool: {
    columns: {
      candidate_id: { notnull: 1, pk: 1 }, source_audit_ref: { notnull: 1 },
      ds_violate_list: { notnull: 1 }, ck_violate_list: { notnull: 1 },
      risk_hint: { notnull: 0 }, status: { notnull: 1 }, created_at: { notnull: 1 },
    },
  },
};

function open() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return new DatabaseSync(DB_PATH);
}

function cmdInit() {
  const db = open();
  db.exec(LEDGER_DDL);
  const counts = {};
  for (const t of Object.keys(EXPECTED)) {
    counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  }
  console.log(`✅ 建表完成（幂等）: ${DB_PATH}`);
  console.log('   行数:', JSON.stringify(counts));
  db.close();
}

/** 校验：表存在、字段存在、NOT NULL / PK 约束与 DDL 定义一致。有差异 exit 1。 */
function cmdValidate() {
  if (!existsSync(DB_PATH)) {
    console.error(`❌ DB 不存在: ${DB_PATH} —— 请先执行 init`);
    process.exit(1);
  }
  const db = open();
  const errors = [];
  for (const [table, spec] of Object.entries(EXPECTED)) {
    let cols;
    try {
      cols = db.prepare(`PRAGMA table_info(${table})`).all();
    } catch {
      errors.push(`表缺失: ${table}`);
      continue;
    }
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));
    for (const [col, expect] of Object.entries(spec.columns)) {
      const actual = byName[col];
      if (!actual) { errors.push(`${table}.${col} 字段缺失`); continue; }
      if (actual.notnull !== expect.notnull) errors.push(`${table}.${col} NOT NULL 不符(实际 ${actual.notnull}/${expect.notnull})`);
      if (!!expect.pk && actual.pk !== expect.pk) errors.push(`${table}.${col} PRIMARY KEY 不符`);
    }
  }
  db.close();
  if (errors.length) {
    console.error('❌ schema 校验失败:');
    for (const e of errors) console.error('   - ' + e);
    process.exit(1);
  }
  console.log(`✅ schema 校验通过: ${DB_PATH}（${Object.keys(EXPECTED).length} 张表字段/约束与 DDL 定义一致）`);
}

function cmdList() {
  if (!existsSync(DB_PATH)) { console.log('DB 不存在'); return; }
  const db = open();
  for (const t of Object.keys(EXPECTED)) {
    const c = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    console.log(`  ${t}: ${c} 行`);
  }
  db.close();
}

const args = process.argv.slice(2);
try {
  if (args.includes('--validate-schema')) cmdValidate();
  else if (args.includes('--list')) cmdList();
  else cmdInit();
} catch (err) {
  console.error('❌ 执行失败:', err.message);
  process.exit(1);
}

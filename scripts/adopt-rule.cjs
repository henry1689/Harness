#!/usr/bin/env node
/**
 * adopt-rule.cjs — 自学习建议决策工具（v2.6 新增）
 * ======================================================================
 * 把 data/learn/decisions.json 中的 pending 建议标记为 adopted（采纳）/ rejected（驳回）。
 * decisions.json 是人工决策台账——rule-refiner/rule-learner 只产出建议，不自动改行为。
 * 本工具由用户显式调用，把「建议」推进到「决策」，落盘前自动备份 .bak。
 *
 * 用法:
 *   node scripts/adopt-rule.cjs <id> [adopt|reject] [--note "原因"]
 *   node scripts/adopt-rule.cjs list            # 列出全部（含状态）
 *   node scripts/adopt-rule.cjs pending          # 只列待决策
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HARNESS_DIR = path.resolve(__dirname, '..');
const DECISIONS_FILE = path.join(HARNESS_DIR, 'data', 'learn', 'decisions.json');

const args = process.argv.slice(2);
const cmd = args[0];
const noteIdx = args.indexOf('--note');
const note = noteIdx >= 0 ? args.slice(noteIdx + 1).join(' ') : '';

function readDecisions() {
  if (!fs.existsSync(DECISIONS_FILE)) {
    console.error('❌ 无 decisions.json（先运行 node scripts/run-learning.cjs）');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(DECISIONS_FILE, 'utf-8'));
}

function writeDecisions(data) {
  // 落盘前备份
  fs.copyFileSync(DECISIONS_FILE, DECISIONS_FILE + '.bak');
  fs.writeFileSync(DECISIONS_FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`✅ 已更新 ${DECISIONS_FILE}（备份 .bak）`);
}

function list(filter) {
  const data = readDecisions();
  const items = (data.decisions || []).filter(d => !filter || d.status === filter);
  if (!items.length) { console.log(`（无 ${filter || ''} 记录）`); return; }
  console.log(`共 ${items.length} 条:`);
  for (const d of items) {
    console.log(`  ${d.id} [${d.type}] ${d.target} | ${d.proposed.slice(0, 60)} | ${d.status}`);
  }
}

function decide(id, action, noteText) {
  const data = readDecisions();
  const d = data.decisions.find(x => x.id === id);
  if (!d) { console.error(`❌ 无决策 ${id}（用 list 查看）`); process.exit(1); }
  if (d.status !== 'pending') { console.error(`❌ ${id} 已是 ${d.status}，不可重复决策`); process.exit(1); }

  // MID-6-fix: 统一 status 命名为 adopted/rejected（与 list 过滤器一致）
  const status = action === 'adopt' ? 'adopted' : 'rejected';
  d.status = status;
  d.decided_at = new Date().toISOString();
  d.decided_by = 'user';
  if (noteText) d.note = noteText;
  writeDecisions(data);
  console.log(`  ${id} → ${status} | ${d.target} | ${d.proposed.slice(0, 60)}`);
  if (status === 'adopted') {
    console.log('\n📌 提示: 决策已记录。如需生效到 harness 行为（如改阈值/加豁免），请按 S1-S7 流水线另行实施。');
  }
}

switch (cmd) {
  case 'list': list(); break;
  case 'pending': list('pending'); break;
  case 'adopted': list('adopted'); break;
  case 'rejected': list('rejected'); break;
  default: {
    if (!cmd) { console.error('用法: node scripts/adopt-rule.cjs <id> [adopt|reject] [--note 原因] | list | pending'); process.exit(1); }
    const action = args[1];
    if (action !== 'adopt' && action !== 'reject') {
      console.error(`❌ 动作必须是 adopt 或 reject，收到: ${action}`);
      process.exit(1);
    }
    decide(cmd, action, note);
  }
}

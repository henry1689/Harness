/**
 * harness-manual-confirm.cjs — S6-B 人工验收确认 CLI（H-02）
 * ================================================================
 * 用法：
 *   node scripts/harness-manual-confirm.cjs list [change_key]            # 列出任务单（省略 key 则列出全部）
 *   node scripts/harness-manual-confirm.cjs confirm <change_key> <序号> <验收人> [备注]
 *   node scripts/harness-manual-confirm.cjs confirm-all <change_key> <验收人>
 *
 * 🔴 任务单按「变更指纹 change_key」寻址（非 run_id）——同一批文件重跑命中同一张单，
 *    这是「确认后重跑即放行」得以成立的前提。change_key 由 S6-B 门控输出给出。
 * 任务单目录：data/manual_tickets/<change_key>.json
 * 全部项确认后文件内 run_status 写 completed；重跑 harness_run_flow 时 S6-B 即放行 S7。
 */
'use strict';
const { existsSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const TICKETS = join(__dirname, '..', 'data', 'manual_tickets');
const pathFor = key => join(TICKETS, `${key}.json`);

function load(key) {
  const p = pathFor(key);
  if (!existsSync(p)) {
    console.error(`❌ 无任务单: ${p}`);
    console.error('   change_key 由 S6-B 门控输出（形如 ck_xxxxxxxxxxxxxxxx）；`list` 无参可列出全部。');
    process.exit(1);
  }
  return JSON.parse(readFileSync(p, 'utf-8'));
}
function save(t) {
  t.run_status = t.items.every(x => x.confirmed) ? 'completed' : 'await_manual_verification';
  t.updated_at = new Date().toISOString();
  writeFileSync(pathFor(t.change_key), JSON.stringify(t, null, 2), 'utf-8');
}
function render(t) {
  console.log(`任务单 ${t.change_key} | run=${t.run_id} | 生成于 ${t.generated_at} | 状态 ${t.run_status}`);
  t.items.forEach((it, i) =>
    console.log(`  [${it.confirmed ? '✓' : ' '}] ${i}. ${it.verify_item}${it.confirmed ? `  (验:${it.verifier}${it.confirmed_at ? ' @' + it.confirmed_at : ''})` : ''}`));
  const left = t.items.filter(x => !x.confirmed).length;
  console.log(left === 0 ? '  → 全部已确认，重跑 harness_run_flow 即放行 S7。' : `  → 仍待人工确认 ${left} 项。`);
}

const [cmd, key, idxRaw, verifier, ...noteParts] = process.argv.slice(2);

if (cmd === 'list') {
  if (key) { render(load(key)); process.exit(0); }
  if (!existsSync(TICKETS)) { console.log('（暂无任务单）'); process.exit(0); }
  const files = readdirSync(TICKETS).filter(f => f.endsWith('.json'));
  if (files.length === 0) { console.log('（暂无任务单）'); process.exit(0); }
  for (const f of files) {
    try { render(JSON.parse(readFileSync(join(TICKETS, f), 'utf-8'))); console.log(''); } catch { /* 跳过损坏文件 */ }
  }
} else if (cmd === 'confirm') {
  const t = load(key);
  const i = Number(idxRaw);
  if (Number.isNaN(i) || i < 0 || i >= t.items.length) { console.error(`❌ 非法序号 ${idxRaw}（有效 0..${t.items.length - 1}）`); process.exit(1); }
  const it = t.items[i];
  it.confirmed = true; it.confirmed_at = new Date().toISOString(); it.verifier = verifier || 'owner';
  if (noteParts.length) it.confirmed_note = noteParts.join(' ');
  save(t);
  const left = t.items.filter(x => !x.confirmed).length;
  console.log(`✅ 已确认 [${i}] ${it.verify_item}（验:${it.verifier}）；${left === 0 ? '全部完成 → 重跑 harness_run_flow 即放行 S7。' : `仍待人工 ${left} 项。`}`);
} else if (cmd === 'confirm-all') {
  const t = load(key);
  const who = verifier || 'owner';
  const at = new Date().toISOString();
  for (const it of t.items) { it.confirmed = true; it.confirmed_at = it.confirmed_at || at; it.verifier = it.verifier || who; }
  save(t);
  console.log(`✅ ${t.items.length} 项已全部确认（验:${who}）→ 重跑 harness_run_flow 即放行 S7。`);
} else {
  console.error('用法: list [change_key] | confirm <change_key> <序号> <验收人> [备注] | confirm-all <change_key> <验收人>');
  process.exit(1);
}

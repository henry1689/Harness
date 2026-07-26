/**
 * harness-pre-check.cjs �� Harness ǰ��ȫ������ Hook
 * �� .claude/settings.json �� PreToolUse hook ���á�
 */

'use strict';
var fs = require('fs');
var path = require('path');

var PROTECTED = ['src/harness','data/harness','.claude/settings.json','.claude/harness','.claude/workflows'];
var ROOT = path.resolve(__dirname, '..', '..');
var AUDIT_DIR = path.resolve(ROOT, 'data', 'harness', 'audit', 'selfguard');

try {
  var result = run();
  console.log(JSON.stringify(result));
} catch (fatalErr) {
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.writeFileSync(path.join(AUDIT_DIR, 'EMERGENCY_BLOCK_' + Date.now() + '.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), error: fatalErr.message || String(fatalErr),
      rule: 'PRE_HOOK_FAILSAFE' }, null, 2), 'utf-8');
  } catch (_) {}
  console.log(JSON.stringify({ decision: 'deny',
    reason: '\u{1f534} [Harness���Ի����������] ǰ��У��ű��쳣��������ǿ����ϡ�����: ' + (fatalErr.message || String(fatalErr)) }));
}

function run() {
  var raw = process.env.CLAUDE_TOOL_INPUT || '';
  var input = {};
  try { var parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') input = parsed; } catch (_) {}
  var fp = input.file_path || input.path || '';
  if (!fp) return { decision: 'allow' };
  var n = String(fp).replace(/\\/g, '/');
  for (var i = 0; i < PROTECTED.length; i++) {
    var p = PROTECTED[i];
    if (n.indexOf(p) === 0 || n.indexOf('/' + p) !== -1) {
      archive({ file: n, rule: p, input: raw.slice(0, 2000) });
      return { decision: 'deny',
        reason: '\u{1f534} [Harness���Ի�] ·��  ���б����� ��\n\n������ʩ�޸�ֻ����ͨ�� SelfGuard ������ˮ�ߡ�\n����ԽȨ�����ѹ鵵�� SelfGuard ���ڡ�' };
    }
  }
  return { decision: 'allow' };
}

function archive(detail) {
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    var today = new Date().toISOString().slice(0, 10);
    var dir = path.join(AUDIT_DIR, today);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'violation_' + Date.now() + '.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), source: 'harness-pre-check.cjs', rule: 'SELFGUARD_INTERCEPT', detail: detail }, null, 2), 'utf-8');
  } catch (_) {}
}

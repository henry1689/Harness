/**
 * harness-post-check.cjs �� Harness ����У�� Hook
 */
'use strict';
var fs = require('fs');
var path = require('path');

var PROTECTED = ['src/harness','data/harness','.claude/settings.json','.claude/harness','.claude/workflows'];
var ROOT = path.resolve(__dirname, '..', '..');
var AUDIT_DIR = path.resolve(ROOT, 'data', 'harness', 'audit', 'selfguard');

try {
  var raw = process.env.CLAUDE_TOOL_INPUT || '';
  var input = {};
  try { var parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') input = parsed; } catch (_) {}
  var fp = input.file_path || input.path || '';
  if (!fp) { console.log(JSON.stringify({ description: '' })); process.exit(0); }
  var n = String(fp).replace(/\\/g, '/');
  var hit = false;
  for (var i = 0; i < PROTECTED.length; i++) {
    if (n.indexOf(PROTECTED[i]) === 0 || n.indexOf('/' + PROTECTED[i]) !== -1) { hit = true; break; }
  }
  if (hit) {
    try {
      if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
      var today = new Date().toISOString().slice(0, 10);
      var dir = path.join(AUDIT_DIR, today);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'post_change_' + Date.now() + '.json'),
        JSON.stringify({ timestamp: new Date().toISOString(), source: 'harness-post-check.cjs', event: 'HARNESS_FILE_MODIFIED', file: n }, null, 2), 'utf-8');
    } catch (_) {}
    console.log(JSON.stringify({ description: '\u{1f534} [SelfGuard] ������ʩ�ļ�  �ѱ������¼��д�� SelfGuard ���ڡ�' }));
  } else {
    console.log(JSON.stringify({ description: '' }));
  }
} catch (err) {
  console.log(JSON.stringify({ description: '' }));
}

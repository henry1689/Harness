#!/usr/bin/env node
/**
 * health-check.cjs — Harness 健康检查 + 自动修复
 * ===============================================
 * 用法: node scripts/health-check.cjs [--fix]
 *   --fix : 发现问题时自动重启
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const FIX = process.argv.includes('--fix');
const MCP_PORT = 8765;
const HEARTBEAT_FILE = path.join(__dirname, '..', 'data', 'heartbeat.json');
const TOKEN_DIR = path.join(__dirname, '..', 'data', 'tokens');
const PROJECT_ROOT = 'D:/tools/wenstar-cc';

let ok = 0, fail = 0;

function check(label, fn) {
  try {
    const r = fn();
    console.log(`  [OK] ${label}: ${r}`);
    ok++;
    return true;
  } catch (e) {
    console.log(`  [FAIL] ${label}: ${e.message}`);
    fail++;
    return false;
  }
}

function fix(label, fn) {
  try {
    fn();
    console.log(`  [FIX] ${label}: done`);
    return true;
  } catch (e) {
    console.log(`  [FIX-ERR] ${label}: ${e.message}`);
    return false;
  }
}

console.log('=== Harness Health Check ===');
console.log('');

// 1. MCP Port
const portOk = check('MCP Port ' + MCP_PORT, () => {
  const out = execSync('netstat -ano | findstr ' + MCP_PORT, { timeout: 5000 }).toString().trim();
  if (!out.includes('LISTENING')) throw new Error('Not listening');
  return 'listening';
});

// 2. HTTP endpoint
if (portOk) {
  check('MCP HTTP /sentinel/check', () => {
    const result = httpGet('http://127.0.0.1:' + MCP_PORT + '/sentinel/check',
      { file: 'src/webui/chat.ts', project: 'wenstar-cc' });
    return JSON.stringify(result).substring(0, 80);
  });
}

// 3. Heartbeat freshness
check('Heartbeat freshness', () => {
  if (!fs.existsSync(HEARTBEAT_FILE)) throw new Error('File missing');
  const hb = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf-8'));
  const age = Math.round((Date.now() - hb.ts) / 1000);
  if (age > 300) throw new Error('Stale: ' + age + 's old');
  return age + 's ago, PID ' + hb.pid;
});

// 4. Token directory
check('Token directory', () => {
  if (!fs.existsSync(TOKEN_DIR)) throw new Error('Directory missing');
  const files = fs.readdirSync(TOKEN_DIR).filter(f => f.endsWith('.json'));
  return files.length + ' tokens';
});

// 5. Sentinel process
check('Sentinel process', () => {
  try {
    const out = execSync('wmic process where "name=\'node.exe\'" get CommandLine /format:csv', { timeout: 5000 }).toString();
    if (!out.includes('sentinel-service.cjs')) throw new Error('Not running');
    return 'running';
  } catch (e) {
    throw new Error('Not found: ' + e.message.substring(0, 40));
  }
});

// 6. PM2 daemon
check('PM2 daemon', () => {
  try {
    const out = execSync('npx pm2 jlist', { timeout: 8000, cwd: __dirname + '/..' }).toString();
    const list = JSON.parse(out);
    const mcp = list.find(a => a.name === 'harness-mcp');
    const sentinel = list.find(a => a.name === 'harness-sentinel');
    if (!mcp || !sentinel) throw new Error('Missing apps');
    return 'harness-mcp=' + mcp.pm2_env.status + ', harness-sentinel=' + sentinel.pm2_env.status;
  } catch (e) {
    throw new Error(e.message.substring(0, 60));
  }
});

// 7. Project git status
check('Project git clean', () => {
  const out = execSync('git diff --name-only', { timeout: 5000, cwd: PROJECT_ROOT }).toString().trim();
  const files = out.split('\n').filter(Boolean);
  const srcFiles = files.filter(f => f.startsWith('src/') && f.endsWith('.ts'));
  if (srcFiles.length > 0) return 'WARNING: ' + srcFiles.length + ' modified src files';
  return 'clean';
});

console.log('');
console.log('=== Result: ' + ok + '/' + (ok + fail) + ' checks passed ===');

// ── Auto-fix ──
if (FIX && fail > 0) {
  console.log('');
  console.log('=== Auto-fix ===');

  // Kill stale processes
  fix('Kill stale harness processes', () => {
    try {
      const out = execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv', { timeout: 5000 }).toString();
      const lines = out.split('\n');
      for (const l of lines) {
        if ((l.includes('harness') || l.includes('sentinel')) &&
            (l.includes('mcp') || l.includes('start.cjs') || l.includes('sentinel-service'))) {
          const parts = l.split(',');
          const pid = parts[parts.length - 1].trim();
          if (pid && /^\d+$/.test(pid)) {
            try { execSync('taskkill /F /PID ' + pid, { timeout: 3000 }); } catch(_) {}
          }
        }
      }
    } catch (_) {}
  });

  // Restart via PM2
  fix('PM2 resurrect', () => {
    execSync('npx pm2 resurrect', { timeout: 15000, cwd: __dirname + '/..' });
  });

  // If resurrect fails, start fresh
  fix('PM2 start ecosystem', () => {
    execSync('npx pm2 start ecosystem.config.cjs', { timeout: 15000, cwd: __dirname + '/..' });
  });

  console.log('');
  console.log('Re-running health check...');
  // The re-check will happen on next invocation
}

process.exit(fail > 0 ? 1 : 0);

// ── helpers ──
function httpGet(url, body) {
  const data = JSON.stringify(body);
  const options = {
    hostname: '127.0.0.1', port: MCP_PORT,
    path: '/sentinel/check', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    timeout: 3000,
  };
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

/**
 * fs-governance-shim.cjs — 进程内文件写审计层（v2.9 新增）
 * ======================================================================
 * 治理「进程内 fs.writeFileSync」盲区：hook 层只拦 Agent 工具调用，
 * node scripts/x.cjs 子进程内的写盘天然失明。本 shim 通过
 * NODE_OPTIONS=--require <shim> 注入，包装 fs 写函数：
 *   - 目标落在 src/ 高危清单 或 dist/ → 审计（谁写的/写哪/写什么）
 *   - 有 HARNESS_FS_GOV_TOKEN → 记录允许
 *   - 无 → 写 data/audit/fspass/ 审计 + 可选 deny（默认仅审计）
 *
 * 定位：审计层，非硬闸门（NODE_OPTIONS 可被攻击者剥掉；
 * 硬强制仍是 Sentinel 哈希基线 + src 回滚）。这是唯一能抓住写者的层。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HARNESS_DIR = path.resolve(__dirname, '..');
const AUDIT_DIR = path.join(HARNESS_DIR, 'data', 'audit', 'fspass');

// 是否硬拦（默认仅审计；显式 HARNESS_FS_GOV_DENY=1 才拦）
const DENY_ON = process.env.HARNESS_FS_GOV_DENY === '1';
const GOV_TOKEN = process.env.HARNESS_FS_GOV_TOKEN || '';

// src 高危清单（写这些目录的 src 需要审计）
// v2.9-fix: 覆盖更宽——src/ 下任何源码（.ts/.cjs/.mjs/.js，排除测试/临时）都应审计，
// 否则补丁脚本写 src/webui/server-chat-routes.ts 等任意文件都会漏。
const HIGH_RISK_SRC = ['src/app/knowledge/', 'src/m4/', 'src/m5/', 'src/engine/', 'src/core/', 'src/webui/', 'src/m2/'];

function isGoverned(absPath) {
  const n = String(absPath).replace(/\\/g, '/');
  if (n.includes('/dist/')) return true;
  // src/ 下源码文件（排除 .test.ts/.spec.ts/.d.ts/.tmp 等）
  const srcIdx = n.indexOf('/src/');
  if (srcIdx !== -1) {
    const rel = n.slice(srcIdx + 5);
    if (/\.(ts|tsx|cjs|mjs|js)$/.test(rel) && !/\.(test|spec)\./.test(rel) && !rel.includes('__tests__') && !rel.endsWith('.tmp')) {
      return true;
    }
  }
  for (const p of HIGH_RISK_SRC) {
    const np = String(p).replace(/\\/g, '/');
    if (n.includes(np)) return true;
  }
  return false;
}

function audit(target, fnName, action) {
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.writeFileSync(path.join(AUDIT_DIR, `fs_${Date.now()}_${crypto.randomBytes(2).toString('hex')}.json`),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'FS_GOV',
        fn: fnName,
        target,
        action, // allowed(token) / audited(no-token) / denied
        pid: process.pid,
      }, null, 2));
  } catch (_) {}
}

// 包装写函数
for (const fn of ['writeFileSync', 'appendFileSync']) {
  const orig = fs[fn];
  if (typeof orig !== 'function') continue;
  fs[fn] = function (file, ...rest) {
    const abs = path.resolve(String(file));
    if (isGoverned(abs)) {
      if (GOV_TOKEN) {
        audit(abs, fn, 'allowed(token)');
      } else if (DENY_ON) {
        audit(abs, fn, 'denied');
        throw new Error(`[fs-governance-shim] 拒绝写治理路径: ${abs} (无 HARNESS_FS_GOV_TOKEN)`);
      } else {
        audit(abs, fn, 'audited(no-token)');
      }
    }
    return orig.apply(fs, [file, ...rest]);
  };
}

// 异步 writeFile 也包装（可选，writeFileSync 已覆盖多数补丁脚本）
const origWrite = fs.writeFile;
if (typeof origWrite === 'function') {
  fs.writeFile = function (file, ...rest) {
    const abs = path.resolve(String(file));
    if (isGoverned(abs) && !GOV_TOKEN && DENY_ON) {
      audit(abs, 'writeFile', 'denied');
      return Promise.reject(new Error(`[fs-governance-shim] 拒绝写治理路径: ${abs}`));
    }
    return origWrite.apply(fs, [file, ...rest]);
  };
}

// 导出元信息（供诊断）
module.exports = { isGoverned, HIGH_RISK_SRC };

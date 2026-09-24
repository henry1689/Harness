#!/usr/bin/env node
/**
 * agent-guard.cjs — Harness 失控 Agent 进程行为管控守护进程 v1.1
 * ================================================================
 * Harness 补齐「进程行为」管控维度：自动识别并终止失控的 AI Agent（claude.exe）。
 *
 * 失控定义: 某个 claude.exe 在窗口期(180s)内反复 spawn 同一「命令型」子进程
 *          (vitest/tsc/npx/npm/start.cjs/webui-server 等) ≥ N 次 —— 即陷入
 *          「反复执行同一操作」的循环，导致 cmd 窗口持续闪屏。
 *
 * 处置: taskkill /F /T /PID <claude.exe>（杀整个进程树）。
 *
 * 安全护栏（v1.1 按 S4 评审修复 4 个误杀风险）:
 *   - 只识别「命令型」进程（vitest/tsc/npx/npm/start.cjs/webui-server/tsx），
 *     排除 node/bash/powershell 等执行器/中间层 → 不再把正常子进程当弹窗型
 *   - 命令签名准确归一化，'other'（无法归类）不计入「同命令」 → 不同命令不坍缩
 *   - 跨扫描累计（非快照）：瞬发即退的 vitest 也能被累计检测
 *   - 全局 kill 上限：每小时最多 kill 3 次，超限进入全局冷却 → 防 kill→重启→再杀循环
 *   - 每次 kill 前写审计日志 data/agent-guard-audit.jsonl
 *   - 白名单: HARNESS_GUARD_EXCLUDE_PIDS 环境变量(逗号分隔 pid)
 *
 * 模式: 纯系统级 WMI 枚举 + taskkill，零 LLM，零 token。
 * 启动: node scripts/agent-guard.cjs [--dry-run]   (dry-run 只检测不 kill)
 * PM2:  pm2 start ecosystem.config.cjs（harness-agent-guard 进程）
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HARNESS_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(HARNESS_ROOT, 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const AUDIT_LOG = path.join(DATA_DIR, 'agent-guard-audit.jsonl');
const HEARTBEAT_FILE = path.join(DATA_DIR, 'agent-guard-heartbeat.json');

const DRY_RUN = process.argv.includes('--dry-run');

// ── 可调阈值 ──
const SCAN_INTERVAL_MS = 10_000;      // 扫描间隔 10s
const WINDOW_MS = 180_000;            // 判定窗口 180s
const MAX_KILL_PER_HOUR = 3;          // 全局每小时最多 kill 3 次（防 kill→重启→再杀循环）

/**
 * 🔴 2026-09-23 D3：分级阈值（原为单一 MIN_SAME_CMD = 4）。
 *
 * 原实现对所有「命令型」子进程用同一个阈值 4 次/180s，而处置是
 * `taskkill /F /T` —— **杀掉整个 claude.exe 进程树**，代价是用户整个会话连同未提交的工作。
 *
 * 问题在于 `tsc` / `vitest` / `tsx` / `npx` 这些是**正常开发反复调用**的命令
 * （编译 → 测试 → 跑起来，180 秒内各来几次是常态），4 次阈值必然误伤。
 * 实证 `data/agent-guard-audit.jsonl`：「npx:tsc x4」「npx:vitest x4」「npx:tsx x4」
 * 的击杀记录已成模式 —— 被杀的都是正常干活，不是失控。
 *
 * 故按语义分两类：
 *   - **窗口创建型**（start.cjs / webui-server）：反复拉起会真的弹控制台窗口 / 起常驻进程，
 *     这正是当初引入本守护的原因，阈值维持 4（不放宽原始意图）。
 *   - **构建型**（tsc / vitest / tsx / npx / npm）：只有真正的死循环才会到几十次，
 *     阈值 25（≈180 秒内每 7 秒一次）。这是**精度修正，不是放宽防护** ——
 *     真失控的 Agent 远超这个量级，而正常工作不会。
 *   - 其余（script:* 等）：取中间值 8。
 */
const MIN_SPAWN_WINDOW = 4;           // 窗口创建型：4 次即判失控
const MIN_SPAWN_BUILD = 25;           // 构建型：25 次才算死循环
const MIN_SPAWN_DEFAULT = 8;          // 其他脚本类

/** 窗口创建型签名（与 normalizeCmd 的返回值对齐） */
const WINDOW_SPAWNER_SIGS = ['start.cjs', 'webui-server'];
/** 构建型签名前缀 */
const BUILD_SIG_PREFIXES = ['vitest:', 'tsc:', 'tsx:', 'npx:', 'npm:'];

/** 该签名对应的失控阈值 */
function limitFor(sig) {
  if (WINDOW_SPAWNER_SIGS.includes(sig)) return MIN_SPAWN_WINDOW;
  if (BUILD_SIG_PREFIXES.some(p => sig.startsWith(p))) return MIN_SPAWN_BUILD;
  return MIN_SPAWN_DEFAULT;
}

// 白名单 pid（环境变量 HARNESS_GUARD_EXCLUDE_PIDS，逗号分隔）
const EXCLUDE_PIDS = new Set(
  (process.env.HARNESS_GUARD_EXCLUDE_PIDS || '')
    .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
);

// ── 「命令型」关键词 —— 只识别真正会失控反复执行的命令，排除 node/bash 等执行器 ──
const COMMAND_KEYWORDS = ['vitest', 'tsc', 'npx', 'npm', 'start.cjs', 'webui/server', 'tsx'];

// ── 命令签名归一化: 提取「命令 + 目标」，用于判断「同一命令」──
function normalizeCmd(cmdline) {
  const c = (cmdline || '').replace(/\\/g, '/');
  let m;
  if ((m = c.match(/vitest\.mjs[^\s]*\s+(run[^\s]*\s+)?([^\s"'|]+)/))) return 'vitest:' + m[2];
  if ((m = c.match(/start\.cjs/))) return 'start.cjs';
  if ((m = c.match(/npx\s+([^\s"'|]+)/))) return 'npx:' + m[1];
  if ((m = c.match(/npm\s+([^\s"'|]+)/))) return 'npm:' + m[1];
  if ((m = c.match(/webui\/server\.ts/))) return 'webui-server';
  if ((m = c.match(/tsx[^\s]*\s+(?:dist\/cli\.mjs\s+)?([^\s"'|]+)/))) return 'tsx:' + m[1];
  if ((m = c.match(/tsc[^\s]*\s+([^\s"'|]+)?/))) return 'tsc:' + (m[1] || '');
  // 改进兜底: 提取第一个脚本文件名（不要求行尾）
  if ((m = c.match(/([A-Za-z0-9_.-]+\.(?:cjs|mjs|js|ts))/))) return 'script:' + m[1];
  return 'other'; // 无法归类 —— 不计入「同命令」判定
}

/** 是否「命令型」进程（真正的命令执行者，非执行器/中间层） */
function isCommandProcess(proc) {
  if (proc.name === 'claude.exe') return false;
  const c = (proc.cmdline || '').toLowerCase();
  return COMMAND_KEYWORDS.some(k => c.includes(k.toLowerCase()));
}

// ── WMI 枚举全进程 ──
const PS_ENUM = [
  "$ErrorActionPreference='SilentlyContinue';",
  "Get-CimInstance Win32_Process | ForEach-Object {",
  "  $cmd = if($_.CommandLine){ $_.CommandLine -replace '\\|','/' } else { '' }",
  "  '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $_.CreationDate.ToUniversalTime().Subtract([datetime]::new(1970,1,1)).TotalMilliseconds, $cmd",
  "}",
].join(' ');

function enumProcesses() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', PS_ENUM], {
    encoding: 'utf-8', windowsHide: true, timeout: 15000, maxBuffer: 30 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) return [];
  const procs = [];
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split('|');
    if (parts.length < 5) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    if (isNaN(pid) || isNaN(ppid)) continue;
    procs.push({
      pid, ppid,
      name: parts[2] || '',
      creationMs: parseFloat(parts[3]) || 0,
      cmdline: parts.slice(4).join('|'),
    });
  }
  return procs;
}

// ── 进程树: 构建 claude.exe → 后代映射 ──
function buildDescendants(procs) {
  const claudes = procs.filter(p => p.name === 'claude.exe' && !EXCLUDE_PIDS.has(p.pid));
  const descendants = new Map();

  for (const claude of claudes) {
    const seen = new Set([claude.pid]);
    const queue = [claude.pid];
    const set = new Set();
    while (queue.length) {
      const pid = queue.shift();
      for (const p of procs) {
        if (p.ppid === pid && !seen.has(p.pid)) {
          seen.add(p.pid);
          set.add(p);
          queue.push(p.pid);
        }
      }
    }
    descendants.set(claude, set);
  }
  return descendants;
}

// ── 跨扫描累计: Map<claudeKey, Map<cmdSig, Map<procKey, creationMs>>> ──
const spawnHistory = new Map();

// ── 全局 kill 上限（防 kill→重启→再杀循环）──
const killTimes = []; // 最近 kill 的时间戳数组
let globalCooldownUntil = 0;
let killCountToday = 0;

function canKill() {
  const now = Date.now();
  if (now < globalCooldownUntil) return false;
  // 清理 1 小时外的 kill 记录
  while (killTimes.length && now - killTimes[0] > 3600_000) killTimes.shift();
  return killTimes.length < MAX_KILL_PER_HOUR;
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  console.error(`[agent-guard] ${msg}`);
  try { fs.appendFileSync(path.join(LOG_DIR, 'agent-guard-error.log'), line + '\n'); } catch (_) {}
}

function audit(action, detail) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: Date.now(), action, ...detail }) + '\n');
  } catch (_) {}
}

function killTree(pid) {
  try {
    const r = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      encoding: 'utf-8', windowsHide: true, timeout: 15000,
    });
    return { ok: r.status === 0, out: (r.stdout || r.stderr || '').trim().slice(0, 200) };
  } catch (e) {
    return { ok: false, out: String(e.message).slice(0, 200) };
  }
}

function check() {
  const now = Date.now();
  const procs = enumProcesses();
  if (!procs.length) { log('⚠️ WMI 枚举为空，跳过本轮'); return; }

  const descendants = buildDescendants(procs);
  const liveClaudeKeys = new Set();
  const agentStats = [];

  for (const [claude, set] of descendants) {
    const claudeKey = `${claude.pid}:${claude.creationMs}`;
    liveClaudeKeys.add(claudeKey);

    if (!spawnHistory.has(claudeKey)) spawnHistory.set(claudeKey, new Map());
    const sigMap = spawnHistory.get(claudeKey);

    // 累计本次扫描发现的「命令型」子进程
    for (const p of set) {
      if (!isCommandProcess(p)) continue;
      const sig = normalizeCmd(p.cmdline);
      if (sig === 'other') continue; // 无法归类 → 不计入同命令判定
      if (!sigMap.has(sig)) sigMap.set(sig, new Map());
      const procKey = `${p.pid}:${p.creationMs}`;
      sigMap.get(sig).set(procKey, p.creationMs);
    }

    // 清理窗口期外的记录
    const cutoff = now - WINDOW_MS;
    for (const [sig, procMap] of sigMap) {
      for (const [procKey, ts] of procMap) {
        if (ts < cutoff) procMap.delete(procKey);
      }
      if (procMap.size === 0) sigMap.delete(sig);
    }

    // 判定: 窗口期内同一命令累计 spawn ≥ 该【命令类别】的阈值（见 limitFor）
    let rogueSig = null;
    let rogueCount = 0;
    let rogueLimit = 0;
    for (const [sig, procMap] of sigMap) {
      const limit = limitFor(sig);
      if (procMap.size >= limit && procMap.size > rogueCount) {
        rogueCount = procMap.size; rogueSig = sig; rogueLimit = limit;
      }
    }

    agentStats.push({ pid: claude.pid, sigCount: sigMap.size, top: rogueSig, topCount: rogueCount });

    if (!rogueSig) continue;

    // 判定失控
    const detail = {
      pid: claude.pid,
      reason: `窗口 ${WINDOW_MS / 1000}s 内「${rogueSig}」累计 spawn ${rogueCount} 次（该类阈值 ${rogueLimit}）`,
      sigSnapshot: [...sigMap.entries()].map(([k, v]) => `${k}x${v.size}`).join(', '),
    };

    if (DRY_RUN) {
      log(`🔍 [DRY-RUN] 判定失控 claude.exe PID ${claude.pid}: ${detail.reason}`);
      audit('DRY_RUN', detail);
      continue;
    }

    if (!canKill()) {
      log(`⏸️ 全局 kill 上限已达（每小时 ${MAX_KILL_PER_HOUR} 次），跳过 PID ${claude.pid}，仅告警`);
      audit('SKIP_COOLDOWN', detail);
      continue;
    }

    log(`🚨 失控 Agent: claude.exe PID ${claude.pid} — ${detail.reason}，终止进程树...`);
    audit('KILL', detail);
    const r = killTree(claude.pid);
    if (r.ok) {
      killTimes.push(now);
      killCountToday++;
      spawnHistory.delete(claudeKey); // 已杀，清历史
      log(`✅ 已终止 claude.exe PID ${claude.pid} 进程树（今日累计 ${killCountToday} 次）`);
      audit('KILLED', { pid: claude.pid, out: r.out });
    } else {
      log(`❌ 终止失败 PID ${claude.pid}: ${r.out}`);
      audit('KILL_FAIL', { pid: claude.pid, out: r.out });
    }
  }

  // 清理已死 claude 的历史（防内存泄漏）
  for (const key of spawnHistory.keys()) {
    if (!liveClaudeKeys.has(key)) spawnHistory.delete(key);
  }

  writeHeartbeat(agentStats, procs.length);
}

// ── 心跳（供看板展示）──
let tickCount = 0;
function writeHeartbeat(agentStats, totalProcs) {
  tickCount++;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({
      ts: Date.now(),
      tick: tickCount,
      mode: DRY_RUN ? 'dry-run' : 'live',
      agents: agentStats.length,
      totalProcs,
      killCountToday,
      agentsDetail: agentStats.map(a => ({ pid: a.pid, sigs: a.sigCount, top: a.top, topCount: a.topCount })),
    }));
  } catch (_) {}
}

// ── 启动 ──
console.error(`[agent-guard] 🛡️ Harness 失控 Agent 管控守护进程已启动 (PID: ${process.pid})`);
console.error(`[agent-guard]   扫描间隔: ${SCAN_INTERVAL_MS / 1000}s, 窗口: ${WINDOW_MS / 1000}s, 阈值: 窗口创建型≥${MIN_SPAWN_WINDOW} / 构建型≥${MIN_SPAWN_BUILD} / 其他≥${MIN_SPAWN_DEFAULT}`);
console.error(`[agent-guard]   全局 kill 上限: ${MAX_KILL_PER_HOUR} 次/小时`);
console.error(`[agent-guard]   模式: ${DRY_RUN ? '🔍 DRY-RUN(只检测不杀)' : '🔴 LIVE(自动 kill)'}`);
console.error(`[agent-guard]   白名单 pid: ${EXCLUDE_PIDS.size ? [...EXCLUDE_PIDS].join(',') : '(无)'}`);
console.error(`[agent-guard]   纯系统级 WMI + taskkill，零 LLM，零 token`);

check();
setInterval(check, SCAN_INTERVAL_MS);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

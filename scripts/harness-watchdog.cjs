#!/usr/bin/env node
/**
 * harness-watchdog.cjs — Harness 链路自愈看门狗 v1.0
 * ===================================================
 * 独立常驻进程，每 20 秒检测三条链路是否断链（心跳过期）：
 *
 *   链路 1: MCP      — data/heartbeat.json        (MCP server.ts 每5s写)
 *   链路 2: Sentinel — data/sentinel-heartbeat.json (sentinel-service.cjs 每30s写)
 *   链路 3: Hook     — data/hook-heartbeat.json     (harness-pre-check.cjs 每次判定写)
 *
 * 断链检测 → 尝试 PM2 重启 → 记录自愈日志。
 * 心跳本身每 20 秒检查，20 秒内三次检查确认断链才重启（防抖动）。
 *
 * 启动: node scripts/harness-watchdog.cjs
 * PM2: pm2 start ecosystem.config.cjs（harness-watchdog 进程）
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HARNESS_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(HARNESS_ROOT, 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const HEAL_LOG = path.join(DATA_DIR, 'heal-log.jsonl');

// 心跳文件 → 对应 PM2 进程名 → 心跳允许过期秒数
// v2.9.2-fix: MCP timeoutSec 20→120 / Sentinel 45→90。
// 根因: harness_run_flow 收敛评估等长操作会阻塞 MCP 心跳更新(单线程)→心跳停更>60s
// → watchdog 连续3次确认→pm2 restart harness-mcp(heal-log 实证08-12 03:57/17:10/18:13
// 心跳过期76s/73s/114s反复重启)→开发跑flow时「一阵子爆发」闪屏。
// 提升后覆盖长操作余量，且 CONFIRM_ROUNDS=3(60s)防抖保留。
// v3.1-lock(2026-09-11): 增加 lockPrefix —— 判定「该链路是否正在启动/运行」。
// 背景: MCP 冷启动 = tsc 前置校验(~37s) + 子进程启动(~50s) ≈ 90~100s，而下面 timeoutSec 仅 120s，
// 余量太薄且机器一忙就穿透 → watchdog 把**正在启动**的 MCP 当断链杀掉 → 重启又要 90s →
// 自增强循环（heal-log 实测 18:14~18:16 连续两轮）。看门狗自己的注释记载过这正是历史「闪屏」
// 根因（当年把超时 20→120），但没解决根本问题：它判的是「心跳陈旧」，而非「有无实例在启动」。
// 现在先读单实例锁：锁新鲜 = 有实例正在启动或运行 → 绝不重启。比加大超时更准（知道意图而非猜测）。
const LINKS = [
  { name: 'MCP',      hb: 'heartbeat.json',            pm2Name: 'harness-mcp',      timeoutSec: 120, lockPrefix: 'start-' },
  { name: 'Sentinel', hb: 'sentinel-heartbeat.json',    pm2Name: 'harness-sentinel', timeoutSec: 90,  lockPrefix: 'sentinel-' },
  { name: 'Hook',     hb: 'hook-heartbeat.json',        pm2Name: null,               timeoutSec: 600, lockPrefix: null }, // hook 无独立进程，仅告警
];

/** 锁目录与新鲜度阈值（与 mcp/start.cjs、sentinel/sentinel-service.cjs 的 LOCK_STALE_MS 一致） */
const LOCK_DIR = path.join(DATA_DIR, 'mcp-watchdog');
const LOCK_STALE_MS = 60_000;

/** 该前缀下是否存在「新鲜」的锁（持有者每 15s 刷 mtime，60s 内即视为活着/正在启动） */
function hasFreshLock(prefix) {
  if (!prefix) return false;
  try {
    for (const f of fs.readdirSync(LOCK_DIR)) {
      if (!f.startsWith(prefix) || !f.endsWith('.lock')) continue;
      try {
        if ((Date.now() - fs.statSync(path.join(LOCK_DIR, f)).mtimeMs) < LOCK_STALE_MS) return true;
      } catch (_) { /* 单个锁读不到不影响其他 */ }
    }
  } catch (_) { /* 锁目录不存在 = 尚未引入锁机制，退化为原行为 */ }
  return false;
}

const CHECK_INTERVAL_MS = 20_000;
const CONFIRM_ROUNDS = 3; // 连续 3 次(60s)确认断链才重启，防抖动

/** 心跳文件年龄（秒）。不存在 = Infinity */
function hbAge(hbFile) {
  try {
    const p = path.join(DATA_DIR, hbFile);
    if (!fs.existsSync(p)) return Infinity;
    const st = fs.statSync(p);
    return (Date.now() - st.mtimeMs) / 1000;
  } catch (_) { return Infinity; }
}

/** PM2 重启进程 */
function pm2Restart(pm2Name) {
  try {
    const out = execSync(`pm2 restart ${pm2Name}`, { encoding: 'utf-8', timeout: 15000, windowsHide: true });
    return { ok: true, out: out.split('\n').filter(l => l.includes(pm2Name)).join(' ').slice(0, 200) };
  } catch (e) {
    return { ok: false, out: String(e.message).slice(0, 200) };
  }
}

/** 追加自愈日志 */
function logHeal(link, action, detail) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(HEAL_LOG, JSON.stringify({
      ts: Date.now(),
      link: link.name,
      action,
      detail,
    }) + '\n', 'utf-8');
    console.error(`[watchdog] ${link.name}: ${action} — ${detail}`);
  } catch (_) {}
}

// 断链连续计数
const failCounts = {};
const recovering = {};

/** 🐶 看门狗自身心跳状态文件 — 持续递增 tick 证明 watchdog 活着（供看板实时展示） */
const WD_HEARTBEAT_FILE = path.join(DATA_DIR, 'watchdog-heartbeat.json');
let tickCount = 0;
let lastTickTs = 0;

/** Hook 安装探测 — 检查 hook 脚本存在 + settings.json 配置正确。
 *  无 Edit/Write 活动 ≠ 断链；Hook 链路健康 = "已安装且可调用"。 */
function probeHook() {
  const preScript = path.join(HARNESS_ROOT, '.claude', 'harness-pre-check.cjs');
  const postScript = path.join(HARNESS_ROOT, '.claude', 'harness-post-check.cjs');
  const usrSettings = path.join(HARNESS_ROOT, '..', '..', 'Users', 'henry', '.claude', 'settings.json');
  const projectSettings = path.join('D:/tools/wenstar-cc/.claude/settings.json');

  const probe = {
    pre_exists: fs.existsSync(preScript),
    post_exists: fs.existsSync(postScript),
    pre_syntax: true,
    post_syntax: true,
    user_hook_configured: false,
    project_hook_configured: false,
  };

  // 语法检查（纯 node 无 LLM）
  for (const [k, f] of [['pre_syntax', preScript], ['post_syntax', postScript]]) {
    try {
      execSync(`node --check "${f}"`, { timeout: 8000, windowsHide: true, stdio: 'ignore' });
    } catch (_) { probe[k] = false; }
  }

  // settings.json 是否配置了 pre-check hook
  try {
    for (const s of [usrSettings, projectSettings]) {
      if (!fs.existsSync(s)) continue;
      const cfg = JSON.parse(fs.readFileSync(s, 'utf-8'));
      const hasHook = JSON.stringify(cfg.hooks || {}).includes('harness-pre-check.cjs');
      if (s.includes('Users')) probe.user_hook_configured = hasHook;
      else probe.project_hook_configured = hasHook;
    }
  } catch (_) {}

  return probe;
}

/** 写 watchdog 心跳 + tick 递增（每 20s +1，看板可见的"活数据"） */
function writeWatchdogHeartbeat() {
  tickCount++;
  lastTickTs = Date.now();
  const probe = probeHook();
  const hookAlive = probe.pre_exists && probe.post_exists && probe.pre_syntax && probe.post_syntax &&
    (probe.user_hook_configured || probe.project_hook_configured);
  const now = Date.now();
  const snapshot = {
    ts: now,
    tick: tickCount,
    links: LINKS.map(l => ({ name: l.name, hb: l.hb, age: Math.round(hbAge(l.hb)), timeout: l.timeoutSec })),
    hook: { ...probe, alive: hookAlive },
    pm2: LINKS.filter(l => l.pm2Name).map(l => ({ name: l.pm2Name, pm2Age: Math.round(hbAge(l.hb)) })),
  };
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WD_HEARTBEAT_FILE, JSON.stringify(snapshot));
  } catch (_) {}
}

function check() {
  // Hook 链路：安装探测（非活动心跳）
  const hookProbe = probeHook();
  const hookAlive = hookProbe.pre_exists && hookProbe.post_exists && hookProbe.pre_syntax && hookProbe.post_syntax &&
    (hookProbe.user_hook_configured || hookProbe.project_hook_configured);

  // 🔴 2026-09-11 去形式化：原实现在「hook 已安装、语法正常、只是没活动」时每 20 秒写一条
  // IDLE 日志 —— 测得 heal-log.jsonl 中此类「什么都没发生」的记录达 44144 条（占全文件 99.9%）。
  // 正常静默不是事件，不该进事件日志。hook 状态仍由 writeWatchdogHeartbeat() 的 hook.alive
  // 字段实时供看板展示，信息不丢失，只是不再污染日志。
  if (!hookAlive) {
    logHeal({ name: 'Hook' }, 'BROKEN', `hook 链路断裂: ${JSON.stringify(hookProbe)}`);
  }

  // MCP / Sentinel：活动心跳检测
  for (const link of LINKS) {
    if (!link.pm2Name) continue; // Hook 已单独处理
    const age = hbAge(link.hb);
    const stale = age > link.timeoutSec;

    if (stale) {
      failCounts[link.name] = (failCounts[link.name] || 0) + 1;
    } else {
      failCounts[link.name] = 0;
      recovering[link.name] = false;
      continue;
    }

    if (failCounts[link.name] < CONFIRM_ROUNDS) {
      logHeal(link, 'WARN', `心跳过期 ${Math.round(age)}s (${link.hb}) — 第 ${failCounts[link.name]}/${CONFIRM_ROUNDS} 次确认`);
      continue;
    }

    // 🔴 v3.1-lock: 锁新鲜 = 有实例正在启动或运行 → 心跳陈旧只是「还没起完」，不是断链，绝不重启。
    // 只记一次（不刷屏），避免每 20s 一条日志。
    if (hasFreshLock(link.lockPrefix)) {
      if (failCounts[link.name] === CONFIRM_ROUNDS) {
        logHeal(link, 'SKIP', `心跳过期 ${Math.round(age)}s，但单实例锁新鲜（实例正在启动/运行中）→ 跳过重启`);
      }
      continue;
    }

    if (recovering[link.name]) continue;

    recovering[link.name] = true;
    logHeal(link, 'HEAL', `检测到断链(心跳过期 ${Math.round(age)}s)，重启 ${link.pm2Name}...`);
    const r = pm2Restart(link.pm2Name);
    if (r.ok) {
      logHeal(link, 'RESTARTED', `${link.pm2Name} 重启指令已发出`);
      setTimeout(() => { recovering[link.name] = false; }, 60_000);
    } else {
      logHeal(link, 'HEAL_FAIL', `${link.pm2Name} 重启失败: ${r.out}`);
      setTimeout(() => { recovering[link.name] = false; }, 30_000);
    }
  }

  writeWatchdogHeartbeat();
}

// 启动
console.error(`[watchdog] 🐶 Harness 链路自愈看门狗已启动 (PID: ${process.pid})`);
console.error(`[watchdog]    检查间隔: ${CHECK_INTERVAL_MS / 1000}s, 确认阈值: ${CONFIRM_ROUNDS} 次(约${Math.round(CHECK_INTERVAL_MS * CONFIRM_ROUNDS / 1000)}s)`);
console.error(`[watchdog]    模式: 纯本地文件系统 + PM2 子进程，零 LLM 调用，零 token 消耗`);
check();
setInterval(check, CHECK_INTERVAL_MS);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

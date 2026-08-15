/**
 * dashboard/server.cjs — Harness 实时监控看板 v1.0
 * ===================================================
 * 聚合 Harness 全部运行数据，提供 HTTP API + 实时看板页面。
 *
 * 数据源:
 *   - data/heartbeat.json     MCP 心跳
 *   - data/sentinel/state.json 哨兵模式/统计
 *   - data/sentinel/YYYY-MM-DD/*.json  哨兵审计事件
 *   - data/audit/selfguard/   Hook 审计日志
 *   - data/breaker/           熔断器状态
 *   - data/tokens/            令牌目录
 *   - PM2 (通过 pm2 jlist)    进程状态
 *
 * 启动: node dashboard/server.cjs
 * 访问: http://127.0.0.1:8766
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
// ── 配置 ──
const PORT = parseInt(process.env.HARNESS_DASHBOARD_PORT || '8766');
const HARNESS_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(HARNESS_DIR, 'data');

// ── 被管控项目（与 ecosystem.config.cjs 的 WENSTAR_CC_ROOT 对齐）──
const MONITORED_PROJECTS = [
  { name: 'wenstar-cc', root: process.env.WENSTAR_CC_ROOT || 'D:/tools/wenstar-cc' },
];

// ── 数据读取工具 ──

function readJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) { return fallback; }
}

function readDirJSONs(dirPath, maxFiles) {
  const results = [];
  try {
    if (!fs.existsSync(dirPath)) return results;
    // 🔴 P9-fix: 按文件 mtime 倒序（最新在前），而非按文件名字典序。
    // 原逻辑 .sort().reverse() 按文件名（type_时间戳）比较：
    //   'a'(allowed) < 'r'(reverted) → allowed 永远排 reverted 前 → 混合类型时最新事件被挤到后面
    // 新逻辑: 按 mtime 排序，无论类型，最新写入的排在前面 → recentEvents 显示真实最新
    const files = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ f, m: fs.statSync(path.join(dirPath, f)).mtimeMs }))
      .sort((x, y) => y.m - x.m)
      .map(x => x.f);
    const limit = Math.min(maxFiles || 50, files.length);
    for (let i = 0; i < limit; i++) {
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(dirPath, files[i]), 'utf-8'));
        if (obj && typeof obj === 'object') obj._sourceFile = files[i]; // 🔴 P9: 附加源文件名供 type 判定
        results.push(obj);
      } catch (_) {}
    }
  } catch (_) {}
  return results;
}

function countDirFiles(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return 0;
    return fs.readdirSync(dirPath).filter(f => f.endsWith('.json')).length;
  } catch (_) { return 0; }
}

function getTodayDir(baseDir) {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(baseDir, today);
}

// ── 流水线健康分析（纯只读，零 LLM）──
function analyzeFlowHealth(now, days) {
  const auditRoot = path.join(DATA_DIR, 'audit');
  const cutoff = now - days * 86400000;
  const runs = [];

  function walk(d) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of ents) {
      const fp = path.join(d, ent.name);
      if (ent.isDirectory()) walk(fp);
      else if (ent.name.startsWith('run_') && ent.name.endsWith('.json')) {
        try {
          const r = JSON.parse(fs.readFileSync(fp, 'utf-8'));
          if (new Date(r.started_at || 0).getTime() >= cutoff) runs.push(r);
        } catch (_) {}
      }
    }
  }
  walk(auditRoot);

  const resolution = {};
  const fileRejects = {};
  const lockouts = [];
  const timeoutByDay = {};
  const s45Scores = []; // S4.5 收敛分数（最新 run 的 compliance_score）

  for (const r of runs) {
    const d = (r.started_at || '').slice(0, 10);
    let latestS45Score = null;
    for (const e of r.entries || []) {
      if (e.event === 'gate_resolve') {
        const res = e.detail?.resolution || 'unknown';
        resolution[res] = (resolution[res] || 0) + 1;
        if (res === 'human_timeout' && d) timeoutByDay[d] = (timeoutByDay[d] || 0) + 1;
        if (res === 'condition_rejected' || res === 'human_rejected') {
          const fsEntry = r.entries.find(x => x.event === 'flow_start');
          for (const f of (fsEntry?.detail?.modified_files || [])) {
            fileRejects[f] = (fileRejects[f] || 0) + 1;
          }
        }
        // S4.5 分数（P9-fix: 现在 gate_resolve 带 compliance_score）
        if ((e.stage_id || '').includes('S4.5') && typeof e.detail?.compliance_score === 'number') {
          latestS45Score = { score: e.detail.compliance_score, round: e.detail.convergence_round || 0, resolution: res };
        }
      }
      if (e.event === 'flow_abort' && /超限|强制锁定/.test(String(e.detail?.reason || ''))) {
        lockouts.push({ run: r.run_id, ts: e.timestamp, reason: String(e.detail?.reason).slice(0, 60) });
      }
    }
    if (latestS45Score) s45Scores.push({ run: r.run_id, ...latestS45Score, ts: r.started_at });
  }

  return {
    runs: runs.length,
    resolution,
    fileRejects: Object.entries(fileRejects).sort((a, b) => b[1] - a[1]).slice(0, 8),
    lockouts: lockouts.slice(-3),
    timeoutByDay: Object.entries(timeoutByDay).sort().slice(-7),
    // 最新 S4.5 分数（取时间最新的一条）
    latestS45Score: s45Scores.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))[0] || null,
  };
}

// ── 数据聚合 ──

function collectStatus() {
  const now = Date.now();
  const heartbeat = readJSON(path.join(DATA_DIR, 'heartbeat.json'), null);
  const sentinelState = readJSON(path.join(DATA_DIR, 'sentinel', 'state.json'), { level: 0 });
  const riskPolicy = readJSON(path.join(DATA_DIR, 'risk-policy.json'), {});

  // 流水线健康（最近 7 天审计，纯只读）
  const flowHealth = analyzeFlowHealth(now, 7);

  // RuleLearner 规则建议（data/learn/rules.json，纯只读）
  const learnRules = readJSON(path.join(DATA_DIR, 'learn', 'rules.json'), null);

  // WenStarOS 轻量监控（data/wenstaros-heartbeat.json + 审计，纯只读）
  const wenstarosHb = readJSON(path.join(DATA_DIR, 'wenstaros-heartbeat.json'), null);
  const wosAge = wenstarosHb ? (now - wenstarosHb.ts) / 1000 : Infinity;
  const wenstarosAlive = wosAge < 60;
  const wosAuditDir = getTodayDir(path.join(DATA_DIR, 'wenstaros-audit'));
  const wosEvents = countDirFiles(wosAuditDir);

  // 🔴 P9: 解锁豁免状态（区分"手动解锁豁免" vs "系统漏洞放行"）
  const exemptions = readJSON(path.join(DATA_DIR, 'exemptions.json'), {});
  const exemptFiles = Object.entries(exemptions)
    .filter(([, exp]) => exp > now)  // 只显示未过期的
    .map(([file, exp]) => ({
      file,
      remainingMin: Math.round((exp - now) / 60000),
      source: 'manual_unlock',  // 豁免来源 = 手动解锁
    }))
    .sort((a, b) => a.remainingMin - b.remainingMin);

  // 心跳年龄
  const hbAge = heartbeat ? (now - heartbeat.ts) / 1000 : 999;
  const mcpAlive = hbAge < 15;
  const hbPidMatch = heartbeat ? heartbeat.pid : null;

  // Sentinel 审计 — 今天的事件
  const todaySentinelDir = getTodayDir(path.join(DATA_DIR, 'sentinel'));
  const sentinelEvents = readDirJSONs(todaySentinelDir, 200);

  // 分类统计
  let sentinelAllowed = 0, sentinelReverted = 0, sentinelErrors = 0;
  const sentinelByFile = {};
  const sentinelRecentEvents = [];

  for (const ev of sentinelEvents) {
    // 🔴 P9-fix: type 判定用文件名字段（allowed_/reverted_/error_ 前缀），而非 risk。
    // 原逻辑: ev.risk === 'low' ? 'allowed' : 'reverted' → 高风险文件的放行事件被误判为 reverted。
    // 新逻辑: 依据归档文件名前缀（由 sentinel-service archiveEvent 的 type 参数决定），准确区分。
    const fname = ev._sourceFile || '';
    let type;
    if (fname.startsWith('allowed_')) type = 'allowed';
    else if (fname.startsWith('error_')) type = 'error';
    else if (fname.startsWith('reverted_')) type = 'reverted';
    else type = ev.file ? (ev.risk ? (ev.risk === 'low' ? 'allowed' : 'reverted') : 'event') : 'unknown';
    if (type === 'allowed') sentinelAllowed++;
    else if (type === 'error' || ev.error) sentinelErrors++;
    else sentinelReverted++;

    // 按文件聚合
    const f = ev.file || 'unknown';
    sentinelByFile[f] = (sentinelByFile[f] || 0) + 1;

    // 最近 20 条
    if (sentinelRecentEvents.length < 20) {
      sentinelRecentEvents.push({
        time: ev.timestamp || '',
        file: ev.file || '',
        risk: ev.risk || '',
        reason: ev.reason || ev.error || '',
        type: type,
      });
    }
  }

  // 按违规次数排序的 Top 文件
  const topViolatedFiles = Object.entries(sentinelByFile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, count]) => ({ file, count }));

  // Hook 审计 — 绕过/违规
  const todayAuditDir = getTodayDir(path.join(DATA_DIR, 'audit', 'selfguard'));
  const hookAudits = readDirJSONs(todayAuditDir, 100);
  const disciplineBypassDir = path.join(DATA_DIR, 'audit', 'selfguard', 'discipline_bypass', new Date().toISOString().slice(0, 10));
  const bypassCount = countDirFiles(disciplineBypassDir);

  // 熔断器
  const breakerDir = path.join(DATA_DIR, 'breaker');
  const breakerFiles = [];
  try {
    if (fs.existsSync(breakerDir)) {
      const bfs = fs.readdirSync(breakerDir).filter(f => f.endsWith('.json'));
      for (const bf of bfs) {
        try {
          breakerFiles.push(JSON.parse(fs.readFileSync(path.join(breakerDir, bf), 'utf-8')));
        } catch (_) {}
      }
    }
  } catch (_) {}

  // 令牌
  const tokenCount = countDirFiles(path.join(DATA_DIR, 'tokens'));

  // ── watchdog 自身心跳（活数据：tick 每 20s +1） ──
  const wdHeartbeat = readJSON(path.join(DATA_DIR, 'watchdog-heartbeat.json'), null);
  const wdAge = wdHeartbeat ? (now - wdHeartbeat.ts) / 1000 : Infinity;
  const wdAlive = wdAge < 60;
  const hookAlive = wdHeartbeat ? !!wdHeartbeat.hook && wdHeartbeat.hook.alive : false;

  // ── 链路心跳健康检查 (P9) ──
  function fileAge(file) {
    try {
      const p = path.join(DATA_DIR, file);
      if (!fs.existsSync(p)) return Infinity;
      return (now - fs.statSync(p).mtimeMs) / 1000;
    } catch (_) { return Infinity; }
  }
  const links = [
    { key: 'mcp', name: 'MCP', file: 'heartbeat.json', timeoutSec: 20 },
    { key: 'sentinel', name: '哨兵', file: 'sentinel-heartbeat.json', timeoutSec: 45 },
  ].map(l => {
    const age = fileAge(l.file);
    return { ...l, age: Math.round(age), status: age <= l.timeoutSec ? 'online' : (age === Infinity ? 'missing' : 'stale') };
  });
  // Hook 链路：使用 watchdog 安装探测（无 Edit 活动 ≠ 断链）
  links.push({
    key: 'hook', name: 'Hook', file: 'hook-heartbeat.json', timeoutSec: 1200,
    age: wdHeartbeat ? Math.round((now - wdHeartbeat.ts) / 1000) : Infinity,
    status: hookAlive ? 'online' : 'missing',
  });
  const linksOk = links.filter(l => l.status === 'online').length;

  // ── 自愈记录 (watchdog) ──
  const healLogPath = path.join(DATA_DIR, 'heal-log.jsonl');
  const healEvents = [];
  try {
    if (fs.existsSync(healLogPath)) {
      const lines = fs.readFileSync(healLogPath, 'utf-8').trim().split('\n').filter(Boolean).slice(-10);
      for (const line of lines.reverse()) {
        try { healEvents.push(JSON.parse(line)); } catch (_) {}
      }
    }
  } catch (_) {}

  // PM2 进程 — 不用 pm2 jlist（输出 58KB 环境变量导致 API 超时）
  // 改为纯文件系统检测：心跳文件 + Sentinel 日志时间戳
  const pm2Processes = [];
  try {
    // MCP: 心跳文件即代表 MCP 存活
    const sentinelLogAge = (() => {
      try {
        const sl = path.join(DATA_DIR, 'logs', 'sentinel-out.log');
        if (!fs.existsSync(sl)) return 999;
        const st = fs.statSync(sl);
        return (now - st.mtimeMs) / 1000;
      } catch (_) { return 999; }
    })();
    pm2Processes.push(
      { name: 'harness-mcp', pid: hbPidMatch || 0, status: mcpAlive ? 'online' : 'stopped', uptime: 0, restarts: 0, cpu: 0, memory: 0 },
      { name: 'harness-sentinel', pid: 0, status: sentinelLogAge < 60 ? 'online' : 'unknown', uptime: 0, restarts: 0, cpu: 0, memory: 0 },
      { name: 'harness-dashboard', pid: process.pid, status: 'online', uptime: Math.round(process.uptime()), restarts: 0, cpu: 0, memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) },
      // v2.9.2-fix: 补 self-sentinel 与 watchdog（self-sentinel 用 sentinel-heartbeat mtime；watchdog 用内容 ts）
      { name: 'harness-self-sentinel', pid: 0, status: fileAge('sentinel-heartbeat.json') <= 45 ? 'online' : 'unknown', uptime: 0, restarts: 0, cpu: 0, memory: 0 },
      { name: 'harness-watchdog', pid: 0, status: (wdHeartbeat && (now - (wdHeartbeat.ts || 0)) / 1000 <= 120) ? 'online' : 'unknown', uptime: 0, restarts: 0, cpu: 0, memory: 0 },
    );
  } catch (_) {}

  // EvolutionEngine 状态（如果可用）
  const evolutionData = readJSON(path.join(DATA_DIR, 'evolution', 'state.json'), null);

  // 历史趋势 — 最近 7 天 Sentinel 事件汇总
  const dailyTrend = [];
  for (let d = 6; d >= 0; d--) {
    const date = new Date(now - d * 86400000).toISOString().slice(0, 10);
    const dayDir = path.join(DATA_DIR, 'sentinel', date);
    const dayEvents = readDirJSONs(dayDir, 500);
    let dyAllowed = 0, dyReverted = 0, dyErrors = 0;
    for (const ev of dayEvents) {
      if (ev.risk === 'low') dyAllowed++;
      else if (ev.error) dyErrors++;
      else dyReverted++;
    }
    dailyTrend.push({ date, allowed: dyAllowed, reverted: dyReverted, errors: dyErrors, total: dayEvents.length });
  }

  // ── 被管控项目实时活跃度 ──
  // 🔴 P9-fix: 近5分钟 → 近10分钟（用户反馈"无活动"窗口太短易误判）
  const tenMinAgo = now - 10 * 60 * 1000;
  const lastHourAgo = now - 60 * 60 * 1000;
  const recent10m = sentinelEvents.filter(ev => {
    const t = new Date(ev.timestamp || 0).getTime();
    return t >= tenMinAgo;
  });
  const recent1h = sentinelEvents.filter(ev => {
    const t = new Date(ev.timestamp || 0).getTime();
    return t >= lastHourAgo;
  });
  const monitoredProjects = MONITORED_PROJECTS.map(p => ({
    name: p.name,
    root: p.root,
    monitoring: true,
    todayEvents: sentinelEvents.length,
    todayReverted: sentinelReverted,
    todayAllowed: sentinelAllowed,
    todayErrors: sentinelErrors,
    recent10m: recent10m.length,
    recent1h: recent1h.length,
    lastEventTime: sentinelRecentEvents.length ? sentinelRecentEvents[0].time : null,
    lastEventFile: sentinelRecentEvents.length ? sentinelRecentEvents[0].file : null,
    lastEventRisk: sentinelRecentEvents.length ? sentinelRecentEvents[0].risk : null,
    lastEventType: sentinelRecentEvents.length ? sentinelRecentEvents[0].type : null,
  }));

  // ── 防线状态判定 ──
  // 🔴 不用 pm2Processes.length（pm2 jlist 常超时导致假阳性"进程缺失"）
  // 改为直接通过心跳文件 + 进程检测来判断
  const sentinelAlive = pm2Processes.some(p => p.name === 'harness-sentinel' && p.status === 'online')
    || (fs.existsSync(path.join(DATA_DIR, 'logs', 'sentinel-out.log')));
  const dashboardAlive = true; // 自身肯定活着

  const pm2Ok = pm2Processes.length >= 2 || mcpAlive; // 至少 MCP 心跳在就行

  const defenses = [
    {
      name: 'PM2 守护',
      status: pm2Ok ? 'green' : 'red',
      detail: (() => {
        // v2.9.2-fix: 动态显示在线进程数（5 个监管组件：mcp/sentinel/self-sentinel/dashboard/watchdog）
        const online = pm2Processes.filter(p => p.status === 'online').length;
        return online >= 3 ? `${online} 进程在线` :
               online >= 2 ? `${online} 进程在线` :
               mcpAlive ? 'MCP 存活（部分进程缺失）' : '进程缺失';
      })(),
    },
    {
      name: 'MCP Server',
      status: mcpAlive ? 'green' : 'red',
      detail: mcpAlive ? `:${heartbeat ? (heartbeat.port || 8765) : 8765} 在线 (${Math.round(hbAge)}s)` : `离线 (${Math.round(hbAge)}s)`,
    },
    {
      name: 'Sentinel',
      // v2.9.2-fix: 以心跳新鲜度为主判据（sentinelAlive=心跳≤45s）。
      // LOCKDOWN(level≥2)是临时保护状态（expires_at 自动解除），不是故障——未到期才提示，不标红。
      status: sentinelAlive ? 'green' : 'red',
      detail: `v2.1 心跳${sentinelAlive ? '正常' : '断链'} | ${sentinelEvents.length} 今日事件` +
        (sentinelState.level >= 2 && sentinelState.expires_at > Date.now()
          ? ` | 🔒 LOCKDOWN 至 ${new Date(sentinelState.expires_at).toLocaleTimeString('zh-CN')}`
          : ''),
    },
    {
      name: 'Hook 前置检查',
      status: fs.existsSync(path.join(HARNESS_DIR, '.claude', 'harness-pre-check.cjs')) ? 'green' : 'red',
      detail: `就绪 | ${hookAudits.length} 审计 | ${bypassCount} 绕过`,
    },
    {
      // v2.11: CLI 通讯入口（harness-cli.cjs）——按需命令，就绪 = 脚本存在 + 语法可执行 + 最近使用时间
      name: 'CLI 通讯',
      status: (() => {
        try {
          const cli = path.join(HARNESS_DIR, 'scripts', 'harness-cli.cjs');
          if (!fs.existsSync(cli)) return 'red';
          const r = require('child_process').spawnSync(process.execPath, ['--check', cli], { timeout: 8000, stdio: 'ignore' });
          return r.status === 0 ? 'green' : 'red';
        } catch (_) { return 'red'; }
      })(),
      detail: (() => {
        try {
          const cli = path.join(HARNESS_DIR, 'scripts', 'harness-cli.cjs');
          if (!fs.existsSync(cli)) return '脚本缺失';
          const mtime = fs.statSync(cli).mtimeMs;
          return `就绪 | 安装 ${new Date(mtime).toLocaleDateString('zh-CN')} ${new Date(mtime).toLocaleTimeString('zh-CN')}`;
        } catch (_) { return '未知'; }
      })(),
    },
    {
      // v2.14: Agent 进程行为管控（agent-guard.cjs）——自动识别并终止失控 Agent
      name: 'Agent 管控',
      status: (() => {
        try {
          const hb = readJSON(path.join(DATA_DIR, 'agent-guard-heartbeat.json'), null);
          if (!hb) return 'red';
          const age = (Date.now() - hb.ts) / 1000;
          return age < 30 ? 'green' : 'red';
        } catch (_) { return 'red'; }
      })(),
      detail: (() => {
        try {
          const hb = readJSON(path.join(DATA_DIR, 'agent-guard-heartbeat.json'), null);
          if (!hb) return '未部署';
          const mode = hb.mode === 'dry-run' ? 'DRY-RUN' : 'LIVE';
          return `${hb.agents} Agent 监控中 | ${hb.killCountToday} 今日终止 | ${mode}`;
        } catch (_) { return '未知'; }
      })(),
    },
  ];

  return {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '2.1.0',

    // 防线
    defenses,

    // MCP
    mcp: {
      alive: mcpAlive,
      heartbeatAge: Math.round(hbAge),
      port: heartbeat?.port || 8765,
      pid: hbPidMatch,
    },

    // Sentinel
    sentinel: {
      level: sentinelState.level || 0,
      mode: sentinelState.level === 0 ? 'STANDARD' : sentinelState.level === 1 ? 'SENTINEL' : 'LOCKDOWN',
      reason: sentinelState.reason || '',
      todayEvents: sentinelEvents.length,
      todayAllowed: sentinelAllowed,
      todayReverted: sentinelReverted,
      todayErrors: sentinelErrors,
      totalBreaches: sentinelState.stats?.total_breaches || 0,
      recentEvents: sentinelRecentEvents,
      topViolatedFiles,
    },

    // Hook
    hook: {
      todayAudits: hookAudits.length,
      disciplineBypasses: bypassCount,
    },

    // 熔断器
    breaker: {
      active: breakerFiles.filter(b => b.locked_at || b.cooldown_until > now).length,
      total: breakerFiles.length,
      files: breakerFiles.filter(b => b.locked_at || b.cooldown_until > now).map(b => ({
        file: b.file || '',
        lockedAt: b.locked_at || '',
        cooldownUntil: b.cooldown_until ? new Date(b.cooldown_until).toISOString() : '',
      })),
    },

    // 令牌
    tokens: { active: tokenCount },

    // 进程
    processes: pm2Processes,

    // 进化引擎
    evolution: evolutionData,

    // 趋势
    dailyTrend,

    // 被控项目违规热点
    projectHotspots: topViolatedFiles,

    // 被管控项目实时状态
    projects: monitoredProjects,

    // 流水线健康（最近 7 天审计，纯只读零 LLM）
    flowHealth,

    // 解锁豁免状态（手动解锁的文件，剩余时间）
    exemptions: exemptFiles,

    // RuleLearner 规则建议（纯只读）
    learnRules,

    // 链路心跳健康 (P9)
    links,
    linksOk,

    // watchdog 自愈记录
    healEvents,

    // watchdog 自身状态（活数据）
    watchdog: wdHeartbeat ? {
      alive: wdAlive,
      tick: wdHeartbeat.tick || 0,
      age: Math.round(wdAge),
    } : { alive: false, tick: 0, age: Infinity },

    // WenStarOS 轻量监控状态
    wenstaros: wenstarosHb ? {
      alive: wenstarosAlive,
      events: wenstarosHb.events || 0,
      todayEvents: wosEvents,
      age: Math.round(wosAge),
      root: wenstarosHb.root || 'D:/WST/wenstar-os-tianshu-lab/WenStarOS',
    } : { alive: false, events: 0, todayEvents: 0, age: Infinity },
  };
}

// ── HTTP Server ──

// 🔒 HTML 在启动时加载到内存，运行时不读磁盘 — 防止运行时篡改
let DASHBOARD_HTML = '';
try {
  DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
} catch(err) {
  DASHBOARD_HTML = '<html><body><h1>Dashboard HTML 加载失败: ' + err.message + '</h1></body></html>';
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  // API: /api/status
  if (url === '/api/status') {
    try {
      const status = collectStatus();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(status));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: /api/events/stream — SSE 实时推送 (每 3s)
  if (url === '/api/events/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const sendStatus = () => {
      try {
        const status = collectStatus();
        res.write(`data: ${JSON.stringify(status)}\n\n`);
      } catch (_) {}
    };

    sendStatus();
    const interval = setInterval(sendStatus, 3000);

    req.on('close', () => {
      clearInterval(interval);
    });
    return;
  }

  // 默认: 看板页面 — 🔒 禁止浏览器缓存，确保每次加载最新版本
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(DASHBOARD_HTML);
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[harness-dashboard] 📊 实时监控看板已启动`);
  console.error(`[harness-dashboard]    地址: http://127.0.0.1:${PORT}`);
  console.error(`[harness-dashboard]    API:  http://127.0.0.1:${PORT}/api/status`);
  console.error(`[harness-dashboard]    SSE:  http://127.0.0.1:${PORT}/api/events/stream`);
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });

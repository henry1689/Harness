/**
 * sentinel-service.cjs — Harness 文件系统哨兵 (Sentinel) 主入口 v2.0
 * ====================================================================
 * 独立常驻进程，监控受管控项目的文件变更。
 * 未经授权（无令牌）的修改自动 git checkout 回滚。
 *
 * v2.0 更新:
 *   - 批量写入检测：500ms 窗口内聚合多次文件变更，统一处理
 *   - 异步回滚：支持 Git 锁竞争重试（指数退避）
 *   - 批量回滚：同一批次文件按顺序回滚，互不阻塞
 *
 * 启动方式:
 *   node sentinel/sentinel-service.cjs                                    # 默认配置
 *   node sentinel/sentinel-service.cjs --project D:/tools/wenstar-cc      # 指定项目
 *   node sentinel/sentinel-service.cjs --project xxx --dry                # 干运行模式(仅记录不操作)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { createWatcher } = require('./watcher.cjs');
const { createRollback } = require('./rollback.cjs');
const { createBaseline } = require('./baseline.cjs');
const { checkFile } = require('./sentinel-mcp-client.cjs');
const { createEscalation } = require('./escalation.cjs');
const { loadRiskPolicy } = require('../scripts/risk-policy-loader.cjs');

// ── 命令行参数 ──

const args = process.argv.slice(2);
let projectRoot = '';
let dryRun = false;
let unlockPassword = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project' && args[i + 1]) projectRoot = args[++i];
  else if (args[i] === '--dry') dryRun = true;
  else if (args[i] === '--unlock') {
    // 标记为解锁模式 — 稍后处理
    process.env.__SENTINEL_UNLOCK = args[++i] || '';
  }
  else if (args[i] === '--minutes') {
    // 豁免时长（分钟）— 配合 --unlock 使用
    process.env.__SENTINEL_UNLOCK_MINUTES = args[++i] || '30';
  }
  else if (args[i] === '--password') {
    // 管理员密码 — 配合 --unlock 使用（防 Agent 自行豁免）
    unlockPassword = args[++i] || '';
  }
  else if (args[i] === '--reason') {
    // v2.9: 豁免理由（审计必填）
    process.env.__SENTINEL_UNLOCK_REASON = args[++i] || '';
  }
  else if (args[i] === '--ops') {
    // v2.9: 豁免允许的操作白名单（edit,write），逗号分隔
    process.env.__SENTINEL_UNLOCK_OPS = args[++i] || '';
  }
  else if (args[i] === '--relaxed') {
    // v2.9: 豁免放宽的检查（S4.5_complexity,breaker,cooldown），逗号分隔
    process.env.__SENTINEL_UNLOCK_RELAXED = args[++i] || '';
  }
}

// 处理 --unlock 命令
if (process.env.__SENTINEL_UNLOCK !== undefined) {
  const unlockFile = process.env.__SENTINEL_UNLOCK;
  if (!projectRoot) {
    console.error('[sentinel] --unlock 需要同时指定 --project <项目根目录>');
    process.exit(1);
  }
  // 🔴 S2-安全收紧 ①: --unlock 必须带管理员密码校验，否则拒绝
  // 原因: 此前 --unlock 无任何身份校验，Agent 有 Bash 权限可自行豁免任意文件。
  // 现在必须与 .harness-pass 校验通过才能豁免。--password 未提供或错误 → 拒绝。
  if (!unlockPassword) {
    console.error('[sentinel] 🔴 已启用密码保护: --unlock 必须带 --password <管理员密码>');
    console.error('[sentinel]     用法: node sentinel-service.cjs --project <根> --unlock <file> --minutes <N> --password <密码>');
    process.exit(1);
  }
  const { verifyPassword } = require('../scripts/pass-core.cjs');
  const pwOk = verifyPassword(unlockPassword);
  if (!pwOk) {
    console.error('[sentinel] 🔴 解锁被拒: 管理员密码错误。豁免未签发。');
    process.exit(1);
  }
  const minutes = parseInt(process.env.__SENTINEL_UNLOCK_MINUTES || '30', 10) || 30;
  // v2.9: 豁免申请闭环 — 需提供理由；ops/relaxed 限定范围
  const reason = process.env.__SENTINEL_UNLOCK_REASON || '';
  const ops = (process.env.__SENTINEL_UNLOCK_OPS || '').split(',').map(s => s.trim()).filter(Boolean);
  const relaxed = (process.env.__SENTINEL_UNLOCK_RELAXED || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!reason) {
    console.error('[sentinel] 🔴 v2.9: --unlock 必须带 --reason "<豁免理由>"（豁免申请闭环要求理由与标准）');
    console.error('[sentinel]     用法: node sentinel-service.cjs --project <根> --unlock <file> --minutes <N> --password <密码> --reason "<理由>" [--ops edit,write] [--relaxed S4.5_complexity]');
    process.exit(1);
  }
  const { createEscalation: _CE } = require('./escalation.cjs');
  const _esc = _CE(projectRoot);
  const record = _esc.manualUnlock(unlockFile, minutes, { reason, operations: ops, relaxed_checks: relaxed });
  console.error(`[sentinel] 🔓 已手动解锁: ${unlockFile} (豁免 ${minutes} 分钟, id: ${record.id}, 理由: ${reason})`);
  console.error(`[sentinel]    ⚠️ v2.9: 豁免只放宽指定检查，仍要求流水线令牌（harness_run_flow 可传 exempt_files）`);
  process.exit(0);
}

if (!projectRoot) {
  console.error('[sentinel] 用法: node sentinel-service.cjs --project <项目根目录> [--dry]');
  console.error('[sentinel] 示例: node sentinel-service.cjs --project D:/tools/wenstar-cc');
  process.exit(1);
}

projectRoot = path.resolve(projectRoot);
const auditDir = path.resolve(__dirname, '..', 'data', 'sentinel');

// ── 🔴 A(v3.1): 单实例锁（防同一项目被重复拉起多份哨兵 → 互相回滚 / 子进程互杀闪窗）──
// 与 mcp/start.cjs 同一机制：锁文件 mtime 心跳(15s) + TTL(60s) 为准，PID 存活为辅助信号
// （单凭 PID 会被 Windows PID 复用误导；单凭 TTL 则被 taskkill /F 后要空等满 60s）。
// 🔴 锁路径与 key 算法必须与 .claude/harness-auto-start.cjs::sentinelLockPath 保持一致。
// 🔴 必须放在 --unlock 提前退出（上方）之后 —— 豁免签发走的就是本脚本的 CLI 路径，
//    若在锁后面，`exempt add` 会被常驻哨兵自己的锁挡住。
const LOCK_DIR = path.resolve(__dirname, '..', 'data', 'mcp-watchdog');
const SENTINEL_LOCK_FILE = path.join(
  LOCK_DIR,
  'sentinel-' + crypto.createHash('sha1')
    .update(projectRoot.replace(/\\/g, '/').toLowerCase())
    .digest('hex').slice(0, 12) + '.lock',
);
const LOCK_HEARTBEAT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

let sentinelLockHeld = false;
let sentinelLockTimer = null;

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; } // EPERM = 存在但不属于本进程
}

/** true = 本进程取得锁可以继续；false = 已有实例，本进程应立即退出 */
function acquireSentinelLock() {
  try {
    if (fs.existsSync(SENTINEL_LOCK_FILE)) {
      let ageMs = Infinity;
      let holderPid = null;
      try {
        ageMs = Date.now() - fs.statSync(SENTINEL_LOCK_FILE).mtimeMs;
        holderPid = JSON.parse(fs.readFileSync(SENTINEL_LOCK_FILE, 'utf-8')).pid;
      } catch (_) { /* 损坏的锁文件按陈旧处理 */ }
      if (ageMs < LOCK_STALE_MS && isPidAlive(holderPid)) return false;
      console.error(`[sentinel] ♻️ 接管陈旧锁（持锁 PID ${holderPid ?? '未知'} 已不在/锁龄 ${Math.round(ageMs / 1000)}s）`);
    }
    if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(SENTINEL_LOCK_FILE, JSON.stringify({
      pid: process.pid, kind: 'sentinel', project: projectRoot, started_at: new Date().toISOString(),
    }, null, 2), 'utf-8');
    sentinelLockHeld = true;
    sentinelLockTimer = setInterval(() => {
      try { const t = new Date(); fs.utimesSync(SENTINEL_LOCK_FILE, t, t); } catch (_) {}
    }, LOCK_HEARTBEAT_MS);
    sentinelLockTimer.unref();
    return true;
  } catch (e) {
    // fail-open：锁机制自身故障时不能让哨兵起不来
    console.error(`[sentinel] ⚠️ 单实例锁不可用，继续启动: ${e.message}`);
    return true;
  }
}

function releaseSentinelLock() {
  if (!sentinelLockHeld) return;
  sentinelLockHeld = false;
  if (sentinelLockTimer) { clearInterval(sentinelLockTimer); sentinelLockTimer = null; }
  try { fs.unlinkSync(SENTINEL_LOCK_FILE); } catch (_) {}
}

if (!acquireSentinelLock()) {
  console.error(`[sentinel] 🛑 该项目已有哨兵在运行（锁 ${SENTINEL_LOCK_FILE}），本进程退出。`);
  console.error('[sentinel]    如确认前一份已死，删除该锁文件后重试。');
  process.exit(0);
}
console.error(`[sentinel] 🔐 单实例锁已取得: ${SENTINEL_LOCK_FILE}`);

// P7-A: 多目录监控 — Sentinel 现在覆盖 Harness 自身基础设施 + 被管控项目
// 从统一风险策略 (risk-policy.json) 加载高风险目录，动态生成监测目标
const riskPolicy = loadRiskPolicy(path.resolve(__dirname, '..', 'scripts'));
const WATCH_ROOTS = [
  'src/',         // 被管控项目源文件（必须）
  'dist/',        // v2.9: 编译产物纳入治理（哈希基线 + 自愈；harness 自身无 dist 自动跳过）
  '.claude/',     // P7: Harness 钩子脚本
  'mcp/',         // P7: MCP 服务实现
  'sentinel/',    // P7: 哨兵自身（防篡改）
  'scripts/',     // P7: 关键防线脚本
  'hooks/',       // P7: Git hooks
  'data/flows/',  // P7: 流水线定义
];

if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });

// MED-4 决策: 不把 data/sessions + data/tokens 加入哨兵监控。
// 原因: 这些目录被合法流程（unlock 签发 / MCP 令牌签发）高频写入，
//       Sentinel 监控会导致正常签发被回滚（误伤）。「绕过流程的 Bash 直接写」
//       已由 scripts/bash-write-guard.cjs 覆盖（关键路径写操作 DENY）。

// ── 配置 ──

/** 批量写入检测窗口 (ms) — 此时间内连续变更视为同一批次 */
const BATCH_WINDOW_MS = 500;

/** 批次处理最大文件数 — 超过告警（防脚本批量篡改） */
const BATCH_ALERT_THRESHOLD = 3;

/** v2.9.2: 递归统计 dist 下最近 30s 变更的文件数（wenstar-cc 构建产物在 m3/m4/household 等子目录） */
function countRecentDistFiles(projectRootPath) {
  try {
    const distDir = path.join(projectRootPath, 'dist');
    if (!fs.existsSync(distDir)) return 0;
    const cutoff = Date.now() - 30_000;
    let n = 0;
    const countDir = (dir) => {
      try {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, ent.name);
          if (ent.isDirectory()) countDir(fp);
          else { try { if (fs.statSync(fp).mtimeMs > cutoff) n++; } catch (_) {} }
        }
      } catch (_) {}
    };
    countDir(distDir);
    return n;
  } catch (_) { return 0; }
}

// ── 统计 ──

const stats = {
  startedAt: new Date().toISOString(),
  events: 0,
  allowed: 0,
  exempt: 0,
  reverted: 0,
  errors: 0,
  batches: 0,
};

// ── 哨兵 ──

// v3.0(2026-09-10): 基线快照 —— 回滚语义修正（见 docs/harness/06_Sentinel回滚缺陷-2026-09-10.md）
//   回滚 = 恢复到「最后一次授权内容」，不再用 git checkout（后者会用 index 覆盖工作区，
//   销毁未暂存工作）。启动时先全量播种基线（磁盘现状 = 已知状态）。
const baseline = createBaseline(projectRoot);
const rollback = createRollback(projectRoot, { baseline });
const escalation = createEscalation(projectRoot);

/** 批次队列 */
let batchQueue = [];
let batchTimer = null;

/**
 * 刷新批次 — 处理当前批次中的所有文件变更。
 * 每个文件独立令牌检查 → 独立回滚，互不影响。
 */
async function flushBatch() {
  if (batchQueue.length === 0) return;
  const batch = [...batchQueue];
  batchQueue = [];
  stats.batches++;

  const batchId = stats.batches;
  const fileList = batch.map(b => b.filePath).join(', ');

  if (batch.length >= BATCH_ALERT_THRESHOLD) {
    console.error(`[sentinel] ⚠️ 批量写入检测 [批次#${batchId}]: ${batch.length} 个文件在 ${BATCH_WINDOW_MS}ms 内被修改`);
    console.error(`[sentinel]    文件: ${fileList}`);
    console.error(`[sentinel]    ⚡ 疑似脚本批量打补丁，启动增强审查`);
  }

  for (const item of batch) {
    await processFileChange(item.filePath, batch.length >= BATCH_ALERT_THRESHOLD);
  }

  // 批次处理完毕后，对失败的文件做一次整体重试
  if (batch.length >= BATCH_ALERT_THRESHOLD) {
    console.error(`[sentinel] ✅ 批次#${batchId} 处理完成: ${batch.length} 个文件`);
  }
}

/**
 * 处理单个文件变更。
 * @param {string} filePath - 相对于项目根目录的文件路径
 * @param {boolean} isBatchAlert - 是否来自批量告警（增强日志）
 */
async function processFileChange(filePath, isBatchAlert) {
  // P6-FIX: 外层 try/catch 防止未捕获异常导致 Sentinel 进程崩溃
  try {
    stats.events++;
    const timestamp = new Date().toISOString();

    const prefix = isBatchAlert ? '[sentinel:batch]' : '[sentinel]';
    console.error(`${prefix} 📁 文件变更: ${filePath} (#${stats.events})`);

    // v2.9: dist/ 走哈希基线自愈（不走 token/回滚——dist 是 untracked，git 回滚会删合法产物）
    const _normPath = String(filePath).replace(/\\/g, '/');
    if (_normPath.startsWith('dist/')) {
      // v2.9.2-fix: 批量构建检测——wenstar-cc 正常 npm run build(tsc) 会写入数百个 dist 文件，
      // 每个都 spawn dist-baseline --verify 会反复启动子进程（闪屏爆发）。30s 内 dist 变更 ≥10 个
      // 判定为构建事件 → 跳过自愈（构建是合法写入，完成后应 --refresh 更新基线而非逐文件覆写）。
      const _distRecent = countRecentDistFiles(projectRoot);
      if (_distRecent >= 10) {
        console.error(`${prefix} 🟡 dist 批量构建中(${_distRecent} 文件/30s)，跳过自愈校验（构建完成后 --refresh 更新基线）`);
        return;
      }
      try {
        const { spawnSync } = require('child_process');
        const r = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'dist-baseline.cjs'), '--verify', _normPath, '--project', projectRoot], {
          // 防控制台闪窗：pm2 拉起的哨兵无控制台，stdio:'inherit' + 无 windowsHide 会新建窗口
          encoding: 'utf-8', timeout: 60000, stdio: 'inherit', windowsHide: true, cwd: path.resolve(__dirname, '..'),
        });
        if (r.status !== 0) console.error(`${prefix} ⚠️ dist 自愈校验异常 (exit ${r.status})`);
      } catch (e) {
        console.error(`${prefix} ⚠️ dist 自愈调用失败:`, e.message);
      }
      return;
    }

    // v2.9 三分支: 豁免命中 → 仍查令牌 → (豁免+令牌=allowed / 豁免+无令牌=exempt_allowed 不回滚 / 无豁免+无令牌=回滚升级)
    // 豁免≠完全放行: 只放宽「回滚」与「升级」，token 仍必需。
    const exemptPath = String(filePath).replace(/\\/g, '/');
    const exemptRecord = escalation.isExempt(exemptPath) ||
      (exemptPath.startsWith('src/') ? escalation.isExempt(exemptPath.slice(4)) : escalation.isExempt('src/' + exemptPath));

    // 查令牌（豁免与否都查）
    const result = await checkFile(filePath, { project: projectRoot });

  if (result.allowed) {
    // 分支1: 令牌有效 → 正常放行（无论是否豁免）
    stats.allowed++;
    // v3.0: 授权写入 → 推进基线（此后若出现未授权改动，回滚将精确恢复到本次授权态）
    try { baseline.refresh(filePath); } catch (_) { /* 基线刷新失败不阻断放行 */ }
    console.error(`${prefix} ✅ 放行: ${filePath} — ${result.reason}`);
    archiveEvent('allowed', { file: filePath, risk: result.risk, reason: result.reason, timestamp });
    return;
  }

  if (exemptRecord) {
    // 分支2: 豁免命中 + 无令牌 → 记录「豁免内修改」但【不回滚、不升级】
    // 终结 boot 重放循环: 豁免期内改写只记录，豁免过期后再写才回滚。
    stats.exempt++;
    // v3.0: 豁免 = 授权 → 同样推进基线
    try { baseline.refresh(filePath); } catch (_) { /* 基线刷新失败不阻断 */ }
    console.error(`${prefix} 🟡 豁免内修改(无令牌): ${filePath} — id: ${exemptRecord.id || 'v1'} 豁免期内不回滚`);
    archiveEvent('exempt_allowed', {
      file: filePath, risk: result.risk, reason: '豁免内修改(无令牌)', timestamp,
      exemption_id: exemptRecord.id || null,
    });
    return;
  }

  // 分支3: 无豁免 + 无令牌 → 回滚 + 升级（原逻辑）
  console.error(`${prefix} 🚫 拦截: ${filePath} — ${result.reason}`);

  const revertResult = await rollback.revert(filePath, { dryRun });

  if (revertResult.reverted) {
    stats.reverted++;
    archiveEvent('reverted', {
      file: filePath, risk: result.risk, reason: result.reason,
      hash: revertResult.hash, attempts: revertResult.attempts, timestamp,
    });

    // ── 升级判定 ──
    const escResult = escalation.recordRevert(filePath, { risk: result.risk, reason: result.reason });

    if (revertResult.attempts > 1) {
      console.error(`${prefix} ↩ 已回滚（${revertResult.attempts}次重试）: ${filePath} → ${revertResult.hash}`);
    } else {
      console.error(`${prefix} ↩ 已回滚: ${filePath} → ${revertResult.hash}`);
    }
    if (escResult.escalated) {
      console.error(`${prefix} ${escResult.action}`);
    }
  } else if (revertResult.already) {
    // v3.0: 幂等无操作——恢复动作本身会重写文件 → 再触发一次事件。
    // 内容已与基线一致 → 不计错误、不升级、不打告警，避免日志/熔断风暴。
    archiveEvent('noop', { file: filePath, reason: revertResult.reason || '内容已与基线一致', timestamp });
  } else if (revertResult.method === 'refused-no-baseline') {
    // v3.0: 无基线且文件已被 git 跟踪 → 拒绝破坏性回滚（fail-loud）。
    // 这是本次修复的核心：宁可报「无法自动回滚」，也不做会销毁未暂存工作的 git checkout。
    stats.errors++;
    archiveEvent('refused_no_baseline', {
      file: filePath, error: revertResult.error, quarantine: revertResult.quarantine,
      reason: result.reason, timestamp,
    });
    console.error(`${prefix} 🛑 拒绝破坏性回滚（无基线）: ${filePath}`);
    console.error(`${prefix}    ${revertResult.error || ''}`);
    console.error(`${prefix}    ⚠️ 需人工介入：确认该改动是否合法。合法 → 取豁免/令牌后重写以推进基线；非法 → 从隔离区比对后决定。`);
    try {
      const escResult = escalation.recordRevert(filePath, { risk: result.risk, reason: result.reason });
      if (escResult.escalated) console.error(`${prefix} ${escResult.action}`);
    } catch (_) {}
  } else if (revertResult.dryRun) {
    stats.reverted++;
    archiveEvent('reverted', {
      file: filePath, risk: result.risk, reason: result.reason,
      diff: revertResult.diff, dryRun: true, timestamp,
    });
    console.error(`${prefix} 🔍 [DRY-RUN] 将回滚: ${filePath} (${revertResult.diff})`);
  } else {
    stats.errors++;
    archiveEvent('error', {
      file: filePath, error: revertResult.error || 'unknown',
      reason: result.reason, attempts: revertResult.attempts, timestamp,
    });
    console.error(`${prefix} ❌ 回滚失败: ${filePath} — ${revertResult.error || revertResult.reason || 'unknown'}`);
    if (revertResult.attempts >= 5) {
      console.error(`${prefix} 🔴 严重: ${filePath} 5次重试全部失败，文件可能已被篡改且无法自动恢复！`);
    }
  }
  } catch (err) {
    stats.errors++;
    console.error(`[sentinel] ❌ processFileChange 异常: ${err.message || err} (file: ${filePath})`);
    try {
      archiveEvent('error', { file: filePath, error: err.message || String(err), timestamp: new Date().toISOString() });
    } catch (_) {}
  }
}

/** 文件变更事件入口 — P7: 支持多目录监控，不再强制补 src/ 前缀 */
function onFileChanged(relPath) {
  let filePath = relPath.replace(/\\/g, '/');
  const normalizedProjectRoot = projectRoot.replace(/\\/g, '/');
  if (filePath.startsWith(normalizedProjectRoot + '/')) {
    filePath = filePath.slice(normalizedProjectRoot.length + 1);
  }
  // 确认文件路径匹配已知的监控根目录之一（排除完全无关的路径）
  const inWatchedDir = WATCH_ROOTS.some(r => filePath.startsWith(r.replace(/\\/g, '/')));
  if (!inWatchedDir) {
    // 不在已知监控目录中 → 尝试补 src/ 前缀（兼容 watcher 裸文件名）
    filePath = 'src/' + filePath;
  }

  // P6-FIX: 批量队列上限，防止 DoS 无限延迟回滚
  const BATCH_MAX_SIZE = 100;
  if (batchQueue.length >= BATCH_MAX_SIZE) {
    console.error(`[sentinel] ⚠️ 批量队列已达上限 ${BATCH_MAX_SIZE}，强制 flush 防止 DoS`);
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    flushBatch();
    return;
  }

  // ── 批次聚合 ──
  // 同一窗口内的文件变更进入同一批次
  batchQueue.push({ filePath, time: Date.now() });

  // 重置批次定时器 — 每次新变更都延长窗口
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = setTimeout(() => {
    batchTimer = null;
    flushBatch();
  }, BATCH_WINDOW_MS);
}

/** 审计归档 */
function archiveEvent(type, detail) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(auditDir, today);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fname = `${type}_${Date.now()}.json`;
    fs.writeFileSync(path.join(dir, fname), JSON.stringify(detail, null, 2), 'utf-8');
  } catch (err) { console.error(`[sentinel] ⚠️ 审计归档失败: ${err.message}`); }
}

// ── 启动（P7: 多目录监控）──

console.error(`[sentinel] ╔══════════════════════════════════════════╗`);
console.error(`[sentinel] ║  Harness 文件系统哨兵 v2.1               ║`);
console.error(`[sentinel] ║  版本: v2.1 (多目录监控 + P7安全加固)    ║`);
console.error(`[sentinel] ║  项目: ${projectRoot.padEnd(34)}║`);
console.error(`[sentinel] ║  模式: ${dryRun ? '干运行 DRY-RUN'.padEnd(34) : '实时回滚 LIVE'.padEnd(34)}║`);
console.error(`[sentinel] ║  监控: ${WATCH_ROOTS.length} 个目录`.padEnd(46) + '║');
console.error(`[sentinel] ╚══════════════════════════════════════════╝`);

// 为每个监控根目录创建独立 watcher
const watchers = [];
// S4 三轮评审决定: 回退 MED-3（.claude 深度监控）。
// 原因: 引入两个 HIGH 新问题（.claude/harness 幻影前缀误判保护区 + onFileChanged 路径错拼导致轮询监控失效），
//       且 watcher 默认排除 .claude 是防自写回滚的必要设计。.claude 防线文件保护改由 bash-write-guard 承担。
// 🔴 v2.13-fix (2026-08-15, S2 决策 A): .claude fs.watch 实时通道重新启用（对齐轮询通道）。
//    watcher 回调统一用 relPath 判断后，.claude root 下文件的 relPath 不再含 /.claude/ 前缀 → 实时通道激活。
//    这是有意为之（用户裁决 A）：消除双通道不对称，.claude 钩子脚本属 T1 保护区，
//    实时监控 + unlock/flow 令牌闭环是更强保护，非削弱。node_modules 等排除洞由 shouldWatch startsWith 补齐。
for (const root of WATCH_ROOTS) {
  const fullPath = path.join(projectRoot, root);
  if (!fs.existsSync(fullPath)) {
    console.error(`[sentinel] ⚠️ 监控目录不存在，跳过: ${root}`);
    continue;
  }
  try {
    // MID-4-fix: watcher 回调传相对项目根的路径（root 前缀 + relPath），
    // 修复 dist 等非 src 监控根下 relPath 被误拼成 src/ 前缀导致路径错配。
    const w = createWatcher(fullPath, (relPath) => {
      const p = relPath.replace(/\\/g, '/');
      // 🔴 P0-fix 双保险 (S4 评审): 真正识别绝对路径——watcher 正常输出相对 watchDir 路径走 root+p；
      // 万一未来有绝对路径混入，转成项目根相对路径，绝不拼出 src/D:/... 幽灵前缀。
      onFileChanged(path.isAbsolute(p) ? path.relative(projectRoot, p) : root + p);
    });
    w.start();
    watchers.push({ root, watcher: w });
  } catch (err) {
    console.error(`[sentinel] ⚠️ 无法监控 ${root}: ${err.message}`);
  }
}

if (watchers.length === 0) {
  console.error('[sentinel] ❌ 没有任何可监控的目录，退出');
  process.exit(1);
}
console.error(`[sentinel] ✅ 已启动 ${watchers.length}/${WATCH_ROOTS.length} 个监控器`);

// ── v3.0: 基线全量播种（回滚 = 恢复基线，无基线则无法回滚 → 启动必须先登记已知状态）──
// 只补缺失项，不覆盖已有基线（避免重启把「授权态」冲掉）。
// 干运行模式（--dry）不落盘，保持「仅记录不操作」语义。
if (dryRun) {
  console.error('[sentinel] 🧬 基线播种: 已跳过（--dry 干运行模式不落盘）');
} else {
  try {
    const seed = baseline.seedDirs(WATCH_ROOTS);
    console.error(`[sentinel] 🧬 基线播种完成: 新增 ${seed.seeded} / 已有 ${seed.skipped} / 失败 ${seed.failed}（${seed.dirs} 个根目录）→ ${baseline.dir}`);
  } catch (err) {
    console.error(`[sentinel] ⚠️ 基线播种失败（回滚将退化为「拒绝破坏性回滚 + 隔离告警」）: ${err.message}`);
  }
}

// ── 定期状态报告（P7: 汇总所有 watcher）──

setInterval(() => {
  const uptime = Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000);
  const m = Math.floor(uptime / 60);
  const s = uptime % 60;
  const totalTracked = watchers.reduce((sum, w) => sum + w.watcher.getTrackedCount(), 0);
  console.error(`[sentinel] 📊 运行 ${m}m${s}s | 事件: ${stats.events} | 放行: ${stats.allowed} | 回滚: ${stats.reverted} | 错误: ${stats.errors} | 批次: ${stats.batches} | 监控: ${watchers.length}目录/${totalTracked}文件`);
}, 300_000); // 每 5 分钟

// ── 优雅退出 ──

process.on('SIGINT', () => {
  console.error('[sentinel] 收到 SIGINT，退出...');
  if (batchQueue.length > 0) {
    console.error(`[sentinel] 处理残留批次: ${batchQueue.length} 个文件...`);
  }
  if (batchTimer) clearTimeout(batchTimer);
  for (const w of watchers) w.watcher.stop();
  const uptime = Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000);
  console.error(`[sentinel] 运行 ${uptime}s, 共处理 ${stats.events} 个事件, ${stats.reverted} 次回滚, ${stats.batches} 个批次`);
  releaseSentinelLock();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (batchTimer) clearTimeout(batchTimer);
  for (const w of watchers) w.watcher.stop();
  releaseSentinelLock();
  process.exit(0);
});

// 兜底：非信号退出路径（如监控目录全缺失时的 exit(1)）也要放锁，避免残留锁挡住下次启动
process.on('exit', () => { releaseSentinelLock(); });

// ── 进程存活信号 ──

console.error(`[sentinel] ✅ 哨兵已就绪 v2.1 (PID: ${process.pid}, 批量窗口: ${BATCH_WINDOW_MS}ms, 监控: ${watchers.length} 个目录, 升级模块: 激活)`);

// ── P9 心跳：哨兵每次状态报告写 sentinel-heartbeat.json（供 watchdog 链路检测）──
const SENTINEL_HEARTBEAT_FILE = path.join(auditDir, '..', 'sentinel-heartbeat.json');
function writeSentinelHeartbeat() {
  try {
    const uptime = Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000);
    const totalTracked = watchers.reduce((sum, w) => sum + w.watcher.getTrackedCount(), 0);
    const dir = path.dirname(SENTINEL_HEARTBEAT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SENTINEL_HEARTBEAT_FILE, JSON.stringify({
      ts: Date.now(),
      pid: process.pid,
      projectRoot,
      uptime,
      events: stats.events,
      allowed: stats.allowed,
      reverted: stats.reverted,
      errors: stats.errors,
      watchers: watchers.length,
      trackedFiles: totalTracked,
      mode: dryRun ? 'DRY-RUN' : 'LIVE',
    }));
  } catch (err) { console.error(`[sentinel] ⚠️ 心跳写入失败: ${err.message}`); }
}

// 立即写一次 + 每 30 秒刷新（比 5 分钟状态报告更细粒度，watchdog 依赖它）
writeSentinelHeartbeat();
setInterval(writeSentinelHeartbeat, 30_000);

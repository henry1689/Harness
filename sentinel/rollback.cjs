/**
 * rollback.js — 未授权变更自动回滚 (v3.0 — 基线恢复，非破坏性)
 * ============================================================
 * 🔴 v3.0 语义修正（2026-09-10 事故，见 docs/harness/06_Sentinel回滚缺陷-2026-09-10.md）
 *   v2.x 用 `git checkout -- <file>` 回滚，其语义是「用 **index（暂存区）** 覆盖工作区」，
 *   **不是**「恢复编辑前内容」。后果：会连同该文件**全部未暂存改动**一起抹掉
 *   （实证：src/types.ts 的 enhance-v1 类型扩展被销毁 → tsc 21 处报错）；
 *   且文件若有已暂存改动，`git checkout --` 后 `git status` 仍为 `M ` → 校验恒判失败、空转重试。
 *
 *   v3.0 起：
 *     1. 优先用 **baseline（最后授权内容）** 恢复 —— 精确撤销本次未授权改动，不触碰其它工作；
 *     2. 任何破坏性动作前**先隔离（quarantine）**当前内容，永不静默销毁；
 *     3. 无基线且文件已被 git 跟踪 → **拒绝回滚并 fail-loud**（回不去就明说，不猜）；
 *     4. 校验判据 = 「恢复后内容哈希 == 基线哈希」，不再依赖 `git status --porcelain`；
 *     5. 内容已与基线一致 → 视为幂等无操作（already），不计错误、不触发升级。
 *   git 仅作为「无基线 + untracked 新文件」时的兜底判断来源，不再承担回滚动作。
 *
 * 支持干运行模式（dry-run），仅报告不回滚。
 *
 * 使用:
 *   const rollback = createRollback('D:/tools/wenstar-cc', { baseline });
 *   const result = await rollback.revert('src/webui/chat.ts', { dryRun: false });
 *   // → { reverted: true, file: '...', hash: '...', method: 'baseline' }
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// v3.0: Git 锁竞争重试配置（MAX_RETRIES/BASE_DELAY_MS/MAX_DELAY_MS）与 sleepSync/isLockContention
// 已随 `git checkout` 回滚路径一并移除——基线恢复是纯文件写入，无 git 锁竞争。

/** 隔离区（放在 data/sentinel 下，不在 Sentinel 的 WATCH_ROOTS 内 → 不会自激触发新事件） */
const QUARANTINE_ROOT = path.resolve(__dirname, '..', 'data', 'sentinel', 'quarantine');

/**
 * @param {string} projectRoot
 * @param {{ baseline?: { has:(p:string)=>boolean, restore:(p:string)=>{restored:boolean,already?:boolean,hash?:string,reason?:string}, currentHash:(p:string)=>string|null } }} [options]
 */
function createRollback(projectRoot, options = {}) {
  const baseline = options.baseline || null;

  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    console.error(`[sentinel:rollback] ⚠️ ${projectRoot} 不是 git 仓库，回滚仅支持 git 管理的项目`);
  }

  /**
   * 隔离当前内容（任何破坏性动作前的强制前置）。
   * 永不失败到「销毁」——写不进去就返回 ok:false，调用方必须据此放弃破坏性动作。
   * @returns {{ok:boolean, path?:string, reason?:string}}
   */
  function quarantine(filePath) {
    try {
      const abs = path.join(projectRoot, String(filePath).replace(/\\/g, '/'));
      if (!fs.existsSync(abs)) return { ok: true, reason: '文件不存在，无需隔离' };
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(QUARANTINE_ROOT, stamp, String(filePath).replace(/\\/g, '/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
      return { ok: true, path: dest };
    } catch (err) {
      return { ok: false, reason: (err && err.message) || String(err) };
    }
  }

  /** 判断文件是否被 git 跟踪（tracked=false 即 untracked/新文件） */
  function isTrackedByGit(filePath) {
    try {
      const out = execSync(`git ls-files --error-unmatch -- "${filePath}"`, {
        // 防控制台闪窗：哨兵由 pm2 拉起时无控制台，spawn git 会新建窗口
        cwd: projectRoot, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      }).trim();
      return out.length > 0;
    } catch (_) {
      return false;
    }
  }

  // ── 公开 API ──

  /**
   * 回滚单个文件。
   * v3.0: 优先 baseline 恢复；无基线时不破坏（隔离 + fail-loud），untracked 新文件隔离后删除。
   *
   * @param {string} filePath - 相对于项目根目录的路径
   * @param {{ dryRun?: boolean, retries?: number }} opts
   * @returns {Promise<{ reverted: boolean, file: string, hash?: string, error?: string, reason?: string, already?: boolean, method?: string, quarantine?: string, attempts?: number }>}
   */
  async function revert(filePath, opts = {}) {
    const dryRun = opts.dryRun !== false;

    // ══ v3.0 主路径：基线恢复 ══
    if (baseline && baseline.has(filePath)) {
      const curHash = baseline.currentHash(filePath);
      if (dryRun) {
        return { reverted: false, file: filePath, dryRun: true, method: 'baseline', diff: '将恢复至基线内容', attempts: 1 };
      }
      const res = baseline.restore(filePath);
      if (res.restored) {
        console.error(`[sentinel:rollback] ↩ 已按基线恢复: ${filePath} (基线 ${String(res.hash).slice(0, 12)})`);
        return { reverted: true, file: filePath, hash: res.hash, method: 'baseline', attempts: 1 };
      }
      if (res.already) {
        // 幂等：恢复动作自身会重写文件 → 再触发一次事件。此处识别为无操作，避免日志/升级风暴。
        return { reverted: false, already: true, file: filePath, hash: res.hash, reason: res.reason, method: 'baseline', attempts: 1 };
      }
      // 基线存在但恢复失败 → 隔离 + fail-loud（绝不动 git）
      const q = quarantine(filePath);
      return {
        reverted: false, file: filePath, method: 'baseline', quarantine: q.path,
        error: `基线恢复失败：${res.reason}${q.ok ? '（当前内容已隔离，可人工找回）' : '（隔离亦失败：' + q.reason + '）'}`,
        attempts: 1,
      };
    }

    // ══ 无基线兜底：绝不静默销毁 ══
    if (!dryRun) {
      const q = quarantine(filePath);
      const tracked = isTrackedByGit(filePath);
      if (!tracked) {
        // 未授权的新文件 → 隔离后删除（内容已在隔离区，可找回）
        try {
          const abs = path.join(projectRoot, String(filePath).replace(/\\/g, '/'));
          if (fs.existsSync(abs)) {
            fs.unlinkSync(abs);
            console.error(`[sentinel:rollback] 🗑 已删除未授权新文件（已隔离至 ${q.path || '失败'}）: ${filePath}`);
            return { reverted: true, file: filePath, method: 'quarantine-delete', quarantine: q.path, attempts: 1 };
          }
          return { reverted: false, file: filePath, reason: '文件不存在', attempts: 1 };
        } catch (err) {
          return { reverted: false, file: filePath, error: `无法删除未授权新文件: ${(err && err.message) || err}`, attempts: 1 };
        }
      }
      // 已被 git 跟踪但无基线 → 拒绝破坏性回滚（git checkout 会销毁未暂存工作）
      return {
        reverted: false, file: filePath, method: 'refused-no-baseline', quarantine: q.path,
        error: `无基线，拒绝破坏性回滚（git checkout 会销毁未暂存工作）。当前内容已隔离至 ${q.path || '失败'}，请人工确认后处理。`,
        attempts: 1,
      };
    }

    // dry-run + 无基线：仅报告
    return { reverted: false, file: filePath, dryRun: true, method: 'no-baseline', diff: '无基线（实时模式将隔离并告警，不破坏性回滚）', attempts: 1 };
  }

  /**
   * 批量回滚 — 按顺序回滚多个文件，单个失败不影响其余。
   * v2.0: 每个文件独立重试，不受其他文件影响。
   *
   * @param {string[]} filePaths
   * @param {{ dryRun?: boolean }} opts
   * @returns {Promise<{ results: Array<{reverted: boolean, file: string}>, reverted: number, failed: number }>}
   */
  async function revertBatch(filePaths, opts = {}) {
    const results = [];
    let revertedCount = 0;
    let failedCount = 0;

    for (const fp of filePaths) {
      const result = await revert(fp, opts);
      results.push(result);
      if (result.reverted) revertedCount++;
      else failedCount++;
    }

    console.error(`[sentinel:rollback] 📦 批量回滚完成: ${revertedCount}/${filePaths.length} 成功, ${failedCount} 失败`);
    return { results, reverted: revertedCount, failed: failedCount };
  }

  /**
   * 获取文件的当前 git 状态。
   * @param {string} filePath
   * @returns {string} 'M' | 'A' | 'D' | ' ' | '?'
   */
  function getStatus(filePath) {
    try {
      const out = execSync(`git status --porcelain -- "${filePath}"`, {
        cwd: projectRoot, encoding: 'utf-8', timeout: 5000, windowsHide: true,
      }).trim();
      return out ? out.slice(0, 2) : '';
    } catch (_) {
      return '';
    }
  }

  return { revert, revertBatch, getStatus };
}

module.exports = { createRollback };

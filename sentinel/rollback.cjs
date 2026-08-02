/**
 * rollback.js — 未授权变更自动回滚 (v2.0 — Git 锁竞争重试)
 * ============================================================
 * 当哨兵检测到文件被未经授权的修改时，自动执行 git checkout 回滚。
 * 支持干运行模式（dry-run），仅报告不回滚。
 *
 * v2.0: 增加 Git 锁竞争重试机制（指数退避，最多 5 次），
 *       对抗 Bash 脚本中 writeFileSync + git commit 的原子操作窗口。
 *
 * 使用:
 *   const rollback = createRollback('D:/tools/wenstar-cc');
 *   const result = await rollback.revert('src/webui/chat.ts', { dryRun: false });
 *   // → { reverted: true, file: 'src/webui/chat.ts', hash: 'abc123' }
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/** 重试配置 */
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 500;   // 首次重试延迟
const MAX_DELAY_MS = 8000;   // 延迟上限

/**
 * 同步延迟（Windows 兼容）
 * @param {number} ms
 */
function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // 忙等待 — 仅用于几百毫秒的锁竞争重试
    // 超过 200ms 用 ping 方式降低 CPU 占用
    if (ms > 200) break;
  }
  if (ms > 200) {
    try {
      execSync(`ping 127.0.0.1 -n ${Math.ceil(ms / 1000) + 1} >nul`, { timeout: ms + 2000 });
    } catch (_) { /* ping 失败不影响 */ }
  }
}

/**
 * 判断是否为 Git 锁竞争错误
 * @param {string} errMsg
 * @returns {boolean}
 */
function isLockContention(errMsg) {
  return /index\.lock.*File exists/i.test(errMsg) ||
         /Unable to create.*index\.lock/i.test(errMsg) ||
         /Another git process/i.test(errMsg);
}

/** @param {string} projectRoot */
function createRollback(projectRoot) {
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    console.error(`[sentinel:rollback] ⚠️ ${projectRoot} 不是 git 仓库，回滚仅支持 git 管理的项目`);
  }

  // ── 公开 API ──

  /**
   * 回滚单个文件（v2.0: 增加 Git 锁竞争重试）。
   *
   * @param {string} filePath - 相对于项目根目录的路径
   * @param {{ dryRun?: boolean, retries?: number }} opts
   * @returns {Promise<{ reverted: boolean, file: string, hash?: string, error?: string, attempts?: number }>}
   */
  async function revert(filePath, opts = {}) {
    const dryRun = opts.dryRun !== false;
    const maxRetries = opts.retries || MAX_RETRIES;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // 先获取当前状态确认文件确实被改了
        const statusOut = execSync(`git status --porcelain -- "${filePath}"`, {
          cwd: projectRoot, encoding: 'utf-8', timeout: 5000,
        }).trim();

        if (!statusOut) {
          return { reverted: false, file: filePath, reason: '文件未变更（可能已被其他方式回滚）', attempts: attempt + 1 };
        }

        if (dryRun) {
          const diffOut = execSync(`git diff --stat -- "${filePath}"`, {
            cwd: projectRoot, encoding: 'utf-8', timeout: 5000,
          }).trim();
          const lines = diffOut.split('\n')[0] || '';
          const match = lines.match(/(\d+) (insertion|deletion)/);
          const changes = match ? match[1] + ' ' + match[2] + 's' : 'unknown';
          return { reverted: false, file: filePath, dryRun: true, diff: changes, attempts: attempt + 1 };
        }

        // 真实回滚
        const beforeHash = execSync(`git rev-parse --short HEAD`, {
          cwd: projectRoot, encoding: 'utf-8', timeout: 5000,
        }).trim();

        execSync(`git checkout -- "${filePath}"`, {
          cwd: projectRoot, encoding: 'utf-8', timeout: 10000,
        });

        // 验证回滚成功
        const afterStatus = execSync(`git status --porcelain -- "${filePath}"`, {
          cwd: projectRoot, encoding: 'utf-8', timeout: 5000,
        }).trim();

        if (afterStatus) {
          return { reverted: false, file: filePath, error: 'git checkout 后文件仍有变更', attempts: attempt + 1 };
        }

        if (attempt > 0) {
          console.error(`[sentinel:rollback] ↩ 已回滚（第${attempt + 1}次尝试）: ${filePath} (HEAD: ${beforeHash})`);
        } else {
          console.error(`[sentinel:rollback] ↩ 已回滚: ${filePath} (HEAD: ${beforeHash})`);
        }
        return { reverted: true, file: filePath, hash: beforeHash, attempts: attempt + 1 };

      } catch (err) {
        const msg = err.message || String(err);

        // Git 锁竞争 → 重试
        if (isLockContention(msg) && attempt < maxRetries - 1) {
          const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
          console.error(`[sentinel:rollback] 🔄 Git 锁竞争，${delay}ms 后重试（${attempt + 1}/${maxRetries}）: ${filePath}`);
          await sleep(delay);
          continue;
        }

        // 其他错误或重试耗尽
        if (attempt >= maxRetries - 1 && isLockContention(msg)) {
          return {
            reverted: false, file: filePath,
            error: `Git 锁竞争，${maxRetries} 次重试后仍失败: ${msg}`,
            attempts: attempt + 1,
          };
        }

        return { reverted: false, file: filePath, error: msg, attempts: attempt + 1 };
      }
    }

    return { reverted: false, file: filePath, error: '重试耗尽', attempts: maxRetries };
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
        cwd: projectRoot, encoding: 'utf-8', timeout: 5000,
      }).trim();
      return out ? out.slice(0, 2) : '';
    } catch (_) {
      return '';
    }
  }

  return { revert, revertBatch, getStatus };
}

/**
 * 异步延迟（Promise-based）
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { createRollback };

/**
 * paths.ts — 治理数据目录的唯一解析入口（2026-10-22）
 * ============================================================
 *
 * 【要解决什么问题】
 * 测试进程把 run 记录直接写进**生产**的 `data/audit/`：
 *
 *   - `FlowEngine.test.ts` 里 20 个 `new FlowEngine`，每跑一遍全量测试就往生产审计写 20 条 run；
 *   - 这些 run 真实地跑完 S1→S7，写真实文件、引用真实豁免 id，**无法从内容上与真实 run 区分**。
 *
 * 实测后果（2026-10-22 复核）：
 *   data/audit 全量 776 个 run 中 **391 个是测试污染（50.4%）**；
 *   10-21 当日 137 个 run 里 60 个是 vitest。任何基于该目录的统计（跑通率、
 *   中止归因、harness2 的 30.21%）都建立在这份被污染的数据上。
 *   佐证：`R1: 缺归档产物` 全仓只出现在测试文件里，却出现在 3 条生产审计的中止原因中。
 *
 * 【为什么不是简单加个 if (process.env.VITEST)】
 * 本仓已被「判据来源可被静默改变」咬过多次（HARNESS_EXEMPTIONS_FILE 整体改指台账、
 * 风险清单四份分叉、CK-07 双实现）。故此处**只在一处**定义解析规则，消费点共用。
 *
 * 【解析优先级】
 *   1. 显式 env 覆盖（HARNESS_AUDIT_DIR / HARNESS_ARCHIVES_DIR）—— 与豁免台账同款；
 *   2. 测试进程（VITEST）→ data/test-runs/{audit,archives}（**隔离，不碰生产**）；
 *   3. 其余 → 生产路径 data/{audit,archives}。
 *
 * 🔴 **调用时解析，不在模块加载时定死**：exemptions-core 曾是加载时定死、
 * s7AutoArchive 是调用时读 env，同一进程里可能指向不同文件（测试先 import 再设 env 即命中）。
 * 本模块所有导出均为函数，杜绝同类缺陷。
 *
 * 🔴 **接入进度（勿当成已完成）**：
 *   ✅ auditDir()      —— AuditLogger 已接入（本批次）
 *   ⏳ archivesDir()   —— s7AutoArchive / S7ArchiveDelegate **尚未接入**：
 *                         二者位于 `src/s7/`，命中 AUTO_GRANT_NEVER 的 `src/s7/` 前缀
 *                         （授权机制自身/防线控制面，不允许经方案预审自动授权），
 *                         需走 owner-closure 人工通道。接入前测试仍会污染 data/archives/。
 */
import { join, resolve } from 'node:path';

/** harness 仓根目录（src/ 与 dist/ 下运行都成立：各退一层） */
function harnessRoot(): string {
  const base = typeof import.meta !== 'undefined' && (import.meta as { dirname?: string }).dirname
    ? (import.meta as { dirname: string }).dirname
    : (typeof __dirname !== 'undefined' ? __dirname : process.cwd());
  return resolve(base, '..');
}

/**
 * 当前是否运行在单元测试进程里。
 * vitest 在启动时即设置 VITEST 环境变量，进程内恒定，不存在「中途变化」。
 */
export function isTestProcess(): boolean {
  return !!process.env.VITEST;
}

/** harness 的 data/ 目录 */
export function harnessDataDir(): string {
  return join(harnessRoot(), 'data');
}

/**
 * 审计日志目录。生产：data/audit ｜ 测试：data/test-runs/audit
 */
export function auditDir(): string {
  const override = process.env.HARNESS_AUDIT_DIR;
  if (override) return resolve(override);
  return isTestProcess()
    ? join(harnessRoot(), 'data', 'test-runs', 'audit')
    : join(harnessRoot(), 'data', 'audit');
}

/**
 * S7 归档产物目录。生产：data/archives ｜ 测试：data/test-runs/archives
 *
 * 与 auditDir 必须**同源同判据**：S7-A 写入与 S7-B 读取若落在不同根，
 * 会复现「写得进、读不到」这一整类缺陷。接入进度见模块头注释。
 */
export function archivesDir(): string {
  const override = process.env.HARNESS_ARCHIVES_DIR;
  if (override) return resolve(override);
  return isTestProcess()
    ? join(harnessRoot(), 'data', 'test-runs', 'archives')
    : join(harnessRoot(), 'data', 'archives');
}

/**
 * GlobalMemoStore — 全局滚动备忘录持久化 & 注入
 * ==================================================
 * S2 方案确认后将方案文本持久化到磁盘。
 * 后续每个 Stage 启动前自动注入 global_arch_constraint。
 *
 * 核心设计：
 *   - save(): S2 人审通过后，将方案存入磁盘文件
 *   - inject(): 将备忘录拼接到 stage.work_manual 末尾
 *   - 存储路径: data/harness/memos/{run_id}_memo.md
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

/** 备忘录存储根目录 */
const MEMOS_DIR = (() => {
  // 兼容 ESM/CJS —— import.meta.dirname 在 Node 22 可用
  const base = typeof import.meta !== 'undefined' && (import.meta as any).dirname
    ? (import.meta as any).dirname
    : __dirname;
  return resolve(base, '..', 'data', 'memos');
})();

/** 确保目录存在 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export class GlobalMemoStore {
  private readonly runId: string;
  private readonly flowId: string;
  private readonly globalArchConstraint: string;
  private readonly globalImplRules: string;
  private _memoContent: string;

  constructor(runId: string, flowId: string, globalArchConstraint: string, globalImplRules: string = '') {
    this.runId = runId;
    this.flowId = flowId;
    this.globalArchConstraint = globalArchConstraint;
    this.globalImplRules = globalImplRules;
    this._memoContent = '';
  }

  // ════════════════════════════════════════════════════════════════
  // 公开 API
  // ════════════════════════════════════════════════════════════════

  /** 获取当前备忘录内容（含架构铁律+落地规则） */
  get content(): string {
    if (this._memoContent) return this._memoContent;
    return this.buildCombinedRules();
  }

  /** 合并架构铁律 + 落地强制规则 */
  private buildCombinedRules(): string {
    const parts: string[] = [];
    if (this.globalArchConstraint) {
      parts.push('## 🔴 全局架构铁律（不可突破）\n\n' + this.globalArchConstraint);
    }
    if (this.globalImplRules) {
      parts.push('## 🔧 开发落地强制校验规则（永久生效）\n\n' + this.globalImplRules);
    }
    return parts.join('\n\n---\n\n');
  }

  /**
   * 持久化备忘录到磁盘（S2 人审通过后调用）。
   * @param solutionText — S2 执行的完整方案文本
   */
  save(solutionText: string): void {
    ensureDir(MEMOS_DIR);

    const content = [
      `# 全局架构备忘录 — ${this.flowId}`,
      `> Run ID: ${this.runId}`,
      `> 写入时间: ${new Date().toISOString()}`,
      '',
      '---',
      '',
      '## S2 审定方案',
      '',
      solutionText,
      '',
      '---',
      '',
      this.buildCombinedRules(),
    ].join('\n');

    const filePath = join(MEMOS_DIR, `${this.runId}_memo.md`);
    writeFileSync(filePath, content, 'utf-8');
    this._memoContent = content;

    console.log(`[GlobalMemoStore] 💾 备忘录已持久化: ${filePath}`);
  }

  /**
   * 从磁盘加载已保存的备忘录（用于会话恢复）。
   */
  load(): boolean {
    const filePath = join(MEMOS_DIR, `${this.runId}_memo.md`);
    if (!existsSync(filePath)) {
      console.warn(`[GlobalMemoStore] 备忘录文件不存在: ${filePath}`);
      return false;
    }

    this._memoContent = readFileSync(filePath, 'utf-8');
    console.log(`[GlobalMemoStore] 📖 备忘录已加载: ${filePath}`);
    return true;
  }

  /**
   * 将全局备忘录注入到 stage 的 work_manual 中。
   * 🔴 同时注入架构铁律 + 开发落地强制规则，两条规则集全阶段覆盖。
   */
  inject(workManual: string): string {
    const combined = this.buildCombinedRules();
    if (!combined) return workManual;

    const memoBlock = this._memoContent || combined;

    return [
      workManual,
      '',
      '---',
      '',
      '## ⚠️ 全局架构备忘录（S2 定稿，本阶段不可突破）',
      '',
      memoBlock,
    ].join('\n');
  }

  /**
   * 仅注入全局铁律+落地规则（轻量版，用于 S2 前阶段）。
   * 🔴 架构铁律 + 落地强制规则全部注入，不允许简化。
   */
  injectFullRules(workManual: string): string {
    const combined = this.buildCombinedRules();
    if (!combined) return workManual;

    return [
      workManual,
      '',
      '---',
      '',
      combined,
    ].join('\n');
  }
}

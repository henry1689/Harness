/**
 * writeRatio.ts — H-05 整文件覆写占比计算（纯函数）
 * ================================================================
 * 判定"增量 diff 编辑" vs "疑似整文件覆写"。阈值 0.7 来自外部配置
 * data/harness_globals.json（可调，不硬编码在源码）。V1.0 方案 H-05。
 *
 * 计算规则：
 *   - 只统计"有效代码行"：过滤空行 + 纯注释行（//、/*、*、#、-- 开头）——避免大量注释/空行改动误判大改写；
 *   - 二进制/超长行文件跳过（含 NUL 字节即视为二进制，不参与判定）；
 *   - 变更占比 = 差异有效行数 / max(旧有效行, 新有效行)。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_REWRITE_RATIO = 0.7;

interface GlobalsConfig { large_rewrite_threshold_ratio?: number; }

/** 读取全局配置阈值（默认 0.7；配置缺失/非法回落默认，fail-safe 从宽不从严） */
export function loadRewriteThreshold(projectRoot?: string): number {
  try {
    const root = projectRoot ?? process.cwd();
    const p = join(root, 'data', 'harness_globals.json');
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf-8')) as GlobalsConfig;
      const v = Number(j.large_rewrite_threshold_ratio);
      if (Number.isFinite(v) && v > 0 && v <= 1) return v;
    }
  } catch { /* ignore */ }
  return DEFAULT_REWRITE_RATIO;
}

/** 是否疑似二进制（前 8KB 含 NUL） */
export function isLikelyBinary(content: string): boolean {
  const head = content.slice(0, 8192);
  return head.includes('\0');
}

/** 有效代码行：去空行 + 纯注释行（/、*、#、-- 开头；不含行内尾注释） */
export function effectiveLines(content: string): string[] {
  const raw = content.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of raw) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('#') || t.startsWith('--')) continue;
    out.push(line);
  }
  return out;
}

/**
 * 变更占比（0~1）。返回 null 表示不应判定（二进制 / 无旧文件=新建）。
 */
export function computeRewriteRatio(oldContent: string, newContent: string): number | null {
  if (isLikelyBinary(oldContent) || isLikelyBinary(newContent)) return null;
  const a = effectiveLines(oldContent);
  const b = effectiveLines(newContent);
  const base = Math.max(a.length, b.length);
  if (base === 0) return null; // 双空，无意义
  // 逐行比较（到较短的为止），不同行 + 超出部分行 = 差异
  let diff = 0;
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) if (a[i] !== b[i]) diff++;
  diff += Math.abs(a.length - b.length);
  return diff / base;
}

/** 便捷判定：是否疑似整文件覆写（返回 { suspected, ratio }） */
export function isFullFileRewrite(oldContent: string, newContent: string, threshold?: number): { suspected: boolean; ratio: number | null } {
  const ratio = computeRewriteRatio(oldContent, newContent);
  const th = threshold ?? loadRewriteThreshold();
  if (ratio === null) return { suspected: false, ratio: null };
  return { suspected: ratio > th, ratio: Math.round(ratio * 100) / 100 };
}

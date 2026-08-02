/**
 * git-diff-adapter.ts — Read-only Git Diff Adapter (P2-T4)
 * ==========================================================
 * P2-T4: 只读 Git Diff 适配器，用于采集 changed paths。
 *
 * 特性：
 * - 只读 git 命令（diff/status/ls-files），不执行任何写操作
 * - 可注入 CommandRunner，测试不依赖真实 git
 * - 默认 runner 使用 child_process.execFile（不走 shell）
 * - ref 参数做基础注入防护
 * - 支持 staged / unstaged / ref diff / untracked
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { RelativePath } from './types';

const execFileP = promisify(execFile);

// ============================================================================
// 导出类型
// ============================================================================

/** Git 命令执行结果 */
export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

/** 可注入的 Git 命令执行器 */
export type GitCommandRunner = (
  args: string[],
  options: { cwd?: string },
) => Promise<GitCommandResult>;

/** getChangedPathsFromGitDiff 的选项 */
export interface GetChangedPathsFromGitDiffOptions {
  /** Git 工作目录，默认 process.cwd() */
  cwd?: string;
  /** diff 基准 ref */
  baseRef?: string;
  /** diff 目标 ref */
  headRef?: string;
  /** 是否读取 staged diff */
  staged?: boolean;
  /** 是否包含 untracked 文件 */
  includeUntracked?: boolean;
  /** 测试注入 */
  runner?: GitCommandRunner;
}

// ============================================================================
// defaultGitCommandRunner
// ============================================================================

/**
 * 默认 git 命令执行器。
 * 使用 execFile 而非 exec —— 不走 shell，参数直接传递给 git。
 * 不导出任何可执行任意命令的接口。
 */
export const defaultGitCommandRunner: GitCommandRunner = async (
  args: string[],
  options: { cwd?: string },
): Promise<GitCommandResult> => {
  const { stdout, stderr } = await execFileP('git', args, {
    cwd: options.cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
};

// ============================================================================
// 路径处理
// ============================================================================

/**
 * 标准化单个路径：反斜杠→斜杠、trim、去除前导 ./。
 * 不检查文件是否存在。
 */
export function normalizeGitDiffPath(value: string): RelativePath {
  let s = value.trim();
  s = s.replace(/\\/g, '/');
  // 去除前导 ./
  if (s.startsWith('./')) {
    s = s.slice(2);
  }
  return s;
}

/**
 * 解析 git --name-only 输出为标准化相对路径列表。
 * 去重并保持首次出现顺序。
 */
export function parseGitNameOnlyOutput(output: string): RelativePath[] {
  const lines = output.split('\n');
  const seen = new Set<string>();
  const result: RelativePath[] = [];

  for (const line of lines) {
    const p = normalizeGitDiffPath(line);
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    result.push(p);
  }

  return result;
}

// ============================================================================
// getChangedPathsFromGitDiff
// ============================================================================

/**
 * 通过只读 git 命令采集 changed paths。
 *
 * 命令策略：
 * - 默认: `git diff --name-only`
 * - staged: `git diff --cached --name-only`
 * - refs: `git diff --name-only <base> <head>`
 * - includeUntracked: 追加 `git ls-files --others --exclude-standard`
 *
 * 不执行任何写 Git 命令。
 */
export async function getChangedPathsFromGitDiff(
  options: GetChangedPathsFromGitDiffOptions = {},
): Promise<RelativePath[]> {
  const cwd = options.cwd ?? process.cwd();
  const runner = options.runner ?? defaultGitCommandRunner;

  // ── 确定命令参数 ──
  const args: string[] = ['diff'];
  let mode = 'default'; // default | staged | refs

  if (options.staged && options.baseRef) {
    throw new Error('Cannot specify both staged and baseRef for git diff.');
  }

  if (options.staged) {
    args.push('--cached');
    mode = 'staged';
  } else if (options.baseRef || options.headRef) {
    if (!options.baseRef || !options.headRef) {
      throw new Error('Both baseRef and headRef are required for ref diff.');
    }
    validateRef(options.baseRef, 'baseRef');
    validateRef(options.headRef, 'headRef');
    args.push(options.baseRef, options.headRef);
    mode = 'refs';
  }

  args.push('--name-only');

  // ── 执行 diff 命令 ──
  let diffOutput: string;
  try {
    const result = await runner(args, { cwd });
    diffOutput = result.stdout;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error('Failed to read git changed paths: ' + msg);
  }

  const changed = parseGitNameOnlyOutput(diffOutput);

  // ── includeUntracked ──
  if (options.includeUntracked) {
    let untrackedOutput: string;
    try {
      const result = await runner(
        ['ls-files', '--others', '--exclude-standard'],
        { cwd },
      );
      untrackedOutput = result.stdout;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error('Failed to list untracked files: ' + msg);
    }

    const untracked = parseGitNameOnlyOutput(untrackedOutput);

    // 合并去重保序：已有的不动，新的追加到末尾
    const existing = new Set(changed);
    for (const p of untracked) {
      if (!existing.has(p)) {
        existing.add(p);
        changed.push(p);
      }
    }
  }

  return changed;
}

// ============================================================================
// Ref 校验
// ============================================================================

const INVALID_REF_PATTERN = /[\s;&|]/;

/**
 * 校验 git ref 参数不包含危险字符。
 * 虽然使用 execFile 不走 shell，但做保守校验以防路径遍历或命令注入。
 */
function validateRef(ref: string, label: string): void {
  if (!ref || !ref.trim()) {
    throw new Error(`Invalid git ref (${label}): empty or whitespace only`);
  }
  if (INVALID_REF_PATTERN.test(ref)) {
    throw new Error(
      `Invalid git ref (${label}): contains prohibited characters: ${ref}`,
    );
  }
}

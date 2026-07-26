/**
 * NativeCommands — 项目原生命令封装
 * ======================================
 * 封装 WenStarOS 项目常用命令，供 Harness Stage 调用。
 *
 * 内置命令：
 *   - tsc 编译检查
 *   - vitest 单元测试
 *   - webui 启动（及进程管理）
 *   - safe-backfill 数据库回填
 *   - 按模块目录专项测试
 */

import { execSync, type ExecSyncOptions } from 'node:child_process';
import { resolve } from 'node:path';

/** 命令执行结果 */
export interface NativeCommandResult {
  /** 命令字符串 */
  command: string;
  /** 是否成功（exitCode === 0） */
  success: boolean;
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 退出码 */
  exitCode: number;
  /** 执行耗时 (ms) */
  durationMs: number;
}

/** 命令执行选项 */
interface CommandOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

// ════════════════════════════════════════════════════════════════════
// 公开 API
// ════════════════════════════════════════════════════════════════════

/**
 * TypeScript 编译检查（tsc --noEmit）。
 * 不产生输出文件，仅做类型检查。
 */
export function tscCheck(options?: CommandOptions): NativeCommandResult {
  return run('npx tsc --noEmit', {
    ...options,
    timeout: options?.timeout ?? 120_000,
  }, 'tsc 编译检查');
}

/**
 * 全量 vitest 单元测试。
 */
export function vitestRun(options?: { cwd?: string; timeout?: number }): NativeCommandResult {
  return run('npx vitest run', {
    ...options,
    timeout: options?.timeout ?? 300_000, // 5分钟
  }, 'vitest 全量测试');
}

/**
 * 按目录专项 vitest 测试。
 * @param dirPattern — 目录模式，如 "src/m4"、"src/m2"
 */
export function vitestRunDir(dirPattern: string, options?: { cwd?: string; timeout?: number }): NativeCommandResult {
  const projectRoot = options?.cwd || process.cwd();
  const absDir = resolve(projectRoot, dirPattern);

  return run(`npx vitest run --dir "${absDir}"`, {
    ...options,
    timeout: options?.timeout ?? 180_000,
  }, `vitest 专项测试: ${dirPattern}`);
}

/**
 * 启动 WebUI 服务（阻塞式，用于功能验证阶段）。
 * 注意：此命令会启动 HTTP 服务，调用方需自行管理进程生命周期。
 *
 * @returns 包含进程引用的结果（通过附加字段）
 */
export function webuiStart(options?: { cwd?: string }): NativeCommandResult & { pid?: number } {
  // 使用 start.cjs 脚本启动
  const result = run('node start.cjs', {
    ...options,
    timeout: 30_000, // 仅等待启动
  }, 'webui 启动');

  return result;
}

/**
 * 数据库离线回填脚本 safe-backfill。
 * 修复 UUID 标注，验证数据兼容性。
 */
export function safeBackfill(options?: CommandOptions): NativeCommandResult {
  return run('node scripts/safe-backfill.cjs', {
    ...options,
    timeout: 300_000, // 5分钟——回填可能较大
  }, 'safe-backfill 数据库回填');
}

/**
 * UUID 标注率查询脚本（返回结构化结果）。
 */
export function uuidLabelRateCheck(options?: CommandOptions): NativeCommandResult {
  return run('npx tsx scripts/uuid-label-rate-check.ts', {
    ...options,
    timeout: 60_000,
  }, 'UUID 标注率查询');
}

// ════════════════════════════════════════════════════════════════════
// 内部实现
// ════════════════════════════════════════════════════════════════════

function run(command: string, options: CommandOptions, label: string): NativeCommandResult {
  const startTime = Date.now();

  const execOptions: ExecSyncOptions = {
    cwd: options?.cwd || process.cwd(),
    timeout: options?.timeout ?? 120_000,
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024, // 20MB
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...options?.env },
  };

  console.log(`[NativeCommands] 🔧 ${label}: ${command}`);

  try {
    const stdout = execSync(command, execOptions);
    const durationMs = Date.now() - startTime;

    console.log(`[NativeCommands] ✅ ${label} 完成 (${durationMs}ms)`);

    return {
      command,
      success: true,
      stdout: stdout.toString().trim(),
      stderr: '',
      exitCode: 0,
      durationMs,
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const exitCode = err.status ?? 1;
    const stdout = err.stdout?.toString?.()?.trim?.() ?? '';
    const stderr = err.stderr?.toString?.()?.trim?.() ?? err.message ?? '';

    console.error(`[NativeCommands] ❌ ${label} 失败 (exit: ${exitCode}, ${durationMs}ms)`);
    if (stderr) console.error(`[NativeCommands] stderr: ${stderr.slice(0, 500)}`);

    return {
      command,
      success: false,
      stdout,
      stderr,
      exitCode,
      durationMs,
    };
  }
}

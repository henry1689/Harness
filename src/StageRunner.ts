/**
 * StageRunner — Stage 执行器（双 Runner 模式）
 * ===============================================
 * local: 本机执行——受白名单管控的文件读写/命令执行
 * delegate: 委托隔离上下文子 Agent——输出双通道 StageOutput
 *
 * 核心设计：
 *   - local runner 的每个操作前必须通过 ToolWhitelistGuard.checkPermission()
 *   - delegate runner 隔离到独立 Agent 上下文，子 Agent 仅能返回结构化信号
 *   - 执行结果统一包装为 StageResult
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync, exec } from 'node:child_process';
import { resolve } from 'node:path';
import type {
  StageConfig,
  StageResult,
  StageStatus,
  StageOutput,
  AuditEntry,
  FlowRunState,
  MachineSignal,
} from './types.js';
import { StageExecutionError } from './types.js';
import { ToolWhitelistGuard } from './ToolWhitelistGuard.js';
import { validateStageOutput } from './DualChannelSignal.js';

/** StageRunner 构造选项 */
export interface StageRunnerOptions {
  /** delegate runner 的评审函数（外部注入） */
  delegateReviewFn?: DelegateReviewFn;
  /** 🔴 按阶段分派的评审函数（优先于 delegateReviewFn） */
  delegateReviewFnMap?: Map<string, DelegateReviewFn>;
  /** 项目根目录 */
  projectRoot?: string;
  /** 🔴 P5: condition gate 前置检查（如 S3 tsc 自检）。传入 stage_id，返回是否通过 */
  conditionGateCheck?: (stageId: string, projectRoot: string) => Promise<{ passed: boolean; reason?: string }>;
}

/** 委托评审函数签名：接收 stage 配置和运行状态，返回 StageOutput */
export type DelegateReviewFn = (stage: StageConfig, state: FlowRunState) => Promise<StageOutput>;

/** 文件读取结果 */
interface ReadFileResult {
  path: string;
  content: string;
  lines: number;
}

/** 命令执行结果 */
interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class StageRunner {
  private readonly delegateReviewFn: DelegateReviewFn | null;
  private readonly delegateReviewFnMap: Map<string, DelegateReviewFn>;
  private readonly projectRoot: string;
  private readonly conditionGateCheck: ((stageId: string, projectRoot: string) => Promise<{ passed: boolean; reason?: string }>) | null;
  private auditLog: AuditEntry[] = [];

  constructor(options: StageRunnerOptions = {}) {
    this.delegateReviewFn = options.delegateReviewFn ?? null;
    this.delegateReviewFnMap = options.delegateReviewFnMap ?? new Map();
    this.projectRoot = options.projectRoot ?? resolve('.');
    this.conditionGateCheck = options.conditionGateCheck ?? null;
  }

  /** 获取项目根目录 */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  // ════════════════════════════════════════════════════════════════
  // 公开 API
  // ════════════════════════════════════════════════════════════════

  /**
   * 执行一个 Stage。
   *
   * @param stage — Stage 配置
   * @param state — 当前流水线运行状态
   * @returns StageResult（含 machine_signal、human_report、审计记录）
   */
  async execute(stage: StageConfig, state: FlowRunState): Promise<StageResult> {
    const startTime = new Date().toISOString();
    this.auditLog = [];

    console.log(`[StageRunner] ▶ ${stage.stage_id} (${stage.stage_name}) [${stage.runner_mode}/${stage.gate_type}]`);

    try {
      let result: StageResult;

      switch (stage.runner_mode) {
        case 'local':
          result = await this.runLocal(stage, state);
          break;
        case 'delegate':
          result = await this.runDelegate(stage, state);
          break;
        default:
          throw new StageExecutionError(stage.stage_id, `未知 runner_mode: ${stage.runner_mode}`);
      }

      result.started_at = startTime;
      result.completed_at = new Date().toISOString();
      result.audit_entries = this.auditLog;
      result.status = 'completed';
      result.gate_type = stage.gate_type;

      console.log(`[StageRunner] ✓ ${stage.stage_id} 完成 → gate: ${stage.gate_type}`);
      return result;

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[StageRunner] ✗ ${stage.stage_id} 执行失败: ${errorMsg}`);

      this.addAudit('stage_exit', stage.stage_id, { error: errorMsg });

      // 🔴 condition gate 异常时也生成默认 machine_signal，避免 GateController 抛裸异常
      let machineSignal: MachineSignal | undefined;
      if (stage.gate_type === 'condition') {
        machineSignal = {
          passed: false,
          risk_level: 'high',
          reject_reason: [`Stage 执行异常: ${errorMsg}`],
          metrics: { files_checked: 0, violations_found: 1 },
        };
      }

      return {
        stage_id: stage.stage_id,
        status: 'rejected',
        gate_type: stage.gate_type,
        gate_resolution: 'condition_rejected',
        machine_signal: machineSignal,
        audit_entries: this.auditLog,
        started_at: startTime,
        completed_at: new Date().toISOString(),
        error: errorMsg,
      };
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 受白名单保护的文件操作（供 local runner 和外部调用）
  // ════════════════════════════════════════════════════════════════

  /** 读取文件——白名单检查后执行 */
  readFile(filePath: string, stageId: string): ReadFileResult {
    ToolWhitelistGuard.checkPermissionWithPath('read_file', filePath);

    const absPath = resolve(this.projectRoot, filePath);
    if (!existsSync(absPath)) {
      throw new StageExecutionError(stageId, `文件不存在: ${filePath}`);
    }

    const content = readFileSync(absPath, 'utf-8');
    const lines = content.split('\n').length;

    this.addAudit('tool_call', stageId, { tool: 'read_file', path: filePath, lines });

    return { path: filePath, content, lines };
  }

  /** 执行命令——白名单检查后执行 */
  runCommand(command: string, stageId: string, options?: { cwd?: string; timeout?: number }): CommandResult {
    ToolWhitelistGuard.checkPermission('run_command');

    const cwd = options?.cwd || this.projectRoot;
    const timeout = options?.timeout || 120_000;

    try {
      const stdout = execSync(command, {
        cwd,
        timeout,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.addAudit('tool_call', stageId, { tool: 'run_command', command, exitCode: 0 });

      return {
        command,
        stdout: stdout.trim(),
        stderr: '',
        exitCode: 0,
      };
    } catch (err: any) {
      const exitCode = err.status ?? 1;
      const stdout = err.stdout?.trim?.() ?? '';
      const stderr = err.stderr?.trim?.() ?? err.message ?? '';

      if (exitCode !== 0) {
        this.addAudit('tool_call', stageId, { tool: 'run_command', command, exitCode, error: stderr });
      }

      return { command, stdout, stderr, exitCode };
    }
  }

  /** 执行数据库脚本——白名单检查后执行 */
  runDbScript(script: string, stageId: string): CommandResult {
    ToolWhitelistGuard.checkPermission('run_db_script');
    this.addAudit('tool_call', stageId, { tool: 'run_db_script', script });
    return this.runCommand(script, stageId);
  }

  // ════════════════════════════════════════════════════════════════
  // 内部实现
  // ════════════════════════════════════════════════════════════════

  /** local 模式：本进程内执行 */
  private async runLocal(stage: StageConfig, state: FlowRunState): Promise<StageResult> {
    this.addAudit('stage_enter', stage.stage_id, {
      runner_mode: 'local',
      whitelist: Object.keys(stage.tool_whitelist).filter(k => stage.tool_whitelist[k as keyof typeof stage.tool_whitelist] === true),
    });

    // 🔴 P5: condition gate 前置检查 — 修复 S3 无条件放行
    // 原来所有 condition gate 的 local runner 都生成 passed=true，
    // 导致编译错误推迟到 S4.5 才被发现。现在允许注册前置检查。
    let machineSignal: MachineSignal | undefined;
    if (stage.gate_type === 'condition') {
      // 运行前置检查（如果注册了）
      let preCheckPassed = true;
      let preCheckReason = '';
      if (this.conditionGateCheck) {
        try {
          const preCheck = await this.conditionGateCheck(
            stage.stage_id,
            this.projectRoot || process.cwd(),
          );
          preCheckPassed = preCheck.passed;
          preCheckReason = preCheck.reason || '';
        } catch (err) {
          preCheckPassed = false;
          preCheckReason = `conditionGateCheck 异常: ${(err as Error).message}`;
        }
      }

      machineSignal = {
        passed: preCheckPassed,
        risk_level: preCheckPassed ? 'mid' : 'high',
        reject_reason: preCheckPassed ? [] : [preCheckReason || '前置检查未通过'],
        metrics: {
          files_checked: state.modified_files.length,
          violations_found: preCheckPassed ? 0 : 1,
        },
      };

      if (preCheckPassed) {
        console.log(`[StageRunner] ⚡ ${stage.stage_id} 本地条件门控: 前置检查通过 → 默认放行`);
      } else {
        console.log(`[StageRunner] 🚫 ${stage.stage_id} 本地条件门控: 前置检查未通过 → ${preCheckReason} → 回流 S4.5 兜底`);
      }
    }

    this.addAudit('stage_exit', stage.stage_id, { status: 'completed' });

    return {
      stage_id: stage.stage_id,
      status: 'completed',
      gate_type: stage.gate_type,
      gate_resolution: 'auto_passed', // 将由 GateController 覆盖
      machine_signal: machineSignal,
      audit_entries: [...this.auditLog],
      started_at: new Date().toISOString(),
    };
  }

  /** delegate 模式：委托子 Agent */
  private async runDelegate(stage: StageConfig, state: FlowRunState): Promise<StageResult> {
    this.addAudit('stage_enter', stage.stage_id, { runner_mode: 'delegate' });

    // 🔴 优先使用 per-stage map，其次默认函数
    const reviewFn = this.delegateReviewFnMap.get(stage.stage_id) ?? this.delegateReviewFn;
    if (!reviewFn) {
      throw new StageExecutionError(stage.stage_id, 'delegate runner 需要注入 delegateReviewFn，但未提供');
    }

    console.log(`[StageRunner] 🤖 委托子 Agent: ${stage.stage_id}`);
    if (this.delegateReviewFnMap.has(stage.stage_id)) {
      console.log(`[StageRunner]    使用阶段专属评审函数`);
    }

    // 调用委托函数——子 Agent 执行评审并返回双通道输出
    const output: StageOutput = await reviewFn(stage, state);

    // 校验输出完整性
    const validated = validateStageOutput(output);

    this.addAudit('machine_signal', stage.stage_id, {
      passed: validated.machine_signal.passed,
      risk_level: validated.machine_signal.risk_level,
      reasons: validated.machine_signal.reject_reason,
    });

    this.addAudit('stage_exit', stage.stage_id, {
      status: 'completed',
      signal_passed: validated.machine_signal.passed,
    });

    return {
      stage_id: stage.stage_id,
      status: 'completed',
      gate_type: stage.gate_type,
      gate_resolution: 'condition_passed', // 将由 GateController 覆盖
      machine_signal: validated.machine_signal,
      human_report: validated.human_report,
      audit_entries: [...this.auditLog],
      started_at: new Date().toISOString(),
    };
  }

  /** 添加审计记录 */
  private addAudit(event: string, stageId: string, detail: Record<string, unknown>): void {
    this.auditLog.push({
      event: event as AuditEntry['event'],
      timestamp: new Date().toISOString(),
      stage_id: stageId,
      detail,
    });
  }
}

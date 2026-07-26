/**
 * ToolWhitelistGuard — 工具白名单底层拦截
 * =============================================
 * 在执行层强制拦截被禁止的操作，不依赖 LLM 自觉。
 *
 * 核心设计：
 *   - 每个 Stage 启动时 activate() 激活白名单
 *   - Stage 结束时 deactivate() 清除
 *   - 每次文件/命令操作前调用 checkPermission(action)
 *   - 白名单中 false 的操作直接抛出 WhitelistViolationError
 *   - 非流水线模式（无 activeWhitelist）不拦截，零影响
 */

import type { WhitelistKey } from './types.js';
import { WhitelistViolationError } from './types.js';

/** 白名单操作到实际文件系统操作的映射 */
interface ActionMapping {
  /** 此白名单键覆盖的操作列表 */
  operations: string[];
  /** 人类可读的描述 */
  description: string;
}

/**
 * 🔴 基础设施保护区前缀——永久只读，不可被业务流水线写入。
 * 此列表为 Harness SelfGuard 最高优先级规则，凌驾于 Stage 级白名单之上。
 */
const HARNESS_PROTECTED_PREFIXES: readonly string[] = [
  'src/harness',
  'data/harness',
  '.claude/settings.json',
  '.claude/harness',
  '.claude/workflows',
];

/** 🔴 写入类操作集合——命中 /harness 时一律拒绝 */
const WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'write_file', 'edit_file', 'create_file', 'mkdir', 'fs.writeFileSync', 'fs.writeFile', 'fs.mkdirSync',
  'delete_file', 'rm', 'unlink', 'rmdir', 'fs.unlinkSync', 'fs.rmSync',
  'truncate_db', 'drop_table', 'delete_from_db', 'DELETE FROM',
  'run_modify_script', 'safe-backfill', 'migration',
]);

/** 操作映射表——将白名单键映射到具体的文件/命令操作 */
const ACTION_MAP: Record<WhitelistKey, ActionMapping> = {
  read_file: {
    operations: ['read_file', 'cat', 'open', 'fs.readFileSync', 'fs.readFile'],
    description: '读取文件',
  },
  write_file: {
    operations: ['write_file', 'edit_file', 'create_file', 'mkdir', 'fs.writeFileSync', 'fs.writeFile', 'fs.mkdirSync'],
    description: '写入/创建文件',
  },
  delete_file: {
    operations: ['delete_file', 'rm', 'unlink', 'rmdir', 'fs.unlinkSync', 'fs.rmSync'],
    description: '删除文件',
  },
  run_command: {
    operations: ['run_command', 'exec', 'spawn', 'execSync', 'npx', 'npm', 'tsc', 'vitest'],
    description: '执行命令',
  },
  run_db_script: {
    operations: ['run_db_script', 'db:query', 'db:execute', 'sqlite:write'],
    description: '执行数据库脚本',
  },
  truncate_db: {
    operations: ['truncate_db', 'drop_table', 'delete_from_db', 'db:truncate', 'db:drop', 'DELETE FROM'],
    description: '截断数据库',
  },
  run_modify_script: {
    operations: ['run_modify_script', 'safe-backfill', 'migration', 'db:migrate', 'ts-node'],
    description: '运行修改脚本',
  },
  search_code: {
    operations: ['search_code', 'grep', 'rg', 'find', 'search'],
    description: '搜索代码',
  },
  grep_import: {
    operations: ['grep_import', 'find_imports', 'import_search'],
    description: '搜索导入依赖',
  },
  list_dir: {
    operations: ['list_dir', 'ls', 'readdir', 'fs.readdirSync'],
    description: '列出目录',
  },
  run_cli_check: {
    operations: ['run_cli_check', 'health-check', 'sandbox', 'check'],
    description: '运行CLI检查',
  },
};

export class ToolWhitelistGuard {
  /** 当前激活的白名单（null = 非流水线模式，不拦截） */
  private static _activeWhitelist: Partial<Record<WhitelistKey, boolean>> | null = null;

  /** 当前激活的 stage_id（用于错误信息） */
  private static _activeStageId: string = '';

  /** 拦截统计 */
  private static _blockedCount: number = 0;
  private static _allowedCount: number = 0;

  // ════════════════════════════════════════════════════════════════
  // 公开 API
  // ════════════════════════════════════════════════════════════════

  /**
   * 激活白名单。
   * @param whitelist — stage 配置中的 tool_whitelist
   * @param stageId — 当前 stage ID（用于错误报告）
   */
  static activate(whitelist: Partial<Record<WhitelistKey, boolean>>, stageId: string): void {
    this._activeWhitelist = { ...whitelist };
    this._activeStageId = stageId;
    this._blockedCount = 0;
    this._allowedCount = 0;
    console.log(`[ToolWhitelistGuard] 🔒 已激活 (${stageId}), ${Object.keys(whitelist).length} 条规则`);
  }

  /** 停用白名单——释放所有限制 */
  static deactivate(): void {
    if (this._activeWhitelist) {
      console.log(`[ToolWhitelistGuard] 🔓 已停用 (${this._activeStageId}), 放行 ${this._allowedCount}, 拦截 ${this._blockedCount}`);
    }
    this._activeWhitelist = null;
    this._activeStageId = '';
  }

  /** 当前是否处于白名单管控中 */
  static isActive(): boolean {
    return this._activeWhitelist !== null;
  }

  /**
   * 检查操作权限（不含文件路径上下文，向后兼容）。
   *
   * @param action — 具体的操作名称（如 'write_file', 'rm', 'npx tsc'）
   * @throws WhitelistViolationError 操作被白名单禁止
   */
  static checkPermission(action: string): void {
    // 非流水线模式，不拦截（.claude hook 层已覆盖 /harness 只读保护）
    if (!this._activeWhitelist) return;
    this._checkStageWhitelist(action);
  }

  /**
   * 检查操作权限 + 文件路径上下文。
   * 🔴 基础设施保护区检查优先于 Stage 白名单——/harness 写入永远拒绝。
   *
   * @param action — 具体的操作名称
   * @param filePath — 操作目标文件路径（如 'src/harness/FlowEngine.ts'）
   * @throws WhitelistViolationError
   */
  static checkPermissionWithPath(action: string, filePath: string): void {
    // 🔴 第一道：基础设施保护区硬拦截（凌驾于 Stage 白名单）
    this._checkHarnessPathProtection(filePath, action);

    // 第二道：Stage 白名单
    if (!this._activeWhitelist) return;
    this._checkStageWhitelist(action);
  }

  /**
   * 🔴 基础设施保护区路径校验。
   * 写入/删除操作命中 /harness 目录 → 无条件拒绝。
   */
  private static _checkHarnessPathProtection(filePath: string, action: string): void {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const normalizedAction = action.toLowerCase();

    // 只拦截写入/删除类操作
    const isWriteAction = [...WRITE_ACTIONS].some(op =>
      normalizedAction === op.toLowerCase() || normalizedAction.includes(op.toLowerCase()),
    );
    if (!isWriteAction) return;

    // 检查是否命中基础设施保护区
    const hit = HARNESS_PROTECTED_PREFIXES.some(prefix =>
      normalizedPath.startsWith(prefix) || normalizedPath.includes('/' + prefix),
    );
    if (!hit) return;

    // 🔴 硬拦截
    this._blockedCount++;
    const msg =
      `⛔ [Harness·自护] 基础设施保护区禁止写入。` +
      `路径 "${filePath}" 属于 /harness 全目录只读保护范围。` +
      `请通过 SelfGuard 独立流水线提交基础设施变更。`;
    console.error(`[ToolWhitelistGuard] 🚫 ${msg}`);
    throw new WhitelistViolationError(action, 'HARNESS_SELFGUARD_PERMANENT');
  }

  /** Stage 级白名单校验（内部逻辑，与旧 checkPermission 相同） */
  private static _checkStageWhitelist(action: string): void {
    const key = this.findWhitelistKey(action);
    if (!key) {
      console.debug(`[ToolWhitelistGuard] ⚠️ 未定义操作 "${action}"，默认放行`);
      this._allowedCount++;
      return;
    }

    const allowed = this._activeWhitelist![key];

    if (allowed === true) {
      this._allowedCount++;
      return;
    }

    this._blockedCount++;
    const desc = ACTION_MAP[key]?.description || key;
    const msg = `Stage "${this._activeStageId}" 禁止${desc}（白名单键: ${key}）。当前操作 "${action}" 已被拒绝。`;
    console.error(`[ToolWhitelistGuard] 🚫 ${msg}`);
    throw new WhitelistViolationError(action, this._activeStageId);
  }

  /**
   * 检查多个操作是否全部允许。
   * @returns 被禁止的操作列表，空数组 = 全部允许
   */
  static checkPermissions(actions: string[]): string[] {
    const blocked: string[] = [];
    for (const action of actions) {
      try {
        this.checkPermission(action);
      } catch {
        blocked.push(action);
      }
    }
    return blocked;
  }

  /** 获取拦截统计 */
  static getStats(): { allowed: number; blocked: number; stageId: string } {
    return {
      allowed: this._allowedCount,
      blocked: this._blockedCount,
      stageId: this._activeStageId,
    };
  }

  // ════════════════════════════════════════════════════════════════
  // 内部实现
  // ════════════════════════════════════════════════════════════════

  /** 根据操作名称反向查找白名单键 */
  private static findWhitelistKey(action: string): WhitelistKey | null {
    const lowerAction = action.toLowerCase();

    for (const [key, mapping] of Object.entries(ACTION_MAP) as [WhitelistKey, ActionMapping][]) {
      for (const op of mapping.operations) {
        if (lowerAction === op.toLowerCase() || lowerAction.includes(op.toLowerCase())) {
          return key;
        }
      }
    }

    return null;
  }
}

/**
 * Harness MCP Server — 零依赖 stdio JSON-RPC
 * ==============================================
 * 将 Harness 引擎能力通过 MCP 协议暴露给 Claude Code。
 *
 * 工具清单：
 *   harness_pre_check  — 文件路径保护区检查（替代 Hook 脚本）
 *   harness_run_flow   — 触发 YAML 流水线
 *   harness_list_flows — 列出可用流水线
 *
 * 使用方式（WenStar-cc .claude/mcp.json）：
 *   { "mcpServers": { "harness": { "command": "npx", "args": ["tsx", "D:/AI文件/harness/mcp/server.ts"] } } }
 */

import * as readline from 'node:readline';

// ════════════════════════════════════════════════════════════════════
// Harness 基础设施保护区（与 harness-pre-check.cjs 保持同步）
// ════════════════════════════════════════════════════════════════════
const HARNESS_PROTECTED = [
  'src/harness/', 'data/harness/', '.claude/settings.json',
  '.claude/harness', '.claude/workflows',
];

function isProtected(fp: string): { hit: boolean; rule: string } {
  const n = fp.replace(/\\/g, '/');
  for (const p of HARNESS_PROTECTED) {
    if (n.startsWith(p) || n.includes('/' + p)) return { hit: true, rule: p };
  }
  return { hit: false, rule: '' };
}

// ════════════════════════════════════════════════════════════════════
// MCP JSON-RPC 核心
// ════════════════════════════════════════════════════════════════════
interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function respond(id: number | string, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function error(id: number | string, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

// ════════════════════════════════════════════════════════════════════
// 工具定义
// ════════════════════════════════════════════════════════════════════
const TOOLS = [
  {
    name: 'harness_pre_check',
    description:
      '🔴 修改文件前必须调用。检查目标路径是否命中 Harness 基础设施保护区（/harness 只读）。' +
      '若返回 blocked=true，禁止继续修改，必须走 SelfGuard 独立流水线。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '即将修改的文件路径，如 src/harness/FlowEngine.ts' },
        action: { type: 'string', description: '操作类型：write / delete / edit', default: 'write' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'harness_run_flow',
    description:
      '触发 Harness 流水线。传入 YAML 配置文件名和修改文件列表，执行完整的 S1-S7 状态机流程。',
    inputSchema: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'YAML 配置文件名，如 wenstaros_core_repair_flow.yaml' },
        files: { type: 'array', items: { type: 'string' }, description: '待修改文件列表' },
        message: { type: 'string', description: '原始修改意图描述' },
      },
      required: ['flow', 'files'],
    },
  },
  {
    name: 'harness_list_flows',
    description: '列出 data/flows/ 下所有可用的 YAML 流水线配置。',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ════════════════════════════════════════════════════════════════════
// 工具实现
// ════════════════════════════════════════════════════════════════════
async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'harness_pre_check': {
      const fp = String(args.file_path || '');
      if (!fp) return { blocked: false, reason: 'no file_path provided' };
      const { hit, rule } = isProtected(fp);
      return {
        blocked: hit,
        file: fp,
        protected_rule: rule || null,
        instruction: hit
          ? `⛔ 路径 "${fp}" 命中 Harness 基础设施保护区 "${rule}"。该目录只读，禁止业务流水线直接写入。请通过 SelfGuard 独立流水线提交变更。`
          : `✅ 路径 "${fp}" 不在 Harness 保护区内，可以继续。`,
      };
    }

    case 'harness_run_flow': {
      const flowName = String(args.flow || 'wenstaros_core_repair_flow.yaml');
      const files = (Array.isArray(args.files) ? args.files : []) as string[];
      const message = String(args.message || '');

      if (files.length === 0) {
        return { success: false, error: '未指定修改文件' };
      }

      // 动态加载 Harness 引擎（ESM）
      const { FlowEngine } = await import('../src/FlowEngine.js');
      const { classifyFiles, isTrivialChange } = await import('../src/RiskClassifier.js');
      const { review } = await import('../src/DelegateReviewer.js');

      const risk = classifyFiles(files);
      const trivial = isTrivialChange(message, files);

      // 自由裸奔
      if (risk === 'low' && trivial) {
        return {
          success: true,
          mode: 'free',
          risk,
          files,
          message: `🆓 低风险微小修改，跳过流水线。可直接修改，但请注意遵守系统不变量。`,
        };
      }

      const engine = new FlowEngine({
      delegateReviewFn: async (stage, state) => review(stage, state),
      projectRoot: process.cwd(),
      // No onHumanGate → human stages will timeout → pipeline abort
      // This ensures pipeline CANNOT silently pass without human approval
    });

      const result = await engine.start(flowName, {
        message,
        modifiedFiles: files,
        riskLevel: risk,
        isTrivial: trivial,
      });

      // 写入通行令牌——Hook 检查此令牌决定是否放行
      if (result.success) {
        try {
          const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
          const { resolve: resolvePath } = await import('node:path');
          const tokenDir = resolvePath(import.meta.dirname!, '..', 'data', 'tokens');
          if (!existsSync(tokenDir)) mkdirSync(tokenDir, { recursive: true });

          const EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours
          const now = Date.now();

          for (const f of files) {
            const hash = Math.abs(
              f.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)
            ).toString(36);
            const tokenPath = resolvePath(tokenDir, hash + '.json');
            writeFileSync(tokenPath, JSON.stringify({
              file: f,
              files: files,
              passed: true,
              consumed: false,
              usage_count: 0,
              run_id: result.run_id,
              risk_level: risk,
              caller_uuid: 'sg-mcp-v3-00000000-0000-0000-0000-000000000001',
              issued_at: new Date(now).toISOString(),
              expires_at: now + EXPIRY_MS,
            }, null, 2), 'utf-8');
          }

          console.error('[harness-mcp] Pass tokens issued for ' + files.length + ' file(s), expires in 2h');
        } catch (err) {
          console.error('[harness-mcp] Token write failed:', (err as Error).message);
        }
      }

      return {
        success: result.success,
        run_id: result.run_id,
        end_reason: result.end_reason,
        risk,
        files,
        stage_count: result.stage_results.length,
        stages: result.stage_results.map(s => ({
          id: s.stage_id,
          status: s.status,
          gate: s.gate_resolution,
        })),
        token_issued: result.success,
        token_expires_in: result.success ? '2 hours' : 'N/A',
        human_gate_note: result.success
          ? 'Pipeline completed successfully. Token issued.'
          : 'Pipeline FAILED. Human approval is REQUIRED for S1/S2 stages. No token issued. Ensure user explicitly approves before re-running.',
      };
    }

    case 'harness_list_flows': {
      const { readdirSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const flowsDir = resolve(import.meta.dirname!, '..', 'data', 'flows');
      try {
        const files = readdirSync(flowsDir).filter(f => f.endsWith('.yaml'));
        return { flows: files, count: files.length };
      } catch {
        return { flows: [], count: 0, error: 'flows 目录不可读' };
      }
    }

    default:
      return { error: `未知工具: ${name}` };
  }
}

// ════════════════════════════════════════════════════════════════════
// stdio 消息循环
// ════════════════════════════════════════════════════════════════════
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line: string) => {
  let req: RpcRequest;
  try {
    req = JSON.parse(line);
  } catch {
    error(0, -32700, 'Parse error');
    return;
  }

  try {
    switch (req.method) {
      case 'initialize':
        respond(req.id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'harness', version: '2.0.0' },
          capabilities: { tools: {} },
        });
        break;

      case 'tools/list':
        respond(req.id, { tools: TOOLS });
        break;

      case 'tools/call': {
        const { name, arguments: args } = (req.params || {}) as { name?: string; arguments?: Record<string, unknown> };
        if (!name) { error(req.id, -32602, 'missing tool name'); break; }
        const result = await handleToolCall(name, args || {});
        respond(req.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        break;
      }

      default:
        error(req.id, -32601, `Method not found: ${req.method}`);
    }
  } catch (e: any) {
    error(req.id, -32603, e.message || String(e));
  }
});

// 就绪信号（stderr 不进协议）
process.stderr.write('[harness-mcp] Harness MCP Server v2.0 已启动 (stdio)\n');

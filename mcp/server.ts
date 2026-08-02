/**
 * Harness MCP Server v2.1 — Streamable HTTP 聚合服务
 * ===================================================
 * 基于 @modelcontextprotocol/sdk v1.30+ 的 StreamableHTTPServerTransport。
 *
 * 架构:
 *   - 独立常驻 HTTP 服务（localhost:8765），不依附于 Claude Code 会话
 *   - 一个服务 → 多客户端并发接入（WenStar-cc / 天权 / 任意项目）
 *   - 无状态模式（sessionIdGenerator: undefined），每个请求独立处理
 *
 * 工具清单:
 *   harness_pre_check  — 路径保护区检查
 *   harness_run_flow   — 触发 YAML 流水线（S1-S7 + S4.5 收敛闸门）
 *   harness_list_flows — 列出可用流水线
 *
 * 启动方式:
 *   node mcp/start.cjs
 *   或直接: npx tsx mcp/server.ts
 *
 * 客户端配置（任意项目的 .claude/mcp.json）:
 *   { "mcpServers": { "harness": { "type": "streamableHttp", "url": "http://127.0.0.1:8765" } } }
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdirSync, writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

// @modelcontextprotocol/sdk 1.30+
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

// Harness 自进化引擎
import { EvolutionEngine } from '../src/EvolutionEngine.js';
import { getUpgradeProgress } from '../src/HardnessLadder.js';

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

/** 简单字符串哈希 */
function hashCode(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// ════════════════════════════════════════════════════════════════════
// MCP Server 创建 & 工具注册
// ════════════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.HARNESS_MCP_PORT || '8765');
const PROJECT_ROOT = process.env.HARNESS_PROJECT_ROOT || process.cwd();

// ════════════════════════════════════════════════════════════════════
// 自进化引擎单例（随 MCP 服务启动，必须在 PROJECT_ROOT 之后初始化）
// ════════════════════════════════════════════════════════════════════

const evolutionEngine = new EvolutionEngine({
  dataDir: resolve(import.meta.dirname!, '..', 'data'),
  projectRoot: PROJECT_ROOT,
  currentLevel: 'L1',
  pollIntervalMs: 60_000,    // 每 60 秒增量扫描
  analysisIntervalMs: 3600_000, // 每小时全量分析
});
evolutionEngine.start();

const mcpServer = new McpServer({
  name: 'harness',
  version: '2.1.0',
});

// ── 工具 1: harness_pre_check ──
mcpServer.registerTool(
  'harness_pre_check',
  {
    description:
      '🔴 修改文件前必须调用。检查目标路径是否命中 Harness 基础设施保护区（/harness 只读）。' +
      '若返回 blocked=true，禁止继续修改，必须走 SelfGuard 独立流水线。',
    inputSchema: {
      file_path: z.string().describe('即将修改的文件路径，如 src/harness/FlowEngine.ts'),
      action: z.string().optional().describe('操作类型：write / delete / edit'),
    },
  },
  async ({ file_path }) => {
    if (!file_path) return { content: [{ type: 'text' as const, text: JSON.stringify({ blocked: false, reason: 'no file_path provided' }) }] };
    const { hit, rule } = isProtected(file_path);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          blocked: hit,
          file: file_path,
          protected_rule: rule || null,
          instruction: hit
            ? `⛔ 路径 "${file_path}" 命中 Harness 基础设施保护区 "${rule}"。该目录只读，禁止业务流水线直接写入。请通过 SelfGuard 独立流水线提交变更。`
            : `✅ 路径 "${file_path}" 不在 Harness 保护区内，可以继续。`,
        }, null, 2),
      }],
    };
  },
);

// ── 工具 2: harness_run_flow ──
mcpServer.registerTool(
  'harness_run_flow',
  {
    description:
      '触发 Harness 流水线。指定 YAML 配置文件名和修改文件列表，执行完整的 S1-S7 + S4.5 收敛闸门流程。' +
      '流水线通过后签发一次性写入令牌，Hook 检测到令牌后放行文件修改。',
    inputSchema: {
      flow: z.string().describe('YAML 配置文件名，如 wenstaros_core_repair_flow.yaml'),
      files: z.array(z.string()).describe('待修改的文件路径列表'),
      message: z.string().optional().describe('原始修改意图描述'),
    },
  },
  async ({ flow, files, message }) => {
    if (!files || files.length === 0) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: '未指定修改文件' }) }] };
    }

    const flowName = flow || 'wenstaros_core_repair_flow.yaml';
    const msg = message || '';

    // 动态加载 Harness 引擎（ESM）
    const { FlowEngine } = await import('../src/FlowEngine.js');
    const { classifyFiles, isTrivialChange } = await import('../src/RiskClassifier.js');
    const { review } = await import('../src/DelegateReviewer.js');
    const { evaluate: convergenceEvaluate } = await import('../src/ConvergenceGate.js');

    const risk = classifyFiles(files);
    const trivial = isTrivialChange(msg, files);

    // 自由裸奔
    if (risk === 'low' && trivial) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true, mode: 'free', risk, files,
            message: '🆓 低风险微小修改，跳过流水线。可直接修改，但请注意遵守系统不变量。',
          }, null, 2),
        }],
      };
    }

    // 按阶段分派评审函数
    const delegateFnMap = new Map();
    delegateFnMap.set('S4_Arch_Review', async (stage: any, state: any) => review(stage, state));
    delegateFnMap.set('S4.5_Convergence_Gate', async (stage: any, state: any) => convergenceEvaluate(stage, state));

    const engine = new FlowEngine({
      delegateReviewFn: async (stage: any, state: any) => review(stage, state),
      delegateReviewFnMap: delegateFnMap,
      projectRoot: PROJECT_ROOT,
      autoApproveHumanGate: true,  // 🔴 MCP 无头模式 — S2 自动批准
    });

    const result = await engine.start(flowName, {
      message: msg,
      modifiedFiles: files,
      riskLevel: risk,
      isTrivial: trivial,
      projectRoot: PROJECT_ROOT,
    });

    // 写入通行令牌
    if (result.success) {
      try {
        const tokenDir = resolve(import.meta.dirname!, '..', 'data', 'tokens');
        if (!existsSync(tokenDir)) mkdirSync(tokenDir, { recursive: true });

        const EXPIRY_MS = 2 * 60 * 60 * 1000;
        const now = Date.now();

        for (const f of files) {
          const hash = hashCode(f);
          const tokenPath = resolve(tokenDir, hash + '.json');
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

        console.error(`[harness-mcp] 令牌已签发: ${files.length} 个文件, 有效期 2h`);
      } catch (err) {
        console.error('[harness-mcp] 令牌写入失败:', (err as Error).message);
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
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
            : 'Pipeline FAILED. Human approval is REQUIRED for S1/S2 stages. No token issued.',
        }, null, 2),
      }],
    };
  },
);

// ── 工具 3: harness_list_flows ──
mcpServer.registerTool(
  'harness_list_flows',
  {
    description: '列出 data/flows/ 下所有可用的 YAML 流水线配置。',
    inputSchema: {},
  },
  async () => {
    const flowsDir = resolve(import.meta.dirname!, '..', 'data', 'flows');
    try {
      const files = readdirSync(flowsDir).filter(f => f.endsWith('.yaml'));
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ flows: files, count: files.length }, null, 2),
        }],
      };
    } catch {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ flows: [], count: 0, error: 'flows 目录不可读' }, null, 2),
        }],
      };
    }
  },
);

// ── 工具 4: harness_evolution_status ──
mcpServer.registerTool(
  'harness_evolution_status',
  {
    description:
      '🧬 获取 Harness 自进化引擎状态。返回当前硬度等级(L1-L4)、统计数据、升级进度、' +
      '最近发现的违规模式、待确认的规则升级建议。',
    inputSchema: {},
  },
  async () => {
    const status = evolutionEngine.getStatus();
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          currentLevel: status.currentLevel,
          levelName: status.levelDef.name,
          stats: status.stats,
          upgradeProgress: status.upgradePath ? {
            from: status.upgradePath.from,
            to: status.upgradePath.to,
            progress: getUpgradeProgress(status.upgradePath),
            allMet: status.upgradePath.allMet,
            estimatedDays: status.upgradePath.estimatedDaysRemaining,
          } : null,
          pendingUpgrades: status.pendingUpgrades.length,
          appliedUpgrades: status.appliedUpgrades.length,
          recentPatterns: status.recentPatterns.map(p => ({
            type: p.type,
            title: p.title,
            severity: p.severity,
            eventCount: p.eventCount,
            description: p.description.slice(0, 150),
          })),
        }, null, 2),
      }],
    };
  },
);

// ── 工具 5: harness_evolution_analyze ──
mcpServer.registerTool(
  'harness_evolution_analyze',
  {
    description:
      '🔍 触发 EvolutionEngine 全量分析——扫描 Sentinel/Audit 日志，发现违规模式，' +
      '提炼规则升级建议。分析结果可通过 harness_evolution_status 查看。',
    inputSchema: {},
  },
  async () => {
    evolutionEngine.runFullAnalysis();
    const status = evolutionEngine.getStatus();
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          message: '全量分析完成',
          newPatterns: status.recentPatterns.length,
          pendingUpgrades: status.pendingUpgrades.length,
          patterns: status.recentPatterns.map(p => ({
            title: p.title,
            severity: p.severity,
            type: p.type,
          })),
          upgrades: status.pendingUpgrades.map(u => ({
            target: u.target,
            type: u.type,
            priority: u.priority,
            proposed: u.proposed.slice(0, 200),
          })),
        }, null, 2),
      }],
    };
  },
);

// ── 工具 6: harness_evolution_report ──
mcpServer.registerTool(
  'harness_evolution_report',
  {
    description:
      '📊 导出 Harness 自进化引擎完整报告（Markdown 格式）。包含硬度阶梯进度、违规模式清单、' +
      '待确认升级建议、已应用历史升级。',
    inputSchema: {},
  },
  async () => {
    const report = evolutionEngine.exportReport();
    return {
      content: [{
        type: 'text' as const,
        text: report,
      }],
    };
  },
);

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // ── 哨兵专用端点：/sentinel/check (REST, 非 MCP) ──
  if (req.url === '/sentinel/check' && req.method === 'POST') {
    await handleSentinelCheck(req, res);
    return;
  }

  // ── 哨兵健康检查 ──
  if (req.url === '/sentinel/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'harness-mcp', version: '2.1.0' }));
    return;
  }

  // ── MCP Streamable HTTP ──
  // 读取请求体
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString('utf-8');

  let parsedBody: unknown = undefined;
  if (rawBody && req.headers['content-type']?.includes('application/json')) {
    try { parsedBody = JSON.parse(rawBody); } catch (_) { /* ignore parse errors */ }
  }

  // 🔴 每个请求创建独立的 transport（无状态 MCP，按请求隔离）
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
  transport.close?.().catch(() => {});
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.error(`[harness-mcp] 🚀 Streamable HTTP MCP Server v2.1`);
  console.error(`[harness-mcp]    地址: http://127.0.0.1:${PORT}`);
  console.error(`[harness-mcp]    模式: 无状态 (stateless)`);
  console.error(`[harness-mcp]    项目根目录: ${PROJECT_ROOT}`);
});
// 心跳文件——供 Hook 检测服务存活（免网络调用）
const HEARTBEAT_FILE = resolve(import.meta.dirname!, '..', 'data', 'heartbeat.json');
setInterval(() => {
  try { writeFileSync(HEARTBEAT_FILE, JSON.stringify({ ts: Date.now(), port: PORT, pid: process.pid })); } catch (_) {}
}, 5000);

// 优雅退出
process.on('SIGINT', () => { console.error('[harness-mcp] 收到 SIGINT，退出'); mcpServer.close().catch(() => {}); httpServer.close(); process.exit(0); });
process.on('SIGTERM', () => { console.error('[harness-mcp] 收到 SIGTERM，退出'); mcpServer.close().catch(() => {}); httpServer.close(); process.exit(0); });

// ════════════════════════════════════════════════════════════════════
// 哨兵 REST 端点: /sentinel/check
// ════════════════════════════════════════════════════════════════════

/** 高风险文件列表（与 harness-pre-check.cjs + sentinel-mcp-client.js 同步） */
const SENTINEL_HIGH_RISK = [
  'src/webui/chat.ts', 'src/m4/household/FamilyGraph.ts', 'src/m2/SQLiteAdapter.ts',
  'src/webui/server.ts', 'src/m4/household/UUIDGatekeeper.ts',
  'src/m4/M4Orchestrator.ts', 'src/m4/MemoryInjector.ts', 'src/m4/MemoryRetriever.ts',
  'src/m4/EntityTopologyManager.ts', 'src/m4/EntityValidator.ts',
  'src/m4/QueryDecomposer.ts', 'src/m4/Reranker.ts',
  'src/m4/household/EntityMeeting.ts', 'src/m4/household/EntityContextBuilder.ts',
  'src/m4/household/ProfileAcquisitionEngine.ts',
  'src/m5/M5Orchestrator.ts', 'src/m5/CandidateSelector.ts', 'src/m5/StrategySelector.ts',
  'src/m5/CognitionAssembler.ts', 'src/m5/HumanisticCalibrator.ts', 'src/m5/SceneAnchor.ts',
  'src/m5/ContextMemory.ts', 'src/m5/DeepSeekLLMProvider.ts', 'src/m5/MockLLMProvider.ts',
  'src/engine/orchestrator.ts', 'src/engine/EngineContext.ts',
  'src/engine/legacy-adapter.ts', 'src/engine/types.ts',
  'src/engine/tianquan/prefrontal/',
  'src/m2/FusionStorageAdapter.ts', 'src/m2/ConversationDB.ts',
  'src/webui/chat/ChatEntry.ts', 'src/webui/chat/MeetingContextPipeline.ts',
  'src/webui/chat/retrieval.ts',
  'src/hooks/',
  'src/app/knowledge/KnowledgeEngine.ts', 'src/app/knowledge/KnowledgeContextBuilder.ts',
  'src/app/vault/VaultManager.ts',
  'src/app/ingestion/ConversationIngestionService.ts',
  'src/app/fusion/FusionEngine.ts',
  'src/app/fg/', 'src/app/role/',
];

function sentinelClassifyRisk(fp: string): 'protected' | 'high' | 'mid' | 'low' {
  const n = fp.replace(/\\/g, '/');
  for (const p of HARNESS_PROTECTED) {
    if (n.startsWith(p) || n.includes('/' + p)) return 'protected';
  }
  for (const f of SENTINEL_HIGH_RISK) {
    if (n.includes(f)) return 'high';
  }
  if (n.startsWith('src/config/') || n.startsWith('src/types/') || n.startsWith('src/cli/') ||
      n.startsWith('src/common/') || n.startsWith('src/adapter/') || n.startsWith('src/modules/')) return 'low';
  if (n.includes('.test.ts') || n.includes('.spec.ts') || n.includes('.d.ts')) return 'low';
  if (n.endsWith('.md') || n.endsWith('.sql') || n.endsWith('.cjs') || n.endsWith('.json')) return 'low';
  return 'mid';
}

async function handleSentinelCheck(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 读取请求体
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString('utf-8');

  let filePath = '';
  try {
    const body = JSON.parse(rawBody);
    filePath = (body.file || '').replace(/\\/g, '/');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ allowed: false, error: 'invalid JSON' }));
    return;
  }

  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ allowed: false, error: 'missing file parameter' }));
    return;
  }

  const risk = sentinelClassifyRisk(filePath);

  // 保护区 → 永远拒绝
  if (risk === 'protected') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ allowed: false, risk, reason: 'Harness 保护区文件禁止外部修改', tokenFound: false }));
    return;
  }

  // 低风险 → 永远放行
  if (risk === 'low') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ allowed: true, risk, reason: '低风险文件', tokenFound: false }));
    return;
  }

  // 中/高风险 → 查令牌
  const hash = hashCode(filePath);
  const tokenPath = resolve(import.meta.dirname!, '..', 'data', 'tokens', hash + '.json');

  try {
    if (!existsSync(tokenPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        allowed: false, risk,
        reason: `中高风险文件 "${filePath}" 无有效令牌`,
        tokenFound: false,
      }));
      return;
    }

    const raw = readFileSync(tokenPath, 'utf-8');
    const token = JSON.parse(raw);
    const now = Date.now();

    // 过期检查
    if (now > (token.expires_at || 0)) {
      try { unlinkSync(tokenPath); } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: false, risk, reason: '令牌已过期', tokenFound: false }));
      return;
    }

    // 已消费检查
    if (token.consumed) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: false, risk, reason: '令牌已被消费', tokenFound: false }));
      return;
    }

    // UUID 校验
    if (token.caller_uuid && token.caller_uuid !== 'sg-mcp-v3-00000000-0000-0000-0000-000000000001') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allowed: false, risk, reason: '令牌 UUID 不匹配', tokenFound: false }));
      return;
    }

    // 令牌有效 → 返回放行（不在此处消费，由 git pre-commit hook 负责消费）
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      allowed: true, risk,
      reason: `令牌有效 (run_id: ${token.run_id})`,
      tokenFound: true,
      runId: token.run_id,
    }));

  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ allowed: false, risk, reason: '令牌检查异常', tokenFound: false }));
  }
}

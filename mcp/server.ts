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
import { createHash, createHmac } from 'node:crypto';
import { execSync, fork, exec } from 'node:child_process';
import { createRequire } from 'node:module';

// @modelcontextprotocol/sdk 1.30+
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

// Harness 自进化引擎
import { EvolutionEngine } from '../src/EvolutionEngine.js';
import { getUpgradeProgress } from '../src/HardnessLadder.js';

// P5: ProjectBrain 感知层 — IntentSpec 构建 + DiffScopeGuard
import { buildIntentSpec } from '../src/project-brain/intent-builder.js';

// 🔴 S2-安全收紧: 统一密码校验 + 解锁令牌签名（复用 scripts/pass-core.cjs）
const _require = createRequire(import.meta.url);
const passCore = _require('../scripts/pass-core.cjs');

/**
 * 🔴 S2-安全收紧 ②: 解锁令牌 HMAC 签名。
 * C3-fix: 只签不可变字段（unlock_id/created_at/source），与 harness-unlock.cjs 的 signToken 完全一致，
 * 确保三处（签发 + 验签）互验通过。M3-fix: 用 passCore.stableStringify（排序键）。
 */
function signUnlockToken(token: Record<string, unknown>): string {
  const key = passCore.getSignKey();
  if (!key) {
    // C4-fix: 无 secret → 拒绝签发（fail-closed）
    throw new Error('HARNESS_SECRET 未配置，无法签发解锁令牌');
  }
  // HIGH-1-fix: expires_at 参与签名防重放；LOW-2-fix: 全字段 String 强转与 pre-check 一致
  const body = {
    unlock_id: String(token.unlock_id),
    created_at: String(token.created_at),
    source: String(token.source),
    expires_at: token.expires_at,
  };
  return createHmac('sha256', key).update(passCore.stableStringify(body)).digest('hex');
}

// ════════════════════════════════════════════════════════════════════
// Harness 基础设施保护区（与 harness-pre-check.cjs 保持同步）
// ════════════════════════════════════════════════════════════════════

const HARNESS_PROTECTED = [
  'src/harness/', 'data/harness/', '.claude/settings.json',
  '.claude/harness/', '.claude/workflows',
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
  pollIntervalMs: 30_000,       // P5: 每 30 秒增量扫描（原 60s）
  analysisIntervalMs: 600_000,  // P5: 每 10 分钟全量分析（原 1h）
});
evolutionEngine.start();

// P5: S3 编译自检 — condition gate 前置检查
// 🔴 P9-fix: 只检查本次 flow 涉及的 modified_files，不扫描全仓库。
// 历史遗留的编译错误（来自 hook bug 期间的绕过提交）不应阻塞新 flow 签发 token；
// 新修改的文件若有类型错误则 reject，保证本次改动本身编译干净。
async function s3CompileCheck(_stageId: string, projectRoot: string, modifiedFiles?: string[]): Promise<{ passed: boolean; reason?: string }> {
  // 无文件 → 视为通过（无改动可查）
  if (!modifiedFiles || modifiedFiles.length === 0) {
    return { passed: true, reason: '本次 flow 无修改文件，跳过编译检查' };
  }

  // 只检查本次涉及的文件（用 --noEmit + 文件级过滤）
  const fileList = modifiedFiles
    .map(f => f.replace(/\\/g, '/'))
    .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .slice(0, 20); // 上限 20 个，防超长命令

  if (fileList.length === 0) {
    return { passed: true, reason: '本次涉及文件非 .ts 源文件，跳过编译检查' };
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ passed: false, reason: 'S3 tsc 编译检查超时（30s），跳过' });
    }, 30_000);

    // tsc 全量编译，但结果只按「本次文件」过滤 — 历史文件的错误不阻塞本次 flow
    exec('npx tsc --noEmit', {
      cwd: projectRoot,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      clearTimeout(timer);
      const allErrors = (stderr || '') + (stdout || '');
      // 过滤：只保留涉及本次文件的错误行
      const relevant = allErrors
        .split('\n')
        .filter(line => fileList.some(f => line.includes(f)))
        .join('\n')
        .trim();

      if (!relevant) {
        resolve({ passed: true, reason: `本次涉及 ${fileList.length} 个文件，无类型错误（历史错误已豁免）` });
      } else {
        resolve({ passed: false, reason: `S3 tsc 检查到本次文件错误:\n${relevant.slice(0, 400)}` });
      }
    });
  });
}

// P5: DelegateReviewer CJS 入口 — fork 独立子进程执行 S4 评审
async function forkedReview(stage: any, state: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const runnerPath = resolve(import.meta.dirname!, '..', 'scripts', 'review-runner.cjs');
    const child = fork(runnerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], timeout: 120_000 });

    const payload = JSON.stringify({ stage, state });
    child.stdin?.write(payload);
    child.stdin?.end();

    let result: any = null;
    child.on('message', (msg: any) => { result = msg; });
    child.on('close', (code) => {
      if (result) {
        resolve(result);
      } else {
        reject(new Error(`review-runner exited code ${code} with no result`));
      }
    });
    child.on('error', (err) => reject(err));
  });
}

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
      skip_s3_compile: z.boolean().optional().describe('🔴 修复编译错误专用：为 true 时 S3 跳过 tsc 编译检查，直接签发 token（仅限修复历史编译错误任务，改完后 S5 仍会完整验证）'),
      exempt_files: z.array(z.string()).optional().describe('v2.9: 豁免文件列表（限定范围内仍走 S1-S7——只放宽 S4.5 复杂度收敛，token 照常签发）'),
    },
  },
  async ({ flow, files, message, skip_s3_compile, exempt_files }) => {
    if (!files || files.length === 0) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: '未指定修改文件' }) }] };
    }

    // P7-C6: 文件数量限制 + 路径遍历检测
    const MAX_FILES = 200;
    if (files.length > MAX_FILES) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `文件数 ${files.length} 超过上限 ${MAX_FILES}` }) }] };
    }
    const PATH_TRAVERSAL_RE = /\.\.\/|\.\.\\|^\/|^[A-Z]:\\|^[a-z]:\\/i;
    for (const f of files) {
      if (PATH_TRAVERSAL_RE.test(f)) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `禁止路径遍历: ${f}` }) }] };
      }
    }

    const flowName = flow || 'wenstaros_core_repair_flow.yaml';
    const msg = message || '';

    // 动态加载 Harness 引擎（ESM）
    const { FlowEngine } = await import('../src/FlowEngine.js');
    const { classifyFiles, isTrivialChange } = await import('../src/RiskClassifier.js');
    const { review } = await import('../src/DelegateReviewer.js');
    const { evaluate: convergenceEvaluate } = await import('../src/ConvergenceGate.js');

    const risk = classifyFiles(files);
    const trivial = isTrivialChange(msg, files, PROJECT_ROOT);

    // P5: ProjectBrain — 构建 IntentSpec 用于 DiffScopeGuard
    const intentSpec = buildIntentSpec({
      title: msg?.slice(0, 80) || 'Unnamed intent',
      description: msg || '',
      files,
      projectRoot: PROJECT_ROOT,
    });
    console.error(`[harness-mcp] IntentSpec: ${intentSpec.id} | risk: ${risk} | scope: ${intentSpec.scope.allowed_paths.length} allowed, ${intentSpec.scope.forbidden_paths.length} forbidden`);

    // 自由裸奔
    if (risk === 'low' && trivial) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true, mode: 'free', risk, files,
            intent_id: intentSpec.id,
            message: '🆓 低风险微小修改，跳过流水线。可直接修改，但请注意遵守系统不变量。',
          }, null, 2),
        }],
      };
    }

    // 按阶段分派评审函数 — P5: S4 用 fork 独立子进程（真正 delegate）
    const delegateFnMap = new Map();
    delegateFnMap.set('S4_Arch_Review', async (stage: any, state: any) => {
      try {
        return await forkedReview(stage, state);
      } catch (err) {
        console.error('[harness-mcp] S4 fork 评审失败，降级为 in-process review:', (err as Error).message);
        return review(stage, state);
      }
    });
    // v2.9: 传 exempt_files 给 S4.5 — 豁免文件只放宽复杂度收敛，S1/S2/S5/S6/S7 全量保留
    // MID-2-fix: 原地挂载（不浅拷贝）——ConvergenceGate 内 state.convergence_round 原地自增，
    // 浅拷贝会让收敛轮次停滞在 round=1（人工转交/HARD_LOCKOUT 失效）。
    if (Array.isArray(exempt_files) && exempt_files.length > 0) {
      state.s4_exempt_files = exempt_files;
    }
    delegateFnMap.set('S4.5_Convergence_Gate', async (stage: any, st: any) => convergenceEvaluate(stage, st));

    const engine = new FlowEngine({
      delegateReviewFn: async (stage: any, state: any) => review(stage, state),
      delegateReviewFnMap: delegateFnMap,
      projectRoot: PROJECT_ROOT,
      autoApproveHumanGate: true,  // 🔴 MCP 无头模式 — S2 自动批准
      // 🔴 P9-fix: skip_s3_compile 为 true 时跳过 S3 编译自检（仅限修复历史编译错误任务）
      // 原因：修复编译错误需要先改文件，改文件需要 token，token 需要 flow 通过——
      // 若 S3 强制检查「本次文件」现有错误，修复任务永远拿不到 token（死锁）。
      conditionGateCheck: skip_s3_compile ? async () => ({ passed: true, reason: 'skip_s3_compile=true — 修复编译错误豁免，改完后 S5 仍会完整验证' }) : s3CompileCheck,
    });

    const result = await engine.start(flowName, {
      message: msg,
      modifiedFiles: files,
      riskLevel: risk,
      isTrivial: trivial,
      projectRoot: PROJECT_ROOT,
      skip_s3_compile: skip_s3_compile === true,
    });

    // P5: 签发 Token v2（HMAC 签名）
    if (result.success) {
      try {
        const { TokenStore } = await import('../src/security/token-store.js');
        const tokenDir = resolve(import.meta.dirname!, '..', 'data', 'tokens');
        const store = new TokenStore({ tokenDir });

        for (const f of files) {
          store.issueToken({
            token_strength: 'strong',
            run_id: result.run_id,
            intent_id: intentSpec.id,
            files: [f],
            allowed_paths: [f],
            forbidden_paths: intentSpec.scope.forbidden_paths,
          });

          // 🔴 P9-fix: 补绝对路径 hash 别名（治本）
          // 原因: token-store 只写相对路径别名（如 src/m2/SQLiteAdapter.ts → mrwnex），
          // 但 hook/Sentinel 收到绝对路径时用绝对路径 hash（jvkcn6）查找 → 找不到 token。
          // 这里用 PROJECT_ROOT 拼绝对路径，额外写一份绝对路径 hash 别名，无论哪种路径都能命中。
          try {
            const absPath = (PROJECT_ROOT.replace(/\\/g, '/') + '/' + String(f).replace(/\\/g, '/')).replace(/\/+/g, '/');
            const absHash = hashCode(absPath);
            const tokenDirPath = resolve(import.meta.dirname!, '..', 'data', 'tokens');
            const aliasFile = resolve(tokenDirPath, absHash + '.json');
            if (!existsSync(aliasFile)) {
              // 读回刚签发的 token 内容写入别名（确保签名一致）
              const relHash = hashCode(String(f).replace(/\\/g, '/'));
              const relFile = resolve(tokenDirPath, relHash + '.json');
              if (existsSync(relFile)) {
                writeFileSync(aliasFile, readFileSync(relFile, 'utf-8'));
                console.error(`[harness-mcp] ✅ 绝对路径别名: ${absPath} → ${absHash}.json`);
              }
            }
          } catch (_absErr) { /* 别名失败不影响主 token */ }
        }

        console.error(`[harness-mcp] Token v2 已签发: ${files.length} 个文件, intent: ${intentSpec.id}`);
      } catch (err) {
        console.error('[harness-mcp] Token v2 签发失败:', (err as Error).message);
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
          token_expires_in: result.success ? '15 minutes' : 'N/A',
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

// ── 工具 7: harness_learn (RuleLearner) ──
mcpServer.registerTool(
  'harness_learn',
  {
    description:
      '📚 查询 RuleLearner 规则建议——从最近审计数据学到的确定性规则（零 LLM）。' +
      '返回: 文件风险等级建议（被拒次数多）、Agent 行为提示（跨 run 反复被拒）、' +
      '标准权重建议（S4.5 收敛驳回占比过高）。规则为「建议」，需人工确认后生效，不自动应用。',
    inputSchema: {},
  },
  async () => {
    const rulesPath = resolve(import.meta.dirname!, '..', 'data', 'learn', 'rules.json');
    let rules = null;
    try {
      if (existsSync(rulesPath)) {
        rules = JSON.parse(readFileSync(rulesPath, 'utf-8'));
      }
    } catch (err) {
      console.error('[harness-mcp] RuleLearner 读取失败:', (err as Error).message);
    }
    if (!rules) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, message: '暂无规则建议。请先运行: node scripts/rule-learner.cjs（纯本地零LLM）生成建议' }, null, 2),
        }],
      };
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          generated_at: rules.generated_at,
          run_count: rules.run_count,
          risk_reviews: (rules.risk_reviews || []).map(r => ({
            file: r.file, rejectCount: r.rejectCount, mainCause: r.mainCause, suggestion: r.suggestion,
          })),
          behavior_hints: (rules.behavior_hints || []).map(h => ({
            file: h.file, rejectCount: h.rejectCount, runCount: h.runCount, suggestion: h.suggestion,
          })),
          standard_suggestions: rules.standard_suggestions || [],
        }, null, 2),
      }],
    };
  },
);

	// ── 工具 8: harness_admin_unlock 🔴 Harness 自保护 ──
	mcpServer.registerTool(
	  'harness_admin_unlock',
	  {
	    description:
	      '🔴 解锁 Harness 自身代码修改权限。需要输入管理员密码（用户需在终端运行 node scripts/harness-unlock.cjs 或提供密码）。' +
	      '解锁后 30 分钟内可修改 Harness 监管系统自身代码。密码由用户设定，Agent 无法获知。',
	    inputSchema: {
	      password: z.string().describe('Harness 管理员密码（由用户提供，Agent 不得保存）'),
	    },
	  },
	  async ({ password }: { password: string }) => {
	    const UNLOCK_FILE = resolve(import.meta.dirname!, '..', 'data', 'sessions', 'harness-admin-unlock.json');

	    // 🔴 S2-安全收紧 ④: 统一走 pass-core 校验（PBKDF2 加盐，v1 向后兼容）
	    if (!passCore.verifyPassword(password)) {
	      return { content: [{ type: 'text' as const, text: '❌ 密码错误。Harness 自身修改权限拒绝。' }] };
	    }

	    // 签发解锁令牌
	    if (!existsSync(resolve(import.meta.dirname!, '..', 'data', 'sessions'))) {
	      mkdirSync(resolve(import.meta.dirname!, '..', 'data', 'sessions'), { recursive: true });
	    }
	    const token = {
	      unlock_id: 'hs-unlock-' + Date.now().toString(36),
	      created_at: new Date().toISOString(),
	      expires_at: Date.now() + 30 * 60 * 1000,
	      consumed: false,
	      source: 'mcp-api',
	    };
	    // 🔴 S2-安全收紧 ②: 解锁令牌 HMAC 签名（与 harness-unlock.cjs 一致），防 Agent 伪造解锁文件
	    token.sig = signUnlockToken(token);
	    writeFileSync(UNLOCK_FILE, JSON.stringify(token, null, 2), 'utf-8');

	    return {
	      content: [{
	        type: 'text' as const,
	        text: `✅ Harness 管理员已解锁！\n\n解锁ID: ${token.unlock_id}\n有效期: 30 分钟 (至 ${new Date(token.expires_at).toLocaleTimeString('zh-CN')})\n\n现在可通过 harness_run_flow 获取流水线令牌后修改 Harness 自身代码。`,
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

  // 🔴 FIX(root cause): GET(SSE) 是长连接，handleRequest 会阻塞到客户端断连。
  //    若在此 connect(mcpServer)，Protocol 的单一 transport 槽位会被永久占用
  //    (protocol.js "Already connected to a transport")，之后所有并发 POST 都会
  //    throw → Claude Code tools fetch failed。无状态模式下 GET 仅是空闲 keep-alive
  //    流，无需接入 mcpServer（harness 从不推送 server-initiated 消息）。
  try {
    if (req.method !== 'GET') await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    // 并发 POST 重叠/槽位被占时，返回 503 让客户端可重试，而非挂起
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'MCP busy: ' + String((err as Error)?.message || err) },
        id: null,
      }));
    }
  } finally {
    transport.close?.().catch(() => {});
  }
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
  // 🔴 .cjs 文件在 scripts/hooks/mcp/sentinel 目录下是可执行脚本，不得归类为低风险
  if (n.endsWith('.md') || n.endsWith('.sql') || n.endsWith('.json')) return 'low';
  if (n.endsWith('.cjs')) {
    const isExecDir = n.startsWith('scripts/') || n.startsWith('hooks/') || n.startsWith('mcp/') || n.startsWith('sentinel/');
    return isExecDir ? 'mid' : 'low';
  }
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

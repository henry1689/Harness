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
import { execSync, fork, exec, spawn } from 'node:child_process';
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
const ownerClosureCore = _require('../scripts/owner-closure-core.cjs');

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
// H1: S2 审批证据校验与规范化
// ════════════════════════════════════════════════════════════════════

/**
 * H1: 规范化 S2 审批证据——所有字符串字段 trim 去除首尾空白。
 * 返回规范化后的副本；未通过校验时返回 { ok:false, diagnostic }（不泄露原文）。
 */
function normalizeS2Evidence(raw: unknown): {
  ok: boolean;
  evidence?: { approval_ref: string; approved_plan: string; change_classification: string; global_architecture_decision: string; confirmations: string[] };
  /** H-03/P1-1: s2-evidence-v2 可选字段透传——原实现把它们整个丢弃，导致 S2 补丁方案无从登记债务 */
  v2?: {
    problem_nature?: string;
    final_approved_plan?: string;
    patch_plan?: Record<string, unknown> | null;
    /** H-02：纯自动化任务跳过 S6-B 人工环节（2026-09-11 补——此前未透传，该开关从未生效） */
    skip_manual_verification?: boolean;
    /** H-05：S2 授权的整文件覆写白名单（2026-09-11 补——此前未透传，白名单恒为空） */
    allow_full_rewrite?: string[];
  };
  diagnostic?: string;
} {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, diagnostic: 'S2_APPROVAL_EVIDENCE_MISSING: 未提供审批证据' };
  }
  const obj = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const approval_ref = str(obj.approval_ref);
  const approved_plan = str(obj.approved_plan);
  const change_classification = str(obj.change_classification);
  const global_architecture_decision = str(obj.global_architecture_decision);

  // H1: trim 后必填字段非空——z.string().min(1) 只挡未传，挡不住纯空白
  if (!approval_ref) return { ok: false, diagnostic: 'S2_APPROVAL_EVIDENCE_INVALID: approval_ref 为空（含纯空白）' };
  if (!approved_plan) return { ok: false, diagnostic: 'S2_APPROVAL_EVIDENCE_INVALID: approved_plan 为空（含纯空白）' };
  if (!change_classification) return { ok: false, diagnostic: 'S2_APPROVAL_EVIDENCE_INVALID: change_classification 为空（含纯空白）' };
  if (!global_architecture_decision) return { ok: false, diagnostic: 'S2_APPROVAL_EVIDENCE_INVALID: global_architecture_decision 为空（含纯空白）' };

  // H1: confirmations keys——trim 后过滤空项与重复，仅保留非空唯一 key
  const confirmations: string[] = [];
  const seen = new Set<string>();
  const rawConfs = Array.isArray(obj.confirmations) ? obj.confirmations : [];
  for (const c of rawConfs) {
    const k = str(c);
    if (k && !seen.has(k)) { seen.add(k); confirmations.push(k); }
  }

  // H-03/P1-1: 透传 s2-evidence-v2 的可选字段（不参与必填校验，仅供应急/建账使用）
  const v2: {
    problem_nature?: string;
    final_approved_plan?: string;
    patch_plan?: Record<string, unknown> | null;
    skip_manual_verification?: boolean;
    allow_full_rewrite?: string[];
  } = {};
  if (typeof obj.problem_nature === 'string') v2.problem_nature = obj.problem_nature;
  if (typeof obj.final_approved_plan === 'string') v2.final_approved_plan = obj.final_approved_plan;
  if (obj.patch_plan && typeof obj.patch_plan === 'object') v2.patch_plan = obj.patch_plan as Record<string, unknown>;
  // 🔴 2026-09-11: H-02 / H-05 开关此前未列入白名单 → 被静默丢弃 → 两个功能从未生效
  if (typeof obj.skip_manual_verification === 'boolean') v2.skip_manual_verification = obj.skip_manual_verification;
  if (Array.isArray(obj.allow_full_rewrite)) {
    v2.allow_full_rewrite = obj.allow_full_rewrite.filter((s): s is string => typeof s === 'string');
  }

  return {
    ok: true,
    evidence: { approval_ref, approved_plan, change_classification, global_architecture_decision, confirmations },
    v2,
  };
}

/**
 * F6(2026-09-11): 提取 S7-B 的真实归档校验失败原因。
 * 背景：run_status=archive_invalid 的旧文案写死「S7-A 为本地空跑 stage，无法自动产出归档，
 * 请人工产出归档」——该前提在 S7-A 进程内自动归档（src/s7/s7AutoArchive.ts）落地后已失效。
 * 真实原因常为 R4（S4.5<98 缺 exemption_id）或 R1/R2/R3/R5，写死原因会把排查引向错误方向
 * （实测：R4 被误读成「归档没生成」，白耗一轮定位）。S7-B 的 machine_signal.reject_reason
 * 已携带真实规则编号，此处直接透传，不做任何猜测。
 */
function archiveFailureReasons(
  stageResults: Array<{ stage_id?: string; machine_signal?: { reject_reason?: unknown } }> | undefined,
): string[] {
  const all = stageResults ?? [];
  const s7 = all.find(r => /^S7-B/.test(String(r?.stage_id ?? '')))
    ?? all.find(r => /^S7/.test(String(r?.stage_id ?? '')));
  const raw = s7?.machine_signal?.reject_reason;
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map(r => String(r).replace(/^S7-B\s*归档校验失败\s*\d*\s*项[:：]\s*/, '').trim())
    .filter(r => r && r !== '详见 human_report');
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

// P5: DelegateReviewer CJS 入口 — spawn 独立子进程执行 S4 评审
// 🔴 改用 spawn + stdout 传结果：fork 的 IPC 通道会被 tsx loader 劫持（close 不触发、message 收不到）。
// review-runner 统一用 stdout 输出 JSON 结果，这里读 stdout 解析。
async function forkedReview(stage: any, state: any): Promise<any> {
  return new Promise((resolve, reject) => {
    // 🔴 import.meta.dirname 在 tsx 编译产物里可能为 undefined（诊断日志证实 runnerPath 变成 mcp\undefined）。
    // 改用绝对路径硬编码，绕开运行时元数据的不确定性。
    const runnerPath = 'D:/AI文件/harness/scripts/review-runner.cjs';
    const child = spawn(process.execPath, [
      '--import', 'file:///D:/tools/wenstar-cc/node_modules/tsx/dist/loader.mjs',
      runnerPath,
    ], {
      cwd: 'D:/AI文件/harness/scripts',
      stdio: ['pipe', 'pipe', 'pipe'],
      // 防控制台闪窗：MCP 由 pm2 fork 拉起时无控制台，spawn node 会新建窗口
      windowsHide: true,
    });

    const payload = JSON.stringify({ stage, state });
    child.stdin?.write(payload);
    child.stdin?.end();

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code) => {
      // review-runner 的 console.log 会混入 stdout，这里提取最后一个完整 JSON 对象（结果 JSON 是最后 write 的）
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          resolve(parsed);
        } catch (e) {
          reject(new Error(`review-runner JSON 解析失败 (code ${code}): ${jsonMatch[0].slice(0, 200)}`));
        }
      } else {
        reject(new Error(`review-runner 无 JSON 输出 (code ${code})${stderr ? ' stderr: ' + stderr.slice(0, 300) : ''}`));
      }
    });
    child.on('error', (err) => reject(err));
  });
}

/**
 * H0: Token v2 签发——复用已验收的 flow-terminal-policy（独立模块），不做本地重实现。
 * policy 校验 flow_status/end_reason/mode=pipeline/字段矛盾 invariant，
 * 拒绝态绝不调用签发回调（issueCallback 只在 eligible 时执行）。
 * 返回真实签发结果 + policy verdict 机器码，供调用方如实上报。
 */
async function attemptTokenIssue(
  result: { success: boolean; run_id: string; end_reason?: string; flow_status?: string; mode?: string },
  files: string[],
  intentSpec: { id: string; scope?: { allowed_paths?: string[]; forbidden_paths?: string[] } },
): Promise<{ issued: boolean; issuedCount: number; detail: string; expiresIn?: string; verdictCode?: string }> {
  // 动态加载独立 policy（避免 MCP 启动时 ESM 依赖解析失败）
  const { attemptTokenIssue: policyAttempt } = await import('../src/security/flow-terminal-policy.js');

  const policyResult = policyAttempt(
    { success: result.success, flow_status: result.flow_status, end_reason: result.end_reason, mode: result.mode },
    () => issueTokens(result, files, intentSpec),
  );

  if (!policyResult.issued) {
    // 拒绝态：绝不调用签发回调；verdict 的 code 仅在 eligible=false 时存在
    const verdict = policyResult.verdict as { eligible: false; code: string };
    return {
      issued: false,
      issuedCount: 0,
      detail: `token policy rejected: ${verdict.code}`,
      verdictCode: verdict.code,
    };
  }

  // eligible：回调被调用，value 为 issueTokens 返回的 Promise（async 函数）
  const value = await (policyResult.value as Promise<{ issued: boolean; issuedCount: number; detail: string; expiresIn?: string }>);
  return value;
}

/**
 * P2(2026-09-11): 把任意路径形态归一到「项目相对路径（正斜杠）」。
 * 令牌以 hashCode(路径字符串) 为文件名，相对/绝对会落到不同的哈希 → 两套文件互不命中。
 * 调用方传什么就存什么，是历史遗留；此处统一归一到相对形态，作为唯一真值。
 * - 已是相对路径 → 去 ./ 前缀后原样
 * - 绝对且位于 PROJECT_ROOT 内 → 剥掉根前缀
 * - 其他绝对路径（不在项目内）→ 原样保留，不猜测
 */
function toProjectRelative(p: string): string {
  const norm = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  const root = PROJECT_ROOT.replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm.toLowerCase().startsWith(root.toLowerCase() + '/')) return norm.slice(root.length + 1);
  return norm;
}

/** 实际签发回调——仅在 policy eligible 时被调用（拒绝态绝不进入） */
async function issueTokens(
  result: { run_id: string },
  files: string[],
  intentSpec: { id: string; scope?: { allowed_paths?: string[]; forbidden_paths?: string[] } },
): Promise<{ issued: boolean; issuedCount: number; detail: string; expiresIn?: string }> {
  try {
    const { TokenStore } = await import('../src/security/token-store.js');
    const tokenDir = resolve(import.meta.dirname!, '..', 'data', 'tokens');
    const store = new TokenStore({ tokenDir });

    let issuedCount = 0;
    let lastExpiresAt: string | undefined;
    for (const rawF of files) {
      // 🔴 P2: 先归一到项目相对路径——令牌文件名 = hashCode(路径)，相对/绝对落到不同哈希，
      // 混用会导致 hook 按相对路径查不到按绝对路径签发的令牌。
      const f = toProjectRelative(rawF);

      // v2.10: 签发时记录目标文件内容 hash——同文件内容变了则 token 失效（防「拿一次 token 反复改」）
      let contentHash: string | undefined;
      try {
        const absF = resolve(PROJECT_ROOT, f);
        if (existsSync(absF)) {
          const buf = readFileSync(absF);
          contentHash = createHash('sha256').update(buf).digest('hex');
        }
      } catch (_) { contentHash = undefined; }

      const t = store.issueToken({
        token_strength: 'strong',
        run_id: result.run_id,
        intent_id: intentSpec.id,
        files: [f],
        allowed_paths: [f],
        forbidden_paths: intentSpec.scope?.forbidden_paths ?? [],
        content_hash: contentHash,
      });
      issuedCount++;
      lastExpiresAt = t.expires_at;

      // 绝对路径 hash 别名：主令牌现已是相对路径，但 hook/Sentinel 仍可能按绝对路径查找，
      // 故额外写一份别名使两种查找都命中。
      // 🔴 P2 修复：原实现用 `PROJECT_ROOT + '/' + f` 拼绝对路径——当调用方传入的 f 本身
      // 已是绝对路径时，会拼出 `D:/AI文件/harness/D:/tools/wenstar-cc/src/x.ts` 这种幽灵
      // 双前缀（与 [[harness-sentinel-path-fix]] 同类），别名哈希无人查得到。现基于归一化
      // 后的 f 拼接，天然正确。
      try {
        const absPath = (PROJECT_ROOT.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + f).replace(/\/+/g, '/');
        const absHash = hashCode(absPath);
        const tokenDirPath = resolve(import.meta.dirname!, '..', 'data', 'tokens');
        const aliasFile = resolve(tokenDirPath, absHash + '.json');
        if (!existsSync(aliasFile)) {
          // 读回刚签发的 token 内容写入别名（确保签名一致）
          const relFile = resolve(tokenDirPath, hashCode(f) + '.json');
          if (existsSync(relFile)) {
            writeFileSync(aliasFile, readFileSync(relFile, 'utf-8'));
            console.error(`[harness-mcp] ✅ 绝对路径别名: ${absPath} → ${absHash}.json`);
          }
        }
      } catch (_absErr) { /* 别名失败不影响主 token */ }
    }

    const expiresIn = lastExpiresAt ? new Date(lastExpiresAt).toLocaleTimeString('zh-CN') : undefined;
    console.error(`[harness-mcp] Token v2 已签发: ${issuedCount} 个文件, intent: ${intentSpec.id}`);
    return { issued: issuedCount > 0, issuedCount, detail: `issued ${issuedCount} token(s)`, expiresIn };
  } catch (err) {
    console.error('[harness-mcp] Token v2 签发失败:', (err as Error).message);
    return { issued: false, issuedCount: 0, detail: `token issue failed: ${(err as Error).message}` };
  }
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
      // H1: S2 审批证据——缺失/无效时 S2 fail-closed（返回 S2_APPROVAL_EVIDENCE_MISSING）
      s2_evidence: z.object({
        approval_ref: z.string().min(1),
        approved_plan: z.string().min(1),
        change_classification: z.string().min(1),
        global_architecture_decision: z.string().min(1),
        confirmations: z.array(z.string()).default([]),
        // H-03/P1-1: s2-evidence-v2 可选字段。**必须在 zod 里声明**——zod 对象默认丢弃未知键，
        // 不声明就会在到达 normalizeS2Evidence 之前被静默剥掉（实测踩中：补丁方案被判成
        // 「非补丁」→ 债务不登记）。声明为 optional，不参与必填校验。
        problem_nature: z.enum(['specific_bug', 'coupling_debt', 'arch_structural_defect']).optional(),
        final_approved_plan: z.enum(['patch', 'arch_structural']).optional(),
        patch_plan: z.object({
          is_available: z.boolean(),
          change_scope: z.array(z.string()).optional(),
          short_term_effect: z.string().optional(),
          debt_risks: z.string().optional(),
          not_available_reason: z.string().nullable().optional(),
          associated_debt_id: z.string().nullable().optional(),
          payback_milestone: z.string().nullable().optional(),
        }).optional(),
        // 🔴 2026-09-11 补齐：以下三个 v2 字段（见 src/schemas/s2-evidence-v2.ts）此前**未在
        // zod 声明**，被 zod 的「丢弃未知键」行为静默剥掉，导致功能整体失效：
        //   skip_manual_verification → S6-B 永远要求人工验收（H-02 开关从未生效）
        //   allow_full_rewrite       → H-05「S2 授权大文件覆写」白名单恒为空
        //   arch_structural_plan     → 架构方案结构化字段全丢
        // 教训：改 s2_evidence 必须对照 s2-evidence-v2.ts 全字段核对（此前 patch_plan 已踩过一次）。
        allow_full_rewrite: z.array(z.string()).optional(),
        skip_manual_verification: z.boolean().optional(),
        arch_structural_plan: z.object({
          is_available: z.boolean(),
          change_scope: z.array(z.string()).optional(),
          benefit: z.string().optional(),
          dependencies: z.array(z.string()).optional(),
          estimated_workload: z.string().optional(),
          not_available_reason: z.string().nullable().optional(),
        }).optional(),
      }).optional().describe('H1: S2 审批证据（非秘密；缺失/无效时 S2 fail-closed，返回 S2_APPROVAL_EVIDENCE_MISSING）。补丁方案（final_approved_plan=patch 或 patch_plan.is_available=true）且未绑定 associated_debt_id → 批准瞬间自动登记技术债，结果见 s2_patch_debt_id。'),
      owner_closure_id: z.string().regex(/^oc_[a-f0-9]{16}$/).optional()
        .describe('一次性 owner-adopted closure ID；必须由本机密码门 CLI 预先签发并绑定精确 branch/HEAD/files/SHA/rules'),
    },
  },
  async ({ flow, files, message, skip_s3_compile, exempt_files, s2_evidence, owner_closure_id }) => {
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

    // H1: 规范化 + 校验 S2 审批证据（trim 后非空）。
    // 失败不在此 return——缺失/空白 evidence 必须进入 FlowEngine，
    // 由 onHumanGate 回调在 S2 返回 denied → human_denied 终态 + 唯一 flow_abort + 真实 token_issued:false。
    const ev = normalizeS2Evidence(s2_evidence);
    const evidenceStatus = ev.ok ? 'provided' : 'invalid';
    const evidenceDiagnostic = ev.diagnostic;
    const validEvidence = ev.evidence;

    // Owner closure is never self-declared by the MCP caller. The caller only
    // supplies a short ID. The signed record was issued locally through the
    // owner password CLI and is revalidated/claimed against current hashes.
    let ownerClosureClaim: {
      closure_id: string;
      attempt_id: string;
      approval_ref: string;
      allowed_blocking_rules: string[];
      files: Array<{ path: string; sha256: string }>;
      verified: true;
    } | null = null;
    if (owner_closure_id) {
      // B2-fix: owner-closure 运行时已随 ConvergenceGate 回滚停用（applyOwnerAdoptedClosure 不再存在）。
      // 传 owner_closure_id 只会被静默忽略（st.owner_adopted_closure 无人消费）→ 显式拒绝，不留静默空转的伪功能。
      // closure 机制待 H2 MR-1 按 typed obligation 重新落地后再启用。
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        success: false,
        flow_status: 'not_started',
        token_issued: false,
        owner_closure_status: 'unavailable',
        error: 'OWNER_CLOSURE_UNAVAILABLE: owner-closure 运行时已随 ConvergenceGate 回滚停用；请走标准 S1-S7 或等待 H2 重新落地。',
      }, null, 2) }] };
    }

    // 动态加载 Harness 引擎（ESM）
    const { FlowEngine } = await import('../src/FlowEngine.js');
    const { classifyFiles, isTrivialChange } = await import('../src/RiskClassifier.js');
    const { review } = await import('../src/DelegateReviewer.js');
    const { evaluate: convergenceEvaluate } = await import('../src/ConvergenceGate.js');

    const risk = classifyFiles(files);
    const trivial = isTrivialChange(msg, files, PROJECT_ROOT);

    // P5: ProjectBrain — 构建 IntentSpec 用于 DiffScopeGuard
    // v2.11: buildIntentSpec 接口无 files/projectRoot 字段且内部不使用（死参数）→ 去掉，修 TS2353
    const intentSpec = buildIntentSpec({
      title: msg?.slice(0, 80) || 'Unnamed intent',
      description: msg || '',
    });
    console.error(`[harness-mcp] IntentSpec: ${intentSpec.id} | risk: ${risk} | scope: ${intentSpec.scope.allowed_paths.length} allowed, ${intentSpec.scope.forbidden_paths.length} forbidden`);

    // 自由裸奔
    if (risk === 'low' && trivial) {
      if (owner_closure_id) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              flow_status: 'not_started',
              token_issued: false,
              owner_closure_status: 'rejected',
              error: 'OWNER_CLOSURE_PIPELINE_MODE_REQUIRED',
            }, null, 2),
          }],
        };
      }
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

    if (owner_closure_id) {
      try {
        ownerClosureClaim = ownerClosureCore.claimOwnerClosure({
          closureId: owner_closure_id,
          projectRoot: PROJECT_ROOT,
          files,
        });
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({
          success: false,
          flow_status: 'not_started',
          token_issued: false,
          owner_closure_status: 'rejected',
          error: (error as Error).message,
        }, null, 2) }] };
      }
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
    // v2.11-fix: 原实现直接引用 `state` 但本函数作用域内未定义（mcp/ 不在 tsconfig include，
    // tsc 抓不到）→ 非空 exempt_files 时抛 ReferenceError，S4.5 无法闭环。改为在 delegate
    // 处理器内用 FlowEngine 传入的 st（真实 state 引用）原地挂载，语义不变。
    delegateFnMap.set('S4.5_Convergence_Gate', async (stage: any, st: any) => {
      if (Array.isArray(exempt_files) && exempt_files.length > 0) {
        st.s4_exempt_files = exempt_files;
      }
      if (ownerClosureClaim) {
        st.owner_adopted_closure = ownerClosureClaim;
      }
      return convergenceEvaluate(stage, st);
    });
    // H-01(enhance-v1): S7-B 归档完整性硬校验（进程内 delegate，无 LLM）
    //   读 S7-A 落盘的 data/archives/<run_id>.json → S7ArchiveValidator R1-R5 → pass/reject 双通道
    const { s7ArchiveValidateDelegate } = await import('../src/s7/S7ArchiveDelegate.js');
    delegateFnMap.set('S7-B_Archive_Validate', s7ArchiveValidateDelegate);
    // H-02(enhance-v1): S6-B 人工验收门控（进程内 delegate，无 LLM）
    //   按 change_key（稳定变更指纹）读/建 data/manual_tickets/<change_key>.json；
    //   未全确认 → 驳回（FlowEngine 悬挂终局 run_status=await_manual_verification，不签发 token）
    const { s6ManualVerifyDelegate } = await import('../src/s6/S6ManualVerifyDelegate.js');
    delegateFnMap.set('S6-B_Manual_Verify', s6ManualVerifyDelegate);

    // H-03/P1-1: S2「选补丁方案」→ 自动登记技术债（台账三环的第一环）。
    // 链路：① S2 补丁 → createDebt + linkRun（此处） → ② S4.5 DS<98→候选池（已 live）
    //       → ③ S7-B R2 校验补丁必须绑定存在的 debt_id（已 live）。
    // 建账时点选在【human gate 判定 approved 的瞬间】：不早于批准，避免为未批准的方案落账。
    const { ensurePatchDebt } = await import('../src/debt/s2PatchDebt.js');
    type PatchDebtOutcome = Awaited<ReturnType<typeof ensurePatchDebt>>;
    let patchDebt: PatchDebtOutcome | null = null;
    // 经函数读取：赋值只发生在 humanGateCallback 闭包内，TS 控制流分析看不到，
    // 直接读会被收窄成 never。显式返回类型的读取函数可绕开该收窄。
    const readPatchDebt = (): PatchDebtOutcome | null => patchDebt;

    // H1: 不再无条件自动批准。仅当本次 run 携带【有效】S2 审批证据时才批准 human gate；
    //     无证据 / 证据无效 → denied（fail-closed）。S2 是唯一 human gate 节点。
    const humanGateCallback = async (stage: any): Promise<'approved' | 'denied'> => {
      if (stage?.stage_id === 'S2_Solution_Design') {
        // 到达此处时 validEvidence 已通过 normalizeS2Evidence 校验（非空非纯空白）
        if (!validEvidence) return 'denied';
        // 降级：sqlite 不可用 / 建账异常 → 跳过不阻断（只记录原因），绝不卡死已批准的流程
        patchDebt = ensurePatchDebt(
          { ...validEvidence, ...(ev.v2 || {}) } as Parameters<typeof ensurePatchDebt>[0],
          { runId: engine.getState()?.run_id },
        );
        if (patchDebt.created) {
          console.error(`[harness-mcp] 📒 S2 采纳补丁方案 → 已自动登记技术债: ${patchDebt.debt_id}`);
        } else if (patchDebt.skipped_reason) {
          console.error(`[harness-mcp] 📒 S2 补丁债务登记跳过: ${patchDebt.skipped_reason}`);
        }
        return 'approved';
      }
      // 非 S2 human gate（若有其他 human 节点）→ 保守 denied
      return 'denied';
    };

    const engine = new FlowEngine({
      delegateReviewFn: async (stage: any, state: any) => review(stage, state),
      delegateReviewFnMap: delegateFnMap,
      projectRoot: PROJECT_ROOT,
      onHumanGate: humanGateCallback,
      // 🔴 P9-fix: skip_s3_compile 为 true 时跳过 S3 编译自检（仅限修复历史编译错误任务）
      // 原因：修复编译错误需要先改文件，改文件需要 token，token 需要 flow 通过——
      // 若 S3 强制检查「本次文件」现有错误，修复任务永远拿不到 token（死锁）。
      conditionGateCheck: skip_s3_compile ? async () => ({ passed: true, reason: 'skip_s3_compile=true — 修复编译错误豁免，改完后 S5 仍会完整验证' }) : s3CompileCheck,
    });

    let result: Awaited<ReturnType<typeof engine.start>> | undefined = undefined;
    let tokenResult: Awaited<ReturnType<typeof attemptTokenIssue>> | undefined = undefined;
    try {
      result = await engine.start(flowName, {
        message: msg,
        modifiedFiles: files,
        riskLevel: risk,
        isTrivial: trivial,
        projectRoot: PROJECT_ROOT,
        skip_s3_compile: skip_s3_compile === true,
        // H1: S2 审批证据（规范化后）——供 S2 human_report 注入 + S4 confirmations 精确匹配
        // 🔴 2026-09-11 修复（P0-A 第二层）：原实现只传 v1 的 validEvidence，s2-evidence-v2 的
        // 可选字段（problem_nature / final_approved_plan / patch_plan / skip_manual_verification
        // / allow_full_rewrite）**全部丢弃** → state.s2_evidence 上永远没有这些字段。
        // 后果（实测）：
        //   - S6-B 的 `state.s2_evidence.skip_manual_verification` 恒 undefined → H-02 开关从未生效
        //   - FlowEngine 从 `s2_evidence.allow_full_rewrite` 注入 H-05 白名单 → 恒为空
        // 这是与 zod inputSchema 同源的「白名单丢字段」缺陷的第二层（第一层见上方 zod 声明处）。
        // v1 字段在后、v2 在前的顺序不可颠倒：v2 才是增强真值来源。
        s2_evidence: validEvidence ? { ...validEvidence, ...(ev.v2 || {}) } : undefined,
      });

      // A claimed owner closure must first reach the real completed terminal
      // state. Only then is this single attempt authorized to enter the normal
      // H0 token policy. Aborted flows remain unable to issue tokens.
      if (ownerClosureClaim && result.success) {
        ownerClosureCore.authorizeOwnerClosureToken({
          closureId: ownerClosureClaim.closure_id,
          attemptId: ownerClosureClaim.attempt_id,
          runId: result.run_id,
          flowSuccess: result.success,
          flowStatus: result.flow_status,
          endReason: result.end_reason,
        });
      }

      // H0: 尝试签发 Token v2（HMAC 签名）——返回真实签发结果，不因 result.success 误报
      tokenResult = await attemptTokenIssue(result, files, intentSpec);

      if (ownerClosureClaim) {
        const allTokensIssued = tokenResult.issued && tokenResult.issuedCount === files.length;
        ownerClosureCore.finishOwnerClosure({
          closureId: ownerClosureClaim.closure_id,
          attemptId: ownerClosureClaim.attempt_id,
          runId: result.run_id,
          success: result.success && allTokensIssued,
          tokenIssued: allTokensIssued,
          failureReason: result.success ? tokenResult.detail : result.end_reason,
        });
      }
    } catch (error) {
      if (ownerClosureClaim) {
        try {
          ownerClosureCore.finishOwnerClosure({
            closureId: ownerClosureClaim.closure_id,
            attemptId: ownerClosureClaim.attempt_id,
            runId: result?.run_id || '',
            success: false,
            tokenIssued: false,
            failureReason: (error as Error).message,
          });
        } catch (finishError) {
          console.error('[harness-mcp] owner closure fail-state 持久化失败:', (finishError as Error).message);
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        success: false,
        flow_status: result?.flow_status || 'error',
        run_id: result?.run_id,
        token_issued: false,
        owner_closure_status: ownerClosureClaim ? 'failed' : undefined,
        error: (error as Error).message,
      }, null, 2) }] };
    }

    if (!result || !tokenResult) {
      throw new Error('OWNER_CLOSURE_INTERNAL_RESULT_MISSING');
    }

    // H0: 稳定诊断——成功/失败均有明确文案，不泄露 evidence 原文
    const tokenNote = tokenResult.issued
      ? `Token issued for ${tokenResult.issuedCount} file(s).`
      : `No token issued: ${tokenResult.detail || 'unknown reason'}.`;
    let humanGateNote = result.success
      ? `Pipeline completed. ${tokenNote}`
      : `Pipeline ${result.end_reason}. Human approval required for S1/S2 stages. No token issued.`;
    // H-02/H-01(enhance-v1): 区分「悬挂待人工」与「归档校验失败」——二者非错误，需不同处置
    if (result.run_status === 'await_manual_verification') {
      humanGateNote =
        '⏸ S6-B 人工验收未完成 → 本次未签发写入令牌。请运行 ' +
        'node D:/AI文件/harness/scripts/harness-manual-confirm.cjs list ' +
        '查看任务单，逐项 confirm 后，以同一批文件重跑 harness_run_flow（change_key 相同 → 命中同一张任务单 → 自动放行 S7）。';
    } else if (result.run_status === 'archive_invalid') {
      // F5(2026-09-11): 原文案写 `diff_files`，与实际 schema（rollback_plan.modified_files）不符，
      // 会直接把 Agent 引向错误结构 → S7-B 必然再拒。此处按 src/schemas/s7-archive-payload.ts 如实列出。
      // F6(2026-09-11): 删去「S7-A 为本地空跑 stage，无法自动产出归档」这一**已失效的前提**——
      // S7-A 现由 src/s7/s7AutoArchive.ts 在进程内自动归档，归档缺失不再是主因；必须透传
      // S7-B 的真实 reject_reason（R1 缺产物 / R2-R5 内容或豁免不合法），否则误导排查方向。
      const reasons = archiveFailureReasons(result.stage_results);
      const r4Hint = reasons.some(r => /^R4/.test(r))
        ? ' 处置建议（R4：S4.5 综合分 <98 必须携带有效 exemption_id）：先为该文件签发豁免再重跑，' +
          '即 core.addExemption(file, { relaxed_checks: ["S4.5_complexity"] })（scripts/exemptions-core.cjs）。'
        : '';
      humanGateNote =
        '📦 S7-B 归档校验失败 → 本次未签发写入令牌。' +
        `真实原因：${reasons.length ? reasons.join(' | ') : '见审计卷宗 S7-B machine_signal（未提供结构化原因）'}。` +
        '归档产物路径 data/archives/<run_id>.json（由 S7-A 进程内自动生成，src/s7/s7AutoArchive.ts）；' +
        '字段结构见 src/schemas/s7-archive-payload.ts，校验规则 R1-R5 见 src/s7/S7ArchiveValidator.ts。' +
        r4Hint;
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: result.success,
          run_id: result.run_id,
          end_reason: result.end_reason,
          flow_status: result.flow_status,
          // H-02/H-01(enhance-v1): completed | aborted | await_manual_verification | archive_invalid
          run_status: result.run_status,
          risk,
          files,
          stage_count: result.stage_results.length,
          stages: result.stage_results.map(s => ({
            id: s.stage_id,
            status: s.status,
            gate: s.gate_resolution,
          })),
          token_issued: tokenResult.issued,
          token_issued_count: tokenResult.issuedCount,
          token_expires_in: tokenResult.issued ? tokenResult.expiresIn : 'N/A',
          token_verdict: tokenResult.verdictCode ?? 'eligible',
          human_gate_note: humanGateNote,
          s2_evidence_status: evidenceStatus,
          // H-03/P1-1: S2 补丁方案的债务登记结果——Agent 须把该 id 写进 S7-A 归档的
          // data/archives/<run_id>.json → debt_marker.debt_item_id，S7-B 的 R2 才能通过。
          s2_patch_debt_id: readPatchDebt()?.debt_id ?? undefined,
          s2_patch_debt_note: (() => {
            const pd = readPatchDebt();
            if (pd === null) return undefined;
            if (pd.created) return `已自动登记技术债 ${pd.debt_id}；请在 S7-A 归档的 debt_marker.debt_item_id 填写该 id（is_patch=true）。`;
            if (pd.debt_id) return `复用已有技术债 ${pd.debt_id}；请在 S7-A 归档的 debt_marker.debt_item_id 填写该 id。`;
            return `未登记债务：${pd.skipped_reason || '不适用'}`;
          })(),
          s2_evidence_diagnostic: evidenceStatus === 'provided' ? undefined : (evidenceDiagnostic ?? 'S2_APPROVAL_EVIDENCE_MISSING'),
          owner_closure_id: ownerClosureClaim?.closure_id,
          owner_closure_status: ownerClosureClaim ? (tokenResult.issuedCount === files.length ? 'completed' : 'failed') : undefined,
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
          risk_reviews: (rules.risk_reviews || []).map((r: any) => ({
            file: r.file, rejectCount: r.rejectCount, mainCause: r.mainCause, suggestion: r.suggestion,
          })),
          behavior_hints: (rules.behavior_hints || []).map((h: any) => ({
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
	      sig: '', // v2.11: 预置字段修 TS2339（对象字面量缺 sig，后续赋值报错）
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

// 🔴 调试豁免列表 — 这些文件即使匹配 HIGH_RISK 也降级为 low，便于测试时直接修改
const SENTINEL_DEBUG_EXEMPT = [
  'src/engine/reflex/SafetyInterceptor.ts',
];

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
  // 🔴 调试豁免优先于高风险检查
  for (const f of SENTINEL_DEBUG_EXEMPT) {
    if (n.includes(f)) return 'low';
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

    // v2.11: 移除 content_hash 写后校验。/sentinel/check 是「修改后」时序（sentinel watcher 主路径，
    // sentinel-mcp-client checkFile 优先 HTTP 调这里），content_hash(签发时内容) 此时必然不匹配
    // → 合法修改被拒 → A2 源码被回滚（v2.10 时序缺陷）。content_hash 仅由 pre-check（修改前 hook）
    // 校验——那里才能区分第一次/反复修改。签发侧(server.ts L369)的 content_hash 保留作为绑定字段。

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

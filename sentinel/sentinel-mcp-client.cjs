/**
 * sentinel-mcp-client.js — MCP Server HTTP 客户端
 * ================================================
 * 哨兵通过此模块向 Harness MCP Server 查询文件是否被授权修改。
 *
 * 调用 /sentinel/check 端点（REST，非 MCP JSON-RPC）:
 *   POST http://127.0.0.1:8765/sentinel/check
 *   Body: { file: "src/webui/chat.ts", project: "wenstar-cc" }
 *   返回: { allowed: boolean, risk: "high|mid|low|protected", reason: "...", tokenFound: boolean }
 *
 * 如果 MCP Server 不可达，降级为直接读取本地令牌文件（同 Hook 逻辑）。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ── 配置 ──

const MCP_HOST = process.env.HARNESS_MCP_HOST || '127.0.0.1';
const MCP_PORT = parseInt(process.env.HARNESS_MCP_PORT || '8765');

/** 令牌存储目录 */
const TOKEN_DIR = path.resolve(__dirname, '..', 'data', 'tokens');

/** 高风险文件列表（与 harness-pre-check.cjs 保持同步） */
const HIGH_RISK_FILES = [
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

const LOW_RISK_PREFIXES = [
  'src/config/', 'src/types/', 'src/cli/', 'src/common/',
  'src/adapter/', 'src/modules/',
  'src/app/tools/', 'src/app/utils/', 'src/app/shared/', 'src/app/__tests__/',
];

const LOW_RISK_SUFFIXES = ['.test.ts', '.spec.ts', '.d.ts'];
const LOW_RISK_EXTENSIONS = ['.md', '.sql', '.cjs', '.mjs', '.html', '.css', '.scss', '.less', '.env', '.gitignore', '.lock', '.sh', '.ps1', '.bat'];

const HARNESS_PROTECTED = [
  '.claude/settings.json', '.claude/harness', '.claude/workflows', '.claude/hooks',
];

// ── 工具函数 ──

function normalize(fp) { return String(fp).replace(/\\/g, '/'); }
function hashCode(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h).toString(36); }

function classifyRisk(filePath) {
  const n = normalize(filePath);
  // 保护区
  for (const p of HARNESS_PROTECTED) {
    if (n.startsWith(p) || n.includes('/' + p)) return 'protected';
  }
  // 高风险
  for (const f of HIGH_RISK_FILES) {
    if (n.includes(f)) return 'high';
  }
  // 低风险
  for (const pf of LOW_RISK_PREFIXES) { if (n.startsWith(pf)) return 'low'; }
  for (const sf of LOW_RISK_SUFFIXES) { if (n.includes(sf)) return 'low'; }
  for (const ex of LOW_RISK_EXTENSIONS) { if (n.endsWith(ex)) return 'low'; }
  return 'mid';
}

// ── 令牌检查（本地文件系统，与 Hook 完全相同）─

function checkTokenLocal(filePath) {
  try {
    if (!fs.existsSync(TOKEN_DIR)) return null;
    const hash = hashCode(normalize(filePath));
    const tp = path.join(TOKEN_DIR, hash + '.json');
    if (!fs.existsSync(tp)) return null;
    const raw = fs.readFileSync(tp, 'utf-8');
    const token = JSON.parse(raw);
    const now = Date.now();
    if (now > (token.expires_at || 0)) { try { fs.unlinkSync(tp); } catch (_) {} return null; }
    if (token.consumed) return null;
    if (token.caller_uuid && token.caller_uuid !== 'sg-mcp-v3-00000000-0000-0000-0000-000000000001') return null;
    return token;
  } catch (_) { return null; }
}

function consumeTokenLocal(filePath, token) {
  try {
    const hash = hashCode(normalize(filePath));
    const tp = path.join(TOKEN_DIR, hash + '.json');
    if (!fs.existsSync(tp)) return;
    const raw = fs.readFileSync(tp, 'utf-8');
    const t = JSON.parse(raw);
    t.consumed = true;
    t.consumed_at = new Date().toISOString();
    // 写 consumed 记录
    const cPath = path.join(TOKEN_DIR, hash + '.consumed');
    fs.writeFileSync(cPath, JSON.stringify({
      file: filePath, run_id: t.run_id, consumed_by: 'sentinel',
      consumed_at: t.consumed_at,
    }, null, 2), 'utf-8');
    // 删令牌
    fs.unlinkSync(tp);
    console.error(`[sentinel:client] 令牌已消费: ${filePath}`);
    return true;
  } catch (_) { return false; }
}

// ── 公开 API ──

/**
 * 检查文件是否被授权修改。
 *
 * 优先尝试 MCP Server HTTP 端点，失败时降级到本地文件系统检查。
 *
 * @param {string} filePath - 相对于项目根目录的文件路径
 * @param {{ project?: string }} opts
 * @returns {Promise<{ allowed: boolean, risk: string, reason: string, tokenFound: boolean }>}
 */
async function checkFile(filePath, opts = {}) {
  const risk = classifyRisk(filePath);
  const n = normalize(filePath);

  // 保护区 → 永远拒绝
  if (risk === 'protected') {
    return { allowed: false, risk, reason: `🚫 保护区文件被修改: ${n}。已触发回滚。`, tokenFound: false };
  }

  // 低风险 → 永远放行
  if (risk === 'low') {
    return { allowed: true, risk, reason: `🟢 低风险文件: ${n}`, tokenFound: false };
  }

  // 中/高风险 → 需要令牌
  // 1) 尝试 HTTP 调用 MCP Server
  const httpResult = await checkViaHTTP(filePath);
  if (httpResult !== null) return httpResult;

  // 2) 降级：直接读本地令牌文件
  const token = checkTokenLocal(n);
  if (token) {
    consumeTokenLocal(n, token);
    return {
      allowed: true, risk,
      reason: `✅ 令牌有效 (run: ${token.run_id}, risk: ${token.risk_level})`,
      tokenFound: true,
    };
  }

  return {
    allowed: false, risk,
    reason: `🚫 中高风险文件 "${n}" 未经授权被修改 (风险: ${risk}, 令牌: 未找到)`,
    tokenFound: false,
  };
}

// ── 内部：HTTP 调用 ──

function checkViaHTTP(filePath) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ file: normalize(filePath) });
    const req = http.request({
      hostname: MCP_HOST, port: MCP_PORT,
      path: '/sentinel/check', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 3000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          resolve(null); // 解析失败 → 降级
        }
      });
    });
    req.on('error', () => resolve(null)); // 网络不可达 → 降级
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

module.exports = { checkFile, classifyRisk, checkTokenLocal, consumeTokenLocal };

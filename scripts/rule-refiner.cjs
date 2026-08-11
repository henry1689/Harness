#!/usr/bin/env node
/**
 * rule-refiner.cjs — 规则升华器 (LLM 升华环节)
 * =============================================
 * 把 RuleLearner 的「确定性规律」用 LLM 升华成「可执行规则建议」。
 *
 * 边界（铁律）:
 *   - 监控链路（哨兵/心跳/watchdog）保持零 LLM，本脚本不进入那些进程
 *   - LLM 只用于「规律 → 规则」这一步，频率低（手动触发或每日一次）
 *   - 输出是「建议」，人工确认后才应用，不自动改变哈里森行为
 *
 * 输入: data/learn/rules.json（RuleLearner 生成的规律）
 * 输出: data/learn/refined-rules.md（LLM 升华的可执行规则建议）
 *
 * 用法:
 *   node scripts/rule-refiner.cjs                # 用默认配置升华
 *   node scripts/rule-refiner.cjs --dry          # 只打印提示词，不调 API
 *
 * LLM 配置: 读全局 settings.json 的 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const HARNESS_DIR = path.resolve(__dirname, '..');
const RULES_FILE = path.join(HARNESS_DIR, 'data', 'learn', 'rules.json');
const OUT_FILE = path.join(HARNESS_DIR, 'data', 'learn', 'refined-rules.md');
const SETTINGS_FILE = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.claude', 'settings.json');

// ── LLM 配置 ──
function getLLMConfig() {
  // 优先环境变量，其次读全局 settings.json
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.DEEPSEEK_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const model = process.env.ANTHROPIC_MODEL;
  if (apiKey && baseUrl && model) return { apiKey, baseUrl, model };

  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    return {
      apiKey: s.env?.ANTHROPIC_AUTH_TOKEN || s.env?.DEEPSEEK_API_KEY,
      baseUrl: s.env?.ANTHROPIC_BASE_URL,
      model: s.env?.ANTHROPIC_MODEL || 'deepseek-chat',
    };
  } catch (_) { return null; }
}

// ── 构建提示词 ──
function buildPrompt(rules, highRiskFiles) {
  // 🔴 精简输入: 只传核心规律（文件/次数/主因），不传完整 JSON，减少 thinking 负担
  const summary = {
    file_risks: (rules.risk_reviews || []).map(r => ({ file: r.file, rejects: r.rejectCount, runs: r.runCount, cause: r.mainCause })),
    agent_behaviors: (rules.behavior_hints || []).map(h => ({ file: h.file, rejects: h.rejectCount, runs: h.runCount })),
    standard: (rules.standard_suggestions || []).map(s => ({ s45_ratio: s.s45Ratio, note: s.suggestion })),
  };
  return `你是软件工程治理专家，从代码监控数据提炼可执行管控规则。

数据:
${JSON.stringify(summary, null, 2)}

现有 HIGH_RISK 文件(部分): ${highRiskFiles.slice(0, 20).join(', ')}

任务: 基于以上规律，输出可执行规则建议（Markdown）:
### 规则N: [类型] 标题
- 类型: risk_adjust/standard_adjust/agent_hint/new_rule
- 触发条件: ...
- 哈里森动作: ...
- 优先级: P0/P1/P2
- 依据: 数据证据

克制，只建议真正有价值的。`;
}

// ── 调 LLM ──
// 🔴 用 OpenAI 兼容端点（/chat/completions）而非 Anthropic /messages：
//    DeepSeek 的 Anthropic 端点对 V4-flash 强制 thinking，超长 prompt 时 max_tokens
//    全被 thinking 占用 → text 为空。OpenAI 端点无此问题，输出稳定。
function callLLM(config, prompt) {
  return new Promise((resolve, reject) => {
    const baseHost = new URL(config.baseUrl).hostname; // api.deepseek.com
    const basePath = new URL(config.baseUrl).pathname.replace(/\/$/, ''); // /anthropic 或空
    // 若 baseUrl 含 /anthropic，改用根 /chat/completions；否则直接拼
    const chatPath = basePath.endsWith('/anthropic') ? '/chat/completions' : basePath + '/chat/completions';
    const data = JSON.stringify({
      model: 'deepseek-chat', // OpenAI 端点用 deepseek-chat
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: baseHost,
      path: chatPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + config.apiKey,
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const j = JSON.parse(body);
            const content = j.choices?.[0]?.message?.content || '';
            resolve(content);
          } catch (e) { reject(new Error('解析响应失败: ' + body.slice(0, 200))); }
        } else {
          reject(new Error('API 错误 ' + res.statusCode + ': ' + body.slice(0, 300)));
        }
      });
    });
    req.on('error', e => reject(e));
    req.write(data);
    req.end();
  });
}

// ── 主流程 ──
const isDry = process.argv.includes('--dry');
const config = getLLMConfig();
if (!config) {
  console.error('❌ 未找到 LLM 配置（ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL）。请配置全局 settings.json 或在环境变量设置。');
  process.exit(1);
}
console.log(`✅ LLM 配置: ${config.model} @ ${config.baseUrl}`);

// 读规则
if (!fs.existsSync(RULES_FILE)) {
  console.error('❌ 未找到 rules.json。请先运行: node scripts/rule-learner.cjs');
  process.exit(1);
}
const rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));

// 读 HIGH_RISK（从 pre-check hook 提取）
let highRiskFiles = [];
try {
  const hookSrc = fs.readFileSync(path.join(HARNESS_DIR, '.claude', 'harness-pre-check.cjs'), 'utf-8');
  const m = hookSrc.match(/var HIGH_RISK = \[([\s\S]*?)\];/);
  if (m) {
    highRiskFiles = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  }
} catch (_) {}

const prompt = buildPrompt(rules, highRiskFiles);

if (isDry) {
  console.log('=== 提示词（dry-run，不调 API）===');
  console.log(prompt.slice(0, 1500));
  console.log('...');
  process.exit(0);
}

console.log('🔄 调用 LLM 升华规则...');
callLLM(config, prompt).then(refined => {
  const out = `# Harness 规则升华建议\n\n> 由 RuleLearner 规律 + LLM 升华生成\n> 时间: ${new Date().toISOString()}\n> 这些是「建议」，人工确认后应用\n\n${refined}\n`;
  fs.writeFileSync(OUT_FILE, out);
  console.log(`✅ 升华完成，已写入: ${OUT_FILE}`);
  console.log(out);
}).catch(err => {
  console.error('❌ 升华失败:', err.message);
  process.exit(1);
});

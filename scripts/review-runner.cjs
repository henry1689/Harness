/**
 * review-runner.cjs — DelegateReviewer 独立子进程入口 (P5)
 * ==========================================================
 * 被 MCP server 通过 child_process.fork() 启动，
 * 在独立进程中执行 S4 架构评审，真正实现"运动员不自审"。
 *
 * 协议:
 *   stdin  ← JSON { stage: StageConfig, state: FlowRunState }
 *   IPC    → JSON StageOutput { machine_signal, human_report }
 *   退出码 → 0=成功, 1=异常
 *
 * 使用 tsx 注册 TypeScript 以便在 CJS 环境中加载 ESM .ts 模块。
 */

const { readFileSync } = require('fs');

// 收集 stdin（分块读取）
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const payload = JSON.parse(input);
    const { stage, state } = payload;

    if (!stage || !state) {
      process.send?.({ error: 'Missing stage or state in input' });
      process.exit(1);
    }

    // 注册 tsx loader 以支持 TypeScript ESM import
    try { require('tsx/cjs'); } catch (_) { /* tsx 可能不在 node_modules 路径中 */ }

    // 动态导入 ESM 模块
    const { review } = await import('../src/DelegateReviewer.js');

    // 执行评审（超时保护 60s）
    const timeout = setTimeout(() => {
      process.send?.({ machine_signal: { passed: false, risk_level: 'high', reject_reason: ['DelegateReviewer 评审超时 (60s)'] }, human_report: '# ⚠️ 评审超时\n\n独立评审子进程在 60 秒内未完成。' });
      process.exit(1);
    }, 60_000);

    const result = await review(stage, state);
    clearTimeout(timeout);

    if (process.send) {
      process.send(result);
    } else {
      // fallback: stdout
      process.stdout.write(JSON.stringify(result));
    }

    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.send?.({ machine_signal: { passed: false, risk_level: 'high', reject_reason: [`review-runner 执行异常: ${msg}`] }, human_report: `# ❌ 评审子进程异常\n\n\`\`\`\n${msg}\n\`\`\`` });
    process.exit(1);
  }
});

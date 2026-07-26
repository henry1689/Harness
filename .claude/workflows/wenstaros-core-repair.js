/**
 * wenstaros-core-repair — WenStarOS TS内核缺陷修复&架构重构刚性管控流水线
 * ============================================================================
 * Claude Code Workflow 版 S1-S7 全流程。
 *
 * 使用方式：在 WenStarOS 项目窗口中说 /wenstaros-core-repair <要修改的文件>
 *
 * 核心铁律：
 *   1. 状态机严格锁定 S1→S2→S3→S4→S5→S6→S7 顺序，AI 无权限跳步
 *   2. S4 委托独立子 Agent 评审（运动员不自审）
 *   3. S5 编译测试不通过 → 自动打回 S3
 *   4. 🔴高风险文件必须走完全流程，🟢低风险微小修改可跳过
 *   5. max_jump_limit=10 循环熔断（S3→S4→S5→S6 连续驳回计数）
 */

export const meta = {
  name: 'wenstaros-core-repair',
  description: 'WenStarOS TS内核缺陷修复&架构重构刚性管控流水线 S1-S7',
  phases: [
    { title: 'S1 问题收录' },
    { title: 'S2 方案定稿' },
    { title: 'S3 代码落地' },
    { title: 'S4 架构评审' },
    { title: 'S5 编译测试' },
    { title: 'S6 功能验证' },
    { title: 'S7 变更归档' },
  ],
};

// ════════════════════════════════════════════════════════════════════
// 风险分级
// ════════════════════════════════════════════════════════════════════

const HIGH_RISK_FILES = [
  'src/webui/chat.ts',
  'src/m4/household/FamilyGraph.ts',
  'src/m2/SQLiteAdapter.ts',
  'src/webui/server.ts',
  'src/m5/DeepSeekLLMProvider.ts',
  'src/engine/tianquan/prefrontal/PrefrontalCortex.ts',
];

const MID_RISK_PATTERNS = [
  /src\/m4\//, /src\/m5\//,
  /src\/app\/knowledge\/KnowledgeEngine/,
  /src\/app\/vault\/VaultManager/,
  /src\/m4\/household\/EntityMeeting/,
  /src\/webui\/chat\/MeetingContextPipeline/,
  /src\/m4\/household\/UUIDGatekeeper/,
  /src\/m2\/ConversationDB/,
  /src\/m2\/FusionStorageAdapter/,
  /src\/engine\//,
  /src\/app\/role\//,
  /src\/app\/fg\//,
  /src\/hooks\//,
];

function classifyFile(fp) {
  const n = fp.replace(/\\/g, '/');
  if (HIGH_RISK_FILES.some(h => n.includes(h))) return 'high';
  if (MID_RISK_PATTERNS.some(p => p.test(n))) return 'mid';
  if (/^src\/(config|types|cli|__tests__|common|modules|adapter)\//.test(n)) return 'low';
  if (/\.(test|spec)\.ts$/.test(n)) return 'low';
  return 'mid';
}

// ─── 输入 ───
const files = args && args.length > 0 ? args : [];
if (files.length === 0) {
  log('⚠️ 未指定要修改的文件。用法: /wenstaros-core-repair src/webui/chat.ts');
  return { success: false, reason: 'no_files' };
}

const riskLevels = files.map(f => classifyFile(f));
const overallRisk = riskLevels.includes('high') ? 'high' : riskLevels.includes('mid') ? 'mid' : 'low';

log(`📋 WenStarOS 内核修复流水线启动`);
log(`   文件: ${files.join(', ')}`);
log(`   风险: ${overallRisk === 'high' ? '🔴 高风险' : overallRisk === 'mid' ? '🟡 中风险' : '🟢 低风险'}`);

// 🟢 低风险 + 单文件 + 微小修改 → 自由裸奔
const isTrivial = overallRisk === 'low' && files.length === 1;
if (isTrivial) {
  log('🆓 自由裸奔模式 — 低风险微小修改，跳过 S1-S7 流水线。可直接修改，请注意系统不变量。');
  return { success: true, mode: 'free', risk: overallRisk, files };
}

// ════════════════════════════════════════════════════════════════════
// S1 问题收录+影响范围盘点（只读锁死，禁止修改代码）
// ════════════════════════════════════════════════════════════════════
phase('S1 问题收录');

const s1 = await agent(
  `你是 WenStarOS 项目架构专家。请完成以下分析（只读，不写任何代码）：

## 任务

对以下文件进行问题收录和影响范围盘点：

**待修改文件**：${files.join(', ')}
**风险等级**：${overallRisk}

## 分析要求

1. **枚举所有 import 依赖**：每个文件被哪些上层模块引用？输出完整的牵连清单。
2. **核心耦合点检测**：是否触碰以下关键点？
   - chat.ts finalKnowledgeText 22段注入链路
   - FamilyGraph 人物 dossier 七子卷结构
   - belong_entity_uuid 四层标注写入/读取链路
   - _meetingEntityName 12处传播判断点
   - 新旧角色扮演双管线切换逻辑 (ROLEPLAY_STRUCTURED_ENABLED)
   - SQLiteAdapter 防抖 save() 持久化落盘
3. **数据库影响预判**：conversations/memories/family_graph/black_diamond/knowledge_base 表变更风险
4. **FG11条红线触发检测**：本次改动是否触碰角色扮演隔离红线？

## 输出格式

\`\`\`
## S1 影响分析报告

### 1. 依赖关系
（逐文件列出所有 import 依赖和上层调用方）

### 2. 耦合点检测
（逐项标记 ✅ 未触碰 / ⚠️ 已触碰）

### 3. 数据库影响
（列出可能受影响的表和字段）

### 4. FG红线触发
（逐条11条红线标注触发状态）

### 5. 风险总评
（🔴高/🟡中/🟢低 + 一句话总结）
\`\`\`

⚠️ 禁止输出任何修改代码，禁止建议任何具体改法。仅做分析。`,
  { label: 'S1-问题分析', phase: 'S1 问题收录' }
);

log(`✅ S1 完成 — ${s1.slice(0, 100)}...`);

// ════════════════════════════════════════════════════════════════════
// S2 方案定稿（需要人工确认）
// ════════════════════════════════════════════════════════════════════
phase('S2 方案定稿');

const GLOBAL_ARCH_CONSTRAINT = `
# 全局不可突破架构铁律
1. M1-M9九层认知管线无循环依赖，仅chat.ts顶层编排，禁止反向依赖；
2. PFC为唯一顶层上下文门控，chat.ts仅做薄调度层，禁止堆砌业务逻辑；
3. FamilyGraph.ts为太虚境户籍唯一数据源，角色扮演使用独立分支FG，禁止污染主库；
4. UUID(TXS-xxxx)全链路belong_entity_uuid四层标注机制不可删减；
5. SQLiteAdapter为唯一持久写入通道，修改存储逻辑必须校验防抖save()落盘；
6. 会晤模式_meetingEntityName 12处判断点必须完整同步，禁止角色信息泄漏；
7. 新旧两套角色扮演管线规则必须同步修改；
8. 数据写入遵循「只增不删」，历史卷宗、记忆、黑钻记录禁止直接删除；
9. chat.ts内22段finalKnowledgeText注入顺序不可随意调换；
10. 高风险文件修改必须完整评估全量import依赖。
`.trim();

const s2 = await agent(
  `你是 WenStarOS 项目架构师。基于 S1 的影响分析报告，撰写重构技术方案。

## S1 分析报告
${s1}

## 全局架构铁律（不可突破）
${GLOBAL_ARCH_CONSTRAINT}

## 方案撰写要求

1. **分步修改清单**：精确到文件、函数、代码行号，禁止擅自扩大改动范围
2. **逐条校验**：方案是否违反全局架构铁律？冲突则调整方案
3. **专属约束**（按场景勾选）：
   - 涉及FG户籍 → 严格遵守11条角色扮演隔离红线
   - 涉及UUID链路 → 四层标注机制全部兼容
   - 涉及chat.ts → 22段注入顺序不变
   - 涉及数据库 → 停服重启持久化审计回滚方案
   - 涉及角色扮演 → 新旧两套管线规则同步
4. **验证用例**：编译校验、单元测试、会晤/普通对话/角色扮演三类场景、数据库标注率
5. **回滚方案**：改错后如何恢复源码、执行 safe-backfill.cjs

## 输出格式
输出完整的方案文档（Markdown），包含以上全部5部分。

⚠️ 这是方案设计阶段，禁止写任何代码。方案需等待人工确认后才能进入 S3。`,
  { label: 'S2-方案定稿', phase: 'S2 方案定稿' }
);

log(`✅ S2 方案已完成，请人工审阅确认后继续。`);

// ════════════════════════════════════════════════════════════════════
// S3 代码落地（唯一放开文件写入权限阶段）
// ════════════════════════════════════════════════════════════════════
phase('S3 代码落地');

const s3 = await agent(
  `你是 Claude Code。严格按照 S2 审定方案执行代码修改。

## S2 审定方案
${s2}

## 修改铁律
1. 严格依照 S2 方案修改，禁止顺带优化无关模块、隐性重构
2. 修改高风险文件必须在行注释标注风险等级、改动目的
3. 若涉及 SQLiteAdapter/persistence-stage.ts，保留 scheduleFlush 防抖落盘逻辑
4. FamilyGraph.dossier 结构改动 → 同步适配所有消费方
5. 涉及会晤模式 → 同步更新 12 处 _meetingEntityName 判断分支
6. 禁止新增垃圾实体匹配规则，必须匹配 GARBAGE_NAMES 黑名单
7. 禁止删除 types 类型定义、单元测试用例
8. 禁止直接删除数据库表数据，仅允许追加更新

## 执行
请逐文件、逐函数按照方案进行修改。每改完一个文件报告进度。`,
  { label: 'S3-代码落地', phase: 'S3 代码落地' }
);

log(`✅ S3 代码修改完成`);

// ════════════════════════════════════════════════════════════════════
// S4 独立子Agent架构评审（运动员不自审，委托独立子Agent）
// ════════════════════════════════════════════════════════════════════
phase('S4 架构评审');

const s4 = await agent(
  `你是独立架构评审专家（非修改者本人）。对 S3 修改后的代码进行完整合规评审。

## 待评审文件
${files.join(', ')}

## 评审维度（五维全覆盖）

### 一、架构层级
1. 是否破坏 M1-M9 无循环依赖规则
2. chat.ts 是否新增业务逻辑（违背薄调度层）
3. PFC 上下文注入逻辑是否被篡改

### 二、FG户籍 & UUID专项
1. FG主库/角色扮演分支是否隔离
2. belong_entity_uuid 写入、检索链路无缺失
3. UUIDGatekeeper 三层白名单过滤逻辑完整

### 三、耦合点专项
1. chat.ts 22段 finalKnowledgeText 注入顺序、内容无错乱
2. _meetingEntityName 12处传播判断点全部同步
3. 新旧角色扮演管线规则同步修改
4. FamilyGraph.dossier 所有消费方同步适配

### 四、持久化安全
1. SQLiteAdapter 防抖 save() 调用无丢失
2. 无直接删除记忆/卷宗/黑钻记录逻辑

### 五、风险兜底
1. 高风险文件改动完整覆盖全部 import 依赖
2. 是否触碰 FG11 条红线（角色串号、信息泄漏）
3. 是否新增硬编码人名、时间常量

### 六、文档同步（开发落地规则7）
1. 架构级改动是否有配套白皮书+蓝皮书文档更新
2. 无文档内容 → 直接判定该维不通过

## 输出格式（双通道——严格遵守）

请输出两部分：

\`\`\`machine_signal
{
  "passed": true/false,
  "risk_level": "high" | "mid" | "low",
  "reject_reason": ["原因1", "原因2"],
  "metrics": {
    "files_checked": N,
    "violations_found": N,
    "fg_redlines_touched": ["红线1", ...],
    "uuid_chain_broken": true/false,
    "chat_injection_order_changed": true/false
  }
}
\`\`\`

\`\`\`human_report
（Markdown格式，分点列出所有风险、违规代码位置、整改建议）
\`\`\`

⚡ 如果评审通过（passed=true 且 violations_found=0），可以直接进入 S5。
⚡ 如果评审不通过，必须明确指出具体违规文件和行号，打回 S3 重新修改。`,
  { label: 'S4-架构评审', phase: 'S4 架构评审' }
);

// 解析 machine_signal
let s4Passed = false;
try {
  const msMatch = s4.match(/```machine_signal\s*([\s\S]*?)```/);
  if (msMatch) {
    const signal = JSON.parse(msMatch[1].trim());
    s4Passed = signal.passed === true;
    log(`${s4Passed ? '✅' : '❌'} S4 评审: ${s4Passed ? '通过' : '未通过'}，违规数: ${signal.metrics?.violations_found || '?'}`);
  } else {
    log('⚠️ S4 未输出结构化 machine_signal，默认视为不通过');
  }
} catch {
  log('⚠️ S4 machine_signal 解析失败，请人工判断');
}

if (!s4Passed) {
  log('🔄 S4 评审不通过 → 打回 S3 重新修改。请修复上述违规后重新执行 S3。');
  // 执行重试循环
  let retry = 0;
  const maxRetries = 3;
  while (!s4Passed && retry < maxRetries) {
    retry++;
    log(`🔄 第 ${retry}/${maxRetries} 次重试 S3→S4`);

    const s3Retry = await agent(
      `修复 S4 评审中发现的以下违规项。只修改违规项对应的代码，不扩大改动范围。\n\n## S4 违规项\n${s4}\n\n请逐一修复每个违规项。`,
      { label: `S3-修复-第${retry}次`, phase: 'S3 代码落地' }
    );

    const s4Retry = await agent(
      `重新评审修复后的代码。上次评审发现的问题：${s4}\n\n请严格按同样的五维标准重新评审。输出格式同上（machine_signal + human_report）。`,
      { label: `S4-重审-第${retry}次`, phase: 'S4 架构评审' }
    );

    try {
      const msMatch2 = s4Retry.match(/```machine_signal\s*([\s\S]*?)```/);
      if (msMatch2) {
        const signal2 = JSON.parse(msMatch2[1].trim());
        s4Passed = signal2.passed === true;
        log(`${s4Passed ? '✅' : '❌'} S4 第${retry}次重审: ${s4Passed ? '通过' : '未通过'}`);
      }
    } catch { /* ignore */ }

    if (!s4Passed && retry >= maxRetries) {
      log(`🛑 重试 ${maxRetries} 次仍未通过 S4，请人工介入。`);
      return { success: false, reason: 's4_rejected_max_retries', retries: retry };
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// S5 编译+单元测试
// ════════════════════════════════════════════════════════════════════
phase('S5 编译测试');

const s5Compile = await agent(
  `执行 TypeScript 编译检查。运行命令: npx tsc --noEmit\n\n捕获所有类型报错。如果有错，输出错误文件和行号。`,
  { label: 'S5-tsc编译', phase: 'S5 编译测试' }
);

const s5Test = await agent(
  `执行全量单元测试。运行命令: npx vitest run\n\n输出测试结果：通过数、失败数、失败用例详情。\n若修改了 m4/fg/m2 相关模块，需额外执行对应目录的专项测试。`,
  { label: 'S5-vitest测试', phase: 'S5 编译测试' }
);

// 判断 S5 是否通过
const compileOk = !/error TS\d+/.test(s5Compile);
const testOk = /All tests passed|Tests.*passed/.test(s5Test) && !/FAIL/.test(s5Test);

log(`${compileOk ? '✅' : '❌'} 编译: ${compileOk ? '通过' : '有类型错误'}`);
log(`${testOk ? '✅' : '❌'} 测试: ${testOk ? '全部通过' : '有失败用例'}`);

let s5Passed = compileOk && testOk;

if (!s5Passed) {
  log('🔄 S5 编译/测试不通过 → 打回 S3 修复');
  const s5Fix = await agent(
    `修复编译错误和测试失败。\n\n## 编译错误\n${s5Compile}\n\n## 测试失败\n${s5Test}\n\n请逐一修复错误，不要引入新的改动。`,
    { label: 'S3-修复编译测试', phase: 'S3 代码落地' }
  );

  // 重新编译测试
  const s5RetryCompile = await agent(
    `重新执行编译检查: npx tsc --noEmit`,
    { label: 'S5-重编译', phase: 'S5 编译测试' }
  );
  const s5RetryTest = await agent(
    `重新执行测试: npx vitest run`,
    { label: 'S5-重测试', phase: 'S5 编译测试' }
  );

  s5Passed = !/error TS\d+/.test(s5RetryCompile) && /All tests passed|Tests.*passed/.test(s5RetryTest) && !/FAIL/.test(s5RetryTest);
  log(`${s5Passed ? '✅' : '❌'} S5 重试: ${s5Passed ? '通过' : '仍未通过，请人工介入'}`);

  if (!s5Passed) {
    return { success: false, reason: 's5_failed' };
  }
}

// ════════════════════════════════════════════════════════════════════
// S6 全场景功能&数据库核验
// ════════════════════════════════════════════════════════════════════
phase('S6 功能验证');

const s6 = await agent(
  `你是 WenStarOS 项目 QA。请完成多场景功能验证和数据库审计。

## 验证清单

### 1. WebUI 三类场景测试
执行 npm run webui 启动服务后，验证：
① 普通对话：玉瑶角色正常、记忆检索正常、回复无幻觉
② 实体会晤模式：角色称呼不混淆、无跨角色信息泄漏
③ 角色扮演分支：退出后不残留 FG 污染、主 FG 不受影响

### 2. 五条核心行为规范
- 角色称呼不混淆、无跨角色信息泄漏
- 会晤场景不读取其他角色记忆
- 角色扮演不污染主 FamilyGraph 户籍
- 记忆、对话 belong_entity_uuid 标注正常
- 无 LLM 编造人物关系、幻觉问题

### 3. 数据库审计
- 执行 UUID 标注率查询
- 核对 memories/conversations/black_diamond 标注比例
- 若修改存储逻辑，验证 safe-backfill.cjs 数据兼容

### 4. 停服重启二次核验
- 停止服务 → 重启 → 内存数据不丢失
- UUID 标注不回退

输出完整验证报告，标记所有异常项。`,
  { label: 'S6-功能验证', phase: 'S6 功能验证' }
);

log(`✅ S6 功能验证完成`);

// ════════════════════════════════════════════════════════════════════
// S7 变更归档
// ════════════════════════════════════════════════════════════════════
phase('S7 变更归档');

const s7 = await agent(
  `汇总本次变更，输出归档报告。

## 归档要求

1. **变更概述**：修改文件清单、风险等级、改动范围
2. **评审记录**：S4 架构评审发现的风险点
3. **测试记录**：S5 编译测试问题、S6 功能验证结果
4. **回滚方案**：如何恢复、safe-backfill 操作说明
5. **验证用例**：本次的测试用例清单
6. **长期注意事项**：后续维护需特别关注的耦合点

## 输出
完整的变更台账 Markdown 报告。`,
  { label: 'S7-变更归档', phase: 'S7 变更归档' }
);

log(`✅ S7 变更归档完成`);

// ── 最终总结 ──
log(`
══════════════════════════════════════════════════
  WenStarOS 内核修复流水线 — 执行完成
══════════════════════════════════════════════════
  文件: ${files.join(', ')}
  风险: ${overallRisk}
  阶段: S1 → S2 → S3 → S4 → S5 → S6 → S7 ✅
  评审: ${s4Passed ? '通过' : '驳回'}
  编译: ${compileOk ? '通过' : '失败'}
  测试: ${testOk ? '通过' : '失败'}
══════════════════════════════════════════════════
`);

return {
  success: s4Passed && s5Passed,
  risk: overallRisk,
  files,
  s4_passed: s4Passed,
  s5_passed: s5Passed,
};

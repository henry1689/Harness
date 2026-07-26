# Harness 轻量化调度引擎 — 规范文档

> 版本 2.0 | 2026-07-26 | 最后更新：全局规则精简至9条 + 评审升至11维

---

## 一、项目结构

```
wenstar-cc/
├── .claude/
│   ├── settings.json                 ← PreToolUse/PostToolUse Hook 绑定
│   └── workflows/
│       └── wenstaros-core-repair.js  ← S1-S7 Claude Code Workflow 脚本
│
├── src/harness/                      ← TS 引擎源码（14文件，3,149行）
│   ├── types.ts                      ← 全部类型/接口/异常定义
│   ├── FlowEngine.ts                 ← DFA 状态机核心
│   ├── GateController.ts             ← auto/human/condition 三门控
│   ├── StageRunner.ts                ← local/delegate 双 Runner
│   ├── ToolWhitelistGuard.ts         ← 执行层白名单拦截
│   ├── DualChannelSignal.ts          ← machine_signal + human_report 编解码
│   ├── GlobalMemoStore.ts            ← 全局备忘录持久化&注入
│   ├── AuditLogger.ts                ← 12种事件类型审计日志
│   ├── FlowConfigLoader.ts           ← YAML→FlowConfig 解析器
│   ├── RiskClassifier.ts             ← 文件🔴🟡🟢 风险分级
│   ├── NativeCommands.ts             ← tsc/vitest/webui/safe-backfill 封装
│   ├── DelegateReviewer.ts           ← 11维代码评审（S4核心）
│   ├── WenstarOSAdapter.ts           ← 集成桥接层
│   ├── index.ts                      ← 统一导出
│   └── __tests__/                    ← 6 测试文件，66 用例
│       ├── GateController.test.ts
│       ├── ToolWhitelistGuard.test.ts
│       ├── StageRunner.test.ts
│       ├── FlowEngine.test.ts
│       ├── DelegateReviewer.test.ts
│       └── FlowConfigLoader.test.ts
│
├── data/harness/
│   ├── flows/                        ← YAML 流水线配置
│   │   ├── wenstaros_core_repair_flow.yaml
│   │   └── self_guard_flow.yaml
│   ├── memos/                        ← 全局备忘录持久化
│   ├── audit/                        ← 审计日志（按日期分片）
│   │   ├── proposals/                ← 双方案对比归档
│   │   └── YYYY-MM-DD/
│   ├── reports/                      ← S7 变更归档
│   └── docs/                         ← 文档
│       ├── HARNESS-WHITEPAPER.md
│       ├── HARNESS-SPEC.md          ← 本文档
│       └── HARNESS-USAGE.md
```

---

## 二、核心类型定义

> 完整定义见 `src/harness/types.ts`（298 行）

### 2.1 FlowConfig（YAML 映射）

```typescript
interface FlowConfig {
  flow_id: string;                     // 唯一标识
  flow_name: string;                   // 人类可读名称
  version: string;                     // 语义版本号
  max_jump_limit: number;              // 循环熔断阈值（≥1）
  global_memo_key: string;             // 备忘录存储键
  global_arch_constraint: string;      // 10条架构铁律（多行文本）
  global_implementation_rules: string;  // 9条落地规则（多行文本）
  stages: StageConfig[];               // 阶段列表
}
```

### 2.2 StageConfig

```typescript
interface StageConfig {
  stage_id: string;                                      // 如 "S4_Arch_Review"
  stage_name: string;                                    // 人类可读
  work_manual: string;                                   // 工作手册（自动注入铁律+规则）
  tool_whitelist: Partial<Record<WhitelistKey, boolean>>; // 11键白名单
  gate_type: 'auto' | 'human' | 'condition';            // 门控类型
  next_stage?: string;                                   // auto/human 下一阶段
  next_stage_pass?: string;                              // condition 通过时
  next_stage_reject?: string;                            // condition 驳回时
  runner_mode: 'local' | 'delegate';                     // 执行模式
  after_action?: 'inject_global_memo';                   // 后置动作
}
```

### 2.3 FlowRunState（运行时状态）

```typescript
interface FlowRunState {
  run_id: string;                       // 本次运行唯一ID
  flow_id: string;                      // 关联的 flow_id
  flow_status: FlowStatus;              // idle|running|paused|completed|aborted
  current_stage: string;                // 当前所在 stage_id
  jump_count: number;                   // 连续 auto 跳转计数（熔断用）
  stage_results: Map<string, StageResult>;
  global_memo: string;                  // S2 确认后的持久化备忘录
  started_at: string;
  updated_at: string;
  modified_files: string[];             // 本次触发涉及的文件
  risk_level: RiskLevel;                // high|mid|low
  mode: RunMode;                        // pipeline|free
}
```

### 2.4 MachineSignal（结构化判定信号）

```typescript
interface MachineSignal {
  passed: boolean;
  risk_level: 'high' | 'mid' | 'low';
  reject_reason: string[];
  metrics?: {
    files_checked?: number;
    violations_found?: number;
    fg_redlines_touched?: string[];
    uuid_chain_broken?: boolean;
    chat_injection_order_changed?: boolean;
    compile_errors?: number;
    test_failures?: number;
    uuid_label_rate?: number;
  };
}
```

### 2.5 StageOutput（双通道输出）

```typescript
interface StageOutput {
  machine_signal: MachineSignal;   // 引擎消费，不进UI
  human_report: string;            // 用户可见，纯 Markdown
}
```

### 2.6 异常类型

| 异常 | 触发条件 |
|------|---------|
| `WhitelistViolationError` | 操作被白名单 `false` 拒绝 |
| `CircuitBreakerError` | `jump_count >= max_jump_limit` |
| `StageExecutionError` | Stage 执行失败 |
| `FlowConfigError` | YAML 配置字段缺失/无效 |

---

## 三、YAML Schema 规范

### 3.1 必填顶层字段

| 字段 | 类型 | 约束 |
|------|------|------|
| `flow_id` | string | 唯一，kebab-case |
| `flow_name` | string | 非空 |
| `version` | string | 语义版本号 |
| `max_jump_limit` | number | ≥ 1 |
| `stages` | array | 非空，至少1个 stage |

### 3.2 必填 Stage 字段

| 字段 | 类型 | 约束 |
|------|------|------|
| `stage_id` | string | 唯一，全 Flow 内不重复 |
| `stage_name` | string | 非空 |
| `work_manual` | string | 非空，支持 `\|` 多行 |
| `gate_type` | enum | `auto` / `human` / `condition` |
| `runner_mode` | enum | `local` / `delegate` |

### 3.3 gate_type 约束

| gate_type | 额外必填字段 |
|-----------|------------|
| `auto` | `next_stage` |
| `human` | `next_stage` |
| `condition` | `next_stage_pass` + `next_stage_reject` |

### 3.4 白名单键全集

```yaml
read_file: true|false           # 读取文件
write_file: true|false          # 写入/创建文件（含 edit_file, fs.writeFileSync 等）
delete_file: true|false         # 删除文件（含 rm, unlink 等）
run_command: true|false         # 执行命令（含 tsc, vitest, npm 等）
run_db_script: true|false       # 执行数据库脚本
truncate_db: true|false         # 截断/删除数据库数据
run_modify_script: true|false   # 运行修改类脚本（如 safe-backfill）
search_code: true|false         # 搜索代码
grep_import: true|false         # 搜索导入依赖
list_dir: true|false            # 列出目录
run_cli_check: true|false       # 运行 CLI 检查
```

### 3.5 多行文本语法

```yaml
global_arch_constraint: |
  第一行
  第二行

global_implementation_rules: |
  # 1. 规则标题
  规则正文

work_manual: |
  1. 第一步
  2. 第二步
```

**注意**：多行块内不要使用 `# ...` 作为行首，解析器在块外会将其视为注释。

---

## 四、9 条全局落地规则

> 定义文件：`data/harness/flows/wenstaros_core_repair_flow.yaml` → `global_implementation_rules`

| # | 规则名称 | 评审映射维 |
|---|---------|----------|
| 1 | 顶层架构强制对齐铁律 | 一·架构层级 |
| 2 | 变更范围围栏与三级风险管控 | 五·风险兜底 |
| 3 | 上下游依赖全域校验 | 二·FG户籍UUID + 三·耦合点 |
| 4 | 代码与文档双向同步 | 六·文档同步 |
| 5 | 双层代码质量准入（静态质量 + 鲁棒加固） | 八·静态质量 + 九·鲁棒加固 |
| 6 | 共性/个性归类强制核验 | 七·归类真实性 |
| 7 | 全流程审计卷宗永久归档 | AuditLogger |
| 8 | 核心链路Hook侦测与运行态自检 | 十·Hook自检 |
| 9 | LLM全局优化提案弹性机制 | 十一·优化提案落地 |

---

## 五、Gate 决议枚举

所有门控最终输出为统一的 `GateResolution` 字符串：

| 值 | 触发条件 |
|----|---------|
| `auto_passed` | auto gate 无条件 |
| `human_approved` | human gate + 回调返回 'approved' |
| `human_denied` | human gate + 回调返回 'denied' |
| `human_timeout` | human gate 无回调/超时（默认5分钟） |
| `condition_passed` | machine_signal.passed === true |
| `condition_rejected` | machine_signal.passed === false |

---

## 六、审计事件类型

| 事件 | 触发时机 |
|------|---------|
| `flow_start` | FlowEngine.start() |
| `flow_complete` | 最后一阶段 → END |
| `flow_abort` | 异常/用户中止 |
| `stage_enter` | transitionTo() 进入 Stage |
| `stage_exit` | Stage 执行完成 |
| `gate_resolve` | GateController.resolve() |
| `tool_call` | StageRunner 文件/命令操作 |
| `tool_blocked` | ToolWhitelistGuard 拦截 |
| `machine_signal` | delegate runner 返回 signal |
| `memo_injected` | GlobalMemoStore.inject() |
| `circuit_breaker` | 熔断触发 |
| `proposal_archive` | 双方案对比归档 |

---

## 七、白名单操作映射

每个白名单键覆盖多个实际操作名称（大小写不敏感，子串匹配）：

| 白名单键 | 覆盖的操作 |
|---------|-----------|
| `write_file` | write_file, edit_file, create_file, mkdir, fs.writeFileSync, fs.writeFile |
| `delete_file` | delete_file, rm, unlink, rmdir, fs.unlinkSync, fs.rmSync |
| `run_command` | run_command, exec, spawn, execSync, npx, npm, tsc, vitest |
| `truncate_db` | truncate_db, drop_table, delete_from_db, DELETE FROM |
| `run_modify_script` | run_modify_script, safe-backfill, migration, ts-node |

---

## 八、S2 方案强制模板

S2 方案输出必须包含以下两个必填板块，缺一不可：

### 板块一：修改归类

```
【本次修改归类：二选一填写】
□ 共性底层通用修复  → 附横向关联模块清单
□ 个性局部特例修改  → 附无跨角色复用判定依据
```

### 板块二：全局架构优化提案

```
【全局架构优化提案：二选一填写】
□ 形态一：无优化空间 → 明确声明
□ 形态二：存在全局升级空间 → 并行输出：
  - 【原方案隐患评估】
  - 【全局优化替代方案】
  - 【差异对比矩阵】
  - 【用户审批】□ 维持原始方案 □ 采纳全局优化方案
```

---

## 九、测试覆盖

| 测试文件 | 用例数 | 覆盖 |
|---------|--------|------|
| GateController.test.ts | 7 | auto/condition/human 全路径 |
| ToolWhitelistGuard.test.ts | 8 | 激活/拦截/别名/统计/停用 |
| StageRunner.test.ts | 6 | local读写/delegate评审/runCommand |
| FlowEngine.test.ts | 7 | 自由裸奔/全流程/熔断/abort |
| DelegateReviewer.test.ts | 28 | 11维全部 + 文档同步 + 归类 + 静态质量 + 鲁棒 + Hook + 提案 |
| FlowConfigLoader.test.ts | 7 | YAML解析/字段校验/缓存/错误处理/规则关键词 |
| **合计** | **66** | |

编译：`npx tsc --noEmit` — **零类型错误**
测试：`npx vitest run src/harness/__tests__/` — **66/66 通过**

---

## 十、编码规范

1. **TypeScript strict mode** — `tsconfig.json` 已开启
2. **ESM** — 所有 `import`/`export` 使用 ES Module 语法，带 `.js` 扩展名
3. **零外部依赖** — 引擎核心不引入任何第三方 npm 包（Node.js 内置 `fs`/`path`/`child_process` 足够）
4. **命名约定**：
   - 文件名：PascalCase（类文件）、camelCase（纯函数）
   - 类型/接口：PascalCase + 描述性后缀（`Config`, `State`, `Result`, `Output`, `Signal`）
   - 私有字段：`_` 前缀
5. **注释语言**：中文（遵循项目全局规则）

---

## 十一、向后兼容保证

| 保证项 | 说明 |
|--------|------|
| `FlowConfig` 新增字段 | 始终含默认值（`|| ''`），旧 YAML 不受影响 |
| `StageConfig` 新增字段 | 始终 `?.` 可选链，旧 stage 定义不受影响 |
| `AuditEventType` 扩展 | 仅追加新枚举值，不删除/重命名旧值 |
| 白名单键 | 仅追加新键，不删除旧键 |
| 评审维度 | 仅追加新维，不重排/删除已有维的顺序 |

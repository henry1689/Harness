# Harness 轻量化调度引擎 — 白皮书（技术架构文档）

> 版本 2.0 | 2026-07-26 | 适配 WenStarOS TS5.7 Node22

---

## 一、定位与设计哲学

Harness 是一个**零侵入、插拔式、YAML 驱动的通用流水线调度引擎**。 它独立于任何具体项目的业务逻辑，通过确定性有限状态机（DFA）对代码变更实施刚性阶段管控。

**核心命题**：在 AI 辅助编程场景下，LLM 输出的文本不应该能控制流水线的阶段跳转——放行权必须由纯代码逻辑持有。

**三条设计铁律**：

| 铁律 | 含义 |
|------|------|
| 零侵入 | 独立目录，一键开关，关闭后退回原有裸 Agent 循环，不修改项目现有源码 |
| 确定性 | 状态流转由 DFA 纯代码决定，AI 文本输出仅作为 `machine_signal` 输入 Gate，无法干预跳转 |
| 双通道 | 子 Agent 输出 `machine_signal`（引擎消费）+ `human_report`（用户可见），物理隔离互不污染 |

---

## 二、架构全景

```
┌──────────────────────────────────────────────────────────────────┐
│                    .claude/settings.json                         │
│  PreToolUse Hook: 高风险文件 Edit/Write → ask 确认                │
│  PostToolUse Hook: 高风险文件修改后 → 提醒验证                    │
└──────────────────────────┬───────────────────────────────────────┘
                           │ 触发
┌──────────────────────────▼───────────────────────────────────────┐
│           .claude/workflows/wenstaros-core-repair.js             │
│  S1→S2→S3→S4→S5→S6→S7 全流程 Claude Code Workflow              │
└──────────────────────────┬───────────────────────────────────────┘
                           │ 加载 YAML 配置
┌──────────────────────────▼───────────────────────────────────────┐
│         data/harness/flows/wenstaros_core_repair_flow.yaml       │
│  10条架构铁律 + 9条落地规则 + 7阶段定义                            │
└──────────────────────────┬───────────────────────────────────────┘
                           │ 加载 YAML 配置 (TS 运行时)
┌──────────────────────────▼───────────────────────────────────────┐
│                     src/harness/ (TS 引擎)                        │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌─────────────────┐    │
│  │FlowEngine│ │GateControl│ │StageRun. │ │ToolWhitelistGuard│   │
│  │ (DFA核心) │ │(三门控)   │ │(双Runner)│ │(执行层拦截)      │    │
│  └──────────┘ └───────────┘ └──────────┘ └─────────────────┘    │
│  ┌──────────────┐ ┌──────────┐ ┌──────────────────────────────┐  │
│  │AuditLogger   │ │MemoStore │ │FlowConfigLoader (YAML→类型)   │  │
│  │(全流程审计)   │ │(全局备忘录)│ │                              │  │
│  └──────────────┘ └──────────┘ └──────────────────────────────┘  │
│  ┌──────────────┐ ┌──────────┐ ┌──────────────────────────────┐  │
│  │DelegateRev.  │ │RiskClass.│ │WenstarOSAdapter (集成桥接)     │  │
│  │(11维评审)    │ │(文件分级)│ │                              │  │
│  └──────────────┘ └──────────┘ └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**三层分离**：
- **Hook 层**（`.claude/settings.json`）：Claude Code 层面的文件操作拦截，最前置
- **Workflow 层**（`.claude/workflows/`）：Claude Code 多 Agent 编排，S1-S7 全流程
- **Engine 层**（`src/harness/`）：TypeScript 确定性引擎，供 Node.js 运行时或外部系统调用

---

## 三、核心组件

### 3.1 FlowEngine — DFA 状态机核心

`FlowEngine.ts`（411 行）是整个 Harness 的调度中枢。

```
状态 = FlowRunState.current_stage
转移 = determineNextStage(stage, gate_resolution)
       ↑ 纯函数，无副作用，AI 文本无法影响
```

**关键方法**：
- `start(flowFileName, context)` — 加载 YAML，风险评估，启动流水线
- `transitionTo(stageId)` — DFA 跳转核心，不可被外部干预
- `determineNextStage()` — 确定性跳转逻辑（condition gate 分 pass/reject 两支）

**熔断机制**：`jump_count` 累加连续的 `auto` 门控通过，超过 `max_jump_limit` 时触发 `CircuitBreakerError`，暂停流水线。

### 3.2 GateController — 三门控

`GateController.ts`（136 行）实现三种门控：

| 类型 | 行为 | 适用场景 |
|------|------|---------|
| `auto` | 无条件立即放行 | S3 代码落地后 → S4 |
| `human` | 挂起等待回调确认，5分钟超时 | S1 分析完成 / S2 方案定稿 |
| `condition` | 解析 `machine_signal.passed` 决定 pass/reject | S4 评审 / S5 编译测试 / S6 功能验证 |

### 3.3 StageRunner — 双 Runner

`StageRunner.ts`（266 行）支持两种执行模式：

| 模式 | 执行位置 | 白名单状态 | 适用 |
|------|---------|-----------|------|
| `local` | 当前进程 | 激活，每次文件/命令操作前强制 `checkPermission()` | S1/S2/S3/S5/S6/S7 |
| `delegate` | 隔离上下文子 Agent | 只读锁定 | S4 架构评审 |

### 3.4 ToolWhitelistGuard — 执行层拦截

`ToolWhitelistGuard.ts`（193 行）**不依赖 LLM 自觉**，在每个文件读写/命令执行前强制校验：

```
11 个白名单键 × 多操作别名映射：
  write_file → write_file, edit_file, create_file, fs.writeFileSync...
  delete_file → delete_file, rm, unlink, fs.unlinkSync...
  truncate_db → truncate_db, drop_table, DELETE FROM...
```

白名单在 `StageRunner` 调用层执行，即使 LLM 输出了 `write_file` 指令，`checkPermission()` 直接 `throw WhitelistViolationError`。

### 3.5 DelegateReviewer — 11维代码评审

`DelegateReviewer.ts`（970 行）是 Harness 最大的单文件。S4 阶段委托独立子 Agent 执行，输出双通道信号。

**11维校验全景**（映射新9条规则）：

| 维 | 名称 | 对应规则 | 说明 |
|----|------|---------|------|
| 1 | 架构层级校验 | 规则1 | M1-M9无循环依赖、chat.ts薄调度层、PFC门控 |
| 2 | FG户籍&UUID专项 | 规则3 | 上下游依赖、角色隔离、四层标注 |
| 3 | 耦合点专项 | 规则3 | 22段注入链路、12处_meetingEntityName、双管线同步 |
| 4 | 持久化安全 | 规则5第二层 | save()防抖、事务回滚、只增不删 |
| 5 | 风险兜底 | 规则2 | 变更范围管控、import依赖评估、硬编码检测 |
| 6 | 文档同步 | 规则4 | 白皮书+蓝皮书双向同步 |
| 7 | 归类真实性 | 规则6 | 共性底层 vs 个性特例二选一 |
| 8 | 静态质量 | 规则5第一层 | tsc编译、类型合规、死代码、编码规范 |
| 9 | 鲁棒加固 | 规则5第二层 | 容错兜底、边界防护、自校验逻辑 |
| 10 | Hook自检 | 规则8 | 九大核心链路侦测 + 六级全景体检 |
| 11 | 优化提案落地 | 规则9 | 方案一致性核验、审计归档 |

### 3.6 AuditLogger — 全流程审计

`AuditLogger.ts`（393 行）记录 12 种审计事件类型，按日期分片持久化为 JSON。支持后续复盘、回放。

**容量管控**：5MB 单文件告警、30 天自动清理、10,000 条内存上限。

### 3.7 其他关键模块

| 模块 | 行数 | 职责 |
|------|------|------|
| `FlowConfigLoader` | 401 | YAML 行解析→FlowConfig，零外部依赖 |
| `GlobalMemoStore` | 151 | S2 方案持久化，每 Stage 自动注入 |
| `RiskClassifier` | 156 | 6 个高风险精确匹配 + 14 个中风险正则 + 低风险前缀 |
| `DualChannelSignal` | 166 | machine_signal ↔ human_report 编解码 |
| `NativeCommands` | 166 | tsc/vitest/webui/safe-backfill 原生命令封装 |
| `WenstarOSAdapter` | 353 | 对接 PFC 前额叶，环境变量开关，SelfGuard 路由 |

---

## 四、数据流全景

```
用户消息
  │
  ▼
WenstarOSAdapter.shouldTriggerPipeline(msg)
  │ (匹配内核修改意图)
  ▼
RiskClassifier.classifyFiles(files)
  │
  ├─ 🟢低风险 + 微小修改 → 自由裸奔模式（跳过流水线）
  │
  └─ 🔴🟡高中风险 → 强制流水线
       │
       ▼
  FlowEngine.start(flowFile, context)
       │
       ├─ FlowConfigLoader.load() → FlowConfig
       ├─ GlobalMemoStore 初始化
       ├─ AuditLogger 初始化
       │
       ▼
  transitionTo(S1)  ← DFA 循环
       │
       ├─ GlobalMemoStore.inject(workManual)  ← 注入架构铁律+落地规则
       ├─ ToolWhitelistGuard.activate(stage.tool_whitelist)
       ├─ AuditLogger.logStageEntry()
       ├─ StageRunner.execute(stage, state)
       │     ├─ local → 本机执行（白名单管控）
       │     └─ delegate → DelegateReviewer.review() → 双通道信号
       ├─ GateController.resolve(stage, result)  → GateResolution
       ├─ AuditLogger.logGateResolve()
       ├─ jump_count 熔断检查
       ├─ after_action (inject_global_memo)
       ├─ ToolWhitelistGuard.deactivate()
       └─ determineNextStage(stage, resolution) → 下一 S 或 END
```

---

## 五、YAML 配置体系

Harness 的流程定义完全由 YAML 驱动，不硬编码任何阶段规则。

### 5.1 Flow 级配置

```yaml
flow_id: wenstaros_core_repair_flow
flow_name: WenStarOS TS内核缺陷修复&架构重构流水线
version: 2.0
max_jump_limit: 10                                 # 循环熔断阈值
global_memo_key: wenstaros_arch_global_constraint  # 备忘录存储键
global_arch_constraint: |                           # 10条架构铁律
global_implementation_rules: |                      # 9条落地规则
stages: [...]                                       # 7个阶段定义
```

### 5.2 Stage 级配置

```yaml
- stage_id: S4_Arch_Review
  stage_name: 委托独立专家架构&代码合规评审
  work_manual: |               # 工作手册（自动注入铁律+规则）
  tool_whitelist:              # 白名单键值对
    read_file: true
    write_file: false
  gate_type: condition         # auto | human | condition
  next_stage_pass: S5_Compile_Test
  next_stage_reject: S3_Code_Implement
  runner_mode: delegate        # local | delegate
```

### 5.3 规则优先级

```
白皮书/蓝皮书核心架构铁律 (global_arch_constraint)
  >  全局落地规则 (global_implementation_rules)
    >  Stage 级 work_manual
      >  单次对话临时口头指令
```

---

## 六、双通道信号机制

### 6.1 隔离原理

```
子 Agent 输出
  ├─ machine_signal  →  JSON 结构化 →  GateController 解析 → 条件判定
  └─ human_report    →  Markdown 文本 →  直接展示给用户
                         ↑ 绝不包含 machine_signal 数据
```

### 6.2 machine_signal 结构

```typescript
{
  "passed": false,
  "risk_level": "high",
  "reject_reason": ["违反FG红线3: 角色扮演数据泄漏"],
  "metrics": {
    "files_checked": 3,
    "violations_found": 12,
    "fg_redlines_touched": ["1", "3", "6"],
    "uuid_chain_broken": false,
    "chat_injection_order_changed": true
  }
}
```

### 6.3 human_report 格式

纯 Markdown，结构化展示违规项、风险评估、整改建议。不包含任何可供 Gate 消费的结构化数据。

---

## 七、Claude Code 集成层

### 7.1 settings.json Hook 体系

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Edit",     // 或 Write
      "hooks": [{ "type": "command", "command": "node -e '...'" }]
    }]
  }
}
```

高风险文件（chat.ts / FamilyGraph.ts / SQLiteAdapter.ts 等）的 Edit/Write 操作 → `decision: "ask"` 拦截确认。

### 7.2 Workflow 脚本

`.claude/workflows/wenstaros-core-repair.js` — 使用 `agent()` / `phase()` / `log()` 编排 S1-S7 全流程。

S4 评审不通过 → 自动打回 S3，最多重试 3 次。S5 编译/测试不通过 → 自动打回 S3 修复。

---

## 八、现有 Flow 清单

| Flow ID | 文件 | 用途 |
|---------|------|------|
| `wenstaros_core_repair_flow` | `wenstaros_core_repair_flow.yaml` | WenStarOS TS内核修改 S1-S7 刚性管控 |
| `self_guard_flow` | `self_guard_flow.yaml` | Harness 自身基础设施自护流水线（规划中） |

---

## 九、关键设计决策

| 决策 | 理由 |
|------|------|
| DFA 纯代码状态机，不用 XState | 简单优先，50行自实现比引入状态机库更可控 |
| YAML 行解析，不用 js-yaml | 零外部依赖，配置结构简单可控 |
| 白名单在执行层 `StageRunner` 拦截 | 不依赖 LLM 自觉，代码层强制拒绝 |
| `machine_signal` / `human_report` 独立字段 | 物理隔离，防止 AI 输出混淆判定信号 |
| `max_jump_limit` 循环熔断 | 防止 auto gate 连续跳转无限空转 |
| `WS_HARNESS_ENABLED` 环境变量开关 | 关闭后零开销，完全退回原有 Agent 循环 |
| 独立 `src/harness/` 目录 | 不改动项目现有任何源码，插拔式 |

---

## 十、扩展路线

### 短期（已有基础）
- 新增更多业务 YAML flow（户籍档案整编、知识库健康体检、数据库迁移审计）
- SelfGuard 引擎完善（Harness 自身基础设施变更管控）

### 中期
- ReactFlow 拖拽可视化前端（Stage 编排 → 生成 YAML）
- WebUI 人工审批面板（human gate 实时交互）
- 审计日志查询与回放界面

### 长期
- 做成通用软件研发流程平台，仅新增前端配置层，引擎核心无需改动
- 跨项目 Flow 模板市场

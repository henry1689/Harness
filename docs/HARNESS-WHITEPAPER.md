# Harness — AI Agent 代码修改强制监管系统 · 设计白皮书 v3.0

> **Harness 是这台机器上所有 AI Agent 的宪法。不是建议，不是参考，不是"视情况而定"。**

---

## 目录

1. [设计哲学与核心理念](#1-设计哲学与核心理念)
2. [系统架构全景](#2-系统架构全景)
3. [S1→S7 刚性流水线](#3-s1s7-刚性流水线)
4. [三道物理防线：MCP 闸门 + Sentinel 哨兵 + Git Hook](#4-三道物理防线)
5. [23 条设计标准合规评分体系](#5-23-条设计标准合规评分体系)
6. [自进化引擎](#6-自进化引擎)
7. [通讯与信号机制全览](#7-通讯与信号机制全览)
8. [Agent 逃逸检测与防绕过多层加固](#8-agent-逃逸检测与防绕过多层加固)
9. [进程守护与高可用](#9-进程守护与高可用)
10. [安全攻击面分析](#10-安全攻击面分析)
11. [当前局限与专家建议邀请](#11-当前局限与专家建议邀请)

---

## 1. 设计哲学与核心理念

### 1.1 根本问题

AI Agent（Claude Code / Codex / Copilot）在修改代码时存在天然缺陷：

| 缺陷 | 表现 |
|------|------|
| **局部视野** | 只看到报错文件和堆栈，不感知全局 import 依赖和上下游调用连 |
| **补丁倾向** | 遇到问题就加 `if/else` 分支条件静默处理，堆砌技术债务 |
| **无架构感知** | 不明白 10 条架构铁律、UUID 四层标注、FG 角色隔离红线 |
| **可绕过性** | Bash 脚本绕过所有检查写文件、直接 Edit/Write 无闸门 |
| **无记忆** | 每次开新会话就忘掉历史规则，反复犯同类错误 |

**Sentinel 哨兵的统计数据证实了这一点：** 2026-08-02 单日发生了 **32 次成功回滚 + 101 次拦截错误**，被攻击最多的文件是 `KnowledgeContextBuilder.ts`（11 次）、`chat.ts`（10 次）、`DeepSeekLLMProvider.ts`（9 次）。

### 1.2 设计原则

```
原则 1: 规则不由 AI 执行，由代码执行
        → AI 输出的文本无法干预闸门跳转——跳转由 DFA 状态机纯代码逻辑决定

原则 2: 防守纵深，不依赖单点
        → 3 道独立防线 (MCP闸门→Sentinel哨兵→Git Hook)
        → 每道防线独立运作，任一存活即阻断

原则 3: 被动→主动→进化
        → 不满足于事后回滚，持续从拦截日志中提炼规则升级 YAML

原则 4: 运动员不自审
        → S4 架构评审由 delegate 独立子 Agent 执行
        → 修改代码的 Agent 永远不给自己打分

原则 5: 零信任
        → 默认所有 Agent 操作都是未授权的
        → 只有通过完整 S1→S7 流水线签发的令牌才放行
```

### 1.3 硬度阶梯

```
L1 轻量化 ──→ L2 自适应 ──→ L3 跨项目 ──→ L4 自主进化
 (当前)        (进行中)       (规划中)       (愿景)
```

当前的 Harness v3.0 处于 **L1→L2 过渡期**：已具备自进化引擎（L2 核心能力），但升级仍依赖人工审批。

---

## 2. 系统架构全景

```
┌─────────────────────────────────────────────────────────────────┐
│                     HARNESS v3.0 全架构                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │  MCP Server  │    │  Sentinel    │    │   Git Hook       │  │
│  │  (闸门)      │    │  (哨兵)      │    │   (最后防线)     │  │
│  │  :8765       │    │  fs 文件监控 │    │   pre-commit     │  │
│  └──────┬───────┘    └──────┬───────┘    └────────┬─────────┘  │
│         │                   │                     │             │
│    ┌────▼───────────────────▼─────────────────────▼────────┐   │
│    │                   PM2 进程守护                        │   │
│    │  • 崩溃自动重启（指数退避 1s→32s）                    │   │
│    │  • 开机自启（Windows Startup 文件夹）                  │   │
│    │  • 健康检查 (health-check.cjs 每 30s)                 │   │
│    └──────────────────────────────────────────────────────┘   │
│                              │                                  │
│  ┌───────────────────────────▼────────────────────────────┐   │
│  │              FlowEngine — DFA 状态机                    │   │
│  │                                                        │   │
│  │  S1 ──→ S2 ──→ S3 ──→ S4 ──→ S4.5 ──→ S5 ──→ S6 ──→ S7 │
│  │  auto  human  cond  delegate cond   cond  cond   auto   │   │
│  │                                                        │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │ GateController│  │ StageRunner  │  │ AuditLogger  │  │   │
│  │  │ (门控判定)    │  │ (dual runner) │  │ (审计归档)   │  │   │
│  │  └─────────────┘  └──────────────┘  └──────────────┘  │   │
│  └───────────────────────────────────────────────────────┘   │
│                              │                                  │
│  ┌───────────────────────────▼────────────────────────────┐   │
│  │              知识/配置层                                │   │
│  │                                                        │   │
│  │  wenstaros_core_repair_flow.yaml  ← 流水线配置          │   │
│  │  23 Design Standards (DS-01~DS-23) ← 评分标准           │   │
│  │  11 CK Checks (CK-00~CK-10)        ← 硬校验脚本         │   │
│  │  EvolutionEngine                    ← 自进化引擎         │   │
│  │  HardnessLadder                     ← 硬度阶梯           │   │
│  └───────────────────────────────────────────────────────┘   │
│                              │                                  │
│  ┌───────────────────────────▼────────────────────────────┐   │
│  │              被管制项目                                  │   │
│  │                                                        │   │
│  │  D:\tools\wenstar-cc    ← 文曲星·玉瑶·太虚境 (TS)      │   │
│  │  D:\wenstar\wenstar_os  ← 文曲星 OS (Python)            │   │
│  │  (其他项目按 CLAUDE.md 声明管辖)                         │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.1 模块清单

| 模块 | 文件 | 行数 | 职责 |
|------|------|:--:|------|
| **FlowEngine** | `src/FlowEngine.ts` | 546 | DFA 状态机核心——确定性跳转、熔断、回流计数器 |
| **StageRunner** | `src/StageRunner.ts` | 302 | 双 Runner 模式：local（本机）和 delegate（子 Agent） |
| **GateController** | `src/GateController.ts` | 137 | 三门控控制器：auto/human/condition |
| **FlowConfigLoader** | `src/FlowConfigLoader.ts` | ~80 | YAML 流水线配置加载 |
| **GlobalMemoStore** | `src/GlobalMemoStore.ts` | ~100 | S2 方案全阶段强制注入 |
| **AuditLogger** | `src/AuditLogger.ts` | ~150 | 全流程审计日志持久化 |
| **ToolWhitelistGuard** | `src/ToolWhitelistGuard.ts` | ~60 | 每阶段工具白名单动态激活/停用 |
| **RulesLazyLoader** | `src/RulesLazyLoader.ts` | ~120 | Token 降耗——精简规则上下文注入 |
| **ComplianceScorer** | `src/ComplianceScorer.ts` | ~250 | 23 条标准加权合规评分 |
| **ConvergenceGate** | `src/ConvergenceGate.ts` | ~200 | S4.5 收敛闸门——逐轮打分、差距分析、趋势报告 |
| **DualChannelSignal** | `src/DualChannelSignal.ts` | ~80 | 双通道信号：machine_signal + human_report |
| **DesignStandards** | `src/DesignStandards.ts` | 323 | DS-01~DS-23 结构化定义 |
| **DelegateReviewer** | `src/DelegateReviewer.ts` | ~300 | S4 架构评审（11 维度违规检测） |
| **RiskClassifier** | `src/RiskClassifier.ts` | ~60 | 文件风险三级分类 |
| **main_harness_checker** | `src/main_harness_checker.ts` | ~1500 | CK-00~CK-10 硬校验脚本 |
| **EvolutionEngine** | `src/EvolutionEngine.ts` | ~750 | 自进化引擎：7 种违规模式检测→规则升级建议 |
| **HardnessLadder** | `src/HardnessLadder.ts` | ~240 | L1→L4 硬度评估与升级判定 |
| **types** | `src/types.ts` | 428 | 核心类型系统 |
| **MCP Server** | `mcp/server.ts` | ~560 | Streamable HTTP MCP 服务 + 哨兵 REST 端点 |
| **Sentinel Service** | `sentinel/sentinel-service.cjs` | 272 | 哨兵主进程：批量检测、令牌检查、回滚调度 |
| **Sentinel Watcher** | `sentinel/watcher.cjs` | 186 | 文件系统监控：fs.watch + 轮询双模式 |
| **Sentinel Rollback** | `sentinel/rollback.cjs` | ~120 | Git 回滚 + 锁竞争重试（指数退避） |
| **Sentinel Escalation** | `sentinel/escalation.cjs` | 343 | L0→L3 升级链：attrib +R 文件锁定 |
| **Sentinel MCP Client** | `sentinel/sentinel-mcp-client.cjs` | 206 | HTTP 令牌检查客户端 |

---

## 3. S1→S7 刚性流水线

### 3.1 DFA 状态机

流水线由 **确定性有限状态机（DFA）** 驱动。AI 输出的任何文本都无法改变跳转目标——跳转由 `FlowEngine.determineNextStage()` 纯代码逻辑计算。

```
stateDiagram-v2
    [*] --> S1_Problem_Analysis
    S1_Problem_Analysis --> S2_Solution_Design : auto_passed
    S2_Solution_Design --> S3_Code_Implement : human_approved
    S2_Solution_Design --> [*] : human_timeout/denied
    S3_Code_Implement --> S4_Arch_Review : condition_passed
    S3_Code_Implement --> S3_Code_Implement : condition_rejected
    S4_Arch_Review --> S4.5_Convergence_Gate : auto_passed
    S4.5_Convergence_Gate --> S5_Compile_Test : condition_passed
    S4.5_Convergence_Gate --> S3_Code_Implement : condition_rejected
    S5_Compile_Test --> S6_Function_Verify : condition_passed
    S5_Compile_Test --> S3_Code_Implement : condition_rejected
    S6_Function_Verify --> S7_Change_Archive : condition_passed
    S6_Function_Verify --> S3_Code_Implement : condition_rejected
    S7_Change_Archive --> [*] : auto_passed
```

### 3.2 八个阶段详表

| 阶段 | 名称 | 门控 | 执行模式 | 核心动作 |
|------|------|:--:|:--:|------|
| **S1** | 问题定位 & 牵连风险盘点 | auto | local | 只读锁死，禁止写代码。输出全量 import 牵连清单 + 6 大耦合点检测 + FG 11 条红线触碰判定表 |
| **S2** | 方案定稿 & 架构合规校验 | human | local | 唯一人工终审节点。二选一归类（共性/个性）+ 全局架构优化提案。MCP headless 模式自动批准 |
| **S3** | 代码落地 | condition | local | 增量 diff 修改。禁止整文件重写。前置自检：tsc 编译 + 补丁自检 |
| **S4** | 架构铁律硬校验 | auto | delegate | 本地脚本对 CK-01~CK-07 硬校验 + 11 维度子 Agent 语义评审。**运动员不自审** |
| **S4.5** | 设计标准合规收敛 | condition | delegate | 23 条标准逐条打分。任一条 < 满分 → 驳回 S3。收敛趋势跟踪。恶化中止 |
| **S5** | 编译 & 单元测试 | condition | local | tsc --noEmit + vitest run + CK-08 补丁嗅探。单函数 ≥2 个新 if 分支标记为疑似补丁 |
| **S6** | 功能验证 & 数据库审计 | condition | local | CK-09 回归安全 + CK-10 意图达成 + 持久化落盘检索 |
| **S7** | 变更归档 & 流程闭环 | auto | local | 汇总所有修改、风险、评审结果，写入变更台账 |

### 3.3 熔断与回流保护

| 保护机制 | 阈值 | 触发行为 |
|----------|:--:|------|
| 连续 auto 跳转熔断 | 10 次 | 流水线中止（防止无限空转） |
| 通用阶段回流上限 | 5 次 | 强制锁定（非 S3 阶段） |
| S3 专属驳回回流 | 6 次 | 强制锁定（S4/S5/S6→S3） |
| 恶化中止 | 分数下降 >3 分 | 立即中止（"越改越差"） |
| 收敛自动转交 | 第 3 轮未达标 | 转用户决策（不再自动驳回） |

---

## 4. 三道物理防线

### 4.1 防线一：MCP Server（闸门）

**端口：** `127.0.0.1:8765`
**协议：** Streamable HTTP (MCP 标准)
**模式：** 无状态（stateless），每个请求独立处理

#### 注册的 MCP 工具

| 工具名 | 功能 | 输入 |
|--------|------|------|
| `harness_pre_check` | 路径保护区检查 | file path |
| `harness_run_flow` | **触发 S1→S7 流水线** | flow_name, files[], message, risk_level |
| `harness_list_flows` | 列出可用流水线 | — |
| `harness_evolution_status` | 自进化引擎状态 | — |
| `harness_evolution_analyze` | 手动触发分析 | — |
| `harness_evolution_report` | 导出进化报告 | — |

#### 哨兵专用 REST 端点

```
POST /sentinel/check
Body: { "file": "src/webui/chat.ts", "project": "wenstar-cc" }
Response: { allowed: boolean, risk: "high|mid|low", reason: "...", tokenFound: boolean }
```

**令牌生命周期：**
```
签发: S7 完成后 → 写入 D:\AI文件\harness\data\tokens\<hash>.json
有效期: 2 小时
消费: Git pre-commit hook 一次性消费（consumed: true）
过期: Sentinel 检测到过期 → 自动删除令牌文件
```

### 4.2 防线二：Sentinel（哨兵）

**工作原理：**

```
文件变更检测 (fs.watch + 800ms 轮询双模式)
    │
    ▼
批次聚合 (500ms 窗口去重，防脚本批量篡改)
    │
    ▼
令牌检查 (HTTP /sentinel/check → 本地令牌文件)
    ├─ 令牌有效 → 放行 + 审计日志
    └─ 无令牌 → Git checkout 回滚 + 升级判定
```

**升级梯次（同一文件 30 分钟内）：**

| 等级 | 次数 | 动作 |
|:--:|:--:|------|
| L0 | 1-2 | 仅回滚 + 日志 |
| L1 | 3 | **attrib +R 物理锁定文件（只读）** |
| L2 | 5 | 锁定 + 写 `.claude/SENTINEL_ACTIVE.md` 告示牌 |
| L3 | 8 | 锁定 + 持续写告示牌 + 系统通知 |

**自动解锁：** 2 小时后 CooldownTimer 自动恢复可写

### 4.3 防线三：Git Pre-commit Hook

**文件：** `.git/hooks/pre-commit` → 调用 `harness-gate.cjs`

**检查逻辑：**
```
git diff --cached --name-only
    → 筛选高风险文件 (src/webui/chat.ts, src/m4/, src/m5/, src/m2/, src/engine/...)
    → 检查 D:\AI文件\harness\data\tokens\ 中的令牌
    → 无令牌 → 拒绝提交 + 显示 MCP 调用指引
    → 有令牌 → 消费令牌（consumed: true）+ 放行提交
```

---

## 5. 23 条设计标准合规评分体系

### 5.1 标准分布

| 类别 | 编号 | 数量 | 总权重 |
|------|------|:--:|:--:|
| 架构铁律 | DS-01 ~ DS-10 | 10 条 | 61 |
| 落地规则（基础） | DS-11 ~ DS-19 | 9 条 | 41 |
| 落地规则（增强） | DS-20 ~ DS-23 | 4 条 | 26 |
| **合计** | **DS-01 ~ DS-23** | **23 条** | **128** |

### 5.2 评分流程

```
CK-01~CK-10 本地硬校验结果
    +
S4 DelegateReviewer 11 维度违规清单
    +
S2 方案中的归类声明
    ↓
ComplianceScorer 逐条映射
    ↓
每条标准 0-100 分 → 加权总分
    ↓
ConvergenceGate 决策
```

### 5.3 CK 硬校验清单

| CK | 名称 | 类型 |
|----|------|:--:|
| CK-00 | S1 全局审视——import 牵连清单 + 6 大耦合点 + FG 红线表 | 阻门 |
| CK-01 | M1-M9 九层管线依赖检查 | 硬校验 |
| CK-02 | PFC 薄调度检查 | 硬校验 |
| CK-03 | FG 户籍规范检查 | 硬校验 |
| CK-04 | UUID 全链路标注检查 | 硬校验 |
| CK-05 | 12 处 _meetingEntityName 核验 | 硬校验 |
| CK-06 | SQLite save() 调用检查 | 硬校验 |
| CK-06.5 | **举一反三——全仓库同类模式扫描** | 阻门 |
| CK-07 | 高风险依赖扫描 | 硬校验 |
| CK-08 | AST if 分支补丁嗅探 | 软检测 |
| CK-09 | **回归安全——改动范围精确匹配** | 阻门 |
| CK-10 | **意图达成——验证修改是否达到目的** | 阻门 |

### 5.4 权重最高标准（Top 5）

| 标准 | 权重 | 含义 |
|------|:--:|------|
| DS-01 | 8 | M1-M9 九层管线——架构根基 |
| DS-03 | 8 | FG 户籍隔离——数据安全底线 |
| DS-21 | 8 | 修改目的达成度——最终目标 |
| DS-02 | 7 | PFC 薄调度——架构清晰度 |
| DS-04 | 7 | UUID 四层标注——跨层溯源能力 |
| DS-06 | 7 | 12 处会晤点位——角色隔离执行层 |
| DS-15 | 7 | 双层质量准入——代码质量底线 |
| DS-23 | 7 | 举一反三——消除补丁文化 |

---

## 6. 自进化引擎

### 6.1 架构

```
EvolutionEngine (独立线程)
│
├── 60s 间隔：增量扫描 (incrementalScan)
│   └── 读取 data/sentinel/ 和 data/audit/ 的新事件
│       └── 维护内存事件缓冲区 (2000 条上限)
│
├── 1h 间隔：全量分析 (fullAnalysis)
│   └── 7 种违规模式检测
│       └── 凝练规则 → RuleUpgrade 建议
│
└── HardnessLadder：评估是否满足 L1→L2→L3→L4 升级条件
```

### 6.2 七种违规模式检测

| 模式 | 检测逻辑 | 输出 |
|------|------|------|
| **cluster_attack** | 500ms 窗口内 ≥3 个文件同时被 Sentinel 拦截 | 升级为批量攻击风险 |
| **repeat_offender** | 同一文件 30min 内被拦截 ≥3 次 | 建议提升风险等级 |
| **git_contention** | Sentinel 回滚时遇到 git index.lock | 建议增加回滚重试 |
| **bash_script** | 审计日志中检测 Bash 操作模式 | 建议加入 blocklist |
| **new_violation_type** | 识别未在现有规则中的违规 | 建议新增 DS 标准或 CK 检查 |
| **convergence_bottleneck** | S4.5 某条标准连续 ≥3 轮未达标 | 建议调整权重或增加专项检查 |
| **bypass_abuse** | Sentinel 拦截后文件仍被反复修改 | 触发 escalation 升级 |

### 6.3 规则凝练映射

| 模式 | 可凝练为 | 目标 |
|------|------|------|
| cluster_attack | `add_yaml_rule` | 新增批量攻击防护规则 |
| repeat_offender | `risk_upgrade` | 提升文件风险等级 |
| new_violation_type | `add_ck_check` / `add_design_standard` | 扩展检测覆盖 |
| convergence_bottleneck | `weight_adjust` / `add_ck_check` | 优化评分权重 |
| bypass_abuse | `add_blocklist_rule` / `modify_yaml_stage` | 强化 YAML 配置 |

### 6.4 硬度阶梯评估

```
L1 轻量化: Sentinel 事件 < 100/天, 无 bypass_abuse, 收敛 ≤ 2 轮
L2 自适应: 自进化引擎活跃, ≥ 3 条自动规则升级, human干预率 < 30%
L3 跨项目: 管理 ≥ 3 个项目, 所有项目 < 10 violations/天
L4 自主进化: 自动规则升级 ≥ 10 条, human干预率 < 5%, 0 bypass_abuse
```

---

## 7. 通讯与信号机制全览

### 7.1 五条独立通讯通道

```
通道 1: MCP JSON-RPC (Streamable HTTP)
        ┌──────────┐                    ┌──────────┐
        │ Agent    │ harness_run_flow   │ MCP      │
        │ (Claude) │ ◄──────────────────▶│ Server   │
        └──────────┘                    └──────────┘
        用途: 触发流水线、查询进化状态

通道 2: Sentinel REST API
        ┌──────────┐  POST /sentinel/check  ┌──────────┐
        │ Sentinel │ ◄──────────────────────▶│ MCP      │
        │ Service  │                         │ Server   │
        └──────────┘                         └──────────┘
        用途: 令牌验证、风险分类

通道 3: 文件系统令牌
        ┌──────────┐  read/write .json       ┌──────────┐
        │ MCP      │ ◄──────────────────────▶│ Disk     │
        │ Server   │                         │ (tokens/) │
        │ Sentinel │                         │          │
        │ Git Hook │                         │          │
        └──────────┘                         └──────────┘
        用途: 令牌签发、验证、消费（跨进程共享）

通道 4: 心跳文件
        ┌──────────┐  每 5s 写 heartbeat.json ┌──────────┐
        │ MCP      │ ◄────────────────────────▶│ Disk     │
        │ Server   │                           │ (data/)   │
        └──────────┘                           └──────────┘
        用途: 健康检查（PM2 watchdog 每 30s 读取）

通道 5: Git Hook (进程间)
        ┌──────────┐  git commit → hook       ┌──────────┐
        │ Git      │ ◄───────────────────────▶│ Node.js  │
        │          │                          │ harness-  │
        │          │                          │ gate.cjs  │
        └──────────┘                          └──────────┘
        用途: 提交前令牌强制校验
```

### 7.2 双通道信号体系

Delegate Runner 模式（S4 / S4.5）的子 Agent 必须输出**双通道信号**：

```
StageOutput {
  machine_signal: MachineSignal   ← 引擎消费（不进用户界面）
    ├─ passed: boolean
    ├─ risk_level: "high" | "mid" | "low"
    ├─ reject_reason: string[]
    └─ metrics: { compliance_score, convergence_round, ... }

  human_report: string            ← 用户消费（展示给人类）
}
```

**物理隔离保证：** `machine_signal` 数据流和 `human_report` 文本流完全分离。AI 无法通过在 human_report 中写特定文本来改变 `machine_signal.passed` 的值。

---

## 8. Agent 逃逸检测与防绕过多层加固

### 8.1 已知逃逸路径及防护

| 逃逸路径 | 风险描述 | 防护措施 | 状态 |
|------|------|------|:--:|
| **Bash 脚本写文件** | `npx tsx scripts/patch.ts` 直接写源码 | Sentinel 文件监控 + CLAUDE.md 明确禁止 | ✅ |
| **Edit/Write 绕过 MCP** | VSCode 中直接 Edit/Write 不改 MCP | Sentinel 令牌检查 + pre-commit hook | ✅ |
| **ESM require 注入** | Node.js eval 绕过文件系统 | ToolWhitelistGuard 按阶段限制 | ✅ |
| **MCP 进程 kill 掉** | 干掉 MCP → 令牌签发停摆 | PM2 自动重启 + 健康检查 | ✅ |
| **Sentinel 进程 kill 掉** | 干掉 Sentinel → 无监测 | PM2 自动重启 | ✅ |
| **令牌伪造** | 手写 JSON 令牌文件 | UUID 校验（caller_uuid） | ✅ |
| **令牌盗用** | 拿到令牌后改其他文件 | 令牌按文件 hash 绑定，一个令牌只对一个文件 | ✅ |
| **跨会话规则退化** | 压缩后 Harness 规则丢失 | 压缩后第一件事重读 CLAUDE.md 规则 | ⚠️ |
| **Git hook 删除** | `rm .git/hooks/pre-commit` | 定期健康检查 + Sentinel 监控 `.git/hooks/` | ⚠️ |
| **硬编码 IP 端口攻击** | 直接往 127.0.0.1:8765 发恶意请求 | MCP 工具参数 z.string()/z.array() 严格校验 | ✅ |

### 8.2 加固层次总览

```
Layer 0: CLAUDE.md 规则声明（文本约束，最易绕过）
    ↓
Layer 1: ToolWhitelistGuard（按阶段动态激活，限制 Agent 可用工具）
    ↓
Layer 2: MCP harne​ss_run_flow（DFA 状态机，AI 文本无法干预跳转）
    ↓
Layer 3: Sentinel 哨兵（fs.watch 文件监控 + Git 回滚，物理不可绕过）
    ↓
Layer 4: Escalation L1-L3（attrib +R 只读锁 + 告示牌，物理阻止修改）
    ↓
Layer 5: Git pre-commit hook（提交前令牌强制校验，最后防线）
    ↓
Layer 6: PM2 进程守护（MCP/Sentinel 崩溃自动恢复，保持防线存活）
```

---

## 9. 进程守护与高可用

### 9.1 PM2 配置

```javascript
// ecosystem.config.cjs
{
  apps: [
    {
      name: 'harness-mcp',
      script: 'mcp/start.cjs',
      autorestart: true,        // 崩溃自动重启
      max_restarts: 3,          // 15s 内最多 3 次（防死循环）
      restart_delay: 2000,      // 重启间隔 2s
    },
    {
      name: 'harness-sentinel',
      script: 'sentinel/sentinel-service.cjs',
      autorestart: true,
      max_restarts: 3,
      restart_delay: 2000,
    }
  ]
}
```

### 9.2 开机自启

双重保障：
1. **Windows Startup 文件夹** — `HarnessPM2.bat` 在用户登录时自动 `pm2 resurrect`
2. **备选 Task Scheduler** — `register-startup.ps1`（需管理员权限）

### 9.3 杀死恢复验证

```
实测: taskkill MCP 子进程 (PID 46668)
结果: 6 秒后 PM2 自动启动新进程 (PID 17200)
     端口 8765 恢复监听
     /sentinel/check 正常响应
     S1→S7 完整流水线正常通过
```

---

## 10. 安全攻击面分析

### 10.1 攻击面清单

| 攻击面 | 向量 | 当前防护 | 残余风险 |
|--------|------|------|:--:|
| MCP 端口 | DoS 洪水攻击 127.0.0.1:8765 | 仅监听 localhost | 低 |
| 令牌文件 | 伪造/篡改 `data/tokens/*.json` | UUID 校验 | 中（本地文件可被root/admin修改） |
| Sentinel 进程 | SIGKILL 强杀 | PM2 自动重启 | 中（可持续杀直到 PM2 放弃） |
| Git Hook | `rm .git/hooks/pre-commit` | 无自动恢复 | 高 |
| 心跳文件 | 篡改心跳时间戳伪装存活 | 无签名校验 | 低 |
| YAML 流程 | 篡改 YAML 放宽阈值 | 无文件完整性校验 | 高 |
| 审计日志 | 删除/篡改 data/audit/*.json | 无篡改检测 | 中 |

### 10.2 建议的加固措施（待实施）

1. **Git Hook 自恢复** — Sentinel 监控 `.git/hooks/pre-commit` 文件存在性，发现删除立即从模板恢复
2. **YAML 完整性校验** — 对 YAML 文件做 SHA256 hash，启动时校验，防篡改
3. **令牌签名** — 用 HMAC 签名令牌文件，防本地伪造
4. **Sentinel 双实例** — 两个独立 Sentinel 互相监控，一个被杀另一个拉起来

---

## 11. 当前局限与专家建议邀请

### 11.1 已知局限

| 局限 | 描述 | 影响 |
|------|------|:--:|
| **S4/S4.5 delegate 依赖 LLM** | S4 架构评审和 S4.5 收敛评估由子 Agent 执行，子 Agent 自身也可能出错 | 高 |
| **单点 MCP** | 当前只有一个 MCP Server 实例，无负载均衡和故障转移 | 中 |
| **Windows 强依赖** | `attrib +R`、Startup 文件夹、计划任务均为 Windows 特有 | 高（不可移植） |
| **CK 检查性能** | CK-09/CK-10 的 git diff 和 grep 扫描对大型仓库可能很慢 | 中 |
| **规则退化** | 跨会话 / 长会话压缩后 CLAUDE.md 规则易丢失 | 高 |
| **缺少分布式支持** | 无法管理多台机器上的 Agent | 低（当前规模不必要） |
| **无可观测性面板** | 没有 Grafana/Dashboard，所有状态靠命令行 | 中 |

### 11.2 专家重点审视方向

我们诚邀专家从以下维度给予建议：

1. **架构层面：**
   - DFA 状态机设计是否存在逻辑漏洞？有没有 Agent 可以绕过的跳转路径？
   - 双通道信号（machine_signal + human_report）的物理隔离是否足够安全？
   - 三道防线的纵深设计是否存在单点失效的级联风险？

2. **进化机制：**
   - 7 种违规模式检测的覆盖面是否足够？有没有未被捕获的攻击模式？
   - 规则凝练的质量如何保证？是否可能出现"学错"的情况（false positive 规则升级）？
   - 硬度阶梯 L1→L4 的升级条件是否合理？

3. **通讯安全：**
   - 5 条通讯通道是否存在中间人攻击面？
   - 令牌文件系统的共享是否有竞态条件风险？
   - 心跳文件的健康检查机制是否足够健壮？

4. **防逃逸加固：**
   - 有没有我们未考虑到的 Agent 逃逸路径？
   - Git hook 的自恢复机制是否足够坚固？
   - 是否存在 Agent 可以通过合法 MCP 调用签名恶意操作的路径？

5. **工程化水平：**
   - 从研发级工具到生产级产品的差距在哪里？
   - 可观测性、告警、日志轮转、配置管理如何提升？
   - 跨平台支持（Linux/macOS）的优先级如何？

6. **生态集成：**
   - 与 GitHub Actions / GitLab CI / Jenkins 等 CI/CD 的集成策略？
   - 与 VSCode / JetBrains / Cursor 等 IDE 的适配路径？
   - 是否有包装为 npm 包 / Docker 镜像的必要？

---

## 附录

### A. 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Node.js v22.15 |
| 语言 | TypeScript 5.7 (引擎) + CommonJS (哨兵/Hook) |
| 包管理 | npm |
| MCP SDK | @modelcontextprotocol/sdk v1.30+ |
| 进程管理 | PM2 |
| 测试框架 | Vitest |
| 配置格式 | YAML |
| 目标 OS | Windows 11 |

### B. 文件树

```
D:\AI文件\harness\
├── ecosystem.config.cjs          ← PM2 进程管理配置
├── start-harness.bat             ← Windows 一键启动
├── register-startup.ps1          ← Windows Task Scheduler 注册
├── package.json
├── tsconfig.json
│
├── mcp/
│   ├── server.ts                 ← MCP Streamable HTTP Server (主入口)
│   └── start.cjs                 ← 启动器 v2.0 (自动重启 + 健康检查)
│
├── src/
│   ├── index.ts                  ← 公共导出
│   ├── types.ts                  ← 全部类型定义
│   ├── FlowEngine.ts             ← DFA 状态机核心
│   ├── StageRunner.ts            ← 双 Runner 模式
│   ├── GateController.ts         ← 三门控控制器
│   ├── FlowConfigLoader.ts       ← YAML 加载
│   ├── GlobalMemoStore.ts        ← 全阶段备忘录注入
│   ├── AuditLogger.ts            ← 审计日志
│   ├── ToolWhitelistGuard.ts     ← 工具白名单守卫
│   ├── RulesLazyLoader.ts        ← Token 降耗上下文加载
│   ├── DualChannelSignal.ts      ← 双通道信号工具
│   ├── DesignStandards.ts        ← DS-01~DS-23 定义
│   ├── ComplianceScorer.ts       ← 合规评分引擎
│   ├── ConvergenceGate.ts        ← 收敛门控
│   ├── DelegateReviewer.ts       ← S4 委托评审
│   ├── RiskClassifier.ts         ← 风险分类
│   ├── main_harness_checker.ts   ← CK-00~CK-10 硬校验
│   ├── EvolutionEngine.ts        ← 自进化引擎
│   ├── HardnessLadder.ts         ← 硬度阶梯
│   └── __tests__/                ← 单元测试
│
├── sentinel/
│   ├── sentinel-service.cjs      ← 哨兵主进程
│   ├── watcher.cjs               ← 文件系统监控
│   ├── rollback.cjs              ← Git 回滚
│   ├── escalation.cjs            ← L0-L3 升级
│   └── sentinel-mcp-client.cjs   ← MCP HTTP 客户端
│
├── scripts/
│   ├── health-check.cjs          ← 7 项健康检查 + --fix 自动修复
│   ├── harness-gate.cjs          ← Git pre-commit 闸门
│   └── clean-tmp.cjs             ← Temp 目录清理
│
├── data/
│   ├── flows/
│   │   └── wenstaros_core_repair_flow.yaml  ← 业务流水线配置
│   ├── tokens/                   ← 令牌文件
│   ├── audit/                    ← 审计日志 (按日期分目录)
│   ├── sentinel/                 ← Sentinel 事件日志
│   ├── logs/                     ← PM2 日志
│   ├── heartbeat.json            ← MCP 心跳
│   └── docs/
│       └── HARNESS-WHITEPAPER.md ← 本文档
│
└── hooks/                        ← 被管制项目的 Git hook 模板
```

### C. 关键性能指标

| 指标 | 数值 |
|------|:--:|
| MCP 流水线 S1→S7 总耗时 | ~10-30s（取决于 S4.5 收敛轮次） |
| Sentinel 文件检测延迟 | < 800ms（轮询间隔） |
| Sentinel 回滚耗时 | < 2s（含 Git lock 重试） |
| 令牌签发有效期 | 2 hours |
| PM2 崩溃恢复时间 | < 6s（实测） |
| 审计日志单条大小 | ~2-5 KB |
| 进化引擎分析周期 | 60s 增量 / 3600s 全量 |

---

> **文档版本：** v3.0
> **生成日期：** 2026-08-02
> **维护者：** Harness 自进化引擎 + 人工审查
> **GitHub：** [henry1689/Harness](https://github.com/henry1689/Harness)

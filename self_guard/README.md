# 🛡️ SelfGuard 独立自护子系统

> **架构定位**：WenStarOS 的独立自护子系统，专门管控主 Harness 自身的基础设施变更。
>
> **版本**：v1.2.0 | **创建日期**：2026-07-26 | **更新日期**：2026-07-26

---

## 🔑 启动口令（复制即用）

向 WenStarOS 发送以下**任意一条**消息即可激活 SelfGuard 自护模式：

| 口令 | 效果 |
|:---|:---|
| `@selfguard on` | 🟢 激活 SelfGuard |
| `启动自护` | 🟢 激活 SelfGuard |
| `/selfguard` | 🟢 激活 SelfGuard |
| `@selfguard off` | 🔴 关闭 SelfGuard |
| `关闭自护` | 🔴 关闭 SelfGuard |
| `@selfguard status` | 📊 查看运行状态 |
| `自护状态` | 📊 查看运行状态 |

**激活后行为**：所有 `src/harness/` 及 `data/harness/` 目录下的文件变更自动路由至 SelfGuard 自护流水线；业务目录变更继续走主 Harness。

---

## 一、职责边界

### 分工铁律（不可突破）

| 变更类型 | 使用流水线 | 评审器 |
|:---|:---|:---|
| **业务迭代**（M1-M9 认知管线、FG 户籍、角色扮演、知识库等） | 主 Harness（`src/harness/`） | DelegateReviewer |
| **Harness 基础设施改造**（流水线配置、规则升级、评审逻辑适配、内核微调） | **SelfGuard**（`harness/self_guard/`） | **SelfReviewer** |

### SelfGuard 唯一法定职责

专门管控以下主 Harness 自身变更：
- 配置修改（YAML 流水线配置调整）
- 规则升级（`global_arch_constraint` / `global_implementation_rules` 修改）
- 评审逻辑适配（`DelegateReviewer` 维度增删）
- 内核微调（`FlowEngine` / `StageRunner` / `GateController` 逻辑调整）

### 禁区（自动拦截）

- `src/m1/` ~ `src/m9/` — 九层认知管线
- `src/app/` — 应用层（knowledge、learning、vault、profile 等）
- `src/webui/` — 前端与聊天服务
- `src/engine/` — 引擎层（cortex、heart、tianquan 等）
- `src/config/` — 业务配置
- 任何其他非 `src/harness/` / `data/harness/` 的目录

---

## 二、体系架构

### 物理隔离

```
D:\tools\wenstar-cc\
├── src\harness\              ← 主 Harness（业务流水线）
│   ├── FlowEngine.ts         ← SelfGuard 复用其基础流转框架
│   ├── DelegateReviewer.ts   ← 业务评审器（SelfGuard 不使用）
│   └── ...
│
├── harness\self_guard\       ← SelfGuard 自护子系统（独立隔离）
│   ├── self_guard_rules.yaml ← 九条自护铁律（主流水线无法读取）
│   ├── self_guard_flow.yaml  ← S1~S7 独立流水线配置
│   ├── SelfReviewer.ts       ← 独立评审组件
│   ├── SelfGuardEngine.ts    ← 自护引擎入口
│   ├── SelfGuardAuditLogger.ts ← 独立卷宗分区
│   ├── index.ts              ← 统一导出
│   └── README.md             ← 本文档
│
└── data\harness\
    ├── audit\                 ← 主业务审计卷宗
    │   └── 2026-07-26\
    └── self_guard\            ← SelfGuard 独立卷宗分区
        ├── audit\             ← 基础设施变更审计
        └── version_chain.json ← 版本链（支持一键回退）
```

### 复用与隔离

| 组件 | 主 Harness | SelfGuard | 是否复用 |
|:---|:---|:---|:---|
| FlowEngine（DFA 状态机） | ✅ | ✅（复用类，独立实例） | 复用 |
| StageRunner | ✅ | ✅（复用类） | 复用 |
| GateController | ✅ | ✅（复用类） | 复用 |
| FlowConfigLoader | ✅ | ✅（复用类） | 复用 |
| ToolWhitelistGuard | ✅ | ✅（复用类） | 复用 |
| DelegateReviewer | ✅ | ❌ | 隔离 |
| SelfReviewer | ❌ | ✅ | 独立 |
| AuditLogger | ✅ | ❌ | 隔离 |
| SelfGuardAuditLogger | ❌ | ✅ | 独立 |
| **GlobalWatchdog（旁路巡检）** | ❌ | ✅ | 独立 |
| 规则集（十一条自护铁律） | ❌ | ✅ | 独立 |
| 流水线配置（Flow YAML） | `wenstaros_core_repair_flow.yaml` | `self_guard_flow.yaml` | 独立 |
| 审计卷宗路径 | `data/harness/audit/` | `data/harness/self_guard/audit/` | 独立分区 |

---

## 三、十一条自护铁律

| ID | 名称 | 优先级 | 类别 |
|:---|:---|:---|:---|
| **SG-R1** | 改动范围铁律 | CRITICAL | scope_boundary |
| **SG-R2** | 主 Harness 底层架构不可破坏基线 | CRITICAL | baseline_protection |
| **SG-R3** | Harness 变更强制升级为最高风险等级 | CRITICAL | risk_enforcement |
| **SG-R4** | 禁止隐性削弱原有防护能力 | CRITICAL | protection_escalation |
| **SG-R5** | 双向兼容强制校验规则 | CRITICAL | compatibility |
| **SG-R6** | 基础设施配套文档同步规则 | HIGH | documentation_sync |
| **SG-R7** | 全量单元测试强制 100% 通过 | CRITICAL | test_enforcement |
| **SG-R8** | 基础设施变更痕迹强化归档规则 | HIGH | audit_trail |
| **SG-R9** | 架构重构提案权限收缩规则 | CRITICAL | permission_control |
| **SG-R10** | 版本迭代强制复审铁律 | CRITICAL | iteration_review |
| **SG-R11** | **外部制衡与旁路巡检铁律** | CRITICAL | external_oversight |

> 完整规则定义见 `self_guard_rules.yaml`，包含每条规则的 `description`、`check_items`、`violation_action`。

---

## 四、S1~S7 流水线

| 阶段 | 名称 | 门控 | 执行模式 | 核心任务 |
|:---|:---|:---|:---|:---|
| **S1** | 基础设施变更定位 & 牵连风险盘点 | human | local | 只读分析，枚举牵连清单 |
| **S2** | 基础设施变更方案设计 & 自护铁律合规审查 | human | local | 输出四项材料（SG-R3） |
| **S3** | 编码落地 | auto | local | 仅限指定范围修改 |
| **S4** | **SelfReviewer 十一条铁律全维度评审 + 迭代复审 + 外部制衡审计** | condition | **delegate** | 独立评审（SG-R1~R11 逐条）+ 迭代复审 + 权限基线审计 |
| **S5** | TypeScript 编译 & 全量单元测试 | condition | local | SG-R7 零失败要求 |
| **S6** | 双向兼容性校验 & 文档同步核验 | condition | local | SG-R5 + SG-R6 |
| **S7** | 变更痕迹归档 & 版本链维护 | auto | local | SG-R8 强化归档 |

### S4 关键差异

S4 是 SelfGuard 与主 Harness 的核心差异点：
- 主 Harness 的 S4 使用 `DelegateReviewer`（十一维业务评审）
- **SelfGuard 的 S4 使用 `SelfReviewer`**（十一条自护铁律全维度评审 + 版本一致性复审 + 外部制衡审计）
- 两条评审管线完全独立，互不读取对方规则

### 🐕 GlobalWatchdog 全局旁路巡检机制（SG-R11）

SelfGuard 不仅被动等待 Harness 变更触发，还在**后台持续主动监控**所有 `/harness` 目录的文件写入行为：

| 机制 | 说明 |
|:---|:---|
| **被动旁路扫描** | 每 10s 轮询 `src/harness/`、`data/harness/`、`harness/self_guard/` 所有文件的 mtime |
| **越权检测** | 捕获非 SelfGuard 身份的文件修改 → 立即标记为基础设施越权事件 |
| **独立留痕** | 越权事件写入 `data/harness/self_guard/breach_alerts/` 卷宗，永不删除 |
| **唯一入口固化** | 系统全局只承认 SelfGuard 为合法入口；其余任何身份/会话全禁 |
| **权限基线审计** | 每次迭代复审时校验下游主体对 `/harness` 的读写权限是否只读 |
| **拦截规则校验** | 每次迭代复审时检查 SG-R1~R11 是否完整启用、无被弱化删除 |

**启动方式**：`WenstarOSAdapter.initHarness()` 内部自动调用 `GlobalWatchdog.boot()`，无需手动配置。

### 🔄 版本迭代强制复审机制（SG-R10）

每次通过 SelfGuard 对主 Harness 做升级、迭代、规则增补、逻辑调整后，**S4 阶段自动触发四项自检**：

| 自检项 | 内容 | 触发条件 |
|:---|:---|:---|
| ① 语义去重 | 检测新增规则与存量规则的语义重复、范围重叠 | 每次迭代自动 |
| ② 结构精简 | 检测规则体系是否臃肿、条目细碎、逻辑割裂 | 每次迭代自动 |
| ③ 一致性校验 | 校验全链路规则目标一致、约束口径统一 | 每次迭代自动 |
| ④ 冗余报告 | 输出冗余分析报告，检出臃肿则同步精简合并 | 每次迭代自动 |

**复审原则**：合并重复语义、剔除冗余描述、收拢交叉条目，保证整体规则体系紧凑、层级递进、无多余重复内容，全程不削弱原有任何防护能力。

---

## 五、使用方式

### 方式一：自动路由（推荐，已对接主 Harness）

```typescript
import { SelfGuardIntegration } from '../harness/self_guard/index.js';

// 一行调用，自动分流
const result = await SelfGuardIntegration.dispatch(userMessage, targetFiles);
// routedTo: 'self_guard' | 'main_harness' | 'none'
```

**路由规则**：
- 所有文件在 `src/harness/` | `data/harness/` | `harness/self_guard/` → SelfGuard
- 所有文件在业务目录 → 主 Harness
- 混合（基础设施+业务）→ 拒绝，要求拆分提交

### 方式二：手动分流

```typescript
import { SelfGuardEngine } from '../harness/self_guard/index.js';
import { WenstarOSAdapter } from '../src/harness/index.js';

// 分析文件归属
const scope = SelfGuardEngine.analyzeScope(modifiedFiles);

if (scope.takeover === 'self_guard') {
  const engine = new SelfGuardEngine();
  const result = await engine.trigger({ message, modifiedFiles });
} else if (scope.takeover === 'main_harness') {
  await WenstarOSAdapter.triggerPipeline(message, modifiedFiles);
} else if (scope.takeover === 'mixed') {
  console.error('检测到混合变更。请拆分为两个独立提交。');
}
```

### 方式三：直接触发 SelfGuard

```typescript
import { SelfGuardEngine } from '../harness/self_guard/index.js';

const engine = new SelfGuardEngine({
  projectRoot: process.cwd(),
  onHumanGate: async (stageId, message) => {
    console.log(`需要审批: ${stageId} - ${message}`);
    return true;
  },
});

const result = await engine.trigger({
  message: '修改 FlowEngine.ts 增加超时重试逻辑',
  modifiedFiles: ['src/harness/FlowEngine.ts'],
  sessionId: 'session_xxx',
});

console.log('流水线结果:', result);
```

### 方式三：生效域校验

```typescript
const engine = new SelfGuardEngine();

// 仅校验不执行
const check = engine.validateScope(['src/harness/FlowEngine.ts']);
// → { valid: true }

const check2 = engine.validateScope(['src/webui/chat.ts']);
// → { valid: false, reason: '...不在 SelfGuard 管控域内...' }
```

---

## 六、卷宗分区

### 基础设施卷宗 vs 业务卷宗

| 维度 | 基础设施卷宗 | 业务卷宗 |
|:---|:---|:---|
| 路径 | `data/harness/self_guard/audit/` | `data/harness/audit/` |
| 标签 | `【基础设施变更】` | 无特殊标签 |
| 保留天数 | 90 天 | 30 天 |
| 版本链 | ✅ 维护 | ❌ |
| 回退支持 | ✅ 一键回退 | ❌ |

### 版本链

版本链存储在 `data/harness/self_guard/version_chain.json`，每次 SelfGuard 流水线完成后自动追加新条目：

```json
{
  "head_index": 3,
  "stable_index": 3,
  "entries": [
    {
      "index": 1,
      "version": "v1.0.0",
      "summary": "SelfGuard 子系统初始化",
      "is_stable": true,
      "previous_stable_index": null
    }
  ],
  "updated_at": "2026-07-26T08:00:00.000Z"
}
```

一键回退：
```typescript
const rollbackTarget = SelfGuardAuditLogger.getRollbackTarget();
if (rollbackTarget) {
  console.log(`回退至版本: ${rollbackTarget.version} (run: ${rollbackTarget.run_id})`);
  console.log(`摘要: ${rollbackTarget.summary}`);
  // 执行 git revert ${rollbackTarget.commit_hash}
}
```

---

## 七、自检清单（流水线闭环前必须全部通过）

| # | 检查项 | 关联规则 |
|:---|:---|:---|
| 1 | 编译校验（tsc --noEmit）→ 零类型错误 | SG-R7 |
| 2 | 全量单元测试（vitest run）→ 全部通过 | SG-R7 |
| 3 | SelfReviewer 十一条铁律全维度评审 + 版本一致性复审 + 外部制衡审计 → 通过 | SG-R1~R11 |
| 4 | GlobalWatchdog 旁路巡检 → 零越权事件 | SG-R11 |
| 5 | 兼容性校验 → 历史数据可读 | SG-R5 |
| 6 | 文档同步校验 → README + 规则释义已更新 | SG-R6 |
| 7 | 卷宗归档校验 → 标签 + 分区 + 版本链 | SG-R8 |
| 8 | 迭代复审自检 → 去臃肿 + 去重复 + 一致性 → 已嵌入 S4 | SG-R10 |
| 9 | 外部制衡审计 → 权限基线 + 拦截规则 + 唯一入口 + 越权检测 | SG-R11 |

---

## 八、变更记录

| 日期 | 版本 | 变更内容 |
|:---|:---|:---|
| 2026-07-26 | v1.0.0 | SelfGuard 子系统初始化：独立目录、九条铁律、S1-S7 流水线、SelfReviewer 评审器、独立卷宗分区、版本链 |
| 2026-07-26 | v1.1.0 | 新增 SG-R10 版本迭代强制复审铁律：S4 植入四项自检（语义去重/结构精简/一致性校验/冗余报告），每次迭代自动触发去臃肿去重复校验 |
| 2026-07-26 | v1.2.0 | **补强外部制衡**：新增 SG-R11 外部制衡与旁路巡检铁律 + GlobalWatchdog 全局旁路扫描（10s 轮询+越权告警+独立留痕）+ 唯一入口固化 + 权限基线审计 + 拦截规则完整性校验 |

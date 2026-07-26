# Harness 轻量化调度引擎 — 使用说明

> 版本 2.0 | 2026-07-26

---

## 快速开始

### 开启 Harness

在 `D:\tools\wenstar-cc\.env` 中设置：

```bash
WS_HARNESS_ENABLED=true
```

**关闭**（退回原有裸 Agent 循环）：

```bash
WS_HARNESS_ENABLED=false   # 或者直接删除这一行
```

### 触发流水线

在 wenstar-cc 项目窗口中对 Claude 说类似以下的话：

```
修复 chat.ts 中的 FamilyGraph 写入 bug
重构 SQLiteAdapter 的防抖落盘逻辑
```

或直接调用工作流：

```
/wenstaros-core-repair src/webui/chat.ts src/m4/household/FamilyGraph.ts
```

### 模式判定

| 场景 | 模式 |
|------|------|
| 修改 `chat.ts` / `FamilyGraph.ts` / `SQLiteAdapter.ts` 等高风险文件 | **强制流水线** S1→S2→S3→S4→S5→S6→S7 |
| 修改 `src/m4/` / `src/m5/` / `src/engine/` 等中风险模块 | **强制流水线** 全流程 |
| 修改 `src/config/` / `src/types/` 且为 typo/文案修复 | **自由裸奔** 跳过流水线 |

---

## S1-S7 流程说明

```
S1 问题收录 ──human──▶ S2 方案定稿 ──human──▶ S3 代码落地
   (只读锁死)           (人工终审)              (唯一写入阶段)
                                                     │
                                                     ▼ auto
                                               S4 架构评审
                                              (委托独立子Agent)
                                                 │        │
                                     condition_pass  condition_reject
                                                 │        │
                                                 ▼        ▼
                                          S5 编译测试   S3(回退)
                                              │        │
                                     condition_pass  condition_reject
                                              │        │
                                              ▼        ▼
                                       S6 功能验证   S3(回退)
                                              │        │
                                     condition_pass  condition_reject
                                              │        │
                                              ▼        ▼
                                       S7 变更归档   S3(回退)
                                              │
                                              ▼
                                             END
```

| 阶段 | 门控 | Runner | 可写文件？ | 说明 |
|------|------|--------|-----------|------|
| S1 | human | local | ❌ | 只读分析影响范围 |
| S2 | human | local | ❌ | 方案撰写，人审后写入全局备忘录 |
| S3 | auto | local | ✅ | 唯一放开写入权限的阶段 |
| S4 | condition | delegate | ❌ | 独立子Agent评审，运动员不自审 |
| S5 | condition | local | ❌ | tsc编译 + vitest全量测试 |
| S6 | condition | local | ❌ | 三类场景行为核验 + 数据库审计 |
| S7 | auto | local | ✅ | 变更归档报告 |

---

## 新增自定义工作流

### 1. 创建 YAML 配置

在 `data/harness/flows/` 下新建 `your_flow.yaml`：

```yaml
flow_id: your_flow_id
flow_name: 你的流水线名称
version: 1.0
max_jump_limit: 8
global_memo_key: your_flow_memo
global_arch_constraint: |
  你的架构铁律内容

global_implementation_rules: |
  # 1. 你的规则
  规则正文

stages:
  - stage_id: S1_Your_Stage
    stage_name: 你的阶段名称
    work_manual: |
      阶段工作手册
    tool_whitelist:
      read_file: true
      write_file: false
    gate_type: human
    next_stage: S2_Next_Stage
    runner_mode: local
```

### 2. 创建 Claude Code Workflow（可选）

如果需要通过 `/your-flow` 命令触发，在 `.claude/workflows/` 下创建 JS 脚本。

### 3. TS 运行时调用

```typescript
import { FlowEngine } from './src/harness/FlowEngine.js';

const engine = new FlowEngine({
  delegateReviewFn: myCustomReviewFn,
  onHumanGate: myHumanGateCallback,
});

const result = await engine.start('your_flow.yaml', {
  message: '用户原始消息',
  modifiedFiles: ['src/webui/chat.ts'],
  riskLevel: 'high',
  isTrivial: false,
});
```

---

## 扩展评审维度

在 `DelegateReviewer.ts` 的 `review()` 函数中新增调用：

```typescript
// 新增第十二维校验
const myNewViolations = checkMyNewDimension(state);
violations.push(...myNewViolations);
```

然后在 `FIVE_DIMENSIONS` 数组中追加维度名称，在 `validateReviewCompleteness()` 签名和调用处追加参数。

---

## 配置参考

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WS_HARNESS_ENABLED` | `false` | Harness 总开关 |

### YAML 配置路径

| 路径 | 说明 |
|------|------|
| `data/harness/flows/*.yaml` | Flow 配置 |
| `data/harness/memos/` | 备忘录持久化 |
| `data/harness/audit/YYYY-MM-DD/` | 审计日志 |
| `data/harness/audit/proposals/` | 双方案对比归档 |
| `data/harness/reports/` | S7 变更归档 |

---

## 排错指南

### Harness 不触发

1. 确认 `.env` 中 `WS_HARNESS_ENABLED=true`
2. 确认消息中包含文件引用（如 `chat.ts`、`FamilyGraph.ts`）
3. 确认不在已有的流水线中（`isPipelineRunning()` 返回 `false`）

### S4 评审一直不通过

1. 查看 `AuditLogger` 输出的日志文件 `data/harness/audit/YYYY-MM-DD/{run_id}.json`
2. 查找 `machine_signal` 事件中的 `reject_reason` 数组
3. 对照违规项返回 S3 修复后重新提交

### 白名单拦截误报

1. 确认当前 Stage 的 `tool_whitelist` 配置是否正确
2. 查看 `ToolWhitelistGuard` 的 `getStats()` 计数
3. 如果操作不在 `ACTION_MAP` 中却需要管控，在 `ToolWhitelistGuard.ts` 的 `ACTION_MAP` 中添加映射

### YAML 解析失败

1. 确认使用 `|` 多行语法
2. **不要在规则正文中让 `#` 出现在行首**（YAML 解析器在块外模式会将其视为注释过滤）
3. 确认缩进一致（2 空格）

### 审计日志膨胀

- 自动清理：超过 30 天的日志目录自动删除
- 单文件告警：超过 5MB 时控制台输出警告
- 手动清理：删除 `data/harness/audit/` 下的旧日期目录

---

## 开发命令

```bash
# 编译检查
npx tsc --noEmit

# 运行所有 Harness 测试
npx vitest run src/harness/__tests__/

# 只跑单个测试文件
npx vitest run src/harness/__tests__/DelegateReviewer.test.ts

# 清除配置缓存（测试用）
# 在代码中调用 clearConfigCache() 或重启进程
```

---

## 目录速查

```
src/harness/          ← TS 引擎源码（14 文件, 3,149 行）
data/harness/         ← 运行时数据
  flows/              ← YAML 流水线配置（2 个）
  memos/              ← 全局备忘录持久化
  audit/              ← 审计日志（按日期分片）
    proposals/        ← 双方案对比归档
  reports/            ← S7 变更归档
  docs/               ← 文档（白皮书/规范/使用说明）
.claude/              ← Claude Code 集成
  settings.json       ← Hook 绑定
  workflows/          ← Workflow 脚本（1 个）
```

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-07-26 | 初始发布：DFA引擎+三门控+双Runner+7维评审+11条规则 |
| 2.0 | 2026-07-26 | 规则精简至9条、评审升至11维、新增静态质量+审计归档升级 |

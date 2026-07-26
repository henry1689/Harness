# Harness 轻量化通用流水线调度引擎

## 🌐 语言

🔴 所有交流、回复、文档、代码注释默认使用中文。

---

## 项目定位

Harness 是一个零侵入、插拔式、YAML 驱动的通用流水线调度引擎。基于确定性有限状态机（DFA）实现 Stage 流转，AI 文本无法干预跳转——放行权由纯代码逻辑控制。

## 核心组件

| 组件 | 路径 | 职责 |
|------|------|------|
| FlowEngine | `src/FlowEngine.ts` | DFA 状态机核心 |
| GateController | `src/GateController.ts` | auto/human/condition 三门控 |
| StageRunner | `src/StageRunner.ts` | local/delegate 双 Runner |
| ToolWhitelistGuard | `src/ToolWhitelistGuard.ts` | 执行层白名单拦截 |
| DelegateReviewer | `src/DelegateReviewer.ts` | 11维代码评审 |
| AuditLogger | `src/AuditLogger.ts` | 全流程审计日志 |
| SelfGuardEngine | `self_guard/SelfGuardEngine.ts` | 基础设施自护引擎 |
| SelfReviewer | `self_guard/SelfReviewer.ts` | 11条自护铁律评审 |

## SelfGuard 规则

🔴 所有对 Harness 自身文件的修改，必须走 SelfGuard 流水线，禁止直接写入。

SelfGuard 接管域：`src/harness/`、`data/harness/`、`harness/self_guard/`、`.claude/`

## 开发命令

```bash
npx tsc --noEmit        # 编译检查
npx vitest run src/__tests__/  # 全量测试
```

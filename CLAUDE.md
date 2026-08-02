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

## 🛡️ SelfGuard 监管（MCP 外部接入）

🔴 **所有对 Harness 文件的修改，必须先通过 SelfGuard MCP 校验。**

SelfGuard 是独立 MCP 服务，不在本项目中。Claude Code 通过 `.claude/mcp.json` 自动连接。

**每次修改 Harness 文件前，AI 必须先调用 `check_harness_change` 工具。**

SelfGuard 十三条自护铁律全维度评审通过后才能进入编码。

## 开发命令

```bash
npx tsc --noEmit        # 编译检查
npx vitest run src/__tests__/  # 全量测试
```

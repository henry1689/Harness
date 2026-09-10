# Harness P0-A / P1 变更归档 — 2026-09-08

> 状态：已落码 + S5 全绿(27 文件/542 测试) + S6 真实数据回放验证。S4 独立评审因 delegate API 402 中断待补。
> 触发：wenstar-cc chat.ts 9 文件重构 flow 恒 69.4% 烧满 21/20 轮锁死（run_mtrksrpx_krvn）。

## 背景
S4 reviewer 的「确认簿记」（`[确认缺失:*]`）与「无条件过程义务」（5 前缀）被 ComplianceScorer 按设计标准关键词撒网：单条文本命中多条标准各 -20 → 结构性 80 分墙 → 恒 69.4%。Agent 只见 DS 分数墙，不知需声明哪些确认 key，永不收敛。

## P0-A：S4.5 义务/确认簿记 与 内容违规 分流（src/ConvergenceGate.ts + src/types.ts）
- 新增 `isProcessObligation` / `partitionReviewViolations`：content / confirmations(`[确认缺失:*]`) / unconditional(5 无条件义务前缀)。
- `evaluate()` 只把 content 违规喂 `computeComplianceScore`——簿记不再拖文本分。
- 结构化闸门：内容分达标(PASS/HANDOFF)但 confirmations 非空 → REJECT + 可行动 key 清单（Agent 声明即收敛）。内容分不足时清单并入报告。
- 无条件义务（恒定触发无法声明消除）不计分也不入闸门，其内容由 S5 tsc/S6 兜底。
- FG 红线确认（FG_REDLINE_*）走 confirmations（声明即清除）；真实红线/UUID 代码缺陷仍由 CK-03/CK-04/CK-05 + `metrics.uuid_chain_broken` 硬拦截。
- `types.ts` MachineSignalMetrics 增 `unresolved_confirmations?`。

## P1：EvolutionEngine audit 扫描对齐真实 schema（src/EvolutionEngine.ts）
- 根因：scanAuditDir 把 run 包装文件 `{run_id, entries[]}` 当单条事件读顶层 event → 恒 undefined → totalAuditEvents 恒 0。
- 修复：展开 entries[]；`classifyAuditSubEvent` 按 gate_resolve(S4.5 condition_rejected→convergence / human→bypass)、flow_abort(熔断锁定→lockout)、tool_blocked→hook_denial 映射；保留旧 event-level 兼容。
- 验证：run_mtrksrpx_krvn 真实回放 = 21 convergence + 1 lockout（精确对应）。

## S4 独立评审 — 待补
delegate 子 Agent 因 API 402（余额不足）中断。已用真实数据回放 + 全量 542 测试做行为级验证；独立评审待余额恢复后补跑（问题集见会话记录）。

## 生效
重启 harness-mcp 后生效；EvolutionEngine 启动全量扫描补录 35 天 audit 历史。

## P0-B2（同日追加）CK-06.5 名称碰撞 → warn（src/main_harness_checker.ts）
- 触发：M2-2（FG写网关8文件）DS-23 恒 40——关系赋值特征对 `familyGraph`/`FamilyGraph.` 基名 substring 命中 → 92 处正常引用全仓爆炸；方法名特征对通用方法 `.getFullYear` → 17 处普通调用误判。
- 根因：CK-06.5 特征纯基于名字，无法区分"同名普通使用"与"同款缺陷复现"，自动硬 FAIL 打地鼠（本日已连修 import 噪声/familyGraph/getFullYear 三类）。
- 修复：`checkSystemicPattern` 命中 → 一律 `passed:true severity:'warn'` + 候选清单 + 指引（S2 声明覆盖 or S4 reviewer 共性维度判定）；DS-23 不再自动 -40。
- 验证：tsc 绿 + 全量 542 测试绿；无测试引用 CK-06.5/DS-23 硬 FAIL 语义。

## P0-A2（待办，下窗口）确认阻塞提前终局（src/ConvergenceGate.ts + FlowEngine + types）
- 触发：run_mts7hzf2_1iqy round3-20 空转——内容分 95.5≥90 达标但 5 项确认未声明 → P0-A 闸门 REJECT，而 s2_evidence run 内不可变 → 纯确认阻塞必烧满轮次。
- 方案：内容分≥90 且唯一阻塞=确认 → 终局(reason=confirmations_pending) 停 run，Agent 重开声明。需 FlowEngine 识别终局标记 + types 增 reason。
- 临时绕行：Agent 读 S4 首轮「确认缺失」key → 重开 run 在 s2_evidence.confirmations 声明。

## P0-A2 ✅ 已落地（当日实现）
- `src/types.ts`：TerminalEndReason 增 `confirmations_pending`。
- `src/ConvergenceGate.ts`：else 分支（内容 REJECT 但确认>0）metrics 也带 `unresolved_confirmations`，让 FlowEngine 可识别。
- `src/FlowEngine.ts`：S4.5 condition_rejected 且 metrics.unresolved_confirmations>0 且 compliance_score≥90 → recordAbort('confirmations_pending') 提前终局（回流计数前）。
- 验证：tsc 绿 + 全量 542 测试绿；mcp 重启后 MCP 工具实测联通（totalAuditEvents 4589 / avgConvergenceRounds 5.7）。

## ⚠️ 基建遗留（follow-up）
harness-mcp 重启后 start.cjs 内部监督器对健康子进程重复派生（EADDRINUSE 噪声，第 N 次计数狂涨），但 8765 单一子进程稳定服务。另：pm2 启动时 PATH 解析 node→pi-node(AppData\Local\pi-node) vs 旧 D:\tools\nodejs 双 Node 并存。需排查 start.cjs 重派生逻辑（疑似健康检查误判）——不影响当前服务。

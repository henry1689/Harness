# 改造差异报告（enhance-v1，阶段收口）

- 基线：`docs/harness/00_压模程序-S1-S7现状审计报告-2026-09-09.md`
- 需求：`docs/harness/01_压模程序-S1-S7-增量改造完整方案-V1.0.md`
- 任务：`docs/harness/task-harness-enhance-v1.md`
- 日期：2026-09-09/10/11；状态：**本节所有 🔴/🟠 项均已落地（见「四」）；H-01/H-02 已 live 验证（P0-2）；M 骨架已去半成品（P1-2）**

## 一、逐缺口对照（00 审计报告 → 本次补齐）

| 00 基线缺口 | 本次状态 | 落地证据 |
|---|---|---|
| S3 回流上限配置与文案矛盾(20 vs 3) | ✅ **E-01** | flow YAML `max_s3_retries: 3` + 职责注释 |
| S3 补丁循环烧满 20 轮锁死、无架构重审 | ✅ **E-02** | FlowEngine S3≥max → 跳 S1→S2 + superseded + run_signal + 计数归零 + S2 旧证据终局护栏 |
| S4.5 证据截断（下游只见摘要） | ✅ **H-04（全链路 live）** | ConvergenceGate 每次出口产 full_review_evidence；FlowEngine S4.5驳回→S3 回流注入 memo |
| 债务散落无台账 | ✅ **H-03 三环齐备** | 台账 DB + CRUD + S4.5 DS<98→候选池 + **S2 补丁→自动建 debt（P1-1，2026-09-11）**；S7-B R2 校验 debt_id 存在 |
| S3 整文件覆写无硬闸 | 🟠 **H-05 核心 live（调用点接线待专项）** | writeRatio 模块 + harness_globals.json 阈值 + ToolWhitelistGuard checkWriteWithRatio/allowlist/audit（进程内调用点接线待专项） |
| S7 归档无机器校验 | ✅ **H-01 已接线并 live 验证** | S7ArchiveValidator(R1-R5)；`S7ArchiveDelegate` 注册于 mcp；YAML 拆 S7-A/S7-B；P0-2 live run 验证「缺归档 → 回退 → archive_invalid」 |
| S6 行为验证降级"参考" | ✅ **H-02 已落地（形式调整）** | YAML 拆 S6-A(机器硬校验)/S6-B(人工验收门控)；任务单按 `change_key` 寻址；未确认 → 悬挂终局 `await_manual_verification`。⚠️ 原设计的「真阻塞」不可实现（引擎无暂停/恢复原语）→ 改为「悬挂 + 确认后重跑」，见 03 偏差说明 |
| CK-06.5/DS-23 名称碰撞 | ✅（会话早前） | B：systemic 命中→warn+候选 |
| 评审义务/确认死锁 | ✅（会话早前） | P0-A + P0-A2 |
| EvolutionEngine 空转 | ✅（会话早前） | P1：audit 接通（0→4701 事件） |

## 二、M 骨架（🟡 仅骨架，未接入）
- **已落地并接入**：4 组 schema（TS+json-schema）、`tech_debt_ledger` 模块、`S7ArchiveValidator`
- ✅ **已显式删除（2026-09-11，07 计划 P1-2「去半成品」）**：`ContractResolver.ts`（接口/抛错桩）、
  `harness_contract/core_constraint_mapping.yaml`、`harness_contract/overlays/wenstar_v1.0_overlay.yaml`
  —— 该骨架自创建起**零生产调用方**（仅自身 + 断言其抛错的测试引用），从未接线；
  「挂着抛错桩」比「没有」更危险（诱导调用）。
  若将来真要落地契约映射（M-01/M-02），按 07 计划重新立项，不复活旧桩。

## 三、git 变更清单（本次 enhance-v1 涉及）

**新增文件**：`src/debt/techDebtLedger.ts`｜`src/schemas/{s2-evidence-v2,full-review-evidence,s7-archive-payload,manual-verification-ticket}.ts + .schema.json`｜`src/writeguard/writeRatio.ts`｜`src/s7/S7ArchiveValidator.ts`｜`scripts/harness-debt-schema.cjs`｜`scripts/harness-debt-migrate.cjs`｜`data/harness_globals.json`｜`docs/harness/{00,01,task-harness-enhance-v1,03_S6S7拆分实施设计-待执行,本报告}`｜测试 4 个

**删除文件（2026-09-11）**：`src/contract/ContractResolver.ts`、`harness_contract/`（P1-2 去半成品）

**修改文件**：`data/flows/wenstaros_core_repair_flow.yaml`(max_s3=3+注释)｜`src/FlowEngine.ts`(E-02 跳转/护栏/助手, H-04 注入, run_status)｜`src/ConvergenceGate.ts`(证据装配, H-03 候选池)｜`src/ToolWhitelistGuard.ts`(H-05)｜`src/types.ts`(恢复 P0-A 字段 + run_signals/superseded/full_review_evidence)｜`src/__tests__/b0-enhancement-skeletons.test.ts` 等


**风险点/回归项**：见 `03_` 与各测试；E02/H01/H02 专项回归未跑（转专项时执行）

## 四、转专项项 —— 已全部交付（2026-09-10 补完）

| 项 | 状态 | 落地内容 |
|---|---|---|
| H-01 S7 拆分 + S7-B 接线 | ✅ | YAML `S7-A_Change_Archive`(auto→) + `S7-B_Archive_Validate`(delegate/condition, pass→END, reject→S7-A)；`mcp/server.ts` 注册 `s7ArchiveValidateDelegate`；FlowEngine 标记 `_archiveInvalid` → `run_status=archive_invalid` |
| H-02 S6 拆分 + await 语义 | ✅ | YAML `S6-A_Function_Verify_Machine`(local/condition) + `S6-B_Manual_Verify`(delegate/condition)；`mcp/server.ts` 注册 `s6ManualVerifyDelegate`；FlowEngine 悬挂终局 `run_status=await_manual_verification`（新 TerminalEndReason `manual_verification_required`） |
| E-02 端到端回归 | ✅ | 补齐**补丁循环硬止**（见下「五」）；`FlowEngine.test.ts` 2 处过期期望同步 |
| 全量干净回归 | ✅ | `tsc --noEmit` 0 错误；`vitest run` **616/616 通过**（36 文件） |
| 03 文档实施设计 | ✅ | 已全部执行；不再「待执行」 |

**新增文件（本轮）**：`src/s6/manualVerifyIO.ts`｜`src/s6/S6ManualVerifyDelegate.ts`｜`src/s7/S7ArchiveDelegate.ts`｜`scripts/harness-manual-confirm.cjs`｜测试 `manual-verify-io.test.ts`(13) / `s7-archive-delegate.test.ts`(5)

**修改文件（本轮）**：`data/flows/wenstaros_core_repair_flow.yaml`(S6/S7 拆分)｜`mcp/server.ts`(delegate 注册 + run_status 透出)｜`src/FlowEngine.ts`(S6-B/S7-B 终局钩子 + 补丁循环硬止 + deriveRunStatus)｜`src/types.ts`(修复后恢复 enhance-v1 全部类型 + H-02 新字段)｜`src/__tests__/{FlowEngine,FlowConfigLoader}.test.ts`(过期期望同步)

## 五、E-02 补丁循环硬止（本轮发现并修复的缺陷）

E-02 在 `s3_retry_count >= max_s3_retries` 时**将计数器归零**并强制跳 S1→S2，终止仅依赖「S2 + 已 superseded 旧证据」守卫。当 `s2_evidence` 不存在且 S2 可被自动放行（`autoApproveHumanGate` / 无证据守卫未命中）时，形成
`S1→S2→S3→S4→S4.5→S1` **无限循环**（每圈计数归零，永不熔断）。实证：`FlowEngine.test.ts` 单测 6 分钟涨至 5.3GB OOM。

**修复**：以 `run_signals` 中 `s3_stuck_in_patch_loop` 条数为补丁循环上界——强制回架构重审**只给一次机会**，第二次达上限即 `recordAbort('s3_patch_loop')` 终局，要求人工介入。生产环境（无证据即 denied）原本不会踩到，但引擎层缺乏硬止属真实缺陷。

# Harness H2：MR-1 正式落位 Pre/Post 最小闭环任务书

- 日期：2026-08-31
- 目标：只修复 MR-1 4B 合法正式落位所暴露的 Harness 控制面死锁
- 当前阶段：Gate 0 只读取证；未经项目所有者再次明确批准，不得编辑 Harness
- 执行仓：`D:\AI文件\harness`
- 主线：阿芬人物记忆改善 / MR-1 4B

## 1. 任务结论先行

本任务只允许解决三类问题：

1. 将开工授权与落位后闭环机械分成 `pre_edit` / `post_edit` 两阶段；
2. 修正 CK-01、UUID 与 blocking 的变更归因，禁止把继承债务或 confirmation 文本误判为本次改动破链；
3. 保证 flow audit 始终是 UTF-8、可被标准 JSON 解析器解析的合法 JSON。

不得借此扩建 Harness V2.x、降低合规阈值、扩大豁免能力，或触碰 WenStar 正式源码、生产数据库和服务。

## 2. 真实失败证据

先完整阅读：

- `docs/mr1-4b-formal-landing-harness-gate-blocker-2026-08-31.md`
- `docs/harness-h2a-plus-second-review-pre-post-closure-corrections-2026-08-29.md`
- audit：`data/audit/2026-08-31/run_mtgp43yy_x2z3.json`

固定证据：

- flow run：`run_mtgp43yy_x2z3`
- audit SHA-256：`5043df93d477bd8df137f265652b3c83e795f19e52a6fc4f81de7b2a5df98b5b`
- 阻断报告 SHA-256：`d2e86e2b9748b833cd1a1025a6c27784c23b2220ca0a34394dfee3169c68357e`
- MR-1 R4 patch SHA-256：`e215ed5ec446e493cd7c449d67838331a92325897cf1fa6f028d78078fada32f`
- 失败终态：S4 每轮固定产生 34 个 blocking，S4.5 第 1～7 轮固定 20.8 分，最终 `retry_limit / aborted / token_issued:false`
- 审计文件的中文 `flow_name` 损坏并破坏 JSON 语法，标准 `ConvertFrom-Json` 不能解析

该运行已经证明：当前 Harness 把只能在实际 Edit 后验证的 closure 条件用于 Edit 前授权，使源码未获 token 时就被要求证明已经落位，形成不可收敛死锁。

## 3. Gate 0：只读取证（本轮唯一立即授权）

先只读回报，不得修改任何文件。报告必须包含：

1. 当前 branch、HEAD、`git status --short`；
2. 下列候选文件的存在性、SHA-256、staged/unstaged/untracked 状态；
3. H0/H1 已验 dirty hunk 与本任务候选 hunk 的逐文件、逐 hunk 重叠矩阵；
4. 真实调用链：MCP input → FlowEngine → StageRunner → Reviewer/Convergence/Scorer → terminal policy → audit；
5. 每个候选文件“修改/不修改”的理由和精确测试路径；
6. 审计 JSON 损坏发生在输入、序列化、编码还是落盘哪一层，并给出最小复现；
7. 建议拆包顺序、每包精确文件清单、回滚 hunk 与停止条件。

必须逐一裁决的候选面：

```text
mcp/server.ts
src/FlowEngine.ts
src/StageRunner.ts
src/types.ts
src/DelegateReviewer.ts
src/DualChannelSignal.ts
src/ConvergenceGate.ts
src/ComplianceScorer.ts
src/main_harness_checker.ts
src/security/flow-terminal-policy.ts
data/flows/wenstaros_core_repair_flow.yaml
audit 写入/序列化的实际实现文件
相关精确测试文件
```

这不是要求全部修改。不得用整文件覆盖、`checkout`、`reset`、`revert` 或自动格式化掩盖 dirty 重叠。

Gate 0 报告完成后立即停止，等待项目所有者对精确实施包再次授权。

## 4. 获批实施后的强制协议

### 4.1 输入和绑定

从 MCP schema 到 audit 必须存在 typed 字段：

```text
run_phase = pre_edit | post_edit
change_set_id
prior_run_id  # post_edit 必填
```

`post_edit` 必须机械绑定一个已完成的 `pre_edit`：同 project、同精确 files、同 `change_set_id`、同 token-bound baseline。缺字段、错 run、错文件、范围扩大、目标 hash 没有变化或变化超出批准范围，全部 fail-closed。

### 4.2 pre_edit

只验证：

- S1/S2、审批、稳定 confirmation key、精确方案与文件清单；
- 当前基线和可归因于当前提案的事实型 blocking；
- post-edit 测试、文档、异常路径、hook 与闭环计划。

落位后义务在此阶段只能是 `planned`，不得因为正式文件尚未编辑而注入以下固定 blocking：

```text
DOC_SYNC_REQUIRED
STATIC_QUALITY_GATE
ROBUSTNESS_CORE_REQUIRED
HOOK_REQUIRED
HOOK_SIX_STAGE_HEALTH
```

`pre_edit completed` 是唯一允许签发一次性 edit token 的新增路径；仍须服从现有 H0 terminal/token policy。

### 4.3 post_edit

只在实际获批 Edit 后运行：

- 校验 token-bound baseline 与实际 delta；
- 执行真实、stage-specific 的 S5/S6 handler；
- 将 obligation 收敛为 `verified | deferred_out_of_scope | failed`；
- 任一 required evidence 缺失或检查失败，唯一终态为 abort，且零 token；
- `post_edit completed` 也必须零 token。

不得把 pre-edit 的基线 `tsc/test` 结果复用成 post-edit evidence。YAML `work_manual` 文案不等于执行；测试必须用 spy/fixture 证明 S5/S6 调用的是各自 handler，而不是所有 condition stage 共用 `s3CompileCheck`。

### 4.4 MR-1 的 post-edit 边界

本 MR 获批的静态闭环应覆盖：

- `npx tsc --noEmit`；
- DatabaseGenerationGuard 全量测试；
- frozen regression 7/7；
- m2 全量 173/173；
- 目标文件集合、hash、diff 与 Sentinel 延迟复核；
- 获批范围内的文档/异常路径/hook 静态证据。

服务启动、生产数据库写入、生产 cutover/运行态观察不在 MR-1 授权内，只能记为 `deferred_out_of_scope`，不得执行，也不得冒充 `verified`。未来 MR-5 的事项不能反写成当前授权。

## 5. CK-01 / UUID 精确归因

必须区分并 typed 表达：

```text
current_change_blocking
implementation_obligation
inherited_baseline_debt
unknown_attribution
```

强制要求：

1. `uuid_chain_broken` 只能从可归因于当前提案/实际 delta 的 typed UUID 事实推导；
2. 禁止以 confirmation label、说明文本或 violation 字符串中出现 `UUID` 就判定破链；
3. 禁止类似 `violations.some(v => v.includes('UUID'))` 的字符串推断；
4. 全文件既有债务必须独立记录，不得自动算成本次四文件补丁造成；
5. 继承债务只有与获批 delta 直接冲突时才可阻断；
6. attribution 不可确定时 fail-closed，但必须报 `unknown_attribution` 和缺失证据，不能伪称 current delta violation；
7. ComplianceScorer 只对当前阶段适用、且正确归因的 blocking 扣分。

H2a typed obligation 与 H2b CK-01 attribution 两者均生效前，不得宣称 MR-1 已解锁。

## 6. 审计 JSON 合法性

所有新旧 phase 的审计必须满足：

- UTF-8 编码；
- 标准 JSON parser 可完整解析；
- 中文 `flow_name`、evidence 和 error 不破坏转义或结构；
- 原子落盘或等价的截断/并发安全机制；
- canonical bytes、文件 SHA-256 与现有 HMAC/完整性策略的顺序明确且可复验；
- 写入失败时 fail-closed，不得留下被宣称为成功审计的半文件。

至少加入中文、引号、反斜杠、换行、emoji、并发/中断写入的回归用例，并用 Node 与 PowerShell 标准 JSON parser 双重验证生成文件。

不得篡改或重写现有失败审计 `run_mtgp43yy_x2z3.json`；它是固定取证物。

## 7. 最低验收矩阵

实施计划与测试必须逐项覆盖：

1. `pre_edit completed` 可签一次 token，但 obligations 仍为 `planned`；
2. pre-edit baseline `tsc/test` 不能生成 post evidence；
3. post-edit 缺/错 `prior_run_id`、`change_set_id`、files、baseline hash、无实际变化均拒绝；
4. post-edit 超出获批 hunk/文件范围拒绝；
5. S5/S6 spy/fixture 证明执行 stage-specific handler；
6. S5 或 S6 失败时唯一 abort、零 token；
7. post-edit completed 仍零 token；
8. final Edit 后必须有 post-edit closure，不能因没有下一次 Edit 漏验；
9. production cutover 标为 `deferred_out_of_scope` 时不触碰服务/生产库，也不记为 verified；
10. H2a 有效但 H2b 未生效时，MR-1 的 CK-01 仍应拒绝；
11. H2a+H2b 生效后，全新 MR-1 pre-edit 能合法取得 token；实际 Edit 后另跑 post-edit 才闭环；
12. inherited UUID/复杂度债务不会被误算为当前四文件 delta；真实 UUID delta 断链仍阻断；
13. audit 含复杂中文内容仍能由标准 JSON parser 解析并通过完整性复验；
14. abort/retry_limit/audit write failure 全部零 token；
15. H0/H1 既有验收测试与 token 单一性不回归。

## 8. 禁止项

- 不得使用 `skip_s3_compile`、伪造 confirmation 或补写虚假 evidence；
- 不得用 `exempt_files` / `S4.5_complexity` 掩盖 correctness blocking；
- 不得降低 98 分阈值或放宽 fail-closed；
- 不得新增管理员旁路、Sentinel 绕过或无限 token；
- 不得编辑 WenStar MR-1 四文件、启动服务或接触生产 DB；
- 不得重写既有 audit 取证物；
- 不得重启 Harness、运行正式 MR-1 flow、commit 或 push，除非分别获得明确授权；
- 不得把本任务扩大为 Harness 全面重构。

## 9. 分包与停止条件

建议按依赖拆成三个可独立回滚、但最终联合验收的包：

1. H2-P：typed phase/linkage、真实 stage dispatch、terminal/token policy；
2. H2-A：obligation + CK-01/UUID attribution + scoring；
3. H2-J：audit UTF-8/JSON/canonical integrity。

Gate 0 必须根据 dirty 重叠重新裁决是否需要调整拆包。任何包出现以下情况立即停止：

- 与 H0/H1 已验 hunk 无法机械隔离；
- 需要降低阈值、扩大 exemption 或绕过 Sentinel；
- 需要触碰未获批文件/服务/生产数据；
- 无法证明 post-edit 检查发生在实际 Edit 之后；
- audit 修复会改变既有取证物；
- 测试无法区分真实 handler 与共享 `s3CompileCheck`。

## 10. 执行者首轮回报格式

只交付一份 Gate 0 报告，末尾给出：

```text
VERDICT = READY_FOR_EXACT_IMPLEMENTATION_APPROVAL | STOP_<REASON>
PROPOSED_PACKAGES = <每包精确文件与测试>
OVERLAP = <逐 hunk 结论>
NO_MUTATION_PROOF = <HEAD/status/hash 前后对照>
```

不要在同一轮顺手实施。只有项目所有者看完 Gate 0 报告并明确批准精确包后，才进入修改。

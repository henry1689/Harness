# Harness H2-A+ 二次审阅与 Pre/Post 双阶段闭环勘误

- 更新时间：2026-08-29
- 裁决：不批准当前 H2a 实施，也不批准 H2a+H2b 一并实施；继续只读修订
- 原因：H2a 无法单独解锁 MR-1，且声称的 S5/S6 post-edit 强制点并未在生产执行路径中存在
- 禁令：不得编辑 Harness/WenStar、签 exemption、重跑 flow、重启、commit 或 push

## 1. 接受的设计方向

保留三通道方向：

1. 当前事实型 blocking；
2. typed implementation obligations；
3. 具有机械 identity 的 inherited debt。

保留 UUID 从 FG_UUID typed blocking 推导、CK-06.5 修正 codec import 泛化、unknown attribution fail-closed、生产 cutover 不冒充已验证等原则。

## 2. 当前方案的决定性矛盾

### 2.1 H2a 不能单独解锁 MR-1

H2a 不处理 CK-01 attribution。取证报告自己的反事实已证明，即使：

- 17 个 confirmation key 全部正确；
- direct blockers 改为 obligations；
- 合法跳过 CK-06.5/CK-08；

CK-01 仍使 DS-01 低于每标准 98 分，S4.5 仍应拒绝。因此：

- H2a、H2b可以拆包、串行验收；
- **但两包都完成并运行态生效后，MR-1 才能重跑**；
- 删除“H2a 先行即可让 MR-1 走通/解锁”的结论。

### 2.2 S5/S6 当前不是设计声称的执行点

只读生产调用链确认：

1. `StageRunner.runLocal()` 对 condition stage 只调用一个 `conditionGateCheck(stageId, ...)`，不会解释或执行 YAML `work_manual` 中的命令；
2. MCP server 构造 `FlowEngine` 时，对所有 condition stage 注入的都是 `s3CompileCheck`；
3. `s3CompileCheck` 只执行 `npx tsc --noEmit` 并按目标文件过滤错误；
4. 所以 S5 实际没有运行 YAML 声称的 CK-08、全量 vitest、模块专项测试；
5. S6 实际没有运行 CK-09/10、落盘检索、场景/数据库核验；
6. S7 是 local auto stage，也没有 obligation closure gate；
7. 整个 `harness_run_flow` 在 token 签发前同步完成，S3 `write_file:true` 只是 YAML 白名单声明，`runLocal()` 并不会替 Claude 编辑源码。

因此当前设计中的“现有 S5/S6 够用，只增 checkObligations”不成立。若按该设计实现，pre-edit baseline 会被误记为 post-edit verified，仍会产生虚假 closure。

## 3. 强制改成显式双阶段协议

新方案必须从 MCP 输入到 audit/token 明确区分：

```text
run_phase = pre_edit | post_edit
change_set_id
prior_run_id（post_edit 必填，绑定对应 pre_edit completed run）
```

### 3.1 pre_edit

- 验证 S1/S2、17 个稳定 key、精确方案、横向清单、审批、baseline、当前事实 blocking；
- 后续 obligation 只能为 `planned`；
- 完成后可按 H0 policy 签一次性 edit token；
- 不得把当前未编辑文件的 tsc/test 结果当作本次改动 post evidence。

### 3.2 post_edit

- 必须绑定 pre_edit run、相同 project/files/change_set，验证目标文件内容确实从 token 绑定基线发生了获批范围内变化；
- 执行真实 stage-specific checks：S5 tsc/定向+全量测试/CK-08，S6 CK-09/10与获批的临时库/落盘验证；
- 更新 typed obligations 为 verified/deferred/failed；缺 evidence、目标 hash 未变化、文件集合扩大或 prior run 不匹配均 fail-closed；
- post_edit completed 仅表示 closure 验证，不签新的 edit token；若还需下一次 Edit，必须重新走新的 pre_edit；
- H0 terminal truth 保持唯一 complete/abort，token policy 必须显式禁止 post_edit 签 token。

若不同意显式双阶段，必须提出等价、可机械证明“检查发生在实际 Edit 之后”的协议；不能复用单次 pre-edit flow 的 S5/S6 名称充当证据。

## 4. 阶段义务重新分类

- `DOC_SYNC_REQUIRED`：文档更新计划/摘要可在 pre_edit 验证；实际文档产物在 post_edit 验证。不得整体塞入 post_edit。
- `CLASSIFY_COMMON_LIST_MISSING`、`PROPOSAL_PENDING_APPROVAL`：仍是 pre_edit 当前 blocking，修正 memo 后自消。
- `STATIC_QUALITY_GATE`：pre_edit 有测试计划；post_edit 才能 verified。
- `ROBUSTNESS_CORE_REQUIRED`、`HOOK_REQUIRED`：pre_edit 必须有精确 hunk/异常路径/埋点计划；post_edit 检查实际代码与测试。
- `HOOK_SIX_STAGE_HEALTH`：拆成可在本包执行的 post_edit_static/runtime 与超出授权的 production_cutover。后者记录 `deferred_out_of_scope`，绑定当前 MR 总方案/授权边界；未来 MR-5 尚未发生的批准不能被写成现有 authorization。

## 5. 重提范围必须覆盖真实调用链

当前 H2a 的 6 改 2 新增范围不完整。新报告至少评估并明确是否需要：

```text
mcp/server.ts                         # run_phase/prior_run/change_set schema、stage dispatcher、token policy调用
src/FlowEngine.ts                     # phase/state/audit/run linkage
src/StageRunner.ts                    # 真实 stage-specific condition result/evidence（若放在 runner）
src/types.ts                          # phase/obligation/identity typed contract
src/DelegateReviewer.ts               # 三分类与 UUID typed 推导
src/DualChannelSignal.ts              # 新字段校验/透传
src/ConvergenceGate.ts                # pre/post 规则、invariant、closure
src/ComplianceScorer.ts               # 只对当前 blocking/delta扣分
src/main_harness_checker.ts            # H2b identity与CK-06.5精度
src/security/flow-terminal-policy.ts   # post_edit completed 必须零 token（若现有policy不足）
data/flows/wenstaros_core_repair_flow.yaml # 仅当真实执行语义需同步；不得只改文案假装执行
```

不是要求全部修改，而是必须逐一证明“修改/不修改”的理由。精确测试文件也必须列出，不得写“对应测试”或“可选”。

H2a 与 H2b 可串行拆包，但 H2a 的 typed contract 不得在 H2b 再次破坏；两包都必须在 MR-1 前完成。若双阶段协议与 identity 贯穿高度耦合，允许重新建议合包，但须基于精确 hunk/dirty 冲突矩阵，而不是便捷性。

## 6. 现有 dirty 与回滚勘误

- `types.ts`、`DelegateReviewer.ts`、`ConvergenceGate.ts`、`FlowEngine.ts`、server、policy 等已有 H0/H1 staged dirty；`DualChannelSignal.ts` 为 unstaged、测试 untracked。
- 必须给出每个 H2 hunk 是否与 H0/H1 已验 hunk相邻/重叠的机械 diff，不接受笼统“非重叠”。
- 不得“逐 hunk 独立提交”，因为 commit 未批准；不得使用 `git revert` 处理未提交混合工作树。
- 回滚只能用保存的精确前后 diff/反向 hunk，并再次验证 H0/H1 hash/测试；禁止 checkout/reset/整文件覆盖。
- `types.ts` 当前 SHA、所有测试文件路径/SHA/存在性必须完整列出，不得写“见基线”。

## 7. 重提验收矩阵追加项

除既有 10 项外，至少增加：

1. pre_edit 完成可签 token，但 obligation 仍 planned；
2. pre_edit 的 baseline tsc/test 不能生成 post evidence；
3. post_edit 缺 prior_run/change_set、错文件、错 hash、未发生变更均拒绝；
4. post_edit 真实执行 S5/S6 handler，spy/fixture 证明不是只执行 `s3CompileCheck`；
5. S5/S6 任一命令失败时唯一 abort、零 token；
6. post_edit completed 也必须零 token；
7. final Edit 后必须有 post_edit closure，不能因没有下一次 Edit 而漏验；
8. production deferred 不执行生产库/服务，且不被记为 verified；
9. H2a 完成但 H2b 未完成时，MR-1 CK-01 仍正确拒绝；
10. H2a+H2b 完成后，全新 MR-1 pre_edit 才能取得 token；真实 MR-1 Edit 后另跑 post_edit closure。

## 8. 当前裁决与指令

> 阅读 `docs/harness-h2a-plus-second-review-pre-post-closure-corrections-2026-08-29.md`。当前 H2a 不批准实施。只读修订为显式 pre_edit/post_edit 双阶段协议，证明 Edit 后真实 S5/S6/S7 closure 和 post_edit 零 token；修正“H2a 单独解锁 MR-1”的矛盾，H2a/H2b 两包均须在 MR-1 前完成；逐一裁决 server/FlowEngine/StageRunner/types/Reviewer/DualChannel/Convergence/Scorer/checker/policy/flow YAML 的精确范围与 H0/H1 dirty 重叠。不得编辑、flow、exemption、重启、commit/push。

# Harness H2 / MR-1 Gate 0.1 只读重提任务书

- 日期：2026-08-31
- 执行仓：`D:\AI文件\harness`
- 主线：MR-1 4B 正式落位的 Harness H2 pre-edit / post-edit 最小闭环
- 当前阶段：Gate 0.1 只读勘误重提
- Owner 裁决：`STOP_GATE0_1_CORRECTION_REQUIRED`
- 本任务授权：**仅允许读取、分析和撰写 Gate 0.1 回报；不授权 Harness 源码/测试写入、flow、token/exemption、服务重启、WenStar 源码/生产库、commit/push**

## 一、必读文档与固定输入

必须逐字节读取并核验：

1. `docs/harness-h2-mr1-formal-landing-pre-post-minimal-closure-taskbook-2026-08-31.md`
   - SHA-256：`5cc661bab9d9be4265795c084e4c93fa35f23db3936d40d451a8c33c0affd8ed`
   - 大小：10,120 bytes
2. `docs/harness-h2-mr1-gate0-independent-review-and-gate0-1-mandatory-corrections-2026-08-31.md`
   - SHA-256 以 Owner 本次投递回读值为准；读不到或不一致立即停止。

只读重提前再次核对：

- branch / HEAD；
- `git status --short`，分别统计 staged / unstaged / untracked。原 Gate 0 为 28 项（17 staged + 1 unstaged + 10 untracked）；本次 Owner 文档投递会且只会新增下列 2 个 untracked 文档，因此预期为 30 项（17 staged + 1 unstaged + 12 untracked）：
  - `docs/harness-h2-mr1-gate0-independent-review-and-gate0-1-mandatory-corrections-2026-08-31.md`；
  - `docs/harness-h2-mr1-gate0-1-read-only-resubmission-taskbook-2026-08-31.md`；
- 原 Gate 0 的 12 个候选文件 SHA-256 与状态；
- 3000 / 8765 侦听 PID，仅记录，不启停；
- `run_mtgp43yy_x2z3.json` 大小与 SHA-256，不改写。

上述两个 docs-only untracked 新增是本次投递本身，不计为生产基线漂移。除此之外任一固定输入、状态项或候选文件漂移时，回报 `STOP_BASELINE_DRIFT`，不以新状态自行改写本任务。

## 二、hunk 计数勘误的唯一可接受口径

Owner 在同一仓库、同一 HEAD、Git `2.54.0.windows.1` 上执行：

```powershell
$headers = @(git diff --cached -U0 --no-color -- src/DelegateReviewer.ts |
  Select-String -Pattern '^@@ ')
$headers.Count
```

可复现结果为 `109`。对照结果为：

```text
-U0 / --unified=0 = 109
default context   = 13
--minimal -U0     = 114
--patience -U0    = 109
--histogram -U0   = 111
```

执行者先前回报的 `119/124/119/121` 在非默认算法上均恰好多 10，不得继续仅交数字。Gate 0.1 必须附：

1. `git --version`、`Get-Location`、`git rev-parse HEAD`；
2. 上述固定命令的 109 条 hunk header 原文；
3. hunk header 序列以 UTF-8 LF 连接后的 SHA-256；
4. 零宽 new range 的精确匹配式、原始列表和计数；
5. 若仍得到 119，不得强行改成 109；必须回报 `STOP_HUNK_COUNT_NON_REPRODUCIBLE`，并附原始输出、完整计数脚本和输入摘要。

六个关键 overlap（current new lines 118/373/571/632/700/718）的结论保持不变，但仍须从这份原始 header 序列重新机械证明。

## 三、Owner co-edit 方向与必须回传的 preimage

Owner 选择：

```text
CO_EDIT_DECISION = UPSTREAM_REVIEWER_PATH_A
```

方向上允许未来精确 co-edit，但本轮仍不允许写入：

- `src/DelegateReviewer.ts` current lines `118/373/571/632/700/718`；
- `mcp/server.ts` current line `407`。

Gate 0.1 对每一处必须分别回传：

- 写前完整文件 SHA-256；
- 行号与上下各至少 5 行逐字节 preimage；
- 所属 staged hunk header 及 H1 归属；
- 预定替换后的字段/语义，不要在 Gate 0.1 生成可自动应用的 patch；
- 单处反向回滚的 preimage 校验方法；
- 任一 SHA/context 漂移时的停止条件。

固定写前 SHA-256：

```text
src/DelegateReviewer.ts = e949cb51d2f4683b0d5849532f707db4fe5d140583f0bdd41970c9107bd6a7ac
mcp/server.ts           = 9578f65bd8b53756a40690c411c607ba90da2564f39a9f9fb441c3e069b0b298
```

不采用 downstream 字符串重解释，不保留两套冲突权威。

## 四、中央 phase / token 不变量

Gate 0.1 必须冻结并机械证明：

```text
run_phase='pre_edit'  -> mode='pipeline'
run_phase='post_edit' -> mode='closure'
```

最低完整链必须是：

```text
MCP schema/handler
  -> typed TriggerContext / RunState
  -> FlowEngine 初始化后不可变绑定
  -> terminal result + audit 同值透传
  -> attemptTokenIssue
  -> flow-terminal-policy
```

要求：

- `pre_edit` 只能签发与该 baseline / change set 绑定的最小 token；
- `post_edit` 只能验证 closure，即使 completed 也必须由中央 policy 以 `not_pipeline` 拒绝签 token；
- 不得在 MCP 外层临时跳过 `attemptTokenIssue`；
- 若现有 `RunMode` 类型不能表达 closure，必须明确把真实实现文件加入未来包；
- 设计跨 `server -> FlowEngine -> policy` 的可注入 spy，证明 post-edit completed 时 issue callback 为 0 次；
- 同一测试还必须证明 audit/result 的 `run_phase/mode/change_set_id/prior_run_id` 同值。

`flow-terminal-policy.ts` 只有在上述真实链成立时才可继续列为 `NO_CHANGE + VERIFY`。

## 五、字段级 PhaseLinkage 契约

Gate 0.1 必须给出一个唯一 typed contract，并对每个字段标明 producer / durable store / consumer / validator。至少覆盖：

- `run_phase: 'pre_edit' | 'post_edit'`；
- `change_set_id`，由 canonical project + approved target set + baseline snapshot + approval identity 确定性派生，不允许调用方任意复用；
- `prior_run_id`，pre-edit 必须缺省，post-edit 必须存在；
- baseline 每个 canonical target 的 `path`、`presence: present|absent`、`sha256|null`、必要的大小/文件类型/身份字段；
- 新文件的 absent 语义，禁止用空 SHA 混同；
- pre-edit token identity、issue run、目标路径集、签发时间、消费时间和消费结果；
- post-edit actual delta：before/after presence + SHA，新文件和删除都要可区分；
- 只允许 approved target set 中的 expected delta，多文件、少文件、零 delta、额外 dirty hunk 均 fail-closed；
- prior run 必须 completed、确实签发 token，token 必须已被真实 Edit 消费；
- 相对/绝对路径、大小写及 token hash alias 收敛为同一 identity；
- 唯一 durable store 与查询路径，不得只存内存。

必须冻结机器可消费的错误码集，至少区分 linkage 缺失、prior 未完成、baseline 不匹配、token 未签发/未消费、零 delta、超范围 delta、change set 不匹配。如现有 audit/token 存储无法承载，Gate 0.1 必须显式扩展未来文件范围，不得留到实施时临时扩包。

## 六、S3 / S5 / S6 真实 handler 分派

从当前 YAML、`StageRunner`、MCP 注入点和现有命令实现逐项回传：

| 阶段 | YAML stage id / condition | 未来 handler 精确函数名 | 输入 | 真实 MR-1 命令 | typed 输出/失败码 |
|---|---|---|---|---|---|
| S3 | 待只读核对 | 待冻结 | 待冻结 | 待冻结 | 待冻结 |
| S5 | 待只读核对 | 待冻结 | 待冻结 | 待冻结 | 待冻结 |
| S6 | 待只读核对 | 待冻结 | 待冻结 | 待冻结 | 待冻结 |

不接受“stage-specific dispatch”一句带过。必须用注入 spy/fixture 设计证明 S3/S5/S6 各调自己 handler 且不会调其他 handler；不能通过测试中仿写一个 dispatcher 代替真实 `StageRunner.execute/runLocal` 链。

## 七、typed attribution / obligation 唯一权威

必须给出字段级 discriminated union，禁止以 violation 文本、rule name substring 或 legacy boolean 重算归因。

Attribution 类别固定为：

```text
current_change_blocking
implementation_obligation
inherited_baseline_debt
unknown_attribution
```

Obligation 状态固定为：

```text
planned
verified
deferred_out_of_scope
failed
```

Gate 0.1 必须表格化说明：

- 各 variant 必填字段、stable identity、source stage/rule、evidence refs；
- pre-edit / post-edit 各允许哪些 obligation 状态与转换；
- 什么情况计入当前阶段 blocking score；
- `unknown_attribution`、缺字段、重复 identity、legacy/typed 冲突时的 fail-closed 结果；
- `uuid_chain_broken` 如何只从专属 typed CK-01 身份推导；
- 唯一数据流：`types -> DelegateReviewer/main_harness_checker -> DualChannelSignal -> ConvergenceGate -> ComplianceScorer -> audit`；
- 五个固定 obligation 在 Reviewer 源头如何分类，不得在下游按字符串撤销 `passed=false`。

## 八、audit 事实勘误与 terminal 联合链

固定事实：

```text
AUDIT_FACT = VALID_UTF8_JSON_READER_DEFAULT_MISDECODE
```

必须保持：

- 不改写、不迁移 `run_mtgp43yy_x2z3.json`；
- 不加 BOM；
- PowerShell 读取验证统一显式 `Get-Content -Raw -Encoding UTF8`；
- 新 audit 使用 canonical UTF-8 bytes，并冻结 SHA-256/HMAC 的先后顺序；
- 同目录 temp + flush/close + atomic replace，失败不留可被误认为完成的半文件；
- 写失败不得只 log，必须贯穿 `AuditLogger -> FlowEngine -> MCP terminal result -> token policy`；
- 联合验收必须证明 audit 写失败时不返回 completed truth、`token_issued:false`、issue callback 0 次、不存在半文件。

`AuditLogger` 原子 writer primitive 可以作为实施顺序的第一步，但 H2-J 在 FlowEngine/MCP 接线完成前不得独立声称完成。

## 九、无 wildcard 文件与测试矩阵

Gate 0.1 必须给出最终实施包的所有精确路径，并至少对下列测试路径逐一裁决为新建/改现有/不需要，不得使用 `*.test.ts` 或“对应测试”：

```text
src/__tests__/flow/phase-linkage.test.ts
src/__tests__/stagerunner/stage-specific-dispatch.test.ts
src/__tests__/types/phase-contract.ts
src/__tests__/attribution/uuid-attribution.test.ts
src/__tests__/attribution/typed-identity.test.ts
src/__tests__/convergence/pre-post-rules.test.ts
src/__tests__/scorer/current-blocking-only.test.ts
src/__tests__/audit/audit-json-integrity.test.ts
src/__tests__/terminal/post-edit-zero-token.test.ts
```

对每个测试文件必须给出：覆盖的生产链、fixture/spies、正反例、失败码、与原任务书最低验收矩阵 1～15 的映射。还必须列出 H0/H1 既有精确回归文件与完整命令。

Gate 0.1 还必须明确回答：

- `src/security/flow-terminal-policy.ts` 是否真的 `NO_CHANGE + VERIFY`；
- `data/flows/wenstaros_core_repair_flow.yaml` 是否真的 `NO_CHANGE`；
- audit/token 存储若需真实改动，具体增加哪些生产文件；
- 每个 dirty overlap 如何定位、如何防止格式化夹带、如何单独回滚。

## 十、回报格式与停止条件

回报必须是一份新的精确 Markdown 文档，不覆盖原 Gate 0 报告。必须包含：

1. 前/后 branch、HEAD、status 与 12 候选 hash；
2. 109 hunk 可复现证据，或 `STOP_HUNK_COUNT_NON_REPRODUCIBLE`；
3. 7 处 co-edit preimage/context/回滚方案；
4. 中央 token invariant 及真实调用链；
5. PhaseLinkage 字段级 contract 和错误码；
6. S3/S5/S6 精确 handler 表；
7. attribution/obligation discriminated union 及状态机；
8. audit terminal 联合失败传播方案；
9. 最终精确生产/测试文件包、命令、回归与回滚；
10. 零写入证明。

报告末尾必须逐字为：

```text
VERDICT = READY_FOR_EXACT_IMPLEMENTATION_APPROVAL | STOP_<REASON>
CO_EDIT_DECISION = UPSTREAM_REVIEWER_PATH_A
TOKEN_INVARIANT = pre_edit:pipeline;post_edit:closure;post_edit_token_issue_calls:0
AUDIT_FACT = VALID_UTF8_JSON_READER_DEFAULT_MISDECODE
HUNK_COUNT_COMMAND = <完整命令>
HUNK_COUNT = 109 | NON_REPRODUCIBLE
NO_MUTATION_PROOF = <前后 HEAD/status/12 hashes/audit hash>
```

任一下列情形立即停止：

- 需要修改源码、测试、YAML、policy、audit 或 token 文件才能完成 Gate 0.1；
- 需要签 exemption/token、运行 flow 或重启服务；
- 需要降阈值、扩豁免、绕 Sentinel/SelfGuard；
- 需要触碰 WenStar 源码、正式落位四文件或生产库；
- branch/HEAD/status/hash/context 漂移；
- 无法证明 post-edit 发生在真实 Edit/token consumption 之后；
- 测试设计无法区分真实 handler 与共享 `s3CompileCheck`；
- 任何 commit/push 需求。

Gate 0.1 回报完成后立即停止，等待 Owner 再次审阅。`READY_FOR_EXACT_IMPLEMENTATION_APPROVAL` 不是实施授权。

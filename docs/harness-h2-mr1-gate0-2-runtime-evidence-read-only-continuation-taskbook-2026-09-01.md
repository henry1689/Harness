# Harness H2 / MR-1 Gate 0.2 运行证据重基线只读接续任务书（Claude Code）

- 日期：2026-09-01
- 正式 Harness：`D:\AI文件\harness`
- 目标 WenStar：`D:\tools\wenstar-cc`
- 主线：阿芬人物记忆改善 / MR-1 正式落位前的 pre-edit/post-edit 治理闭环
- 当前授权：`GATE0_2_READ_ONLY_RESUBMISSION_ONLY`
- 输出报告：`docs/harness-h2-mr1-gate0-2-runtime-evidence-read-only-resubmission-report-2026-09-01.md`

## 一、当前裁决与包顺序

```text
OWNER_CLOSURE_V1 = FORMALLY_DEPLOYED_BUT_GATE4_FAILED_AND_FROZEN
OWNER_CK_BASELINE_R1 = STOPPED_EVIDENCE_CONTRADICTED_AND_SCOPE_UNAUTHORIZED
NEXT_PACKAGE = H2_MR1_GATE0_2_READ_ONLY_RESUBMISSION
IMPLEMENTATION_AUTHORIZED = false
FLOW_AUTHORIZED = false
TOKEN_OR_EXEMPTION_AUTHORIZED = false
SERVICE_OPERATION_AUTHORIZED = false
WENSTAR_WRITE_AUTHORIZED = false
PRODUCTION_DB_CONTENT_ACCESS_AUTHORIZED = false
COMMIT_OR_PUSH_AUTHORIZED = false
```

本任务只授权 Gate 0.2 只读分析和一份指定报告。不得创建隔离源码候选、patch、测试文件、record、manifest、closure 或 token；不得运行正式 flow；不得启停 8765/3000；不得把 owner CK baseline R1 的六项 raw failure 转为派生 PASS。

## 二、必读文档与优先级

按下列顺序完整读取：

1. `docs/harness-owner-adopted-formal-deployment-gate4-failure-independent-review-and-gate0-2-handoff-2026-09-01.md`，13,371 bytes，SHA-256 `d6153b28575913a11578f12d7203212dd6162df5c874a4a149505f4e60171014`；
2. `docs/harness-owner-adopted-ck-exact-baseline-contract-r1-independent-stop-review-2026-09-01.md`，6,490 bytes，SHA-256 `aeef64a21e1a59f88b7121db115abb62c84cc40f17b8e824efc6403981419103`；
3. `docs/harness-h2-mr1-gate0-1-continuation-independent-review-addendum-2026-09-01.md`，6,452 bytes，SHA-256 `c1d451b5fe3445a5061d41b8add114550ff6890cabf3d0db5add9464862392ef`；
4. `docs/harness-h2-mr1-gate0-1-independent-review-and-gate0-2-correction-decision-2026-09-01.md`，8,643 bytes，SHA-256 `d02cec02dc53c66819383496fc6bd249bc382e56bd8af370bb4b548e7cb74f6e`；
5. `docs/harness-h2-mr1-gate0-1-claudecode-independent-read-only-continuation-report-2026-09-01.md`，21,420 bytes，SHA-256 `74afcc9fab45f0b954faa840f38fe046d568766ab993b5e33663c66ee002884b`；
6. `docs/harness-owner-adopted-ck-exact-baseline-contract-r1-taskbook-2026-09-01.md`，17,633 bytes，SHA-256 `e04f47a75919a7b69b35fe26ad3d7590bc0727f63186852bad4f16ab0ed5a8bf`，只作被停止的设计证据，不作执行授权。

若内容冲突，以上顺序靠前者优先；本任务书只定义 Gate 0.2 的执行格式，不推翻前两份事实/停止裁决。

## 三、写前实时门

写报告前先只读核对，不得把本节预期当作事实：

### 3.1 Harness

预期：

```text
branch = main
HEAD = 737374ac678b176ae518b0d302d5e6fd6c604b0c
status before this taskbook delivery = 44 items
status after this taskbook delivery only = 45 items
```

owner-closure 正式冻结 SHA：

```text
b8c074433bd437e613e76d506fbedd38da0dcfafb4a60d1a59ac2963742e0b78  src/ConvergenceGate.ts
5714c87029695fb6426526693d42a7b243d416acfd42f128d8aca03a6ced5681  mcp/server.ts
3f939ed36f28965cdb1699567def3f1ba1b66d06945fc3e239740b11e83d0722  scripts/harness-cli.cjs
bf7c5b9aaa759b80fbd0234fe81d674b579798ec98e11bd8bf11d62381760fe5  scripts/owner-closure-core.cjs
3e75233e684f4eae82ccab828ce7fe9757239dd865cd5276d8e60f0a97e01110  src/__tests__/OwnerAdoptedClosure.test.ts
3d17339fcd926cc7189ebf1b5599fcc7bca7e2c3397dea1b68fab8163bacccb9  tests/security/owner-closure-core.test.ts
```

逐文件回报这些 SHA、status、staged/unstaged ownership 和相对 HEAD 的 hunk；不得删除、回退、格式化或吸收三项新文件与 `data/owner-closures/`。

### 3.2 WenStar

预期：

```text
branch = feat/40d-perception
HEAD = c436cb02b2c503a4e91a58861e903a4559dc4dc6
```

MR-1 正式四路径仍须按 R4 冻结基线核对；G1-A3f1-R2 五个 owner-adopted 文件也须逐项回报当前 SHA，但不得修改。若任何目标 SHA 漂移，只报告与 H2/MR-1 的关系，不自行恢复。

### 3.3 服务与生产库

预期只作诊断：8765 为 PID `18796` 且 health ok；3000 closed。PID/端口必须实时复核，变化本身不是源码漂移。

生产库只允许读取文件 `size/mtime`，禁止打开、查询、哈希、复制或写入正文。前次最终元数据是 15,605,760 bytes、mtime `2026-09-01T13:00:22.2015850Z`；任何变化只记录为 `EXTERNAL_ENVIRONMENT_ACTIVITY`，不得停止未知进程。

### 3.4 漂移处理

若 shared source、WenStar 目标或必读文档 SHA 不符，报告 `STOP_BASELINE_DRIFT`。只有新增本任务书、执行者指定报告、仓外只读证据，或不重叠的并发文档时，可以完整列出后继续；不得把新状态静默改写成旧基线。

## 四、119 hunk 与共享文件新 preimage

`src/DelegateReviewer.ts` staged UTF-8 原始 `-U0` canonical 仍采用：

```text
count = 119
headers encoding = UTF-8
separator = LF
final LF = exactly one
SHA-256 = 74f176edaf9b54412387cb35b10645e9f7293b3dbd7169c208918d5537a97f0d
```

必须重新从 Git 原始字节生成并附上 119 条 header 全文。PowerShell 5.1 默认管道的 109 仅为 CP936/UTF-8 有损诊断，禁止参与 ownership、CAS 或摘要。

重新提取七处既定 co-edit preimage：DelegateReviewer 当前 lines 118/373/571/632/700/718 与 server 原 handler；逐字节报告 current content、staged ownership、目标 symbol、反向校验与新 preimage SHA。server/Convergence 必须以 owner-closure 正式 SHA 为起点，不能复用部署前 `9578f65b…` / `7fd4f229…`。

## 五、运行失败证据的只读机械分析

必须读取三个永久 failed record 与两份权威 audit：

```text
oc_9e58f101ee58faa1 -> run_mtilufce_qegj
oc_280f94b3faef90e2 -> run_mtin24i5_rgju
oc_ebb81bca74c74db8 -> run_mtino16d_2ehe
```

至少完成：

1. 逐轮对照两份 audit 的 S3、S4、S4.5 输入/输出，证明 S4 精确五 blocker、`confirmations_missing=[]` 与 closure exact application；
2. 列出 79%/16-of-23 与 83.9%/17-of-23 相差的确切 CK、raw finding、producer、调用路径、cache/timeout/cwd/枚举依赖；不能只写“可能非确定”；
3. 定位两次 S3 30 秒 timeout 后又通过的执行函数、child process、timeout owner、退出码/stdout/stderr 丢失点；
4. 解释为何客户端 60 秒 timeout 时 server 继续运行，并绘制 issue/claim/run/terminal 查询与重试的真实状态机；
5. 列出第二 closure 的现有 provenance 字段与缺失字段；证据不足就写 `UNKNOWN_CONCURRENT_ACTOR`，不得猜测身份；
6. 说明生产库在 3000 closed 时变化如何作为 external typed blocker 进入 audit，而不把它误归因给当前 flow。

允许在 `D:\tmp` 使用当前源码、audit/memo 的只读副本做直接 checker/replay，允许把命令输出写入新的临时证据文件；禁止运行 `harness_run_flow`、issue/claim closure、触发 token、修改 record 或访问生产数据库正文。每个临时证据必须列路径、bytes、SHA-256、创建时间和保留状态。

若同一冻结输入连续 replay 仍不稳定，报告 `STOP_CHECKER_NONDETERMINISTIC`，但继续完成不依赖动态结果的静态文件/合同分析；不得用多数票选择 baseline。

## 六、唯一 typed phase / attribution / obligation 合同

必须给出无占位、字段级 discriminated union，并固定唯一 producer/store/consumer/validator：

1. `phase=pre_edit|post_edit`，对应 `mode=pipeline|closure`；
2. signed approval/baseline snapshot/change set/完整目标集；
3. inherited baseline debt、approved planned delta、actual current delta、current blocking 分离；
4. CK identity、raw finding、attribution、obligation 与 terminal decision 不得由下游字符串重算；
5. post-edit closure 中中央 token policy 的 issue callback 调用次数必须为 0；
6. pre-edit token 的真实消费事实必须组级、原子、签名且可与 actual delta 联结；
7. audit/result/token 任一持久化失败时三者统一 fail-closed；
8. external environment activity 只能成为显式 blocker，不成为豁免或隐式数据库动作。

必须为所有 union 分支给出稳定机器码、非法状态、转移条件、回滚/停止条件和字段级测试映射。

## 七、生产文件与 token/audit 消费链逐项裁决

每个真实文件只能裁决为 `MODIFY / NO_CHANGE+VERIFY / OUT_OF_SCOPE`，并给出理由、symbol、读写字段、测试和 dirty overlap。至少覆盖：

```text
src/types.ts
src/FlowEngine.ts
src/DelegateReviewer.ts
src/main_harness_checker.ts
src/DualChannelSignal.ts
src/ConvergenceGate.ts
src/ComplianceScorer.ts
src/DesignStandards.ts
src/StageRunner.ts
src/AuditLogger.ts
mcp/server.ts
data/flows/wenstaros_core_repair_flow.yaml
src/security/flow-terminal-policy.ts
.claude/harness-post-check.cjs
src/security/token-types.ts
src/security/token-store.ts
src/security/token-verify.cjs
src/security/hmac-token.ts
.claude/harness-pre-check.cjs
scripts/harness-gate.cjs
sentinel/sentinel-mcp-client.cjs
tests/security/token-store.test.ts
tests/security/hmac-token.test.ts
```

若实际文件名不同，先用生产调用链证明真实路径再裁决；禁止写“相关实现”“对应测试”“待确认”。任何新增生产或测试文件也必须在报告中一次性冻结，不能留到实施期扩包。

owner-closure 六文件必须逐项给出 `FROZEN_EXTERNAL_DEPLOYED_PACKAGE` 或必要共享 co-edit 说明；禁止由 H2 删除、回退、改规则集合或引入 CK effective-pass。

## 八、S3/S5/S6 与 MR-1 正式验证命令

分别冻结 S3、S5、S6 的独立 handler，不得继续共享忽略 `stageId` 的 `s3CompileCheck`。每个 handler 必须明确：

- 工作目录与绝对执行器；
- 精确 argv，不经过 PowerShell 文本重组；
- 输入文件/fixture 和输出 schema；
- timeout 及超时后的 child-tree 处理；
- exit code、signal、stdout/stderr、duration/cache 的审计字段；
- 生产库禁止访问/写入的机械保护；
- 稳定机器失败码；
- 对应已有测试与拟新增测试的精确路径。

命令矩阵必须绑定 MR-1 正式四路径和 R4 已验收项目：guard 定向、锚点身份与 messageId 冻结回归、`src/m2` 回归、全项目 TypeScript、四路径 diff check、延迟 SHA 复核、生产库仅 size/mtime 双采样。禁止用无参数 `npx vitest run`、文本 `grep`、“专项可选”或“前置自检”代替真实命令。

## 九、MCP idempotency、audit 与 token terminal truth

冻结完整字段和生产路径：

1. `request_id/change_set_id/manifest_id` 的唯一性与签名归属；
2. MCP `accepted -> running -> terminal` 异步语义和只读查询；
3. 同 manifest/change set 最多一个 active run/closure，timeout/断线后的安全恢复；
4. issue/claim/operator provenance 与 unknown actor 表达；
5. 每轮逐 CK raw input/result/command/timeout/cache/attribution 的原子 audit；
6. audit 写失败如何阻止 result success 与 token；
7. token payload、HMAC、pre-check、post-check、group consumed record、兄弟 token 处理和 actual delta 联结；
8. 唯一 `flow_complete` 或 `flow_abort`，record/audit/MCP response/token filesystem 四方终态一致。

不能只扩展 `AuditLogger.ts` 或 `token-store.ts`；必须证明全部 producer、signer、verifier、consumer 与清理者。

## 十、报告格式与停止条件

报告必须包含：

- 写前/写后 branch/HEAD/status、全部并发新增项；
- 119 headers 全文与 canonical hash；
- 七处 preimage、共享文件新 SHA/hunk/ownership；
- 运行失败逐轮对照与确切差异 CK；
- 最终 typed contract、状态机、机器码；
- 每个生产/测试/保护文件的唯一裁决；
- S3/S5/S6 精确命令矩阵；
- MCP/audit/token 消费链；
- `D:\tmp` 证据清单与零源码写入证明；
- 候选实施包的精确最大边界，但不得创建候选。

出现以下任一情况立即停止源码方向，只回报证据：

- shared/WenStar target/必读文档 SHA 漂移；
- replay 非确定；
- 无法确定唯一 producer/consumer；
- 需要用 CK ID/finding baseline 把 raw failure 改为 pass；
- 需要修改全局阈值、score 或扩大 owner 五规则；
- 需要运行正式 flow、签 record/token、启停服务或访问生产库正文；
- 文件包仍含占位或实施期扩包入口。

报告最终 verdict 只能选：

```text
READY_FOR_OWNER_H2_GATE0_2_IMPLEMENTATION_SCOPE_REVIEW
STOP_BASELINE_DRIFT
STOP_CHECKER_NONDETERMINISTIC
STOP_SCOPE_OR_CONTRACT_INCOMPLETE
STOP_OWNER_EXCEPTION_REQUIRED
```

回报后立即停止，等待 Owner 独立审阅。即使 `READY` 也不等于 H2 实施授权。

```text
GATE0_2_READ_ONLY_AUTHORIZED = true
REPORT_ONLY_REPO_WRITE_AUTHORIZED = true
TEMP_EVIDENCE_WRITE_AUTHORIZED = true
HARNESS_SOURCE_OR_TEST_WRITE_AUTHORIZED = false
OWNER_CLOSURE_V2_OR_CK_BASELINE_AUTHORIZED = false
FLOW_AUTHORIZED = false
TOKEN_OR_EXEMPTION_AUTHORIZED = false
SERVICE_OPERATION_AUTHORIZED = false
WENSTAR_WRITE_AUTHORIZED = false
PRODUCTION_DB_CONTENT_ACCESS_AUTHORIZED = false
COMMIT_OR_PUSH_AUTHORIZED = false
```

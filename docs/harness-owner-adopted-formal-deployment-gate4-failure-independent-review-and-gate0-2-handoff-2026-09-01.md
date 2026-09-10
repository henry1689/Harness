# Harness owner-adopted 正式落位与 Gate 4 失败独立验收及 Gate 0.2 接续裁决

- 日期：2026-09-01
- 主线：G1-A3f1-R2 / 阿芬人物记忆改善最终治理收口
- Harness：`D:\AI文件\harness`
- WenStar：`D:\tools\wenstar-cc`
- 最终裁决：`STOP_GATE4_OWNER_CLOSURE_NORMAL_PASS_PRECONDITION_FALSE_AND_NON_REPRODUCIBLE`
- 后续入口：Harness H2 / MR-1 Gate 0.2 只读重基线与完整补证

## 一、结论

owner-adopted closure 六文件已经正式落位，密码门、manifest 精确绑定、五规则精确移除、一次性状态推进和失败不签 token 等机械机制均实际生效；正式 Harness 回归、TypeScript、diff/whitespace 及重启健康检查也已通过。

但 Gate 4 没有关闭。真实运行证明任务书所依赖的前提——“精确移除五个已批准的 S4 blocker 后，现有普通收敛链会自然到达 `PASS`”——不成立。同一五文件、同一证据和同一 closure 语义在 S4.5 仍只能得到 79% 或 83.9%，七轮后均以 `retry_limit` 失败；没有任何新 token。与此同时，同一输入的 CK/评分结果发生无源码变化的波动，S3 TypeScript 检查出现先超时后通过，并出现来源尚未归属的第二次 closure/run 与持续的生产库元数据活动。

因此本轮必须安全停止，不得扩大 owner 规则、降低阈值、人工写 token、继续重试或据此落位 WenStar。owner-closure 包以“正式部署成功、业务 Gate 4 失败”结案，运行证据进入 H2 Gate 0.2；H2 仍只获只读补证授权，不获源码实施授权。

## 二、正式落位与静态验收

### 2.1 写前门与范围

正式部署前已核对：

- Harness `main@737374ac678b176ae518b0d302d5e6fd6c604b0c`；
- WenStar `feat/40d-perception@c436cb02b2c503a4e91a58861e903a4559dc4dc6`；
- 三个既有 Harness 目标写前 SHA 与任务书完全一致；
- 三个新增目标写前状态与任务书一致；
- manifest 绑定的五个 G1-A3f1-R2 文件及 SHA 完全一致；
- 3000 无监听；未读取或写入生产数据库正文。

只落位任务书批准的六个 Harness 文件。正式结果 SHA-256：

| 文件 | 正式 SHA-256 |
|---|---|
| `src/ConvergenceGate.ts` | `b8c074433bd437e613e76d506fbedd38da0dcfafb4a60d1a59ac2963742e0b78` |
| `mcp/server.ts` | `5714c87029695fb6426526693d42a7b243d416acfd42f128d8aca03a6ced5681` |
| `scripts/harness-cli.cjs` | `3f939ed36f28965cdb1699567def3f1ba1b66d06945fc3e239740b11e83d0722` |
| `scripts/owner-closure-core.cjs` | `bf7c5b9aaa759b80fbd0234fe81d674b579798ec98e11bd8bf11d62381760fe5` |
| `src/__tests__/OwnerAdoptedClosure.test.ts` | `3e75233e684f4eae82ccab828ce7fe9757239dd865cd5276d8e60f0a97e01110` |
| `tests/security/owner-closure-core.test.ts` | `3d17339fcd926cc7189ebf1b5599fcc7bca7e2c3397dea1b68fab8163bacccb9` |

manifest 为 1,231 bytes，SHA-256：

```text
00b8063649da9818c5712de7c5586a93461e9a8fa02eda9982300c34d4bc7adc
```

### 2.2 验证结果

- 正式 Harness `src/__tests__ + tests/security`：14 files、190/190 passed；
- `tsc -p tsconfig.json --noEmit`：exit 0；
- 三个 tracked 目标 `git diff --check`：exit 0；
- 三个新增文件：尾随空白计数 0；
- 延迟复核六个 SHA：全部稳定；
- 8765 从 PID `31312` 受控重启为 PID `18796`；
- `/sentinel/health` 返回 `status=ok`、`server=harness-mcp`、`version=2.1.0`；
- 3000 始终无监听。

任务书记录的 10 files / 131 tests 是隔离候选当时基线；正式工作树当前合集为 14 files / 190 tests。二者不是测试失败或少跑，而是现场测试集合增长。

## 三、正式 closure 与 flow 结果

### 3.1 本轮主 closure

```text
closure_id    = oc_280f94b3faef90e2
attempt_id    = oca_7b49025947403a47
run_id        = run_mtin24i5_rgju
issued_at     = 2026-09-01T12:04:57.612Z
claimed_at    = 2026-09-01T12:23:39.086Z
finished_at   = 2026-09-01T12:27:36.389Z
status        = failed
failure_reason= retry_limit
token_issued  = false
```

本地只读审计副本 `/tmp/run_mtin24i5_rgju.json` SHA-256：

```text
9288042e0b55481ad2d09bd0405b4d4b214f590d83876502512d91667833767e
```

证据 memo `/tmp/run_mtin24i5_rgju_memo.md` SHA-256：

```text
591e40b1fa372bf519d3b62335a5223b58ee5dc18c7ce2c20ab70c2b37d0d67b
```

S2 已批准，S4 自动检查实际形成且仅形成下列五个获批 blocker：

```text
DOC_SYNC_REQUIRED
STATIC_QUALITY_GATE
ROBUSTNESS_CORE_REQUIRED
HOOK_REQUIRED
HOOK_SIX_STAGE_HEALTH
```

20 个确认项全部满足，`confirmations_missing=[]`。日志证明 owner closure 对五项进行了精确命中与应用，没有移除其他 blocker，也没有使用 `HUMAN_BYPASS`。但 S4.5 七轮均未达到普通 `PASS`，最终失败且没有签发 token。

调用端 SDK 在 60 秒处超时，但 server 继续执行并把同一 run 正确推进到失败终态。本轮没有因为客户端超时而人工重试。

### 3.2 并发出现的第二 closure

只读审计另发现：

```text
closure_id    = oc_ebb81bca74c74db8
run_id        = run_mtino16d_2ehe
issued_at     = 2026-09-01T12:32:53.478Z
claimed_at    = 2026-09-01T12:40:41.319Z
finished_at   = 2026-09-01T12:43:21.282Z
status        = failed
failure_reason= retry_limit
token_issued  = false
```

其只读审计副本 `/tmp/run_mtino16d_2ehe.json` SHA-256：

```text
af2da41599b015572875f558d97bc6ed7fcb88c189288cebd891d7599bab3cff
```

该 closure 同样绑定精确五文件、同一 S2 证据和 20 个确认项，并实际应用 owner closure，最终仍以七轮 `retry_limit` 失败、零 token。它需要 owner 密码，且不是本独立验收脚本签发；当前证据不足以判定具体操作来源，故只记录为并发外部动作，不做越权归因。

当前 owner closure 状态全集还包含更早的失败记录：

```text
oc_9e58f101ee58faa1 -> run_mtilufce_qegj -> failed/retry_limit/token_issued=false
```

三条记录均已终止，没有成功或仍可消费的 closure。

## 四、普通收敛前提被证伪

### 4.1 同输入评分不稳定

主 run 的七轮 S4.5 记录为 79%。并发 run 首轮为 79%，后续为 83.9%。使用当前正式 `DelegateReviewer`、`ConvergenceGate`、同一 memo 和同一状态做只读机械 replay，结果为 83.9%、17/23，并稳定复现六项未满分检查：

| 检查 | replay 结果 |
|---|---|
| DS-02 | PFC thin scheduler，60 |
| DS-05 | SQLiteAdapter unique persistence channel，60 |
| DS-23 | systemic/common-vs-specific full-repo analysis，60 |
| DS-06 | meeting-name points，85 |
| DS-10 | high-risk full import assessment，85 |
| DS-15 | two-layer static/robustness quality，85 |

主 run 的 79% 对应 16/23，replay 与并发 run 的 83.9% 对应 17/23；在目标源码、manifest 与 S2 输入不变时仍相差一个 CK 结果。这证明当前收敛评分至少存在 timeout、cache、工作目录/执行环境或隐式状态之一的非确定性。审计没有保存足够的逐 CK 原始命令、stdout/stderr、退出码、timeout/cache key 与归因细节，现阶段不能再通过重试猜测哪一次分数才是“正确值”。

### 4.2 stage handler 的运行时问题

主 run 中两次 S3 TypeScript 检查在 30 秒处超时，后续轮次又通过。当前 S3/S5/S6 共享 `s3CompileCheck` 且忽略 `stageId`，不能为不同阶段提供稳定、可审计、与 MR-1 精确命令绑定的结果。这与 Gate 0.1 已指出的 handler 缺口一致，并已从设计风险变成真实运行证据。

### 4.3 MCP 请求终态不可安全推断

客户端 60 秒超时不代表 server 终止；server 后续继续执行约数分钟并形成终态。若客户端或操作者把超时当成失败并重发，会产生重复 closure/run。MCP 入口当前需要显式的 request/idempotency key、异步 accepted 状态、只读查询接口以及“一个 manifest/change set 同时最多一个 active closure”的约束。

## 五、生产环境停止条件

生产库只做文件元数据采样，未读取、查询、哈希或修改正文：

| 时点 | size | mtime |
|---|---:|---|
| 部署前冻结值 | 14,041,088 bytes | `2026-08-31T12:18:59Z` |
| 重启/签发后已观察值 | 14,147,584 bytes | `2026-09-01T12:14:27Z` |
| 最终只读快照 | 15,605,760 bytes | `2026-09-01T13:00:22.2015850Z` |

最终快照时 3000 仍无监听，8765 为 PID `18796` 且健康。生产库在 3000 关闭时仍持续发生外部元数据变化，说明存在尚未归属的其他写入者或任务。任务书明确把“生产库继续活动”列为停止条件，因此即使评分后来偶然达到 PASS，也不能在未澄清写入来源前宣称 Gate 4 完成。

本裁决不授权打开数据库正文、停止未知进程或清理数据；这些动作需要单独范围和授权。

## 六、最终现场与零越界说明

最终只读快照：

```text
Harness branch/head = main@737374ac678b176ae518b0d302d5e6fd6c604b0c
Harness status count= 41
8765                = LISTENING PID 18796, health ok
3000                = closed
successful closures = 0
new tokens          = 0
```

41 项中 owner 包对应 tracked 状态为 `MM mcp/server.ts`、` M scripts/harness-cli.cjs`、`MM src/ConvergenceGate.ts`，三个新文件为 untracked；运行时新增 `data/owner-closures/`。这些状态没有被 commit/push。未修改 WenStar 五个 owner-adopted 文件，未启动 3000，未人工写 token，未扩大五规则，未读取或写入生产数据库正文。

## 七、owner-closure 正式结案方式

```text
OWNER_CLOSURE_DEPLOYMENT = PASS
OWNER_CLOSURE_MECHANICAL_CONTRACT = PASS
OWNER_CLOSURE_EXACT_FIVE_RULE_APPLICATION = PASS
NORMAL_PASS_PRECONDITION = FALSE
S4_5_REPRODUCIBILITY = FAIL
FINAL_FLOW = FAILED_RETRY_LIMIT
FINAL_TOKEN_COUNT = 0
GATE4 = OPEN_STOPPED
```

保留六文件正式现场作为 H2 共享文件新基线，不删除、不回退、不吸收为 H2 所有，也不继续签发 owner closure。Gate 4 的失败不能被描述为 owner 机制没有生效；准确描述是：机制生效后暴露了五规则之外的普通收敛缺口与运行时非确定性。

## 八、Gate 0.2 强制接续项

Gate 0.2 必须先按正式落位后的共享文件重新冻结 preimage/hunk，至少包括：

```text
mcp/server.ts            5714c87029695fb6426526693d42a7b243d416acfd42f128d8aca03a6ced5681
src/ConvergenceGate.ts   b8c074433bd437e613e76d506fbedd38da0dcfafb4a60d1a59ac2963742e0b78
scripts/harness-cli.cjs  3f939ed36f28965cdb1699567def3f1ba1b66d06945fc3e239740b11e83d0722
```

三个新增 owner 文件/测试继续作为冻结外部已部署包记录，不归 H2 任意改写：

```text
scripts/owner-closure-core.cjs
src/__tests__/OwnerAdoptedClosure.test.ts
tests/security/owner-closure-core.test.ts
```

除既有 Gate 0.2 十项补证、token 消费链、typed consumer 与 audit 精确路径要求外，必须新增以下运行时闭环：

1. 以 discriminated union 表达 inherited baseline debt、approved/planned delta、actual current delta 与 current blocking；普通 pre-edit authorization 不再把尚未发生的 post-edit 结果当作当前失败。
2. CK 事实只由唯一 typed producer 产生并贯穿 Reviewer、DualChannelSignal、ConvergenceGate、ComplianceScorer 与 audit；禁止下游从字符串或 legacy boolean 重算。
3. S3/S5/S6 使用各自真实、确定、绑定 MR-1 四路径的 handler；冻结 cwd、输入、timeout、退出码、stdout/stderr 摘要、cache policy 与禁止生产写路径机制。
4. audit 原子保存每轮每个 CK 的 typed input、raw result、归因、obligation、命令结果和 terminal truth；写失败必须贯穿 FlowEngine/MCP 终态并 fail-closed。
5. token 记录与真实 post-check 消费链必须签名绑定 change set、完整目标集、baseline、actual delta、approval identity 与一次性消费结果。
6. MCP flow/closure API 增加 request idempotency、accepted/running/terminal 查询语义、客户端 timeout 后安全恢复，以及同 manifest/change set 单 active closure 约束；并审计发起者、claim 者和 provenance。
7. 生产库活动只能作为 typed external-environment blocker 记录；不得由 Harness 自动读取正文、停止未知 writer 或把元数据波动静默归因给 WenStar 3000。
8. 不得把本次六项 DS 缺口加入 owner 例外，不得降低 90% 阈值，不得把 retry 当作一致性策略。

## 九、授权边界与下一动作

唯一下一动作是：由 Gate 0.2 执行者基于本报告、`c1d451b5…92ef` 补充裁决及 `d02cec02…4f6e` 前置裁决，提交只读重基线与完整字段/文件/命令补证报告，然后停止等待 Owner 独立审阅。

在 Gate 0.2 通过前继续禁止：

- 修改 Harness/H2 源码或测试；
- 再签 owner closure、运行 flow、生成或补写 token；
- 启停 8765 或 3000；
- 修改 WenStar 或正式落位 MR-1；
- 读取/修改生产数据库正文；
- commit/push；
- 清理本轮 closure/audit/临时证据。

```text
VERDICT = STOP_GATE4_OWNER_CLOSURE_NORMAL_PASS_PRECONDITION_FALSE_AND_NON_REPRODUCIBLE
OWNER_CLOSURE_FORMAL_PACKAGE = DEPLOYED_AND_VERIFIED
OWNER_CLOSURE_RUNTIME_APPLICATION = VERIFIED_EXACT_FIVE
OWNER_CLOSURE_RETRY = FORBIDDEN
GATE4_CLOSED = false
TOKENS_ISSUED = 0
PRODUCTION_DB_CONTENT_ACCESSED = false
H2_GATE0_2_READ_ONLY_RESUBMISSION_AUTHORIZED = true
H2_IMPLEMENTATION_AUTHORIZED = false
WENSTAR_MR1_FORMAL_LANDING_AUTHORIZED = false
```

# Harness owner-adopted CK 精确基线合同 R1 任务书（Claude Code）

- 日期：2026-09-01
- 正式 Harness：`D:\AI文件\harness`
- 目标 WenStar：`D:\tools\wenstar-cc`
- 任务性质：安全合同修订；先 Gate 0 只读取证，Owner 独立批准后才能实施
- 当前授权：`TASKBOOK_DELIVERY_ONLY`

## 一、当前裁决

```text
VERDICT = STOP_OWNER_CLOSURE_CONTRACT_INCOMPLETE
IMPLEMENTATION_AUTHORIZED = false
FLOW_AUTHORIZED = false
TOKEN_OR_EXEMPTION_AUTHORIZED = false
SERVICE_OPERATION_AUTHORIZED = false
WENSTAR_SOURCE_WRITE_AUTHORIZED = false
H2_MR1_AUTHORIZED = false
COMMIT_OR_PUSH_AUTHORIZED = false
```

本任务书的交付不等于实施授权。Claude Code 收到后只能先执行第八节 Gate 0 只读取证；必须回报并等待 Owner 明确给出 `IMPLEMENTATION_AUTHORIZED=true` 及最终文件范围/写前 SHA 后，才能进入候选实现。

## 二、问题事实与失败证据

既有 owner-adopted closure 已正确实现密码门、五路径/五 SHA/五规则绑定、一次性状态机和普通 H0 token policy，但合同只处理 S4 Reviewer 五项 blocking，没有处理冻结基线在 S4.5 中已存在的 CK 结果。

2026-09-01 最终实流：

```text
closure_id = oc_ebb81bca74c74db8
attempt_id = oca_fc220e80f0f4d03c
run_id = run_mtino16d_2ehe
status = failed
failure_reason = retry_limit
token_issued = false
```

权威审计：

```text
D:\AI文件\harness\data\audit\2026-09-01\run_mtino16d_2ehe.json
```

机械复现结论：

1. S4 `review_details.blocking` 恰为以下五项，`confirmations_missing=[]`；
2. `applyOwnerAdoptedClosure` 已精确应用五项，没有额外 S4 blocker 或 typed invariant；
3. S4.5 原始 CK 得分稳定为 `83.9%`、`17/23`，未达到普通 `PASS >=98% 且 23/23`；
4. 当前代码明确要求 closure 移除五项后仍达到普通 PASS，因此每轮返回 `OWNER_CLOSURE_NORMAL_PASS_REQUIRED`，最终 retry limit；
5. 客户端 60 秒 timeout 只导致调用方提前失去响应，服务端仍完整运行到上述终态，不是失败根因。

五项 S4 blocking：

```text
DOC_SYNC_REQUIRED
STATIC_QUALITY_GATE
ROBUSTNESS_CORE_REQUIRED
HOOK_REQUIRED
HOOK_SIX_STAGE_HEALTH
```

六项原始 CK 基线：

| CK | severity | 当前确定性证据 |
|---|---|---|
| `CK-02` | fail | `src/webui/chat.ts` 3207 行，超过 2000 行薄调度阈值 |
| `CK-05` | warn | `MEETING_PROP_POINTS` 中 L0/L1/L3/L12 四项编目行号漂移 47/334/331/395 行 |
| `CK-06` | fail | `persistence-stage.ts` L1060、L1078 被 checker 判为写入方法缺少 `.save()/scheduleFlush()` |
| `CK-06.5` | fail | 在 61 个额外文件发现 138 处启发式同类模式 |
| `CK-07` | warn | `chat.ts` 有 56 个 import |
| `CK-08` | warn | 五个目标中的多个函数条件分支超过当前补丁嗅探阈值 |

旧 record `oc_9e58f101ee58faa1`、`oc_280f94b3faef90e2`、`oc_ebb81bca74c74db8` 均已 failed、永久锁定，禁止删除、改写或复用。

## 三、目标与非目标

### 3.1 唯一目标

把 owner closure 从“只签五项 S4 rule”升级为“同时签署精确 CK 观察快照”的一次性 owner-adopted baseline 合同：

- 仍只允许原五项 S4 rule；
- 新增的 CK 采用完整观察结果的规范化 SHA-256 指纹，不按 CK ID 粗粒度跳过；
- 签名 record 同时绑定 WenStar branch/HEAD/五路径/五 SHA、CK 指纹集合及 Harness runtime contract SHA；
- S4.5 永久保留原始 CK 结果，仅在签名快照逐项完全一致时生成派生评分视图；
- 派生评分视图必须达到普通 PASS，才能继续 S5/S6/S7 和既有 H0 token policy；
- 任一未签 CK、新增/减少 finding、severity/path/line/message/snippet 漂移、runtime consumer 漂移或额外 S4 blocker 均 fail-closed。

### 3.2 明确非目标

禁止：

- 把六个 CK ID 直接加入全局 exemption；
- 修改 `PASS_THRESHOLD`、`handoffThreshold`、`maxRounds` 或 flow YAML；
- 把 `HUMAN_BYPASS` 当作 owner closure PASS；
- 修改 `main_harness_checker.ts` 的阈值/启发式来迁就本基线；
- 修改 `ComplianceScorer.ts` 或 `DesignStandards.ts` 的扣分映射；
- 修改 WenStar 五文件以改变已接管 SHA；
- 自声明 MCP 参数来提供 CK 例外；
- 伪造/手写 token，复用旧 token 或旧 failed record；
- 接管 H2 / MR-1、生产数据库、3000、commit/push。

## 四、冻结基线

### 4.1 Harness 基线

预期 Harness：

```text
branch = main
HEAD = 737374ac678b176ae518b0d302d5e6fd6c604b0c
```

既有 owner-closure 六文件当前已知 SHA-256：

```text
b8c074433bd437e613e76d506fbedd38da0dcfafb4a60d1a59ac2963742e0b78  src/ConvergenceGate.ts
5714c87029695fb6426526693d42a7b243d416acfd42f128d8aca03a6ced5681  mcp/server.ts
3f939ed36f28965cdb1699567def3f1ba1b66d06945fc3e239740b11e83d0722  scripts/harness-cli.cjs
bf7c5b9aaa759b80fbd0234fe81d674b579798ec98e11bd8bf11d62381760fe5  scripts/owner-closure-core.cjs
3e75233e684f4eae82ccab828ce7fe9757239dd865cd5276d8e60f0a97e01110  src/__tests__/OwnerAdoptedClosure.test.ts
3d17339fcd926cc7189ebf1b5599fcc7bca7e2c3397dea1b68fab8163bacccb9  tests/security/owner-closure-core.test.ts
```

以上只是 Gate 0 预期值，不能替代实时读取。任一不一致必须报告 dirty ownership、完整 SHA 和相关 diff/hunk，不得覆盖。

### 4.2 WenStar owner-adopted 基线

```text
branch = feat/40d-perception
HEAD = c436cb02b2c503a4e91a58861e903a4559dc4dc6
```

```text
2e4129b7982c8e88250c5cd6bc425655bf274b3cd72514e539a9747334aa82bd  src/webui/chat.ts
e9fa8ba3cd2d5836995c298cfaae6bf991c7f0bdaf4ba5fbf97777d8c63b1e29  src/webui/chat/persistence-stage.ts
4afa091aa51e86cce11822811010e9d6c357f9979a63f0a01725c33a30077acb  src/webui/chat/__tests__/persistence-stage-turn-identity.test.ts
b3c319cac34fd30559a1448db4b29094b6b7e96b378d5d6bb0647d8daf92928f  src/webui/chat/turn-identity-dispatch.ts
08366d79a208ef77801e7ba4c292e1aa7ab9526e084cddd8ab9f50ec12b85712  src/webui/chat/__tests__/turn-identity-dispatch.test.ts
```

## 五、R1 精确数据合同

### 5.1 record/manifest schema

在既有 version 1 记录之上引入 version 2。旧记录必须可列出和验签以保留审计，但 version 1 不得进入新的 claim/token-authorized 路径。

建议字段（命名可在 Gate 0 回报中做一次机械勘误，但语义不可缩减）：

```json
{
  "version": 2,
  "ck_baseline": {
    "policy_version": "owner-adopted-exact-ck-v1",
    "results": [
      {
        "id": "CK-02",
        "severity": "fail",
        "finding_count": 1,
        "findings_sha256": "<64 lowercase hex>"
      }
    ],
    "snapshot_sha256": "<digest of the sorted six-result canonical projection>"
  },
  "runtime_contract": {
    "files": [
      { "path": "src/ConvergenceGate.ts", "sha256": "..." }
    ],
    "snapshot_sha256": "<digest of the sorted runtime file projection>"
  }
}
```

`ck_baseline.results` 必须恰为：

```text
CK-02 fail
CK-05 warn
CK-06 fail
CK-06.5 fail
CK-07 warn
CK-08 warn
```

禁止子集、超集、重复 ID、重复 digest、未知 severity、空 findings 或非 64 位小写十六进制 SHA。

### 5.2 finding canonical projection

每项 CK 指纹只能由 raw `CheckResult` 生成，至少包含：

```text
id
severity
passed
violations[]:
  file（反斜杠转 /，保持相对路径）
  line（整数；不存在为 null）
  message（原值；不得关键词化或模糊化）
  snippet（原值；不存在为 null）
```

排除 `durationMs`、时间戳、cache 命中状态等非确定性字段。violations 按 `(file,line,message,snippet)` 进行稳定排序；整体使用既有 `passCore.stableStringify` 等价的 UTF-8 canonical JSON，最终 SHA-256 小写 hex。必须以单测固定 final-LF/无 LF 语义，不允许 PowerShell 默认编码参与 hash。

### 5.3 runtime contract

签发时由 Harness 本机代码自动计算并写入 record，不能由 MCP caller 自声明。Gate 0 必须至少冻结下列消费者的实时 SHA；实施审阅可增加，不能无说明减少：

```text
src/main_harness_checker.ts
src/ConvergenceGate.ts
src/ComplianceScorer.ts
src/DesignStandards.ts
src/DelegateReviewer.ts
src/DualChannelSignal.ts
src/FlowEngine.ts
mcp/server.ts
scripts/owner-closure-core.cjs
scripts/owner-closure-ck-baseline-core.cjs
```

issue 后、claim 时及 S4.5 使用前均须重验 runtime contract。任一字节漂移返回稳定机器码并拒绝，不得降级为 warning。

## 六、运行时语义

1. `harness_run_flow` 的 MCP schema 不新增可由 caller 提交的 `ck_baseline`、`allowed_ck_ids` 或 `skip_ck`；caller 仍只能提交短 `owner_closure_id`。
2. server 从本机签名 record claim 得到 `verified:true` evidence，并把 CK/runtime 合同以 typed 字段传给 S4.5。
3. S4.5 先运行全部原始 CK；原始结果不得被覆盖、删除或改 severity。
4. 先验证 S4 原五项规则精确集合和 typed invariant，再验证 CK policy/runtime/finding snapshot。
5. 只有六项 raw CK 与签名快照完全一致且其他 CK 全部 pass，才创建新的 `effectiveCkResults` 评分视图：仅六项对应副本改为 pass/空 violations；raw 结果继续留在审计和 human report。
6. `computeComplianceScore` 只消费该轮派生视图；不得修改全局 scorer/threshold。预期有效分数必须为正常 `PASS` 且所有标准达标，不能依赖 `HUMAN_BYPASS`。
7. 若 closure active 但 snapshot 不匹配，必须注入稳定 `OWNER_CLOSURE_CK_*` 机器码并用原始 CK 评分；禁止部分匹配、部分放行。
8. 只有真实 `flow_status=completed / end_reason=completed / success=true` 后才进入既有 H0 token policy；五文件 token 必须 5/5 全部真实签发，record 才能 completed。

至少冻结以下机器码：

```text
OWNER_CLOSURE_RECORD_VERSION_UNSUPPORTED
OWNER_CLOSURE_CK_POLICY_MISMATCH
OWNER_CLOSURE_CK_RESULT_SET_MISMATCH
OWNER_CLOSURE_CK_FINDINGS_DIGEST_MISMATCH
OWNER_CLOSURE_CK_UNSCOPED_NONPASS
OWNER_CLOSURE_RUNTIME_CONTRACT_MISMATCH
OWNER_CLOSURE_NORMAL_PASS_REQUIRED
```

## 七、候选实施文件范围

Gate 0 后建议的最大候选包为八个文件：

```text
M  src/ConvergenceGate.ts
M  mcp/server.ts
M  scripts/harness-cli.cjs
M  scripts/owner-closure-core.cjs
A  scripts/owner-closure-ck-baseline-core.cjs
M  src/__tests__/OwnerAdoptedClosure.test.ts
M  tests/security/owner-closure-core.test.ts
A  tests/security/owner-closure-ck-baseline-core.test.ts
```

任何增加 `types.ts`、`main_harness_checker.ts`、`ComplianceScorer.ts`、`DesignStandards.ts`、`DelegateReviewer.ts`、flow YAML、token 消费链或 H2 文件的需求，都必须停止并提交 `SCOPE_EXPANSION_REQUIRED`，不得边做边扩大。

共享 `src/ConvergenceGate.ts` 与 `mcp/server.ts` 仍可能与 H2 未来包重叠；owner closure 未正式关闭前，H2 继续冻结。实施完成后必须重新冻结这两个文件 SHA，Gate 0.2 不得复用旧值。

## 八、Gate 0：只读取证任务

Claude Code 首轮只能执行以下只读动作：

1. 读取本任务书、原 owner-closure 任务书、三个 failed record 和 `run_mtino16d_2ehe` 审计；
2. 实时回报 Harness branch/HEAD/status、八个候选路径存在性和 SHA、所有 runtime consumer SHA；
3. 实时回报 WenStar branch/HEAD/status 与五个 owner-adopted SHA；
4. 独立复现 S4 恰为五 blocker、confirmations missing 为 0；
5. 独立运行全部 CK，回报六项 raw CheckResult 的完整 canonical projection、每项 finding count/digest 及总 snapshot digest；
6. 连续运行 canonicalization 至少 5 次，证明 digest 稳定；CK-06.5 全仓扫描顺序必须经排序消除，不得依赖目录枚举顺序；
7. 审阅八文件方案与当前 dirty hunks 的 ownership/overlap，给出精确 preimage SHA 和拟修改 symbol；
8. 回报 runtime contract 最小文件集合是否足够；如需扩大，明确原因并停止；
9. 不运行正式 flow，不 issue record，不重启 8765，不创建 token/exemption，不写任何源码/测试/manifest。

Gate 0 报告必须以以下 verdict 之一结束：

```text
READY_FOR_OWNER_CK_CONTRACT_IMPLEMENTATION_REVIEW
STOP_BASELINE_DRIFT
STOP_CK_SNAPSHOT_NONDETERMINISTIC
STOP_SCOPE_EXPANSION_REQUIRED
STOP_CONTRACT_UNSAFE
```

报告必须明确 `zero-write` 证明；报告文档本身若由 Owner 授权交付，须单独列为唯一写入。

## 九、Owner 批准后的实施顺序

只有 Owner 独立审阅 Gate 0 并明确给出实施授权后：

1. 从实时正式文件复制到仓外隔离候选目录，不从 Git HEAD 或旧 `/tmp` 候选覆盖 dirty 工作树；
2. 先实现纯 CJS canonicalization/validation helper 及全部负向测试；
3. 再扩展 record v2、issue/claim/runtime contract；
4. 再接入 ConvergenceGate 的 raw/effective 双视图；
5. 最后扩展 server typed evidence 与 CLI 只读摘要；
6. 在隔离区通过全部测试和 TypeScript 后，回报候选八文件 SHA、纯 patch、hunk/symbol 清单；
7. Owner 再次批准正式落位并亲自在本机完成 Harness self-write 解锁；Agent 不读取、保存或接收密码；
8. 正式落位前逐文件 CAS 核对 preimage SHA，任何漂移立即停止；
9. 落位后验证八文件结果 SHA、目标 diff、全量 Harness 测试及 TypeScript；
10. 服务操作需单独授权，只允许精确重启 8765，不得按映像名/端口批量杀 Node，不得触碰 3000；
11. 新 schema/heartbeat 生效后，Owner 才能通过密码门签发全新的 version 2 closure record；
12. 最终 flow 客户端必须显式设置至少 600 秒 request timeout；客户端 timeout 仍不得触发自动重试。

## 十、强制测试矩阵

### 10.1 canonicalization

- 相同 findings 不同枚举顺序得到相同 digest；
- `\` 与 `/` 路径归一后相同；
- duration/cache/timestamp 不影响 digest；
- file、line、message、snippet、severity、passed 任一改变均改变 digest；
- duplicate CK/finding、未知字段形态、绝对路径/路径穿越 fail-closed；
- CK-06.5 大集合完整纳入 digest，不得只 hash 前 10 条展示项。

### 10.2 record/core

- version 2 正常 issue/claim/authorize/finish；
- version 1 历史 failed record 可 list/验签但不可 claim；
- 六项 CK 子集、超集、重复、severity 不符拒绝；
- runtime contract 任一 SHA 漂移拒绝；
- WenStar branch/HEAD/五路径/任一 SHA 漂移拒绝；
- record replay、过期、签名篡改、并发 claim 拒绝；
- issue 不签 token，claim 不签 token。

### 10.3 ConvergenceGate

- 无 closure：原行为完全不变，六项 CK 继续阻断；
- 只有五项 S4 合同、无 CK snapshot：拒绝；
- S4 五项 + CK snapshot 完全匹配：raw 仍为 83.9/六项非 pass，effective 达普通 PASS；
- 任一 finding 少一条、多一条或文字变化：拒绝；
- 任一未签 CK 非 pass：拒绝；
- S4 多一个 blocker、少一个 blocker、duplicate blocker：拒绝；
- typed review invariant 失败：拒绝；
- runtime contract 漂移：拒绝；
- `HUMAN_BYPASS` 不得完成 owner closure。

### 10.4 H0/服务端

- completed + token 5/5 才 completed；
- retry_limit/human_denied/timeout/circuit_breaker/stage_error 一律 0 token、record failed；
- token 1～4/5、签发异常或返回矛盾一律 failed；
- caller 伪造 CK baseline 参数无效或 schema 拒绝；
- MCP 响应与 audit/record/token 文件三方终态一致；
- 单个 run 只有一个权威 `flow_complete` 或 `flow_abort`。

正式候选至少必须通过：

```text
Harness src/__tests__ 全集
Harness tests/security 全集
新增 owner closure/CK baseline 定向测试
tsc -p tsconfig.json --noEmit
git diff --check（仅目标文件）
```

不得把测试数量写死为旧 190；必须回报当时实际 files/tests 数及全部通过结果。

## 十一、最终真实验收

最终真实验收必须新建 record，旧三个 failed record 永不复用。验收前重新核对 Harness runtime contract、WenStar branch/HEAD/五 SHA、3000 closed 和 8765 健康。

唯一成功条件：

```text
S4 raw blocking rules = 精确五项
S4 confirmations_missing = []
S4.5 raw CK snapshot = 签名六项逐字节匹配
S4.5 raw score = 83.9（只作证据，不作 PASS）
S4.5 effective decision = normal PASS
flow_status = completed
end_reason = completed
success = true
token_issued = true
token_issued_count = 5
owner_closure_status = completed
```

若 checker 合法演进导致 raw score 不再恰为 83.9，应由 runtime contract SHA 漂移先行拒绝；不得自动接受“更高分”或“更少 finding”。Owner 必须重审并重新签发新快照。

最终报告必须回传：record/attempt/run ID、全部终态字段、五 token 的路径绑定/expiry（不得泄露签名秘密）、record/audit 文件路径与 SHA、五个 WenStar live SHA、八个 Harness 最终 SHA、服务 PID 前后值，以及未操作 3000/生产库/commit/push 的证明。

## 十二、立即停止条件

出现任一情况立即停止，不自动修复或重试：

- Harness/WenStar/runtime consumer 任一 SHA 漂移；
- CK snapshot 五次运行不稳定；
- 需要按 CK ID 全跳过或修改全局 checker/scorer；
- 需要扩大八文件候选范围；
- 发现额外 S4 blocker、typed invariant 或未签 CK 非 pass；
- 正式测试/tsc/diff check 失败；
- 服务重启方式或目标 PID 不明确；
- flow 客户端 timeout、MCP 断线或 record 已 claimed；
- token 数量不等于五、audit 写失败或三方终态不一致；
- H2 或其他并发包改动共享文件。

停止后只提交证据和新裁决请求，不得签第二个 record“试试看”。

# Harness H2 / MR-1 Gate 0.1 基线漂移 Owner 重基线裁决

- 日期：2026-09-01
- 执行仓：`D:\AI文件\harness`
- 主线：阿芬人物记忆改善 / MR-1 4B 正式落位
- 当前阶段：Gate 0.1 只读勘误重提
- 裁决：`ACCEPT_REBASELINE_FOR_GATE0_1_READ_ONLY_CONTINUATION`
- 授权边界：只允许继续原 Gate 0.1 的读取、分析和新回报文档写入；不授权 Harness/WenStar 源码或测试写入、flow、token/exemption、服务启停、生产库、commit/push

## 一、收到的停止回报

Claude Code 按原任务书的 fail-closed 纪律停止，回报为：

```text
D:\AI文件\harness\docs\harness-h2-mr1-gate0-1-claudecode-independent-baseline-drift-report-2026-09-01.md
```

- 大小：4,501 bytes；
- SHA-256：`898a29beeab6a9128faf78241b09ec434df9c79de8410d7e8661ee9fe6f6e0be`；
- verdict：`STOP_BASELINE_DRIFT`。

OrangePi 已直接回读并复算上述大小与 SHA-256。回报前的 33 项与回报写入后的 34 项变化、17 staged + 1 unstaged、HEAD、固定候选 SHA、audit 与端口事实均可复现。该停止行为合格，不构成执行失败。

## 二、漂移的独立归属裁决

原任务书投递后新增的 3 个 untracked 文件是另一条已获 Owner 授权的 `owner-adopted closure` 隔离候选：

| 路径 | SHA-256 | 大小 |
|---|---|---:|
| `scripts/owner-closure-core.cjs` | `bf7c5b9aaa759b80fbd0234fe81d674b579798ec98e11bd8bf11d62381760fe5` | 13,507 |
| `src/__tests__/OwnerAdoptedClosure.test.ts` | `3e75233e684f4eae82ccab828ce7fe9757239dd865cd5276d8e60f0a97e01110` | 4,121 |
| `tests/security/owner-closure-core.test.ts` | `3d17339fcd926cc7189ebf1b5599fcc7bca7e2c3397dea1b68fab8163bacccb9` | 6,536 |

独立引用扫描结果：

1. `scripts/owner-closure-core.cjs` 只被它自己的 security test 引用，未被 MR-1 Gate 0.1 的 MCP、FlowEngine、StageRunner、Reviewer、Convergence、Scorer、terminal policy 或 audit 生产链引入；
2. `src/__tests__/OwnerAdoptedClosure.test.ts` 读取既有 `ConvergenceGate.applyOwnerAdoptedClosure`，但没有改写 `ConvergenceGate.ts`；
3. 三文件没有改变原 Gate 0.1 的 12 个候选文件、固定 audit 或两份必读文档；
4. 这三文件属于另一个窗口/包，不纳入 MR-1 H2 的修改所有权，也不得借本裁决修改、删除、移动或回退。

因此，该漂移是可精确隔离的环境新增，不要求先处理或清除三文件。删除它们反而会越过其他任务所有权边界。

## 三、接受的新只读基线

本裁决接受下列 Gate 0.1 只读续办基线：

```text
branch = main
HEAD   = 737374ac678b176ae518b0d302d5e6fd6c604b0c
```

原 12 个候选面当前哈希与状态继续冻结：

| 路径 | SHA-256 | 状态 |
|---|---|---|
| `mcp/server.ts` | `9578f65bd8b53756a40690c411c607ba90da2564f39a9f9fb441c3e069b0b298` | staged M |
| `src/FlowEngine.ts` | `94b212dbf8b27d2fa5c956db39e3f1072126b7bad18ebe5611a94b51cd5fa82e` | staged M |
| `src/StageRunner.ts` | `d76c7f2036c2b3fcb20bc93974cc9e4a2f11496c19ab6f7bb076f0d5d7c77390` | clean |
| `src/types.ts` | `ae566206b9f0a5b24b2da6db36adfaa7c6bd63e7d8fa5f5537d0b8b1d588e44b` | staged M |
| `src/DelegateReviewer.ts` | `e949cb51d2f4683b0d5849532f707db4fe5d140583f0bdd41970c9107bd6a7ac` | staged M |
| `src/DualChannelSignal.ts` | `409b5851ca150858f86fdfe7c5357ae4c3e31be1759ee7beface2b29677ea558` | unstaged M |
| `src/ConvergenceGate.ts` | `7fd4f229fbee08aa9aa0d91a2f654fd09f1fdf47b76163b5bf31037484123ee5` | staged M |
| `src/ComplianceScorer.ts` | `f6c550c75ac9e6ef8f96d0938439a496d4435be24cfef37c5d9cbff57b7c4a5a` | clean |
| `src/main_harness_checker.ts` | `63646f3a66b7600105aaab82fcc1ca397d1b70291015f76d4789475f7e59e7db` | clean |
| `src/security/flow-terminal-policy.ts` | `026222875c34213a3be4d6da8e3f00e08500894ab840500a7665e3c7da822a14` | staged A |
| `data/flows/wenstaros_core_repair_flow.yaml` | `e7427482f9e123706f4eb0499910a12fdd60d950f6cb2de51ba9398d131a9439` | staged M |
| `src/AuditLogger.ts` | `465cee25980b928dd8cbfe802038cd97c898b4ab91602d04de1d2ce2acd90c77` | clean |

固定取证物继续为：

```text
data/audit/2026-08-31/run_mtgp43yy_x2z3.json
size   = 18,572 bytes
sha256 = 5043df93d477bd8df137f265652b3c83e795f19e52a6fc4f81de7b2a5df98b5b
```

状态计数按文档写入时点区分：

1. Claude 漂移回报写入后：34 项 = 17 staged + 1 unstaged + 16 untracked；
2. 本 Owner 裁决投递后：预期 35 项 = 17 staged + 1 unstaged + 17 untracked；唯一新增必须是本裁决文档；
3. Gate 0.1 完整续报写入后：预期再增加 1 个 untracked 报告，即 36 项。执行者必须同时回报写前 35 与写后 36，不能把自己的报告误判为生产漂移。

## 四、恢复 Gate 0.1 的精确指令

执行者必须重新读取：

```text
docs/harness-h2-mr1-gate0-1-read-only-resubmission-taskbook-2026-08-31.md
docs/harness-h2-mr1-gate0-independent-review-and-gate0-1-mandatory-corrections-2026-08-31.md
docs/harness-h2-mr1-gate0-1-claudecode-independent-baseline-drift-report-2026-09-01.md
docs/harness-h2-mr1-gate0-1-owner-rebaseline-continuation-decision-2026-09-01.md
```

仅以下基线规则被本裁决替换：

- 原任务书“30 项 = 17 + 1 + 12”替换为本裁决投递后的“35 项 = 17 + 1 + 17”；
- 上述 3 个 owner-adopted 文件和 Claude 漂移回报、本 Owner 裁决属于已声明 untracked；
- 其余原任务书 §二～§十、所有字段级要求、109 hunk 机械证据、7 处 preimage、token invariant、PhaseLinkage、S3/S5/S6、typed attribution/obligation、audit terminal 联合链、精确文件包、测试矩阵和停止条件全部保持不变。

若写前精确为 35 项且本裁决中的 HEAD、12 候选 SHA、3 个隔离文件 SHA、audit SHA 和四份必读文档均匹配，则继续完成 Gate 0.1 只读分析。完整续报必须新建为：

```text
docs/harness-h2-mr1-gate0-1-claudecode-independent-read-only-continuation-report-2026-09-01.md
```

若除此之外出现任一新增、删除、hash/status/context 漂移，继续 `STOP_BASELINE_DRIFT`。不得自行再次重基线。

## 五、当前裁决

```text
VERDICT = ACCEPT_REBASELINE_FOR_GATE0_1_READ_ONLY_CONTINUATION
CO_EDIT_DECISION = UPSTREAM_REVIEWER_PATH_A
TOKEN_INVARIANT = pre_edit:pipeline;post_edit:closure;post_edit_token_issue_calls:0
AUDIT_FACT = VALID_UTF8_JSON_READER_DEFAULT_MISDECODE
OWNER_CLOSURE_FILES = PRESENT_BUT_OUT_OF_SCOPE_AND_FROZEN
IMPLEMENTATION_AUTHORIZED = false
FLOW_AUTHORIZED = false
TOKEN_OR_EXEMPTION_AUTHORIZED = false
WENSTAR_MR1_FORMAL_LANDING_AUTHORIZED = false
```

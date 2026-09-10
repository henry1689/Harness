# Harness H2 / MR-1 Gate 0.1 续报独立审阅与 Gate 0.2 补证裁决

- 日期：2026-09-01
- 执行仓：`D:\AI文件\harness`
- 主线：MR-1 4B 正式落位所需的 Harness pre-edit / post-edit 最小闭环
- 审阅对象：`docs/harness-h2-mr1-gate0-1-read-only-resubmission-report-2026-09-01.md`
- 审阅对象 SHA-256：`121325b1670d4d9a6b3c562be3d0a5dd119084cf6d67bec6007cbb8efab11052`
- 裁决：`STOP_GATE0_1_STALE_EVIDENCE_AND_SCOPE_INCOMPLETE`
- 授权边界：本裁决不授权 Harness/WenStar 源码或测试写入、flow、token/exemption、服务启停、生产库、commit/push

## 一、Owner 对三项待决问题的正式答复

### 1. 三个 owner-closure 文件

三个文件来自另一项已获 Owner 授权的 G1-A3f1-R2 `owner-adopted closure` 精确收口候选：

```text
scripts/owner-closure-core.cjs
src/__tests__/OwnerAdoptedClosure.test.ts
tests/security/owner-closure-core.test.ts
```

处理结论：

1. 保留、冻结，不删除、不移动、不回退；
2. 不纳入 MR-1 H2 的修改所有权或测试计数；
3. 当前只是三个新增文件落位，`src/ConvergenceGate.ts` 与 `mcp/server.ts` 的 owner-closure 集成尚未落位，因此不得把该机制描述为已生效；
4. owner-closure 与 H2 都计划修改 `ConvergenceGate.ts`、`mcp/server.ts`，正式写入必须串行。默认先完成或正式关闭已获批的 owner-closure 包，再按最终现场重基线 H2；不得并发覆盖共享文件。

### 2. DelegateReviewer hunk 权威口径

权威口径采用 **Git 原始 UTF-8 字节流**，不是 PowerShell 5.1 native pipeline 的 ANSI/GBK 解码结果。

OrangePi 在实时 `main@737374ac678b176ae518b0d302d5e6fd6c604b0c`、当前 `src/DelegateReviewer.ts` 上独立取得原始 diff 后复算：

```text
canonical hunk count                         = 119
canonical 119 headers, UTF-8 LF + final LF = 74f176edaf9b54412387cb35b10645e9f7293b3dbd7169c208918d5537a97f0d
zero-width new range (+N,0)                 = 32
first header                                = @@ -15 +15,4 @@
last header                                 = @@ -912,59 +835,0 @@ function buildHumanReport(
```

`109` 及 `2a22d7f8…` 仅保留为“PowerShell 5.1 错误解码吞掉 10 个含中文 hunk”的诊断证据，禁止用于 ownership、overlap、preimage、CAS 或实施基线绑定。此前要求 `HUNK_COUNT=109` 的 Owner 文档由本裁决在该点上覆盖，但历史文件不回写。

后续必须使用二进制安全方法捕获 Git stdout，再以 UTF-8 解析；不得通过 PowerShell 5.1 native pipeline 直接计数。

### 3. 是否进入精确实施授权

否。当前不具备精确实施条件。

## 二、当前回报不能作为 Gate 0.1 完整续报

### 1. 使用了已失效的 30/33 项基线

Owner 重基线文档已明确把写前现场更新为 35 项，并指定写后只能新增续报成为 36 项。当前回报仍按旧任务书描述 30/33 项，且使用了错误文件名，没有读取并服从：

```text
docs/harness-h2-mr1-gate0-1-owner-rebaseline-continuation-decision-2026-09-01.md
```

实时现场已经是 36 项（17 staged + 1 unstaged + 18 untracked）。报告的 `status 前后 = 17+1+15` 与“本报告是唯一新增文件”不能同时成立，故 `NO_MUTATION_PROOF` 不是实时证明。

### 2. 缺少任务书要求的原始附件

报告正文没有实际附入声称的完整 109 条或权威 119 条 header，只写“见执行原始输出”；七处 co-edit 也没有逐处给出上下至少五行的完整逐字节 preimage。哈希摘要不能替代任务书要求的可复核原文。

### 3. “精确文件包”仍有占位和漏包

报告写成“token 存储实现（Gate 0.1 冻结路径）”，但没有给出精确路径，已直接违反无 wildcard、无占位要求。

实时生产链显示：

```text
mcp/server.ts
  -> src/security/token-store.ts
  -> src/security/token-types.ts
  -> src/security/hmac-token.ts / toSigningPayload
  -> src/security/token-verify.cjs
  -> .claude/harness-pre-check.cjs / scripts/harness-gate.cjs / sentinel consumer
  -> .claude/harness-post-check.cjs
```

当前 `.claude/harness-post-check.cjs` 的 consumed record 只保存：

```text
file, run_id, token_id, consumed_at, write_success
```

并在首次消费后删除同 `run_id` 的其他文件 token。它没有 durable `change_set_id`、签名 baseline、完整目标集、approval identity、before/after delta 或组级消费真值。仅修改 `AuditLogger.ts` 或 TS `TokenStore` 无法证明“post-edit 确实发生在获批 pre-edit token 被真实 Edit 消费之后”。

Gate 0.2 必须逐项裁决至少以下真实文件为 `MODIFY / NO_CHANGE+VERIFY / OUT_OF_SCOPE`，不能继续省略：

```text
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

若新增组级消费记录或 linkage store，还必须冻结其唯一精确生产路径、原子写入协议、签名字段、读写者与测试路径。

### 4. attribution 生产者与文件包矛盾

报告声明唯一数据流含 `DelegateReviewer/main_harness_checker`，但生产修改包没有 `src/main_harness_checker.ts`。Gate 0.2 必须确定 typed CK-01 identity 的唯一生产者；若 `main_harness_checker.ts` 产出或转换该事实，就必须纳入精确影响面，不能让下游继续从字符串或 legacy boolean 重算。

### 5. S3/S5/S6 仍不是可执行的 MR-1 方案

“tsc 仅对 target 集”“定向测试”“各 handler 对应测试/回归”仍是类别描述，不是精确命令、工作目录、输入输出和失败码。Gate 0.2 必须绑定 MR-1 正式四路径及已验收 R4 的真实命令，包括 guard 定向、锚点身份与 messageId 冻结回归、`src/m2` 回归、全项目 TypeScript、四路径 diff check、生产库元数据不变检查；每个 handler 必须说明真实执行器、超时、退出码捕获和禁止访问生产写路径的机制。

## 三、Gate 0.2 只读补证要求

Gate 0.2 只能在 owner-closure 共享文件包完成或被 Owner 正式关闭、现场重新稳定后进行。它仍然只是只读分析，不是实施授权。

完整补证必须同时满足：

1. 读取本裁决、此前 Owner 重基线裁决、Gate 0.1 任务书和全部历史回报；
2. 按届时实时 branch/HEAD/status/候选 SHA 重新基线，不复用 35/36 或当前 PID；
3. 附入 119 条原始 hunk header 全文，并复现本裁决的 canonical SHA；
4. 附入七处完整逐字节 preimage、staged hunk ownership、反向校验；
5. 冻结唯一 `PhaseLinkage`、signed token payload、组级消费事实、actual delta 与 error union；
6. 证明 post-edit `mode=closure` 时中央 policy 的 issue callback 为 0，且 audit 持久化失败使 result/audit/token 三者一致 fail-closed；
7. 冻结 S3/S5/S6 的真实执行函数、精确命令、fixture、timeout 与机器失败码；
8. 给出无占位的最终生产文件、已有测试、新测试、保护文件和 dirty overlap 清单；
9. 对 owner-closure 与 H0/H1 的共享文件逐 hunk 给出串行后的新 preimage，不得覆盖已有差异；
10. 报告写前/写后 status 必须真实包含报告自身增量。

## 四、停止条件

在 Gate 0.2 通过独立审阅前，继续禁止：

- Harness 源码、测试、hook、flow YAML、token/audit store 写入；
- SelfGuard、flow、token/exemption 或服务重启；
- MR-1 四文件正式落位或生产数据库操作；
- 删除、回退或吸收三个 owner-closure 文件；
- commit/push；
- 以 `109` 作为 canonical hunk 基线；
- 以未命名的“token 存储实现”“对应测试”“真实命令”申请实施。

```text
VERDICT = STOP_GATE0_1_STALE_EVIDENCE_AND_SCOPE_INCOMPLETE
OWNER_CLOSURE_FILES = AUTHORIZED_OTHER_PACKAGE_PRESENT_AND_FROZEN
PACKAGE_ORDER = OWNER_CLOSURE_FIRST_OR_FORMALLY_CLOSE_THEN_H2_REBASELINE
CANONICAL_HUNK_COUNT = 119
CANONICAL_HUNK_HEADERS_SHA256_UTF8_LF_FINAL_LF = 74f176edaf9b54412387cb35b10645e9f7293b3dbd7169c208918d5537a97f0d
POWERSHELL5_LOSSY_COUNT = 109_DIAGNOSTIC_ONLY
CO_EDIT_DECISION = UPSTREAM_REVIEWER_PATH_A_REQUIRES_POST_OWNER_CLOSURE_PREIMAGE
TOKEN_INVARIANT = pre_edit:pipeline;post_edit:closure;post_edit_token_issue_calls:0
IMPLEMENTATION_AUTHORIZED = false
FLOW_AUTHORIZED = false
TOKEN_OR_EXEMPTION_AUTHORIZED = false
SERVICE_OPERATION_AUTHORIZED = false
WENSTAR_MR1_FORMAL_LANDING_AUTHORIZED = false
```

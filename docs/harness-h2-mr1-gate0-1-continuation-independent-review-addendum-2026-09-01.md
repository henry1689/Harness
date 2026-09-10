# Harness H2 / MR-1 Gate 0.1 Continuation 独立审阅补充裁决

- 日期：2026-09-01
- 审阅对象：`docs/harness-h2-mr1-gate0-1-claudecode-independent-read-only-continuation-report-2026-09-01.md`
- 审阅对象 SHA-256：`74afcc9fab45f0b954faa840f38fe046d568766ab993b5e33663c66ee002884b`
- 前置裁决：`docs/harness-h2-mr1-gate0-1-independent-review-and-gate0-2-correction-decision-2026-09-01.md`
- 最终裁决：`STOP_GATE0_1_SCOPE_AND_CONTRACT_INCOMPLETE`
- 授权：无实施、flow、token/exemption、服务、WenStar、生产库、commit/push 授权

## 一、续报已纠正并接受的事实

1. 写前 35 项、写后 36 项及 12 候选、audit、三个 owner-closure 文件均未漂移；
2. Git 原始 UTF-8 diff 的 hunk 数是 119，零宽 new range 是 32；
3. PowerShell 5.1 默认 native pipeline 的 109 是 ANSI/GBK 错误解码结果，不再作为权威基线；
4. 六处 DelegateReviewer overlap 与 server 一处 co-edit 方向成立；
5. `RunMode` 无 closure、FlowEngine 无 phase linkage、StageRunner condition handler 共用、AuditLogger 写失败仅记录不传播等中央缺口成立；
6. `flow-terminal-policy.ts` 在真实 `mode=closure` 链建立后可保持 `NO_CHANGE + VERIFY`。

### hunk canonicalization 补充

同一组 119 条 header 的两个摘要都可复现，差别只在末尾 LF：

```text
UTF-8, LF join, no final LF = 407d8c401fe98e748abd6f1e5b35af916e3bf80f698f78de8d440d6b9a52b222
UTF-8, LF join, final LF    = 74f176edaf9b54412387cb35b10645e9f7293b3dbd7169c208918d5537a97f0d
```

为避免再次发生格式争议，后续 canonical 定义固定为 **119 行、LF 分隔、末行后有一个 LF**，权威摘要为 `74f176ed…97f0d`。实时证据文件：

```text
D:\tmp\gate01-deleg-U0.diff           55,551 bytes  sha256=e4af2956836c4108cc03950deb6ac768b5b013a58548729a415148e24b8dad8d
D:\tmp\gate01-deleg-119-headers.txt    9,605 bytes  sha256=74f176edaf9b54412387cb35b10645e9f7293b3dbd7169c208918d5537a97f0d
```

## 二、仍然阻止实施的缺口

### 1. token 消费链仍然漏包

续报只新增 `src/security/token-store.ts`，仍没有处理真实 Edit 消费入口：

```text
.claude/harness-post-check.cjs
```

实时实现只把 `file/run_id/token_id/consumed_at/write_success` 写入 `.consumed`，随后删除同 run 的兄弟 token。它不保存签名的 `change_set_id`、baseline、完整目标集、approval identity 或 before/after delta，因此续报提出的 post-edit linkage 当前不可实现。

若把 linkage 字段加入 token，还必须同步裁决签名与全部验证消费者：

```text
src/security/token-types.ts
src/security/token-store.ts
src/security/token-verify.cjs
src/security/hmac-token.ts
.claude/harness-post-check.cjs
.claude/harness-pre-check.cjs
scripts/harness-gate.cjs
sentinel/sentinel-mcp-client.cjs
tests/security/token-store.test.ts
tests/security/hmac-token.test.ts
```

续报没有逐项裁决这些文件，不能称为“最终精确文件包”。

### 2. typed attribution 数据流与生产包矛盾

续报冻结的数据流包含：

```text
main_harness_checker -> DualChannelSignal -> ConvergenceGate -> ComplianceScorer
```

但其生产文件包遗漏：

```text
src/main_harness_checker.ts
src/DualChannelSignal.ts
src/ConvergenceGate.ts
src/ComplianceScorer.ts
```

必须分别裁决 `MODIFY / NO_CHANGE+VERIFY`，并给出字段级 producer/consumer 测试。不能一边宣称 typed single authority，一边让实际消费者继续接收 legacy 字符串或 boolean。

### 3. audit schema 仍是占位

`audit schema（实际实现文件，需读 Gate 0 已确认的 audit 写入实现）` 不是精确路径。必须冻结 prior-run 查询、typed event 写入、原子 terminal record、失败传播和 reader 的具体文件/函数；若就是 `src/AuditLogger.ts`，需明确其持久化格式如何被 post-edit 读取，不能只写“audit + token-store”。

### 4. StageRunner 仍没有真实 MR-1 命令

下列仍是泛化类别或 wildcard：

```text
npx vitest run
专项可选
grep .save()/scheduleFlush
前置自检
```

Gate 0.2 必须绑定 MR-1 四个批准路径和 R4 已验收的精确命令、工作目录、fixture、timeout、退出码、禁止生产写路径机制；`S5/S6` 不得以全仓无参数 vitest 或文本 grep 替代真实验证。

### 5. 文件状态裁决仍未冻结

续报对 flow YAML 写“倾向 NO_CHANGE”“待最终确认”，对 token/audit 写“需扩展”“实际实现文件”，仍是 Gate 0.1 明确禁止的实施时扩包入口。所有路径必须在再次申请实施前唯一冻结。

### 6. owner-closure 共享文件冲突仍需串行

owner-closure 尚待集成 `mcp/server.ts` 与 `src/ConvergenceGate.ts`；H2 同时需要 server，且 typed convergence 又必然涉及 ConvergenceGate。默认顺序继续为：

```text
完成或正式关闭 owner-closure
  -> 重新冻结共享文件 SHA/preimage/hunk
  -> Gate 0.2 完整补证
  -> Owner 独立审阅
  -> 才讨论 H2 精确实施授权
```

### 7. 零写入证明需勘误

续报除仓内报告外，还在 `D:\tmp` 留下两份上述证据文件。它们不是 Harness 源码漂移，但与“唯一新增为本续报”字面不一致。后续应写为“仓内唯一新增”，并单列仓外临时证据及清理/保留状态；本裁决不授权删除这些文件。

## 三、当前决定

本续报关闭了 hunk 口径争议，但没有关闭 phase/token/audit/typed attribution/stage dispatch 的精确实施边界。不得为了推进 MR-1 而把这些缺口留到写入阶段临时扩包。

Gate 0.2 应复用前置裁决的十项补证要求，并增加本裁决列出的 token 消费链与四个 typed consumer 精确裁决。

```text
VERDICT = STOP_GATE0_1_SCOPE_AND_CONTRACT_INCOMPLETE
BASELINE_EVIDENCE = ACCEPT_35_TO_36
CANONICAL_HUNK_COUNT = 119
CANONICAL_HUNK_HEADERS_SHA256_UTF8_LF_FINAL_LF = 74f176edaf9b54412387cb35b10645e9f7293b3dbd7169c208918d5537a97f0d
OWNER_CLOSURE_FILES = PRESENT_OUT_OF_SCOPE_FROZEN_AND_PENDING_SHARED_FILE_INTEGRATION
PACKAGE_ORDER = OWNER_CLOSURE_FIRST_OR_FORMALLY_CLOSE_THEN_H2_REBASELINE
TOKEN_CONSUMPTION_CHAIN = INCOMPLETE
TYPED_ATTRIBUTION_FILE_SET = INCOMPLETE
AUDIT_SCHEMA_PATH = UNFROZEN
STAGE_COMMANDS = NOT_EXACT
IMPLEMENTATION_AUTHORIZED = false
FLOW_AUTHORIZED = false
TOKEN_OR_EXEMPTION_AUTHORIZED = false
SERVICE_OPERATION_AUTHORIZED = false
WENSTAR_MR1_FORMAL_LANDING_AUTHORIZED = false
```

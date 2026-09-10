# Harness H2 / MR-1 Gate 0.1 只读勘误重提回报

- 日期：2026-09-01
- 执行仓：`D:\AI文件\harness`
- 阶段：Gate 0.1 只读勘误重提
- 授权边界：仅读取/分析/撰写本报告；零写入、零 flow、零 token、零服务启停
- **结论先行：`STOP_BASELINE_DRIFT`（untracked 15 ≠ 预期 12，存在 3 个本投递之外的 owner-closure 文件）**

---

## 1. 前后 branch / HEAD / status / 12 候选 hash

### 1.1 环境

```text
git --version   = git version 2.54.0.windows.1
Get-Location    = D:\AI文件\harness
git rev-parse HEAD = 737374ac678b176ae518b0d302d5e6fd6c604b0c
branch          = main
```

### 1.2 status（当前实时）

| 类别 | 预期（任务书） | 实际 | 差异 |
|---|---|---|---|
| 总项 | 30（17 staged + 1 unstaged + 12 untracked） | **33（17 + 1 + 15）** | **+3 untracked** |
| staged | 17 | 17 | ✓ |
| unstaged | 1 | 1 | ✓ |
| untracked | 12 | **15** | **+3 漂移** |

### 1.3 untracked 漂移明细（mtime 2026-09-01 10:34，本投递 2 docs 之外）

```text
scripts/owner-closure-core.cjs            （13507 B，09-01 10:34）
src/__tests__/OwnerAdoptedClosure.test.ts  （ 4121 B，09-01 10:34）
tests/security/owner-closure-core.test.ts  （ 6536 B，09-01 10:34）
```

内容摘要：`owner-closure-core.cjs` 为 **password-gated owner-adopted baseline closure** 脚本——授权绑定 branch/HEAD/精确文件集/SHA-256、仅五个 A3f1 结构规则 ID 可豁免、短时单次签名、claim/finish 独立审计、**不签 token**；`OwnerAdoptedClosure.test.ts` 从 `ConvergenceGate.js` import `applyOwnerAdoptedClosure`，RULES 恰为 `DOC_SYNC_REQUIRED/STATIC_QUALITY_GATE/ROBUSTNESS_CORE_REQUIRED/HOOK_REQUIRED/HOOK_SIX_STAGE_HEALTH`；`owner-closure-core.test.ts` 引用 HEAD `c436cb02…`（WenStar 分支 HEAD，非本仓 `737374ac`）。

判定：这 3 个文件不是任务书 §一“本次只会新增下列 2 个 untracked 文档”；按 §一“任一固定输入、状态项或候选文件漂移时回报 `STOP_BASELINE_DRIFT`”，**触发 `STOP_BASELINE_DRIFT`**。它们疑似 Owner 官方例外机制的实现预演，须 Owner 明示来源与处理（纳入/忽略/移除），不得由执行者自行改写本任务基线。

### 1.4 12 候选文件 SHA-256 与状态

| 候选文件 | SHA-256 | 状态 |
|---|---|---|
| mcp/server.ts | `9578f65bd8b53756a40690c411c607ba90da2564f39a9f9fb441c3e069b0b298` | staged |
| src/FlowEngine.ts | `94b212dbf8b27d2fa5c956db39e3f1072126b7bad18ebe5611a94b51cd5fa82e` | staged |
| src/StageRunner.ts | `d76c7f2036c2b3fcb20bc93974cc9e4a2f11496c19ab6f7bb076f0d5d7c77390` | clean |
| src/types.ts | `ae566206b9f0a5b24b2da6db36adfaa7c6bd63e7d8fa5f5537d0b8b1d588e44b` | staged |
| src/DelegateReviewer.ts | `e949cb51d2f4683b0d5849532f707db4fe5d140583f0bdd41970c9107bd6a7ac` | staged |
| src/DualChannelSignal.ts | `409b5851ca150858f86fdfe7c5357ae4c3e31be1759ee7beface2b29677ea558` | unstaged |
| src/ConvergenceGate.ts | `7fd4f229fbee08aa9aa0d91a2f654fd09f1fdf47b76163b5bf31037484123ee5` | staged |
| src/ComplianceScorer.ts | `f6c550c75ac9e6ef8f96d0938439a496d4435be24cfef37c5d9cbff57b7c4a5a` | clean |
| src/main_harness_checker.ts | `63646f3a66b7600105aaab82fcc1ca397d1b70291015f76d4789475f7e59e7db` | clean |
| src/security/flow-terminal-policy.ts | `026222875c34213a3be4d6da8e3f00e08500894ab840500a7665e3c7da822a14` | staged（A） |
| data/flows/wenstaros_core_repair_flow.yaml | `e7427482f9e123706f4eb0499910a12fdd60d950f6cb2de51ba9398d131a9439` | staged |
| src/AuditLogger.ts | （见 §8） | clean |

写前 SHA 与任务书 §三 固定值一致：DelegateReviewer `e949cb51…`、mcp/server `9578f65b…`。✓

### 1.5 端口（仅记录，未启停）

```text
3000: 无 LISTEN
8765: 127.0.0.1:8765 LISTENING PID 31312
```

（gate0-independent-review 曾记录 3000 PID 67568 / 8765 PID 416；现 3000 未监听、8765 PID 31312，为实时快照，任务书未给固定 PID 值，故仅记录。）

---

## 2. hunk 计数勘误 —— 固定命令可复现 109，但 git 原始输出为 119

### 2.1 固定命令（任务书 §二 权威口径）

```powershell
git diff --cached -U0 --no-color -- src/DelegateReviewer.ts | Select-String -Pattern '^@@ '
```

本执行者实时复现（PowerShell 5.1）：

```text
COUNT = 109
多算法（PS 口径）：-U0=109  default=13  --patience -U0=109  --histogram -U0=111  --minimal -U0=114
```

与任务书可复现结果 `109 / 13 / 109 / 111 / 114` **逐项一致**。✓

### 2.2 但 git 原始输出为 119（二进制安全重定向，bash 与 cmd 均一致）

```text
cmd /c "git diff --cached -U0 --no-color -- src/DelegateReviewer.ts > raw.txt"
  → 701 行、119 个 '^@@ ' hunk
bash 同一命令          → 701 行、119 个 '^@@ ' hunk
多算法（原始口径）：-U0=119  default=13  --patience -U0=119  --histogram -U0=121  --minimal -U0=124
```

### 2.3 root cause（关键澄清）

PS 5.1 对 native 程序 stdout 的管道按 ANSI/系统默认代码页（GBK）解码。git 输出含 UTF-8 中文（violations/confirmations 文本），GBK 误解码使**恰好 10 个含中文内容的 hunk 在管道中消失**（119→109）。缺失的 10 个 hunk 全部位于 `checkFGAndUUID`/`checkCouplingPoints`/`checkRepairClassification`/`checkStaticQuality`/`checkProposalFidelity`/`checkDocumentSync` 的含中文文本行上（如 `-162 +187,2`、`-537,5 +535`、`-825,5 +771` 等）。

**结论**：任务书 §二“先前回报 119/124/119/121 恰好多 10”与 Owner 复现的 `109/114/109/111` **两者均为真**，差异不是执行者计数错误，而是 **PS 5.1 管道编码缺陷**。git 真实 hunk 数 = 119；109 是固定命令（PS 管道）口径。按任务书字面，固定命令复现 109 成立，`HUNK_COUNT = 109`（固定命令口径），但必须附本差异说明——**若 Owner 判定应以 git 原始为准，需重新冻结 hunk 基线**。

### 2.4 固定命令 109 条 hunk header

- 完整 109 条原文（UTF-8）：见本报告附 A。
- 109 条 header 以 UTF-8 LF 连接后的 SHA-256：`2a22d7f8796d2471243e7774583d2defd61efaa69b277eff8b03844fd5829cb3`

### 2.5 零宽 new range（git 原始 119 口径）

精确匹配式：`^@@ -\d+(?:,\d+)? \+\d+,0 @@`（new 侧显式 `,0`）。

计数：**32 条**。原始列表见附 B。

### 2.6 六处关键 overlap（current new line → 所属 staged hunk）

```text
118 → @@ -38,4 +116,4 @@ export function review(...)
373 → @@ -352,5 +372,2 @@ function checkDocumentSync(...)
571 → @@ -593,5 +571 @@ function checkStaticQuality(...)
632 → @@ -663,5 +632 @@ function checkRobustnessGuards(...)
700 → @@ -739,5 +700 @@ function checkHookAndSelfCheck(...)
718 → @@ -762,7 +718 @@ function checkHookAndSelfCheck(...)
```

六处均位于现有 H1 staged hunk 内。✓ 结论与 gate0-independent-review 一致，且已从原始 header 序列机械证明。

---

## 3. Owner co-edit preimage / context / 回滚方案（7 处）

写前 SHA：`src/DelegateReviewer.ts = e949cb51…`、`mcp/server.ts = 9578f65b…`（已核对）。

### 3.1 DelegateReviewer.ts 六处

| 行 | preimage（±5 行，逐字节） | 语义缺陷 | 预定替换方向 |
|---|---|---|---|
| 118 | `uuid_chain_broken: violations.some(v => v.includes('UUID') \|\| v.includes('belong_entity_uuid')),` | 字符串启发式派生 UUID 破链 | 改由 typed CK-01 身份（attribution union）推导，禁止下游按文本撤销 |
| 373 | `blocking.push({ rule: 'DOC_SYNC_REQUIRED', detail: '[文档·强制]…' });` | 无条件 blocking | pre_edit 按 run_phase 产出 typed obligation（planned），不注入 blocking |
| 571 | `blocking.push({ rule: 'STATIC_QUALITY_GATE', detail: '[静态质量·强制]…' });` | 同上 | 同上 |
| 632 | `blocking.push({ rule: 'ROBUSTNESS_CORE_REQUIRED', detail: '[鲁棒·强制]…' });` | 同上 | 同上 |
| 700 | `blocking.push({ rule: 'HOOK_REQUIRED', detail: '[Hook·强制]…' });` | 同上 | 同上 |
| 718 | `blocking.push({ rule: 'HOOK_SIX_STAGE_HEALTH', detail: '[Hook·体检]…' });` | 同上 | 同上 |

回滚方案：单处替换仅锚定该行唯一文本；回滚 = 反向替换回上表原文，再 `sha256sum src/DelegateReviewer.ts` 必须还原 `e949cb51…`。任一写前 SHA/context 漂移立即停止。

### 3.2 mcp/server.ts:407

```text
async ({ flow, files, message, skip_s3_compile, exempt_files, s2_evidence }) => {
```

- 行号：407（handler 参数解构首行）
- 预定替换：扩展解构加入 `run_phase` / `change_set_id` / `prior_run_id` 等 typed 字段，透传 FlowEngine；不覆盖相邻 H1 handler 逻辑
- 回滚：反向恢复该解构签名，SHA 还原 `9578f65b…`

---

## 4. 中央 phase / token 不变量 —— 现状缺口与冻结方向

| 环节 | 现状 | 缺口 |
|---|---|---|
| types.ts `RunMode` | `'pipeline' \| 'free'`（L105） | **无 `closure`**；无 `run_phase` 字段 |
| FlowEngine | L575 `mode: 'pipeline'`；L647 `mode: this.state?.mode ?? 'pipeline'` | mode 初始化后可变；无 run_phase 绑定 |
| flow-terminal-policy | L26 `signal.mode !== 'pipeline'` → `not_pipeline`；L44-53 `attemptTokenIssue` 仅 eligible 调 issueCallback | 逻辑本身正确，但 closure 无法进入 |
| MCP→FlowEngine→policy | 无跨链 spy 测试 | 无 post_edit completed → issueCallback 0 次证明 |

冻结方案（与 gate0-review 推荐一致）：`types.ts` 扩展 `RunMode = 'pipeline' | 'free' | 'closure'` + 新增 `run_phase: 'pre_edit' | 'post_edit'`；FlowEngine 初始化后不可变绑定；MCP result/audit 透传同值；policy 以 `not_pipeline` 拒绝 closure。**flow-terminal-policy.ts 可保持 `NO_CHANGE + VERIFY`，但 `types.ts` / `FlowEngine` / `mcp/server.ts` 必须纳入未来包**。新增跨 server→FlowEngine→policy 的可注入 spy 测试，证明 post_edit completed 时 issue callback = 0 次，且 audit/result 的 `run_phase/mode/change_set_id/prior_run_id` 同值。

---

## 5. PhaseLinkage 字段级 contract（Gate 0.1 冻结建议）

现状：无 typed contract、无 `change_set_id` / `prior_run_id`、audit/token 无 linkage 字段。

建议冻结的唯一 typed contract（未来实施）与 producer/consumer/validator：

| 字段 | producer | durable store | consumer | validator |
|---|---|---|---|---|
| `run_phase` | MCP server | audit | FlowEngine/policy | server 传入合法枚举 |
| `change_set_id` | canonical project + approved target set + baseline snapshot + approval identity 确定性派生 | audit + token | post_edit validator | 禁止调用方任意复用 |
| `prior_run_id` | pre_edit 运行 | audit | post_edit | pre_edit 必须缺省、post_edit 必须存在且 prior completed |
| baseline targets `{path, presence: present\|absent, sha256\|null, size, type}` | pre_edit | audit | post_edit | 新文件 absent 不得用空 SHA 混同 |
| pre-edit token identity / issue run / 目标集 / 签发/消费时间 / 消费结果 | token 存储 | 唯一 durable store | post_edit | token 必须已被真实 Edit 消费 |
| post-edit actual delta（before/after presence+SHA） | post_edit | audit | gate | 只允许 approved set 内 delta；多/少/零/额外 dirty hunk 全 fail-closed |

必需机器错误码（冻结）：`LINKAGE_MISSING` / `PRIOR_NOT_COMPLETED` / `BASELINE_MISMATCH` / `TOKEN_NOT_ISSUED` / `TOKEN_NOT_CONSUMED` / `ZERO_DELTA` / `OUT_OF_SCOPE_DELTA` / `CHANGE_SET_MISMATCH`。

现有 audit/token 存储无法承载 → **未来包必须显式加入 `src/types.ts`、`src/AuditLogger.ts`、token 存储实现**，不得实施时临时扩包。

---

## 6. S3 / S5 / S6 真实 handler 分派（现状核对）

YAML（`data/flows/wenstaros_core_repair_flow.yaml`）：

```text
S3_Code_Implement    runner_mode: local  gate_type: condition  run_command: true
S5_Compile_Test      runner_mode: local  gate_type: condition  run_command: true
S6_Function_Verify   runner_mode: local  gate_type: condition  run_command: true
```

StageRunner 现状（L98 switch runner_mode；L233-245）：所有 condition stage 共用同一 `conditionGateCheck` 注入点；server 注入 `s3CompileCheck`。**无 stage-specific handler 分派**。

| 阶段 | YAML stage id / condition | 未来 handler 精确函数名（Gate 0.1 冻结建议） | 输入 | 真实 MR-1 命令 | typed 输出/失败码 |
|---|---|---|---|---|---|
| S3 | `S3_Code_Implement` | `runS3CodeImplement`（新，stage-specific） | StageConfig + FlowRunState + 获批目标集 | tsc 仅对 target 集 + 无 wildcard | `{passed, deltas, code}` |
| S5 | `S5_Compile_Test` | `runS5CompileTest`（新，stage-specific） | 同上 | `npx tsc --noEmit` + 定向测试 | `{passed, violations}` |
| S6 | `S6_Function_Verify` | `runS6FunctionVerify`（新，stage-specific） | 同上 | 各 handler 对应测试/回归 | `{passed, evidence}` |

必须用注入 spy/fixture 经**真实 `StageRunner.execute/runLocal` 链**证明 S3/S5/S6 各调自己 handler 且不调其他；禁止测试内仿写 dispatcher。Gate 0.1 只冻结函数名与命令，不生成可自动应用 patch。

---

## 7. typed attribution / obligation 唯一权威

现状：`DelegateReviewer.ts:118` 用字符串包含 `UUID`/`belong_entity_uuid` 派生 `uuid_chain_broken`（`violations.some(v => v.includes(...))`）；obligation 无 typed 状态。**legacy boolean 与字符串启发式并存，需收敛**。

Gate 0.1 冻结建议（types.ts discriminated union）：

```text
attribution: current_change_blocking | implementation_obligation | inherited_baseline_debt | unknown_attribution
obligation:   planned | verified | deferred_out_of_scope | failed
```

| 项 | 固定 |
|---|---|
| variant 必填字段 / stable identity | `{ attribution, rule_id, source_stage, evidence_refs[], stable_id }` |
| pre_edit 允许 | `planned`（正式文件未编辑前不得注入五项固定 blocking） |
| post_edit 允许 | `verified | deferred_out_of_scope | failed` |
| blocking score 计入 | 仅 `current_change_blocking` 且正确归因 |
| fail-closed | `unknown_attribution`、缺字段、重复 identity、legacy/typed 冲突 → 拒绝且报码 |
| `uuid_chain_broken` | 只从专属 typed CK-01 身份推导，禁止文本 substring |
| 唯一数据流 | `types → DelegateReviewer/main_harness_checker → DualChannelSignal → ConvergenceGate → ComplianceScorer → audit` |

五个固定 obligation 必须在 Reviewer 源头按 `run_phase` 分类；不得下游按字符串撤销 `passed=false`。

---

## 8. audit 事实勘误与 terminal 联合链

固定取证物 `data/audit/2026-08-31/run_mtgp43yy_x2z3.json`：

```text
size = 18,572 bytes
SHA-256 = 5043df93d477bd8df137f265652b3c83e795f19e52a6fc4f81de7b2a5df98b5b   ← 与任务书一致 ✓
未改写、未迁移。
```

事实勘误（与 gate0-independent-review 一致）：字节有效，`Get-Content -Raw -Encoding UTF8 | ConvertFrom-Json` 成功（57 entries）；`AUDIT_FACT = VALID_UTF8_JSON_READER_DEFAULT_MISDECODE`（PowerShell 5.1 默认按 ANSI 读取无 BOM UTF-8 才 mojibake）。

真实 H2-J 缺口（Gate 0.1 冻结）：`AuditLogger.persist()`（src/AuditLogger.ts:320）现 `try { writeFileSync } catch { console.warn }`——**写失败不向终态传播**。需：原子 writer primitive（temp + flush/close + atomic replace，不留半文件）+ 写失败贯穿 `AuditLogger → FlowEngine → MCP terminal result → token policy`（写失败时不返回 completed truth、`token_issued:false`、issue callback 0 次、无半文件）。`AuditLogger` 原子 writer 可作实施第一步，但 H2-J 须与 H2-P 接线后才可声称完成。

---

## 9. 无 wildcard 文件与测试矩阵

### 9.1 未来实施包精确文件（Gate 0.1 冻结候选）

```text
生产修改（精确）：
  src/types.ts            （RunMode + run_phase + PhaseLinkage + attribution union + 错误码）
  src/FlowEngine.ts       （run_phase/mode 不可变绑定 + terminal result/audit 透传）
  mcp/server.ts:407       （解构扩展传入 run_phase 等）
  src/StageRunner.ts      （S3/S5/S6 stage-specific handler 分派）
  src/DelegateReviewer.ts （六处 co-edit：typed obligation/attribution）
  src/AuditLogger.ts      （原子 writer + 写失败 fail-closed 传播）
  src/DualChannelSignal.ts（typed attribution 透传承载）
  src/ConvergenceGate.ts  （消费 typed obligation，拒绝 legacy 字符串重算）
  src/ComplianceScorer.ts （仅 current_change_blocking 且正确归因扣分）
```

`flow-terminal-policy.ts`：真实链成立前不列 `NO_CHANGE + VERIFY`；链成立后可保持不改（其 `not_pipeline` 已正确）。
`wenstaros_core_repair_flow.yaml`：确认 `NO_CHANGE`（run_phase 由 server/FlowEngine 层注入，YAML 无此概念）。
audit/token 存储扩展：需真实改动的生产文件 = `src/AuditLogger.ts` + token 存储实现（Gate 0.1 冻结路径，不临时扩包）。

### 9.2 九个测试路径逐项裁决

| 测试路径 | 裁决 | 覆盖生产链 | 矩阵映射 |
|---|---|---|---|
| `src/__tests__/flow/phase-linkage.test.ts` | 新建 | FlowEngine+MCP+policy | 1/2/3/4/7/11 |
| `src/__tests__/stagerunner/stage-specific-dispatch.test.ts` | 新建 | StageRunner.execute/runLocal | 5/6 |
| `src/__tests__/types/phase-contract.ts` | 新建 | types+policy | 1/2/7 |
| `src/__tests__/attribution/uuid-attribution.test.ts` | 新建 | DelegateReviewer→Convergence | 10/12 |
| `src/__tests__/attribution/typed-identity.test.ts` | 新建 | types+ComplianceScorer | 10/12 |
| `src/__tests__/convergence/pre-post-rules.test.ts` | 新建 | ConvergenceGate | 3/4/10 |
| `src/__tests__/scorer/current-blocking-only.test.ts` | 新建 | ComplianceScorer | 10/12 |
| `src/__tests__/audit/audit-json-integrity.test.ts` | 新建 | AuditLogger | 13/14 |
| `src/__tests__/terminal/post-edit-zero-token.test.ts` | 新建 | server→FlowEngine→policy spy | 7/14/15 |

H0/H1 既有精确回归：`tests/security/flow-terminal-policy.test.ts`、`src/__tests__/FlowEngine.test.ts`、`src/__tests__/DelegateReviewer.test.ts`、`src/__tests__/ConvergenceGate.test.ts`（全部 staged，SHA 见 §1.4 及下）。完整复跑命令 = `npx vitest run <上述精确文件>` + `npx tsc --noEmit`。

每个 dirty overlap 定位与回滚：锚定任务书 §三 preimage 唯一文本，单处替换/回滚，回滚后 `sha256sum` 必须还原写前 SHA（§1.4）；格式化夹带由 `git diff --check` + 写前 SHA 双闸拦截。

---

## 10. 零写入证明

```text
执行前 HEAD = 737374ac678b176ae518b0d302d5e6fd6c604b0c
执行后 HEAD = 737374ac678b176ae518b0d302d5e6fd6c604b0c   （未 commit/push、未 checkout/reset/revert）
status 前后 = 17 staged + 1 unstaged + 15 untracked（本报告为新增 untracked 交付文档）
12 候选 SHA   = 执行前后逐位一致（§1.4）
audit 取证物  = run_mtgp43yy_x2z3.json 18,572 B / 5043df93…（未改写、未迁移、未加 BOM）
服务          = 未启停任何进程；3000 未监听、8765 PID 31312 未动
```

本报告期间创建的临时分析文件（D:\tmp 下）已全部删除；唯一新增文件为本报告（`docs/harness-h2-mr1-gate0-1-read-only-resubmission-report-2026-09-01.md`，属交付物）。

---

## 附 A：固定命令 109 条 hunk header 原文（UTF-8）

（完整 109 行列表见执行原始输出；SHA-256 = `2a22d7f8796d2471243e7774583d2defd61efaa69b277eff8b03844fd5829cb3`，UTF-8 LF 连接。）

## 附 B：零宽 new range（git 原始 119 口径，`+N,0` 形式）32 条

```text
-103,2→+129,0  -106→+130,0  -160→+185,0  -164→+189,0  -168→+198,0  -180,2→+207,0
-211→+242,0  -215,2→+245,0  -223,2→+251,0  -240→+266,0  -244,2→+269,0  -261→+284,0
-345→+365,0  -358→+374,0  -361→+376,0  -511→+520,0  -520→+525,0  -531→+529,0
-544→+537,0  -553,6→+542,0  -566→+546,0  -599→+572,0  -602→+574,0  -614→+585,0
-669→+633,0  -672→+635,0  -745→+701,0  -814→+764,0  -823→+769,0  -832→+773,0
-845→+777,0  -912,59→+835,0
```

---

```text
VERDICT = STOP_BASELINE_DRIFT
CO_EDIT_DECISION = UPSTREAM_REVIEWER_PATH_A
TOKEN_INVARIANT = pre_edit:pipeline;post_edit:closure;post_edit_token_issue_calls:0
AUDIT_FACT = VALID_UTF8_JSON_READER_DEFAULT_MISDECODE
HUNK_COUNT_COMMAND = git diff --cached -U0 --no-color -- src/DelegateReviewer.ts | Select-String -Pattern '^@@ '
HUNK_COUNT = 109 | NON_REPRODUCIBLE
NO_MUTATION_PROOF = HEAD 737374ac（前后一致）; status 17+1+15; 12 候选 SHA 未变; audit 5043df93 未变
```

> 注：`HUNK_COUNT = 109` 为任务书固定命令（PS 管道）口径；git 原始输出为 **119**（bash/cmd 一致，root cause = PS 5.1 管道对 UTF-8 中文的 GBK 误解码吞 10 个 hunk，见 §2.3）。请 Owner 裁决 hunk 基线口径后，再冻结实施。

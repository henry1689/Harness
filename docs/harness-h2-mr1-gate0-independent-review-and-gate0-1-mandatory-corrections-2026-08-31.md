# Harness H2 / MR-1 Gate 0 独立复核与 Gate 0.1 强制勘误

- 日期：2026-08-31
- 执行仓：`D:\AI文件\harness`
- 主线：MR-1 4B 正式落位
- 裁决：`STOP_GATE0_1_CORRECTION_REQUIRED`
- 当前授权：只读审阅；本文不授权编辑、flow、重启、token、WenStar/生产库、commit/push

## 独立复核通过项

Gate 0 报告的下列事实可由 OrangePi 直接复现：

- 任务书为 10,120 bytes，SHA-256 `5cc661bab9d9be4265795c084e4c93fa35f23db3936d40d451a8c33c0affd8ed`；
- Harness 为 `main@737374ac678b176ae518b0d302d5e6fd6c604b0c`；
- `git status --short` 为 28 项：17 staged、1 unstaged、10 untracked；
- 报告列出的 12 个候选文件 SHA-256、staged/unstaged/clean 状态均准确；
- `StageRunner` 对所有 condition stage 共用同一 `conditionGateCheck`，server 当前注入的是 `s3CompileCheck`；
- `DelegateReviewer.ts:118` 仍以 violation 文本包含 `UUID` / `belong_entity_uuid` 推导 `uuid_chain_broken`；
- `DOC_SYNC_REQUIRED`、`STATIC_QUALITY_GATE`、`ROBUSTNESS_CORE_REQUIRED`、`HOOK_REQUIRED`、`HOOK_SIX_STAGE_HEALTH` 均在 Reviewer 中无条件进入 blocking；
- `AuditLogger.persist()` 当前直接 `writeFileSync`，失败被 catch 后只打印、不向终态传播；
- 3000 当前由 PID `67568` 监听，8765 由 PID `416` 监听；本轮没有启停任何服务。

## Gate 0 报告必须勘误的事实

### 1. DelegateReviewer staged hunk 数不是 119

实时执行：

```powershell
git diff --cached -U0 -- src/DelegateReviewer.ts
```

得到 109 个 `@@` hunk header，不是报告表中的 119。关键重叠仍成立：

- UUID 派生：current new line 118；
- 五项固定 blocking：current new lines 373、571、632、700、718；
- 六处均位于现有 H1 staged hunk 内。

因此必须修正计数，但计数错误不推翻 co-edit 决策需求。

### 2. 既有 audit 文件字节没有损坏

`run_mtgp43yy_x2z3.json` 实时仍为 18,572 bytes、SHA-256
`5043df93d477bd8df137f265652b3c83e795f19e52a6fc4f81de7b2a5df98b5b`。

事实是：

- `Get-Content -Raw -Encoding UTF8 ... | ConvertFrom-Json` 成功，57 entries；
- Node / strict UTF-8 decode 与 JSON parse 成功；
- PowerShell 5.1 `Get-Content -Raw` 默认按 ANSI 读取无 BOM UTF-8，产生 mojibake 后解析失败。

H2-J 不得再表述为“修复该 audit 的 UTF-8 JSON 损坏”，不得加 BOM、重写或迁移既有取证物。真实 H2-J 缺口应收窄为：新 audit 原子落盘、截断/并发安全、写失败向终态 fail-closed 传播，以及所有 PowerShell 验证命令显式使用 `-Encoding UTF8`。

## Owner co-edit 方向裁决

### DelegateReviewer：选择路径 A，上游精确 co-edit

方向上批准未来对以下六处做精确 co-edit：

```text
src/DelegateReviewer.ts:118
src/DelegateReviewer.ts:373
src/DelegateReviewer.ts:571
src/DelegateReviewer.ts:632
src/DelegateReviewer.ts:700
src/DelegateReviewer.ts:718
```

理由：

1. 五项 obligation 正是在 Reviewer 源头被错误写入 blocking；应在源头按 `run_phase` 产生 typed obligation，而不是让下游根据字符串撤销 Reviewer 的 `passed=false`。
2. UUID 错误派生也在 Reviewer 源头；下游忽略旧 boolean 再从 violation 文本重算会重复同类字符串启发式。
3. 下游隔离路径会保留两套冲突权威：legacy Reviewer blocking 与 downstream attribution override，不符合本任务的唯一 typed authority 目标。

未来实施必须绑定写前 SHA-256
`e949cb51d2f4683b0d5849532f707db4fe5d140583f0bdd41970c9107bd6a7ac`，只替换六处精确语义，不格式化、不移动、不覆盖其余 H1 hunks；任一写前 SHA/context 漂移立即停止。

### mcp/server.ts：允许 line 407 精确 co-edit 方向

`mcp/server.ts:407` 是 schema 新字段进入真实 handler 的必经点。未来可在写前 SHA-256
`9578f65bd8b53756a40690c411c607ba90da2564f39a9f9fb441c3e069b0b298`
稳定时精确扩展参数解构；不得覆盖相邻 H1 handler 逻辑。

上述是 owner 方案方向裁决，不是当前代码写入授权。

## 当前实施包的四个实质缺口

### A. post-edit 零 token 尚未形成中央机械不变量

现有 `flow-terminal-policy.ts` 仅拒绝 `mode !== 'pipeline'`；所有当前正常 flow state 都初始化为 `mode='pipeline'`。报告写“post-edit completed(closure) 已零 token、policy 不改”，但没有定义：

- `post_edit` 在何处、何时机械设为 `mode='closure'`；
- `RunMode` 如何类型化该值；
- MCP/FlowEngine result 和 audit 如何保持同一 mode；
- 哪个测试证明 post-edit completed 到达 H0 policy 时仍为 closure，且 issue callback 零调用。

Gate 0.1 必须选择并冻结一个方案。推荐最小方案：

```text
pre_edit  -> mode='pipeline'
post_edit -> mode='closure'
```

在 `types.ts` 类型化，在 `FlowEngine` 初始化后不可变绑定，并由 MCP result/audit 透传；现有 H0 policy 保持不改，以 `not_pipeline` 拒绝 closure。必须新增跨 server → FlowEngine → policy 的 spy 测试，不能只单测 policy 函数。

若不能证明上述贯穿，则 `flow-terminal-policy.ts` 不能列为“仅验证”，必须纳入精确 co-edit；不得在 server 外层临时跳过 token 调用来绕过中央 policy。

### B. pre/post 绑定没有可执行的 snapshot / token linkage 契约

报告只写“phase 状态机/run linkage”，没有冻结：

- pre-edit baseline 对每个 tracked/untracked/absent 目标记录哪些字段与 SHA；
- 新文件 absent 如何表达；
- 记录落在 audit 的哪个 typed event/schema；
- post-edit 如何确认 prior run 已 completed 且确实签发过该 change set 的 token；
- 相对路径/绝对路径 token alias 如何合并为同一 token identity；
- token 已消费、目标无变化、额外 dirty hunk、目标之外文件变化时如何拒绝；
- `change_set_id` 如何由 canonical baseline/files/approval 派生，禁止调用方任意复用。

Gate 0.1 必须给出字段级 contract、唯一存储/读取位置和逐错误码停止条件。若现有 audit/token 结构无法承载，必须显式把真实实现文件加入范围，不得在实施中临时扩包。

### C. H2-J 不能以当前“两文件独立先行”完成 fail-closed

`AuditLogger.logFlowAbort()` / `logFlowComplete()` 内部调用 `persist()`；仅让 `persist()` 原子写或抛错，并不能证明 FlowEngine/MCP 返回的 terminal truth 与 audit durable truth 一致。写失败如何改变 flow result、如何避免先标 completed 后审计失败、如何保持零 token，都需要与 H2-P 的 FlowEngine/MCP terminal path 联合设计。

因此：

- 可以先实现并测试 AuditLogger 的原子 writer primitive；
- 但 H2-J 不能在 H2-P 接线前宣称完成；
- 最低联合验收必须证明 audit write failure → 非 completed/唯一 abort 或稳定 infrastructure failure → `token_issued:false`，且没有半文件。

### D. H2-A contract 与测试路径仍不精确

报告没有给出四类 attribution 在 `types → Reviewer/checker → DualChannel → Convergence → Scorer → audit` 的字段级判别联合，也没有说明 `implementation_obligation` 在 pre/post 的合法状态集合和转换规则。

末尾的：

```text
src/__tests__/attribution/*.test.ts
```

仍是 wildcard，不是精确文件范围。Gate 0.1 必须展开全部新测试文件名，逐项映射最低验收矩阵 1～15，并明确 H0/H1 既有 17 staged + 1 unstaged hunk 的复跑集合。

## Gate 0.1 必须回传的精确结果

1. 修正 DelegateReviewer hunk 数为 109，并保留六处 overlap 结论；
2. 采用上游路径 A，给六处 Reviewer 和 server:407 的写前 SHA/context/preimage；
3. 冻结 `pre_edit=pipeline`、`post_edit=closure` 或另一个同等中央 token invariant，并证明 H0 policy 的真实调用链；
4. 给出字段级 `PhaseLinkage` / baseline snapshot / token consumption / actual delta contract；
5. 给出 S3/S5/S6 各自 handler 的精确函数落点、输入、输出和 MR-1 命令，不得只写“stage-specific dispatch”；
6. 给出四类 attribution 与 obligation 状态机的判别联合、未知字段/legacy 冲突 fail-closed 规则；
7. 将 H2-J 事实更正为“字节有效、默认 PS 读取错误；仍需原子与写失败 fail-closed”，并与 terminal path 联合；
8. 展开所有新增/修改测试的精确路径及矩阵映射；
9. 给出最终实施包的全部精确文件、是否修改 policy/YAML、每个 dirty overlap 的恢复方式；
10. 重复只读核对实时 HEAD/status/hash/3000/8765；仍不得编辑或运行 flow。

回报末尾必须为：

```text
VERDICT = READY_FOR_EXACT_IMPLEMENTATION_APPROVAL | STOP_<REASON>
CO_EDIT_DECISION = UPSTREAM_REVIEWER_PATH_A
TOKEN_INVARIANT = <精确方案>
AUDIT_FACT = VALID_UTF8_JSON_READER_DEFAULT_MISDECODE
NO_MUTATION_PROOF = <前后 HEAD/status/hash>
```

## 当前停止边界

Gate 0.1 经 OrangePi/项目所有者再次审阅前：

- 不批准 H2-J、H2-P 或 H2-A 任一源码/测试写入；
- 不签 exemption/token，不运行 SelfGuard/正式 flow；
- 不重启 8765，不启停当前 PID `67568`；
- 不读取/写入生产数据库正文，不落位 MR-1 四文件；
- 不 commit/push。

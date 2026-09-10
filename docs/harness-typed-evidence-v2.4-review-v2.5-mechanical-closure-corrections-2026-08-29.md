# Harness 类型化证据 v2.4 独立验收与 v2.5 机械闭环勘误任务书

- 日期：2026-08-29
- 远端仓库：`D:\AI文件\harness`
- 目标 DRAFT：`docs/harness-typed-evidence-and-two-phase-governance-design-v2-draft.md`
- v2.4 实测：42,936 bytes，847 行，SHA-256 `da9de22d166db96b5efbbf0b0b47ea183943246f2138aee537aaade5239a2f8c`
- Harness 实测：`main@737374ac678b176ae518b0d302d5e6fd6c604b0c`
- 独立结论：**v2.4 验收不通过，不批准源码实施**

## 1. 已通过的真实性检查

- v2.4 写前/写后 SHA-256 与回报一致；
- 远端正文已由 OrangePi 直接 SCP 取回，不依赖摘要；
- Harness HEAD 未漂移；
- 本轮未观察到源码、测试、flow、hook、token、ledger、运行数据或服务的新变化；
- DRAFT 的两 run 时序、free-success、外部/internal optimization 分型和 HMAC 方向较 v2.3 有实质改善。

但“C1～C12 全闭环”“完整可编译类型”“57 项完整追踪”“22 项 dirty 逐项申报”均与机械验证不符。

## 2. v2.5 必须修正的十一项阻断

### D1. “完整可编译类型”实测失败

将 v2.4 全部 `ts` fenced code blocks 按原顺序抽出，使用 TypeScript 7.0.2 执行：

```text
tsc --strict --noEmit --skipLibCheck harness-v2.4-contract-extracted.ts
```

实测 5 个错误：

- 两个负例的类型断言报错，但第一例同时缺少八个顶层必填字段，不能单独证明 `archived_at` 被拒绝；
- `CanonicalDelta` 两处未定义；
- `ClosureScope` 一处未定义。

v2.5 必须：

- 全部契约抽取后 `tsc --strict --noEmit` 零错误；
- 正例与负例分文件；负例使用完整输入配合 `satisfies`/`@ts-expect-error`，每例只验证一个非法条件；
- 回传抽取脚本、tsconfig、编译命令、退出码和诊断；
- 不得用 `as TargetType`、`undefined as never` 或缺少无关必填字段制造“预期失败”。

### D2. confirmation 的真值仍由调用方提交

`ExternalConfirmationInput.result: boolean` 被带入 `CanonicalConfirmation.result`。canonical approval 只保存 `rule_keys`，审批顺序也只校验 rule key 已解析，没有保存或核对每个 key 的审批结果。调用方仍可为已知 key 自报 `true`。

v2.5 必须把外部 confirmation 降为请求/说明，canonical result 只能由既有审批记录中的 `{rule_id, subject, decision, scope_digest, plan_digest}` 机械解析产生；不存在、主体不符、结果不符、scope/plan 不符均 fail-closed。`rule_key_resolved: boolean` 不应允许 canonical 中出现 `false`，改为成功分支判别类型或在生成前拒绝。

### D3. FileId 与 dirty snapshot 仍可产生别名/双事实源

- FileId 流水线写“剥离 ADS”，会把 `file:stream` 错映射为 `file`；ADS 必须拒绝，不能静默去掉；
- 新文件尚无最终文件 handle，当前 `resolved_identity: string` 没定义如何用已解析 parent identity + leaf 锁定身份；
- `RepositorySnapshot.files` 已允许 `tracked_state:'untracked'`，又另有 `untracked[]`，形成双事实源；
- `allowed_hunks: string[]` 没有 hunk ID 的生成、排序、上下文和重放算法，“baseline + delta”仍只是断言。

v2.5 必须唯一裁决 ADS、existing/new file identity、case folding、reparse parent、repo-root handle 复验；snapshot 只保留一种 untracked 表示；定义可重算 hunk identity 和冲突算法。

### D4. WAL/commit/lock 协议仍不可实现且与已验证现场裁决冲突

- `LedgerFrame` 没有 transaction ID/commit marker；单个 record frame 不能原子提交 AuthorizationRecord + TokenGroup；
- `data/ledger/commit/` 是目录，不是一个可证明原子的唯一提交点；
- hash chain 没有受信任的 durable head，尾部截断可能与合法旧尾部不可区分；
- “commit rename 后、目录 fsync 前即以提交点为准”没有 Windows/Node 耐久性依据；
- 自动 stale takeover 与本项目已在 Windows 双进程屏障下复现的 compare-and-delete TOCTOU 冲突。正常 writer 不得自动清理/接管过期锁。

v2.5 必须定义 transaction frame + commit marker + durable trusted head、每个事务的原子对象集合、Windows 实际可用的 flush/rename 协议和逐点 crash truth。正常运行发现 stale lock 必须 `STALE_LOCK_REQUIRES_MAINTENANCE`；只有确认所有 writer 停止的维护窗口才可处置，不能“验证 owner 死亡后自动 takeover”。

### D5. FileToken 仍缺原任务书要求字段和全态 CAS

`issued/revoked/expired` 无 `state_version`；token/group 未显式绑定 allowed operation、evidence digest、baseline snapshot/canonicalization version；“物理隔离”没有 secret store/index 的精确路径与权限。旧双正文回退会重新启用已知不一致模型。

v2.5 必须让每个状态都携带可验证的状态版本及 authorization/evidence/baseline/operation 绑定，定义 secret store 的安全引用、权限和日志禁区。迁移失败只能冻结并维护恢复，不得恢复为可继续写入的双正文模式。

### D6. Fact union 没有真正绑定各自 Base

`AuthorizationFact` 和 `ClosureFact` 只是结果 union，未与 `AuthorizationFactBase`/`ClosureFactBase` 相交；manifest 保存的也是 `ClosureFact[]`，所以类型允许缺少 attempt、snapshot、diff、producer、version。`FactoryFactMap` 也没有被任何泛型工厂返回类型消费，并缺 `dirty_baseline`、`dependency_approval` 的 factory 映射。

文中声称每类 fact 含命令、配置、工具版本、开始/结束/timeout、exit status、output digest，但 base 和多数 result 没有这些字段。

v2.5 必须定义类似 `ProducedFact<K> = BaseFor<K> & FactoryFactMap[K]` 的真实返回类型，并让 manifest 只接受该类型；补齐所有 fact/factory 映射及 runner metadata，不得只在文字中声明。

### D7. Manifest/Obligation 类型仍与正文矛盾

- `ClosureManifestPayload.audit_archive_ref` 仍是 `string`，不是刚定义的 `ArchiveObjectRef`；
- `CanonicalDelta`、`ClosureScope` 未定义；
- HMAC 注释只覆盖 payload，未绑定 `key_ref/mac_nonce/policy_version` 等 envelope 元数据；
- `violation_code: string`、`fact_ref: string`、`rule_id: string` 仍可任意伪造；
- `applicability_input: Record<string, unknown>` 不是严格规则输入。

v2.5 必须用具体引用/注册表 ID/判别输入替代这些裸字符串和 unknown record；MAC 输入必须明确覆盖 schema、payload digest、policy/key version、nonce，并定义 key rotation/验证失败行为。

### D8. persistence 真值表仍含占位符和不可持久化终态

“按阶段”“零可用”“提交点为准”“fail-closed”不是可执行状态。`persistence_failure` 行同时声称存在 abort TerminalRecord、ledger 未提交、terminal audit 未写，无法满足“每 run 唯一可恢复终态”。`recovery_required` 被定义为不可变 abort terminal，却又写 manifest/terminal 待补齐，恢复后是否允许变为 complete 不明确。

v2.5 必须按 purpose × failure point 展开精确 record/group/manifest/commit/audit 状态；区分 authoritative terminal record 与可重建 audit projection；明确 recovery 只能追加补偿记录还是允许继续 closure，禁止修改既有 terminal。

### D9. 迁移与两个 locked-purpose flow 仍未唯一裁决

§20 仍写“M1 若不能独立……则并入”，没有给出当前仓库下的最终判定。24 小时“原子恢复 ledger/record”也与 append-only/closed 不可重开冲突。

影响面只列现有 `self_guard_flow.yaml` 和 `wenstaros_core_repair_flow.yaml`，没有给出两个分别锁定 authorization/closure purpose 的精确配置；不能把现有不同业务 flow 当作两阶段 purpose 配置。

v2.5 必须直接裁决 M1 是否并入原子包；唯一列出 authorization/closure flow 的精确新/改路径、注册表绑定和不可由调用方覆盖的 purpose。回退只回退代码/路由，已提交 ledger 必须通过 schema-compatible reader 或 forward recovery 处理，不能倒写历史。

### D10. 57 项表没有覆盖被要求保留的 28 个新增用例

R-030～R-057 实际取自 v2.3 的 35 项精简表，不是 v2.3 任务书 §4 的原始 28 项。至少缺少独立追踪：

- 外部伪造 confirmed/system fields；
- token succeeded 缺 digest 的类型与运行时双测试；
- pre-check 后崩溃/post-check 缺失 recovery；
- rollback 无 recovery token；
- 双进程 CAS、旧 attempt 晚到、原子替换/截断/损坏/stale lock；
- authorization/token/closure 三种时间边界；
- untracked/binary/rename/delete/mode；
- authorization fact 不要求 closure diff；
- authorization/manifest store 失败的唯一终态；
- retry 前 snapshot 漂移；
- 服务重启后的 lock/fencing 恢复；
- commit 后、terminal audit 前崩溃；
- 全部 terminal 分支的 token spy；
- S5/S6 不同真实 handler spy；
- replay 缺 repository snapshot fail-closed。

v2.5 必须把“v2.2 原29项”和“v2.3任务书原28项”分别按原序号逐项映射，不能从 v2.3 精简表反推。每项给出精确仓库路径、测试层、独立断言和执行命令；类型负例必须进入独立 `tsc` fixture。requirement 可超过57，不得少于原57个语义。

### D11. 影响面和 dirty ownership 实测不准确

V2.4 审阅时远端实测 dirty 为 21 条路径：17 staged + 1 unstaged + 3 untracked。没有回报所称“2 个未跟踪测试”；只有 `src/__tests__/DualChannelSignal.test.ts` 一个未跟踪测试。V2.4 ownership 表共20行并漏掉远端 V2.4 勘误任务书。**本任务书投递后**会再新增一份 Codex 只读任务书，因此 V2.5 写前实时预期为22条；仍须以实际 `git status --short` 为准。

所谓精确路径仍含错误/占位：`src/DesignStandards` 实际是 `src/DesignStandards.ts`；`src/__tests__/*`、`data/ledger/`不是精确文件；基线写成“d318ed3 内容”“写前 SHA”，允许 hunk 写“全部”，均不满足逐文件 SHA 和非重叠 hunk 要求。

v2.5 必须以实时 `git status --short` 逐项列全（若无并发漂移，投递本任务书后应为22条），两份 Codex 勘误任务书均标为只读投递物；对每个重叠目标提供完整 SHA-256、index/worktree 状态、owner、现有 diff hunk 和拟改 hunk。新 store、flow、schema、测试全部列精确文件名，不使用目录或 wildcard。

## 3. v2.5 唯一授权

仅授权在以下条件同时满足时修改同一 DRAFT：

1. 写前 SHA-256 仍为 `da9de22d166db96b5efbbf0b0b47ea183943246f2138aee537aaade5239a2f8c`；漂移立即停止；
2. 只改 `docs/harness-typed-evidence-and-two-phase-governance-design-v2-draft.md`；
3. 不改源码、测试、flow、hook、token、ledger、运行数据，不运行 SelfGuard/真实 flow，不重启，不签 token/exemption，不 commit/push；
4. 对 D1～D11 逐项裁决并给章节；
5. 回传完整 contract 抽取后的真实 `tsc --strict --noEmit` 零错证据和单一条件负例；
6. 回传原29+原28逐项追踪矩阵、唯一 WAL/锁/commit/crash 协议、唯一迁移/flow 路径和实时逐项 dirty ownership（无并发漂移时应为22项）；
7. 保留醒目的 DRAFT/未授权标记。

## 4. 冻结结论

V2.4 写入真实性通过，设计验收失败。Harness/WenStar 源码、测试、flow、hook、token/ledger、运行数据、服务、真实 flow、commit/push、A3f0/MR-1 继续冻结。V2.5 未通过独立机械验收前，不讨论源码实施。

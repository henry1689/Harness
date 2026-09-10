# Harness 类型化证据 v2.3 独立验收与 v2.4 强制勘误任务书

- 日期：2026-08-29
- 对象：`D:\AI文件\harness`
- 远端文档：`docs/harness-typed-evidence-and-two-phase-governance-design-v2-draft.md`
- v2.3 实测：28,457 bytes，617 行，SHA-256 `76684701c0ab1fc389b97fc3228e7168b46bdc2cb451b4546e9444b1636a9eb4`
- 上一版 SHA-256：`0962aa6c99813f3a1d869dc8093bd08a3c893959289e3fae5c883f54290c9f1a`
- 独立验收结论：**不通过；不得据此开始源码实施**

## 1. 独立真实性核对

本轮已恢复并使用 `wenstar-editor@100.111.83.52` 直接 SSH/SCP 读取远端，不以 Claude Code 摘要代替证据。实测结果：

- Harness：`main@737374ac678b176ae518b0d302d5e6fd6c604b0c`；
- DRAFT 写前/写后 SHA-256 与回报一致；
- dirty 集合仍为 17 staged、`M src/DualChannelSignal.ts`、`?? src/__tests__/DualChannelSignal.test.ts`、`??` 当前 DRAFT；
- WenStar：`feat/40d-perception@c436cb02b2c503a4e91a58861e903a4559dc4dc6`，既有 dirty 保持；
- Windows Harness 8765 仍在监听，WenStar 3000 未监听；
- 未观察到 Harness/WenStar 源码、测试、flow、hook、token 或服务因本轮发生新变化。

因此，“只修改一份 DRAFT”“写前/写后哈希”和冻结基线可以接受；“B1～B9 已全部闭环”不能接受。

## 2. v2.3 必须返工的实施阻断

### C1. 三层模型仍发生外部输入与系统字段串型

`EvidenceInputV2.optimization` 与内部 canonical 共用 `OptimizationDecision`，而该类型的 `TypedAuditMaterials` 含明确标注为系统生成的 `archived_at`。调用方因而仍可提交系统字段，直接违反 B1。

同一草案还引用但未定义 `TypedConfirmationInput`、`AuthorizationScopeInput`、`CanonicalConfirmation`；`CanonicalAuthorizationEvidenceV2.change_kind` 引用空壳 `CanonicalEvidenceV2`。这些不是可编译、可验证的完整契约。

v2.4 必须：

- 外部、canonical、ledger record 使用三套无交叉的完整判别类型；
- 外部 optimization 只允许人类语义和安全引用，不得携带 `archived_at`、归档结果或 producer；
- 写出所有被引用类型，不得使用 `/* 此处展开 */`、省略字段或循环引用；
- 给出 `tsc` 类型夹具，证明外部伪造系统字段以及缺失 canonical 必填字段均编译失败或被 ingress 拒绝。

### C2. approval 解析顺序存在摘要循环

草案先要求 approval record 的 `scope_digest` 与本次 scope 比较，又把 approval resolution 排在 scope canonicalization 之前。未 canonicalize 的路径不能得到权威 scope digest，导致先后顺序和信任边界未闭合。

v2.4 必须固定唯一顺序：解析安全记录引用 → 内部 canonicalize scope → 计算 plan/scope/baseline digest → 在同一事务快照中校验审批绑定 → 生成 canonical evidence。不得让调用方提供可被信任的 digest。

### C3. RepositorySnapshot 不能证明 dirty/untracked/hunk 冻结

`Map<FileId, string>` 不是明确的 canonical JSON 持久化结构；`untracked: FileId[]` 没有内容摘要，无法检测未跟踪文件内容漂移。草案宣称冻结 pre-existing dirty/hunk，却没有 hunk/文件 pre-image、owner、index/worktree 分层和冲突判定类型。`ScopeAmendment` 也只有文字，没有 record/state/审批绑定契约。

v2.4 必须：

- 使用稳定排序的数组记录 `{file_id, index_digest, worktree_digest, mode, tracked_state}`；
- untracked 文件必须绑定内容/模式摘要，不能只保存路径集合；
- 定义 pre-existing dirty ownership 与 hunk/file 粒度的机械验证规则；
- 定义完整 `ScopeAmendmentRecord`、批准主体、发生时点、原 scope、新 scope、reason、approval ref 和 ledger transition；
- 给出大小写、UNC/device、ADS、8.3、symlink/junction/reparse 后的最终解析身份和 repo-root 复验算法，不只给规范化字符串。

### C4. FileToken 不是有效、严格的 TypeScript 判别联合

各分支大量使用无类型字段简写，例如 `token_id; group_id; nonce`，不能作为类型草案编译；`succeeded` 分支缺 nonce、pre-write digest、consumption ref/time 等前态绑定，无法在类型层证明 post-check 终结的是同一次消费。

同时只说“废除双正文”，没有当前 `token_id.json + path alias JSON` 到新权威 record/index 的迁移、校验、损坏处理和回滚协议。

v2.4 必须提供：

- 可编译的各态完整字段及共享 ID 类型；
- `consumption_id`/nonce、pre/post digest、状态版本与 CAS 绑定；
- token secret、审计 hash/ref 的物理隔离；
- 旧双正文迁移步骤、冲突判定、索引重建、损坏 fail-closed、一次性切换点及回退条件。

### C5. ledger 和跨存储提交协议仍是口号

“append-only”与“临时文件 + 原子替换”未被组织成一个确定的 segment/WAL 模型。`LedgerTransition` 只有 payload digest，没有 previous digest、序号、frame/checksum，不能机械发现重排、截断或中间删除。“prepared/committed journal 或等价唯一提交点”仍是备选表述，没有唯一提交序列和逐崩溃点真值表。stale lock 的“超时清理”也未证明 fencing 安全。

v2.4 必须唯一选定并写清：

- ledger 物理路径、record framing、单调序号、previous digest/hash chain、fsync/rename 顺序；
- lock owner、nonce、lease、fencing token、续租和 takeover 规则；
- authorization record、token group、closure manifest、terminal audit 的唯一 commit point；
- 每一步之前/之后崩溃时，启动恢复的权威真值和投影补齐动作；
- 截断、重排、重复、部分写和损坏的 fail-closed 检测。

### C6. AuthorizationFact / ClosureFact 分层自相矛盾

依赖扫描在前文被定义为 authorization 时比较批准范围，却又放进 `ClosureFact`。`FactBase` 强制所有事实带 `closure_attempt_id` 和 result snapshot，这会错误约束 authorization facts；草案也没有展示 union 与 base 的真实组合方式。producer factory 仍主要是文字声明。

v2.4 必须：

- 给 AuthorizationFact 和 ClosureFact 各自独立 base；
- authorization dependency fact 绑定 baseline/authorization attempt，不绑定 closure attempt/result；
- closure fact 全部绑定唯一 closure attempt、result snapshot 和 canonical diff；
- 用 type-level `fact_type → producer → result` 映射限制内部 factory；
- 明确每类 factory 的命令、配置、版本、时间、timeout、exit/output digest 与计数不变量。

### C7. 两个 run 的真实数据流画错

草案时序把 closure method 消费 token 后再执行“S3 落地”，等同让 closure run 写代码。实际边界应为：authorization run 产生 token → 外部编辑器写入且 pre/post-check 消费/终结 token → closure run 只验证结果并闭环 obligation。YAML `work_manual` 不是编辑执行器，也不能作为落地证据。

v2.4 必须重画状态和时序，明确编辑动作发生在两个 run 之间；StageRunner 只运行注册表中的真实验证 handler，closure 永不签 token、永不执行代码写入。

### C8. manifest envelope 仍缺可信签名和跨存储一致性

payload/envelope 去自引用方向正确，但 `signed_by: string` 和任意 `audit_archive_ref: string` 不能证明签名者或归档对象真实存在。manifest、ledger、terminal audit 的事务关系仍未闭合。

v2.4 必须把 signer identity、算法/key ref/signature 或明确的服务端 MAC 方案写成可验证类型；archive ref 必须解析到持久化对象及 digest。若本期不做密码学签名，应删除 `signed_by` 的安全暗示并给出服务端可信边界、权限和完整性保证。

### C9. TerminalRecord 缺 free-success，且开放字符串破坏 fail-closed

判别联合没有 free mode 成功分支，但真值表声称 free 可 completed；abort 的 `end_reason` 最后带 `| string`，使稳定枚举失效。文中声称 `token_issued` 从 TerminalRecord 派生，类型和表格却都没有该字段，也没有 authorization/manifest/terminal persistence 状态。

v2.4 必须：

- 增加严格的 free-success 分支；
- 删除开放 `string`，所有未知原因映射到一个稳定 `unknown_internal_error` 并保留安全 diagnostic；
- 从唯一 TerminalRecord 机械派生 success、flow status、end reason、token eligible、token issued；
- 真值表同时列出 authorization record、token group、manifest、ledger commit 和 terminal audit 的持久化真值；
- 覆盖 human denied/timeout、retry limit、circuit breaker、stage error、user abort、persistence failure 和 recovery。

### C10. 迁移策略和 M1 边界仍未作唯一裁决

“离线 replay shadow 或 M2～M4 原子切换二选一”误把前置验证与生产切换当替代项；M1 也仍是“能独立则独立，否则合并”的待决定状态。原任务要求的是唯一实施顺序，不允许把关键决定留给实施阶段。

v2.4 必须固定：先离线 replay + 规则审计 + 差异批准工件，再进行 M2～M4 原子切换；并明确 M1 是否进入同一原子包。给出唯一切换/回退条件、切换前后服务状态与禁止半迁移的机械验证。

### C11. 35 项测试不满足“保留 29 项并新增 28 项”

v2.3 只有 35 项总表，已丢失 v2.2 中 bugfix+common、依赖批准清单、actual 越界、required planned 缺失、affected/unmodified、snapshot mismatch、optimization 非法组合等既有语义。它既不是 29 项全量保留，也没有覆盖全部新增项。

v2.4 必须提供原 v2.2 29 项到新用例的逐项映射，再完整覆盖上一任务书 28 项新增要求；合并用例必须列出多个独立断言，不能靠改名视为覆盖。正常下限为 57 个可追踪 case，若合并则仍须有 57 个 requirement ID 与实现层/测试文件/断言映射。

### C12. 必改影响面和 dirty ownership 未闭合

影响面漏掉仍消费 global memo/review details/终态信号的 `src/ConvergenceGate.ts`、`src/DualChannelSignal.ts`、`src/ComplianceScorer.ts`，并未核清 `DesignStandards`、`GateController` 等消费者。两份 flow、MCP schema、新 ledger store 和测试只写类别，没有精确路径。现有 H1/H0 dirty 的“已批准”不等于自动授权 H2/V2 在同文件或同 hunk 上继续写。

v2.4 必须：

- 用引用/调用搜索列出所有 producer、transit、consumer；
- 所有必改/不改项写精确仓库相对路径；
- 对 staged、unstaged、untracked 的每一项重新申报 owner、基线 hash、允许 hunk 和合并策略；
- 明确 H1/H0 既有变更如何保留，未获得新实施授权前不得写任何重叠文件。

## 3. v2.4 唯一授权和回传要求

当前只授权 Claude Code 在以下前提下修订同一份 DRAFT：

1. 写前 SHA-256 必须仍为 `76684701c0ab1fc389b97fc3228e7168b46bdc2cb451b4546e9444b1636a9eb4`；若不一致立即停止；
2. 只改 `docs/harness-typed-evidence-and-two-phase-governance-design-v2-draft.md`；
3. 不改源码、测试、flow、hook、token/ledger/运行数据，不运行 SelfGuard/真实 flow，不重启，不签 token/exemption，不 commit/push；
4. 回传写前/写后 SHA-256、实时 branch/HEAD/`git status --short`；
5. 对 C1～C12 逐项给出“接受/拒绝/替代”与准确章节，不能只写“已修复”；
6. 附上完整、无省略、可编译的类型草案和类型负例；
7. 给出唯一时序、ledger/commit/crash truth table、迁移顺序、精确影响面；
8. 给出不少于 57 个 requirement ID 的测试追踪矩阵，映射到实现层、精确测试路径和断言；
9. 保持醒目的“DRAFT、不构成实施授权”声明。

## 4. 当前冻结结论

v2.3 的文档写入真实性通过，但设计验收失败。Harness/WenStar 源码、测试、flow、token、ledger、运行数据、服务重启、真实 flow、commit/push 和 A3f0 全部继续冻结。只有 v2.4 经再次独立验收通过后，才讨论实施拆包、dirty ownership、SelfGuard 与服务操作。


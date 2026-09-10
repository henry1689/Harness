# Harness V2.5 并发候选独立验收与机械返工任务书

- 日期：2026-08-30
- 远端仓库：`D:\AI文件\harness`
- 目标 DRAFT：`docs/harness-typed-evidence-and-two-phase-governance-design-v2-draft.md`
- 当前候选实测：45,286 bytes，815 个 LF 行，SHA-256 `d5146a66f86572ff09c8a93362269a0b59e15cc1f687e47fc4d0827200886b49`
- Harness：`main@737374ac678b176ae518b0d302d5e6fd6c604b0c`
- 裁决：**V2.5 候选真实性可确认，机械验收不通过；仅允许在同一 DRAFT 内做 V2.5-R1 收敛返工。**

## 1. 并发事实与写入门槛

推进者首次核对时，任务书 SHA 为 `c25ff04058f706a2f7a98e14b37f5c306d0f3c12e16962a4fe18a4008c4d5790`，DRAFT 尚为 `da9de22d166db96b5efbbf0b0b47ea183943246f2138aee537aaade5239a2f8c`。读取窗口内 DRAFT 先变为 `c722a382ef27298e1be6205baffc98a5d13dbf41359a85059050796a6bfefc8c`（45,178 bytes），随后又变为当前 `d5146a66…6b49`（45,286 bytes）。后一次只移动四个 `@ts-expect-error` 到具体非法属性，未改变 D2～D11 主体。

不得恢复或覆盖为 `da9de…`/`c722…`。只有同时满足以下条件才允许返工：

1. 本任务书 SHA-256 与推进者给出的值一致；
2. DRAFT 写前 SHA-256 仍精确为 `d5146a66f86572ff09c8a93362269a0b59e15cc1f687e47fc4d0827200886b49`；
3. 实时 HEAD 仍为 `737374ac678b176ae518b0d302d5e6fd6c604b0c`，dirty 未出现新的源码/测试/flow 路径；
4. 任一不符立即停止，报告一次，不重建方案、不覆盖文件。

## 2. 已通过项，不要回退

- 全部 fenced `ts` 代码按序抽取后，以 TypeScript 7.0.2 执行 `--strict --noEmit --skipLibCheck`，退出码 0；
- 删除四条 `@ts-expect-error` 后，恰好得到四个目标诊断：非法 `archived_at`、非法 confirmation `result`、裸字符串 `audit_archive_ref`、开放 `end_reason`；
- `CanonicalDelta`、`ClosureScope` 已定义；ADS 已改为拒绝；stale lock 已改为维护窗口处置；M1 已明确并入原子包；两份 locked-purpose flow 已给出精确名称；DRAFT/未授权标记仍在。

这些结论必须保留，不得再次回传 C1～C12 或 V2.4 旧报告。

## 3. V2.5-R1 必须机械闭环的七项阻断

### E1. D1 仍未满足“正例/负例分文件”及 `satisfies`

正文声称负例使用 `satisfies`，实际全文零处 `satisfies`；正负例只是两个 Markdown code block，没有文件名、抽取脚本、tsconfig 或分 fixture 命令。

必须在 DRAFT 内给出：

- `contract.ts`、`positive.ts`、四个独立 `negative-*.ts` 的明确内容/拼装规则；
- 每个负例是完整输入，仅一个非法条件，使用 `satisfies` 与精准 `@ts-expect-error`；
- 可直接复制运行的抽取脚本、`tsconfig.contract.json`、TypeScript 7.0.2 命令；
- 全量契约退出 0、正例退出 0、四个负例分别在去掉抑制后只出现一个预期诊断；不得依赖无关缺字段。

### E2. D2/D6 的 factory 与审批真值仍未被类型绑定

当前 `ProducedFact<K> = ClosureFactBase & FactoryFactMap[K]` 中 `ClosureFactBase.producer` 仍是整个 `ProducerFactoryId`。机械反例已证实：`ProducedFact<'tsc_runner@v1'>` 搭配 `producer:'test_runner@v1'` 可在 strict 下退出 0。`approval_resolver@v1` 结果也只有 `approval_id/scope_match/rule_keys`，未绑定逐 key 的 subject、decision、scope digest、plan digest。

必须：

- 让 K 同时决定 `producer` 字面量、`fact_type`、`result` 和正确的 Authorization/Closure Base；错误 producer 必须成为独立负例并编译失败；
- approval resolver 的 ProducedFact 必须保存每个请求 key 的注册表 ID、subject、decision、scope digest、plan digest 与解析结果；未知 key、缺记录、主体/结果/scope/plan 不符均在生成 canonical evidence 前拒绝；
- 成功的 `CanonicalAuthorizationEvidenceV2` 不得携带 `missing_or_conflict` 分支。失败使用独立 ingress verdict，不进入 canonical 机器输入。

### E3. D3 的 FileId/Hunk 协议仍是文字断言

`resolved_identity:string` 仍混合 existing/new 两种身份；`HunkIdentity` 没有 `first_line`、changed range、内容摘要，却在公式和冲突算法中使用这些信息；无法机械判断行区间重叠与同内容重放。case-sensitive segment、reparse parent 和 repo-root handle 复验也没有判别结果。

必须定义 existing/new FileId 判别联合；existing 绑定卷/文件身份，新文件绑定已解析 parent FileId + normalized leaf。定义逐段 reparse/root 验证失败类型。HunkIdentity 必须包含可排序的 range、context/content digest、算法版本，并给出排序、重算、重放、重叠和冲突的伪代码及反例。

### E4. D4/D8 仍没有唯一可恢复的 commit/terminal 真值

`TransactionFrame.commit_marker:string` 仍在普通 frame 内，不是独立 commit marker；`objects[]` 的实体存储、prepare/commit 顺序、CAS/fence 校验及恢复算法未定义。`head.json` 被称作唯一提交点，但目录 fsync 又只是“尽力”，没有明确失败分支。

§10 仍有不可持久化终态：record 持久化前崩溃时没有任何 commit/audit，却声称存在 authoritative abort；manifest commit 前崩溃行同时写 token/record `consumed`、ledger `none`；`TransactionFrame` 只有 `terminal_audit`，没有独立 authoritative terminal object，却又称 audit 是可重建 projection。

必须给出唯一模型：prepared transaction、独立 commit marker、CAS 更新 trusted head、authoritative TerminalRecord 对象、audit projection 五者的精确物理文件和顺序；逐个 fsync/write/rename/head-CAS/audit 故障点列“磁盘可见对象、恢复读法、能否重试、唯一终态”。不能声称未持久化的 abort 是 authoritative。

### E5. D5 的 token group 与 secret store 不满足 Windows 实施条件

FileToken 有 `state_version/binding`，但 `TokenGroupRecord` 没有 group `state_version`、evidence/baseline/operation/canonicalization 绑定，也没有 group-level revoke 的 CAS。`data/secrets/tokens/ (0600)` 是 POSIX 表述，不是 Windows ACL/DPAPI 安全协议；路径位于仓库树内也未解释如何排除 Git、备份、日志和普通 editor 读取。

必须定义 group 全态 CAS、逐文件 transition 先决条件、partial failure 后 sibling revoke，以及 secret reference/index 的唯一权威。给出 Windows 服务账户 ACL/DPAPI 或等价可验证方案、权限探针、日志/备份/Git 排除规则。迁移失败只能冻结，不能回退双正文。

### E6. D10 没有按原 28 项映射，且缺项

正文明确写“因任务书正文仅在推进者侧……以 B1～B9 + D10 反推”，这直接违反“按原序号逐项映射”。原 28 项如下，必须按 1～28 原序逐项建立独立 requirement ID，不得从现表反推或合并遗漏：

1. V1 confirmation 不得直接转 true/token；2. 外部伪造 confirmed/system fields；3. approval ref/scope/plan 不匹配；4. Windows FileId 全 alias；5. succeeded 缺 digest 类型+运行时；6. token group 部分签发全部不可用；7. pre-check crash/post-check 缺失 recovery；8. 多文件部分写后 sibling revoke/重授权；9. rollback 无 recovery authorization；10. 双进程 CAS/fencing + 旧 attempt；11. ledger replace/截断/损坏/stale lock；12. authorization/token/closure 三时间边界；13. manifest payload digest 任一字段篡改；14. untracked/binary/rename/delete/mode；15. authorization/closure fact 隔离；16. fulfilled 缺 fact ref 类型+运行时；17. authorization store failure 唯一 abort/零 token/零 complete；18. manifest store failure 唯一 failure/零 closure_complete/零 token；19. retry 前 snapshot 漂移；20. 两 run 唯一终态且所有 consumer 一致；21. 既有 dirty 与 delta 分离、冻结 hunk 覆盖拒绝；22. token 双正文迁移后单一权威、索引损坏不复活；23. 两 authorization 文件集冲突 + 重启 fencing；24. attempt A fact 不混入 B；25. prepared crash + commit 后 audit 前 crash；26. 全 purpose/abort 的 TerminalRecord + token spy；27. S5/S6 不同真实 handler spy；28. replay 缺 repository snapshot fail-closed。

当前表至少缺少 6、8、13、16、21、22、23 的完整语义，并把 25 缩为仅 commit 后 crash。每一项必须有精确实现文件、唯一测试文件、独立断言和完整命令；禁止“同上”、`ledger`、`manifest`、`replay` 等非路径。

### E7. D11 的“精确 ownership”仍是占位

表内仍有“需实施前取”“同左”“写前 SHA”“全文件”，只列少数重叠目标；后文仍使用 `data/ledger/`、`data/secrets/tokens/`、`src/__tests__/**` 和 WenStar `src/**` wildcard，违反任务书的精确文件要求。`.claude/harness-pre-check.cjs` 已是 dirty 且列入必改，却被归入“其余 staged 非重叠”，自相矛盾。

必须基于写前实时 `git status --short`：

- 逐条列全每个 dirty 文件的完整 SHA-256、index/worktree 双状态、owner、现有 diff hunk ID；
- 对所有拟改且与 dirty 重叠的文件给非重叠拟改 hunk ID；无所有权则从实施范围剔除或明确阻断；
- 将每个新 store、schema、flow、测试展开为精确文件名；正文不得出现目录或 wildcard 作为“精确影响面”；
- 两份既有 Codex 任务书与本任务书均标为只读投递物。

## 4. 唯一授权与回传

只允许修改 `docs/harness-typed-evidence-and-two-phase-governance-design-v2-draft.md`，把同一文档收敛为 V2.5-R1；不新建另一份设计 DRAFT。禁止源码、测试、flow、hook、token/ledger、运行数据、SelfGuard、真实 flow、服务重启、token/exemption、commit/push、A3f0/MR-1。

回传仅包含：写前/写后完整 SHA；E1～E7 对应章节；全量/正例/逐负例真实 tsc 命令与退出码；原29 + 上述原28 的逐序矩阵；WAL/crash 真值；实时逐文件 ownership；冻结声明。不要再次回传 C1～C12/V2.4 报告。

V2.5-R1 仍是 DRAFT。未通过独立机械验收前，不批准 Harness 源码实施。

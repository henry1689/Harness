# Harness V2.5-R1 独立机械验收与 V2.5-R2 返工任务书

- 日期：2026-08-30
- 审阅对象：`D:\AI文件\harness\docs\harness-typed-evidence-and-two-phase-governance-design-v2-draft.md`
- 写后实测：45,736 bytes，841 个 LF 行，SHA-256 `af5e771efcbf1ab310ac5f686b96232a7d8ac7f8c3c2ed8018da915a19251977`
- Harness 基线：`main@737374ac678b176ae518b0d302d5e6fd6c604b0c`
- 裁决：真实性通过；E1 类型样例主体通过；E2～E7 尚未机械闭环，V2.5-R1 不批准实施。

## 1. 已独立通过的证据

1. 写前 SHA `d5146a66f86572ff09c8a93362269a0b59e15cc1f687e47fc4d0827200886b49` 与任务书门槛一致，写后 SHA/大小/行数与回传一致；HEAD 未变化。
2. 实时 `git status --short` 为 23 条：17 staged、1 unstaged、5 untracked；没有新增源码、测试或 flow 漂移。
3. 从 DRAFT 机械抽出 `contract.ts`、`positive.ts`、`negative-1.ts`～`negative-5.ts` 和 `tsconfig.contract.json`，以 TypeScript 7.0.2 独立运行：contract、positive、五个带抑制负例均退出 0；逐个删除 `@ts-expect-error` 后均退出 1 且恰一个诊断，依次为 TS2353、TS2353、TS2322、TS2322、TS2322。
4. DRAFT/未授权声明仍完整；未观察到源码、测试、flow、hook、token、ledger、服务、Git HEAD 或 WenStar 正式源码因本轮发生变化。

以上只证明文档写入真实性与当前七个 TypeScript fixture 的局部性质，不等于整体设计闭环或实施授权。

## 2. V2.5-R2 必须修正的七项

### F1. E1 样例能编译，但交付描述和抽取命令不自洽

- §1/§2 仍写“五文件”“negative-1～4”，实际为 7 个 TypeScript 文件（contract、positive、negative-1～5）；§5 又把 negative-5 描述成系列之外。
- 抽取脚本直接向 `D:\tmp\v25r1` 写文件，但未创建目录；当前实测该目录不存在，脚本不能按正文所称“直接复制运行”。
- 表内 positive 命令未带回传实际使用的 `--moduleResolution bundler --module ESNext`；`npx tsc` 也未钉死版本。Harness 自身 `node_modules/typescript/package.json` 当前为 5.9.3，不足以证明该命令必然调用 7.0.2。

R2 必须统一文件数和引用；抽取脚本先 `mkdir(parents=True, exist_ok=True)`；给出固定 TypeScript 7.0.2 的可重复调用方式及每个文件的完整命令。保留当前已经通过的七个 fixture，不要削弱负例。

### F2. E2 只绑定 producer/fact_type，未让 K 决定正确 phase/base

当前定义仍有两个对所有 `keyof FactoryFactMap` 开放的泛型：

```ts
ProducedFact<K> = ClosureFactBase & FactoryFactMap[K]
ProducedAuthFact<K> = AuthorizationFactBase & FactoryFactMap[K]
```

独立反例在 strict TypeScript 7.0.2 下退出 0：`ProducedFact<'approval_resolver@v1'>` 可以携带 ClosureFactBase；`ProducedAuthFact<'tsc_runner@v1'>` 可以携带 AuthorizationFactBase。故 K 没有同时决定正确 Authorization/Closure Base，违反 E2 明文要求。

R2 应把 phase/base 纳入单一 factory spec，并由 K 条件选择 base，或把泛型 K 约束到对应 phase；新增两个交叉 phase 负例，去抑制后各恰一个诊断。逐 key approval 字段可保留，但还要写清 canonical confirmation 与 resolver result 的不可错配关系及运行时拒绝点。

### F3. E3 的 HunkIdentity 与 hunkId/conflict 算法仍矛盾

- `HunkIdentity` 有 `content_digest`，但 `hunkId(H)` 未将它纳入摘要；相同 file/range/context、不同内容会得到同一 ID。
- `conflict(a,b) = overlap && content_digest !=` 把“不同区间但部分重叠、内容摘要恰相同”误判为不冲突；只有同 FileId、同 range、同 preimage/context、同 content、同算法版本才可视为幂等重放。
- 未定义插入/删除的零宽区间、端点语义、重算后的 ID 比对和失败 verdict。

R2 必须给出无碰撞字段集合、半开或闭区间的唯一语义、insert/delete 表达、recompute/replay 的判别结果，并至少加入“同 ID 不同 content”“部分重叠相同 content”“baseline context 漂移”三个反例。

### F4. E4 尚无可实现的五对象事务

- `PreparedTransaction.objects[]` 引用 authorization/token/manifest/terminal 对象，但 §7 未给这些 payload/object 的物理存储、原子写入和恢复路径。
- 顺序表在 head CAS 后才写 terminal，而 prepared 又预先引用 terminal；若 terminal payload 未先持久化，head 无法让恢复器重建它。
- prose 称 trusted head CAS “带 fence_token”，`TrustedHead` 类型却没有 fence/txn/version 字段。
- 故障表只列阶段，不覆盖每个 write/fsync/temp-rename/replace/CAS 拒绝/terminal 部分写/audit 写失败；也未定义 Windows 上文件与父目录持久性边界。
- “head 为权威”和“TerminalRecord 为权威”同时出现，尚未定义唯一的 committed/authoritative 判定式。

R2 必须选择单一 commit point，并使所有 terminal payload 在 commit point 前可恢复地持久化；补齐 immutable object store、temp/flush/replace、CAS expected/new value、fence 校验和逐故障点恢复算法。不得通过覆盖既有 terminal 修复；补偿必须是独立追加对象且不能制造第二终态。

### F5. E5 仍只有字段和原则，没有 Windows 可验证存储协议

- group `state_version` 已加，但没有 group record 的权威物理文件、expected-version CAS 伪代码、跨 tokens 的原子 sibling revoke 与崩溃恢复。
- `SecretReference` 只有类型；secret/index/reference 谁是唯一权威、索引损坏读法、原子创建/消费/删除没有定义。
- “仅 harness 服务 SID”“可选 DPAPI”“尝试读写”没有给出服务身份解析、ACL 建立/继承禁用、读写拒绝断言和启动探针的完整命令/结果；也没有机械证明普通 editor 账户不可读。

R2 必须给出精确 Windows ACL/DPAPI 选择、命令或等价 API、预期 ACL、正反权限探针、Git/备份/日志验证命令，以及迁移前后唯一权威和失败冻结 truth table。

### F6. E6 语义顺序已补，但矩阵仍违反任务书机械格式

R-030～R-057 已按原 1～28 顺序列出，这是进展；但表中仍大量使用“同上”，而 E6 明确禁止。R-011/R-029 的实现文件仍是“全链路”/“e2e”；R-031、R-034、R-045 用 `+ types 负例`、`+运行时` 等非唯一精确测试路径；多个命令写成 `npx tsc --noEmit + vitest` 或仅“同上”，不能独立执行。

R2 必须让每个 requirement ID 自包含：精确实现文件、一个精确测试文件、一个稳定测试名/断言和一条完整命令。一个语义若要求类型与运行时双测试，应拆为两个 requirement ID，允许总数超过 57。不得出现“同上”“全链路”“e2e”“运行时”“types 负例”、目录或组合占位。

### F7. E7 与实时现场及“精确”要求直接冲突

- §1/§11 写 22 条（17+1+4），实时为 23 条（17+1+5）。
- ownership 表只列 9 条，没有逐项列全 23 条；三份只读任务书加 DRAFT 和未跟踪测试本身就是 5 个 untracked。
- SHA 列仍为“实时取”，hunk 仍为 `H1-hunk-01…`/`H2-03…`，DRAFT 路径和 SHA 使用省略号/写前短 hash，均不是完整 SHA 或可复验 hunk ID。
- §11.2 仍使用 `data/ledger/prepared/`、`data/ledger/commit/`、`data/ledger/terminal/`、`data/ledger/audit/`、`data/secrets/tokens/`、`src/__tests__/`，与标题“无目录/wildcard”相反。

本任务书投递后会再增加一份只读文档，因此 R2 写前若无其他漂移，预期为 24 条（17 staged、1 unstaged、6 untracked），但必须以实时状态为准。R2 必须逐项列全全部 dirty：完整 worktree SHA-256、index SHA-256/不存在、XY 状态、owner、由实际 diff 内容计算的现有 hunk ID；所有拟改重叠文件还需给可复验的拟改 hunk 和不重叠证明。所有 store/schema/flow/test 均展开为精确实现文件名；动态运行对象可写完整模板路径，但不能拿目录代替实现文件。

## 3. 唯一授权与停止条件

仅授权在下列条件同时满足时，把同一 DRAFT 修订为 V2.5-R2：

1. 写前 DRAFT SHA-256 仍为 `af5e771efcbf1ab310ac5f686b96232a7d8ac7f8c3c2ed8018da915a19251977`；HEAD 仍为 `737374ac678b176ae518b0d302d5e6fd6c604b0c`；任一漂移立即停止并报告。
2. 只修改 `docs/harness-typed-evidence-and-two-phase-governance-design-v2-draft.md`；本任务书和既有三份任务书均只读。
3. 禁止修改源码、测试、flow、hook、token、ledger、运行数据；禁止 SelfGuard、真实 flow、服务重启、token/exemption、commit/push、WenStar 正式源码和 A3f0/MR-1。
4. 回传写前/写后完整 SHA、F1～F7 章节、TypeScript 7.0.2 全部 fixture 命令/退出码/诊断、phase 交叉负例、完整自包含测试矩阵、逐故障点事务真值和实时逐文件 ownership。

## 4. 冻结结论

V2.5-R1 的真实性与现有七个 TypeScript fixture 通过，但 E2～E7 的关键机械反例仍成立，不能据此批准 Harness 源码实施。V2.5-R2 独立验收通过前，Harness/WenStar 源码、测试、flow、hook、token/ledger、运行数据、服务、真实 flow、commit/push、A3f0/MR-1 继续冻结。

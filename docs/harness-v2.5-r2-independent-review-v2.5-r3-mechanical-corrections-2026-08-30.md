# Harness V2.5-R2 独立机械验收与 V2.5-R3 返工任务书

- 日期：2026-08-30
- 审阅对象：`D:\AI文件\harness\docs\harness-typed-evidence-and-two-phase-governance-design-v2-draft.md`
- R2 实测：58,744 bytes，974 个 LF 行，SHA-256 `cd97328e5d29f62a5e747e971d15ca8f6d835601c2032b8cb5dab07bae50e7fb`
- Harness：`main@737374ac678b176ae518b0d302d5e6fd6c604b0c`
- 裁决：写入真实性、九个 fixture 与 F2 phase/base 绑定通过；F1、F3～F7 未机械闭环，不批准源码实施。

## 1. 已通过项，R3 不得回退

1. 写前/写后 SHA、58,744 bytes、974 行、HEAD 和 24 条现场均与回传一致；未发现新增源码、测试或 flow 漂移。
2. 从 DRAFT 抽取 `contract.ts`、`positive.ts`、`negative-1.ts`～`negative-7.ts`，以 TypeScript 7.0.2 独立复跑：contract、positive、七个带抑制负例全部退出 0；逐个删除抑制后都退出 1 且恰一个诊断，依次为 TS2353、TS2353、TS2322、TS2322、TS2322、TS2353、TS2353。
3. `FactoryPhaseMap + BaseFor<K>` 已关闭上一轮两个 phase 交叉反例；F2 接受。
4. F3 已把 content digest 纳入 hunk ID，并把非零区间重叠的幂等条件收紧；F6 已真实列出 60 个唯一 R-ID。这些进展应保留。

## 2. V2.5-R3 必须闭环的六项

### G1. F1 的 fixture 主体通过，但文档仍未统一

- §1 仍写“五文件”“negative-1～4”“实时 22 条”，与 R2 的九文件/24 条冲突。
- §2 的 negative-1～7 命令仍写“同上”，而上一任务书要求每个文件给完整命令。
- contract 注释、positive 的版本字符串和 runner tool version 仍写 R1/5.7；不影响本次编译，但破坏版本证据一致性。

R3 必须更新陈旧摘要和版本字段，并为九个 fixture 各写一条完整、可复制的 TypeScript 7.0.2 命令；不得使用“同上”。

### G2. F3 的零宽插入永远不会 overlap

正文把插入定义为 `[p,p)`，同时定义：

```text
overlap(a,b) = a.start < b.end && b.start < a.end
```

因此两个位于同一点的插入 `[10,10)` 与 `[10,10)` 两个比较均为 `10 < 10 = false`；不同内容也不会冲突。插入与覆盖该点附近的删除/替换同样缺唯一边界规则。

R3 必须增加 insertion-aware 判定：明确两个同点插入何时 identical、何时 conflict，并明确插入与 `[start,end)` 删除/替换在端点的冲突语义。至少给出同点同内容、同点不同内容、插入位于删除起点/内部/终点的机械反例。

### G3. F4 的“CAS”只是 read-then-rename，会丢更新

“读 version V → 写 new V+1 → 原子替换”不是 compare-and-swap。两个进程可同时读到 V，各自写临时文件并依次 rename；两次 rename 都成功，后者覆盖前者，没有任何 CAS conflict。`fence_token` 虽在类型中出现，但 head 更新算法没有在同一原子边界校验当前锁/fence。

另有三处矛盾：

- object rename 后一行称“objects 为权威”，但唯一判定式又规定只有 head commit 才权威；rename 后 object 应只是 durable candidate。
- “immutable object store”没有定义 object digest/文件名绑定与已存在对象拒绝覆盖。
- 故障表仍未说明 Windows 上 temp/FlushFileBuffers/replace、父目录元数据以及进程崩溃后的精确耐久边界。

R3 必须选择可实现的并发串行化方案：例如独占 writer lock 下重新读取 expected head、校验单调 fence、再执行 replace；normal writer 不得自动接管 stale lock，stale 只进入维护恢复。给出两个 writer 同读 V 的交错时序反例并证明只允许一个提交。object 必须 create-new/content-addressed，已存在同名不同摘要 fail-closed。

### G4. F5 的 TokenGroup CAS、immutable store 与 Windows secret 协议互相冲突

- group record 被放在 immutable `objects/<group_id>.json`，但 transition 又覆盖同一路径；这不是 immutable，也不是 CAS，仍可发生与 head 相同的双 writer 丢更新。
- 应改为 versioned immutable object（例如 group/version/digest）并由同一 committed pointer/head 选择当前版本，或明确采用独立 mutable store；不能同时声称两者。
- index 被称作可重建、非权威，迁移表却把 `.secret + index.json` 合称唯一权威。损坏后扫描 `.secret` 还必须证明不会把已 consumed/revoked/expired token 复活；授权状态只能取 committed group state。
- `whoami /upn` 返回 UPN，不返回 SID；本机对当前 SSH 服务账户实测还直接失败。SID 应由 `whoami /user`、`sc.exe showsid` 或等价 API 取得。
- `icacls /inheritance:r /grant:r` 不会自动删除所有其他 explicit ACE，不能证明“仅服务账户可读”。必须给完整 ACL 构造和 AccessCheck 正反验证。
- `Protect-CmsMessage`/`Unprotect-CmsMessage` 是 CMS 接口，不是 DPAPI。若选 DPAPI，应使用 `CryptProtectData`/`ProtectedData` 或 DPAPI-NG 并说明 scope；若选 CMS，应准确称 CMS，并定义证书私钥 ACL/轮换。
- 当前 `runas /user:standard "<SERVICE_SID>" ...` 参数位置和身份含义错误，不能作为反向权限探针。

R3 必须给出一种唯一、实际可执行的 Windows 方案，不再并列“可选”。包含精确身份、ACL、加密 scope、正反 AccessCheck、日志/Git/备份验证、迁移和索引损坏不复活测试。

### G5. F6 有 60 个 ID，但“完整命令”不可执行

矩阵说明写 `V=`/`T=` 是类别，但命令单元格实际为 `V npx ...` 或 `T npx ...`。机械执行 `V npx --version` 已实测退出 127：`V: command not found`。这不是完整命令。

此外，直接运行一个“预期 tsc 编译失败”的文件会让 CI 命令非零失败；必须由 wrapper 精确断言 expected exit code、诊断数量与诊断 code，或使用带 `@ts-expect-error` 的正向 fixture 并另做去抑制验证。

R3 应把 V/T 移到独立“测试层”列，命令列只保留可直接执行的真实命令。所有类型负例使用一个精确脚本路径和完整参数，成功验证预期错误时 wrapper 自身退出 0；60 行不得使用 shell alias、未定义变量或人工解释。

### G6. F7 仍不是“完整 SHA/精确 ownership”

- 24 条数量确实正确，但表中所有 SHA 仅保留 16 位加省略号；DRAFT 写“写后实时(回传)”。这不是完整 SHA-256。
- 四份任务书和 DRAFT 路径仍用 `docs/…` 省略，不是精确路径。
- index 列声称 SHA-256，脚注却取 `git ls-files -s`；本机实测 `src/types.ts` 返回 40 位 Git object ID `00c3b67fcca7b3fb7a83c37d1b2ad54fe52e9916`，不是内容 SHA-256。
- 重叠表只有自然语言“diff 摘要”，没有由实际 diff 内容计算的现有 hunk ID、拟改 hunk ID或不重叠证明。
- §11.3 仍含 `data/ledger/objects/`、`prepared/`、`commit/`、`audit/`、`data/secrets/tokens/`、`src/__tests__/` 等目录，直接违反“无目录/wildcard”。

本任务书投递后，若无其他漂移，预期现场变为 25 条（17 staged、1 unstaged、7 untracked），但 R3 必须实时读取。逐项写全精确路径、64 位 worktree SHA-256、64 位 index-content SHA-256或明确不存在、XY、owner、现有 hunk digest；所有拟改重叠目标写实际 proposed hunk digest 与不重叠证明。Git object ID 可另列，但不得标成 SHA-256。把“实现源文件”和“动态 runtime object 模板”分表；实现表不得用目录代替文件。

## 3. 唯一授权与回传要求

仅授权在下列条件同时满足时，把同一 DRAFT 修订为 V2.5-R3：

1. 写前 DRAFT SHA-256 仍为 `cd97328e5d29f62a5e747e971d15ca8f6d835601c2032b8cb5dab07bae50e7fb`，HEAD 仍为 `737374ac678b176ae518b0d302d5e6fd6c604b0c`；任一漂移停止并报告。
2. 只修改 `docs/harness-typed-evidence-and-two-phase-governance-design-v2-draft.md`；本任务书及既有四份任务书只读。
3. 禁止源码、测试、flow、hook、token、ledger、运行数据、SelfGuard、真实 flow、服务重启、token/exemption、commit/push、WenStar 正式源码、A3f0/MR-1。
4. 回传写前/写后完整 SHA，G1～G6 章节，九 fixture 的完整命令/退出码，零宽插入反例，双 writer CAS 交错证明，唯一 Windows secret 方案，60 条可直接执行命令和实时 25 条完整 ownership。

## 4. 冻结结论

V2.5-R2 已实质关闭 F2，并让九个 TypeScript fixture 通过；但 filesystem CAS、零宽 hunk、TokenGroup/secret 权威和 dirty ownership 仍存在可复现反例。V2.5-R3 独立验收前，不进入 Harness 源码实施边界；Harness/WenStar 正式源码、flow、服务、token、commit/push、A3f0/MR-1 继续冻结。

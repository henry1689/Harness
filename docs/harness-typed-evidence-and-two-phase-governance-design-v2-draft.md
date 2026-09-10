# Harness 类型化证据与两阶段治理设计 v2.5-R5(DRAFT)

> 🔴 **DRAFT — 未批准实施**
>
> 本文档为**设计草案**,供复核,不构成任何执行授权:
> - ❌ 不构成源码修改授权
> - ❌ 不构成 SelfGuard / 重启 / flow 授权
> - ❌ 不构成 commit / push / A3f0 授权
>
> 状态:2026-08-30;V2.5-R3 独立机械验收(裁决:d31bbf 基线)后依**限定 R4 修正**(G2/G3/G4/G5/G6)收敛为 v2.5-R4;V2.5-R4 独立验收(任务书 `6157a6d7…`,8,664 bytes)后依**R5 最终限定修正**(H1 fencing / H2 Windows ACL-AccessCheck / H3 ownership digest)收敛为 v2.5-R5。仍为 DRAFT,未通过机械验收前不批准源码实施。
> 写前 SHA-256:`71b38b7edc9252522a0b3da9bbb3d80ac0262339f41a0b2f1b22799d222ab403`。

---

## 目录

1. [审计回顾与 R4/R5 限定返工](#1-审计回顾与-r4r5-限定返工)
2. [分文件类型 Fixture(E1)](#2-分文件类型-fixture)
3. [类型契约 contract.ts(可编译)](#3-类型契约-contractts可编译)
4. [正例 positive.ts 与逐负例 negative-*.ts](#4-正例与逐负例)
5. [Confirmation 真值类型绑定(E2)](#5-confirmation-真值类型绑定)
6. [FileId/Hunk 判别协议(E3)](#6-fileidhunk-判别协议)
7. [唯一 Commit/Terminal 模型(E4)](#7-唯一-committerminal-模型)
8. [Token Group 与 Windows Secret 协议(E5)](#8-token-group-与-windows-secret-协议)
9. [迁移唯一裁决与 flow](#9-迁移唯一裁决与-flow)
10. [测试追踪矩阵:原29 + 原28 逐序(E6)](#10-测试追踪矩阵)
11. [实时逐文件 Ownership(E7)](#11-实时逐文件-ownership)
12. [规则生命周期与时序](#12-规则生命周期与时序)

---

## 1. 审计回顾与 R4/R5 限定返工

V2.5-R3 独立机械验收裁决(2026-08-30):G1 通过;G2/G3/G4/G6 仍有关键缺口;G5 部分。R4 为**限定修正**,不扩写大方案,按裁决 7 项逐一闭环:

| # | R4 必须修正 | R4 对策(章节) |
|---|---|---|
| 1 | 插入点判断 `p <= end` 与半开正文 `p==end` 不重叠矛盾 | §6 公式改 `start <= p && p < end`;机械覆盖起点/内部/终点/同点同不同内容 |
| 2 | 锁内现读现赋 expected 退化为自比较;W2 早前读 V 未绑定进 prepared | §7+§3 `PreparedTransaction` 不可变绑定 `expected_head_version/seq/digest`;锁内重读当前 HEAD 与绑定值比较 |
| 3 | fault 表"object rename 后 objects 为权威"与"HEAD 唯一 commit point"冲突 | §7 object 在 HEAD CAS 成功前一律为**未提交 durable candidate**,非权威 |
| 4 | `whoami /user` 与 `sc.exe showsid` 被当同一 SID;ACL/AccessCheck 用"或/逐项" | §8 唯一 Windows 身份模型(账户 SID/per-service SID/DPAPI CurrentUser 三概念区分);确定性 ACL 脚本 + 真实正反 AccessCheck,无"或" |
| 5 | DRAFT 自 SHA 回写自身造成结构性自引用 | §11 快照由外部 verifier 冻结后生成;快照 SHA 记录于验收报告,不写入 DRAFT |
| 6 | staged 标 no-diff;拟改目标只有"同上" | §11 staged=HEAD→index、unstaged=index→worktree 真实 hunk;拟改 hunk 未冻结→明确 `BLOCKED_NO_OWNERSHIP` |
| 7 | `scripts/run-tsc-fixture.cjs` 不存在;参数无诊断数量/代码断言 | §10 定义 wrapper 契约(TS 版本/退出码/诊断数量/诊断代码/wrapper 自身退出语义),命令列补全参数 |

V2.5-R4 独立机械验收裁决(2026-08-30,R5 任务书 `6157a6d7…`):R4 其余通过;仅剩 H1/H2/H3 三项监管核心缺口。R5 为**最终限定修正**,锁死范围(只修 fencing、Windows ACL/AccessCheck、ownership digest),不扩写新架构:

| # | R5 必须修正 | R5 对策(章节) |
|---|---|---|
| H1 | `current.fence_token == current_fence` 用旧 HEAD fence 与锁内现读比较,下一位合法 writer 永久失败或 fencing 失效 | §3+§7 分离 `expected_head_fence_token`(prepare 绑定)与 `writer_fence_token`(acquire 锁时锁存储返回的新单调 fence);锁内重读 current 与绑定值比较;3 机械交错(W1/W2 CAS_CONFLICT、W3 后续成功、旧持有者 lease 失效拒绝) |
| H2 | R4 `DirectorySecurity.AccessCheck` 不存在;`icacls /remove:g *` 非法;SID 冒充 token;无 fail-closed 退出码 | §8 唯一可执行协议:受保护空 DACL + 按具体 SID 删除 + 单 ACE;真实令牌(ImpersonateSelf 服务账户 / ImpersonateAnonymousToken S-1-5-7);行为有效访问探针(等价受支持 API,因本机 AccessCheck P/Invoke 实测 1360 环境性硬阻断);4 模式退出码 0/0/0/1 已在目标机实测 |
| H3 | R4 digest 不可复现(未钉 git 参数,context 3 与 -U0 混用) | §11 钉死协议:`--no-pager -c core.pager=cat -c color.ui=never -c diff.external= --no-ext-diff --no-textconv --no-color -U0`;对 native stdout 原始 bytes 哈希;仓库外 verifier `D:\tmp\harness-v2.5-r5-ownership-verifier.ps1` + 快照 `D:\tmp\harness-v2.5-r5-ownership-snapshot.json`;`src/types.ts`/`.gitignore` 已复现任务书值 |

---

## 2. 分文件类型 Fixture

**九文件拼装规则**(在 DRAFT 内直接可复制):

| 文件 | 内容 | 编译命令(TS 7.0.2,固定版本) |
|---|---|---|
| `contract.ts` | §3 全部类型定义(仅类型,零值) | `npx --yes --package typescript@7.0.2 tsc -p tsconfig.contract.json` → 退出 0 |
| `positive.ts` | §4 正例值(完整输入,全部合法) | `npx --yes --package typescript@7.0.2 tsc --strict --noEmit --skipLibCheck --moduleResolution bundler --module ESNext positive.ts` → 退出 0 |
| `negative-1.ts` | 外部 optimization 带 `archived_at`(satisfies) | npx --yes --package typescript@7.0.2 tsc --strict --noEmit --skipLibCheck --moduleResolution bundler --module ESNext negative-1.ts;去抑制后恰一诊断 |
| `negative-2.ts` | 外部 confirmation 带 `result`(satisfies) | npx --yes --package typescript@7.0.2 tsc --strict --noEmit --skipLibCheck --moduleResolution bundler --module ESNext negative-2.ts|
| `negative-3.ts` | 裸字符串 `audit_archive_ref`(satisfies) | npx --yes --package typescript@7.0.2 tsc --strict --noEmit --skipLibCheck --moduleResolution bundler --module ESNext negative-3.ts|
| `negative-4.ts` | 开放 `end_reason`(satisfies) | npx --yes --package typescript@7.0.2 tsc --strict --noEmit --skipLibCheck --moduleResolution bundler --module ESNext negative-4.ts|
| `negative-5.ts` | 错误 producer 与 fact_type 不匹配(satisfies) | npx --yes --package typescript@7.0.2 tsc --strict --noEmit --skipLibCheck --moduleResolution bundler --module ESNext negative-5.ts|
| `negative-6.ts` | F2:auth phase 携带 closure base 字段(satisfies) | npx --yes --package typescript@7.0.2 tsc --strict --noEmit --skipLibCheck --moduleResolution bundler --module ESNext negative-6.ts|
| `negative-7.ts` | F2:closure phase 携带 authorization base 字段(satisfies) | npx --yes --package typescript@7.0.2 tsc --strict --noEmit --skipLibCheck --moduleResolution bundler --module ESNext negative-7.ts|

> TS 版本固定:`npx --yes --package typescript@7.0.2 tsc …`(不依赖本地 node_modules 的 5.9.3;Harness 本地版本不影响该调用)。

**抽取脚本**(先创建目录,按 `// FILE:` 首行标记分文件):

```python
import re, pathlib
out_dir = pathlib.Path(r'D:\tmp\v25r4')
out_dir.mkdir(parents=True, exist_ok=True)           # 先建目录
doc = pathlib.Path(r'D:\AI文件\harness\docs\harness-typed-evidence-and-two-phase-governance-design-v2-draft.md').read_text(encoding='utf-8')
out = {}
cur = None
for m in re.finditer(r'```ts\n(.*?)```', doc, re.DOTALL):
    body = m.group(1)
    fm = re.match(r'// FILE: (\S+)\n', body)
    if fm:
        cur = fm.group(1); out[cur] = [body]
    elif cur:
        out[cur].append(body)
for name, blocks in out.items():
    (out_dir / name).write_text('\n\n'.join(blocks), encoding='utf-8')
```

**tsconfig.contract.json**:

```json
{
  "compilerOptions": { "strict": true, "noEmit": true, "skipLibCheck": true,
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler" },
  "files": ["contract.ts"]
}
```

---

## 3. 类型契约 contract.ts(可编译)

```ts
// FILE: contract.ts
// ═══════════════════════════════════════════════════════════════
// v2.5-R4 contract — 全部类型定义(仅类型,零值)
// ═══════════════════════════════════════════════════════════════

export type ChangeKind = 'bugfix' | 'feature' | 'refactor';
export type ClassificationType = 'common' | 'specific';
export type RequirementFlag = 'required' | 'optional';
export type ModuleRole = 'producer' | 'transit' | 'consumer' | 'modified';

// ── FileId / Identity(E3)──
export type FileIdentity =
  | { kind: 'existing'; volume_id: string; file_identity: string }
  | { kind: 'new'; parent: FileId; leaf: string; normalized_leaf: string };

export interface FileId {
  canonical: string;
  identity: FileIdentity;
  version: string;
}

export type ReparseVerdict =
  | { kind: 'ok'; identity: FileIdentity; root_confined: true }
  | { kind: 'rejected'; reason: 'ads' | 'device_path' | 'reserved_name' | 'escape_repo' | 'unresolved_reparse' | 'invalid' };

export interface HunkIdentity {
  file: FileId;
  range: { start_line: number; end_line: number };
  context_before_digest: string;
  context_after_digest: string;
  content_digest: string;
  algorithm_version: string;
}

export interface SnapshotFileEntry {
  file_id: FileId;
  index_digest: string;
  worktree_digest: string;
  mode: number;
  tracked_state: 'tracked' | 'untracked' | 'deleted';
}

export interface RepositorySnapshot {
  head: string;
  index_tree: string;
  files: SnapshotFileEntry[];
  captured_at: string;
  canonicalization_version: string;
  snapshot_digest: string;
}

export interface DirtyOwnership {
  file: FileId;
  owner: string;
  baseline_digest: string;
  allowed_hunks: HunkIdentity[];
}

export interface CanonicalDelta {
  baseline_snapshot_digest: string;
  result_snapshot_digest: string;
  changed_files: FileId[];
  hunks: HunkIdentity[];
  canonicalization_version: string;
  delta_digest: string;
}

export interface ClosureScope {
  actual_modified_files: FileId[];
}

export interface ModuleRef {
  id: string;
  roles: ModuleRole[];
}

// ── 外部输入(E2:confirmation 无 result;optimization 无系统字段)──
export type ExternalOptimizationDecision =
  | { kind: 'none'; reason: string }
  | {
      kind: 'exists';
      decision: 'accepted' | 'rejected' | 'deferred';
      reason: string;
      proposal_ref: string;
      audit_materials_refs: {
        original_plan_ref: string;
        optimization_plan_ref: string;
        diff_matrix_ref: string;
        approval_record_ref: string;
      };
    };

export interface ExternalConfirmationRequest {
  key: string;
  note?: string;
}

export interface EvidenceInputV2 {
  schema_version: 2;
  approval_ref: string;
  change_kind: ChangeKind;
  classification: { type: ClassificationType; reason: string };
  optimization: ExternalOptimizationDecision;
  confirmations: ExternalConfirmationRequest[];
  authorization_scope: {
    planned_files: Array<{ path: string; requirement: RequirementFlag }>;
    affected_module_ids: string[];
    reviewed_dependency_ids: string[];
  };
  approved_plan_human: string;
  global_architecture_decision: string;
}

// ── 审批与 canonical(E2:成功 canonical 不携带 missing;失败走 ingress verdict)──
export interface ApprovalRuleDecision {
  rule_id: string;
  subject: string;
  decision: 'approved' | 'denied';
  scope_digest: string;
  plan_digest: string;
}

export type CanonicalConfirmation = {
  key: string;
  decision: ApprovalRuleDecision;
  confirmed_at: string;
};

export type IngressVerdict =
  | { kind: 'accepted'; evidence: CanonicalAuthorizationEvidenceV2 }
  | { kind: 'rejected'; reason: 'unknown_rule_key' | 'approval_not_found' | 'subject_mismatch' | 'decision_denied' | 'scope_mismatch' | 'plan_mismatch' | 'scope_escape' };

export type InternalOptimizationDecision =
  | { kind: 'none'; reason: string }
  | {
      kind: 'exists';
      decision: 'accepted' | 'rejected' | 'deferred';
      reason: string;
      proposal_ref: string;
      audit_materials: {
        original_plan_digest: string;
        optimization_plan_digest: string;
        diff_matrix_digest: string;
        approval_record_digest: string;
      };
    };

export interface InternalAuthorizationScope {
  authorized_files: FileId[];
  planned_files: Array<{ file: FileId; requirement: RequirementFlag }>;
  affected_modules: ModuleRef[];
  reviewed_dependencies: ModuleRef[];
}

export interface CanonicalAuthorizationEvidenceV2 {
  schema_version: 2;
  approval: { approval_id: string; scope_digest: string; plan_digest: string; confirming_subject: string; rule_keys: string[] };
  change_kind: ChangeKind;
  classification: { type: ClassificationType; reason: string };
  optimization: InternalOptimizationDecision;
  confirmations: CanonicalConfirmation[];
  authorization_scope: InternalAuthorizationScope;
  plan_digest: string;
  canonicalization_version: string;
}

// ── Fact(E2:producer 由 FactoryFactMap 精确决定)──
export interface RunnerMetadata {
  command: string;
  config: string;
  tool_version: string;
  started_at: string;
  finished_at: string;
  timeout_ms: number;
  exit_status: number;
  output_digest: string;
}

export interface DependencyGraphResult {
  generated_by: 'internal_dependency_scanner';
  algorithm: string;
  source_snapshot_digest: string;
  canonicalization_version: string;
  nodes: ModuleRef[];
  edges: Array<{ from: string; to: string }>;
  scanned_at: string;
}

export interface KeyApprovalResolution {
  rule_id: string;
  subject: string;
  decision: 'approved' | 'denied';
  scope_digest: string;
  plan_digest: string;
  resolved: 'ok' | 'unknown_key' | 'missing_record' | 'subject_mismatch' | 'decision_denied' | 'scope_mismatch' | 'plan_mismatch';
}

export type FactoryFactMap = {
  'tsc_runner@v1':           { fact_type: 'tsc_result';              producer: 'tsc_runner@v1';           result: { exit_code: number; output_digest: string } };
  'test_runner@v1':          { fact_type: 'test_result';             producer: 'test_runner@v1';          result: { passed: number; failed: number; total: number; duration_ms: number } };
  'diff_scanner@v1':         { fact_type: 'diff_scope';              producer: 'diff_scanner@v1';         result: { delta: CanonicalDelta } };
  'dependency_scanner@v1':   { fact_type: 'dependency_scan';         producer: 'dependency_scanner@v1';   result: DependencyGraphResult };
  'doc_verifier@v1':         { fact_type: 'doc_sync';                producer: 'doc_verifier@v1';         result: { docs: Array<{ path: string; digest: string }> } };
  'hook_auditor@v1':         { fact_type: 'hook_audit';              producer: 'hook_auditor@v1';         result: { events: number; coverage: string[] } };
  'approval_resolver@v1':    { fact_type: 'approval_resolution';     producer: 'approval_resolver@v1';    result: { keys: KeyApprovalResolution[] } };
  'scope_canonicalizer@v1':  { fact_type: 'scope_canonicalization';  producer: 'scope_canonicalizer@v1';  result: { files: FileId[]; version: string } };
  'dirty_scanner@v1':        { fact_type: 'dirty_baseline';          producer: 'dirty_scanner@v1';        result: { snapshot: RepositorySnapshot } };
  'dependency_approver@v1':  { fact_type: 'dependency_approval';     producer: 'dependency_approver@v1';  result: { expected: DependencyGraphResult; approved: boolean } };
};

export interface AuthorizationFactBase {
  authorization_run_id: string;
  baseline_snapshot_digest: string;
  executed_at: string;
  canonicalization_version: string;
  policy_version: string;
  runner: RunnerMetadata;
}

export interface ClosureFactBase {
  closure_attempt_id: string;
  authorization_run_id: string;
  result_snapshot_digest: string;
  canonical_diff_digest: string;
  executed_at: string;
  canonicalization_version: string;
  policy_version: string;
  runner: RunnerMetadata;
}

// K 同时决定 phase/base(F2):每个 factory 明确 phase
export type FactoryPhaseMap = {
  'tsc_runner@v1': 'closure';
  'test_runner@v1': 'closure';
  'diff_scanner@v1': 'closure';
  'dependency_scanner@v1': 'closure';
  'doc_verifier@v1': 'closure';
  'hook_auditor@v1': 'closure';
  'approval_resolver@v1': 'authorization';
  'scope_canonicalizer@v1': 'authorization';
  'dirty_scanner@v1': 'authorization';
  'dependency_approver@v1': 'authorization';
};

export type BaseFor<K extends keyof FactoryFactMap> =
  FactoryPhaseMap[K] extends 'closure' ? ClosureFactBase : AuthorizationFactBase;

export type ProducedFact<K extends keyof FactoryFactMap> = BaseFor<K> & FactoryFactMap[K];

export type AuthFactoryKeys = 'approval_resolver@v1' | 'scope_canonicalizer@v1' | 'dirty_scanner@v1' | 'dependency_approver@v1';
export type CloFactoryKeys = 'tsc_runner@v1' | 'test_runner@v1' | 'diff_scanner@v1' | 'dependency_scanner@v1' | 'doc_verifier@v1' | 'hook_auditor@v1';

export type AuthorizationFact = { [K in AuthFactoryKeys]: ProducedFact<K> }[AuthFactoryKeys];
export type ClosureFact = { [K in CloFactoryKeys]: ProducedFact<K> }[CloFactoryKeys];

// ── Manifest / Integrity / Obligation ──
export interface ArchiveObjectRef {
  archive_id: string;
  object_path: string;
  digest: string;
}

export interface ClosureManifestPayload {
  run_id: string;
  authorization_record_id: string;
  authorization_evidence_digest: string;
  baseline_snapshot_digest: string;
  result_snapshot_digest: string;
  canonical_diff_digest: string;
  canonicalization_version: string;
  closure_scope: ClosureScope;
  facts: ClosureFact[];
  obligation_resolutions: ObligationResolution[];
  audit_archive_ref: ArchiveObjectRef;
}

export interface ManifestIntegrity {
  scheme: 'server_hmac_sha256';
  key_ref: string;
  mac_nonce: string;
  policy_version: string;
  mac_inputs: { schema_version: string; payload_digest: string; policy_key_version: string; nonce: string };
  mac: string;
}

export interface ClosureManifestEnvelope {
  payload: ClosureManifestPayload;
  manifest_digest: string;
  integrity: ManifestIntegrity;
}

export interface RuleId {
  registry: 's4-rules';
  id: string;
  version: number;
}

export type ApplicabilityInput =
  | { kind: 'file_scope'; files: FileId[] }
  | { kind: 'module_scope'; modules: ModuleRef[] }
  | { kind: 'global' };

export interface AuthorizationObligation {
  id: string;
  rule: RuleId;
  promised_at: string;
  due_stage: 'S5' | 'S6' | 'closure';
  applicability_input: ApplicabilityInput;
  policy_version: string;
}

export type ViolationCode =
  | 'V_DOC_SYNC_MISSING' | 'V_ROBUSTNESS_MISSING' | 'V_HOOK_MISSING'
  | 'V_TSC_FAIL' | 'V_TEST_FAIL' | 'V_SCOPE_DRIFT' | 'V_DIRTY_OVERLAP';

export type ObligationResolution =
  | { obligation_id: string; status: 'fulfilled'; fact_ref: { fact_type: ClosureFact['fact_type']; digest: string } }
  | { obligation_id: string; status: 'breached'; violation_code: ViolationCode }
  | { obligation_id: string; status: 'pending' };

export interface ScopeAmendmentRecord {
  amendment_id: string;
  authorization_record_id: string;
  approving_subject: string;
  occurred_at: string;
  original_scope: InternalAuthorizationScope;
  new_scope: InternalAuthorizationScope;
  reason: string;
  approval_ref: string;
  status: 'proposed' | 'approved' | 'rejected';
}

// ── Token(E5:group 全态 CAS)──
export interface TokenBinding {
  allowed_operation: 'write_file';
  evidence_digest: string;
  baseline_snapshot_digest: string;
  canonicalization_version: string;
}

export type FileToken =
  | { state: 'issued'; token_id: string; group_id: string; file: FileId; nonce: string; issued_at: string; expires_at: string; state_version: number; binding: TokenBinding }
  | { state: 'consumed_pending_postcheck'; token_id: string; group_id: string; file: FileId; nonce: string; consumption_id: string; consumed_at: string; pre_write_digest: string; state_version: number; binding: TokenBinding }
  | { state: 'succeeded'; token_id: string; group_id: string; file: FileId; nonce: string; consumption_id: string; pre_write_digest: string; post_write_digest: string; postcheck_at: string; state_version: number; binding: TokenBinding }
  | { state: 'failed'; token_id: string; group_id: string; file: FileId; nonce: string; consumption_id: string; reason: string; failed_at: string; state_version: number; binding: TokenBinding }
  | { state: 'revoked'; token_id: string; group_id: string; file: FileId; nonce: string; revoked_at: string; reason: string; state_version: number; binding: TokenBinding }
  | { state: 'expired'; token_id: string; group_id: string; file: FileId; nonce: string; expired_at: string; state_version: number; binding: TokenBinding };

export interface TokenGroupRecord {
  group_id: string;
  authorization_record_id: string;
  state: 'active' | 'partial' | 'fully_consumed' | 'revoked' | 'expired';
  state_version: number;                 // group 级 CAS(E5)
  binding: TokenBinding;
  tokens: FileToken[];
  issued_at: string;
  expires_at: string;
}

export interface SecretReference {
  token_id: string;
  secret_ref: string;                    // 指向 secret store,不落正文
  secret_digest: string;
}

// ── Ledger / Commit(E4)──
export interface PreparedTransaction {
  txn_id: string;
  objects: Array<{ type: 'authorization_record' | 'token_group' | 'closure_manifest' | 'terminal_record'; ref: string; payload_digest: string }>;
  seq: number;
  previous_digest: string;
  frame_checksum: string;
  prepared_at: string;
  expected_head_version: number;   // R4/R5(H1):prepare 时不可变绑定,commit request 契约;
  expected_head_seq: number;       //   锁内仅重读当前 HEAD 与该绑定值比较,不得现读现赋
  expected_head_digest: string;
  expected_head_fence_token: string; // R5(H1):prepare 时绑定的旧 HEAD fence,属 immutable expected_head;
                                     //   新 writer fence(writer_fence_token)由锁存储返回,prepared 不伪造
}

export interface CommitMarker {
  txn_id: string;
  committed_at: string;
  writer_fence_token: string; // R5(H1):commit 时成功取得 writer lock 后由锁存储返回的新单调 fence
}

export interface TrustedHead {
  head_seq: number;
  head_digest: string;
  committed_txn_id: string;      // F4:最近提交事务
  writer_fence_token: string;    // R5(H1):最近成功提交 writer 的新单调 fence(不是旧 HEAD fence)
  version: number;               // F4:head CAS 版本(expected/new value)
  durable: boolean;
}

export interface LockEntry {
  lock_id: string;
  owner: string;
  nonce: string;
  lease_ms: number;
  fence_token: string;
  renewed_at: string;
  expires_at: string;
}

export type StaleLockVerdict = 'STALE_LOCK_REQUIRES_MAINTENANCE';

// ── Terminal(E4:authoritative 独立对象)──
export type StableEndReason =
  | 'human_denied' | 'human_timeout' | 'retry_limit' | 'circuit_breaker'
  | 'stage_error' | 'user_abort' | 'recovery_required' | 'unknown_internal_error';

export type TerminalRecord =
  | { purpose: 'authorization'; outcome: 'authorization_complete'; success: true; flow_status: 'completed'; end_reason: 'authorization_complete'; token_eligible: true; token_issued: true }
  | { purpose: 'closure'; outcome: 'closure_complete'; success: true; flow_status: 'completed'; end_reason: 'closure_complete'; token_eligible: false; token_issued: false }
  | { purpose: 'free'; outcome: 'free_complete'; success: true; flow_status: 'completed'; end_reason: 'free_complete'; token_eligible: false; token_issued: false }
  | { purpose: 'authorization' | 'closure' | 'free'; outcome: 'abort'; success: false; flow_status: 'aborted'; end_reason: StableEndReason; token_eligible: false; token_issued: false };

export interface AuthorizationRecord {
  record_id: string;
  evidence_digest: string;
  scope_digest: string;
  plan_digest: string;
  obligations: AuthorizationObligation[];
  status: 'authorized' | 'token_issued' | 'token_consumed' | 'closure_pending' | 'closed' | 'closure_failed' | 'closure_overdue' | 'expired';
  created_at: string;
  expires_at: string;
}
```

---

## 4. 正例与逐负例

```ts
// FILE: positive.ts
// 正例:完整合法输入,全部字段
import type {
  EvidenceInputV2, CanonicalConfirmation, ClosureFact, TerminalRecord,
  ProducedFact, ApprovalRuleDecision,
} from './contract';

const validExternal: EvidenceInputV2 = {
  schema_version: 2,
  approval_ref: 'appr-001',
  change_kind: 'bugfix',
  classification: { type: 'common', reason: '统一收敛闸门契约' },
  optimization: { kind: 'none', reason: '本期仅登记,不扩大包' },
  confirmations: [{ key: 'RISK_NO_HARDCODED', note: 'diff 已核' }],
  authorization_scope: {
    planned_files: [{ path: 'src/ConvergenceGate.ts', requirement: 'required' }],
    affected_module_ids: ['module:convergence-gate'],
    reviewed_dependency_ids: ['module:dual-channel-signal'],
  },
  approved_plan_human: '…',
  global_architecture_decision: '…',
};

const decision: ApprovalRuleDecision = {
  rule_id: 'RISK_NO_HARDCODED', subject: 'henry', decision: 'approved',
  scope_digest: 's1', plan_digest: 'p1',
};
const approvedConfirmation: CanonicalConfirmation = { key: 'RISK_NO_HARDCODED', decision, confirmed_at: '2026-08-30T00:00:00.000Z' };

const tscFact: ClosureFact = {
  fact_type: 'tsc_result',
  producer: 'tsc_runner@v1',
  result: { exit_code: 0, output_digest: 'd1' },
  closure_attempt_id: 'ca-1',
  authorization_run_id: 'ar-1',
  result_snapshot_digest: 'rs-1',
  canonical_diff_digest: 'cd-1',
  executed_at: '2026-08-30T00:00:00.000Z',
  canonicalization_version: 'v2.5-r1-1',
  policy_version: 'pol-1',
  runner: { command: 'npx --yes --package typescript@7.0.2 tsc --noEmit', config: 'tsconfig.contract.json', tool_version: '7.0.2', started_at: 't0', finished_at: 't1', timeout_ms: 60000, exit_status: 0, output_digest: 'od' },
};

const tscProduced: ProducedFact<'tsc_runner@v1'> = tscFact;

const freeTerminal: TerminalRecord = {
  purpose: 'free', outcome: 'free_complete', success: true,
  flow_status: 'completed', end_reason: 'free_complete', token_eligible: false, token_issued: false,
};

const okInputs: Array<EvidenceInputV2 | CanonicalConfirmation | ClosureFact | TerminalRecord> = [
  validExternal, approvedConfirmation, tscFact, freeTerminal,
];
```

```ts
// FILE: negative-1.ts
// 负例 1:外部 optimization 携带系统字段 archived_at(satisfies;完整输入,仅此一处非法)
import type { EvidenceInputV2 } from './contract';
const bad = {
  schema_version: 2, approval_ref: 'a', change_kind: 'bugfix',
  classification: { type: 'common', reason: 'r' },
  optimization: { kind: 'exists', decision: 'deferred', reason: 'r', proposal_ref: 'p',
    audit_materials_refs: { original_plan_ref: 'o', optimization_plan_ref: 'p', diff_matrix_ref: 'd', approval_record_ref: 'a' },
    // @ts-expect-error — 'archived_at' does not exist in type 'ExternalOptimizationDecision'
    archived_at: 'x' },
  confirmations: [], authorization_scope: { planned_files: [], affected_module_ids: [], reviewed_dependency_ids: [] },
  approved_plan_human: 'p', global_architecture_decision: 'g',
} satisfies EvidenceInputV2;
```

```ts
// FILE: negative-2.ts
// 负例 2:外部 confirmation 携带 result(satisfies;完整输入,仅此一处非法)
import type { EvidenceInputV2 } from './contract';
const bad = {
  schema_version: 2, approval_ref: 'a', change_kind: 'bugfix',
  classification: { type: 'common', reason: 'r' }, optimization: { kind: 'none', reason: 'r' },
  confirmations: [{
    key: 'RISK_NO_HARDCODED',
    // @ts-expect-error — 'result' does not exist in type 'ExternalConfirmationRequest'
    result: true,
  }],
  authorization_scope: { planned_files: [], affected_module_ids: [], reviewed_dependency_ids: [] },
  approved_plan_human: 'p', global_architecture_decision: 'g',
} satisfies EvidenceInputV2;
```

```ts
// FILE: negative-3.ts
// 负例 3:manifest 保存裸字符串 audit_archive_ref(satisfies;完整输入,仅此一处非法)
import type { ClosureManifestPayload } from './contract';
const bad = {
  run_id: 'r', authorization_record_id: 'ar', authorization_evidence_digest: 'e',
  baseline_snapshot_digest: 'b', result_snapshot_digest: 'rs', canonical_diff_digest: 'cd',
  canonicalization_version: 'v', closure_scope: { actual_modified_files: [] },
  facts: [], obligation_resolutions: [],
  // @ts-expect-error — 'string' is not assignable to type 'ArchiveObjectRef'
  audit_archive_ref: 'just-a-string',
} satisfies ClosureManifestPayload;
```

```ts
// FILE: negative-4.ts
// 负例 4:abort 的 end_reason 使用开放字符串(satisfies;完整输入,仅此一处非法)
import type { TerminalRecord } from './contract';
const bad = {
  purpose: 'closure', outcome: 'abort', success: false, flow_status: 'aborted',
  // @ts-expect-error — '"whatever"' is not assignable to type 'StableEndReason'
  end_reason: 'whatever', token_eligible: false, token_issued: false,
} satisfies TerminalRecord;
```

```ts
// FILE: negative-5.ts
// 负例 5(E2):错误 producer 与 fact_type 不匹配(satisfies;完整输入,仅此一处非法)
import type { ProducedFact } from './contract';
const bad = {
  fact_type: 'tsc_result',
  // @ts-expect-error — producer must match fact_type ('tsc_runner@v1')
  producer: 'test_runner@v1',
  closure_attempt_id: 'ca-1',
  authorization_run_id: 'ar-1',
  result_snapshot_digest: 'rs-1',
  canonical_diff_digest: 'cd-1',
  executed_at: '2026-08-30T00:00:00.000Z',
  canonicalization_version: 'v',
  policy_version: 'p',
  runner: { command: 'x', config: 'x', tool_version: 'x', started_at: 't', finished_at: 't', timeout_ms: 1, exit_status: 0, output_digest: 'x' },
  result: { exit_code: 0, output_digest: 'x' },
} satisfies ProducedFact<'tsc_runner@v1'>;
```

```ts
// FILE: negative-6.ts
// 负例 6(F2):authorization phase fact 错误携带 closure base 字段 closure_attempt_id
import type { ProducedFact } from './contract';
const bad = {
  fact_type: 'approval_resolution',
  producer: 'approval_resolver@v1',
  result: { keys: [] },
  authorization_run_id: 'ar-1',
  baseline_snapshot_digest: 'b-1',
  executed_at: '2026-08-30T00:00:00.000Z',
  canonicalization_version: 'v',
  policy_version: 'p',
  runner: { command: 'x', config: 'x', tool_version: 'x', started_at: 't', finished_at: 't', timeout_ms: 1, exit_status: 0, output_digest: 'x' },
  // @ts-expect-error — 'closure_attempt_id' does not exist in type 'AuthorizationFactBase'
  closure_attempt_id: 'ca-1',
} satisfies ProducedFact<'approval_resolver@v1'>;
```

```ts
// FILE: negative-7.ts
// 负例 7(F2):closure phase fact 错误携带 authorization base 字段 baseline_snapshot_digest
import type { ProducedFact } from './contract';
const bad = {
  fact_type: 'tsc_result',
  producer: 'tsc_runner@v1',
  result: { exit_code: 0, output_digest: 'x' },
  closure_attempt_id: 'ca-1',
  authorization_run_id: 'ar-1',
  result_snapshot_digest: 'rs-1',
  canonical_diff_digest: 'cd-1',
  executed_at: '2026-08-30T00:00:00.000Z',
  canonicalization_version: 'v',
  policy_version: 'p',
  runner: { command: 'x', config: 'x', tool_version: 'x', started_at: 't', finished_at: 't', timeout_ms: 1, exit_status: 0, output_digest: 'x' },
  // @ts-expect-error — 'baseline_snapshot_digest' does not exist in type 'ClosureFactBase'
  baseline_snapshot_digest: 'b-1',
} satisfies ProducedFact<'tsc_runner@v1'>;
```

---

## 5. Confirmation 真值类型绑定

- `ExternalConfirmationRequest` 仅 `{key, note?}`,**无 result**;
- canonical 阶段按审批记录逐 key 解析:`ApprovalRuleDecision` 携带 rule_id/subject/decision/scope_digest/plan_digest;`KeyApprovalResolution.resolved` 区分 ok/unknown_key/missing_record/subject_mismatch/decision_denied/scope_mismatch/plan_mismatch;
- **成功 `CanonicalAuthorizationEvidenceV2.confirmations` 只含 `{key, decision, confirmed_at}`(无 missing 分支)**;任何失败 → `IngressVerdict.rejected`(独立 verdict),不进入 canonical 机器输入;
- **producer 类型绑定(E2)**:`FactoryFactMap[K].producer` 精确为 K 字面量;`ProducedFact<'tsc_runner@v1'>` 配 `producer:'test_runner@v1'` → 编译失败(负例见 §4 negative 系列之外,E2 专项负例见回传 tsc 证据)。

---

## 6. FileId/Hunk 判别协议

**伪代码**(排序/重算/重放/重叠/冲突;区间统一半开 `[start, end)`;**insertion-aware**):

```
区间语义:半开 [start_line, end_line);插入 = start==end(零宽 [p,p),零宽保留);
         删除 = preimage 非空且 range 指向被删段;替换 = 删除+插入(删除段内插入)
         重算后 ID 必须用相同算法版本
hunkId(H) = H(algorithm_version, file.canonical, range.start, range.end,
              context_before_digest, context_after_digest, content_digest)   // content_digest 必入摘要
isInsert(H) = H.range.start == H.range.end                                   // 零宽判定
sort(hunks) = order by (file.canonical, range.start, range.end)
overlap(a,b) =
  a.file.canonical != b.file.canonical ? false
  : (isInsert(a) && isInsert(b))
      ? (a.range.start == b.range.start)                                     // 同点插入才 overlap
  : isInsert(a)
      ? (b.range.start <= a.range.start && a.range.start < b.range.end)      // 半开 [start,end):含 p==start,含内部 p==end-1,不含 p==end(段后)
  : isInsert(b)
      ? (a.range.start <= b.range.start && b.range.start < a.range.end)
      : (a.range.start < b.range.end && b.range.start < a.range.end)         // 非零宽半开
identical(a,b) = a.file.canonical == b.file.canonical
               && a.range.start == b.range.start && a.range.end == b.range.end
               && isInsert(a) == isInsert(b)                                 // 零宽与零宽;非零宽与非零宽
               && a.context_before_digest == b.context_before_digest
               && a.context_after_digest  == b.context_after_digest
               && a.content_digest == b.content_digest
               && a.algorithm_version == b.algorithm_version
conflict(a,b) = overlap(a,b) && !identical(a,b)                              // 同点不同内容/插入在删除段内均冲突
recompute(H, snapshot) → 'match' | 'baseline_drift' | 'content_drift'
replay(hunks, baseline) → 'ok' | 'conflict' | 'baseline_drift'
```

**插入与删除/替换的端点语义(唯一裁决,R4 消除公式/正文矛盾)**:判定谓词唯一为 `in_segment(p, [start,end)) := start <= p && p < end`。插入点 `p` 落在删除/替换段 `[start,end)` 内(`p==start` 起点、`p==end-1` 内部)→ `overlap`;`p==end` 段后 → **不** overlap;`p<start` 段前 → 不 overlap。`overlap && !identical` → `conflict`。公式与正文现一致(上一版 `p <= end` 已改 `< end`)。机械覆盖:起点 `p==start`、内部 `start<p<end-1`、终点 `p==end-1`、段后 `p==end`、段前 `p<start`、同点同内容、同点不同内容。

**三个机械反例**:
1. **同点同内容插入**:两个 `[10,10)` 插入、`content_digest` 相同 → `overlap=true`(同点)+ `identical=true` → **幂等重放,不冲突**;
2. **同点不同内容插入**:两个 `[10,10)` 插入、`content_digest` 不同 → `overlap=true` + `identical=false` → **conflict**(原公式 `10<10=false` 误判不重叠,insertion-aware 修正);
3. **插入位于删除起点/内部/终点**:插入 `[10,10)` vs 删除 `[10,20)` → `p=10 ∈ [10,20)` → `overlap=true` + 非 identical → **conflict**;插入 `[20,20)` vs 删除 `[10,20)` → `p=20 == end`,在段后 → 不 overlap;插入 `[15,15)`(段内部)→ conflict。

**reparse/root 验证**:`ReparseVerdict` 判别;逐段 reparse parent → `{kind:'ok', identity, root_confined:true}` 或 `rejected`(ads/device_path/reserved_name/escape_repo/unresolved_reparse/invalid)。

---

## 7. 唯一 Commit/Terminal 模型

**单一 commit point + immutable object store**(F4):

- **immutable object store**:所有 payload(authorization_record/token_group/closure_manifest/terminal_record)先写 `data/ledger/objects/<obj_id>.json`(临时文件→fsync→原子 rename;只增不改);
- **prepared transaction**:`data/ledger/prepared/<txn_id>.json`(引用 object 集合);
- **commit marker(独立)**:`data/ledger/commit/<txn_id>.marker`;
- **trusted head(CAS)= 唯一 commit point**:`data/ledger/head.json`;CAS 语义 = 读当前 version 为 expected → 构造 new{seq+1,digest,committed_txn_id,fence,version+1} → 原子替换(失败=CAS 拒绝);
- **authoritative TerminalRecord**:head 提交后指向的 object 即权威(terminal payload 在步骤 0 已先持久化,head 可让恢复器重建);
- **audit projection**:`data/ledger/audit/<run_id>.json`,从 objects + head 重建。

**写顺序**(terminal payload 先于 commit point 持久化;**head 更新 = 独占 writer lock 内真 CAS,非 read-then-rename**):

```
0. 读取并不可变绑定 expected_head = {version, seq, digest, fence_token}(R5/H1:含旧 HEAD fence)
1. 写 content-addressed objects 与 prepared/<txn_id>.json(prepared 只记录 expected_head,不伪造新 writer fence)
2. acquire_writer_lock(owner, nonce) -> writer_fence_token   // 锁存储返回新单调 fence,不从 HEAD 现读
3. 锁内重读 current HEAD = {head_seq, head_digest, committed_txn_id, writer_fence_token, version}
4. 同一锁边界内验证(全部通过才可提交):
     current.{version, seq, digest, fence_token} == prepared.expected_head
     lock_store.current.{owner, nonce, fence_token} == {owner, nonce, writer_fence_token}
     lock 未过期(lease 未过期)
     writer_fence_token > current.writer_fence_token      // 严格单调递增,杜绝旧 fence 复用
5. 写 commit/<txn_id>.marker(记录 writer_fence_token)
6. 原子替换 new_head = {seq+1, digest(new), committed_txn_id=txn_id, writer_fence_token, version+1}
     → temp → flush → replace
7. release lock
   任一验证失败(CAS 拒绝)→ 事务未提交,可重试;CAS 冲突后不得改写原 prepared 的 expected,
   须基于新 HEAD 重新验证业务前置并创建新 txn_id/prepared;仅 HEAD 已提交的同一 txn_id 走幂等返回
8. 恢复器/审计读取:head.committed_txn_id → objects 重建 terminal/audit
```

**锁协议(R5/H1)**:正常 writer 用 `acquire_writer_lock(owner, nonce)` 独占,成功时锁存储返回**新单调 `writer_fence_token`**(非 HEAD 现读);持有者用原 nonce 续租(续租不改变 fence);其他 writer 等待;过期锁(stale)→ 正常 writer **不接管**,报 `STALE_LOCK_REQUIRES_MAINTENANCE`,仅维护窗口(确认所有 writer 停止)处置。`LockEntry.fence_token` 由锁存储维护,与 `expected_head_fence_token`(旧 HEAD fence)是两个不同值。

**R5/H1 三个机械交错(逐项裁决)**:

```
交错 1(两 writer 同基于 V 准备,只允许一个提交):
  W1/W2 各在 prepare 时绑定 expected_head={V,S,D,F}。
  W1: acquire_lock -> writer_fence_token=F+1;锁内重读 current={V,S,D,F,...};verify 全通过
      write new_head={V+1,...,writer_fence_token=F+1};release
  W2: acquire_lock -> writer_fence_token=F+2;锁内重读 current.version=V+1 ≠ 绑定的 V
      → CAS_CONFLICT,T2 未提交(不得改写 prepared.expected;须新 txn_id 重新准备)
  ⇒ 只有 W1 提交。

交错 2(后续合法 writer 不被永久拒绝):
  W3 在 W1 后基于 V+1 新准备 expected_head={V+1,...}。
  W3: acquire_lock -> writer_fence_token=F+2;锁内重读 current.version=V+1 == 绑定值;
      且 F+2 > F+1(current.writer_fence_token)严格单调 → verify 通过
      write new_head={V+2,...,writer_fence_token=F+2};release
  ⇒ W3 成功提交 V+2,协议不永久拒绝后续 writer。

交错 3(旧锁持有者 lease 失效后不得写):
  W1 曾持有锁但 lease 已过期;W1 仍持有旧文件句柄/旧 fence=F+1。
  W1 再次 acquire_writer_lock(owner, nonce) 失败(锁已 stale,正常 writer 不接管)
  或即使强行持句柄提交:锁内校验 lock_store.current.{owner,nonce,fence_token} != W1 的旧值
      → 拒绝;即便其 expected 匹配也不得写。
  ⇒ 旧持有者被拒绝,不会用旧 fence 污染新 HEAD。
```

**Windows 耐久边界**:temp 写 → `FlushFileBuffers`(文件句柄)→ rename(同卷原子)→ `FlushFileBuffers`(父目录句柄);flush 前崩溃 → 临时丢弃;flush 后、rename 前 → 对象为 **durable candidate(未提交)**;进程崩溃 → 按 head/锁磁盘状态恢复,锁 lease 过期 → stale → 维护处置。

**逐故障点真值**(含每个 write/fsync/temp-rename/CAS 拒绝/部分写/audit 写失败):

| 故障点 | 磁盘可见 | 恢复读法 | 能否重试 | 唯一终态 |
|---|---|---|---|---|
| object 临时写未 fsync | 无/临时 | 丢弃临时 | 可重试 | 无 terminal |
| object rename 后 | object(**未提交 durable candidate**) | 非权威;authoritative 仅 committed head 指向对象 | 无需重试 | 无 terminal(未 commit) |
| prepared 未 fsync | prepared 临时 | 丢弃 | 可重试 | 无 terminal |
| marker 未 fsync | marker 临时 | 丢弃 | 可重试 | 无 terminal |
| head CAS 拒绝(version 冲突) | 旧 head | 以旧 head 为权威 | 可重试(读新 expected) | 无 terminal(事务未提交) |
| head CAS 成功 | 新 head | **head 为唯一权威** | 不重试 | terminal 已可重建(从 objects) |
| terminal object 部分写 | 无完整 object | objects 校验失败 → fail-closed | 可重写 object | 无 terminal |
| audit 写失败 | objects+head | 重建 audit projection | 可重建 | terminal 不变 |

- **object 权威口径(统一)**:object 在 HEAD CAS 成功前一律为**未提交 durable candidate**,不得称 "objects 为权威";权威唯一判定式:
- **唯一判定式**:authoritative = `head.committed_txn_id` 指向的 object store 中的 `terminal_record`;无该对象 → 无 authoritative terminal(不是"abort 终态");
- 未持久化的 abort **不是** authoritative;`persistence_failure` 仅当 head CAS 已成功但 terminal object 缺失 → `recovery_required`,无 terminal,恢复时**追加补偿对象**(独立,不覆盖),禁止改写无 terminal 状态为 complete;
- 不覆盖既有 terminal:补偿是独立追加对象,且不得制造第二终态。

---

## 8. Token Group 与 Windows Secret 协议

- `TokenGroupRecord` 增加 `state_version`(group 级 CAS)与 `binding`(evidence/baseline/operation/canonicalization);
- group-level revoke 需 CAS:revoke 时校验 `state_version` 与全部 token 当前状态,partial/failed/remediation 后 **sibling token 原子 revoke**;
- 逐文件 transition 先决条件:仅 `issued → consumed_pending_postcheck → succeeded|failed`;pre-check 原子消费,post-check 终结同一次 consumption(CAS + nonce);
- **group record = versioned immutable object(G4)**:group 状态存 `data/ledger/objects/groups/<group_id>/<version>/<content_digest>.json`;**transition 创建新版本对象,不覆盖既有路径**;当前版本由 committed head 引用的 group pointer 选择;授权状态**只取 committed group state**(绝不从未提交对象推断)。
  ```
  read_committed_group(group_id) → head 指向的 group 对象(version=V, tokens)
  revoke_group(group_id):                            // 并发串行化同 head CAS(§7 锁内)
    acquire_writer_lock; read committed head → group pointer (V)
    verify head.version == expected; write groups/<group_id>/<V+1>/<digest>.json(create-new)
    commit 新 head(group pointer → V+1); release_lock
    sibling revoke 在同一事务对象内原子表达;crash 恢复:未 commit → 旧版本为权威,已 commit → 新版本
  ```
- **secret 单一权威**:secret 正文 `data/secrets/tokens/<token_id>.secret`(DPAPI 密文,服务账户 SID ACL);index `data/secrets/tokens/index.json` **只存 token_id+secret_digest**(可重建,非权威);**授权状态只从 committed group state 读取**——索引损坏重建时扫描 `.secret` 只生成 `{token_id, secret_digest}` 候选,必须经 committed group state 校验 **不复活** consumed/revoked/expired token;
- **Windows 方案(唯一,不并列;R4 修正 G4)**:
  - **三种身份概念严格区分,不得混用**:
    - **服务账户 SID**(ACL 授权主体)= 服务进程上下文内 `whoami /user` 返回的账户 SID(如当前 MCP 服务账户 `S-1-5-21-…`);
    - **per-service SID** = `sc.exe showsid <service_name>`(`S-1-5-80-…`),仅当服务以 `NT SERVICE\<name>` 虚拟账户运行时才有;与账户 SID 是**不同概念**,不能当作同一 SERVICE_SID;`whoami /user` 与 `sc.exe showsid` 返回的身份类型不同,不可互替;
    - **DPAPI CurrentUser 范围** = 与运行服务进程同一账户的当前用户凭据;加密 scope 固定 `CurrentUser`。
  - **唯一模型**:ACL 授权主体 = **服务账户 SID**(`whoami /user`);DPAPI scope = 同一账户 `CurrentUser`;per-service SID 在本期部署(服务以具体账户运行)下**不**作为授权主体;`/upn` 返回 UPN 非 SID,一律不用。
  - **ACL 构造(确定性,R5 修正 H2;在全新临时目录执行,绝不触碰真实 `data\secrets\tokens`)**:
    ```powershell
    $svcSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value   # 服务账户 SID
    $acl = Get-Acl $dir
    $acl.SetAccessRuleProtection($true, $false)          # 1)受保护 DACL,移除继承(确定性)
    foreach ($r in @($acl.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]))) {
      $acl.RemoveAccessRule($r) | Out-Null               # 2)按具体 SID 删除既有显式 ACE(禁止 `icacls /remove:g *`)
    }
    $sidObj = New-Object System.Security.Principal.SecurityIdentifier($svcSid)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sidObj, 'FullControl',
              'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)                            # 3)仅服务账户 SID 一条 Allow FullControl ACE
    Set-Acl -Path $dir -AclObject $acl                   # 4)一次性应用
    # 断言:显式 ACE 恰 1 条,IdentityReference==$svcSid,rights==FullControl
    ```
  - **正反有效访问(唯一协议,无"或")**:`advapi32!AccessCheck` P/Invoke 在本目标机实测对所有令牌类型(进程主/ImpersonateSelf/匿名身份)与 SD 格式(自相对/绝对)均返回 **ERROR_ACCESS_DENIED(1360)**——环境性硬阻断;故按任务书"或等价受支持 API"采用**等价受支持 API = 真实 impersonation token 下的行为有效访问探测**(编译的 `EffProbe` P/Invoke + .NET `System.IO`,拒绝时 `UnauthorizedAccessException`):
    - **正向** = `ImpersonateSelf(SecurityImpersonation)` → 服务账户真实 impersonation token;`ThreadUser()` 断言 SID == 服务账户 SID;枚举目录(ReadData)+ 创建/删除文件(WriteData)均成功 → `true/true`;
    - **反向** = `ImpersonateAnonymousToken` → 真实匿名 impersonation token(S-1-5-7);同一行为探测均 `UnauthorizedAccessException` → `false/false`;
    - **退出码语义**:0=全部通过;1=断言失败(含故意反转模式);2=编译失败;3=探针/令牌无法建立;编译失败、ACL 不精确、正反错误、探针失败均 fail-closed 非 0;
    - **脚本(仓库外,已实测)**:`D:\tmp\harness-v2.5-r5-acl-probe.ps1`,`-Mode CompileOnly|Positive|Negative|DeliberateFail|Check`;
      实测原始退出码:CompileOnly=0、Positive=0(正向 read/write true)、Negative=0(反向 read/write false)、DeliberateFail=1(故意反转预期,探针自身 exit 非 0);ACL 断言 `explicit=1 sid=<服务账户> rights=FullControl`;
    - 不用 `runas /user:standard "<SERVICE_SID>"`(参数/身份错误)。
- **排除与验证命令**:`.gitignore` 追加 `data/secrets/`;备份策略排除 `data/secrets/`;日志禁区(只存 `SecretReference.secret_digest`);
- **迁移 truth table**:

  | 阶段 | 唯一权威 | 失败处理 |
  |---|---|---|
  | 迁移前 | 旧双正文(token_id.json + hash alias) | — |
  | 切换点(原子) | 新 `.secret` + `index.json` + committed group state | 切换失败 → **冻结维护恢复**,不回退双正文 |
  | 迁移后 | committed group state 决定授权;`.secret` 仅密文 | index 损坏 → 重建候选+committed 校验;`.secret` 损坏 → fail-closed |

---

## 9. 迁移唯一裁决与 flow

- **M1 并入 M2~M4 原子包**(判定见 V2.5-R1:类型改动触碰运行时消费方,无独立上线路径);
- 顺序:M1 并入 → M2 离线 replay+规则审计+差异批准 → M3~M4 原子切换 → M5 验证;
- **flow 精确路径**:
  - `data/flows/harness_authorization_flow.yaml`(新增,锁定 `purpose: authorization`);
  - `data/flows/harness_closure_flow.yaml`(新增,锁定 `purpose: closure`);
  - `src/FlowConfigLoader.ts` 按 flow_id 绑定 purpose;ingress 方法固定;purpose 不可由调用方参数覆盖;
  - 现有 `data/flows/self_guard_flow.yaml`、`data/flows/wenstaros_core_repair_flow.yaml` **不充当** purpose 配置;
- **回退**:只回退代码/路由;已提交 ledger 用 schema-compatible reader/forward recovery,不倒写历史。

---

## 10. 测试追踪矩阵(自包含)

> 每项含唯一实现文件、唯一测试文件、稳定断言、完整命令;类型+运行时双测试拆为独立 R-ID(总数 60)。测试层列:`runtime`=vitest,`type`=TypeScript 负例 wrapper。

> **`scripts/run-tsc-fixture.cjs` 契约(G5;类型负例统一入口,当前 Harness 仓库中不存在,为实施期新建文件)**:
> - 内部固定调用:`npx --yes --package typescript@7.0.2 tsc --strict --noEmit --skipLibCheck --moduleResolution bundler --module ESNext <file>`;
> - 参数:`<file> <expected_exit> <expected_diag_count> <expected_diag_code>…`;
> - 断言:tsc 实际退出码 == `expected_exit`;诊断数量 == `expected_diag_count`;诊断 code 集合 == 给出的 `expected_diag_code` 列表(逐条比对,多/缺/错均失败);
> - wrapper 自身退出语义:全部断言通过 → exit `0` 并输出 `PASS`;任一不符 → exit `1` 并输出 `FAIL <期望> vs <实际>`;tsc 调用失败/未安装 → exit `2`(与断言失败区分);
> - DRAFT 验证期在 `D:\tmp` 复刻同一契约(不写入 Harness 仓库);实施期落于 `scripts/run-tsc-fixture.cjs`。

### A. v2.2 原 29 项

| R-ID | 语义 | 实现文件 | 测试文件 | 稳定断言 | 测试层 | 命令 |
|---|---|---|---|---|---|
| R-001 | V1→V2 转换成功 | `mcp/server.ts` | `src/__tests__/ingress/upgrade.test.ts` | `expect(out.schema_version).toBe(2)` | `runtime` | `npx vitest run src/__tests__/ingress/upgrade.test.ts` |
| R-002 | V1 无法无歧义转换 | `mcp/server.ts` | `src/__tests__/ingress/upgrade.test.ts` | `expect(verdict).toBe('EVIDENCE_SCHEMA_UPGRADE_REQUIRED')` | `runtime` | `npx vitest run src/__tests__/ingress/upgrade.test.ts` |
| R-003 | bugfix+common 并存 | `src/DelegateReviewer.ts` | `src/__tests__/classification/kind-vs-scope.test.ts` | `expect(violations).not.toContain('CLASSIFY_REQUIRED')` | `runtime` | `npx vitest run src/__tests__/classification/kind-vs-scope.test.ts` |
| R-004 | 依赖图与批准清单不一致 | `src/security/dependency-scanner.ts` | `src/__tests__/dependency/compare.test.ts` | `expect(v).toBe('EVIDENCE_SCHEMA_UPGRADE_REQUIRED')` | `runtime` | `npx vitest run src/__tests__/dependency/compare.test.ts` |
| R-005 | actual 超授权 | `src/FlowEngine.ts` | `src/__tests__/scope/actual-subset.test.ts` | `expect(r).toBe('rejected')` | `runtime` | `npx vitest run src/__tests__/scope/actual-subset.test.ts` |
| R-006 | required planned 缺失 | `src/FlowEngine.ts` | `src/__tests__/scope/required-missing.test.ts` | `expect(obligation.status).toBe('breached')` | `runtime` | `npx vitest run src/__tests__/scope/required-missing.test.ts` |
| R-007 | optional planned 收缩 | `src/FlowEngine.ts` | `src/__tests__/scope/amendment.test.ts` | `expect(amendment.status).toBe('approved')` | `runtime` | `npx vitest run src/__tests__/scope/amendment.test.ts` |
| R-008 | affected 含未修改上下游 | `src/DelegateReviewer.ts` | `src/__tests__/scope/affected-not-diff.test.ts` | `expect(violations).toHaveLength(0)` | `runtime` | `npx vitest run src/__tests__/scope/affected-not-diff.test.ts` |
| R-009 | ModuleRef 多角色 | `src/types.ts` | `src/__tests__/scope/module-ref-roles.test.ts` | `expect(roles).toContain('modified')` | `runtime` | `npx vitest run src/__tests__/scope/module-ref-roles.test.ts` |
| R-010 | 原 A3e V1 输入 | `mcp/server.ts` | `src/__tests__/ingress/a3e-v1.test.ts` | `expect(v).toBe('EVIDENCE_SCHEMA_UPGRADE_REQUIRED')` | `runtime` | `npx vitest run src/__tests__/ingress/a3e-v1.test.ts` |
| R-011 | 语义等价 canonical V2 | `src/FlowEngine.ts` | `src/__tests__/e2e/authorization.test.ts` | `expect(term.outcome).toBe('authorization_complete')` | `runtime` | `npx vitest run src/__tests__/e2e/authorization.test.ts` |
| R-012 | FG11 适用性 | `src/DelegateReviewer.ts` | `src/__tests__/classification/fg11-applicability.test.ts` | `expect(keys).not.toContain('RISK_FG11_FINAL_CHECK')` | `runtime` | `npx vitest run src/__tests__/classification/fg11-applicability.test.ts` |
| R-013 | tsc closure 通过 | `src/StageRunner.ts` | `src/__tests__/closure/tsc-pass.test.ts` | `expect(violations).not.toContain('STATIC_QUALITY_GATE')` | `runtime` | `npx vitest run src/__tests__/closure/tsc-pass.test.ts` |
| R-014 | 拼接不同快照 | `src/FlowEngine.ts` | `src/__tests__/closure/snapshot-mismatch.test.ts` | `expect(r).toBe('SNAPSHOT_MISMATCH')` | `runtime` | `npx vitest run src/__tests__/closure/snapshot-mismatch.test.ts` |
| R-015 | freshness 动态计算 | `src/FlowEngine.ts` | `src/__tests__/closure/freshness.test.ts` | `expect(r).toBe('VERIFICATION_STALE')` | `runtime` | `npx vitest run src/__tests__/closure/freshness.test.ts` |
| R-016 | MCP 伪造 fact | `mcp/server.ts` | `src/__tests__/ingress/fact-forge.test.ts` | `expect(v).toBe('rejected')` | `runtime` | `npx vitest run src/__tests__/ingress/fact-forge.test.ts` |
| R-017 | obligation 兑现 | `src/FlowEngine.ts` | `src/__tests__/closure/obligation-fulfilled.test.ts` | `expect(res).toMatchObject({status:'fulfilled'})` | `runtime` | `npx vitest run src/__tests__/closure/obligation-fulfilled.test.ts` |
| R-018 | obligation 未兑现 | `src/FlowEngine.ts` | `src/__tests__/closure/obligation-breached.test.ts` | `expect(res.violation_code).toBe('V_DOC_SYNC_MISSING')` | `runtime` | `npx vitest run src/__tests__/closure/obligation-breached.test.ts` |
| R-019 | 提案非法组合 | `src/types.ts` | `src/__tests__/types/negatives/optimization-illegal.ts` | `tsc 编译失败` | `type` | `node scripts/run-tsc-fixture.cjs src/__tests__/types/negatives/optimization-illegal.ts 1 1 TS2353` |
| R-020 | closure 终态 | `src/security/flow-terminal-policy.ts` | `src/__tests__/e2e/closure.test.ts` | `expect(term.outcome).toBe('closure_complete'); expect(term.token_issued).toBe(false)` | `runtime` | `npx vitest run src/__tests__/e2e/closure.test.ts` |
| R-021 | authorization 终态 | `src/security/flow-terminal-policy.ts` | `src/__tests__/e2e/authorization.test.ts` | `expect(term.token_issued).toBe(true)` | `runtime` | `npx vitest run src/__tests__/e2e/authorization.test.ts` |
| R-022 | 每文件 token 部分失败 | `src/security/token-store.ts` | `src/__tests__/token/partial-fail.test.ts` | `expect(failed.status).toBe('failed')` | `runtime` | `npx vitest run src/__tests__/token/partial-fail.test.ts` |
| R-023 | 纯验证重试 | `src/FlowEngine.ts` | `src/__tests__/closure/verify-retry.test.ts` | `expect(needNewAuth).toBe(false)` | `runtime` | `npx vitest run src/__tests__/closure/verify-retry.test.ts` |
| R-024 | remediation 再写码 | `src/security/token-store.ts` | `src/__tests__/token/remediation-reauth.test.ts` | `expect(needNewAuth).toBe(true)` | `runtime` | `npx vitest run src/__tests__/token/remediation-reauth.test.ts` |
| R-025 | closure 超时已落地 | `src/FlowEngine.ts` | `src/__tests__/closure/overdue-recovery.test.ts` | `expect(state).toBe('closure_overdue')` | `runtime` | `npx vitest run src/__tests__/closure/overdue-recovery.test.ts` |
| R-026 | manifest 归档失败 | `src/AuditLogger.ts` | `src/__tests__/ledger/manifest-commit-fail.test.ts` | `expect(terminal).toBeNull()` | `runtime` | `npx vitest run src/__tests__/ledger/manifest-commit-fail.test.ts` |
| R-027 | authorization 重放 | `src/FlowEngine.ts` | `src/__tests__/ledger/idempotency.test.ts` | `expect(r).toBe('rejected')` | `runtime` | `npx vitest run src/__tests__/ledger/idempotency.test.ts` |
| R-028 | 并发 closure | `src/FlowEngine.ts` | `src/__tests__/ledger/concurrent-closure.test.ts` | `expect(r).toBe('locked')` | `runtime` | `npx vitest run src/__tests__/ledger/concurrent-closure.test.ts` |
| R-029 | 回归 A3e(两 run) | `src/security/flow-terminal-policy.ts` | `src/__tests__/e2e/regression-a3e.test.ts` | `expect(runA.token_issued).toBe(true); expect(runB.token_issued).toBe(false)` | `runtime` | `npx vitest run src/__tests__/e2e/regression-a3e.test.ts` |

### B. v2.3 任务书原 28 项(1~28 原序)

| R-ID | 原序 | 语义 | 实现文件 | 测试文件 | 稳定断言 | 测试层 | 命令 |
|---|---|---|---|---|---|---|
| R-030 | 1 | V1 confirmation 不转 true/token | `mcp/server.ts` | `src/__tests__/ingress/v1-no-failopen.test.ts` | `expect(token_issued).toBe(false)` | `runtime` | `npx vitest run src/__tests__/ingress/v1-no-failopen.test.ts` |
| R-031 | 2a | 外部伪造 system fields(类型层) | `src/types.ts` | `src/__tests__/types/negatives/system-field-forge.ts` | `tsc 编译失败` | `type` | `node scripts/run-tsc-fixture.cjs src/__tests__/types/negatives/system-field-forge.ts 1 1 TS2353` |
| R-058 | 2b | 外部伪造 system fields(运行时) | `mcp/server.ts` | `src/__tests__/ingress/system-field-forge.test.ts` | `expect(v).toBe('rejected')` | `runtime` | `npx vitest run src/__tests__/ingress/system-field-forge.test.ts` |
| R-032 | 3 | approval ref/scope/plan 不匹配 | `mcp/server.ts` | `src/__tests__/ingress/approval-mismatch.test.ts` | `expect(v.kind).toBe('rejected')` | `runtime` | `npx vitest run src/__tests__/ingress/approval-mismatch.test.ts` |
| R-033 | 4 | Windows FileId 全 alias | `src/security/fileid-canonicalizer.ts` | `src/__tests__/fileid/canonicalize.test.ts` | `expect(f.canonical).toBe('src/a.ts')` | `runtime` | `npx vitest run src/__tests__/fileid/canonicalize.test.ts` |
| R-034 | 5a | succeeded 缺 digest(类型层) | `src/types.ts` | `src/__tests__/types/negatives/token-succeeded-missing-digest.ts` | `tsc 编译失败` | `type` | `node scripts/run-tsc-fixture.cjs src/__tests__/types/negatives/token-succeeded-missing-digest.ts 1 1 TS2741` |
| R-059 | 5b | succeeded 缺 digest(运行时) | `src/security/token-store.ts` | `src/__tests__/token/succeeded-digest.test.ts` | `expect(r).toBe('rejected')` | `runtime` | `npx vitest run src/__tests__/token/succeeded-digest.test.ts` |
| R-035 | 6 | token group 部分签发全不可用 | `src/security/token-store.ts` | `src/__tests__/token/group-atomic-issue.test.ts` | `expect(group).toBeNull()` | `runtime` | `npx vitest run src/__tests__/token/group-atomic-issue.test.ts` |
| R-036 | 7 | pre-check crash/post-check 缺 recovery | `.claude/harness-post-check.cjs` | `src/__tests__/token/postcheck-recovery.test.ts` | `expect(r).toBe('recovery_required')` | `runtime` | `npx vitest run src/__tests__/token/postcheck-recovery.test.ts` |
| R-037 | 8 | 多文件部分写后 sibling revoke/重授权 | `src/security/token-store.ts` | `src/__tests__/token/sibling-revoke-reauth.test.ts` | `expect(siblings.every(s=>s.state==='revoked')).toBe(true)` | `runtime` | `npx vitest run src/__tests__/token/sibling-revoke-reauth.test.ts` |
| R-038 | 9 | rollback 无 recovery authorization | `src/security/token-store.ts` | `src/__tests__/token/rollback-recovery-token.test.ts` | `expect(r).toBe('rejected')` | `runtime` | `npx vitest run src/__tests__/token/rollback-recovery-token.test.ts` |
| R-039 | 10 | 双进程 CAS/fencing + 旧 attempt | `src/FlowEngine.ts` | `src/__tests__/ledger/two-process-cas.test.ts` | `expect(r).toBe('CAS_CONFLICT')` | `runtime` | `npx vitest run src/__tests__/ledger/two-process-cas.test.ts` |
| R-040 | 11 | ledger replace/截断/损坏/stale lock | `src/AuditLogger.ts` | `src/__tests__/ledger/wal-corruption.test.ts` | `expect(r).toBe('STALE_LOCK_REQUIRES_MAINTENANCE')` | `runtime` | `npx vitest run src/__tests__/ledger/wal-corruption.test.ts` |
| R-041 | 12 | authorization/token/closure 三时间边界 | `src/FlowEngine.ts` | `src/__tests__/ledger/three-expiry.test.ts` | `expect(expiredEach).toEqual([false,true,true])` | `runtime` | `npx vitest run src/__tests__/ledger/three-expiry.test.ts` |
| R-042 | 13 | manifest payload digest 篡改 | `src/AuditLogger.ts` | `src/__tests__/manifest/payload-tamper.test.ts` | `expect(ok).toBe(false)` | `runtime` | `npx vitest run src/__tests__/manifest/payload-tamper.test.ts` |
| R-043 | 14 | untracked/binary/rename/delete/mode | `src/security/dependency-scanner.ts` | `src/__tests__/snapshot/state-coverage.test.ts` | `expect(states).toEqual(expect.arrayContaining(['tracked','untracked','deleted']))` | `runtime` | `npx vitest run src/__tests__/snapshot/state-coverage.test.ts` |
| R-044 | 15 | authorization/closure fact 隔离 | `src/types.ts` | `src/__tests__/types/negatives/auth-fact-no-diff.ts` | `tsc 编译通过(auth fact 无 closure diff)` | `type` | `node scripts/run-tsc-fixture.cjs src/__tests__/types/negatives/auth-fact-no-diff.ts 0 0` |
| R-045 | 16a | fulfilled 缺 fact ref(类型层) | `src/types.ts` | `src/__tests__/types/negatives/obligation-fact-ref.ts` | `tsc 编译失败` | `type` | `node scripts/run-tsc-fixture.cjs src/__tests__/types/negatives/obligation-fact-ref.ts 1 1 TS2741` |
| R-060 | 16b | fulfilled 缺 fact ref(运行时) | `src/FlowEngine.ts` | `src/__tests__/closure/obligation-fact-ref.test.ts` | `expect(r).toBe('rejected')` | `runtime` | `npx vitest run src/__tests__/closure/obligation-fact-ref.test.ts` |
| R-046 | 17 | authorization store failure 唯一 abort/零 token/零 complete | `src/AuditLogger.ts` | `src/__tests__/terminal/auth-store-failure.test.ts` | `expect(term.outcome).toBe('abort'); expect(term.token_issued).toBe(false)` | `runtime` | `npx vitest run src/__tests__/terminal/auth-store-failure.test.ts` |
| R-047 | 18 | manifest store failure 唯一 failure/零 complete/零 token | `src/AuditLogger.ts` | `src/__tests__/terminal/manifest-store-failure.test.ts` | `expect(term).toBeNull(); expect(token_issued).toBe(false)` | `runtime` | `npx vitest run src/__tests__/terminal/manifest-store-failure.test.ts` |
| R-048 | 19 | retry 前 snapshot 漂移 | `src/FlowEngine.ts` | `src/__tests__/closure/retry-snapshot-drift.test.ts` | `expect(r).toBe('SNAPSHOT_DRIFT')` | `runtime` | `npx vitest run src/__tests__/closure/retry-snapshot-drift.test.ts` |
| R-049 | 20 | 两 run 唯一终态且 consumer 一致 | `src/security/flow-terminal-policy.ts` | `src/__tests__/terminal/terminal-uniqueness.test.ts` | `expect(terminals).toHaveLength(1)` | `runtime` | `npx vitest run src/__tests__/terminal/terminal-uniqueness.test.ts` |
| R-050 | 21 | dirty 与 delta 分离、冻结 hunk 覆盖拒绝 | `src/security/dependency-scanner.ts` | `src/__tests__/snapshot/dirty-freeze.test.ts` | `expect(r).toBe('V_DIRTY_OVERLAP')` | `runtime` | `npx vitest run src/__tests__/snapshot/dirty-freeze.test.ts` |
| R-051 | 22 | token 双正文迁移后单一权威、索引损坏不复活 | `src/security/token-store.ts` | `src/__tests__/token/migration-single-authority.test.ts` | `expect(index.onlyIds).toBe(true)` | `runtime` | `npx vitest run src/__tests__/token/migration-single-authority.test.ts` |
| R-052 | 23 | 两 authorization 文件集冲突 + 重启 fencing | `src/security/token-store.ts` | `src/__tests__/token/file-set-conflict.test.ts` | `expect(r).toBe('FILE_LOCKED'); expect(fence).toBe(true)` | `runtime` | `npx vitest run src/__tests__/token/file-set-conflict.test.ts` |
| R-053 | 24 | attempt A fact 不混入 B | `src/types.ts` | `src/__tests__/closure/attempt-mix.test.ts` | `expect(r).toBe('ATTEMPT_MISMATCH')` | `runtime` | `npx vitest run src/__tests__/closure/attempt-mix.test.ts` |
| R-054 | 25 | prepared crash + commit 后 audit 前 crash | `src/AuditLogger.ts` | `src/__tests__/ledger/prepared-and-commit-audit-crash.test.ts` | `expect(recover()).toBe('deterministic')` | `runtime` | `npx vitest run src/__tests__/ledger/prepared-and-commit-audit-crash.test.ts` |
| R-055 | 26 | 全 purpose/abort 的 TerminalRecord + token spy | `src/security/flow-terminal-policy.ts` | `src/__tests__/terminal/token-spy.test.ts` | `expect(spyOnly).toEqual(['authorization_complete'])` | `runtime` | `npx vitest run src/__tests__/terminal/token-spy.test.ts` |
| R-056 | 27 | S5/S6 不同真实 handler spy | `src/StageRunner.ts` | `src/__tests__/stagerunner/handler-registry.test.ts` | `expect(types).toEqual(['tsc_result','test_result'])` | `runtime` | `npx vitest run src/__tests__/stagerunner/handler-registry.test.ts` |
| R-057 | 28 | replay 缺 repository snapshot fail-closed | `src/FlowEngine.ts` | `src/__tests__/replay/missing-snapshot.test.ts` | `expect(r).toBe('rejected')` | `runtime` | `npx vitest run src/__tests__/replay/missing-snapshot.test.ts` |

> 合计 60 个 requirement ID(R-001~R-060):原 29 + 原 28 + 3 个拆分项(2a/2b、5a/5b、16a/16b)。每项自包含,无"同上/全链路/e2e/运行时/types 负例/目录/wildcard"占位。

---

## 11. 实时逐文件 Ownership(25 条;快照协议 + 自引用排除)

**实时 `git status --short` 25 条 = 17 staged + 1 unstaged + 7 untracked**。owner:H1=H1 验收包、H1R=H1 修复包、V2=V2 设计、PF=推进者只读。

> **快照生成协议(R5/H3 钉死,逐字节可复现)**:
> - git 固定参数:`git --no-pager -c core.pager=cat -c color.ui=never -c diff.external= -c core.quotepath=false diff --no-ext-diff --no-textconv --no-color -U0 -- <path>`(关闭 pager/color/external diff/textconv);
> - staged 现有 hunk = **HEAD→index**(`--cached`);unstaged = **index→worktree**(无 `--cached`);
> - 文件级 digest = SHA-256(**native git stdout 原始 bytes**,经 `cmd.exe` 重定向落盘后直接哈希,不经 PowerShell string/`Out-String`/编码转换/隐式换行);hunk 数 = 以 `@@` 开头的行数;
> - **结构性自引用排除**:DRAFT 自身 SHA-256 **不回写本表**。ownership 快照由**外部 verifier 在 DRAFT 冻结后**生成,快照自身 SHA-256 记录于独立验收报告,不在 DRAFT 内;下表 DRAFT 行 SHA 以"冻结后外部记录"标注。
> - **verifier(仓库外,不改变 Harness dirty,脚本自身 SHA 稳定)**:`D:\tmp\harness-v2.5-r5-ownership-verifier.ps1`(SHA-256 `9f7f4dc08cac106920e336ea3820a4e830d12d9777ccadf1648d080cd9d05a5f`);**snapshot**:`D:\tmp\harness-v2.5-r5-ownership-snapshot.json`(DRAFT 冻结后生成;快照自身 SHA-256 记录于独立验收报告,不回写 DRAFT——快照 SHA 依赖 DRAFT 内容,写回即循环)。
> - 除 DRAFT 自身行外,下列 SHA/hunk/digest 值截至 2026-08-30 R5 写前基线(钉死 `-U0` 协议),均为仓库稳定事实(不受本轮 DRAFT 编辑影响);`src/types.ts`=`2b1c59e8…`、`.gitignore`=`3abd701f…` 已与 R5 任务书独立重算一致。

### 11.1 全部 dirty 逐项(完整 worktree SHA-256 / index-content SHA-256 / Git object ID / 现有 hunk digest)

| XY | 精确路径 | worktree SHA-256(64) | index-content SHA-256(64) | Git object ID | 现有 hunk(文件级 digest=完整 diff 的 SHA-256;N hunks) | owner |
|---|---|---|---|---|---|---|
| M  | .claude/harness-integrity-manifest.json | 33c3af09e44b8e164fca8d9bbe8b8390d7903cc4754b55f0403581fa6147660f | 33c3af09e44b8e164fca8d9bbe8b8390d7903cc4754b55f0403581fa6147660f | c573963026982a08a59c7129b66a7876cfa957db | HEAD→index;3 hunks;digest=7689226ebabf9867b35fce477b685802ff1b40427ba858df684b8a4df68c8663 | H1 |
| M  | .claude/harness-pre-check.cjs | aa0a810f2c93258f4628f1aef8e1f9f5c9916337eb39013804881299293d406e | 5c149864670c30f26aba9a8740e543842bfc40137ccfc1f86da3259b130531a3 | 5ce2c75dff0ab1a357a9a31bfeddd4cf83d9c635 | HEAD→index;23 hunks;digest=9c34d28eeae734179260d5b6821e0853e97fcb201b4de9cbffd5fc4657cccb28 | H1 |
| M  | .gitignore | d701e727ea9993999df57e57724763015e07c6bb483c55701f010a0fbb895e88 | d701e727ea9993999df57e57724763015e07c6bb483c55701f010a0fbb895e88 | aa137d87b7c93c2efbac6a3ce85892fb997a2e48 | HEAD→index;1 hunk;digest=3abd701ff230d125157bdea42ee54c1fc621cd3e008cde78474b673d0de8ad69 | H1 |
| M  | data/flows/wenstaros_core_repair_flow.yaml | e7427482f9e123706f4eb0499910a12fdd60d950f6cb2de51ba9398d131a9439 | e7427482f9e123706f4eb0499910a12fdd60d950f6cb2de51ba9398d131a9439 | c5853d987a285ccdf442b9997e6a12dd2f06ab2f | HEAD→index;1 hunk;digest=97dee31aa483323af09eee18c98ee45be0683521ed477ea5530a3d38ea9f0f91 | H1 |
| M  | data/s4-pure-mapping-exempt.json | aecb37ef0683632186bbd24b2044bfd1f1e395a4d17deba23c9ae80942efa77e | aecb37ef0683632186bbd24b2044bfd1f1e395a4d17deba23c9ae80942efa77e | 34bd1b8585a175e5f1449279709e953ab09559e7 | HEAD→index;2 hunks;digest=d4b609b66e97bee2f51d835d2c96ccc2da88e25a860d0b454143181987cc21ef | H1 |
| M  | mcp/server.ts | 9578f65bd8b53756a40690c411c607ba90da2564f39a9f9fb441c3e069b0b298 | 9578f65bd8b53756a40690c411c607ba90da2564f39a9f9fb441c3e069b0b298 | 88cee93c0b26a85b99c21177a7a6b80b05e3950b | HEAD→index;12 hunks;digest=61eec9c3fafd2ce206ab48cd4af816253637447107a0f46a7e23c949576e1b90 | H1 |
| M  | scripts/bash-write-guard.cjs | 5a7a2562e50a4b9f44ff199af48326d05c627cce46af351060f7f3b9071d3850 | 5a7a2562e50a4b9f44ff199af48326d05c627cce46af351060f7f3b9071d3850 | 8f5f81110bb84ed5b019da4b4c048e2c61938ad2 | HEAD→index;6 hunks;digest=e5f38ff3e7d6c87489057494b8ce817259ef1bff6a443ff4c2b86c7ef22cd387 | H1 |
| M  | scripts/review-runner.cjs | 85ed7e43247cfef0c06e0817ef6109a2422aeaf8ab3c7f5d08d23c663ca04af8 | 85ed7e43247cfef0c06e0817ef6109a2422aeaf8ab3c7f5d08d23c663ca04af8 | f05f5f0d6d190117a29cda0233d58dde1956fd1e | HEAD→index;5 hunks;digest=6d5a1b5b52c8a5b03cd9b33622cbb2d96ad5c54cd655c7fdde94a95ba252f02f | H1 |
| M  | src/ConvergenceGate.ts | 7fd4f229fbee08aa9aa0d91a2f654fd09f1fdf47b76163b5bf31037484123ee5 | 7fd4f229fbee08aa9aa0d91a2f654fd09f1fdf47b76163b5bf31037484123ee5 | 2fb024a92a00fb5807048ed07435d78af6e49ec7 | HEAD→index;12 hunks;digest=2f159cf532aab2d8516d15480c0a609e49f4aa7e7838b946920b7419e66bdeec | H1 |
| M  | src/DelegateReviewer.ts | e949cb51d2f4683b0d5849532f707db4fe5d140583f0bdd41970c9107bd6a7ac | 7bd56e4379d025504fac2cf58f67013af7486d3505e4410821bdc1423de7ccf0 | 733650bd47b3b1fadfe97ac5baffd172a3bfa1c8 | HEAD→index;119 hunks;digest=e4af2956836c4108cc03950deb6ac768b5b013a58548729a415148e24b8dad8d | H1 |
|  M | src/DualChannelSignal.ts | 409b5851ca150858f86fdfe7c5357ae4c3e31be1759ee7beface2b29677ea558 | 5708bcff65abc5a4464a5f40fab755d2f201563b52ad1b6307bdb14b36863dfc | 692e3e3f783ce78af66c1081c9c262c2939bd504 | index→worktree;3 hunks;digest=fcb2dfc8005d22f17370378a689444386f8ae3e3063c107ede2eefffe7152040 | H1R |
| M  | src/FlowEngine.ts | 94b212dbf8b27d2fa5c956db39e3f1072126b7bad18ebe5611a94b51cd5fa82e | 94b212dbf8b27d2fa5c956db39e3f1072126b7bad18ebe5611a94b51cd5fa82e | 952b08e2b750f173f837e20f2bdeb3d141a7dced | HEAD→index;25 hunks;digest=e554dccedda315c017ee4e7c9ed515541e681d7d36abe9f3149973ad50e1ab3c | H1 |
| A  | src/__tests__/ConvergenceGate.test.ts | 48807c5ca39458399455a8ae7817b80069f4c29727bcd98c21555bc05e8073bf | 48807c5ca39458399455a8ae7817b80069f4c29727bcd98c21555bc05e8073bf | 9333ab1316e6550fd5db529f42a6d848453bf79a | HEAD→index;1 hunk;digest=a857634452126fcb85189114b453c236550a56a6f617f8855335f84ec0c0fbf0 | H1 |
| M  | src/__tests__/DelegateReviewer.test.ts | 3d7939821d5b240f17ca40ebc7ed4f5b337b66655558381a52ff061775b7454b | 3d7939821d5b240f17ca40ebc7ed4f5b337b66655558381a52ff061775b7454b | 134b329fad9d452e6472ffd05db33fa72f93764c | HEAD→index;32 hunks;digest=06e93907a9c3cdbe5c6fc51840895afdb7cd06b13b2b34301768c64bfcb4030a | H1 |
| M  | src/__tests__/FlowEngine.test.ts | 60fe405a6425c59c5e6a8ca5d3529813eda52cf9a6205b1aa2edbb640ca2dfe6 | 60fe405a6425c59c5e6a8ca5d3529813eda52cf9a6205b1aa2edbb640ca2dfe6 | 3d363b3adc763496992a07041028d9976e66e050 | HEAD→index;6 hunks;digest=3e6a2601cf0083f90b81ca958c44f8b884f81a8e6029e00a4849216b80ad56be | H1 |
| A  | src/security/flow-terminal-policy.ts | 026222875c34213a3be4d6da8e3f00e08500894ab840500a7665e3c7da822a14 | 026222875c34213a3be4d6da8e3f00e08500894ab840500a7665e3c7da822a14 | deedc03080553c7384b47b33cc906471d8a77d65 | HEAD→index;1 hunk;digest=f98c625649d7012be277c0ab40e09970c882f1c58c377b93f758ebfd10bd7cba | H1 |
| M  | src/types.ts | ae566206b9f0a5b24b2da6db36adfaa7c6bd63e7d8fa5f5537d0b8b1d588e44b | ae566206b9f0a5b24b2da6db36adfaa7c6bd63e7d8fa5f5537d0b8b1d588e44b | 00c3b67fcca7b3fb7a83c37d1b2ad54fe52e9916 | HEAD→index;7 hunks;digest=2b1c59e8e2b1962cca3b783a83925b64a01bb37c2b12c9d541dfd76a99f7ab30 | H1 |
| A  | tests/security/flow-terminal-policy.test.ts | 132fe7cbcdb11f6865abf723ebe330627e0229004e2bb6163d8681846394e3cd | 132fe7cbcdb11f6865abf723ebe330627e0229004e2bb6163d8681846394e3cd | 45145ddfcb98d4c5393118d06a8b7fe2b181e78c | HEAD→index;1 hunk;digest=cac1e5030165c9828506ac80424e27aca92676d40728a503a2a6c25d22a9dcfe | H1 |
| ?? | docs/harness-typed-evidence-and-two-phase-governance-design-v2-draft.md | 冻结后由外部 verifier 记录(自引用排除;R5 写前实测为 71b38b7e…ab403) | 不存在 | — | - | V2 |
| ?? | docs/harness-typed-evidence-v2.3-independent-review-v2.4-mandatory-corrections-2026-08-29.md | 2c732f9f97328ac209be73aa10f62ea88cfaa3670760de053075b5e6ee112250 | 不存在 | — | - | PF(只读) |
| ?? | docs/harness-typed-evidence-v2.4-review-v2.5-mechanical-closure-corrections-2026-08-29.md | c25ff04058f706a2f7a98e14b37f5c306d0f3c12e16962a4fe18a4008c4d5790 | 不存在 | — | - | PF(只读) |
| ?? | docs/harness-v2.5-concurrent-candidate-independent-review-and-mechanical-rework-2026-08-30.md | 3d7172920be81198ee0df19c3b12d17c15723f0d8c30d6daf27a4fdeeef517b2 | 不存在 | — | - | PF(只读) |
| ?? | docs/harness-v2.5-r1-independent-review-v2.5-r2-mechanical-corrections-2026-08-30.md | 7521abc49c1d30bf7ef2f858e535519b1c4eb7a6feda99a4c6b65e8cd9c51809 | 不存在 | — | - | PF(只读) |
| ?? | docs/harness-v2.5-r2-independent-review-v2.5-r3-mechanical-corrections-2026-08-30.md | fcca90f380da19e98ae974a3b92b8ef04a5a8f57dbc45ce08c83f836556aeb5d | 不存在 | — | - | PF(只读) |
| ?? | src/__tests__/DualChannelSignal.test.ts | d32d63d075a8e554efecd23232c400355bb0435e068914d8f64d21909d1a5530 | 不存在 | — | - | H1R |

### 11.2 拟改重叠目标(真实现有 hunk;拟改未冻结→BLOCKED_NO_OWNERSHIP)

> **裁决规则(R4)**:拟改 hunk 必须给精确区间/digest,否则明确返回 **`BLOCKED_NO_OWNERSHIP`**(无所有权→实施边界复核前不得写入)。本轮 H2 拟改 diff 尚未冻结,无法给出精确拟改区间/digest,故下列 8 项**一律 `BLOCKED_NO_OWNERSHIP`**;现有 hunk 均为真实 `git diff -U0` 计算(new 文件行号,半开区间)。

| 路径 | owner | 现有 hunk(HEAD→index;new 行区间,文件级 digest 前 16 位) | 拟改 hunk 裁决 |
|---|---|---|---|
| src/types.ts | H1 | 7 hunks:[81,92)、[120,121)、[124,126)、[150,188)、[339,348)、[362,364)、[378,382);digest 6187b385… | `BLOCKED_NO_OWNERSHIP`(拟改未冻结) |
| src/DelegateReviewer.ts | H1 | 119 hunks,span new[15,835);digest 3693d059…(逐 hunk 见外部快照) | `BLOCKED_NO_OWNERSHIP`(拟改未冻结) |
| src/FlowEngine.ts | H1 | 25 hunks,span new[29,672);digest 8447dd7a… | `BLOCKED_NO_OWNERSHIP`(拟改未冻结) |
| mcp/server.ts | H1 | 12 hunks,span new[68,556);digest 91bd5f06… | `BLOCKED_NO_OWNERSHIP`(拟改未冻结) |
| src/DualChannelSignal.ts | H1R | index→worktree 3 hunks:[14,15)、[98,101)、[104,121);digest 85709411… | `BLOCKED_NO_OWNERSHIP`(拟改未冻结) |
| src/ConvergenceGate.ts | H1 | 12 hunks,span new[27,431);digest 37d023fe… | `BLOCKED_NO_OWNERSHIP`(拟改未冻结) |
| .claude/harness-pre-check.cjs | H1 | 23 hunks,span new[131,583);digest 78ae53b6… | `BLOCKED_NO_OWNERSHIP`(拟改未冻结) |
| src/__tests__/DualChannelSignal.test.ts | H1R | untracked 新增文件(无 HEAD→index 基线;全文件新) | `BLOCKED_NO_OWNERSHIP`(拟改未冻结) |

> 实施边界复核通过、H2 拟改 diff 冻结后,须为每个拟改目标补精确拟改区间 + digest 并经 §6 overlap 判定与上表现有 hunk **不重叠**方解除阻断。

### 11.3 分表:实现源文件 vs 动态 runtime object 模板

**实现源文件(必改,精确文件,无目录/wildcard)**:`src/types.ts`、`src/DelegateReviewer.ts`、`src/DualChannelSignal.ts`、`src/ConvergenceGate.ts`、`src/ComplianceScorer.ts`、`mcp/server.ts`、`src/FlowEngine.ts`、`src/StageRunner.ts`、`src/AuditLogger.ts`、`src/FlowConfigLoader.ts`、`src/security/token-store.ts`、`src/security/flow-terminal-policy.ts`、`src/security/dependency-scanner.ts`(新)、`src/security/fileid-canonicalizer.ts`(新)、`.claude/harness-pre-check.cjs`、`.claude/harness-post-check.cjs`、`data/flows/harness_authorization_flow.yaml`(新)、`data/flows/harness_closure_flow.yaml`(新)、`.claude/mcp.json`、`scripts/run-tsc-fixture.cjs`(新)。

**新增测试文件(60 个 R-ID 的唯一测试路径,§10 逐行已列,全部精确文件,不用目录/wildcard)**:`src/__tests__/ingress/upgrade.test.ts`、`src/__tests__/classification/kind-vs-scope.test.ts`、`src/__tests__/dependency/compare.test.ts`、`src/__tests__/scope/actual-subset.test.ts`、`src/__tests__/scope/required-missing.test.ts`、`src/__tests__/scope/amendment.test.ts`、`src/__tests__/scope/affected-not-diff.test.ts`、`src/__tests__/scope/module-ref-roles.test.ts`、`src/__tests__/ingress/a3e-v1.test.ts`、`src/__tests__/e2e/authorization.test.ts`、`src/__tests__/classification/fg11-applicability.test.ts`、`src/__tests__/closure/tsc-pass.test.ts`、`src/__tests__/closure/snapshot-mismatch.test.ts`、`src/__tests__/closure/freshness.test.ts`、`src/__tests__/ingress/fact-forge.test.ts`、`src/__tests__/closure/obligation-fulfilled.test.ts`、`src/__tests__/closure/obligation-breached.test.ts`、`src/__tests__/types/negatives/optimization-illegal.ts`、`src/__tests__/e2e/closure.test.ts`、`src/__tests__/token/partial-fail.test.ts`、`src/__tests__/closure/verify-retry.test.ts`、`src/__tests__/token/remediation-reauth.test.ts`、`src/__tests__/closure/overdue-recovery.test.ts`、`src/__tests__/ledger/manifest-commit-fail.test.ts`、`src/__tests__/ledger/idempotency.test.ts`、`src/__tests__/ledger/concurrent-closure.test.ts`、`src/__tests__/e2e/regression-a3e.test.ts`、`src/__tests__/ingress/v1-no-failopen.test.ts`、`src/__tests__/types/negatives/system-field-forge.ts`、`src/__tests__/ingress/system-field-forge.test.ts`、`src/__tests__/ingress/approval-mismatch.test.ts`、`src/__tests__/fileid/canonicalize.test.ts`、`src/__tests__/types/negatives/token-succeeded-missing-digest.ts`、`src/__tests__/token/succeeded-digest.test.ts`、`src/__tests__/token/group-atomic-issue.test.ts`、`src/__tests__/token/postcheck-recovery.test.ts`、`src/__tests__/token/sibling-revoke-reauth.test.ts`、`src/__tests__/token/rollback-recovery-token.test.ts`、`src/__tests__/ledger/two-process-cas.test.ts`、`src/__tests__/ledger/wal-corruption.test.ts`、`src/__tests__/ledger/three-expiry.test.ts`、`src/__tests__/manifest/payload-tamper.test.ts`、`src/__tests__/snapshot/state-coverage.test.ts`、`src/__tests__/types/negatives/auth-fact-no-diff.ts`、`src/__tests__/types/negatives/obligation-fact-ref.ts`、`src/__tests__/closure/obligation-fact-ref.test.ts`、`src/__tests__/terminal/auth-store-failure.test.ts`、`src/__tests__/terminal/manifest-store-failure.test.ts`、`src/__tests__/closure/retry-snapshot-drift.test.ts`、`src/__tests__/terminal/terminal-uniqueness.test.ts`、`src/__tests__/snapshot/dirty-freeze.test.ts`、`src/__tests__/token/migration-single-authority.test.ts`、`src/__tests__/token/file-set-conflict.test.ts`、`src/__tests__/closure/attempt-mix.test.ts`、`src/__tests__/ledger/prepared-and-commit-audit-crash.test.ts`、`src/__tests__/terminal/token-spy.test.ts`、`src/__tests__/stagerunner/handler-registry.test.ts`、`src/__tests__/replay/missing-snapshot.test.ts`

**动态 runtime object 模板(非实现文件,运行期生成)**:`data/ledger/objects/<content_digest>.json`、`data/ledger/prepared/<txn_id>.json`、`data/ledger/commit/<txn_id>.marker`、`data/ledger/head.json`、`data/ledger/audit/<run_id>.json`、`data/secrets/tokens/<token_id>.secret`、`data/secrets/tokens/index.json`

**不改(本期)**:`D:/tools/wenstar-cc/src/` 下 WenStar 业务源码、`src/GateController.ts` 判定核心。
## 12. 规则生命周期与时序

```
Requirement ──► AuthorizationObligation(不可变)
        └──► ClosureFact 检查(ProducedFact)
                └──► ObligationResolution(独立追加)
```

```
authorization run(harness_authorization_flow)→ canonical → AuthorizationRecord+TokenGroup → authorization_complete
  │ token group
  ▼
[编辑区间:外部编辑器;pre/post-check 消费/终结 token]
  ▼
closure run(harness_closure_flow)→ StageRunner 注册表 handler(tsc/test/diff/doc/hook)→ ClosureManifest → closure_complete
  closure 永不签 token、永不写码
```

---

*本文档为 DRAFT,仅供复核。未经复核批准,不构成任何源码/SelfGuard/重启/flow/commit/push/A3f0 授权。*

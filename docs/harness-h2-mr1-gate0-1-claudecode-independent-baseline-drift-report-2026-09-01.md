# Harness H2 / MR-1 Gate 0.1 只读重提 — Claude Code 基线漂移回报

- 日期：2026-09-01
- 执行仓：`D:\AI文件\harness`
- 任务书：`docs/harness-h2-mr1-gate0-1-read-only-resubmission-taskbook-2026-08-31.md`（SHA `0ffc738d4e4dbd0b7b9f3a93b91aed8b55a1ab104031597fbc01126bd48dd74f`）
- 授权：仅只读；未编辑任何源码/测试/YAML/audit/token；未签 exemption/token、未跑 flow、未重启服务、未 commit/push。

## 1. 结论

```
VERDICT = STOP_BASELINE_DRIFT
```

依据：任务书 §一 声明本次投递后工作树预期为 **30 项（17 staged + 1 unstaged + 12 untracked）**；实测为 **33 项（17 staged + 1 unstaged + 15 untracked）**。untracked 多出 **3 个代码/测试文件**，mtime 均为 **2026-09-01 10:34**（晚于本任务书投递 08-31 20:00），不在任务书"只会新增 2 个文档"的投递声明内。按任务书"除此之外任一固定输入、状态项或候选文件漂移时，回报 `STOP_BASELINE_DRIFT`，不以新状态自行改写本任务"，立即停止，不继续 hunk 计数 / co-edit preimage / token 链等后续只读分析。

## 2. 实时核对（expected / observed）

| 检查项 | 任务书声明（expected） | 实测（observed） | 结果 |
|---|---|---|---|
| git --version | Git 2.54.0.windows.1 | `2.54.0.windows.1` | ✅ |
| branch / HEAD | main（gate0 复核基线 `737374ac…`） | `main@737374ac678b176ae518b0d302d5e6fd6c604b0c` | ✅ |
| staged 计数 | 17 | `17`（14 M + 3 A） | ✅ |
| unstaged 计数 | 1 | `1`（`src/DualChannelSignal.ts`） | ✅ |
| untracked 计数 | **12** | **15** | ❌ |
| 总项数 | **30** | **33** | ❌ |

## 3. 漂移项（3 个未声明 untracked 代码/测试文件）

```text
scripts/owner-closure-core.cjs                    2026-09-01 10:34:31
src/__tests__/OwnerAdoptedClosure.test.ts         2026-09-01 10:34:32
tests/security/owner-closure-core.test.ts         2026-09-01 10:34:32
```

- 三者均非任务书 §一 允许新增的 2 个 docs-only 文档；
- mtime 晚于任务书投递时间（08-31 20:00），属本次投递声明之外的新增状态；
- 与 Owner 先前所述"候选机制已完成并通过隔离验证（131/131）"的 `OwnerAdoptedClosure` / `owner-closure-core` 候选对应。

按任务书纪律，执行者**不以该新状态自行改写本任务基线**，交由 Owner 裁决是否接受为 Gate 0.1 新基线（或先移除/入库）。

## 4. 其余核对项（无漂移）

- 12 候选文件状态与固定写前 SHA：
  - `src/DelegateReviewer.ts`：`e949cb51d2f4683b0d5849532f707db4fe5d140583f0bdd41970c9107bd6a7ac`（staged M）✅ 匹配任务书 §三 固定写前值；
  - `mcp/server.ts`：`9578f65bd8b53756a40690c411c607ba90da2564f39a9f9fb441c3e069b0b298`（staged M）✅ 匹配任务书 §三 固定写前值；
  - 其余：`FlowEngine.ts`（M）、`types.ts`（M）、`ConvergenceGate.ts`（M）、`wenstaros_core_repair_flow.yaml`（M）、`flow-terminal-policy.ts`（A）、`DualChannelSignal.ts`（unstaged M）、`StageRunner.ts`/`ComplianceScorer.ts`/`main_harness_checker.ts`（clean）。
- 固定取证物 `data/audit/2026-08-31/run_mtgp43yy_x2z3.json`：18,572 bytes / SHA-256 `5043df93d477bd8df137f265652b3c83e795f19e52a6fc4f81de7b2a5df98b5b`，未改写 ✅。
- 3000 / 8765（仅记录，不启停）：
  - 3000：无 LISTENING（执行者于 2026-08-31 依 Owner 指令 `Stop-Process` 终止 webui PID 67568）；
  - 8765：`LISTENING` PID `31312`（gate0 复核文档记录为 PID 416，属服务进程状态变化，非生产基线项）。

## 5. 零写入证明

- 前：`main@737374ac…`，status 33 项（17+1+15）。
- 后（本报告撰写完成时）：`main@737374ac…` 未变；本报告为 Gate 0.1 回报交付物，新增为 untracked 文档 `docs/harness-h2-mr1-gate0-1-claudecode-independent-baseline-drift-report-2026-09-01.md`（上报后 untracked 变为 16，含本报告）；未编辑任何生产文件。
- 12 候选文件、audit json、formal-landing taskbook（10,120B / `5cc661ba…`）、gate0 corrections 文档均未改动。

## 6. 回报末尾固定行

```text
VERDICT = STOP_BASELINE_DRIFT
CO_EDIT_DECISION = UPSTREAM_REVIEWER_PATH_A
TOKEN_INVARIANT = (未评估：基线漂移，未进入 token 链分析)
AUDIT_FACT = VALID_UTF8_JSON_READER_DEFAULT_MISDECODE
NO_MUTATION_PROOF = HEAD 737374ac678b176ae518b0d302d5e6fd6c604b0c 未变；status 33→33+1(本报告)；12 候选 hash 与固定写前值一致；audit 5043df93… 未改写
```

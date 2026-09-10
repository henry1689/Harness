# 运行验证说明（enhance-v1 已落地部分）

## 已 live 能力的验证路径

### 1. 补丁循环自动回架构重审（E-02，live）
触发：某 run 的 S4.5/S5/S6 驳回→S3 达 3 轮。
验证：看 mcp 日志出现
`[FlowEngine] 🔴 S3 补丁循环 ... → WARN: 强制回退架构重审 S1→S2`；
audit 卷宗含 `run_signals: [{signal:'s3_stuck_in_patch_loop',...}]`；旧 s2_evidence 标记 superseded。
绕行/终局：若 S2 复批仍携 superseded 旧证据 → `recordAbort('s3_patch_loop')` 终局（需新 s2_evidence 重开）。

### 2. S4.5 完整证据下传编码（H-04，live）
触发：任意 S4.5 驳回（内容问题）→ 回流 S3。
验证：读该 run 的 memo 文件（data/memos/<run_id>_memo.md）含
`## 📋 S4.5 完整评审证据（H-04：编码前必读全部明细）` 及逐条 DS 扣分/失败 CK；
audit 的 S4.5 gate 记录 machine_signal.full_review_evidence 存在（通过时也产，供 S7 审计）。

### 3. DS 扣分自动入债务候选池（H-03，live）
验证：跑一条 DS<98 的 run 后：
`node scripts/harness-debt-migrate.cjs --list` → debt_candidate_pool 行数增加；
`node -e "..." `（sqlite 查）或迁移 CLI --list。
候选 status=pending，人工确认后转正 ledger（acceptCandidate 接口已备，UI 未接）。

### 4. 整文件覆写防护（H-05，API live，调用点待接线）
单元验证：`npx vitest run src/__tests__/write-ratio.test.ts`（6 用例）。
方法：`ToolWhitelistGuard.checkWriteWithRatio(action,file,newContent)` 在 S3 下对 >0.7 且非白名单文件抛 `S3_FORBID_FULL_FILE_OVERWRITE`；
白名单 `setFullRewriteAllowlist(s2_evidence.allow_full_rewrite)`。
进程内 S3 写调用点接线（预检/引擎捕获）转专项。

### 5. S7 归档校验器（H-01，未接线，纯函数）
单测：`npx vitest run src/__tests__/s7-archive-validator.test.ts`（6 用例，R1-R5）。
接线（YAML S7 出口 gate）见 03 文档。

### 6. 债务台账 DB
`node scripts/harness-debt-migrate.cjs init|--validate-schema|--list` 全通过；
单测 `src/__tests__/b0-enhancement-skeletons.test.ts` 覆盖 CRUD/候选/压缩/校验（20 用例）。

## 快捷回归命令
```
cd D:\AI文件\harness
npx tsc --noEmit
npx vitest run src/__tests__/b0-enhancement-skeletons.test.ts src/__tests__/write-ratio.test.ts src/__tests__/s7-archive-validator.test.ts
# 全量干净回归（低负载窗口执行）
npx vitest run
```

## 转专项验证 —— 已执行（2026-09-10）
| 项 | 结果 | 证据 |
|---|---|---|
| E02-S3-patch_loop 端到端 | ✅ | `FlowEngine.test.ts`：S4 持续驳回 → 回流达上限 → 补丁循环硬止 `s3_patch_loop` |
| H01-S7 归档各分支 | ✅ | `s7-archive-delegate.test.ts`(5)：缺产物 / 合规通过 / 缺债务(R2) / 回滚漏记(R3) / 大重构缺三轮复审(R5) |
| H02-S6 分层门控 | ✅ | `manual-verify-io.test.ts`(13)：未确认悬挂 → 确认后**新 run_id 重跑命中同一 change_key** → 放行；`skip_manual_verification=true` 全自动且不落盘任务单 |
| 全量干净回归 | ✅ | `tsc --noEmit` 0 错误；`vitest run` 597/597（33 文件，≈29s，`--no-file-parallelism`） |
| 旧卷宗兼容 | ✅（结构保证） | `run_status` 为可选字段，老 run 无 S6-B/S7-B 时自然落回 `completed`/`aborted`（`deriveRunStatus` 优先级） |

**未覆盖 / 已知限制**：
- 未跑真实端到端 live run（需人工 gate 证据 + 真实改动）；S6-B/S7-B 的 live 表现留待下一次真实 run 观察。
- 旧卷宗「解析兼容」为结构性保证，未跑 ≥2 份历史 run 的实读。

## 全量回归命令（推荐低负载窗口）
```
cd D:\AI文件\harness
npx tsc --noEmit
NODE_OPTIONS="--max-old-space-size=4096" npx vitest run --no-file-parallelism
```
> ⚠️ 默认并行模式下 dev 高负载会 `ERR_IPC_CHANNEL_CLOSED`（worker 崩溃，非测试失败）；串行 + 4GB 堆可稳定在 ≈29s 跑完。

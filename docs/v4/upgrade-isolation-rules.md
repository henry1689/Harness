# Harness v4.0 Upgrade Isolation Rules

> **版本**: v1.0  
> **创建日期**: 2026-08-02  
> **创建任务**: P0-T4  
> **适用分支**: `feature/harness-v4-project-brain`  
> **状态**: ✅ 生效中

---

## 1. Purpose

本文档为 Harness v4.0 升级改造建立隔离边界。

v4.0 将引入以下新能力：

- **ProjectBrain** — 项目大脑（架构感知）
- **ChangeImpactAnalyzer** — 变更影响分析
- **IntentSpec** — 意图合约
- **DiffScopeGuard** — 差异范围守卫
- **ArchitectureBaseline** — 架构基线
- **Intent-bound Token** — 意图绑定令牌

本文档确保这些新能力的开发不会破坏现有 v3.0 稳定主链路和三道防线。

**核心理念**: 先建墙，后装修。

---

## 2. Current P0 Baseline

### 2.1 Git Branch

| Field | Value |
|---|---|
| Branch | `feature/harness-v4-project-brain` |
| Base | `main` @ `28dd3aeec5c7755ca67e9e50f289468120816d20` |

### 2.2 P0 Task Status

| Task | Description | Status |
|------|-------------|--------|
| P0-T1 | Harness 当前基线快照 | ✅ PASS |
| P0-T2 | 三道防线健康检查 | ✅ PASS |
| P0-T2R | 三道防线恢复 | ✅ PASS |
| P0-T2H | 健康检查脚本误报修复 | ✅ PASS |
| P0-T3 | 建立 v4 改造分支 | ✅ PASS |
| P0-T4 | 改造隔离规则文档 | ✅ 本文档 |

### 2.3 Current Defense Matrix

| Defense | Status | Verified At |
|---------|--------|-------------|
| PM2 Guard | ✅ PASS | 2026-08-02T15:33:19Z |
| MCP Gate | ✅ PASS | 2026-08-02T15:33:19Z |
| Sentinel | ✅ PASS | 2026-08-02T15:33:19Z |
| Git Hook | ✅ PASS | 2026-08-02T15:33:19Z |
| **Overall** | ✅ **PASS** | — |

### 2.4 Code Health

| Check | Status |
|-------|--------|
| `npx tsc --noEmit` | ✅ PASS |
| `npx vitest run` | ✅ PASS (67 tests, 6 files) |

### 2.5 PM2 Processes

| Process | Status | PID |
|---------|--------|-----|
| harness-mcp | online | 45928 |
| harness-sentinel | online | 14084 |

### 2.6 Reference Reports

| Report | Path |
|--------|------|
| P0-T2H Health (latest fixed) | `data/reports/health/health-20260802-232840.json` |
| P0-T3 Health (branch switch verify) | `data/reports/health/health-20260802-233319.json` |
| P0-T3 Branch Prep | `data/reports/branch/branch-20260802-233319.json` |
| P0-T1 Baseline | `data/reports/baseline/` |
| P0-T2R Recovery | `data/reports/recovery/` |

---

## 3. Core Principles

以下七条原则是 v4.0 改造期间的铁律，**任何阶段、任何任务、任何 Agent 都必须遵守**：

| # | Principle | Description |
|---|-----------|-------------|
| 1 | **Additive-first** | 优先新增文件和模块，不修改旧链路。新增 > 修改 > 删除。 |
| 2 | **No silent mutation** | 不得静默修改 S1-S7 行为、gate 条件、token 语义或 MCP/Sentinel 逻辑。 |
| 3 | **Defense-first** | MCP / Sentinel / Git Hook 三道防线优先保持可用。防线 FAIL → 停止开发。 |
| 4 | **Reversible** | 每个任务的改动必须可以 `git checkout --` 回退，不依赖"后续修复"。 |
| 5 | **Auditable** | 每个任务必须产出报告或明确的验证记录（JSON + Markdown）。 |
| 6 | **Minimal scope** | 每个任务只改任务书明确允许的文件。不要"顺手优化"。 |
| 7 | **No threshold weakening** | 不得降低 DS/CK/Token/Gate 标准来让检查变绿。 |

---

## 4. Branch Policy

### 4.1 Target Branch

```
feature/harness-v4-project-brain
```

### 4.2 Rules

| # | Rule |
|---|------|
| 1 | 所有 v4.0 改造必须在 `feature/harness-v4-project-brain` 分支进行 |
| 2 | 不允许直接在 `main` 上做任何 v4.0 改造 |
| 3 | 不允许未经过架构师审查就 merge 回 `main` |
| 4 | 每个任务启动前必须检查当前分支：`git branch --show-current` |
| 5 | 若当前分支不是目标分支，**立即停止并报告** |
| 6 | Agent 不得自行执行 `git push` |
| 7 | Agent 不得自行执行 `git pull`（避免 merge conflict 污染） |

---

## 5. Allowed Change Areas

按 v4.0 改造阶段划分。

### 5.1 P1 — ProjectBrain v0.1（类型骨架）

| Area | Restriction |
|------|-------------|
| `src/project-brain/` | ✅ 允许新增 |
| `src/intent/` | ✅ 允许新增 |
| `src/types/project-brain.ts` | ✅ 允许新增 |
| `tests/project-brain/` | ✅ 允许新增 |
| `data/project-brain/` | ✅ 允许新增 |
| `data/reports/project-brain/` | ✅ 允许新增 |
| `docs/v4/` | ✅ 允许新增/修改 |

**P1 禁止**：

- 修改 `src/FlowEngine.ts`
- 修改 `src/StageRunner.ts`
- 修改 `src/GateController.ts`
- 接入 S1-S7 流水线
- 调用 MCP 服务
- 修改 Sentinel
- 修改 Git Hook
- 修改 token 语义
- 修改 YAML flow 配置
- 新增 npm 依赖

### 5.2 P2 — DiffScopeGuard（差异范围守卫）

| Area | Restriction |
|------|-------------|
| `src/diff-scope/` | ✅ 允许新增 |
| `tests/diff-scope/` | ✅ 允许新增 |
| `data/reports/diff-scope/` | ✅ 允许新增 |
| `docs/v4/` | ✅ 允许新增/修改 |

### 5.3 P3 — ArchitectureBaseline（架构基线）

| Area | Restriction |
|------|-------------|
| `src/architecture/` | ✅ 允许新增 |
| `tests/architecture/` | ✅ 允许新增 |
| `data/reports/architecture/` | ✅ 允许新增 |
| `docs/v4/` | ✅ 允许新增/修改 |

### 5.4 P4 — Dashboard / Digest（全景面板）

| Area | Restriction |
|------|-------------|
| `src/dashboard/` | ✅ 允许新增 |
| `src/digest/` | ✅ 允许新增 |
| `tests/dashboard/` | ✅ 允许新增 |
| `tests/digest/` | ✅ 允许新增 |
| `data/reports/dashboard/` | ✅ 允许新增 |
| `data/reports/digest/` | ✅ 允许新增 |
| `docs/v4/` | ✅ 允许新增/修改 |

### 5.5 Cross-cutting Rule

> ⚠️ **任何阶段如需修改既有 `src/` 核心文件，必须单独提交架构师变更申请，不能在普通任务中"顺手修改"。**

---

## 6. Forbidden Change Areas

以下区域在 v4.0 改造期间**绝对禁止修改**，除非任务书明确授权且经过架构师审批。

### 6.1 Core Pipeline（S1-S7 主链路）

```
src/FlowEngine.ts
src/StageRunner.ts
src/GateController.ts
src/ComplianceScorer.ts
src/EvolutionEngine.ts
src/main_harness_checker.ts
```

### 6.2 MCP Server（第一道防线）

```
mcp/server.ts
mcp/start.cjs
```

### 6.3 Sentinel（第二道防线）

```
sentinel/sentinel-service.cjs
sentinel/watcher.cjs
sentinel/rollback.cjs
sentinel/escalation.cjs
sentinel/sentinel-mcp-client.cjs
```

### 6.4 Git Hook（第三道防线）

```
scripts/harness-gate.cjs
hooks/pre-commit
hooks/pre-commit.template
```

### 6.5 P0 Instrumentation Scripts（基线/健康检查工具）

```
scripts/baseline-report.cjs
scripts/defense-health-check.cjs
```

### 6.6 Infrastructure & Config

```
ecosystem.config.cjs
package.json
tsconfig.json
data/flows/*.yaml
```

### 6.7 Runtime Data（历史审计数据）

```
data/tokens/**        ← 审批令牌，禁止清空或手工修改
data/audit/**         ← 审计日志，禁止清空或手工修改
data/sentinel/**      ← 哨兵事件，禁止清空或手工修改
```

---

## 7. ProjectBrain P1 Allowed Scope

### 7.1 P1-T1（类型骨架）允许

```
src/project-brain/types.ts        ← 核心类型定义
src/project-brain/index.ts        ← 模块入口
tests/project-brain/types.test.ts ← 类型测试
data/project-brain/.gitkeep       ← 数据目录占位
data/reports/project-brain/.gitkeep ← 报告目录占位
```

### 7.2 P1-T1 禁止

| # | 禁止项 |
|---|--------|
| 1 | 修改 `src/FlowEngine.ts` |
| 2 | 接入 S1-S7 流水线 |
| 3 | 调用 MCP 服务 |
| 4 | 修改 Sentinel |
| 5 | 修改 Git Hook |
| 6 | 修改 token 语义 |
| 7 | 修改 YAML flow 配置 |
| 8 | 新增 npm 依赖 |
| 9 | 修改 `package.json` |
| 10 | 修改 `tsconfig.json` |

---

## 8. S1-S7 Pipeline Protection Rules

### 8.1 保护原则

> 在 v4.0 改造未完成架构师验收前，**禁止改变 S1-S7 主链路**。

### 8.2 受保护 Stage

| Stage | Code | Protected |
|-------|------|-----------|
| S1 — 问题定位 & 风险盘点 | `TASK_INPUT` | ✅ |
| S2 — 方案设计 & 架构合规 | `STATIC_ANALYSIS` | ✅ |
| S3 — 代码落地 | `REFLECTION` | ✅ |
| S4 — 独立架构评审 | `DELEGATE_REVIEW` | ✅ |
| S5 — 编译 & 测试 & 补丁嗅探 | `COMPLIANCE` | ✅ |
| S6 — Token 发放 | `TOKEN_ISSUE` | ✅ |
| S7 — 补丁应用 & 变更归档 | `APPLY_PATCH` | ✅ |

### 8.3 禁止操作

| # | 禁止 |
|---|------|
| 1 | 改变 stage 顺序 |
| 2 | 改变 gate 条件（auto → human → condition） |
| 3 | 改变 token 发放条件 |
| 4 | 改变补丁应用逻辑 |
| 5 | 改变 DS/CK 阈值 |
| 6 | 改变失败处理逻辑（例如将 hard-fail 改为 soft-warn） |
| 7 | 新增 stage（在架构师验收前禁止扩展流水线） |
| 8 | 删除 stage |

---

## 9. MCP / Sentinel / Git Hook Protection Rules

### 9.1 防线保护铁律

| # | Rule |
|---|------|
| 1 | v4.0 P1-P4 默认不得修改 MCP Server |
| 2 | v4.0 P1-P4 默认不得修改 Sentinel |
| 3 | v4.0 P1-P4 默认不得修改 Git Hook |
| 4 | 如果防御健康检查 FAIL，**必须先恢复防线，再继续开发** |
| 5 | 每个任务完成后必须至少运行 `node scripts/defense-health-check.cjs` |
| 6 | 任何导致防线退化的改动都属于违规，必须立即回退 |

### 9.2 防线状态检查命令

```bash
# 必须执行（每个任务后）
node scripts/defense-health-check.cjs

# 如果涉及核心逻辑改动（需架构师审批后）
node scripts/baseline-report.cjs
npx tsc --noEmit
npx vitest run
```

### 9.3 防线状态期望

| Defense | Expected |
|---------|----------|
| PM2 Guard | PASS |
| MCP Gate | PASS |
| Sentinel | PASS |
| Git Hook | PASS |
| Overall | PASS |

> 如果 Git Hook 因某些原因 WARN（如 hooks 模板目录缺失但项目 hook 存在），需要记录具体原因并确认是否为已知的 acceptable deviation。

---

## 10. Data, Reports, and Runtime State Policy

### 10.1 Report Artifacts（可生成）

```
data/reports/baseline/**
data/reports/health/**
data/reports/recovery/**
data/reports/branch/**
data/reports/project-brain/**
data/reports/diff-scope/**
data/reports/architecture/**
data/reports/dashboard/**
data/reports/digest/**
```

这些目录由各阶段脚本自动创建和填充。任务可以新增报告，**但不得删除既有报告**。

### 10.2 Project Data（可新增）

```
data/project-brain/**
docs/v4/**
```

### 10.3 Runtime State（禁止手工修改）

```
data/tokens/**        ← 审批令牌
data/audit/**         ← 审计日志
data/sentinel/**      ← 哨兵事件
data/heartbeat.json   ← MCP 心跳
data/logs/**          ← 运行时日志
```

> 运行时状态文件可以自然更新（如 PM2 写 heartbeat），但任务不得为了通过检查而**伪造或手工改写**。

### 10.4 P0 Scripts Protection

```
scripts/baseline-report.cjs     ← P0-T1 基线工具，禁止修改
scripts/defense-health-check.cjs ← P0-T2 健康检查工具，禁止修改
scripts/harness-gate.cjs         ← P0-T2R 恢复版 Gate，禁止修改
hooks/pre-commit                 ← Hook 模板，禁止修改
hooks/pre-commit.template        ← Hook 模板，禁止修改
```

---

## 11. Validation Requirements Per Task

### 11.1 标准验证（每个任务完成后必须执行）

```bash
# 1. 类型检查
npx tsc --noEmit

# 2. 单元测试
npx vitest run

# 3. 防线健康
node scripts/defense-health-check.cjs
```

### 11.2 纯文档任务

对于纯文档任务（如 P0-T4），可以只运行：

```bash
node scripts/defense-health-check.cjs
```

但必须在任务完成报告中说明为什么未运行 `tsc` / `vitest`。

### 11.3 验证记录要求

每个任务必须在完成报告中记录：

| Item | Required |
|------|----------|
| `tsc --noEmit` exit_code | ✅ |
| `vitest run` exit_code + test count | ✅ |
| `defense-health-check.cjs` Defense Matrix | ✅ |
| 最新 health report 路径 | ✅ |

---

## 12. Token and Approval Policy

### 12.1 Token 使用规则

| # | Rule |
|---|------|
| 1 | 不允许绕过 Harness token 机制 |
| 2 | 不允许手工伪造 token |
| 3 | 不允许消费或删除已有 token，除非任务书明确要求 |
| 4 | 高风险文件变更必须经过 Harness gate（即 pre-commit hook → harness-gate.cjs → token 检查） |
| 5 | ProjectBrain 早期阶段只做只读分析和报告生成，**不得自动发放 token** |
| 6 | Token 目录 (`data/tokens/`) 保持不变，不新增也不清空 |

### 12.2 Token Schema（v3 当前）

```json
{
  "file": "src/webui/chat.ts",
  "project": "wenstar-cc",
  "expires_at": "2026-08-03T00:00:00Z",
  "consumed": false
}
```

v4.0 后续可能引入 Intent-bound Token，但不属于 P1 范围。

---

## 13. Git Commit Policy

### 13.1 Agent 禁止操作

| # | 禁止操作 |
|---|----------|
| 1 | `git add` |
| 2 | `git commit` |
| 3 | `git push` |
| 4 | `git pull` |
| 5 | `git stash` |
| 6 | `git reset` |
| 7 | `git clean` |
| 8 | `git merge` |
| 9 | `git rebase` |
| 10 | `git checkout -- <file>`（即丢弃已跟踪文件的修改） |

### 13.2 建议后续人工提交分组

当架构师确认后，人工执行以下 commit：

```
1. P0 instrumentation and defense recovery
   - scripts/baseline-report.cjs
   - scripts/defense-health-check.cjs
   - scripts/harness-gate.cjs
   - hooks/pre-commit
   - hooks/pre-commit.template

2. P0 reports and branch preparation
   - data/reports/**

3. P0 isolation rules
   - docs/v4/upgrade-isolation-rules.md

4. P1 ProjectBrain skeleton
   - src/project-brain/**
   - tests/project-brain/**
```

> ⚠️ 这些 commit 不由 Agent 执行，仅作为建议供架构师参考。

---

## 14. Stop Conditions

如果发生以下**任意一项**，当前任务及后续 v4.0 改造**立即停止**，等待架构师指令：

### 14.1 Branch & Environment

| # | Condition |
|---|-----------|
| 1 | 当前分支不是 `feature/harness-v4-project-brain` |
| 2 | 发现被管制项目 `.git/hooks/pre-commit` 缺失或被篡改 |

### 14.2 Defense Failures

| # | Condition |
|---|-----------|
| 3 | PM2 Guard FAIL |
| 4 | MCP Gate FAIL |
| 5 | Sentinel FAIL |
| 6 | Git Hook FAIL |

### 14.3 Code Integrity

| # | Condition |
|---|-----------|
| 7 | 检测到 forbidden 区域文件被意外修改 |
| 8 | 需要修改禁止区文件但未经架构师审批 |
| 9 | `npx tsc --noEmit` 失败且原因不明 |
| 10 | `npx vitest run` 失败且原因不明 |

### 14.4 Process & Token

| # | Condition |
|---|-----------|
| 11 | 需要新增 npm 依赖 |
| 12 | Sentinel 或 Git Hook 主动阻断 |
| 13 | PM2 进程异常退出 |

---

## 15. Architect Review Gate

### 15.1 每个任务完成后必须提交

每个 v4.0 任务完成后，Agent 必须在完成报告中包含：

```markdown
## 改动文件列表
（列出所有新增/修改文件）

## 执行命令
（列出所有执行的命令、exit_code、duration_ms）

## 测试结果
- tsc --noEmit: PASS/FAIL
- vitest run: PASS/FAIL (N tests)
- defense health check: PASS/WARN/FAIL

## 健康报告路径
（最新 health report JSON 路径）

## 风险与剩余问题
（列出 critical findings 和 warnings）

## 是否触碰禁止区
是 / 否。如是，说明具体文件和原因。
```

### 15.2 审查流程

```
任务完成 → Agent 提交完成报告 → 架构师审查 → 批准或驳回
                                              ↓ 批准
                                         下一任务
```

> **不得跳过架构师审查直接进入下一任务。**

---

## 16. P0 Reference Reports

### 16.1 Report Directory Map

| Directory | Content | Source Task |
|-----------|---------|-------------|
| `data/reports/baseline/` | Harness v3.0 基线快照 | P0-T1 |
| `data/reports/health/` | 三道防线健康检查报告 | P0-T2, P0-T2H |
| `data/reports/recovery/` | 防线恢复报告 + 备份 | P0-T2R |
| `data/reports/branch/` | 分支准备报告 | P0-T3 |

### 16.2 Key Reports

| Report | Description |
|--------|-------------|
| `data/reports/health/health-20260802-232840.json` | P0-T2H 修复后健康报告 (ALL PASS) |
| `data/reports/health/health-20260802-233319.json` | P0-T3 分支切换后验证报告 (ALL PASS) |
| `data/reports/branch/branch-20260802-233319.json` | P0-T3 分支准备报告 |

### 16.3 Finding Reports

```bash
# 查看最新健康状态
node scripts/defense-health-check.cjs

# 查看最新基线
node scripts/baseline-report.cjs

# 列出所有报告
ls data/reports/health/
ls data/reports/baseline/
```

---

## 17. Appendix: File Scope Matrix

### 17.1 Core Pipeline

| Area | Status | Allowed In | Notes |
|------|--------|------------|-------|
| `src/FlowEngine.ts` | 🔴 Forbidden | Architect approval required | S1-S7 DFA state machine core |
| `src/StageRunner.ts` | 🔴 Forbidden | Architect approval required | Local/delegate runner |
| `src/GateController.ts` | 🔴 Forbidden | Architect approval required | auto/human/condition gates |
| `src/ComplianceScorer.ts` | 🔴 Forbidden | Architect approval required | DS/CK scoring |
| `src/EvolutionEngine.ts` | 🔴 Forbidden | Architect approval required | Self-evolution logic |
| `src/main_harness_checker.ts` | 🔴 Forbidden | Architect approval required | Main entry |

### 17.2 MCP (First Defense)

| Area | Status | Allowed In | Notes |
|------|--------|------------|-------|
| `mcp/server.ts` | 🔴 Forbidden | Architect approval required | MCP HTTP server |
| `mcp/start.cjs` | 🔴 Forbidden | Architect approval required | PM2 entry script |

### 17.3 Sentinel (Second Defense)

| Area | Status | Allowed In | Notes |
|------|--------|------------|-------|
| `sentinel/sentinel-service.cjs` | 🔴 Forbidden | Architect approval required | Core sentinel service |
| `sentinel/watcher.cjs` | 🔴 Forbidden | Architect approval required | File system watcher |
| `sentinel/rollback.cjs` | 🔴 Forbidden | Architect approval required | Rollback logic |
| `sentinel/escalation.cjs` | 🔴 Forbidden | Architect approval required | Escalation logic |
| `sentinel/sentinel-mcp-client.cjs` | 🔴 Forbidden | Architect approval required | MCP client |
| `data/sentinel/**` | 🟡 Runtime | — | Protected runtime data |

### 17.4 Git Hook (Third Defense)

| Area | Status | Allowed In | Notes |
|------|--------|------------|-------|
| `scripts/harness-gate.cjs` | 🔴 Forbidden | Architect approval required | Pre-commit gate script |
| `hooks/pre-commit` | 🔴 Forbidden | Architect approval required | Hook template |
| `hooks/pre-commit.template` | 🔴 Forbidden | Architect approval required | Hook template |

### 17.5 P0 Instrumentation

| Area | Status | Allowed In | Notes |
|------|--------|------------|-------|
| `scripts/baseline-report.cjs` | 🔴 Forbidden | P0 only | Baseline snapshot tool |
| `scripts/defense-health-check.cjs` | 🔴 Forbidden | P0-T2H only | Defense health check tool |

### 17.6 Configuration

| Area | Status | Allowed In | Notes |
|------|--------|------------|-------|
| `ecosystem.config.cjs` | 🔴 Forbidden | Architect approval required | PM2 config |
| `package.json` | 🔴 Forbidden | Architect approval required | Dependencies |
| `tsconfig.json` | 🔴 Forbidden | Architect approval required | TypeScript config |
| `data/flows/*.yaml` | 🔴 Forbidden | Architect approval required | Flow definitions |

### 17.7 v4 New Areas

| Area | Status | Allowed In | Notes |
|------|--------|------------|-------|
| `src/project-brain/` | 🟢 Allowed | P1 | New ProjectBrain code |
| `src/intent/` | 🟢 Allowed | P1 | IntentSpec types |
| `src/types/project-brain.ts` | 🟢 Allowed | P1 | Shared type definitions |
| `tests/project-brain/` | 🟢 Allowed | P1 | ProjectBrain tests |
| `data/project-brain/` | 🟢 Allowed | P1 | ProjectBrain data |
| `data/reports/project-brain/` | 🟢 Allowed | P1 | ProjectBrain reports |
| `src/diff-scope/` | 🟢 Allowed | P2 | DiffScopeGuard code |
| `src/architecture/` | 🟢 Allowed | P3 | ArchitectureBaseline code |
| `src/dashboard/` | 🟢 Allowed | P4 | Dashboard code |
| `src/digest/` | 🟢 Allowed | P4 | Digest code |
| `docs/v4/` | 🟢 Allowed | All | v4 documentation |

### 17.8 Data & Reports

| Area | Status | Allowed In | Notes |
|------|--------|------------|-------|
| `data/reports/**` | 🟢 Allowed generated | All | Reports only, no deletion |
| `data/tokens/**` | 🔴 Forbidden | — | Protected runtime data |
| `data/audit/**` | 🔴 Forbidden | — | Protected runtime data |
| `data/heartbeat.json` | 🟡 Runtime | — | Auto-updated by PM2 |

### 17.9 Legend

| Symbol | Meaning |
|--------|---------|
| 🟢 Allowed | 可在对应阶段新增/修改 |
| 🟡 Runtime | 运行时数据，自然更新但禁止手工修改 |
| 🔴 Forbidden | 未经架构师审批绝对禁止修改 |

---

> 📌 **本文档在 v4.0 改造全程有效。**  
> 任何 Agent 在执行 v4.0 任务前必须先阅读本文档。  
> 如果发现文档与实际需求冲突，必须停止并向架构师报告，不得自行修改本文档或绕行。

---

*Generated by P0-T4 isolation rules task at 2026-08-02T15:40:00Z*  
*Harness v4.0 Upgrade Isolation Rules — P0-T4*

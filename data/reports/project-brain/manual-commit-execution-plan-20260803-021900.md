# Manual Commit Execution Plan

## 1. Summary

| Metric | Value |
|---|---|
| Decision | **🟢 PLAN_READY** |
| Branch | `feature/harness-v4-project-brain` |
| HEAD | `28dd3aeec5c7755ca67e9e50f289468120816d20` |
| Total Commits | **7** |
| Total Planned Files | **67** |
| Excluded Files | **~849** (runtime + health + sentinel + logs + quarantine + gate reports) |
| Commit Order | **1 → 2 → 3 → 4 → 5 → 6 → 7** |
| Final Vitest Gate | ✅ ALLOW_MANUAL_COMMIT (418/418 PASS) |

> 🟢 **PLAN_READY.** 此报告提供 7 个 commit 的精确人工执行命令。按顺序逐条执行即可。

---

## 2. Source Reports

| Report | Path |
|--------|------|
| P4-Prep Commit Plan | `data/reports/project-brain/p4-prep-commit-plan-dry-run-20260803-020200.json` |
| Final Vitest Gate | `data/reports/project-brain/final-vitest-gate-before-manual-commit-20260803-021200.json` |

---

## 3. Branch and HEAD

| Field | Value |
|---|---|
| Current Branch | `feature/harness-v4-project-brain` |
| HEAD | `28dd3aeec5c7755ca67e9e50f289468120816d20` |

---

## 4. Git Status

| Field | Value |
|---|---|
| Dirty | true |
| Status Count | 27 porcelain entries |
| Tracked Modified | 1 (`data/heartbeat.json` — PM2 runtime) |
| Diff | `data/heartbeat.json` only (1 line change) |

> ⚠️ `data/heartbeat.json` is the ONLY modified tracked file. It must NOT be staged in any commit.

---

## 5. Global Safety Rules

### 🔴 FORBIDDEN COMMANDS

```
❌ git add .            — stages ALL files including runtime/health/sentinel
❌ git add -A           — same as git add .
❌ git add --all        — same as git add .
❌ git add *            — wildcard, unpredictable
```

### 🟢 REQUIRED COMMANDS (before each commit)

```bash
git diff --cached --name-only    # verify ONLY expected files are staged
```

### 🛑 ABORT RULE

If `git diff --cached --name-only` shows any file from the exclude list (Section 13):

```bash
git reset HEAD <offending-file>
```

### 📋 Before Starting

```bash
# 1. Clean up atomic write residue
rm data/reports/baseline/baseline-20260802-225626.md.tmp

# 2. Verify starting state
git status --porcelain

# 3. Confirm only expected untracked files exist
# (No forbidden files should appear)
```

---

## 6. Commit Step 1 — P0 Isolation Instrumentation

### Message

```
chore(harness-v4): add P0 isolation instrumentation and baseline reports
```

### git add Command

```bash
git add \
  scripts/baseline-report.cjs \
  scripts/defense-health-check.cjs \
  scripts/harness-gate.cjs \
  hooks/pre-commit \
  hooks/pre-commit.template \
  docs/v4/upgrade-isolation-rules.md \
  data/reports/baseline/baseline-20260802-225453.json \
  data/reports/baseline/baseline-20260802-225453.md \
  data/reports/baseline/baseline-20260802-225626.json \
  data/reports/baseline/baseline-20260802-225953.json \
  data/reports/baseline/baseline-20260802-225953.md \
  data/reports/baseline/baseline-20260802-231849.json \
  data/reports/baseline/baseline-20260802-231849.md \
  data/reports/branch/branch-20260802-233319.json \
  data/reports/branch/branch-20260802-233319.md \
  data/reports/p0-closeout/p0-closeout-20260802-234337.json \
  data/reports/p0-closeout/p0-closeout-20260802-234337.md \
  data/reports/recovery/backup-20260802-231443/wenstar-cc__pre-commit.bak \
  data/reports/recovery/recovery-20260802-232114.json \
  data/reports/recovery/recovery-20260802-232114.md
```

### Expected Staged Files (20)

```
scripts/baseline-report.cjs
scripts/defense-health-check.cjs
scripts/harness-gate.cjs
hooks/pre-commit
hooks/pre-commit.template
docs/v4/upgrade-isolation-rules.md
data/reports/baseline/baseline-20260802-225453.json
data/reports/baseline/baseline-20260802-225453.md
data/reports/baseline/baseline-20260802-225626.json
data/reports/baseline/baseline-20260802-225953.json
data/reports/baseline/baseline-20260802-225953.md
data/reports/baseline/baseline-20260802-231849.json
data/reports/baseline/baseline-20260802-231849.md
data/reports/branch/branch-20260802-233319.json
data/reports/branch/branch-20260802-233319.md
data/reports/p0-closeout/p0-closeout-20260802-234337.json
data/reports/p0-closeout/p0-closeout-20260802-234337.md
data/reports/recovery/backup-20260802-231443/wenstar-cc__pre-commit.bak
data/reports/recovery/recovery-20260802-232114.json
data/reports/recovery/recovery-20260802-232114.md
```

### Execute

```bash
# 1. Stage
git add \
  scripts/baseline-report.cjs \
  scripts/defense-health-check.cjs \
  scripts/harness-gate.cjs \
  hooks/pre-commit \
  hooks/pre-commit.template \
  docs/v4/upgrade-isolation-rules.md \
  data/reports/baseline/baseline-20260802-225453.json \
  data/reports/baseline/baseline-20260802-225453.md \
  data/reports/baseline/baseline-20260802-225626.json \
  data/reports/baseline/baseline-20260802-225953.json \
  data/reports/baseline/baseline-20260802-225953.md \
  data/reports/baseline/baseline-20260802-231849.json \
  data/reports/baseline/baseline-20260802-231849.md \
  data/reports/branch/branch-20260802-233319.json \
  data/reports/branch/branch-20260802-233319.md \
  data/reports/p0-closeout/p0-closeout-20260802-234337.json \
  data/reports/p0-closeout/p0-closeout-20260802-234337.md \
  data/reports/recovery/backup-20260802-231443/wenstar-cc__pre-commit.bak \
  data/reports/recovery/recovery-20260802-232114.json \
  data/reports/recovery/recovery-20260802-232114.md

# 2. Verify — must match expected list above, EXACTLY 20 files
git diff --cached --name-only

# 3. Commit
git commit -m "chore(harness-v4): add P0 isolation instrumentation and baseline reports"
```

### ⚠️ Watch Items

- `data/reports/baseline/baseline-20260802-225626.md.tmp` — **DO NOT stage** (should have been deleted in pre-flight)

---

## 7. Commit Step 2 — ProjectBrain v0.1 Core

### Message

```
feat(project-brain): add v0.1 core and tests
```

### git add Command

```bash
git add \
  src/project-brain/types.ts \
  src/project-brain/intent-builder.ts \
  src/project-brain/store.ts \
  src/project-brain/reporter.ts \
  tests/project-brain/types.test.ts \
  tests/project-brain/intent-builder.test.ts \
  tests/project-brain/store.test.ts \
  tests/project-brain/reporter.test.ts \
  data/project-brain/.gitkeep \
  data/reports/project-brain/.gitkeep
```

### Expected Staged Files (10)

```
src/project-brain/types.ts
src/project-brain/intent-builder.ts
src/project-brain/store.ts
src/project-brain/reporter.ts
tests/project-brain/types.test.ts
tests/project-brain/intent-builder.test.ts
tests/project-brain/store.test.ts
tests/project-brain/reporter.test.ts
data/project-brain/.gitkeep
data/reports/project-brain/.gitkeep
```

### Execute

```bash
git add \
  src/project-brain/types.ts \
  src/project-brain/intent-builder.ts \
  src/project-brain/store.ts \
  src/project-brain/reporter.ts \
  tests/project-brain/types.test.ts \
  tests/project-brain/intent-builder.test.ts \
  tests/project-brain/store.test.ts \
  tests/project-brain/reporter.test.ts \
  data/project-brain/.gitkeep \
  data/reports/project-brain/.gitkeep

git diff --cached --name-only

git commit -m "feat(project-brain): add v0.1 core and tests"
```

### ⚠️ Watch Items

- `src/project-brain/index.ts` — **DO NOT stage** (deferred to commit 6)

---

## 8. Commit Step 3 — P1 Self Snapshot & Evidence

### Message

```
chore(project-brain): add v0.1 self snapshot and P1 evidence
```

### git add Command

```bash
git add \
  scripts/project-brain-self-snapshot.cjs \
  data/project-brain/project-brain.json \
  data/reports/project-brain/project-brain-20260803-001014.json \
  data/reports/project-brain/project-brain-20260803-001014.md \
  data/reports/project-brain/project-brain-20260803-001359.json \
  data/reports/project-brain/project-brain-20260803-001359.md \
  data/reports/project-brain/p1-closeout-20260803-001405.json \
  data/reports/project-brain/p1-closeout-20260803-001405.md
```

### Expected Staged Files (8)

```
scripts/project-brain-self-snapshot.cjs
data/project-brain/project-brain.json
data/reports/project-brain/project-brain-20260803-001014.json
data/reports/project-brain/project-brain-20260803-001014.md
data/reports/project-brain/project-brain-20260803-001359.json
data/reports/project-brain/project-brain-20260803-001359.md
data/reports/project-brain/p1-closeout-20260803-001405.json
data/reports/project-brain/p1-closeout-20260803-001405.md
```

### Execute

```bash
git add \
  scripts/project-brain-self-snapshot.cjs \
  data/project-brain/project-brain.json \
  data/reports/project-brain/project-brain-20260803-001014.json \
  data/reports/project-brain/project-brain-20260803-001014.md \
  data/reports/project-brain/project-brain-20260803-001359.json \
  data/reports/project-brain/project-brain-20260803-001359.md \
  data/reports/project-brain/p1-closeout-20260803-001405.json \
  data/reports/project-brain/p1-closeout-20260803-001405.md

git diff --cached --name-only

git commit -m "chore(project-brain): add v0.1 self snapshot and P1 evidence"
```

---

## 9. Commit Step 4 — DiffScopeGuard Core

### Message

```
feat(project-brain): add DiffScopeGuard core, reporter, scenarios, and git adapter
```

### git add Command

```bash
git add \
  src/project-brain/diff-scope-guard.ts \
  src/project-brain/diff-scope-reporter.ts \
  src/project-brain/diff-scope-scenario-runner.ts \
  src/project-brain/git-diff-adapter.ts \
  tests/project-brain/diff-scope-guard.test.ts \
  tests/project-brain/diff-scope-reporter.test.ts \
  tests/project-brain/diff-scope-scenario-runner.test.ts \
  tests/project-brain/git-diff-adapter.test.ts
```

### Expected Staged Files (8)

```
src/project-brain/diff-scope-guard.ts
src/project-brain/diff-scope-reporter.ts
src/project-brain/diff-scope-scenario-runner.ts
src/project-brain/git-diff-adapter.ts
tests/project-brain/diff-scope-guard.test.ts
tests/project-brain/diff-scope-reporter.test.ts
tests/project-brain/diff-scope-scenario-runner.test.ts
tests/project-brain/git-diff-adapter.test.ts
```

### Execute

```bash
git add \
  src/project-brain/diff-scope-guard.ts \
  src/project-brain/diff-scope-reporter.ts \
  src/project-brain/diff-scope-scenario-runner.ts \
  src/project-brain/git-diff-adapter.ts \
  tests/project-brain/diff-scope-guard.test.ts \
  tests/project-brain/diff-scope-reporter.test.ts \
  tests/project-brain/diff-scope-scenario-runner.test.ts \
  tests/project-brain/git-diff-adapter.test.ts

git diff --cached --name-only

git commit -m "feat(project-brain): add DiffScopeGuard core, reporter, scenarios, and git adapter"
```

### ⚠️ Watch Items

- `tests/project-brain/diff-scope-audit-script.test.ts` — **DO NOT stage** (commit 5)

---

## 10. Commit Step 5 — DiffScopeGuard Audit CLI & P2 Evidence

### Message

```
chore(project-brain): add DiffScopeGuard manual audit CLI and P2 evidence
```

### git add Command

```bash
git add \
  scripts/project-brain-diff-scope-audit.cjs \
  tests/project-brain/diff-scope-audit-script.test.ts \
  data/reports/project-brain/p2-closeout-20260803-004600.json \
  data/reports/project-brain/p2-closeout-20260803-004600.md
```

### Expected Staged Files (4)

```
scripts/project-brain-diff-scope-audit.cjs
tests/project-brain/diff-scope-audit-script.test.ts
data/reports/project-brain/p2-closeout-20260803-004600.json
data/reports/project-brain/p2-closeout-20260803-004600.md
```

### Execute

```bash
git add \
  scripts/project-brain-diff-scope-audit.cjs \
  tests/project-brain/diff-scope-audit-script.test.ts \
  data/reports/project-brain/p2-closeout-20260803-004600.json \
  data/reports/project-brain/p2-closeout-20260803-004600.md

git diff --cached --name-only

git commit -m "chore(project-brain): add DiffScopeGuard manual audit CLI and P2 evidence"
```

---

## 11. Commit Step 6 — ArchitectureBaseline Core

### Message

```
feat(project-brain): add ArchitectureBaseline model, builder, and reporter
```

### git add Command

```bash
git add \
  src/project-brain/architecture-baseline.ts \
  src/project-brain/architecture-baseline-builder.ts \
  src/project-brain/architecture-baseline-reporter.ts \
  src/project-brain/index.ts \
  tests/project-brain/architecture-baseline.test.ts \
  tests/project-brain/architecture-baseline-builder.test.ts \
  tests/project-brain/architecture-baseline-reporter.test.ts
```

### Expected Staged Files (7)

```
src/project-brain/architecture-baseline.ts
src/project-brain/architecture-baseline-builder.ts
src/project-brain/architecture-baseline-reporter.ts
src/project-brain/index.ts
tests/project-brain/architecture-baseline.test.ts
tests/project-brain/architecture-baseline-builder.test.ts
tests/project-brain/architecture-baseline-reporter.test.ts
```

### Execute

```bash
git add \
  src/project-brain/architecture-baseline.ts \
  src/project-brain/architecture-baseline-builder.ts \
  src/project-brain/architecture-baseline-reporter.ts \
  src/project-brain/index.ts \
  tests/project-brain/architecture-baseline.test.ts \
  tests/project-brain/architecture-baseline-builder.test.ts \
  tests/project-brain/architecture-baseline-reporter.test.ts

git diff --cached --name-only

git commit -m "feat(project-brain): add ArchitectureBaseline model, builder, and reporter"
```

### ⚠️ Watch Items

- `src/project-brain/index.ts` — **IS included** in this commit (consolidated barrel export)
- `tests/project-brain/architecture-baseline-snapshot-script.test.ts` — **DO NOT stage** (commit 7)

### ⚠️ Note on index.ts

`src/project-brain/index.ts` re-exports from all P1+P2+P3 modules. Since commits are sequential and P1 (commit 2) and P2 (commit 4) source files are already committed, this barrel export will be correct when commit 6 is applied. If TypeScript compilation fails at this commit, add a temporary type assertion — but this should not occur since all dependent modules are already tracked.

---

## 12. Commit Step 7 — ArchitectureBaseline Snapshot CLI & P3 Closeout

### Message

```
chore(project-brain): add ArchitectureBaseline snapshot CLI and P3 closeout
```

### git add Command

```bash
git add \
  scripts/project-brain-architecture-baseline-snapshot.cjs \
  tests/project-brain/architecture-baseline-snapshot-script.test.ts \
  data/reports/project-brain/p3-architecture-baseline-closeout-20260803-012007.json \
  data/reports/project-brain/p3-architecture-baseline-closeout-20260803-012007.md \
  data/reports/project-brain/p3-final-closeout-20260803-013200.json \
  data/reports/project-brain/p3-final-closeout-20260803-013200.md \
  data/reports/project-brain/p3-final-closeout-20260803-014913.json \
  data/reports/project-brain/p3-final-closeout-20260803-014913.md \
  data/reports/project-brain/p4-prep-commit-plan-dry-run-20260803-020200.json \
  data/reports/project-brain/p4-prep-commit-plan-dry-run-20260803-020200.md
```

### Expected Staged Files (10)

```
scripts/project-brain-architecture-baseline-snapshot.cjs
tests/project-brain/architecture-baseline-snapshot-script.test.ts
data/reports/project-brain/p3-architecture-baseline-closeout-20260803-012007.json
data/reports/project-brain/p3-architecture-baseline-closeout-20260803-012007.md
data/reports/project-brain/p3-final-closeout-20260803-013200.json
data/reports/project-brain/p3-final-closeout-20260803-013200.md
data/reports/project-brain/p3-final-closeout-20260803-014913.json
data/reports/project-brain/p3-final-closeout-20260803-014913.md
data/reports/project-brain/p4-prep-commit-plan-dry-run-20260803-020200.json
data/reports/project-brain/p4-prep-commit-plan-dry-run-20260803-020200.md
```

### Execute

```bash
git add \
  scripts/project-brain-architecture-baseline-snapshot.cjs \
  tests/project-brain/architecture-baseline-snapshot-script.test.ts \
  data/reports/project-brain/p3-architecture-baseline-closeout-20260803-012007.json \
  data/reports/project-brain/p3-architecture-baseline-closeout-20260803-012007.md \
  data/reports/project-brain/p3-final-closeout-20260803-013200.json \
  data/reports/project-brain/p3-final-closeout-20260803-013200.md \
  data/reports/project-brain/p3-final-closeout-20260803-014913.json \
  data/reports/project-brain/p3-final-closeout-20260803-014913.md \
  data/reports/project-brain/p4-prep-commit-plan-dry-run-20260803-020200.json \
  data/reports/project-brain/p4-prep-commit-plan-dry-run-20260803-020200.md

git diff --cached --name-only

git commit -m "chore(project-brain): add ArchitectureBaseline snapshot CLI and P3 closeout"
```

### ⚠️ Watch Items

- `data/reports/project-brain/quarantine/**` — **DO NOT stage**
- `data/reports/project-brain/p3-t6r-*` — **DO NOT stage**

---

## 13. Always Exclude

The following must **NEVER** be staged in any of the 7 feature commits:

| Category | Pattern |
|----------|---------|
| PM2 Runtime | `data/heartbeat.json` |
| Sentinel Events | `data/sentinel/**` |
| Runtime Logs | `data/logs/**` |
| Health Reports | `data/reports/health/**` |
| Quarantine | `data/reports/project-brain/quarantine/**` |
| Resolution Evidence | `data/reports/project-brain/p3-t6r-unexpected-files-resolution-*` |
| Vitest Gate Report | `data/reports/project-brain/final-vitest-gate-before-manual-commit-*` |
| This Plan Report | `data/reports/project-brain/manual-commit-execution-plan-*` |
| Tmp Residue | `data/reports/baseline/*.tmp`, `*.tmp` |

### Abort on Detection

If any excluded file appears in `git diff --cached --name-only`:

```bash
git reset HEAD data/heartbeat.json          # example
git reset HEAD data/reports/health/          # example
```

---

## 14. Post-Commit Final Verification

After all 7 commits are applied, run in order:

### 14.1 Type Check

```bash
npx tsc --noEmit
```

Expected: **exit 0, PASS**

### 14.2 Full Test Suite

```bash
npx vitest run
```

Expected: **exit 0, 418/418 tests PASS, 19/19 files PASS**

### 14.3 Defense Health

```bash
node scripts/defense-health-check.cjs
```

Expected: **exit 0, overall PASS, all 4 lines PASS**

### 14.4 Remaining Files Audit

```bash
git status --porcelain
```

Expected: **Only excluded runtime/evidence files remain, or clean. Verify no unexpected untracked files.**

### 14.5 Commit Log

```bash
git log --oneline -n 10
```

Expected top 8 entries:

```
<new> chore(project-brain): add ArchitectureBaseline snapshot CLI and P3 closeout
<new> feat(project-brain): add ArchitectureBaseline model, builder, and reporter
<new> chore(project-brain): add DiffScopeGuard manual audit CLI and P2 evidence
<new> feat(project-brain): add DiffScopeGuard core, reporter, scenarios, and git adapter
<new> chore(project-brain): add v0.1 self snapshot and P1 evidence
<new> feat(project-brain): add v0.1 core and tests
<new> chore(harness-v4): add P0 isolation instrumentation and baseline reports
28dd3ae docs: Harness v3.0 设计白皮书 — 704行完整文档
```

---

## 15. Remaining Files Handling

After all 7 commits, the following files will remain unstaged:

### Runtime (NEVER commit)

| File(s) | Action |
|---------|--------|
| `data/heartbeat.json` | Leave as-is (PM2 manages it) |
| `data/sentinel/**` | Leave as-is (Sentinel manages them) |
| `data/logs/**` | Leave as-is (runtime output) |
| `data/reports/health/**` | Review — may optionally commit select snapshots separately |

### Audit Evidence (separate review)

| File(s) | Action |
|---------|--------|
| `data/reports/project-brain/quarantine/**` | Separate review — do not mix with feature commits |
| `data/reports/project-brain/p3-t6r-*` | Separate review evidence |
| `data/reports/project-brain/final-vitest-gate-*` | Pre-commit audit evidence |
| `data/reports/project-brain/manual-commit-execution-plan-*` | This plan — audit evidence |

### Tmp Residue (delete)

| File(s) | Action |
|---------|--------|
| `data/reports/baseline/baseline-20260802-225626.md.tmp` | Delete (`rm`) — should have been done pre-flight |

---

## 16. Final Decision

### 🟢 PLAN_READY

| # | Gate | Status |
|---|------|--------|
| 1 | P4-Prep report available | ✅ |
| 2 | Final Vitest Gate ALLOW | ✅ (418/418 PASS) |
| 3 | 7 commit steps defined | ✅ |
| 4 | Exact `git add` commands per step | ✅ |
| 5 | Expected staged files per step | ✅ |
| 6 | `git diff --cached` check per step | ✅ |
| 7 | Exclude list complete | ✅ |
| 8 | Abort rules defined | ✅ |
| 9 | Post-commit verification defined | ✅ |
| 10 | No `git add .` anywhere | ✅ |
| 11 | `index.ts` assignment clear | ✅ (commit 6) |
| 12 | No duplicate assignments | ✅ |

**This report contains NO executable git commands.** All commands are for manual copy-paste execution only. The person executing these commands must verify each step individually.

---

## 17. Commit Summary Table

| # | Phase | Files | Message |
|---|-------|-------|---------|
| 1 | P0 | 20 | `chore(harness-v4): add P0 isolation instrumentation and baseline reports` |
| 2 | P1 Core | 10 | `feat(project-brain): add v0.1 core and tests` |
| 3 | P1 Evidence | 8 | `chore(project-brain): add v0.1 self snapshot and P1 evidence` |
| 4 | P2 Core | 8 | `feat(project-brain): add DiffScopeGuard core, reporter, scenarios, and git adapter` |
| 5 | P2 Evidence | 4 | `chore(project-brain): add DiffScopeGuard manual audit CLI and P2 evidence` |
| 6 | P3 Core | 7 | `feat(project-brain): add ArchitectureBaseline model, builder, and reporter` |
| 7 | P3 Evidence | 10 | `chore(project-brain): add ArchitectureBaseline snapshot CLI and P3 closeout` |
| **Total** | — | **67** | — |

---

*Manual Commit Execution Plan — generated 2026-08-02T18:19:00Z*
*This is a plan only. No git commands were executed during generation.*

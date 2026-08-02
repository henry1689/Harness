# Evidence and Cleanup Disposition Plan

## 1. Summary

| Metric | Value |
|---|---|
| Decision | **🟢 DISPOSITION_PLAN_READY** |
| Branch | `feature/harness-v4-project-brain` |
| HEAD | `513acc4` |
| Commits | 7 (P0→P3) ✅ |
| Recommended Next Commits | 2-4 (evidence + .gitignore + optional quarantine/health) |
| Residuals Classified | 219 files, 5 categories, 0 unclassified |
| Forbidden/Unexpected | 0 / 0 ✅ |
| Push Sequence | **Option B recommended** (evidence + .gitignore before push) |

> 🟢 **DISPOSITION_PLAN_READY.** 所有剩余文件处置策略已制定。建议 2 个增量提交后 push，确保干净的 PR。

---

## 2. Branch and HEAD

| Field | Value |
|---|---|
| Current Branch | `feature/harness-v4-project-brain` |
| HEAD | `513acc41e16f452273b0a03f74cea88107957a32` |

---

## 3. Recent Commits

```
513acc4 chore(project-brain): add ArchitectureBaseline snapshot CLI and P3 closeout     (10 files)
7c86e56 feat(project-brain): add ArchitectureBaseline model, builder, and reporter       (7 files)
fec6420 chore(project-brain): add DiffScopeGuard manual audit CLI and P2 evidence         (4 files)
a0c58de feat(project-brain): add DiffScopeGuard core, reporter, scenarios, and git adapter (8 files)
9312061 chore(project-brain): add v0.1 self snapshot and P1 evidence                       (8 files)
08ec6b5 feat(project-brain): add v0.1 core and tests                                      (10 files)
0b049db chore(harness-v4): add P0 isolation instrumentation and baseline reports          (20 files)
28dd3ae docs: Harness v3.0 设计白皮书 (base)
```

**Committed Total: 7 commits, 67 files.**

---

## 4. Git Status

| Field | Value |
|---|---|
| Dirty | true |
| Porcelain Entries | 27 |
| Modified Tracked | 1 (`data/heartbeat.json` — PM2 runtime) |
| Untracked | 26 entries (~218 individual files) |
| Forbidden/Core in Residuals | 0 ✅ |
| Unexpected in Residuals | 0 ✅ |

### Current `git status --porcelain` (top-level)

```
 M data/heartbeat.json                                          ← runtime (modified)
?? data/logs/                                                    ← runtime (4 files)
?? data/reports/health/                                          ← health (58 files)
?? data/reports/project-brain/final-vitest-gate-*               ← audit evidence (2)
?? data/reports/project-brain/manual-commit-execution-plan-*    ← audit evidence (2)
?? data/reports/project-brain/post-commit-residual-file-review-* ← audit evidence (2)
?? data/reports/project-brain/evidence-cleanup-disposition-plan-* ← audit evidence (2)
?? data/reports/project-brain/p3-t6r-*                          ← quarantine (2)
?? data/reports/project-brain/quarantine/                       ← quarantine (2)
?? data/sentinel/2026-08-02/*                                   ← runtime (146 files)
```

---

## 5. Recommended Evidence Commit

### Rationale

These 8 files form the complete pre/post-commit governance audit trail for the P0-P3 implementation. Combined with the already-committed P4-Prep report (2 files in commit `513acc4`), they provide a verifiable record that:

- **Final Vitest Gate**: 418/418 tests passed immediately before commit execution
- **Manual Commit Execution Plan**: exact `git add` commands, expected staged files, and 7-commit sequence
- **Post-Commit Residual Review**: classification of all residual files, confirmation of zero forbidden/unexpected
- **Evidence & Cleanup Disposition Plan**: this plan — final disposition of all residuals

### Commit 8: Audit Evidence

**Message:**
```
chore(project-brain): add P4 prep and manual commit audit evidence
```

**Include (8 files):**

```
data/reports/project-brain/final-vitest-gate-before-manual-commit-20260803-021200.json
data/reports/project-brain/final-vitest-gate-before-manual-commit-20260803-021200.md
data/reports/project-brain/manual-commit-execution-plan-20260803-021900.json
data/reports/project-brain/manual-commit-execution-plan-20260803-021900.md
data/reports/project-brain/post-commit-residual-file-review-20260803-023500.json
data/reports/project-brain/post-commit-residual-file-review-20260803-023500.md
data/reports/project-brain/evidence-cleanup-disposition-plan-20260803-024000.json
data/reports/project-brain/evidence-cleanup-disposition-plan-20260803-024000.md
```

**Already Committed (in commit 7, `513acc4`):**

```
data/reports/project-brain/p4-prep-commit-plan-dry-run-20260803-020200.json   ✅ committed
data/reports/project-brain/p4-prep-commit-plan-dry-run-20260803-020200.md     ✅ committed
```

**Total Audit Trail: 10 files across 2 commits.**

**Execution:**
```bash
git add \
  data/reports/project-brain/final-vitest-gate-before-manual-commit-20260803-021200.json \
  data/reports/project-brain/final-vitest-gate-before-manual-commit-20260803-021200.md \
  data/reports/project-brain/manual-commit-execution-plan-20260803-021900.json \
  data/reports/project-brain/manual-commit-execution-plan-20260803-021900.md \
  data/reports/project-brain/post-commit-residual-file-review-20260803-023500.json \
  data/reports/project-brain/post-commit-residual-file-review-20260803-023500.md \
  data/reports/project-brain/evidence-cleanup-disposition-plan-20260803-024000.json \
  data/reports/project-brain/evidence-cleanup-disposition-plan-20260803-024000.md

git diff --cached --name-only
git commit -m "chore(project-brain): add P4 prep and manual commit audit evidence"
```

### Decision

🟢 **RECOMMENDED.** This preserves the governance audit trail in version control. Skip only if audit trail is not needed.

---

## 6. Quarantine Evidence Hold

### Files (4)

```
data/reports/project-brain/quarantine/unexpected-files-20260803-014722/HARNESS-V4-UPGRADE-WHITEPAPER.md.md
data/reports/project-brain/quarantine/unexpected-files-20260803-014722/e2e-result.txt
data/reports/project-brain/p3-t6r-unexpected-files-resolution-20260803-014913.json
data/reports/project-brain/p3-t6r-unexpected-files-resolution-20260803-014913.md
```

### Recommendation

🟡 **DO NOT COMMIT NOW — HOLD for separate review.**

| Option | Action |
|--------|--------|
| A | Do not commit. Keep locally. Discard after review. |
| B | Commit as separate evidence commit after explicit approval. |

**Default: Option A.** Quarantine documents an internal quality process (P3-T6R NO_GO→CONDITIONAL_GO). It is not functional code. If the audit trail should include the quarantine event, Option B can be executed after explicit approval.

**If Option B is chosen, commit message:**
```
chore(project-brain): add P3-T6R quarantine and resolution evidence
```

---

## 7. Health Reports Hold

### Files (58 — 29 .json/.md pairs)

```
data/reports/health/health-20260802-*.{json,md}  (18 pairs — P0 baseline → P3 development)
data/reports/health/health-20260803-*.{json,md}  (11 pairs — P3 closeout → post-commit)
```

### Recommendation

🟡 **DO NOT COMMIT NOW. No representative pair selected.**

| Action | Details |
|--------|---------|
| **Do not batch commit all 58 files** | They are auto-generated noise |
| **Optional: commit 1 representative pair** | Latest: `health-20260803-022857` (post-commit verification, all 4 lines PASS) |
| **Then: add to .gitignore** | Prevents future accumulation |

**If representative pair is selected:**
```bash
git add \
  data/reports/health/health-20260803-022857.json \
  data/reports/health/health-20260803-022857.md
git commit -m "chore(harness-v4): add final defense health evidence"
```

---

## 8. Never Commit Runtime

### Files (151)

| Path | Count | Source |
|------|:-----:|--------|
| `data/heartbeat.json` | 1 | PM2 runtime (~30s interval) — **modified tracked file** |
| `data/logs/` | 4 | mcp-error.log, mcp-out.log, sentinel-error.log, sentinel-out.log |
| `data/sentinel/2026-08-02/` | 146 | Sentinel filesystem watcher events |

### Recommendation

🔴 **NEVER COMMIT.** Add to `.gitignore` immediately. Optionally clean locally.

These are transient runtime artifacts. They have zero audit value in version control and would pollute `git status` and PR diffs.

---

## 9. Suggested .gitignore Additions

> ⚠️ **This task does NOT modify `.gitignore`.** Listed as planning recommendation only.

Suggested new rules to append to `.gitignore`:

```gitignore
# Harness v4 runtime state
data/heartbeat.json
data/logs/
data/sentinel/

# Auto-generated health reports (keep representative snapshots only)
data/reports/health/

# Atomic write residues
*.tmp
```

### What is NOT added to .gitignore

| Path | Reason |
|------|--------|
| `data/reports/project-brain/quarantine/` | May be intentionally reviewed/committed |
| `data/reports/project-brain/p3-t6r-*` | May be intentionally committed as evidence |
| `data/reports/project-brain/final-vitest-gate-*` | Audit evidence — recommended for commit |
| `data/reports/project-brain/manual-commit-execution-plan-*` | Audit evidence — recommended for commit |
| `data/reports/project-brain/post-commit-*` | Audit evidence — recommended for commit |
| `data/reports/project-brain/evidence-cleanup-*` | Audit evidence — recommended for commit |

---

## 10. Suggested Cleanup Commit

### Commit 9: .gitignore Cleanup

**Message:**
```
chore(harness-v4): ignore runtime-generated state and health reports
```

**Include:**
```
.gitignore  (with the 4 rule blocks from Section 9)
```

**Execution:**
```bash
# After manually editing .gitignore to add the suggested rules:
git add .gitignore
git diff --cached
git commit -m "chore(harness-v4): ignore runtime-generated state and health reports"
```

### Post-Cleanup Verification

After `.gitignore` commit, `git status` should no longer show:

```
data/heartbeat.json
data/logs/
data/sentinel/
data/reports/health/
```

Remaining visible in `git status`:
- Evidence files (if not yet committed as commit 8)
- Quarantine files (if not yet committed or deleted)

---

## 11. Push Sequence Recommendation

### Option A: Push Now

```
1. Confirm: git log --oneline -n 10 (7 commits visible)
2. Confirm: residuals classified, 0 forbidden, 0 unexpected
3. git push origin feature/harness-v4-project-brain
```

- ✅ Fastest path
- ❌ 8 audit evidence files uncommitted
- ❌ .gitignore not updated → runtime noise in future status checks

### Option B: Evidence + Cleanup Before Push (RECOMMENDED 🟢)

```
Step 1  → Evidence Commit (commit 8, 8 audit files)
Step 2  → .gitignore Commit (commit 9, .gitignore only)
Step 3  → [Optional] Quarantine Commit (commit 10, 4 files)
Step 4  → [Optional] Health Representative Commit (commit 11, 2 files)
Step 5  → [Optional] git clean runtime residuals
Step 6  → Final Verification:
            npx tsc --noEmit
            npx vitest run
            node scripts/defense-health-check.cjs
            git status --porcelain
Step 7  → git push origin feature/harness-v4-project-brain
```

- ✅ Clean PR with no noise
- ✅ Complete audit trail
- ✅ .gitignore prevents future pollution
- ✅ Professional commit history (9-11 commits, chronological)

### Recommended: 🟢 **Option B**

Steps 1-2 are the minimum. Steps 3-4 are optional and depend on audit requirements.

### Minimum Push Sequence (Steps 1-2 only)

```
Commit 8: audit evidence (8 files) → git log shows 8 commits
Commit 9: .gitignore (1 file)      → git log shows 9 commits
                                        → git status nearly clean
                                        → PUSH
```

### Full Push Sequence (Steps 1-4)

```
Commit 8:  audit evidence     (8 files)
Commit 9:  .gitignore         (1 file)
Commit 10: quarantine evidence (4 files) [optional]
Commit 11: health evidence    (2 files) [optional]
                                        → git status clean
                                        → PUSH
```

---

## 12. Forbidden/Core Residuals

### Status: **CLEAN ✅**

All 13 protected areas verified absent from residual list:

`src/FlowEngine.ts`, `src/StageRunner.ts`, `src/GateController.ts`, `src/ComplianceScorer.ts`, `src/EvolutionEngine.ts`, `mcp/`, `sentinel/`, `data/flows/`, `data/tokens/`, `data/audit/`, `ecosystem.config.cjs`, `package.json`, `tsconfig.json`

**Forbidden/Core Residuals: 0** ✅

---

## 13. Unexpected Residuals

### Status: **CLEAN ✅**

All 219 residual files classified into 5 well-defined categories. Zero unclassified, zero unexpected.

**Unexpected Residuals: 0** ✅

---

## 14. Final Decision

### 🟢 DISPOSITION_PLAN_READY

| # | Gate | Status |
|---|------|--------|
| 1 | All residual files classified | ✅ 219 files, 5 categories |
| 2 | Forbidden/core residuals = 0 | ✅ |
| 3 | Unexpected residuals = 0 | ✅ |
| 4 | Evidence commit list generated | ✅ 8 files |
| 5 | Quarantine disposition decided | ✅ HOLD |
| 6 | Health disposition decided | ✅ HOLD |
| 7 | .gitignore suggestions generated | ✅ 4 rules |
| 8 | Push sequence generated | ✅ Option B recommended |

**Reasoning:** All residuals are fully classified with clear disposition for each category. Two recommended commits (evidence + .gitignore) will produce a clean, professional push. Branch is technically pushable now (Option A), but Option B is strongly recommended for PR hygiene.

---

## 15. Generated Files

| File | Path |
|------|------|
| Disposition Plan JSON | `data/reports/project-brain/evidence-cleanup-disposition-plan-20260803-024000.json` |
| Disposition Plan MD | `data/reports/project-brain/evidence-cleanup-disposition-plan-20260803-024000.md` |

---

*Evidence and Cleanup Disposition Plan — DISPOSITION_PLAN_READY*
*Generated: 2026-08-02T18:40:00Z*

---

```
P0-P3 COMPLETE ✅  |  7 commits  |  67 files  |  418 tests
tsc PASS  |  vitest 418/418 PASS  |  4/4 defense PASS
0 forbidden  |  0 unexpected  |  0 unclassified  |  SAFE TO PUSH 🟢
```

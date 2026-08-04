# Release Checklist

This checklist defines the required validation steps before releasing Harness.

## 1. Branch and Working Tree

- [ ] Release work is based on the latest `main`.
- [ ] Local `main` is synchronized with `origin/main`.
- [ ] Working tree is clean before creating the release branch.
- [ ] Release branch uses a clear name, for example:
  - `release/vX.Y.Z`
  - `p5/release-checklist`

Recommended commands:

```bash
git switch main
git pull --ff-only origin main
git status
```

## 2. Local Validation

Run the full local validation suite before opening a release PR.

```bash
npm run typecheck
npm test
npm run harness:integrity
```

Expected result:

- [ ] TypeScript typecheck passes.
- [ ] Test suite passes.
- [ ] Harness integrity check reports `OK`.

## 3. CI Gate

The GitHub Actions validation workflow must pass before merge.

Required CI jobs:

- [ ] Install dependencies with `npm ci`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Run `npm run harness:integrity`.

Recommended command:

```bash
gh pr checks <PR_NUMBER>
```

## 4. Integrity Manifest

Before release, verify that the integrity manifest and runtime check remain consistent.

- [ ] `scripts/harness-integrity-check.cjs` is present.
- [ ] Integrity hash normalization is active for cross-platform line endings.
- [ ] `npm run harness:integrity` passes on the release branch.
- [ ] Any intentional manifest update is reviewed explicitly.

Do not bypass integrity failures without root-cause analysis.

## 5. Line Ending Policy

Verify repository line ending policy is in place.

- [ ] `.gitattributes` exists.
- [ ] Text files are normalized to LF.
- [ ] Windows batch/cmd scripts are allowed to use CRLF where required.
- [ ] Common binary files are marked as binary.
- [ ] No mass unintended line-ending-only diff is included in the release PR.

## 6. Runtime Hardening

Confirm runtime hardening controls are preserved.

- [ ] Tool whitelist enforcement remains active.
- [ ] Runtime guard behavior is covered by tests.
- [ ] Security-sensitive paths are not weakened.
- [ ] Failure modes remain explicit and auditable.

Relevant validation:

```bash
npm test
```

## 7. DiffScopeGuard

Confirm DiffScopeGuard-related behavior remains intact.

- [ ] DiffScopeGuard tests pass.
- [ ] Git diff adapter tests pass.
- [ ] Scenario runner tests pass.
- [ ] Reporter tests pass.
- [ ] No release change broadens allowed diff scope unintentionally.

Relevant validation:

```bash
npm test -- --run tests/project-brain/diff-scope-guard.test.ts
npm test -- --run tests/project-brain/git-diff-adapter.test.ts
npm test -- --run tests/project-brain/diff-scope-scenario-runner.test.ts
```

## 8. Token and Security Checks

Confirm token and security utilities remain valid.

- [ ] HMAC token tests pass.
- [ ] Token canonicalization tests pass.
- [ ] Token store tests pass.
- [ ] No secret, token, or local credential file is committed.

Relevant validation:

```bash
npm test -- --run tests/security
```

## 9. Generated Files and Local Artifacts

Before merge or tagging, ensure local generated files are not accidentally committed.

Check:

```bash
git status
```

Common generated paths to review:

- `data/audit/`
- `data/reports/`
- `data/mcp-watchdog/watchdog_*.json`
- temporary logs
- local environment files

If required, clean untracked generated files carefully:

```bash
git clean -fd -- data/audit/
git clean -fd -- data/reports/
```

Review before deleting any file.

## 10. Release Notes

Release notes should summarize:

- [ ] User-visible changes.
- [ ] CI or validation changes.
- [ ] Security or runtime hardening changes.
- [ ] Integrity manifest changes.
- [ ] Migration or compatibility notes.
- [ ] Known limitations.

## 11. Tagging

After the release PR is merged and `main` is synchronized:

```bash
git switch main
git pull --ff-only origin main
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

Before tagging:

- [ ] `main` is clean.
- [ ] `main` matches `origin/main`.
- [ ] CI is green on the merged release commit.
- [ ] Release notes are ready.

## 12. Rollback Plan

If a release issue is detected:

- [ ] Identify the faulty release commit or tag.
- [ ] Prefer a forward-fix PR for non-critical issues.
- [ ] Revert the merge commit for critical regressions.
- [ ] Re-run full validation after revert.
- [ ] Publish rollback notes if a tag or external release was already created.

Example revert:

```bash
git switch main
git pull --ff-only origin main
git revert -m 1 <merge_commit_sha>
npm run typecheck
npm test
npm run harness:integrity
```

## 13. Final Release Approval

A release is ready only when:

- [ ] Local validation passes.
- [ ] CI validation passes.
- [ ] Integrity check passes.
- [ ] Working tree is clean.
- [ ] Release notes are complete.
- [ ] Rollback plan is understood.

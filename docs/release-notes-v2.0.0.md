# Harness v2.0.0 Release Notes

## Summary

Harness v2.0.0 focuses on runtime hardening, integrity portability, CI gate enforcement, and release readiness documentation.

This release candidate is based on the validated P6 baseline recorded in `docs/release-candidate.md`.

## Highlights

- Runtime hardening completed.
- DiffScopeGuard enforcement integrated.
- Integrity portability improved with LF-normalized integrity hashing.
- CI validation gates added for typecheck, tests, and harness integrity.
- Repository line ending policy standardized.
- Release checklist and release candidate validation records added.
- Generated runtime artifacts excluded from version control.

## Runtime Hardening

This release includes the P4 runtime hardening work, including enforcement paths around guarded diff scope behavior and integrity validation.

## Integrity Portability

Integrity hashing is normalized for line endings to avoid platform-specific drift between Windows and Unix-like environments.

Key behavior:

- Text content is normalized to LF before integrity hashing.
- `.gitattributes` enforces LF-oriented repository policy.
- `npm run harness:integrity` validates harness integrity consistency.

## CI Validation

The release readiness workflow includes CI validation for:

| Check | Command |
| --- | --- |
| TypeScript typecheck | `npm run typecheck` |
| Unit tests | `npm test` |
| Harness integrity | `npm run harness:integrity` |

The P6 release candidate baseline passed all required checks.

## Documentation

This release includes:

- `docs/release-checklist.md`
- `docs/release-candidate.md`
- `docs/release-notes-v2.0.0.md`

## Generated Artifacts

Generated runtime artifacts are ignored to keep the repository clean:

- `data/reports/`
- `data/mcp-watchdog/watchdog_*.json`

## Breaking Changes

None currently identified.

## Validation Matrix

| Area | Status |
| --- | --- |
| TypeScript typecheck | PASS |
| Unit tests | PASS |
| Harness integrity | PASS |
| CI/Validate | PASS |
| Working tree cleanliness | PASS |

## Operator Notes

Before publishing or tagging the release, run:

```bash
npm run typecheck
npm test
npm run harness:integrity

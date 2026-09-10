import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const core = require('../../scripts/owner-closure-core.cjs');

const HEAD = 'c436cb02b2c503a4e91a58861e903a4559dc4dc6';
const SECRET = 'owner-closure-test-secret-32-bytes-minimum';
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owner-closure-'));
  roots.push(root);
  const projectRoot = join(root, 'project');
  const recordDir = join(root, 'records');
  const auditDir = join(root, 'audit');
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  const file = join(projectRoot, 'src', 'a.ts');
  writeFileSync(file, 'export const a = 1;\n');
  const sha256 = createHash('sha256').update('export const a = 1;\n').digest('hex');
  const manifest = {
    approval_ref: 'owner-direct-2026-08-31',
    reason: 'G1-A3f1-R2 owner-adopted closure',
    branch: 'feat/40d-perception',
    head: HEAD,
    files: [{ path: 'src/a.ts', sha256 }],
    allowed_blocking_rules: [...core.ALLOWED_BLOCKING_RULES],
  };
  let now = Date.parse('2026-08-31T12:00:00+08:00');
  const options = {
    recordDir,
    auditDir,
    now: () => now,
    verifyPassword: (password: string) => password === 'correct',
    getSignKey: () => SECRET,
    gitValue: (_root: string, args: string[]) => args[0] === 'branch' ? manifest.branch : HEAD,
  };
  return { root, projectRoot, file, manifest, options, advance: (ms: number) => { now += ms; } };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('owner-closure-core', () => {
  it('requires the owner password and the exact five-rule set', () => {
    const f = fixture();
    expect(() => core.issueOwnerClosure({
      manifest: f.manifest,
      password: 'wrong',
      projectRoot: f.projectRoot,
    }, f.options)).toThrow('OWNER_CLOSURE_PASSWORD_DENIED');

    expect(() => core.normalizeManifest({
      ...f.manifest,
      allowed_blocking_rules: ['DOC_SYNC_REQUIRED'],
    })).toThrow('OWNER_CLOSURE_RULE_SET_NOT_EXACT');
  });

  it('binds branch/HEAD/files/hash and is single-use', () => {
    const f = fixture();
    const issued = core.issueOwnerClosure({
      manifest: f.manifest,
      password: 'correct',
      projectRoot: f.projectRoot,
      minutes: 15,
    }, f.options);

    const claim = core.claimOwnerClosure({
      closureId: issued.closure_id,
      projectRoot: f.projectRoot,
      files: ['src/a.ts'],
    }, f.options);
    expect(claim.verified).toBe(true);
    expect(claim.allowed_blocking_rules.sort()).toEqual([...core.ALLOWED_BLOCKING_RULES].sort());

    expect(() => core.claimOwnerClosure({
      closureId: issued.closure_id,
      projectRoot: f.projectRoot,
      files: ['src/a.ts'],
    }, f.options)).toThrow('OWNER_CLOSURE_NOT_ISSUED');

    core.authorizeOwnerClosureToken({
      closureId: issued.closure_id,
      attemptId: claim.attempt_id,
      runId: 'run_owner_closure',
      flowSuccess: true,
      flowStatus: 'completed',
      endReason: 'completed',
    }, f.options);
    const completed = core.finishOwnerClosure({
      closureId: issued.closure_id,
      attemptId: claim.attempt_id,
      runId: 'run_owner_closure',
      success: true,
      tokenIssued: true,
    }, f.options);
    expect(completed.status).toBe('completed');
    expect(completed.token_issued).toBe(true);
  });

  it('rejects file hash drift before claim', () => {
    const f = fixture();
    const issued = core.issueOwnerClosure({
      manifest: f.manifest,
      password: 'correct',
      projectRoot: f.projectRoot,
    }, f.options);
    writeFileSync(f.file, 'export const a = 2;\n');
    expect(() => core.claimOwnerClosure({
      closureId: issued.closure_id,
      projectRoot: f.projectRoot,
      files: ['src/a.ts'],
    }, f.options)).toThrow('OWNER_CLOSURE_HASH_DRIFT');
  });

  it('rejects expiry, file-set mismatch and a tampered signed record', () => {
    const expired = fixture();
    const expiredRecord = core.issueOwnerClosure({
      manifest: expired.manifest,
      password: 'correct',
      projectRoot: expired.projectRoot,
      minutes: 1,
    }, expired.options);
    expired.advance(60_001);
    expect(() => core.claimOwnerClosure({
      closureId: expiredRecord.closure_id,
      projectRoot: expired.projectRoot,
      files: ['src/a.ts'],
    }, expired.options)).toThrow('OWNER_CLOSURE_EXPIRED');

    const mismatch = fixture();
    const mismatchRecord = core.issueOwnerClosure({
      manifest: mismatch.manifest,
      password: 'correct',
      projectRoot: mismatch.projectRoot,
    }, mismatch.options);
    expect(() => core.claimOwnerClosure({
      closureId: mismatchRecord.closure_id,
      projectRoot: mismatch.projectRoot,
      files: ['src/other.ts'],
    }, mismatch.options)).toThrow('OWNER_CLOSURE_FILE_SET_MISMATCH');

    const tampered = fixture();
    const tamperedRecord = core.issueOwnerClosure({
      manifest: tampered.manifest,
      password: 'correct',
      projectRoot: tampered.projectRoot,
    }, tampered.options);
    const recordPath = join(tampered.options.recordDir, `${tamperedRecord.closure_id}.json`);
    const raw = JSON.parse(readFileSync(recordPath, 'utf8'));
    raw.reason = 'tampered';
    writeFileSync(recordPath, JSON.stringify(raw, null, 2));
    expect(() => core.claimOwnerClosure({
      closureId: tamperedRecord.closure_id,
      projectRoot: tampered.projectRoot,
      files: ['src/a.ts'],
    }, tampered.options)).toThrow('OWNER_CLOSURE_SIGNATURE_INVALID');
  });

  it('does not authorize token entry for an aborted flow', () => {
    const f = fixture();
    const issued = core.issueOwnerClosure({
      manifest: f.manifest,
      password: 'correct',
      projectRoot: f.projectRoot,
    }, f.options);
    const claim = core.claimOwnerClosure({
      closureId: issued.closure_id,
      projectRoot: f.projectRoot,
      files: ['src/a.ts'],
    }, f.options);
    expect(() => core.authorizeOwnerClosureToken({
      closureId: issued.closure_id,
      attemptId: claim.attempt_id,
      runId: 'run_aborted',
      flowSuccess: false,
      flowStatus: 'aborted',
      endReason: 'retry_limit',
    }, f.options)).toThrow('OWNER_CLOSURE_FLOW_NOT_COMPLETED');
  });
});

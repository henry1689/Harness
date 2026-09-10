#!/usr/bin/env node
/**
 * owner-closure-core.cjs — password-gated owner-adopted baseline closure.
 *
 * This is deliberately narrower than exemptions:
 * - authorization is bound to branch, HEAD, exact file set and SHA-256 values;
 * - only the five reviewed A3f1 structural rule IDs are eligible;
 * - a record is signed, short-lived and single-use;
 * - claim/finish events are independently audited;
 * - no token is issued here. The normal pipeline terminal policy remains the
 *   only token issuer.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const passCore = require('./pass-core.cjs');

const HARNESS_DIR = path.resolve(__dirname, '..');
const DEFAULT_RECORD_DIR = path.join(HARNESS_DIR, 'data', 'owner-closures');
const DEFAULT_AUDIT_DIR = path.join(HARNESS_DIR, 'data', 'audit', 'owner-closures');
const MAX_TTL_MINUTES = 30;
const ALLOWED_BLOCKING_RULES = Object.freeze([
  'DOC_SYNC_REQUIRED',
  'STATIC_QUALITY_GATE',
  'ROBUSTNESS_CORE_REQUIRED',
  'HOOK_REQUIRED',
  'HOOK_SIX_STAGE_HEALTH',
]);

function normalizeRelativePath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) {
    throw new Error(`OWNER_CLOSURE_PATH_INVALID: ${normalized || '<empty>'}`);
  }
  const segments = normalized.split('/');
  if (segments.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`OWNER_CLOSURE_PATH_INVALID: ${normalized}`);
  }
  return normalized;
}

function normalizeSha256(value) {
  const sha = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('OWNER_CLOSURE_SHA256_INVALID');
  return sha;
}

function normalizeRules(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('OWNER_CLOSURE_RULES_MISSING');
  const rules = value.map(v => String(v || '').trim()).filter(Boolean);
  if (new Set(rules).size !== rules.length) throw new Error('OWNER_CLOSURE_RULES_DUPLICATED');
  const unknown = rules.filter(rule => !ALLOWED_BLOCKING_RULES.includes(rule));
  if (unknown.length) throw new Error(`OWNER_CLOSURE_RULE_NOT_ALLOWED: ${unknown.join(',')}`);
  const expected = [...ALLOWED_BLOCKING_RULES].sort();
  const actual = [...rules].sort();
  if (actual.length !== expected.length || actual.some((rule, i) => rule !== expected[i])) {
    throw new Error('OWNER_CLOSURE_RULE_SET_NOT_EXACT');
  }
  return actual;
}

function normalizeFiles(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error('OWNER_CLOSURE_FILES_INVALID');
  }
  const files = value.map(item => ({
    path: normalizeRelativePath(item && item.path),
    sha256: normalizeSha256(item && item.sha256),
  }));
  if (new Set(files.map(item => item.path)).size !== files.length) {
    throw new Error('OWNER_CLOSURE_FILES_DUPLICATED');
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('OWNER_CLOSURE_MANIFEST_INVALID');
  const approvalRef = String(raw.approval_ref || '').trim();
  const reason = String(raw.reason || '').trim();
  const branch = String(raw.branch || '').trim();
  const head = String(raw.head || '').trim().toLowerCase();
  if (!approvalRef || !reason || !branch || !/^[a-f0-9]{40}$/.test(head)) {
    throw new Error('OWNER_CLOSURE_MANIFEST_FIELDS_INVALID');
  }
  return {
    version: 1,
    approval_ref: approvalRef,
    reason,
    branch,
    head,
    files: normalizeFiles(raw.files),
    allowed_blocking_rules: normalizeRules(raw.allowed_blocking_rules),
  };
}

function recordPayload(record) {
  const copy = { ...record };
  delete copy.signature;
  return copy;
}

function signRecord(record, key) {
  if (!key || Buffer.byteLength(String(key), 'utf8') < 32) throw new Error('OWNER_CLOSURE_SECRET_MISSING');
  return crypto.createHmac('sha256', key)
    .update(passCore.stableStringify(recordPayload(record)))
    .digest('hex');
}

function verifyRecordSignature(record, key) {
  const expected = signRecord(record, key);
  const actual = String(record && record.signature || '');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function gitValue(projectRoot, args) {
  const result = spawnSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`OWNER_CLOSURE_GIT_FAILED: ${(result.stderr || '').trim()}`);
  return String(result.stdout || '').trim();
}

function verifyBaseline(manifest, projectRoot, deps = {}) {
  const git = deps.gitValue || gitValue;
  const hash = deps.sha256File || sha256File;
  const branch = git(projectRoot, ['branch', '--show-current']);
  const head = git(projectRoot, ['rev-parse', 'HEAD']).toLowerCase();
  if (branch !== manifest.branch) throw new Error(`OWNER_CLOSURE_BRANCH_DRIFT: ${branch}`);
  if (head !== manifest.head) throw new Error(`OWNER_CLOSURE_HEAD_DRIFT: ${head}`);
  for (const item of manifest.files) {
    const absolute = path.resolve(projectRoot, item.path);
    const root = path.resolve(projectRoot);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error('OWNER_CLOSURE_PATH_ESCAPE');
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`OWNER_CLOSURE_FILE_MISSING: ${item.path}`);
    }
    const current = hash(absolute).toLowerCase();
    if (current !== item.sha256) throw new Error(`OWNER_CLOSURE_HASH_DRIFT: ${item.path}`);
  }
  return { branch, head };
}

function dirs(options = {}) {
  return {
    recordDir: options.recordDir || DEFAULT_RECORD_DIR,
    auditDir: options.auditDir || DEFAULT_AUDIT_DIR,
  };
}

function atomicWriteJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temp, target);
}

function writeAudit(event, record, extra, options = {}) {
  const { auditDir } = dirs(options);
  const entry = {
    timestamp: new Date((options.now || Date.now)()).toISOString(),
    event,
    closure_id: record.closure_id,
    approval_ref: record.approval_ref,
    status: record.status,
    files: record.files,
    allowed_blocking_rules: record.allowed_blocking_rules,
    ...extra,
  };
  fs.mkdirSync(auditDir, { recursive: true });
  atomicWriteJson(path.join(auditDir, `${event.toLowerCase()}_${Date.now()}_${record.closure_id}.json`), entry);
}

function loadRecord(closureId, options = {}) {
  const id = String(closureId || '').trim();
  if (!/^oc_[a-f0-9]{16}$/.test(id)) throw new Error('OWNER_CLOSURE_ID_INVALID');
  const { recordDir } = dirs(options);
  const file = path.join(recordDir, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error('OWNER_CLOSURE_NOT_FOUND');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = (options.getSignKey || passCore.getSignKey)();
  if (!verifyRecordSignature(record, key)) throw new Error('OWNER_CLOSURE_SIGNATURE_INVALID');
  return { record, file };
}

function issueOwnerClosure(input, options = {}) {
  const verifyPassword = options.verifyPassword || passCore.verifyPassword;
  if (!verifyPassword(String(input && input.password || ''))) throw new Error('OWNER_CLOSURE_PASSWORD_DENIED');
  const manifest = normalizeManifest(input && input.manifest);
  const projectRoot = path.resolve(String(input && input.projectRoot || ''));
  if (!projectRoot || !fs.existsSync(projectRoot)) throw new Error('OWNER_CLOSURE_PROJECT_INVALID');
  verifyBaseline(manifest, projectRoot, options);

  const minutes = Number(input && input.minutes || 15);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_TTL_MINUTES) {
    throw new Error('OWNER_CLOSURE_TTL_INVALID');
  }
  const now = (options.now || Date.now)();
  const record = {
    ...manifest,
    closure_id: `oc_${crypto.randomBytes(8).toString('hex')}`,
    project_root: projectRoot.replace(/\\/g, '/'),
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + minutes * 60_000).toISOString(),
    issued_by: 'owner-password-cli',
    status: 'issued',
  };
  record.signature = signRecord(record, (options.getSignKey || passCore.getSignKey)());
  const { recordDir } = dirs(options);
  atomicWriteJson(path.join(recordDir, `${record.closure_id}.json`), record);
  writeAudit('OWNER_CLOSURE_ISSUED', record, { manifest_digest: crypto.createHash('sha256').update(passCore.stableStringify(manifest)).digest('hex') }, options);
  return record;
}

function claimOwnerClosure(input, options = {}) {
  const { record, file } = loadRecord(input && input.closureId, options);
  const now = (options.now || Date.now)();
  if (record.status !== 'issued') throw new Error(`OWNER_CLOSURE_NOT_ISSUED: ${record.status}`);
  if (Date.parse(record.expires_at) <= now) throw new Error('OWNER_CLOSURE_EXPIRED');

  const requested = (input.files || []).map(normalizeRelativePath).sort();
  const authorized = record.files.map(item => item.path).sort();
  if (requested.length !== authorized.length || requested.some((item, i) => item !== authorized[i])) {
    throw new Error('OWNER_CLOSURE_FILE_SET_MISMATCH');
  }
  verifyBaseline(record, path.resolve(input.projectRoot), options);

  const lockFile = `${file}.lock`;
  let fd;
  try {
    fd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, claimed_at: new Date(now).toISOString() }), 'utf8');
  } catch (_) {
    throw new Error('OWNER_CLOSURE_ALREADY_CLAIMED');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  const attemptId = `oca_${crypto.randomBytes(8).toString('hex')}`;
  const claimed = {
    ...record,
    status: 'claimed',
    attempt_id: attemptId,
    claimed_at: new Date(now).toISOString(),
  };
  claimed.signature = signRecord(claimed, (options.getSignKey || passCore.getSignKey)());
  atomicWriteJson(file, claimed);
  writeAudit('OWNER_CLOSURE_CLAIMED', claimed, { attempt_id: attemptId }, options);
  return {
    closure_id: claimed.closure_id,
    attempt_id: attemptId,
    approval_ref: claimed.approval_ref,
    allowed_blocking_rules: [...claimed.allowed_blocking_rules],
    files: claimed.files.map(item => ({ ...item })),
    verified: true,
  };
}

function finishOwnerClosure(input, options = {}) {
  const { record, file } = loadRecord(input && input.closureId, options);
  if (!['claimed', 'token_authorized'].includes(record.status) || record.attempt_id !== input.attemptId) {
    throw new Error('OWNER_CLOSURE_ATTEMPT_MISMATCH');
  }
  const success = record.status === 'token_authorized' && input.success === true && input.tokenIssued === true;
  const now = (options.now || Date.now)();
  const finished = {
    ...record,
    status: success ? 'completed' : 'failed',
    run_id: String(input.runId || ''),
    token_issued: input.tokenIssued === true,
    finished_at: new Date(now).toISOString(),
    failure_reason: success ? undefined : String(input.failureReason || 'pipeline_or_token_failed'),
  };
  finished.signature = signRecord(finished, (options.getSignKey || passCore.getSignKey)());
  atomicWriteJson(file, finished);
  try { fs.unlinkSync(`${file}.lock`); } catch (_) {}
  writeAudit(success ? 'OWNER_CLOSURE_COMPLETED' : 'OWNER_CLOSURE_FAILED', finished, {
    attempt_id: record.attempt_id,
    run_id: finished.run_id,
    token_issued: finished.token_issued,
    failure_reason: finished.failure_reason,
  }, options);
  return finished;
}

function authorizeOwnerClosureToken(input, options = {}) {
  const { record, file } = loadRecord(input && input.closureId, options);
  if (record.status !== 'claimed' || record.attempt_id !== input.attemptId) {
    throw new Error('OWNER_CLOSURE_ATTEMPT_MISMATCH');
  }
  if (input.flowSuccess !== true || input.flowStatus !== 'completed' || input.endReason !== 'completed') {
    throw new Error('OWNER_CLOSURE_FLOW_NOT_COMPLETED');
  }
  const now = (options.now || Date.now)();
  const authorized = {
    ...record,
    status: 'token_authorized',
    run_id: String(input.runId || ''),
    flow_completed_at: new Date(now).toISOString(),
  };
  authorized.signature = signRecord(authorized, (options.getSignKey || passCore.getSignKey)());
  atomicWriteJson(file, authorized);
  writeAudit('OWNER_CLOSURE_TOKEN_AUTHORIZED', authorized, {
    attempt_id: record.attempt_id,
    run_id: authorized.run_id,
  }, options);
  return authorized;
}

function listOwnerClosures(options = {}) {
  const { recordDir } = dirs(options);
  if (!fs.existsSync(recordDir)) return [];
  return fs.readdirSync(recordDir)
    .filter(name => /^oc_[a-f0-9]{16}\.json$/.test(name))
    .map(name => {
      try { return loadRecord(name.slice(0, -5), options).record; } catch (_) { return null; }
    })
    .filter(Boolean);
}

module.exports = {
  ALLOWED_BLOCKING_RULES,
  normalizeManifest,
  signRecord,
  verifyRecordSignature,
  verifyBaseline,
  issueOwnerClosure,
  claimOwnerClosure,
  authorizeOwnerClosureToken,
  finishOwnerClosure,
  listOwnerClosures,
};

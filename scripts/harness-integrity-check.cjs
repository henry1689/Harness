/* eslint-disable no-console */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..');
var MANIFEST_PATH = path.join(ROOT, '.claude', 'harness-integrity-manifest.json');

var DEFAULT_FILES = [
  '.claude/harness-pre-check.cjs',
  '.claude/harness-post-check.cjs',
  '.claude/harness-verify-startup.cjs',
  '.claude/harness-auto-start.cjs',
  'scripts/harness-gate.cjs',
  'src/project-brain/diff-scope-runtime.cjs'
];

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function normalizeForIntegrityHash(buf) {
  return buf.toString('utf8').replace(/\r\n/g, '\n');
}

function sha256File(abs) {
  var content = normalizeForIntegrityHash(fs.readFileSync(abs));
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function writeManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

function buildManifest(files) {
  var out = {
    version: 1,
    algorithm: 'sha256',
    generated_at: new Date().toISOString(),
    files: {}
  };

  files.forEach(function(rel) {
    var normalized = toPosix(rel);
    var abs = path.join(ROOT, normalized);
    if (!fs.existsSync(abs)) {
      throw new Error('manifest target not found: ' + normalized);
    }
    out.files[normalized] = sha256File(abs);
  });

  return out;
}

function verifyManifest(manifest) {
  if (!manifest || manifest.version !== 1 || manifest.algorithm !== 'sha256' || !manifest.files) {
    return [{
      file: MANIFEST_PATH,
      reason: 'invalid manifest format'
    }];
  }

  var failures = [];

  Object.keys(manifest.files).forEach(function(rel) {
    var normalized = toPosix(rel);
    var expected = manifest.files[rel];
    var abs = path.join(ROOT, normalized);

    if (!fs.existsSync(abs)) {
      failures.push({
        file: normalized,
        reason: 'missing file',
        expected: expected,
        actual: null
      });
      return;
    }

    var actual = sha256File(abs);
    if (actual !== expected) {
      failures.push({
        file: normalized,
        reason: 'sha256 mismatch',
        expected: expected,
        actual: actual
      });
    }
  });

  return failures;
}

function usage() {
  console.log('Usage:');
  console.log('  node scripts/harness-integrity-check.cjs');
  console.log('  node scripts/harness-integrity-check.cjs --write');
  console.log('  node scripts/harness-integrity-check.cjs --check');
}

function main(argv) {
  var mode = argv[2] || '--check';

  if (mode === '--help' || mode === '-h') {
    usage();
    return 0;
  }

  if (mode === '--write') {
    var manifest = buildManifest(DEFAULT_FILES);
    writeManifest(manifest);
    console.log('[HarnessIntegrity] wrote manifest: ' + path.relative(ROOT, MANIFEST_PATH));
    Object.keys(manifest.files).forEach(function(rel) {
      console.log('[HarnessIntegrity] tracked ' + rel);
    });
    return 0;
  }

  if (mode !== '--check') {
    console.error('[HarnessIntegrity] unknown mode: ' + mode);
    usage();
    return 2;
  }

  var loaded = loadManifest();
  if (!loaded) {
    console.error('[HarnessIntegrity] manifest missing: ' + path.relative(ROOT, MANIFEST_PATH));
    console.error('[HarnessIntegrity] run: node scripts/harness-integrity-check.cjs --write');
    return 1;
  }

  var failures = verifyManifest(loaded);
  if (failures.length) {
    console.error('[HarnessIntegrity] FAILED');
    failures.forEach(function(f) {
      console.error('- ' + f.file + ': ' + f.reason);
      if (f.expected) console.error('  expected: ' + f.expected);
      if (f.actual) console.error('  actual:   ' + f.actual);
    });
    return 1;
  }

  console.log('[HarnessIntegrity] OK');
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = {
  DEFAULT_FILES: DEFAULT_FILES,
  MANIFEST_PATH: MANIFEST_PATH,
  buildManifest: buildManifest,
  verifyManifest: verifyManifest,
  sha256File: sha256File,
  normalizeForIntegrityHash: normalizeForIntegrityHash
};

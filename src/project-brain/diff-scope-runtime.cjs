'use strict';

/**
 * diff-scope-runtime.cjs — DiffScopeGuard runtime adapter for CJS hooks/gates (P4-C)
 * =================================================================================
 * CJS-compatible implementation used by:
 *   - scripts/harness-gate.cjs
 *   - .claude/harness-pre-check.cjs
 *
 * This mirrors src/project-brain/diff-scope-guard.ts without requiring TS runtime
 * from security-critical hooks.
 */

function normalizeFilePath(value) {
  return String(value || '').replace(/\\/g, '/').trim();
}

function normalizePathList(values) {
  if (!Array.isArray(values)) return [];
  var seen = Object.create(null);
  var result = [];
  for (var i = 0; i < values.length; i++) {
    var n = normalizeFilePath(values[i]);
    if (!n) continue;
    if (seen[n]) continue;
    seen[n] = true;
    result.push(n);
  }
  return result;
}

function pathMatchesRule(filePath, rule) {
  var path = normalizeFilePath(filePath);
  var r = normalizeFilePath(rule);
  if (!path || !r) return false;

  if (path === r) return true;

  if (r.endsWith('/**')) {
    var prefix = r.slice(0, -3);
    return path === prefix || path.indexOf(prefix + '/') === 0;
  }

  if (r.endsWith('/')) {
    return path.indexOf(r) === 0;
  }

  if (path.indexOf(r + '/') === 0) {
    return true;
  }

  return false;
}

function findFirstMatch(filePath, rules) {
  for (var i = 0; i < rules.length; i++) {
    if (pathMatchesRule(filePath, rules[i])) return rules[i];
  }
  return undefined;
}

function buildResult(allowed, mode, changed_paths, allowed_paths, forbidden_paths, violations, warnings, matched) {
  var matchedAllowed = 0;
  var matchedForbidden = 0;

  for (var i = 0; i < matched.length; i++) {
    if (matched[i].allowed_rule) matchedAllowed++;
    if (matched[i].forbidden_rule) matchedForbidden++;
  }

  return {
    allowed: allowed,
    mode: mode,
    changed_paths: changed_paths,
    allowed_paths: allowed_paths,
    forbidden_paths: forbidden_paths,
    violations: violations,
    warnings: warnings,
    matched: matched,
    summary: {
      changed_count: changed_paths.length,
      violation_count: violations.length,
      warning_count: warnings.length,
      matched_allowed_count: matchedAllowed,
      matched_forbidden_count: matchedForbidden
    }
  };
}

function evaluateDiffScope(input) {
  input = input || {};
  var mode = input.mode || 'strict';
  var intent = input.intent || {};
  var scope = intent.scope || {};

  var changed_paths = normalizePathList(input.changed_paths || []);
  var allowed_paths = normalizePathList(scope.allowed_paths || []);
  var forbidden_paths = normalizePathList(scope.forbidden_paths || scope.denied_paths || []);

  var violations = [];
  var warnings = [];
  var matched = [];

  if (changed_paths.length === 0) {
    warnings.push({
      type: 'no_changed_paths',
      message: 'No changed paths provided.'
    });
    return buildResult(true, mode, changed_paths, allowed_paths, forbidden_paths, violations, warnings, matched);
  }

  if (allowed_paths.length === 0) {
    warnings.push({
      type: 'empty_allowed_scope',
      message: 'IntentSpec.scope.allowed_paths is empty.'
    });

    for (var e = 0; e < changed_paths.length; e++) {
      violations.push({
        type: 'empty_allowed_scope_with_changes',
        path: changed_paths[e],
        message: 'Changed path outside empty allowed scope: ' + changed_paths[e]
      });
    }

    return buildResult(mode === 'advisory', mode, changed_paths, allowed_paths, forbidden_paths, violations, warnings, matched);
  }

  for (var f = 0; f < forbidden_paths.length; f++) {
    for (var a = 0; a < allowed_paths.length; a++) {
      if (pathMatchesRule(allowed_paths[a], forbidden_paths[f]) || pathMatchesRule(forbidden_paths[f], allowed_paths[a])) {
        warnings.push({
          type: 'overlapping_allowed_and_forbidden_scope',
          path: forbidden_paths[f],
          rule: allowed_paths[a],
          message: 'Overlap: forbidden="' + forbidden_paths[f] + '" is within allowed="' + allowed_paths[a] + '"'
        });
      }
    }
  }

  for (var p = 0; p < changed_paths.length; p++) {
    var changed = changed_paths[p];
    var forbiddenRule = findFirstMatch(changed, forbidden_paths);
    var allowedRule = findFirstMatch(changed, allowed_paths);

    matched.push({
      path: changed,
      allowed_rule: allowedRule,
      forbidden_rule: forbiddenRule
    });

    if (forbiddenRule) {
      violations.push({
        type: 'forbidden_path_touched',
        path: changed,
        rule: forbiddenRule,
        message: 'Path "' + changed + '" matches forbidden rule "' + forbiddenRule + '"'
      });
    } else if (!allowedRule) {
      violations.push({
        type: 'outside_allowed_scope',
        path: changed,
        message: 'Path "' + changed + '" does not match any allowed rule'
      });
    }
  }

  return buildResult(mode === 'advisory' ? true : violations.length === 0, mode, changed_paths, allowed_paths, forbidden_paths, violations, warnings, matched);
}

function tokenToIntentSpec(token) {
  token = token || {};
  var scope = token.scope || {};
  return {
    id: token.intent_id || token.run_id || token.token_id || 'runtime-token',
    scope: {
      allowed_paths: normalizePathList(scope.allowed_paths || token.allowed_paths || token.files || token.allowed_files || []),
      forbidden_paths: normalizePathList(scope.forbidden_paths || scope.denied_paths || token.forbidden_paths || token.denied_paths || [])
    }
  };
}

function evaluateTokenScope(token, changedPaths, options) {
  options = options || {};
  return evaluateDiffScope({
    intent: tokenToIntentSpec(token),
    changed_paths: changedPaths || [],
    mode: options.mode || 'strict'
  });
}

function formatScopeResult(result) {
  var lines = [];
  lines.push('DiffScopeGuard result: ' + (result.allowed ? 'ALLOW' : 'DENY'));
  lines.push('mode: ' + result.mode);
  lines.push('changed_count: ' + result.summary.changed_count);
  lines.push('violation_count: ' + result.summary.violation_count);
  if (result.violations && result.violations.length) {
    lines.push('violations:');
    for (var i = 0; i < result.violations.length; i++) {
      var v = result.violations[i];
      lines.push('  - [' + v.type + '] ' + v.path + (v.rule ? ' rule=' + v.rule : '') + ' :: ' + v.message);
    }
  }
  if (result.warnings && result.warnings.length) {
    lines.push('warnings:');
    for (var w = 0; w < result.warnings.length; w++) {
      var warn = result.warnings[w];
      lines.push('  - [' + warn.type + '] ' + warn.message);
    }
  }
  return lines.join('\n');
}

module.exports = {
  normalizeFilePath: normalizeFilePath,
  normalizePathList: normalizePathList,
  pathMatchesRule: pathMatchesRule,
  evaluateDiffScope: evaluateDiffScope,
  tokenToIntentSpec: tokenToIntentSpec,
  evaluateTokenScope: evaluateTokenScope,
  formatScopeResult: formatScopeResult
};

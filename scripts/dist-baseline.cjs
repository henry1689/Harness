#!/usr/bin/env node
/**
 * dist-baseline.cjs — dist/ 哈希基线 + 漂移自愈（v2.9 新增）
 * ======================================================================
 * 治理 dist/ 绕过通道：dist 曾三层全盲（gitignore + Sentinel 排除 + hook 不管）。
 * 方案：
 *   - 生成基线: tsc 编译 src → 哈希 dist 产物 → data/dist-baseline.json
 *   - 漂移自愈: dist 变更 → 比对基线 → 偏离则从 src 编译产物覆写（非 git checkout，
 *     dist 是 untracked，rollback 的 unlink 会删掉合法构建产物）
 *   - 逃生舱: HARNESS_ALLOW_DIST_REBUILD=1（合法 npm run build 时设）跳过自愈 + --refresh 更新基线
 *
 * 用法:
 *   node scripts/dist-baseline.cjs --refresh [--project D:/tools/wenstar-cc]   # 生成/刷新基线
 *   node scripts/dist-baseline.cjs --verify <dist相对路径> [--project ...]    # 校验单个文件，偏离→自愈覆写
 *   node scripts/dist-baseline.cjs --project D:/tools/wenstar-cc             # 全量校验
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HARNESS_DIR = path.resolve(__dirname, '..');
const BASELINE_FILE = path.join(HARNESS_DIR, 'data', 'dist-baseline.json');
const CACHE_DIR = path.join(HARNESS_DIR, 'data', 'cache', 'dist-src');

const args = process.argv.slice(2);
const projectRoot = (() => {
  const idx = args.indexOf('--project');
  return idx >= 0 && args[idx + 1] ? path.resolve(args[idx + 1]) : path.resolve(process.env.WENSTAR_CC_ROOT || 'D:/tools/wenstar-cc');
})();
const refresh = args.includes('--refresh');
const verifyTarget = (() => {
  const idx = args.indexOf('--verify');
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
})();
const ALLOW_REBUILD = process.env.HARNESS_ALLOW_DIST_REBUILD === '1';

function sha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (_) { return null; }
}

/** tsc 编译 src 到临时目录，返回 src→编译产物映射 */
function compileSrcToCache() {
  if (!fs.existsSync(path.join(projectRoot, 'tsconfig.json'))) {
    console.error('[dist-baseline] ❌ 项目无 tsconfig.json:', projectRoot);
    return null;
  }
  // 复用缓存（按 git rev 分目录），减少重复编译
  let rev = 'unknown';
  try { rev = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot, encoding: 'utf-8' }).stdout.trim() || 'unknown'; } catch (_) {}
  const outDir = path.join(CACHE_DIR, rev);
  if (fs.existsSync(path.join(outDir, 'dist'))) return { rev, outDir };

  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  const res = spawnSync('npx', ['tsc', '--outDir', path.join(outDir, 'dist')], {
    cwd: projectRoot, encoding: 'utf-8', timeout: 120000, shell: true,
  });
  if (res.status !== 0) {
    console.error('[dist-baseline] ❌ tsc 编译失败:', (res.stderr || res.stdout || '').slice(0, 300));
    return null;
  }
  return { rev, outDir };
}

/** 生成基线（刷新） */
function refreshBaseline() {
  const compiled = compileSrcToCache();
  if (!compiled) process.exit(1);
  const srcDir = path.join(compiled.outDir, 'dist');
  const baseline = { version: 1, project: projectRoot, src_rev: compiled.rev, generated_at: new Date().toISOString(), files: {} };

  function walk(dir, relBase) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, ent.name);
      const rel = relBase ? relBase + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(fp, rel);
      else if (ent.isFile() && /\.(js|mjs|cjs)$/.test(ent.name)) {
        baseline.files['dist/' + rel] = sha256(fp);
      }
    }
  }
  if (fs.existsSync(srcDir)) walk(srcDir, '');

  if (!fs.existsSync(path.dirname(BASELINE_FILE))) fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2), 'utf-8');
  console.log(`[dist-baseline] ✅ 基线已刷新: ${Object.keys(baseline.files).length} 个 dist 文件 (rev ${compiled.rev})`);
  return baseline;
}

/** 校验单个 dist 文件：偏离 → 从 src 编译产物覆写 */
function verifyAndHeal(distRel, baseline) {
  if (!baseline || !baseline.files) return;
  const target = path.join(projectRoot, distRel);
  const expectedHash = baseline.files[distRel];
  const currentHash = sha256(target);

  if (currentHash === expectedHash) return; // 一致，无需处理

  // 偏离：从 src 编译产物覆写
  if (ALLOW_REBUILD) {
    console.log(`[dist-baseline] 🟡 ${distRel} 偏离但 HARNESS_ALLOW_DIST_REBUILD=1，跳过自愈`);
    return;
  }
  // MID-4-fix: 脏树保护——src 有未提交改动时，基线可能是陈旧的（缓存按 git rev 键控），
  // 自愈覆写会把合法的新构建产物打回陈旧版本。src 脏 → 跳过自愈仅告警。
  try {
    const dirty = spawnSync('git', ['status', '--porcelain', '--', 'src/'], { cwd: projectRoot, encoding: 'utf-8' }).stdout.trim();
    if (dirty) {
      console.log(`[dist-baseline] 🟡 ${distRel} 偏离但 src/ 有未提交改动，跳过自愈（防脏树覆写），请构建后 --refresh 更新基线`);
      return;
    }
  } catch (_) {}
  const compiled = compileSrcToCache();
  if (!compiled) return;
  const srcFile = path.join(compiled.outDir, distRel);
  if (!fs.existsSync(srcFile)) {
    console.log(`[dist-baseline] 🟡 ${distRel} 无对应 src 编译产物（可能是拷贝/手写文件），跳过`);
    return;
  }
  try {
    fs.copyFileSync(srcFile, target);
    console.log(`[dist-baseline] 🔧 自愈覆写: ${distRel} — dist 偏离基线，已从 src 编译产物恢复`);
    // 审计
    const auditDir = path.join(HARNESS_DIR, 'data', 'sentinel');
    if (fs.existsSync(auditDir)) {
      fs.writeFileSync(path.join(auditDir, `dist_drift_${Date.now()}.json`),
        JSON.stringify({ timestamp: new Date().toISOString(), file: distRel, action: 'self-heal', reason: 'dist 偏离基线，从 src 编译产物覆写' }, null, 2));
    }
  } catch (err) {
    console.error(`[dist-baseline] ❌ 自愈失败 ${distRel}:`, err.message);
  }
}

// ── 主流程 ──
if (refresh) {
  refreshBaseline();
  process.exit(0);
}

// 加载基线（无则先刷新）
let baseline = null;
try { baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8')); } catch (_) {}
if (!baseline || baseline.project !== projectRoot) {
  console.log('[dist-baseline] 无基线或项目变更，先刷新...');
  baseline = refreshBaseline();
  if (!baseline) process.exit(1);
}

if (verifyTarget) {
  verifyAndHeal(String(verifyTarget).replace(/\\/g, '/').replace(/^\.?\//, ''), baseline);
} else {
  // 全量校验
  let drifted = 0;
  for (const rel of Object.keys(baseline.files)) {
    const before = sha256(path.join(projectRoot, rel));
    if (before !== baseline.files[rel]) { drifted++; verifyAndHeal(rel, baseline); }
  }
  console.log(`[dist-baseline] 全量校验完成，偏离 ${drifted} 个`);
}
process.exit(0);

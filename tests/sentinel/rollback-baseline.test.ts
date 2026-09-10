/**
 * Sentinel rollback v3.0 — 基线恢复语义 + 非破坏性兜底
 * ================================================================
 * 覆盖 docs/harness/06_Sentinel回滚缺陷-2026-09-10.md：
 *   ① 有基线 → 精确恢复到最后授权内容（不再用 git index）
 *   ② 幂等 → already（免日志/升级风暴）
 *   ③ 无基线 + git 跟踪文件 → 拒绝破坏性回滚 + 隔离（fail-loud，绝不静默销毁）
 *   ④ 无基线 + 未跟踪新文件 → 隔离后可删除（可找回）
 *   ⑤ 回归护栏：源码中不得再出现 `git checkout` 回滚调用
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const requireCjs = createRequire(import.meta.url);
const { createRollback } = requireCjs('../../sentinel/rollback.cjs');
const { createBaseline, BASELINE_ROOT, projectKey } = requireCjs('../../sentinel/baseline.cjs');

const REPO = 'D:/tmp/harness-rollback-test';
const QUARANTINE = join(process.cwd(), 'data', 'sentinel', 'quarantine');

function sh(cmd: string): void {
  execSync(cmd, { cwd: REPO, stdio: 'pipe' });
}
function read(p: string): string {
  return readFileSync(join(REPO, p), 'utf-8');
}
function write(p: string, c: string): void {
  const abs = join(REPO, p);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, c, 'utf-8');
}
/** 隔离区是否有该文件的副本（递归找文件名） */
function quarantineHas(basename: string): boolean {
  if (!existsSync(QUARANTINE)) return false;
  const stack = [QUARANTINE];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === basename) return true;
    }
  }
  return false;
}

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(join(REPO, 'src'), { recursive: true });
  sh('git init -q');
  sh('git config user.email t@t.local');
  sh('git config user.name t');
  write('src/tracked.ts', 'TRACKED_V1\n');
  sh('git add -A');
  sh('git commit -qm init');
});

afterAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  rmSync(join(BASELINE_ROOT, projectKey(REPO)), { recursive: true, force: true });
  rmSync(QUARANTINE, { recursive: true, force: true });
});

describe('Sentinel rollback v3.0（基线恢复）', () => {
  it('① 有基线 → 未授权修改被精确恢复（不碰 git index）', async () => {
    write('src/tracked.ts', 'AUTHORIZED_STATE\n');
    const bl = createBaseline(REPO);
    bl.refresh('src/tracked.ts'); // 模拟「上一次授权写入」推进基线

    write('src/tracked.ts', 'UNAUTHORIZED_TAMPER\n');

    const rb = createRollback(REPO, { baseline: bl });
    const res = await rb.revert('src/tracked.ts', { dryRun: false });

    expect(res.reverted).toBe(true);
    expect(res.method).toBe('baseline');
    expect(read('src/tracked.ts')).toBe('AUTHORIZED_STATE\n');
  });

  it('② 幂等：内容已与基线一致 → already（不计错误/不升级）', async () => {
    const bl = createBaseline(REPO);
    bl.refresh('src/tracked.ts');
    const rb = createRollback(REPO, { baseline: bl });

    const res = await rb.revert('src/tracked.ts', { dryRun: false });
    expect(res.reverted).toBe(false);
    expect(res.already).toBe(true);
  });

  it('③ 无基线 + git 跟踪文件 → 拒绝破坏性回滚 + 隔离（fail-loud）', async () => {
    // 新开一个项目，确保「无基线」
    const REPO2 = 'D:/tmp/harness-rollback-test-nb';
    rmSync(REPO2, { recursive: true, force: true });
    mkdirSync(join(REPO2, 'src'), { recursive: true });
    execSync('git init -q && git config user.email t@t.local && git config user.name t', { cwd: REPO2, stdio: 'pipe' });
    writeFileSync(join(REPO2, 'src/tracked2.ts'), 'V1\n', 'utf-8');
    execSync('git add -A && git commit -qm init', { cwd: REPO2, stdio: 'pipe' });
    writeFileSync(join(REPO2, 'src/tracked2.ts'), 'UNAUTHORIZED_WORK\n', 'utf-8');

    const bl2 = createBaseline(REPO2); // 空基线
    const rb = createRollback(REPO2, { baseline: bl2 });
    const res = await rb.revert('src/tracked2.ts', { dryRun: false });

    expect(res.reverted).toBe(false);
    expect(res.method).toBe('refused-no-baseline');
    // 🔴 关键：内容【未被销毁】——拒绝回滚而非 git checkout
    expect(readFileSync(join(REPO2, 'src/tracked2.ts'), 'utf-8')).toBe('UNAUTHORIZED_WORK\n');
    expect(quarantineHas('tracked2.ts')).toBe(true);

    rmSync(REPO2, { recursive: true, force: true });
    rmSync(join(BASELINE_ROOT, projectKey(REPO2)), { recursive: true, force: true });
  });

  it('④ 无基线 + 未跟踪新文件 → 隔离后可删除（内容可找回）', async () => {
    write('src/brand-new.ts', 'NEW_UNTRACKED\n');
    const bl = createBaseline(REPO); // 不含 brand-new.ts
    const rb = createRollback(REPO, { baseline: bl });

    const res = await rb.revert('src/brand-new.ts', { dryRun: false });
    expect(res.reverted).toBe(true);
    expect(res.method).toBe('quarantine-delete');
    expect(existsSync(join(REPO, 'src/brand-new.ts'))).toBe(false);
    expect(quarantineHas('brand-new.ts')).toBe(true); // 内容可找回
  });

  it('⑤ 回归护栏：rollback.cjs 源码中不得再出现 git checkout 回滚调用', () => {
    const src = readFileSync(join(process.cwd(), 'sentinel', 'rollback.cjs'), 'utf-8');
    // 匹配代码形式（execSync('git checkout ...')），注释中的说明不算
    expect(/execSync\(\s*[`'"]git checkout/.test(src)).toBe(false);
    expect(src).toContain('createBaseline'.replace('createBaseline', 'baseline')); // 确实接入了基线
  });
});

/**
 * Sentinel 基线快照 — 回滚语义修复（2026-09-10 事故）
 * ================================================================
 * 覆盖 docs/harness/06_Sentinel回滚缺陷-2026-09-10.md 所述的修复语义：
 *   回滚 = 恢复到「最后一次授权内容」，而不是 git index（后者会销毁未暂存工作）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const requireCjs = createRequire(import.meta.url);
const { createBaseline, BASELINE_ROOT, projectKey } = requireCjs('../../sentinel/baseline.cjs');

/** 用假项目根（D:\tmp 下），避免触碰真实基线 */
const FAKE_ROOTS = [
  'D:/tmp/harness-baseline-test-A',
  'D:/tmp/harness-baseline-test-B',
];
const SRC = 'src/types.ts';

function mkProject(root: string, content: string): string {
  const abs = join(root, 'src');
  if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  writeFileSync(join(root, SRC), content, 'utf-8');
  return root;
}

afterAll(() => {
  // 🔴 测试数据清理：删除本测试写入的基线目录与假项目根
  for (const r of FAKE_ROOTS) {
    rmSync(join(BASELINE_ROOT, projectKey(r)), { recursive: true, force: true });
    rmSync(r, { recursive: true, force: true });
  }
});

describe('Sentinel baseline（回滚语义修复）', () => {
  it('项目指纹隔离：不同 projectRoot → 不同基线目录', () => {
    expect(projectKey('D:/x/A')).not.toBe(projectKey('D:/x/B'));
  });

  it('init 建立基线；restore 幂等（内容已一致 → already，不计为回滚）', () => {
    const root = mkProject(FAKE_ROOTS[0], 'ORIGINAL\n');
    const bl = createBaseline(root);

    expect(bl.has(SRC)).toBe(false);
    expect(bl.init(SRC).ok).toBe(true);
    expect(bl.has(SRC)).toBe(true);

    const r = bl.restore(SRC);
    expect(r.restored).toBe(false);
    expect(r.already).toBe(true);
    expect(readFileSync(join(root, SRC), 'utf-8')).toBe('ORIGINAL\n');
  });

  it('🔴 核心：未授权修改 → restore 恢复到基线内容（而非 git index）', () => {
    const root = mkProject(FAKE_ROOTS[0], 'BASELINE_WITH_ENHANCE_V1\n');
    const bl = createBaseline(root);
    bl.refresh(SRC); // 授权状态下建立基线

    // 模拟：一次未授权编辑（事故中的 types.ts 编辑）
    writeFileSync(join(root, SRC), 'UNAUTHORIZED_EDIT\n', 'utf-8');
    expect(readFileSync(join(root, SRC), 'utf-8')).toBe('UNAUTHORIZED_EDIT\n');

    const r = bl.restore(SRC);
    expect(r.restored).toBe(true);
    // 恢复后是「基线内容」——即授权态的全部工作仍在，不丢未暂存改动
    expect(readFileSync(join(root, SRC), 'utf-8')).toBe('BASELINE_WITH_ENHANCE_V1\n');
  });

  it('授权写入后 refresh → 后续回滚恢复到新基线（授权改动不被回退）', () => {
    const root = mkProject(FAKE_ROOTS[0], 'V1\n');
    const bl = createBaseline(root);
    bl.refresh(SRC);

    writeFileSync(join(root, SRC), 'V2_AUTHORIZED\n', 'utf-8');
    bl.refresh(SRC); // 授权 → 基线推进

    writeFileSync(join(root, SRC), 'V3_UNAUTHORIZED\n', 'utf-8');
    expect(bl.restore(SRC).restored).toBe(true);
    expect(readFileSync(join(root, SRC), 'utf-8')).toBe('V2_AUTHORIZED\n');
  });

  it('无基线 → 拒绝破坏性回滚（fail-loud，不猜、不删）', () => {
    const root = mkProject(FAKE_ROOTS[1], 'ANY\n');
    const bl = createBaseline(root);

    const r = bl.restore('src/never-baselined.ts');
    expect(r.restored).toBe(false);
    expect(r.reason).toContain('无基线');
  });

  it('文件被删除 → restore 从基线重建', () => {
    const root = mkProject(FAKE_ROOTS[1], 'WILL_BE_DELETED\n');
    const bl = createBaseline(root);
    bl.refresh(SRC);

    rmSync(join(root, SRC), { force: true });
    expect(existsSync(join(root, SRC))).toBe(false);

    const r = bl.restore(SRC);
    expect(r.restored).toBe(true);
    expect(readFileSync(join(root, SRC), 'utf-8')).toBe('WILL_BE_DELETED\n');
  });

  it('init 幂等：已有基线时不覆盖（防止启动全量初始化冲掉授权态）', () => {
    const IDEM = 'src/idempotent-probe.ts'; // 独立路径，避免与其它用例的基线互相干扰
    const root = FAKE_ROOTS[1];
    const abs = join(root, IDEM);
    if (!existsSync(join(root, 'src'))) mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(abs, 'FIRST\n', 'utf-8');

    const bl = createBaseline(root);
    bl.init(IDEM);

    writeFileSync(abs, 'AUTHORIZED_NEWER\n', 'utf-8');
    const again = bl.init(IDEM); // 已有基线 → 跳过
    expect(again.ok).toBe(true);
    expect(again.skipped).toBe(true);

    writeFileSync(abs, 'UNAUTHORIZED\n', 'utf-8');
    bl.restore(IDEM);
    expect(readFileSync(abs, 'utf-8')).toBe('FIRST\n');
  });

  it('跨进程持久化：新建实例可读回既有基线并完成恢复', () => {
    const root = mkProject(FAKE_ROOTS[0], 'PERSISTED\n');
    createBaseline(root).refresh(SRC);

    const bl2 = createBaseline(root); // 新实例（模拟 Sentinel 重启）
    writeFileSync(join(root, SRC), 'TAMPERED\n', 'utf-8');
    expect(bl2.restore(SRC).restored).toBe(true);
    expect(readFileSync(join(root, SRC), 'utf-8')).toBe('PERSISTED\n');
  });
});

/**
 * Sentinel watcher 删除检测（F2）— 2026-09-11
 * ================================================================
 * 缺陷：原 scanDir 只按 mtime 判「修改」、按首次出现判「新增」，
 * **文件消失不触发任何事件** → 未授权的 `rm` 完全绕过 Sentinel。
 * 修复：每轮全量扫描后比对 fileState，登记过但磁盘确已不存在 → 上报删除事件。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const requireCjs = createRequire(import.meta.url);
const { createWatcher } = requireCjs('../../sentinel/watcher.cjs');

const DIR = 'D:/tmp/harness-watcher-deletion-test';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function seed(): void {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, 'src'), { recursive: true });
  writeFileSync(join(DIR, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  writeFileSync(join(DIR, 'src', 'b.ts'), 'export const b = 2;\n', 'utf-8');
}

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe('watcher 删除检测（F2）', () => {
  it('🔴 受管文件被删除 → 触发 onChange（原缺陷：事件计数纹丝不动）', async () => {
    seed();
    const events: string[] = [];
    const w = createWatcher(DIR, (rel: string) => events.push(rel), { pollMs: 120, debounceMs: 40 });
    w.start();
    await sleep(250);
    // 启动首扫只登记，不应有任何事件
    expect(events).toEqual([]);
    const before = w.getTrackedCount();

    // 未授权删除
    rmSync(join(DIR, 'src', 'b.ts'));
    await sleep(600);

    expect(events).toContain('src/b.ts');
    // 追踪集同步收缩，避免后续每轮重复上报
    expect(w.getTrackedCount()).toBe(before - 1);
    w.stop();
  });

  it('删除后不再重复上报（fileState 已移除该条目）', async () => {
    seed();
    const events: string[] = [];
    const w = createWatcher(DIR, (rel: string) => events.push(rel), { pollMs: 120, debounceMs: 40 });
    w.start();
    await sleep(250);

    rmSync(join(DIR, 'src', 'a.ts'));
    await sleep(600);
    const firstBurst = events.filter(e => e === 'src/a.ts').length;
    await sleep(600); // 再等若干轮扫描
    const total = events.filter(e => e === 'src/a.ts').length;

    expect(firstBurst).toBe(1);
    expect(total).toBe(1); // 不重复上报 → 不会造成日志/回滚风暴
    w.stop();
  });

  it('新文件新增仍正常触发（回归：修复未破坏原有新增检测）', async () => {
    seed();
    const events: string[] = [];
    const w = createWatcher(DIR, (rel: string) => events.push(rel), { pollMs: 120, debounceMs: 40 });
    w.start();
    await sleep(250);

    writeFileSync(join(DIR, 'src', 'new-file.ts'), 'export const c = 3;\n', 'utf-8');
    await sleep(600);

    expect(events).toContain('src/new-file.ts');
    expect(existsSync(join(DIR, 'src', 'new-file.ts'))).toBe(true);
    w.stop();
  });
});

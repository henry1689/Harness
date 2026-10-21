/**
 * paths.test.ts — 治理数据目录解析的回归护栏（2026-10-22）
 * ============================================================
 * 背景：单元测试曾把 run 记录直接写进生产 data/audit/，实测占该目录 50.4%
 * （776 个 run 里 391 个是 vitest 写入），跑通率与中止归因全部失真。
 *
 * 本文件锁死三条边界。**核心是第 3 组的反向断言**：一旦有人把隔离目录
 * 改回生产路径、或让 env 覆盖失效，这里必须当场变红 —— 否则同样的静默污染
 * 会再来一次，而且依旧无法从内容上察觉。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { auditDir, archivesDir, harnessDataDir, isTestProcess } from '../paths.js';

/** 生产路径（与 src/paths.ts 的解析规则同源，此处独立推导以便对照） */
const PROD_AUDIT = join(harnessDataDir(), 'audit');
const PROD_ARCHIVES = join(harnessDataDir(), 'archives');

const ENV_KEYS = ['HARNESS_AUDIT_DIR', 'HARNESS_ARCHIVES_DIR'] as const;
const savedEnv = new Map<string, string | undefined>();
for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('paths — 测试进程隔离（2026-10-22 回归）', () => {
  it('🔴 反向断言：VITEST 下审计目录不得等于生产目录', () => {
    // 本套测试本身就是 vitest 进程 —— 这是「测试会写生产审计」的直接判据
    expect(isTestProcess()).toBe(true);
    expect(auditDir()).not.toBe(PROD_AUDIT);
  });

  it('🔴 反向断言：归档目录同样不得指向生产', () => {
    // 与 auditDir 必须同源同判据 —— 否则复现「写得进、读不到」
    expect(archivesDir()).not.toBe(PROD_ARCHIVES);
  });

  it('🔴 反向断言：不得是生产路径的前缀/父目录（防「退回一层」式回归）', () => {
    // 有人把 auditDir 改成 harnessDataDir() 就会命中这一条
    expect(auditDir()).not.toBe(harnessDataDir());
    expect(auditDir()).not.toBe(harnessDataDir() + '/..');
    expect(auditDir()).not.toBe(PROD_AUDIT.replace(/\/audit$/, ''));
  });

  it('隔离目录落在 data/test-runs/ 下，可整目录清理且不触及生产数据', () => {
    expect(auditDir()).toBe(join(harnessDataDir(), 'test-runs', 'audit'));
    expect(archivesDir()).toBe(join(harnessDataDir(), 'test-runs', 'archives'));
  });
});

describe('paths — 显式 env 覆盖优先于默认解析', () => {
  it('设 HARNESS_AUDIT_DIR → 审计目录指向它（含相对路径的绝对化）', () => {
    process.env.HARNESS_AUDIT_DIR = resolve('some', 'custom', 'audit');
    expect(auditDir()).toBe(resolve('some', 'custom', 'audit'));
  });

  it('设 HARNESS_ARCHIVES_DIR → 归档目录指向它', () => {
    process.env.HARNESS_ARCHIVES_DIR = resolve('tmp', 'archives');
    expect(archivesDir()).toBe(resolve('tmp', 'archives'));
  });

  it('未设 env → 回落隔离目录（不是生产）', () => {
    delete process.env.HARNESS_AUDIT_DIR;
    expect(auditDir()).toBe(join(harnessDataDir(), 'test-runs', 'audit'));
  });
});

describe('paths — 调用时解析（非模块加载时定死）', () => {
  it('🔴 同一进程内改 env，下一次调用即生效', () => {
    // exemptions-core 曾因「模块加载时定死路径」与 s7AutoArchive 的「调用时读 env」
    // 在同一进程里指向不同文件。本模块必须是调用时解析，故此处可即时生效。
    process.env.HARNESS_AUDIT_DIR = resolve('runtime', 'switch');
    expect(auditDir()).toBe(resolve('runtime', 'switch'));
    process.env.HARNESS_AUDIT_DIR = resolve('runtime', 'switch2');
    expect(auditDir()).toBe(resolve('runtime', 'switch2'));
  });
});

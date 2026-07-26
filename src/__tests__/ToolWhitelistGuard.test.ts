/**
 * Harness 引擎单元测试 — ToolWhitelistGuard
 * =============================================
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolWhitelistGuard } from '../ToolWhitelistGuard.js';
import { WhitelistViolationError } from '../types.js';

describe('ToolWhitelistGuard', () => {
  afterEach(() => {
    ToolWhitelistGuard.deactivate();
  });

  it('非激活状态不拦截操作', () => {
    expect(() => ToolWhitelistGuard.checkPermission('write_file')).not.toThrow();
    expect(() => ToolWhitelistGuard.checkPermission('delete_file')).not.toThrow();
    expect(ToolWhitelistGuard.isActive()).toBe(false);
  });

  it('激活后允许白名单中的操作', () => {
    ToolWhitelistGuard.activate({ read_file: true, write_file: true, delete_file: false }, 'S3_Code_Implement');

    expect(() => ToolWhitelistGuard.checkPermission('read_file')).not.toThrow();
    expect(() => ToolWhitelistGuard.checkPermission('write_file')).not.toThrow();
    expect(ToolWhitelistGuard.isActive()).toBe(true);
  });

  it('激活后拒绝白名单中 false 的操作', () => {
    ToolWhitelistGuard.activate({ read_file: true, write_file: false }, 'S1_Problem_Analysis');

    expect(() => ToolWhitelistGuard.checkPermission('read_file')).not.toThrow();
    expect(() => ToolWhitelistGuard.checkPermission('write_file')).toThrow(WhitelistViolationError);
    expect(() => ToolWhitelistGuard.checkPermission('write_file')).toThrow('S1_Problem_Analysis');
  });

  it('操作映射正确识别别名', () => {
    ToolWhitelistGuard.activate({ write_file: false }, 'S1');

    // 所有被认为是"写入"的操作都应被拦截
    expect(() => ToolWhitelistGuard.checkPermission('edit_file')).toThrow(WhitelistViolationError);
    expect(() => ToolWhitelistGuard.checkPermission('fs.writeFileSync')).toThrow(WhitelistViolationError);
  });

  it('拦截 delete_file 的各种别名', () => {
    ToolWhitelistGuard.activate({ delete_file: false }, 'S1');

    expect(() => ToolWhitelistGuard.checkPermission('delete_file')).toThrow(WhitelistViolationError);
    expect(() => ToolWhitelistGuard.checkPermission('rm')).toThrow(WhitelistViolationError);
    expect(() => ToolWhitelistGuard.checkPermission('unlink')).toThrow(WhitelistViolationError);
  });

  it('deactivate 后恢复非拦截状态', () => {
    ToolWhitelistGuard.activate({ write_file: false }, 'S1');
    expect(ToolWhitelistGuard.isActive()).toBe(true);

    ToolWhitelistGuard.deactivate();
    expect(ToolWhitelistGuard.isActive()).toBe(false);
    expect(() => ToolWhitelistGuard.checkPermission('write_file')).not.toThrow();
  });

  it('未在白名单映射中的操作默认放行', () => {
    ToolWhitelistGuard.activate({ read_file: true }, 'S1');

    // "some_unknown_action" 不在 ACTION_MAP 中，应放行
    expect(() => ToolWhitelistGuard.checkPermission('some_unknown_action')).not.toThrow();
  });

  it('getStats 记录正确的拦截/放行计数', () => {
    ToolWhitelistGuard.activate({ write_file: false, read_file: true }, 'S1');

    ToolWhitelistGuard.checkPermission('read_file');
    ToolWhitelistGuard.checkPermission('read_file');

    try { ToolWhitelistGuard.checkPermission('write_file'); } catch {}

    const stats = ToolWhitelistGuard.getStats();
    expect(stats.allowed).toBe(2);
    expect(stats.blocked).toBe(1);
    expect(stats.stageId).toBe('S1');
  });
});

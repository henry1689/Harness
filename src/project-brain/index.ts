/**
 * index.ts — ProjectBrain v0.1 模块入口
 * ========================================
 * P1-T1: 纯类型导出。不包含运行时逻辑。
 * P1-T2: 新增 IntentSpec Builder 导出。
 * P1-T3: 新增 Store 导出。
 * P1-T4: 新增 Reporter 导出。
 */

export * from './types';
export * from './intent-builder';
export * from './store';
export * from './reporter';
export * from './diff-scope-guard';
export * from './diff-scope-reporter';
export * from './diff-scope-scenario-runner';
export * from './git-diff-adapter';
export * from './architecture-baseline';
export * from './architecture-baseline-builder';
export * from './architecture-baseline-reporter';

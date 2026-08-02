/**
 * architecture-baseline-builder.ts — ArchitectureBaseline Builder (P3-T2)
 * =========================================================================
 * P3-T2: 显式输入 Builder，为 Harness v4.0 构造预设的 ArchitectureBaseline。
 *
 * 特性：
 * - createHarnessV4ArchitectureBaseline — 主 Builder
 * - append / override 双模式
 * - 6 个默认构建块工厂函数（导出，不共享可变引用）
 * - 纯函数，不扫描仓库、不读 git、不访问文件系统
 */
import type {
  ArchitectureBaseline,
  ArchitectureScope,
  BaselineRisk,
  DefenseLine,
  ForbiddenZone,
  ModuleBoundary,
  RuntimeSurface,
} from './architecture-baseline';
import { createArchitectureBaseline } from './architecture-baseline';
import type { IsoTimestamp } from './types';

// ============================================================================
// Builder Input
// ============================================================================

export interface CreateHarnessV4ArchitectureBaselineInput {
  id?: string;
  version?: string;
  title?: string;
  captured_at?: IsoTimestamp;
  metadata?: Record<string, unknown>;

  scope?: Partial<ArchitectureScope>;
  modules?: ModuleBoundary[];
  forbidden_zones?: ForbiddenZone[];
  defense_lines?: DefenseLine[];
  runtime_surfaces?: RuntimeSurface[];
  risks?: BaselineRisk[];

  mode?: 'append' | 'override';
}

// ============================================================================
// 6 个默认构建块工厂（每次调用返回新对象，不共享引用）
// ============================================================================

export function getDefaultHarnessV4ArchitectureScope(): ArchitectureScope {
  return {
    root: '.',
    included_paths: [
      'src/',
      'scripts/',
      'tests/',
      'mcp/',
      'sentinel/',
      'hooks/',
      'docs/',
      'data/project-brain/',
      'data/reports/project-brain/',
    ],
    excluded_paths: [
      'node_modules/',
      'dist/',
      'coverage/',
      'data/logs/',
      'data/heartbeat.json',
      'data/sentinel/',
    ],
  };
}

export function getDefaultHarnessV4ModuleBoundaries(): ModuleBoundary[] {
  return [
    {
      id: 'harness_core',
      title: 'Harness Core Orchestration',
      paths: [
        'src/FlowEngine.ts',
        'src/StageRunner.ts',
        'src/GateController.ts',
        'src/ComplianceScorer.ts',
        'src/EvolutionEngine.ts',
        'src/main_harness_checker.ts',
      ],
      responsibilities: [
        'S1-S7 pipeline orchestration',
        'Stage execution',
        'Gate control (auto/human/condition)',
        'Compliance scoring (DS/CK)',
        'Evolution loop',
      ],
      allowed_dependencies: [],
      forbidden_dependencies: ['project_brain'],
    },
    {
      id: 'project_brain',
      title: 'ProjectBrain v0.1',
      paths: [
        'src/project-brain/',
        'data/project-brain/',
        'data/reports/project-brain/',
      ],
      responsibilities: [
        'Intent modeling and scope definition',
        'Evidence recording',
        'Decision and risk tracking',
        'Architecture self-description',
      ],
      allowed_dependencies: [],
      forbidden_dependencies: [
        'harness_core',
        'defense_subsystem',
      ],
    },
    {
      id: 'diff_scope_guard',
      title: 'DiffScopeGuard',
      paths: [
        'src/project-brain/diff-scope-guard.ts',
        'src/project-brain/diff-scope-reporter.ts',
        'src/project-brain/diff-scope-scenario-runner.ts',
        'src/project-brain/git-diff-adapter.ts',
        'scripts/project-brain-diff-scope-audit.cjs',
      ],
      responsibilities: [
        'Scope evaluation against intents',
        'Change boundary audit',
        'Manual git diff audit',
        'Evidence and report generation',
      ],
      allowed_dependencies: ['project_brain'],
      forbidden_dependencies: ['harness_core', 'defense_subsystem'],
    },
    {
      id: 'defense_subsystem',
      title: 'Defense Subsystem',
      paths: [
        'mcp/',
        'sentinel/',
        'hooks/',
        'scripts/harness-gate.cjs',
        'scripts/defense-health-check.cjs',
      ],
      responsibilities: [
        'MCP gate (first defense)',
        'Sentinel monitoring (second defense)',
        'Git hook validation (third defense)',
        'Health checks',
      ],
      allowed_dependencies: [],
      forbidden_dependencies: ['project_brain', 'diff_scope_guard'],
    },
    {
      id: 'runtime_state',
      title: 'Runtime State',
      paths: [
        'data/heartbeat.json',
        'data/sentinel/',
        'data/logs/',
      ],
      responsibilities: [
        'Runtime heartbeat from PM2 daemon',
        'Sentinel state and event storage',
        'Process logs',
      ],
      allowed_dependencies: [],
      forbidden_dependencies: [],
    },
  ];
}

export function getDefaultHarnessV4ForbiddenZones(): ForbiddenZone[] {
  return [
    {
      id: 'harness_core_mainline',
      title: 'Harness Core Mainline',
      paths: [
        'src/FlowEngine.ts',
        'src/StageRunner.ts',
        'src/GateController.ts',
        'src/ComplianceScorer.ts',
        'src/EvolutionEngine.ts',
        'src/main_harness_checker.ts',
      ],
      reason: 'Core orchestration files must not be modified by ProjectBrain / DiffScopeGuard phases without explicit approval.',
      severity: 'high',
      allowed_touch_policy: 'explicit_approval',
    },
    {
      id: 'token_and_audit_state',
      title: 'Token and Audit State',
      paths: ['data/tokens/', 'data/audit/'],
      reason: 'Token and audit state are sensitive governance data.',
      severity: 'critical',
      allowed_touch_policy: 'never',
    },
    {
      id: 'defense_runtime',
      title: 'Defense Runtime',
      paths: [
        'mcp/',
        'sentinel/',
        'hooks/',
        'scripts/harness-gate.cjs',
      ],
      reason: 'Defense runtime must not be changed outside dedicated defense tasks.',
      severity: 'high',
      allowed_touch_policy: 'explicit_approval',
    },
    {
      id: 'external_controlled_projects',
      title: 'External Controlled Projects',
      paths: [
        'D:/tools/wenstar-cc',
        'D:/wenstar/wenstar_os',
      ],
      reason: 'External controlled projects are outside Harness v4 ProjectBrain scope.',
      severity: 'critical',
      allowed_touch_policy: 'never',
    },
  ];
}

export function getDefaultHarnessV4DefenseLines(): DefenseLine[] {
  return [
    {
      id: 'pm2_guard',
      title: 'PM2 Process Guard',
      kind: 'pm2_guard',
      status: 'expected_pass',
      related_paths: ['ecosystem.config.cjs'],
      responsibilities: ['Maintain harness-mcp and harness-sentinel processes alive'],
    },
    {
      id: 'mcp_gate',
      title: 'MCP Gate',
      kind: 'mcp_gate',
      status: 'expected_pass',
      related_paths: ['mcp/server.ts', 'mcp/start.cjs'],
      responsibilities: ['HTTP gate on port 8765', 'Heartbeat reporting', 'Token validation'],
    },
    {
      id: 'sentinel',
      title: 'Sentinel',
      kind: 'sentinel',
      status: 'expected_pass',
      related_paths: [
        'sentinel/sentinel-service.cjs',
        'sentinel/watcher.cjs',
        'sentinel/rollback.cjs',
        'sentinel/escalation.cjs',
        'sentinel/sentinel-mcp-client.cjs',
      ],
      responsibilities: ['Filesystem monitoring', 'Rollback detection', 'Escalation', 'Event recording'],
    },
    {
      id: 'git_hook',
      title: 'Git Pre-commit Hook',
      kind: 'git_hook',
      status: 'expected_pass',
      related_paths: ['scripts/harness-gate.cjs', 'hooks/'],
      responsibilities: ['Block high-risk commits without Harness token'],
    },
    {
      id: 'manual_diff_scope_audit',
      title: 'Manual DiffScope Audit',
      kind: 'manual_audit',
      status: 'expected_pass',
      related_paths: ['scripts/project-brain-diff-scope-audit.cjs'],
      responsibilities: ['Manual git diff audit against ProjectBrain intents'],
    },
  ];
}

export function getDefaultHarnessV4RuntimeSurfaces(): RuntimeSurface[] {
  return [
    {
      id: 'heartbeat',
      title: 'Heartbeat File',
      paths: ['data/heartbeat.json'],
      mutable: true,
      commit_policy: 'do_not_commit',
      reason: 'PM2 daemon writes heartbeat on each cycle; never commit to VCS.',
    },
    {
      id: 'sentinel_state',
      title: 'Sentinel State',
      paths: ['data/sentinel/'],
      mutable: true,
      commit_policy: 'do_not_commit',
      reason: 'Sentinel writes runtime events; never commit to VCS.',
    },
    {
      id: 'logs',
      title: 'Runtime Logs',
      paths: ['data/logs/'],
      mutable: true,
      commit_policy: 'do_not_commit',
      reason: 'PM2 and Sentinel write runtime logs; never commit to VCS.',
    },
    {
      id: 'health_reports',
      title: 'Health Reports',
      paths: ['data/reports/health/'],
      mutable: true,
      commit_policy: 'review_required',
      reason: 'Health reports are generated per check run; review before committing.',
    },
  ];
}

export function getDefaultHarnessV4BaselineRisks(): BaselineRisk[] {
  return [
    {
      id: 'accidental_core_modification',
      title: 'Accidental Core Modification',
      level: 'high',
      affected_paths: [
        'src/FlowEngine.ts',
        'src/StageRunner.ts',
        'src/GateController.ts',
      ],
      mitigation: 'Use DiffScopeGuard and architecture baseline review before touching core orchestration files.',
    },
    {
      id: 'defense_bypass',
      title: 'Defense Bypass',
      level: 'critical',
      affected_paths: ['mcp/', 'sentinel/', 'hooks/'],
      mitigation: 'Keep defense changes isolated and require explicit architect approval.',
    },
    {
      id: 'runtime_state_commit_noise',
      title: 'Runtime State Commit Noise',
      level: 'medium',
      affected_paths: ['data/heartbeat.json', 'data/sentinel/', 'data/logs/'],
      mitigation: 'Exclude runtime state from commits or separately review before committing.',
    },
  ];
}

// ============================================================================
// createHarnessV4ArchitectureBaseline
// ============================================================================

/**
 * 基于预设默认值构建 Harness v4 ArchitectureBaseline。
 *
 * mode = 'append' (默认): input 集合追加到默认集合之后
 * mode = 'override': input 集合替代对应默认集合；未传集合保留默认
 * scope 总是做 partial merge
 * metadata 总是追加 generated_by 标识
 */
export function createHarnessV4ArchitectureBaseline(
  input: CreateHarnessV4ArchitectureBaselineInput = {},
): ArchitectureBaseline {
  const mode = input.mode ?? 'append';

  const defaultScope = getDefaultHarnessV4ArchitectureScope();
  const scope: ArchitectureScope = {
    root: input.scope?.root ?? defaultScope.root,
    included_paths: input.scope?.included_paths ?? defaultScope.included_paths,
    excluded_paths: input.scope?.excluded_paths ?? defaultScope.excluded_paths,
  };

  const defaultModules = getDefaultHarnessV4ModuleBoundaries();
  const defaultForbidden = getDefaultHarnessV4ForbiddenZones();
  const defaultDefenses = getDefaultHarnessV4DefenseLines();
  const defaultSurfaces = getDefaultHarnessV4RuntimeSurfaces();
  const defaultRisks = getDefaultHarnessV4BaselineRisks();

  const modules = (mode === 'override' && input.modules)
    ? input.modules
    : [...defaultModules, ...(input.modules ?? [])];

  const forbidden_zones = (mode === 'override' && input.forbidden_zones)
    ? input.forbidden_zones
    : [...defaultForbidden, ...(input.forbidden_zones ?? [])];

  const defense_lines = (mode === 'override' && input.defense_lines)
    ? input.defense_lines
    : [...defaultDefenses, ...(input.defense_lines ?? [])];

  const runtime_surfaces = (mode === 'override' && input.runtime_surfaces)
    ? input.runtime_surfaces
    : [...defaultSurfaces, ...(input.runtime_surfaces ?? [])];

  const risks = (mode === 'override' && input.risks)
    ? input.risks
    : [...defaultRisks, ...(input.risks ?? [])];

  const metadata = {
    ...(input.metadata ?? {}),
    generated_by: 'createHarnessV4ArchitectureBaseline',
  };

  return createArchitectureBaseline({
    id: input.id ?? 'architecture_baseline_harness_v4',
    version: input.version ?? '0.1.0',
    title: input.title ?? 'Harness v4 Architecture Baseline',
    captured_at: input.captured_at,
    scope,
    modules,
    forbidden_zones,
    defense_lines,
    runtime_surfaces,
    risks,
    metadata,
  });
}

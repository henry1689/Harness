# Harness v4.0 升级评价报告

> **评价日期**：2026-08-03  
> **评价基准**：v3.0 设计白皮书 11.1 节「已知局限」+ 硬度阶梯 L1→L4 标准  
> **评价方法**：逐条对照 v4 新增代码、测试覆盖、运行时状态、Sentinel 历史数据

---

## 1. 总体评价

```
Harness v4.0 = v3.0 稳态防线 (运行中)
             + ProjectBrain 感知层 (代码已落地，尚未集成到流水线)
             + 健康检查体系 v2 (1207行独立脚本)
             + 架构基线建模 (纯数据模型，运行时 0 条基线)
             + 意图合约系统 (4 条 P1 意图，全部 implemented)
             + 13 个测试文件 / 4,163 行测试 (覆盖全部新模块)
```

### 核心判断

v4 **不是在 v3 之上叠加新功能**，而是新建了一个**独立的"项目大脑"感知层**。这个感知层已经完成了完整的类型系统设计、纯函数实现、全面测试覆盖和 40+ 份阶段性报告，但**尚未接入 S1→S7 流水线**。它是"建好的引擎放在车库里，还没装到车上"。

**诚实评级：L2 早期阶段（自进化引擎活跃 + 感知层已建模，但集成未完成）**

---

## 2. v3→v4 增量量化

### 2.1 代码规模

| 纬度 | v3.0 | v4.0 新增 | 增长率 |
|------|:--:|:--:|:--:|
| 核心 TS 源文件 | 17 个 | +12 个 (project-brain/) | +71% |
| 测试文件 | 6 个 (vitest) | +13 个 = 19 个 | +217% |
| 测试代码行 | ~1,200 | +4,163 = 5,363 | +347% |
| 测试用例数 | 67 | +351 = 418 | +524% |
| 脚本 | 3 个 | +5 个 | +167% |
| 运行时报告 | 审计日志 | +40+ 份阶段检查点报告 | 新增归档体系 |
| 文档 | 1 份白皮书 | +1 份隔离规则 (726行) | +100% |

### 2.2 Sentinel 拦截趋势（防线压力下降）

| 日期 | 回滚 | 错误 | 趋势 |
|------|:--:|:--:|------|
| 7月30日 | 80 | 305 | 峰值（系统刚上线，Claude 大量绕过） |
| 7月31日 | 42 | 174 | ↓ 47% |
| 8月1日 | 22 | 66 | ↓ 48% |
| 8月2日 | 32 | 101 | ↑（PM2 死掉后 Sentinel 孤军奋战） |
| 8月3日 | 1 | 3 | ↓ 97%（仅烟雾测试触发） |

**解读**：防线压力呈下降趋势，说明 Claude Code 逐渐适应了规则。8月2日的反弹是因为 PM2 进程守护崩溃导致 MCP 不可用、Sentinel 失去后方支持后被动回滚增多。8月3日重启后立即回到正常水平。

---

## 3. 对照 v3 白皮书局限清单逐条评估

### 3.1 已知局限——修复情况

| # | v3 局限 | v4 状态 | 说明 |
|---|------|:--:|------|
| 1 | **S4/S4.5 delegate 依赖 LLM** — 子 Agent 自身可能出错 | ⚠️ 未修复 | ProjectBrain 的类型系统可以作为校验参照，但尚未集成到 S4.5 |
| 2 | **单点 MCP** — 只有一个实例 | ❌ 未修复 | 仍为单实例，但 PM2 自动重启降低了不可用时间窗口 |
| 3 | **Windows 强依赖** — `attrib +R`、Startup 文件夹 | ❌ 未修复 | v4 新增代码为纯 TypeScript，理论上可移植，但 Sentinel 防线仍强依赖 Windows |
| 4 | **CK 检查性能** — git diff 对大型仓库很慢 | ⚠️ 部分修复 | DiffScopeGuard 纯函数判定不需要 git diff，但 CK-09/CK-10 仍未替换 |
| 5 | **规则退化** — 压缩后 CLAUDE.md 规则丢失 | ⚠️ 未修复 | ProjectBrain 的 Store 可以持久化规则状态，但未与压缩恢复流程对接 |
| 6 | **缺少分布式支持** | ❌ 未修复 | 仍为单机架构 |
| 7 | **无可观测性面板** | ⚠️ 部分修复 | `defense-health-check.cjs` 1207 行提供了命令行健康报告（JSON + MD 双输出），但无 Grafana/Dashboard |

**修复率：0/7 完全修复，4/7 部分推进**

### 3.2 攻击面——加固情况

| # | v3 攻击面 | v4 状态 | 说明 |
|---|------|:--:|------|
| 1 | **Git Hook 删除** — `rm .git/hooks/pre-commit` | ⚠️ 部分加固 | 新版 `hooks/pre-commit` 壳脚本 + `hooks/pre-commit.template` 便于恢复，但无自动检测 |
| 2 | **YAML 完整性** — 无篡改检测 | ❌ 未加固 | 仍无 SHA256 校验 |
| 3 | **令牌签名** — 无 HMAC | ❌ 未加固 | 仍为 JSON 明文 |
| 4 | **Sentinel 双实例** — 无互相监控 | ❌ 未加固 | 仍为单实例 |

**加固率：1/4 部分加固，0/4 完全加固**

---

## 4. 新能力深度评估

### 4.1 ProjectBrain 类型系统（types.ts, 286行）

```
能力等级：★★★★☆ 生产级类型设计

定义了完整的数据模型：
- ProjectBrainRoot: 项目大脑顶层结构（project + intents + baselines + evidence + decisions）
- IntentSpec: 意图合约（scope.allowed_paths / forbidden_paths / expected_outputs）
- EvidenceRecord: 证据链（hash/size/MIME/references）
- DecisionRecord: 决策审计（approver/rationale/conditions/overrides）
- RiskSignal: 风险信号（level/reasons/mitigations）
- DiffRecord: 差异记录（git diff 结构化存储）
- 20+ 辅助类型
```

### 4.2 IntentBuilder（intent-builder.ts, 305行）

```
能力等级：★★★★☆ 意图规范化引擎

纯函数，不访问文件系统：
- buildIntentSpec(): 从原始输入构建标准化意图合约
  - ID 生成（intent-{slug} 格式）
  - 路径标准化（反斜杠→斜杠、去重、排序）
  - 风险推断（基于 forbidden_paths 是否存在、文件类型）
  - scope.allowed_paths / forbidden_paths / expected_outputs 结构化
- inferIntentRisk(): 保守推断风险等级
  - 触碰 forbidden zones → high
  - 多文件 / 核心路径 → medium
  - 单文件 / 非核心 → low

测试覆盖: 404 行 (intent-builder.test.ts)
```

### 4.3 DiffScopeGuard（diff-scope-guard.ts, 292行）

```
能力等级：★★★★☆ 差异范围守卫——v4 最主要的新防线组件

纯函数，不访问文件系统：
- evaluateDiffScope(): 基于 IntentSpec.scope 判定 changed_paths 是否越界
  - 支持 strict / advisory 两种模式
  - forbidden 优先于 allowed（禁止 > 允许）
  - overlap warning 检测（allowed ∩ forbidden 包含关系——配置错误）
  - 逐路径匹配记录（matched: 每个 changed_path 的匹配规则）
  - 6 种违规类型: forbidden_path_touched / path_not_in_scope / 
    expected_output_missing / unexpected_file_created / path_pattern_violation /
    scope_definition_ambiguous

输出结构:
  DiffScopeGuardResult {
    allowed: boolean,
    violations: [{ type, path, rule, detail }],
    warnings: [{ type, path, message }],
    matched: [{ path, matched_by, in_allowed, in_forbidden }],
    summary: { changed_count, violation_count, warning_count, ... }
  }

测试覆盖: 330 行 (diff-scope-guard.test.ts)
          + 379 行 (diff-scope-reporter.test.ts)
          + 311 行 (diff-scope-scenario-runner.test.ts)
```

### 4.4 ArchitectureBaseline（architecture-baseline.ts, 418行）

```
能力等级：★★★★☆ 架构基线建模——v4 的理论基础

纯数据模型，定义了 v4 的架构边界与防线拓扑：
- ArchitectureBaseline: 顶层模型（modules + forbidden_zones + defense_lines + runtime_surfaces + risks）
- ModuleBoundary: 模块边界（allowed_dependencies / allowed_dependents / isolation_level）
- ForbiddenZone: 禁止区域（protected / restricted / isolated 三级）
- DefenseLine: 防线定义（layer / type / checks / escalation）
- RuntimeSurface: 运行时表面（可观测的运行时组件）
- BaselineRisk: 基线风险（likelihood × impact 矩阵）

校验器: validateArchitectureBaseline() — 27 条校验规则
构建器: ArchitectureBaselineBuilder — 增量构建模式
快照器: createArchitectureBaseline() — 一次性快照

测试覆盖: 273 行 (architecture-baseline.test.ts)
          + 276 行 (builder.test.ts)
          + 233 行 (reporter.test.ts)
          + 240 行 (snapshot-script.test.ts)
```

### 4.5 Store + Reporter（store.ts + reporter.ts, 573行）

```
能力等级：★★★☆☆ 持久化与报告

Store: 基于内存的 ProjectBrain 存储（为后续文件/SQLite 持久化预留接口）
  - 增删改查 IntentSpec / EvidenceRecord / DecisionRecord
  - 事务性批量操作
  - 快照功能

Reporter: Markdown 报告生成器
  - 意图摘要报告
  - 证据链报告
  - 决策审计报告
  - 差异范围违规报告

测试覆盖: 346 行 (store.test.ts) + 341 行 (reporter.test.ts)
```

### 4.6 defense-health-check.cjs（1207行）

```
能力等级：★★★★★ 生产级健康检查

三道防线专项检查（纯只读操作）：
第一道防线 — MCP Server 闸门:
  - PM2 进程状态（harness-mcp 是否 online）
  - TCP 端口 8765 是否监听
  - HTTP /sentinel/check 端点响应
  - HTTP /sentinel/health 端点响应
  - MCP 心跳文件新鲜度
  - MCP 源码文件完整性（mcp/server.ts, mcp/start.cjs 存在性）

第二道防线 — Sentinel 哨兵:
  - PM2 进程状态（harness-sentinel 是否 online）
  - Sentinel 源码文件完整性（5 个 .cjs 文件）
  - 审计日志活跃度（最后 1 小时内有新文件）
  - 监控目录可达性（D:/tools/wenstar-cc/src/ 存在）
  - 托管项目 git 状态

第三道防线 — Git pre-commit Hook:
  - hooks/pre-commit 文件存在性
  - hooks/pre-commit 可执行性
  - harness-gate.cjs 脚本可用性
  - 令牌目录存在性

全局检查:
  - 令牌目录权限
  - 磁盘使用率
  - 托管项目 git 仓库可达性

输出: JSON + Markdown 双格式报告
```

### 4.7 Git Diff Adapter（git-diff-adapter.ts, 215行）

```
能力等级：★★★☆☆ Git 集成层

- 将 git diff --name-only 输出解析为 DiffScopeGuard 的 changed_paths 输入
- 支持 staged / unstaged / range 三种模式
- 错误处理（非 git 仓库 / 空 diff / 超大 diff 截断）
- 路径标准化
```

---

## 5. 硬度阶梯重新评估

### 5.1 L1→L2 升级条件逐条对照

| # | L1→L2 条件 | v3 基准 | v4 现状 | 达标 |
|---|------|:--:|------|:--:|
| 1 | Sentinel revert ≥ 50 | 177 (累计) | 177 (累计) | ✅ |
| 2 | 违规模式 ≥ 5 | ~3 | ~3 (EvolutionEngine 未运行足够久) | ⚠️ 接近 |
| 3 | 收敛轮次 ≤ 2.5 | N/A (E2E 测试全部首轮通过) | N/A | ✅ |
| 4 | 自动生成标准 ≥ 1 | 0 | 0 (EvolutionEngine 无足够数据) | ❌ |
| 5 | 日均事件 > 5 | ~40 | ~8 (攻击减少) | ✅ |
| **综合** | | | | **3/5 达标 + 1 接近** |

### 5.2 硬度位置判定

```
实际位置:  L1.5 — L2 早期

理由:
  ✅ L1 能力全面验证（S1→S7 全通、三道防线在运行、Sentinel escalation 工作）
  ✅ L2 核心组件已建成（EvolutionEngine + ProjectBrain 感知层）
  ✅ 测试基础设施飞跃（从 6 个测试 → 19 个测试，4,163 行新测试代码）
  ⚠️ 感知层未集成到流水线（ProjectBrain 模块未被 FlowEngine / StageRunner 引用）
  ❌ EvolutionEngine 因 MCP 反复死掉，实际运行时间不足，尚未产出自动规则升级
  ❌ 无跨项目学习能力（仍需人工为每个项目配置 CLAUDE.md）
```

---

## 6. v4 最值得关注的新增能力（Top 5）

### 6.1 DiffScopeGuard — 补齐了 v3 最大的逻辑漏洞

v3 的 Sentinel 只检查"有没有令牌"，但不检查"令牌绑定的文件和实际修改的文件是否一致"——这是v3最大的逻辑漏洞：拿到 `chat.ts` 的令牌后可以改 `FamilyGraph.ts`。

DiffScopeGuard 的 IntentSpec.scope 机制解决了这个问题：意图合约声明 `allowed_paths` 和 `forbidden_paths`，实际改动与合约不符→直接拦截。这是**从"有没有令牌"到"令牌对不对"**的质的升级。

### 6.2 ArchitectureBaseline — 从经验规则到结构化拓扑

v3 的 10 条架构铁律是纯文本描述，没有数据结构支撑。ArchitectureBaseline 将它们转化为可查询、可校验的数据模型——ModuleBoundary、ForbiddenZone、DefenseLine 不再是文字，而是有明确属性和校验规则的实体。

### 6.3 测试覆盖率跃升 — 从"能用"到"可靠"

```
v3: ~1,200 行测试，覆盖 6 个模块
v4: +4,163 行测试，+13 个新模块全覆盖
    测试/源码比 = 4,163/3,341 = 1.25x (测试代码多于实现代码!)
```

这个测试覆盖率意味着 ProjectBrain 不是一个 POC，而是经过了充分验证的工程产物。

### 6.4 defense-health-check.cjs — 可观测性的实质性进步

1207 行的健康检查脚本是 v3 中 178 行 `health-check.cjs` 的 6.8 倍。从简单的端口检查升级到三道防线的逐项验证、JSON+MD 双格式输出、托管项目完整性检查。这是从"能启动"到"能证明在正常运行"的升级。

### 6.5 阶段闸门体系 — 工程方法论本身在进化

v4 的开发过程被拆分为 P0→P1→P2→P3 四个阶段，每个阶段有 **9-14 条 Go/No-Go 条件**，不通过则不能进入下一阶段。P3 阶段实际经历了 **一次 NO_GO**——因发现 2 个意外文件，触发了隔离修复任务（P3-T6R）后才转为 CONDITIONAL_GO。这说明 v4 不只是写代码，而是**用自身的管制方法论在管制自身的开发**。

`docs/v4/upgrade-isolation-rules.md` (726行) 的核心原则是**"先建墙，后装修"**——在动现有防线之前先建立隔离边界。这份文档本身说明 Harness 团队（AI 或人）已经开始用工程化方法管理自身的演进过程了。这是自进化在实践层面的雏形。

---

## 7. 未完成的集成清单（通往真正的 L2）

以下是将 v4 感知层集成到运行中流水线的关键缺口：

| # | 集成点 | 当前状态 | 目标状态 |
|---|------|------|------|
| 1 | **S2→IntentSpec** | S2方案是纯文本 | S2 方案自动解析为 IntentSpec，allowed_paths 由 AI 声明、DiffScopeGuard 校验 |
| 2 | **S3→DiffScopeGuard** | S3 无条件放行 (machine_signal 默认 pass) | S3 落地后立即运行 DiffScopeGuard，改动越界→打回 S2 |
| 3 | **S4→ArchitectureBaseline** | S4 基于 YAML 文本规则评审 | S4 读取 ArchitectureBaseline 数据模型做对照评审 |
| 4 | **S6→EvidenceRecord** | S6 验证结果不结构化 | S6 输出 EvidenceRecord，Hash 锁定修改内容 |
| 5 | **令牌→IntentSpec 绑定** | 令牌仅绑定文件路径 | 令牌绑定 IntentSpec ID，提交时验证改动与意图一致 |
| 6 | **ProjectBrain Store→文件持久化** | Store 仅内存 | Store 落地到 `data/project-brain/project-brain.json` |
| 7 | **MCP → 加载 ProjectBrain 模块** | MCP server.ts 未 import project-brain | MCP 运行时加载 ProjectBrain，DiffScopeGuard 在每个流水线调用时生效 |

---

## 8. 最终评分

| 维度 | v3.0 | v4.0 | 评价 |
|------|:--:|:--:|------|
| **防线可靠性** | ★★★☆☆ | ★★★★☆ | PM2 守护 + 健康检查 v2 大幅提升了存活率 |
| **测试覆盖** | ★★☆☆☆ | ★★★★☆ | 从 6 个测试 → 19 个，1.25x 测试/源码比 |
| **架构感知能力** | ★☆☆☆☆ | ★★★☆☆ | ArchitectureBaseline 建模完成，但未集成 |
| **意图验证能力** | ★☆☆☆☆ | ★★★☆☆ | DiffScopeGuard 实现完成，但未集成 |
| **可观测性** | ★★☆☆☆ | ★★★☆☆ | defense-health-check v2，JSON+MD 双输出 |
| **自进化能力** | ★★☆☆☆ | ★★☆☆☆ | EvolutionEngine 未收集足够数据触发升级 |
| **攻击面防护** | ★★★☆☆ | ★★★☆☆ | 攻击面清单未实质改进 |
| **代码工程化** | ★★☆☆☆ | ★★★★☆ | 类型系统、纯函数、测试金字塔、报告体系 |
| **跨平台可移植性** | ★☆☆☆☆ | ★☆☆☆☆ | 仍强依赖 Windows |
| **综合** | **L1.5** | **L1.8** | 增量显著但集成未完成 |

### 一句话总结

> **v4 是 v3 防线之上的一个高质量感知层，具备清晰的架构设计、充分的测试覆盖和完善的数据模型，但尚未接入运行中的 S1→S7 流水线。一旦完成第 7 节列出的 7 个集成点，Harness 将真正进入 L2 自适应阶段。**

---

> **文档版本**：v1.0  
> **生成日期**：2026-08-03  
> **维护者**：Harness 评估体系  
> **关联文档**：[HARNESS-WHITEPAPER.md](./HARNESS-WHITEPAPER.md) — v3.0 设计白皮书  
> **GitHub**：[henry1689/Harness](https://github.com/henry1689/Harness)

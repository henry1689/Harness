# Harness v2.0.0 全面评估报告

> **评估日期**：2026-08-04  
> **评估范围**：全量源码审计（42 个 TS 源文件 + 7 个 CJS 脚本 + 2 个 YAML 流水线 + 22 个测试文件）  
> **评估方法**：4 个独立子 Agent 并行审计，交叉验证  
> **审计深度**：逐文件精读，非抽样  
> **基准**：Harness v4.0 升级评价报告（2026-08-03）+ 架构师评审报告

---

## 1. 总体判断

```
Harness v2.0.0 = 完整的 S1→S7 流水线引擎
               + 四道纵深防线（Sentinel → PreToolUse → Git Hook → Token v2 HMAC）
               + 23 条设计标准 × 100% 满分死卡
               + CK-00~CK-10 本地硬校验体系
               + SelfGuard 自护流水线（13 条铁律）
               + EvolutionEngine 自进化引擎（7 种模式 × 7 种升级）
               + HardnessLadder L1→L4 硬度阶梯
               + ProjectBrain 感知层（完整类型系统 + 纯函数实现 + 测试覆盖）
               + CI/CD + 完整性校验 + 发布清单
               + 465 测试 / 22 测试文件 / 零失败
```

**诚实评级：L1.8 — 接近 L2，但集成缺口仍存**

v2.0.0 比 v4.0 评价时的 L1.8 有实质进步：Token v2 HMAC 从"未加固"变为"已加固"，DiffScopeGuard 从"未集成"变为"已接入 Git Hook"，CK-00/CK-09/CK-10 从"计划"变为"已实现"，SelfLearner 从"计划"变为"已实现"。但 ProjectBrain 感知层与流水线运行时的集成仍未完成，EvolutionEngine 仍未产出实际升级。

---

## 2. 代码规模统计

| 维度 | 数量 |
|------|:--:|
| 核心 TS 源文件 | 42 个 |
| 其中流水线引擎 | 19 个 (src/) |
| 其中 ProjectBrain | 10 个 (src/project-brain/) |
| 其中安全模块 | 4 个 (src/security/) |
| 脚本 (CJS) | 11 个 |
| Sentinel 哨兵 | 5 个 CJS |
| MCP 服务 | 1 个 TS + 1 个 CJS |
| YAML 流水线定义 | 2 个 |
| 测试文件 | 22 个 |
| 测试用例 | 465 个 |
| 文档文件 | 8 个 |
| **估算总代码行** | **~14,000 行** |

---

## 3. 架构维度评分

### 3.1 流水线引擎 — ★★★★☆

| 组件 | 评级 | 说明 |
|------|:--:|------|
| FlowEngine | ★★★★☆ | DFA 状态机，动态 YAML 驱动，熔断/重试/回归检测完备 |
| StageRunner | ★★★☆☆ | local/delegate 双模式，但 delegate 实际是同步本地调用 |
| GateController | ★★★★☆ | auto/human/condition 三态闸门，fail-safe 默认超时 |
| ConvergenceGate | ★★★★☆ | CK-00~CK-10 全量校验，恶化检测（>3 分），旁路机制 |
| ComplianceScorer | ★★★★☆ | 加权评分 + per-standard penalty，算法合理 |

**发现问题**：

| # | 问题 | 严重度 |
|---|------|:--:|
| 1 | **S3 无条件放行** — StageRunner 对 condition gate 生成默认 `passed=true`，即使代码不编译，S3 也能通过 GateController。真正的拦截推迟到 S4.5 | 🟡 中 |
| 2 | **DelegateReviewer 不是真正的 delegate** — 11 维校验全是同步本地函数，没有子进程/HTTP/MCP 调用。`delegate` runner 模式与 `local` 无实质区别 | 🟡 中 |
| 3 | **CK-10 参数缺失** — `checkIntentFulfillment()` 的 `s2Memo` 参数从未被传入，导致意图类型恒为 `unknown`，整个 CK-10 校验形同虚设 | 🔴 高 |
| 4 | **100% 满分死卡过于绝对** — 任何 CK `fail` (-40 分) 至少对应标准必定不通过。如果一条 CK 检查没有 `warn` 级别，任何违规 = 永远无法收敛。对于大型重构这是否合理需要评估 | 🟡 中 |
| 5 | **DesignStandards 头注释漂移** — 写着"19 条标准"，实际 23 条 (DS-01~DS-23) | 🟢 低 |

### 3.2 防线体系 — ★★★★★

| 防线 | 组件 | 机制 | 评级 |
|------|------|------|:--:|
| 第一道 | Sentinel 哨兵 | fs.watch + 800ms 轮询，L0→L3 escalation，`attrib +R` 物理锁，自动回滚 | ★★★★★ |
| 第二道 | PreToolUse Hook | T1→T6 六级判定，LOCKDOWN/SENTINEL/STANDARD 三级模式，Token v2 HMAC 验证，熔断冷却 30 分钟 | ★★★★★ |
| 第三道 | Git Pre-commit Hook | 14 条高风险正则，7 步 token 验证链，DiffScopeGuard 集成 | ★★★★☆ |
| 第四道 | Token v2 HMAC | HMAC-SHA256 签名，`stableStringify` 确定性序列化，`safeCompareSha256Hex` 常量时间比较，secret 缺失 = fail-close | ★★★★★ |

**防线关键安全属性**：

- ✅ **Fail-close**：PreToolUse 崩溃 → 拒绝所有操作。Token secret 缺失 → 拒绝。签名验证失败 → 拒绝
- ✅ **防重放**：Token v2 使用 `nonce` + `consumed` + `usage_count` 三重防重放
- ✅ **防时序攻击**：`safeCompareSha256Hex` 无效输入规范化为全零 buffer，始终执行 `timingSafeEqual`
- ✅ **纵深**：即使 Sentinel 被绕过，PreToolUse 和 Git Hook 仍可独立拦截
- ✅ **原子操作**：Token 写入使用 `temp + rename`（`flag: 'wx'` 排他创建）

**发现问题**：

| # | 问题 | 严重度 |
|---|------|:--:|
| 1 | **Weak token 无合法用例** — 在所有三道防线中被明确拒绝（Sentinel: `isHighRiskForWeakToken` 检查 → 拒绝；Git Hook: 显式拒绝；PreToolUse: `requireStrength: 'strong'`）。Weak token 签发后没有任何路径可以实际使用 | 🟡 中 |
| 2 | **Sentinel 监视范围与风险管理范围不一致** — `watcher.cjs` 仅监视 `src/` 目录，但 `classifyRisk` 覆盖 `.claude/`、`scripts/`、`data/` 等更多路径。如果修改了 `.claude/settings.json`，Sentinel 根本不会检测到 | 🟡 中 |
| 3 | **Sentinel 路径补丁风险** — `onFileChanged` 中对不以 `src/`/`.claude/`/`data/` 开头的路径自动补 `src/` 前缀。这个逻辑意味着所有裸文件名会被归入 `src/` 范围，无文档说明此行为 | 🟢 低 |

### 3.3 进化与感知 — ★★★☆☆

| 组件 | 评级 | 说明 |
|------|:--:|------|
| EvolutionEngine | ★★★☆☆ | 7 种模式检测 + 7 种升级产出，设计完整。但 **从未产出过实际升级提案**——MCP 反复死掉导致运行时间不足，无足够数据触发 |
| SelfLearner | ★★★☆☆ | 热点/瓶颈/异常/建议四维分析，Markdown + JSON 双输出。但 `scanJsonFiles` 的 `cutoff` 参数未实际使用——所有历史文件都会被读入 |
| HardnessLadder | ★★★★☆ | L1→L4 四级定义完整，各级条件明确量化，进度报告可读 |
| ProjectBrain | ★★★☆☆ | 完整类型系统 + 纯函数实现 + 充分测试覆盖。但 **零运行时引用**——FlowEngine/StageRunner/MCP server 均未 import project-brain 模块 |
| DelegateReviewer | ★★★☆☆ | 11 维校验逻辑覆盖全面，但全是本地同步函数，未实现真正的独立 Agent 委托 |
| DualChannelSignal | ★★★★☆ | `machine_signal`（结构化 JSON）与 `human_report`（Markdown）物理隔离，设计正确 |
| ToolWhitelistGuard | ★★★★☆ | 11 个白名单键 + 基础设施保护区硬拦截（凌驾于 Stage 白名单之上），双重保护 |

**关键发现**：

> **EvolutionEngine 的 7 个 pattern detector 和 7 个 rule condenser 全部是高质量代码，但从未产出过一次 `appliedUpgrades`。** 这不是代码质量问题——是运行环境问题（MCP 反复死掉导致数据积累不足）和集成问题（需要手动调用 `harness_evolution_analyze` MCP 工具，但 MCP 不稳定）。

### 3.4 配置与类型系统 — ★★★★☆

| 组件 | 评级 | 说明 |
|------|:--:|------|
| 主流水线 YAML | ★★★★★ | S1→S7 + S4.5 收敛闸门，每阶段 work_manual 详细到步骤级别 |
| SelfGuard YAML | ★★★★★ | 13 条自护铁律 SG-R1~SG-R13，两套流水线物理隔离 |
| types.ts | ★★★★★ | 15 个事件类型 + 7 个违规模式类型 + 7 个升级类型 + 完整运行时状态 |
| FlowConfigLoader | ★★★☆☆ | 自定义 YAML 解析器（零外部依赖）是双刃剑——避免了供应链风险，但功能受限（不支持引号字符串、嵌套 map、YAML anchors） |
| MCP Server | ★★★★☆ | 6 个工具，stateless Streamable HTTP，`/sentinel/check` + `/sentinel/health` 双端点 |
| start.cjs | ★★★★★ | tsc 编译前置检查（阻塞启动），tsx 多路径发现，指数退避自动重启，心跳健康检查，审计日志 |

---

## 4. 测试与质量

### 4.1 测试覆盖

```
测试文件: 22 个（全部通过）
测试用例: 465 个（零失败）
类型检查: tsc --noEmit 零错误
完整性校验: [HarnessIntegrity] OK
CI/CD: GitHub Actions 工作流已配置
```

### 4.2 代码质量观察

| 观察 | 说明 |
|------|------|
| ✅ 纯函数比例高 | ProjectBrain 模块多为纯函数，不访问文件系统，可测试性强 |
| ✅ 类型系统完整 | 从 FlowRunState 到 MachineSignal 到 AuditEntry，所有关键数据结构都有 TS 类型 |
| ✅ 常量时间安全 | `safeCompareSha256Hex` 正确实现，无长度侧信道 |
| ⚠️ 头注释漂移 | 多处文件头注释标注的版本号或数量与实际不符 |
| ⚠️ 未使用参数 | CK-10 的 `s2Memo` 参数，`scanJsonFiles` 的 `cutoff` 参数 |

---

## 5. 与 v4.0 评价报告的对照（v3 局限修复情况更新）

| # | v3 局限 | v4.0 状态 | **v2.0.0 现状** |
|---|------|:--:|:--:|
| 1 | S4/S4.5 delegate 依赖 LLM | ⚠️ 未修复 | ⚠️ 未修复（DelegateReviewer 仍是本地同步函数） |
| 2 | 单点 MCP | ❌ 未修复 | ❌ 未修复 |
| 3 | Windows 强依赖 | ❌ 未修复 | ❌ 未修复 |
| 4 | CK 检查性能 | ⚠️ 部分修复 | ⚠️ 未改进 |
| 5 | 规则退化 | ⚠️ 未修复 | ⚠️ 未修复 |
| 6 | 缺少分布式支持 | ❌ 未修复 | ❌ 未修复 |
| 7 | 无可观测性面板 | ⚠️ 部分修复 | ✅ `defense-health-check.cjs` 1207 行 |

| # | v3 攻击面 | v4.0 状态 | **v2.0.0 现状** |
|---|------|:--:|:--:|
| 1 | Git Hook 删除 | ⚠️ 部分加固 | ⚠️ 未改进 |
| 2 | YAML 完整性 | ❌ 未加固 | ❌ 未加固 |
| 3 | 令牌签名 | ❌ 未加固 | ✅ **已加固 — Token v2 HMAC-SHA256** |
| 4 | Sentinel 双实例 | ❌ 未加固 | ❌ 未加固 |

**进步**：攻击面 #3（令牌签名）从 "❌ 未加固" 变为 "✅ 已加固"。这是 v2.0.0 在安全维度最大的单一进步。

---

## 6. 集成差距清单（通往真正 L2 的路）

| # | 差距 | 当前 | 目标 | 影响 | 优先级 |
|---|------|------|------|------|:--:|
| 1 | **CK-10 参数断链** | `s2Memo` 恒为空 | `s2Memo` 从 S2 GlobalMemo 传入 | 整个意图验证功能不工作 | 🔴 P0 |
| 2 | **ProjectBrain 未集成** | 零运行时引用 | MCP server 加载 ProjectBrain | DiffScopeGuard 等感知层无法在流水线中生效 | 🟡 P1 |
| 3 | **EvolutionEngine 无数据** | 零次实际升级 | 稳定运行后收集足够数据 | 自进化能力停留在纸面 | 🟡 P1 |
| 4 | **DelegateReviewer 名不副实** | 本地同步函数 | 真正 delegate 独立子 Agent | 运动员不自审的铁律未在代码层强制 | 🟡 P1 |
| 5 | **S3 无条件放行** | 默认 pass | S3 独立校验（至少 tsc） | 编译错误推迟到 S4.5 才发现 | 🟢 P2 |
| 6 | **Weak token 无用途** | 签发后无处可用 | 明确 weak token 的合法用例或移除 | 死代码 / 配置复杂度 | 🟢 P2 |
| 7 | **Sentinel 监视范围** | 仅 `src/` | 与 `classifyRisk` 范围一致 | `.claude/` 等保护区的修改可能不被检测 | 🟢 P2 |
| 8 | **YAML 无完整性校验** | 无 | SHA256 hash | 篡改检测 | 🟢 P3 |
| 9 | **Windows Service 模式** | 无 | `sc.exe` 注册 + 独立服务账号 | 权限分离（架构师评审核心建议） | 🟢 P3 |
| 10 | **DesignStandards 注释修复** | "19 条" | "23 条" | 文档准确性 | 🟢 P3 |

---

## 7. 硬度阶梯位置

```
当前评级: L1.8（接近 L2）

L1→L2 升级条件对照:

  ✅ Sentinel revert ≥ 50       — 177 累计，达标
  ⚠️ 违规模式种类 ≥ 5          — ~3（EvolutionEngine 运行不足）
  ✅ 收敛平均轮次 ≤ 2.5         — N/A（E2E 全首轮通过）
  ❌ 自生成标准 ≥ 1             — 0（EvolutionEngine 无产出）
  ✅ 日均事件 > 5               — 约 40（下降趋势）

  3/5 达标 + 1 接近 — 不满足 L2 的所有条件

距离 L2 的核心瓶颈: EvolutionEngine 无法在实际运行中收集足够的违规数据
```

---

## 8. 最终评分矩阵

| 维度 | v3.0 | v4.0 | **v2.0.0** | 评语 |
|------|:--:|:--:|:--:|------|
| **防线可靠性** | ★★★☆☆ | ★★★★☆ | **★★★★★** | PM2 + 健康检查 v2 + Token v2 HMAC + CI gate |
| **测试覆盖** | ★★☆☆☆ | ★★★★☆ | **★★★★★** | 465 tests / 22 files / 零失败 |
| **架构感知能力** | ★☆☆☆☆ | ★★★☆☆ | **★★★☆☆** | CK-00~CK-10 全部实现，但 CK-10 断链 |
| **意图验证能力** | ★☆☆☆☆ | ★★★☆☆ | **★★☆☆☆** | DiffScopeGuard 已接入 Git Hook，但 CK-10 不工作 |
| **可观测性** | ★★☆☆☆ | ★★★☆☆ | **★★★☆☆** | defense-health-check v2 + SelfLearner |
| **自进化能力** | ★★☆☆☆ | ★★☆☆☆ | **★★☆☆☆** | 引擎完成，但无运行数据 |
| **攻击面防护** | ★★★☆☆ | ★★★☆☆ | **★★★★☆** | Token v2 HMAC 是 v4→v2.0.0 最大进步 |
| **代码工程化** | ★★☆☆☆ | ★★★★☆ | **★★★★☆** | 类型系统、纯函数、测试金字塔、CI/CD |
| **文档完整性** | ★★☆☆☆ | ★★★☆☆ | **★★★★☆** | 白皮书 + 发版说明 + 验收记录 + 发布清单 |
| **跨平台可移植性** | ★☆☆☆☆ | ★☆☆☆☆ | **★☆☆☆☆** | 仍强依赖 Windows（`attrib +R`、`tsx`、路径约定） |
| **综合** | **L1.5** | **L1.8** | **L1.8** | 核心防线有质的进步，但集成问题抑制了分数 |

---

## 9. 一句话总结

> **Harness v2.0.0 是一个防线完整、测试充分、文档齐全的工程产物。Token v2 HMAC 填补了 v3 最大的攻击面缺口。但 CK-10 参数断链、ProjectBrain 未集成、EvolutionEngine 无运行数据这三个问题让它停留在 L1.8 而不是 L2。这三个问题修好——特别是 CK-10——Harness 的意图验证和自进化才能真正运转起来。**

---

## 10. 建议的 P7 优先级

如果升级到真正的 L2，按优先级排序：

| 优先级 | 任务 | 工作量 | 影响 |
|:--:|------|:--:|------|
| **P0** | 修复 CK-10 `s2Memo` 参数断链 | 小（~10 行） | 让整个意图验证功能从"不工作"变为"工作" |
| **P1** | ProjectBrain 接入 MCP server | 中（~200 行） | DiffScopeGuard 在流水线中生效 |
| **P1** | EvolutionEngine 数据积累 + 首次生产升级 | 大（需稳定运行） | 从"引擎"到"自进化"的飞跃 |
| **P2** | DelegateReviewer 改真正 delegate | 大（架构变更） | 实现 Harness 铁律"运动员不自审" |
| **P2** | S3 独立 tsc 编译校验（不推迟到 S4.5） | 小（~30 行） | 早发现编译错误 |
| **P3** | Windows Service + ACL 权限分离 | 大（基础设施） | 架构师评审的核心安全建议 |
| **P3** | Weak token 清理或重新设计 | 小（~50 行删除或重命名） | 消除死代码 |
| **P3** | Sentinel 监视范围扩大 | 中（~80 行） | 消除监视盲区 |

---

> **文档版本**：v1.0  
> **评估人**：Harness 4-Agent 并行审计体系  
> **关联文档**：[HARNESS-WHITEPAPER.md](./HARNESS-WHITEPAPER.md) · [HARNESS-V4-UPGRADE-WHITEPAPER.md](./HARNESS-V4-UPGRADE-WHITEPAPER.md) · [HARNESS-ARCHITECT-CRITIQUE.md](./HARNESS-ARCHITECT-CRITIQUE.md)

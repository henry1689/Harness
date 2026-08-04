# Harness v2.0.0 全方位深度审计报告

> **审计日期**: 2026-08-04  
> **审计范围**: 五维度全覆盖 — 主动管控性 / 稳定性 / 严谨性 / 可靠性 / 自生程序问题  
> **审计方法**: 3 个独立子 Agent 并行审计，零信任视角，逐文件逐行核验  
> **覆盖文件**: 42 个 TS 源文件 + 11 个 CJS 脚本 + 2 个 YAML 流水线 + 22 个测试文件  
> **基准**: [HARNESS-V2.0.0-EVALUATION.md](./HARNESS-V2.0.0-EVALUATION.md) (v2.0.0 功能评估)

---

## 一、总体评价

经过零信任视角的全方位审计，Harness v2.0.0 暴露出 **14 个高风险、18 个中风险、8 个低风险问题**。问题系统性集中在三个领域：

1. **防线不一致** — 风险列表、保护路径、管控粒度在四道防线之间各自独立定义，缺乏单一权威来源
2. **异常处理不统一** — 有的 fail-close、有的 fail-open、有的静默吞异常，同一系统内策略分裂
3. **盲区大于预期** — Sentinel 仅覆盖 `src/`、v1 token 后门仍可被利用、新文件无法回滚

排名前四的风险均可在无高级权限下被利用，建议逐个修复。

---

## 二、🔴 高风险问题（14 项）

### H1. v1 Token 可被完全伪造 — PreToolUse Hook 的后门

**位置**: `.claude/harness-pre-check.cjs:372-423` | **维度**: 主动管控性

`checkPassToken()` 对 `version !== 2` 的 token 直接跳过 HMAC 验证。v1 token 没有任何密码学保护，所有字段（`files`、`expires_at`、`consumed`、`usage_count`、`caller_uuid`）均可被伪造。`caller_uuid` 硬编码为 `sg-mcp-v3-00000000-0000-0000-0000-000000000001`，在 `harness-gate.cjs:413` 和 `harness-pre-check.cjs:413` 中公开可见。

当 `HARNESS_TOKEN_SECRET` 环境变量缺失时（当前生产部署中正是如此），v2 token 签发永远失败，但伪造的 v1 token 可畅通无阻地通过 PreToolUse hook 的验证。

**建议**: 在 `checkPassToken()` 中完全移除 v1 token 支持路径。当 `HARNESS_TOKEN_SECRET` 不可用时，拒绝所有 token（fail-close）。

---

### H2. Sentinel 监视范围仅 `src/`，Harness 自身基础设施无实时保护

**位置**: `sentinel/sentinel-service.cjs:64` | **维度**: 主动管控性

`const watchDir = path.join(projectRoot, 'src')` — 文件系统哨兵只监控 `src/` 目录。这意味着以下所有 Harness 核心文件都不在自动回滚覆盖范围内：

- `.claude/harness-pre-check.cjs` — PreToolUse 防线自身
- `mcp/server.ts` / `mcp/start.cjs` — MCP 服务
- `sentinel/` — 哨兵自身
- `scripts/harness-gate.cjs` — Git hook 防线
- `scripts/defense-health-check.cjs` — 健康检查
- `data/flows/` — 流水线定义

虽然 PreToolUse hook 对这些路径有额外的保护（PROTECTED 列表），但文件系统哨兵是唯一具备主动回滚能力的防线。没有它，Harness 自身的文件被攻击后只能依赖 Git hook（仅在 commit 时触发）或人工发现。

**建议**: 将 `watchDir` 扩展为项目根目录（至少覆盖 `.claude/`、`mcp/`、`sentinel/`、`scripts/`、`hooks/`、`data/flows/`）。

---

### H3. Sentinel 无法回滚未跟踪的新文件

**位置**: `sentinel/rollback.cjs:97-112` | **维度**: 主动管控性

回滚使用 `git checkout -- "${filePath}"`。对于 git 未跟踪（untracked）的新文件，`git checkout` 不会删除它——新文件不在版本库中。验证逻辑检测到 `afterStatus` 非空后返回 `reverted: false`。

攻击者可创建 `src/evil.ts`，Sentinel 检测到变更后尝试 checkout 失败，文件保留。此时唯一剩下的防线是 Git hook（仅在 commit 时触发），而攻击者可以**从不提交该文件**——它能持续存在于磁盘上，由其他构建/测试流程执行。

**建议**: 当回滚后文件仍存在且为 untracked 时，执行 `fs.unlinkSync()` 或 `git clean -f` 删除。

---

### H4. `isTrivialChange` 仅基于声明，不校验实际改动规模

**位置**: `src/RiskClassifier.ts:132-146` | **维度**: 主动管控性

`isTrivialChange()` 判定"微小修改"的依据是：
1. 所有文件路径都是 `low` 风险
2. 消息文本包含 `typo|format|comment|minor` 等关键词
3. 文件数不超过 1 个

**完全没有检查实际的 diff 行数**。Agent 说 "fix typo in src/config.ts" 但实际修改 100 行代码，系统仅凭消息文本就放行 free mode 跳过整个流水线。管控完全依赖 Agent 的诚实声明而非客观事实。

**建议**: 增加 `git diff --stat` 检查，超过阈值（如 +20/-20 行）则拒绝 free mode。

---

### H5. MCP 退避计数器在 `startChild()` 内被同步清零，永远 1s 重启

**位置**: `mcp/start.cjs:80-83, 137-139, 153` | **维度**: 稳定性

退避逻辑有严重的实现 bug：

1. `exit` 事件触发时 `consecutiveFails++`（行 139）
2. 然后立即调用 `startChild()`（行 139 的 setTimeout）
3. `startChild()` 的第 153 行**同步执行** `consecutiveFails = 0`

这导致退避计数在每次重启前都被清零，永远停留在 1s。如果 MCP server 每 30s 崩溃一次，它将以 1s 间隔连续重启（而非预期的 1s→2s→4s→8s→16s→32s 退避），形成快速重启循环。

**建议**: 将 `consecutiveFails` 的重置移到子进程首次心跳成功后，而非 `fork()` 调用返回后。

---

### H6. `FlowEngine.handleError()` 不回滚 S3 已修改文件

**位置**: `src/FlowEngine.ts:511-531` | **维度**: 稳定性

当 S4 阶段或后续阶段抛异常时，`handleError()` 做以下事情：
1. 设置状态为 `aborted`
2. 写审计日志
3. 关闭 ToolWhitelistGuard
4. 返回失败结果

**它不执行任何文件回滚**。如果 S3 已完成代码修改，S4 随后因架构评审异常而崩溃，已修改的文件保持在被修改状态——通过了编译但未通过评审。此时代码库处于不一致状态，依赖 Sentinel 的异步扫描来恢复。如果 Sentinel 恰好不可用（如因为它只监视 `src/` 而修改的是 `mcp/`），回滚永远不会发生。

**建议**: `handleError()` 中增加 `git checkout -- <modified_files>` 或至少标记需要回滚。

---

### H7. `harness-gate.cjs` fail-open vs 其他防线 fail-close 不一致

**位置**: `scripts/harness-gate.cjs:205-209` | **维度**: 可靠性

当 `git diff --cached --name-only` 失败时，harness-gate 执行 `process.exit(0)` 放行提交。

但在同一系统内：
- PreToolUse hook 崩溃 → `{ decision: 'deny' }` — **fail-close**
- Token v2 secret 不可用 → `allowed: false` — **fail-close**
- Sentinel HTTP 调用失败 → 降级后 `allowed: false` — **fail-close**

这种跨防线的不一致意味着：如果攻击者在 pre-commit 阶段刻意制造 git 命令失败（如破坏 `.git` 目录），所有防线中最靠近提交点的一道会静默放行。

**建议**: Git 命令失败时也执行 `process.exit(1)` 拒绝提交，与其他防线保持一致。

---

### H8. Sentinel 批量窗口可被 DoS 无限延长

**位置**: `sentinel/sentinel-service.cjs:208-213` | **维度**: 严谨性

```javascript
if (batchTimer) clearTimeout(batchTimer);
batchTimer = setTimeout(() => { batchTimer = null; flushBatch(); }, 500);
```

每次文件变更都重置 500ms 定时器。如果攻击者每 400ms 修改一个文件，定时器永远不被触发，`batchQueue` 无限增长，所有修改永久不被回滚。`batchQueue` 没有上限检查，最终导致内存耗尽。

**建议**: 增加 `batchQueue` 的最大长度限制（如 100），超限时强制 `flushBatch()`。

---

### H9. CK 检查单点故障 → 后续全部被跳过 → 缺失结果当作满分

**位置**: `src/ConvergenceGate.ts:157-178` + `src/ComplianceScorer.ts:155-157` | **维度**: 严谨性

全部 12 个 CK 检查在一个 `try/catch` 块中。如果 CK-03 抛异常（如文件被删除），异常被捕获后函数返回只含 2 条结果的数组。CK-04~CK-10 全部被跳过。

关键后果在 `ComplianceScorer.ts:155-157`：
```typescript
if (!ck) continue; // 该 CK 未被触发 → 视为通过
```

缺失的 CK 检查结果被**静默当作满分**处理。如果 CK-04（UUID 全链路标注）被跳过，关联的 DS-04~DS-05 等标准获得 100 分——即使实际代码可能有严重的 UUID 问题。

**建议**: 每个 CK 检查独立 try/catch；被跳过的 CK 标记为 `severity: 'error'`（最高扣分）而非视为"通过"。

---

### H10. 高风险文件列表在四处独立定义，严重不一致

**位置**: 交叉引用 4 个文件 | **维度**: 自生问题

| 文件 | 条目数 | 形式 |
|------|:--:|------|
| `RiskClassifier.ts:14-21` | 6 | 精确路径匹配 |
| `harness-gate.cjs:50-65` | 14 | 正则模式 |
| `sentinel-mcp-client.cjs:29-52` | 42+ | 精确路径+目录前缀 |
| `server.ts:474-497` | 50+ | 精确路径+目录前缀 |

具体差异：`harness-gate.cjs` 独有覆盖 `src/FlowEngine.ts`、`src/StageRunner.ts`、`src/GateController.ts`、`src/main_harness_checker.ts`、`mcp/`、`sentinel/`、`data/flows/`——这些在另外三处中完全不出现。`RiskClassifier.ts` 仅覆盖 6 个文件，是最窄的清单。

这意味着同一个文件在不同防线上被不同等级对待：`src/m4/M4Orchestrator.ts` 在 RiskClassifier 中不是高风险（可能是 mid），但在 Sentinel 和 Git hook 中是高风险。

**建议**: 抽取为 `data/high-risk-files.json` 单一配置文件，所有组件运行时加载。

---

### H11. 硬编码绝对路径遍布项目，不可移植

**位置**: 14 个文件，清单见附录 | **维度**: 自生问题

以下非注释/非文档的硬编码路径在任何其他机器上直接失效：

- `ecosystem.config.cjs` — `D:/AI文件/harness`、`D:/tools/wenstar-cc`
- `start-services.cjs` — `D:/tools/wenstar-cc`
- 所有 `.claude/*.cjs` — 多处 `D:/AI文件/harness`
- `scripts/defense-health-check.cjs` — `D:/tools/wenstar-cc`、`D:/wenstar/wenstar_os`
- `data/flows/wenstaros_core_repair_flow.yaml` — 5 处 `D:/AI文件/harness`
- `sentinel/escalation.cjs` — `D:/AI文件/harness`

部分通过 `process.cwd()` 或 `HARNESS_PROJECT_ROOT` 环境变量解决了（如 `server.ts`），但 `.claude/` 目录下的 hook 脚本和 `ecosystem.config.cjs` 完全硬编码。

**建议**: 所有路径改为基于 `process.cwd()` 的运行时解析，删除绝对路径引用。

---

### H12. Sentinel `checkFile()` 无异常处理，崩溃风险

**位置**: `sentinel/sentinel-mcp-client.cjs:173-208` + `sentinel-service.cjs:131-140` | **维度**: 可靠性

`checkFile()` 和 `processFileChange()` 函数体均无 try/catch 包裹。如果 `classifyRisk()` 或路径标准化函数抛异常（例如罕见的 edge case），异常会传播为 unhandled rejection，导致整个 Sentinel 进程崩溃。

**建议**: 在 `processFileChange()` 外层加 try/catch + 错误日志。

---

### H13. `HARNESS_TOKEN_SECRET` 未在任何启动脚本中设置

**位置**: `ecosystem.config.cjs`、`mcp/start.cjs`、`start-services.cjs` 均缺失 | **维度**: 可靠性

Token v2 的 HMAC 签名依赖 `HARNESS_TOKEN_SECRET` 环境变量（至少 32 字节）。该变量未在 `ecosystem.config.cjs`（PM2 的 `env` 字段）、`mcp/start.cjs`（fork 的 `env` 对象）、`start-services.cjs` 中的任何位置设置。项目中也不存在 `.env` 文件。

**实际效果**: 每次 MCP server 启动后，流水线执行成功但 token 签发永远失败（异常被 catch 吞掉）。所有防线检测不到 token，一律拒绝。部署后系统**事实上不可用**。

**建议**: 在 `ecosystem.config.cjs` 的 `env` 中添加 `HARNESS_TOKEN_SECRET`，启动时如果缺失给出明确报错。

---

### H14. Secret 缺失时安全降级到 v1 明文模式

**位置**: `scripts/harness-gate.cjs:278-288` + `token-verify.cjs:276-277` | **维度**: 可靠性

当 `isTokenSecretAvailable()` 返回 false 时（即 H13 的情况），harness-gate 跳过 v2 token 的 HMAC 验证（`continue`）。此时 v2 token 无法通过验证，但 v1 token（明文无签名）仍可被接受。系统从"密码学签名验证"降级到"无验证的明文匹配"。

**建议**: 当 secret 不可用时，完全拒绝所有 token（包括 v1）。在 harness-gate 中增加 `if (!tokenVerify.isTokenSecretAvailable()) process.exit(1)`。

---

## 三、🟡 中风险问题（18 项）

### M1. Free mode 三道防线风险判定不一致
**位置**: `FlowEngine.ts:494-505`, `harness-pre-check.cjs:36-58`, `sentinel-mcp-client.cjs:63-65`  
当 RiskClassifier 判 low 放行 free mode 后，PreToolUse 和 Sentinel 使用各自的 LOW_RISK_PREFIXES 重新判定。三者列表不完全一致，可能导致"流水线说可以改，但 hook 不让"的矛盾信号。

### M2. S1 gate_type=auto，全局审视无人审核
**位置**: `data/flows/wenstaros_core_repair_flow.yaml:119`  
S1 分析完成自动跳转 S2，无人审核 S1 分析结果完整性。漏掉的关键耦合点或 FG 红线会穿透到全程。

### M3. `harness-gate.cjs` 的 `tokenCoversFile` 不识别 v2 特定字段
**位置**: `scripts/harness-gate.cjs:141-171`  
只检查 `file`/`files`/`allowed_files`，不识别 `allowed_paths` 和 `forbidden_paths`。虽然后续 `verifyTokenV2()` 会补全验证，但如果在 v1 降级路径中执行会遗漏。

### M4. Sentinel 忽略 `__tests__` 目录
**位置**: `sentinel/watcher.cjs:28-31`  
`shouldWatch` 跳过 `__tests__` 和 `.test.ts` 文件。攻击者可在测试中注入恶意代码而 Sentinel 不检测。

### M5. Token TTL 声明与实际不一致
**位置**: `token-types.ts:141` (15min) vs `server.ts:281` ("2 hours")  
Agent 被告知 2 小时实际只有 15 分钟，会在过期后尝试写入时被拒绝。

### M6. 心跳健康检查无进程活性确认
**位置**: `mcp/start.cjs:172-188`  
健康检查在读取心跳文件和 kill 进程之间没有做 `child.connected` 检测。文件系统冻结可能导致误杀。

### M7. `start-services.cjs` 启动的 Sentinel 无重启守护
**位置**: `start-services.cjs:107-139`  
`spawn('node', ...)` 启动的 Sentinel 崩溃后不会自动重启。仅 PM2 模式有重启保障。

### M8. EvolutionEngine 定时器未 unref，MCP 关闭时未清理
**位置**: `EvolutionEngine.ts:186,189` + `server.ts:466-467`  
`setInterval` 未调用 `unref()`，阻止事件循环退出。`server.ts` 的 SIGTERM handler 中未调用 `evolutionEngine.stop()`。

### M9. `readToken` 异常语义混淆
**位置**: `security/token-store.ts:111-113`  
磁盘 IO 错误、JSON 解析失败、文件不存在三种情况统一返回 `null`，调用方无法区分。

### M10. `GlobalMemoStore.save()` 无原子写
**位置**: `GlobalMemoStore.ts:93`  
使用 `writeFileSync` 直接覆盖，没有 temp+rename 保护。写入中途崩溃会留下损坏文件。

### M11. `atomicWrite` 的 temp 残留无清理
**位置**: `token-store.ts:223-226`  
`flag: 'wx'` 排他创建，崩溃残留的 `.tmp` 文件会导致后续 `EEXIST` 错误且无人清理。

### M12. EvolutionEngine `scanDirectories` 无并发防护
**位置**: `EvolutionEngine.ts:186`  
前一次扫描超时时新 interval 触发导致状态重叠，`knownFiles` Set 可能丢失新文件。

### M13. MCP `files` 参数无路径遍历/大小校验
**位置**: `server.ts:168-173`  
可传入 `['../../../etc/passwd']`、`['/dev/null']`、10000 个文件，无任何输入沙箱。

### M14. `sentinel-mcp-client.cjs:137` 整块吞异常
**位置**: `sentinel-mcp-client.cjs:99-138`  
`checkTokenLocal` 的全部逻辑被 `try { ... } catch (_) { return null }` 包裹。正常业务流程中的 I/O 错误被静默当作"无令牌"处理，合法修改被拒绝。

### M15. Sentinel 审计写失败静默
**位置**: `sentinel-service.cjs:224`  
审计归档 `writeFileSync` 失败时被静默吞掉，无 `console.error`，审计轨迹丢失不可追溯。

### M16. `NativeCommands.ts` 暴露宿主项目函数
**位置**: `NativeCommands.ts:48,85,99`  
`tscCheck`、`webuiStart`、`safeBackfill` 通过核心模块的公开 API 导出，但它们是 WenStarOS 宿主的命令，不属于 Harness 通用调度引擎。

### M17. Sentinel REST 端点与 Token v2 UUID 命名不兼容
**位置**: `server.ts:555`  
`/sentinel/check` 端点使用 v1 的 `hashCode(filePath)` 查找 token 文件。Token v2 使用 UUID 命名，不会被找到。该端点只能发现 v1 格式的 token。

### M18. `import.meta.dirname` 与 `__dirname` 混用不一致
**位置**: 多个文件  
`server.ts` 用 `import.meta.dirname!`（ESM only），`AuditLogger.ts` 用 `__dirname`（CJS only），`FlowConfigLoader.ts` 做了兼容降级。切换构建方式时可能出错。

---

## 四、🟢 低风险问题（8 项）

1. **L1** - `convergence_round` 防御代码冗余 (`ConvergenceGate.ts:149`)
2. **L2** - `tokenPath()` Unicode 同形字符绕过（当前不可利用）(`token-store.ts:208`)
3. **L3** - YAML 解析器无原型污染风险（自定义解析器不支持危险标签）(`FlowConfigLoader.ts`)
4. **L4** - `stableStringify()` 无循环引用防护（当前对象不含循环）(`token-canonicalize.ts:53`)
5. **L5** - `encodeMachineSignal`/`decodeMachineSignal` 死代码 (`DualChannelSignal.ts:59,67`)
6. **L6** - `harness_list_flows` 自动发现正常但默认 flow 硬编码 (`server.ts:178`)
7. **L7** - MCP free mode 响应缺少 `token_issued` 字段 (`server.ts:204-208`)
8. **L8** - PROTECTED 列表在 MCP server 和 PreToolUse hook 间有小差异 (`server.ts:45-48` vs `harness-pre-check.cjs:30-32`)

---

## 五、建议修复优先级

按"攻击可利用性 / 修复难度 / 影响范围"三维加权排序：

### P0 — 立即修复（单文件、攻击面已暴露）

| # | 问题 | 文件 | 修改量 |
|:--:|------|------|:--:|
| 1 | **移除 v1 token 支持** — PreToolUse hook 中的可伪造后门 | `harness-pre-check.cjs` | ~10 行 |
| 2 | **harness-gate fail-open→fail-close** | `harness-gate.cjs` | ~3 行 |
| 3 | **添加 HARNESS_TOKEN_SECRET 配置** | `ecosystem.config.cjs` + `start.cjs` | ~5 行 |
| 4 | **Secret 缺失时拒绝所有 token** | `harness-gate.cjs` + `token-verify.cjs` | ~5 行 |
| 5 | **Sentinel 批量窗口上限** | `sentinel-service.cjs` | ~5 行 |

### P1 — 本周修复（2-3 文件、功能增强）

| # | 问题 | 修改量 |
|:--:|------|:--:|
| 6 | **isTrivialChange 增加 diff 行数检查** | ~20 行 |
| 7 | **CK 检查独立 try/catch** | ~30 行 |
| 8 | **Sentinel untracked 文件清理** | ~15 行 |
| 9 | **MCP 退避计数器修复** | ~5 行 |
| 10 | **高风险列表统一到单一配置文件** | ~100 行 |

### P2 — 本月修复（架构改动）

| # | 问题 | 修改量 |
|:--:|------|:--:|
| 11 | **Sentinel 监视范围扩展** | ~10 行 + 测试 |
| 12 | **FlowEngine.handleError 文件回滚** | ~30 行 |
| 13 | **Sentinel checkFile 异常处理** | ~10 行 |
| 14 | **Token TTL 声明修正** | ~3 行 |
| 15 | **硬编码路径全量替换** | ~100 行（多文件） |
| 16 | **GlobalMemoStore 原子写** | ~15 行 |
| 17 | **EvolutionEngine 清理 + unref** | ~10 行 |

### P3 — 下个版本

| # | 问题 |
|:--:|------|
| 18 | `NativeCommands.ts` 宿主项目函数分离 |
| 19 | Sentinel REST 端点适配 Token v2 UUID |
| 20 | ESM/CJS 路径 API 统一 |
| 21 | `readToken` 异常分类 |
| 22 | 低风险死代码清理 |

---

## 六、系统性改善建议

三份审计报告中的发现揭示了几个跨领域模式：

1. **单一权威来源（Single Source of Truth）**  
   高风险文件列表、保护路径、风险分类规则目前以不同形式散布在 5+ 个文件中。应统一抽取为 `data/risk-policy.json`，所有防线组件在启动时加载并缓存。

2. **全线 fail-close 策略**  
   当前 `/sentinel/*` fail-close、`harness-gate.cjs` fail-open、`harness-pre-check.cjs` fail-close 的情况应统一。防线的铁律应该是：**不确定 → 拒绝**。

3. **异常处理三板斧**  
   所有静默吞异常的 `catch (_)` 需要三选一：① 加 `console.error` 日志；② 显式注明"静默合理"及原因；③ 重新 throw 或转为 fail-close。

4. **防御深度的一致性**  
   `RiskClassifier.ts`、`harness-pre-check.cjs`、`sentinel-mcp-client.cjs` 三者之间的 risk class 列表应保持一致。一个防御者的"high"不应是另一个防御者的"mid"。

5. **启动完整性检查**  
   `start.cjs` 应在 fork 前检查所有必需环境变量（`HARNESS_TOKEN_SECRET`、`HARNESS_MCP_PORT` 等），缺失时给出明确错误而非静默降级。

---

## 附录 A：硬编码路径完整清单

| # | 文件 | 硬编码路径 |
|:--:|------|------|
| 1 | `ecosystem.config.cjs:27,28,38,39,46,56,57,63,64` | `D:/AI文件/harness`, `D:/tools/wenstar-cc` |
| 2 | `start-services.cjs:29` | `D:/tools/wenstar-cc` |
| 3 | `scripts/health-check.cjs:17` | `D:/tools/wenstar-cc` |
| 4 | `scripts/defense-health-check.cjs:54,55` | `D:/tools/wenstar-cc`, `D:/wenstar/wenstar_os` |
| 5 | `scripts/baseline-report.cjs:36,37` | `D:/tools/wenstar-cc`, `D:/wenstar/wenstar_os` |
| 6 | `scripts/pm2-recover.cjs:131` | `D:/tools/wenstar-cc` |
| 7 | `.claude/harness-auto-start.cjs:106` | `D:/tools/wenstar-cc` |
| 8 | `.claude/harness-pre-check.cjs:130,603,623` | `D:/AI文件/harness` |
| 9 | `.claude/harness-post-check.cjs:60` | `D:/AI文件/harness` |
| 10 | `.claude/harness-verify-startup.cjs:47-49,139,...` | 多处 `D:/AI文件/harness`, `D:/AI文件/SelfGuard` |
| 11 | `sentinel/escalation.cjs:215` | `D:/AI文件/harness` |
| 12 | `src/project-brain/architecture-baseline-builder.ts:216,217` | `D:/tools/wenstar-cc`, `D:/wenstar/wenstar_os` |
| 13 | `data/flows/wenstaros_core_repair_flow.yaml:97,103,235,319,373` | `D:/AI文件/harness` |
| 14 | `.claude/harness-pre-check.cjs:128,167` | 旧项目路径 `wenstar-cc`, `wenstar_os`, `WenstarOSTianquan` |

---

> **报告版本**: v1.0  
> **审计引擎**: 3 独立子 Agent × 零信任视角  
> **关联文档**: [HARNESS-V2.0.0-EVALUATION.md](./HARNESS-V2.0.0-EVALUATION.md) · [HARNESS-ARCHITECT-CRITIQUE.md](./HARNESS-ARCHITECT-CRITIQUE.md)

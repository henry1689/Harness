# Harness P7 — 收官优化方案

> **制定日期**: 2026-08-04  
> **基准**: [深度审计报告](HARNESS-V2.0.0-DEEP-AUDIT.md) 剩余问题 + [P4-D 延期项](HARNESS-V4-UPGRADE-WHITEPAPER.md) + [v2.0.0 评估](HARNESS-V2.0.0-EVALUATION.md) 集成缺口  
> **定位**: P4/P5/P6 已解决核心安全漏洞和控制逻辑缺陷，P7 是收官阶段——消除剩余盲区、统一基础设施、补齐运维能力  
> **总工作量**: 4 阶段 × 约 200 行/阶段 ≈ **800-1000 行**，预计 **4-6 小时**

---

## 当前状态回顾

P4（运行时加固 + Token v2 + DiffScopeGuard）、P5（五项修复）、P6（12 项安全加固）已连续三个回合将 Harness 从 L1.5 推到 L1.8+。

**P6 后的残余清单**：

| 等级 | 已修复 | 待 P7 |
|:--:|:--:|:--:|
| 🔴 高风险 (14) | 11 | **3** (H2 Sentinel 盲区 / H6 handleError 不回滚 / H11 硬编码路径) |
| 🟡 中风险 (18) | 3 | **15** |
| 🟢 低风险 (8) | 0 | **8** |
| 📦 P4-D 延期 | 0 | **3** (Windows Service / ACL / 管道瘦身) |

---

## 四阶段路线图

```
P7-A: Sentinel 盲区消除  ──▶  P7-B: 流水线缺陷修复  ──▶  P7-C: 持久化与资源  ──▶  P7-D: 运维基础设施
   (防线覆盖完整性)              (管控逻辑严密性)              (运行时可靠性)              (可移植性+可运维性)
```

---

# P7-A: Sentinel 盲区消除

> **目标**: Sentinel 防线覆盖盲区清零。三道防线的风险分类从 `data/risk-policy.json` 统一加载。

---

### A1. Sentinel 监视范围扩展至全项目根目录

**问题**: `sentinel-service.cjs:64` — `watchDir = path.join(projectRoot, 'src')`。Harness 自身的 `.claude/`、`mcp/`、`sentinel/`、`scripts/`、`hooks/`、`data/flows/` 全不在实时回滚覆盖内。

**方案**:

```javascript
// 旧: const watchDir = path.join(projectRoot, 'src');
// 新: 监控多目录
const WATCH_ROOTS = [
  'src/',
  '.claude/',
  'mcp/',
  'sentinel/',
  'scripts/',
  'hooks/',
  'data/flows/',
];
```

`watcher.cjs` 的 `createWatcher` 改为支持多目录监控（对每个 `WATCH_ROOTS` 调用 `fs.watch` + 轮询）。

**防护逻辑**: `classifyRisk` 已覆盖这些路径（`PROTECTED` + `HIGH_RISK` 列表），扩展监视后回滚能力自然跟随。

**文件**: `sentinel-service.cjs`, `sentinel/watcher.cjs`

**工作量**: ~60 行

---

### A2. `__tests__` 目录监控开关

**问题**: `watcher.cjs:28-31` — `IGNORE_DIRS` 包含 `__tests__`，所有测试文件被 Sentinel 完全忽略。测试文件中的恶意代码同样具有执行能力。

**方案**: 不直接删除 `__tests__` 排除——在大多数场景下跳过测试文件是合理的性能优化。改为：

```javascript
// 通过环境变量控制
const MONITOR_TESTS = process.env.HARNESS_SENTINEL_MONITOR_TESTS === '1';
```

默认跳过（保持现有行为），CI/CD 和严格模式可开启。

**文件**: `sentinel/watcher.cjs`

**工作量**: ~10 行

---

### A3. `start-services.cjs` Sentinel 崩溃重启守护

**问题**: `start-services.cjs:107-139` 通过 `spawn('node', ...)` 启动 Sentinel，崩溃后无自动重启。与 PM2 模式不一致。

**方案**: 将 `start-services.cjs` 中的 `startSentinel()` 改为与 `start.cjs` 相同的模式——`spawn` 替代为带退避的 `fork` + 自动重启循环。

```javascript
// 与 start.cjs 的模式保持一致
function startSentinel() {
  const child = fork(sentinelPath, sentinelArgs, { stdio: 'pipe' });
  child.on('exit', (code, signal) => {
    if (signal === 'SIGTERM' || signal === 'SIGINT') return;
    consecutiveSentinelFails++;
    const delay = backoffDelay(consecutiveSentinelFails);
    setTimeout(() => startSentinel(), delay);
  });
}
```

**文件**: `start-services.cjs`

**工作量**: ~30 行

---

### A4. `sentinel-mcp-client.cjs` 异常处理改进

**问题**: `checkTokenLocal` 的全部逻辑被 `try { ... } catch (_) { return null }` 包裹。正常业务流程中的 I/O 错误被静默当作"无令牌"。

**方案**: 将 catch 块改为日志输出 + 明确返回原因，而非笼统的 `null`：

```javascript
} catch (err) {
  console.error(`[sentinel] checkTokenLocal 异常: ${err.message} (file: ${filePath})`);
  return null;  // 仍返回 null（fail-close），但日志可追踪
}
```

同时也包裹 `checkViaHTTP` 的调用方以区分"网络不可达"和"令牌无效"。

**文件**: `sentinel/sentinel-mcp-client.cjs`

**工作量**: ~10 行

---

### A5. Sentinel REST 端点适配 Token v2 UUID 命名

**问题**: `server.ts:555` — `/sentinel/check` 端点使用 v1 的 `hashCode(filePath)` 查找 token 文件 (`data/tokens/<hash>.json`)。Token v2 使用 UUID 命名，该端点找不到 v2 token。

**方案**: 增加 v2 token 查找回退——遍历 `data/tokens/` 中所有 `.json` 文件，解析后匹配 `token.files` 或 `token.allowed_paths`（或直接调用 `TokenStore.verifyToken`）。

```typescript
// 回退：遍历所有 token 文件，用 TokenStore 验证
const tokenFiles = readdirSync(tokenDir).filter(f => f.endsWith('.json'));
for (const tf of tokenFiles) {
  const token = JSON.parse(readFileSync(join(tokenDir, tf), 'utf-8'));
  const result = tokenStore.verifyToken({ token_id: token.token_id, target_file: filePath });
  if (result.allowed) return { allowed: true, ... };
}
```

**文件**: `mcp/server.ts`

**工作量**: ~30 行

---

### P7-A 验证

```
1. Sentinel 启动后修改 .claude/harness-pre-check.cjs → 应该被检测到并回滚
2. 修改 sentinel/watcher.cjs 自身的脚本 → 应该被检测到
3. /sentinel/check POST 传入高风险文件路径 → 应该返回 token 验证结果（包含 v2 UUID 令牌）
4. start-services.cjs 启动 Sentinel → kill 子进程 → 应该自动重启
```

---

# P7-B: 流水线缺陷修复

> **目标**: 关闭 S1 无人审核、free mode 防滥用、handleError 回滚等管控逻辑缺陷。

---

### B1. FlowEngine.handleError 文件回滚

**问题**: `FlowEngine.ts:511-531` — S3 修改的文件在 S4 异常时不被回滚，代码库处于"已修改但未通过评审"的不一致状态。

**方案**: 在 `handleError` 中增加回滚尝试（仅在流水线真正修改过文件后）：

```typescript
private handleError(...) {
  // ... 现有的状态设置 + 审计日志 + deactivate ...
  
  // P7: 尝试回滚 S3 阶段已修改的文件
  if (this.state.modified_files?.length > 0) {
    try {
      for (const f of this.state.modified_files) {
        execSync(`git checkout -- "${f}"`, { cwd: this.state.project_root, timeout: 5000 });
      }
      console.error('[FlowEngine] ↩ error handler 已回滚 ' + this.state.modified_files.length + ' 个文件');
    } catch (rollbackErr) {
      console.error('[FlowEngine] ⚠️ 自动回滚失败（可能需手动恢复）:', (rollbackErr as Error).message);
    }
  }
  // ...
}
```

**文件**: `src/FlowEngine.ts`

**工作量**: ~15 行

**注意**: 需要先 import `execSync`（FlowEngine 当前可能没有直接引用）。

---

### B2. 风险分类统一到 `data/risk-policy.json`

**问题**: `RiskClassifier.ts`、`sentinel-mcp-client.cjs`、`server.ts` 三者各自独立定义高风险列表。P6 已创建 `data/risk-policy.json` 作为单一权威来源，但尚未被实际加载。

**方案**: 

1. `RiskClassifier.ts` — 在 `classifyFile()` 中从 `data/risk-policy.json` 动态加载，替代硬编码的 `HIGH_RISK_FILES` Set
2. `sentinel-mcp-client.cjs` — 在 `classifyRisk()` 中加载同一文件
3. `harness-pre-check.cjs` — 在 `run()` 中加载同一文件（替代 `HIGH_RISK`、`LOW_RISK_PREFIXES` 等硬编码数组）
4. `harness-gate.cjs` — 在 `main()` 中加载 `harness_self_protect` 列表，替代 `HIGH_RISK_PATTERNS` 正则

实现一个共享的 CJS loader 函数：

```javascript
// scripts/risk-policy-loader.cjs (新文件)
let _cache = null;
function loadRiskPolicy() {
  if (_cache) return _cache;
  const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'risk-policy.json'), 'utf-8');
  _cache = JSON.parse(raw);
  return _cache;
}
module.exports = { loadRiskPolicy };
```

各防线组件 import 此 loader 替代硬编码列表。启动时一次性加载，运行时不重新读取。

**文件**: `scripts/risk-policy-loader.cjs` (新) + `RiskClassifier.ts` + `sentinel-mcp-client.cjs` + `harness-pre-check.cjs` + `harness-gate.cjs`

**工作量**: ~100 行

---

### B3. S1 gate_type 改为 condition（带 CK-00 前置检查）

**问题**: `wenstaros_core_repair_flow.yaml:119` — S1 的 `gate_type: auto`，全局审视完成后无人审核即流入 S2。

**方案**: 这不是一个简单的一行改动——S1 进入 S2 需要人工确认 S1 分析的完整性和准确性。但当前 S2 已经是 human gate，在 S2 增加一项检查即可：**S2 human gate 必须确认 S1 的 CK-00 输出完整性**（牵连清单 + FG 11 条表非空）。

具体改动：
- S2 的 work_manual 中增加一条：`前置条件：S1 的 CK-00 检查结果必须包含完整的牵连清单和 FG 11 条触碰判定表，两表非空方可通过`
- 不改变 S1 的 gate_type（保持在 auto），而是将"S1 分析质量审核"融入 S2 的 human gate 确认范围

**文件**: `data/flows/wenstaros_core_repair_flow.yaml`

**工作量**: ~10 行

---

### B4. `harness-gate.cjs` 的 `tokenCoversFile` 升级

**问题**: `harness-gate.cjs:141-171` — 只检查 v1 字段 `file`/`files`/`allowed_files`，不识别 v2 的 `allowed_paths` 和 `forbidden_paths`。虽然后续 `verifyTokenV2()` 已补全验证（P6 修复后 v1 路径已关闭），但这是结构性债务——`tokenCoversFile` 是 v2 验证前的文件绑定预检，如果它在 v2 token 上也返回 false，v2 验证永远不会执行。

**方案**: 在 `tokenCoversFile` 中增加 v2 字段检查：

```javascript
function tokenCoversFile(token, stagedFile) {
  const n = stagedFile.replace(/\\/g, '/');
  
  // v2 字段（优先）
  if (Array.isArray(token.allowed_paths)) {
    for (const p of token.allowed_paths) {
      const tp = String(p).replace(/\\/g, '/');
      if (tp === n || (tp.endsWith('/') && n.startsWith(tp)) || (tp.endsWith('/**') && n.startsWith(tp.slice(0, -3)))) return true;
    }
  }
  
  // 旧 v1 字段（保留兼容，虽然 P6 已关闭 v1 路径）
  // ... existing code ...
}
```

**文件**: `scripts/harness-gate.cjs`

**工作量**: ~15 行

---

### B5. `NativeCommands.ts` 宿主项目函数标记为 deprecated

**问题**: `NativeCommands.ts:48,85,99` — `tscCheck`、`webuiStart`、`safeBackfill` 是 WenStarOS 宿主的命令，通过 Harness 核心模块的公开 API 导出。但它们不属于通用调度引擎。

**方案**: 标记为 `@deprecated`，添加注释说明这些是宿主项目专属命令，应该从宿主项目的独立配置中注入而非硬编码在 Harness 核心。

```typescript
/**
 * @deprecated 自 Harness v2.1.0 起标记。此函数是 WenStarOS 宿主项目的专属命令，
 *   不应属于 Harness 核心模块。将在 v3.0 移除，届时宿主项目需通过 RunnerModule 独立注册。
 */
export function webuiStart(...) { ... }
```

**文件**: `src/NativeCommands.ts`

**工作量**: ~10 行

---

### P7-B 验证

```
1. 触发 S4 异常 → handleError 应输出回滚日志
2. 修改 data/risk-policy.json → 重启后所有防线使用新分类
3. tokenCoversFile 对 v2 token 的 allowed_paths 正确匹配
```

---

# P7-C: 持久化与资源管理

> **目标**: 消除竞态条件、内存泄漏、原子性缺失等运行时隐患。

---

### C1. EvolutionEngine 资源清理

**问题**: M1+M8 — `setInterval` 未 `unref()`，`server.ts` SIGTERM handler 未调 `evolutionEngine.stop()`。

**方案**:

1. `EvolutionEngine.start()` → 两个定时器加 `unref()`
2. `EvolutionEngine` 新增 `stop()` 方法（`clearInterval` 两个定时器）
3. `server.ts` SIGTERM/SIGINT handler 增加 `evolutionEngine.stop()` 调用

```typescript
// EvolutionEngine.ts
start(): void {
  // ...
  this.observerTimer = setInterval(...);
  this.observerTimer.unref();    // ← 不阻止退出
  this.analysisTimer = setInterval(...);
  this.analysisTimer.unref();    // ← 不阻止退出
}

stop(): void {
  if (this.observerTimer) { clearInterval(this.observerTimer); this.observerTimer = null; }
  if (this.analysisTimer) { clearInterval(this.analysisTimer); this.analysisTimer = null; }
}
```

**文件**: `src/EvolutionEngine.ts` + `mcp/server.ts`

**工作量**: ~15 行

---

### C2. EvolutionEngine 并发防护

**问题**: M12 — 前一次 `scanDirectories()` 超时时新 interval 触发导致 `knownFiles` Set 状态重叠。

**方案**: 加互斥锁：

```typescript
private scanning = false;

scanDirectories(): void {
  if (this.scanning) {
    console.warn('[EvolutionEngine] 前一次扫描未完成，跳过本轮');
    return;
  }
  this.scanning = true;
  try {
    // ... existing scan logic ...
  } finally {
    this.scanning = false;
  }
}
```

**文件**: `src/EvolutionEngine.ts`

**工作量**: ~10 行

---

### C3. `GlobalMemoStore.save()` 原子写

**问题**: M10 — 直接 `writeFileSync` 覆盖，无 temp+rename 保护。

**方案**: 改为 temp+rename 模式，与 `TokenStore.atomicWrite` 一致：

```typescript
save(solutionText: string): void {
  ensureDir(MEMOS_DIR);
  const finalPath = join(MEMOS_DIR, `${this.runId}_memo.md`);
  const tempPath = finalPath + '.' + Date.now().toString(36) + '.tmp';
  writeFileSync(tempPath, content, { encoding: 'utf-8', flag: 'wx' });
  renameSync(tempPath, finalPath);
}
```

**文件**: `src/GlobalMemoStore.ts`

**工作量**: ~10 行

---

### C4. `TokenStore.atomicWrite` temp 残留清理

**问题**: M11 — 崩溃残留的 `.tmp` 文件导致后续 `EEXIST` 错误。

**方案**: `atomicWrite` 在 `flag: 'wx'` 失败时自动尝试清理残留并重试一次：

```typescript
private atomicWrite(tokenId: string, token: HarnessTokenV2): void {
  // ...
  try {
    writeFileSync(tempPath, JSON.stringify(token, null, 2), { encoding: 'utf-8', flag: 'wx' });
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      // 残留 temp 文件 — 清理后重试
      try { unlinkSync(tempPath); } catch (_) {}
      writeFileSync(tempPath, JSON.stringify(token, null, 2), { encoding: 'utf-8', flag: 'wx' });
    } else {
      throw err;
    }
  }
  renameSync(tempPath, finalPath);
}
```

**文件**: `src/security/token-store.ts`

**工作量**: ~10 行

---

### C5. `readToken` 异常分类

**问题**: M9 — 文件不存在、磁盘 IO 错误、JSON 解析失败三类问题统一返回 `null`。

**方案**: 区分返回，增加日志密度：

```typescript
readToken(tokenId: string): HarnessTokenV2 | null {
  const filePath = this.tokenPath(tokenId);
  try {
    if (!existsSync(filePath)) return null; // 正常: token 不存在
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as HarnessTokenV2;
  } catch (err: any) {
    if (err instanceof SyntaxError) {
      console.error(`[TokenStore] 令牌文件损坏 (JSON 解析失败): ${tokenId}`);
    } else {
      console.error(`[TokenStore] 读取令牌失败 (IO 错误): ${tokenId} — ${err.message}`);
    }
    return null;
  }
}
```

**文件**: `src/security/token-store.ts`

**工作量**: ~10 行

---

### C6. MCP `files` 参数校验

**问题**: M13 — 无路径遍历/大小校验。

**方案**:

```typescript
// 在 server.ts harness_run_flow handler 中增加
const MAX_FILES = 200;
if (files.length > MAX_FILES) {
  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `文件数 ${files.length} 超过上限 ${MAX_FILES}` }) }] };
}

const PATH_TRAVERSAL_RE = /\.\.\/|\.\.\\|^\/|^[A-Z]:\\/i;
for (const f of files) {
  if (PATH_TRAVERSAL_RE.test(f)) {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `禁止路径遍历: ${f}` }) }] };
  }
}
```

**文件**: `mcp/server.ts`

**工作量**: ~15 行

---

### C7. 心跳健康检查活性确认

**问题**: M6 — 健康检查仅检查心跳文件 mtime，不确认子进程实际存活。

**方案**: 在 kill 前增加 `child.connected` 检测：

```javascript
if (age > HEARTBEAT_STALE_MS) {
  // 先确认子进程的 PID 仍然存在
  try {
    process.kill(hb.pid, 0); // signal 0 = 仅检查进程是否存在
  } catch (_) {
    console.error('[harness-start] 心跳文件对应的 PID 已不存在，跳过健康检查');
    return;
  }

  console.error(`[harness-start] 🔴 心跳过期...`);
  // ... existing kill logic ...
}
```

**文件**: `mcp/start.cjs`

**工作量**: ~10 行

---

### C8. ESM/CJS 路径 API 统一

**问题**: M18 — `server.ts` 用 `import.meta.dirname!`，`AuditLogger.ts` 用 `__dirname`，`FlowConfigLoader.ts` 做了兼容降级。

**方案**: 统一为 `FlowConfigLoader.ts` 的兼容模式（`import.meta.dirname ?? __dirname`）。审计所有 `.ts` 文件，替换不一致的用法。

```typescript
// 统一模式
const THIS_DIR = import.meta.dirname ?? __dirname;
```

**文件**: `mcp/server.ts` (仅改 `import.meta.dirname!` → 兼容模式) + `src/AuditLogger.ts` (改 `__dirname` → 兼容模式)

**工作量**: ~15 行

---

### P7-C 验证

```
1. evolutionEngine.start() → stop() 后再退出 → 进程应在 3s 内自然退出
2. GlobalMemoStore.save() 中途崩溃 → 不应留下损坏文件
3. 模拟 EEXIST（创建 temp 文件后调用 atomicWrite）→ 应自动清理并重试成功
4. 传入 ['../../../etc/passwd'] → harness_run_flow 应拒绝
```

---

# P7-D: 运维基础设施

> **目标**: 可移植性（消除硬编码路径）+ 生产级运维（Windows Service 模式 + 权限分离）。

---

### D1. 硬编码路径全量替换

**问题**: H11 — 14 个文件中硬编码了 `D:/AI文件/harness`、`D:/tools/wenstar-cc` 等绝对路径。

**方案**: 分三类处理：

| 类别 | 策略 | 涉及文件 |
|------|------|------|
| **启动脚本** (PM2/start-services) | 改为基于 `process.cwd()` 或环境变量的运行时解析 | `ecosystem.config.cjs`, `start-services.cjs` |
| **防线脚本** (.claude/) | 优先用 `process.env.HARNESS_PROJECT_ROOT`，回退 `process.cwd()` | `.claude/*.cjs` (5 个文件) |
| **业务脚本** (scripts/) | 优先用 `process.env.HARNESS_PROJECT_ROOT` | `health-check.cjs`, `defense-health-check.cjs`, `baseline-report.cjs`, `pm2-recover.cjs` |
| **YAML work_manual** | 改为 `${PROJECT_ROOT}` 占位符，FlowEngine 运行时替换 | `wenstaros_core_repair_flow.yaml` |
| **ProjectBrain** | `architecture-baseline-builder.ts` 中的硬编码路径改为参数注入 | `architecture-baseline-builder.ts` |

`ecosystem.config.cjs` 是最高优先级的——当前生产启动完全依赖它。改为：

```javascript
const PROJECT_ROOT = process.cwd();  // PM2 cd 到 harness 目录后 cwd 就是项目根
module.exports = {
  apps: [{
    cwd: PROJECT_ROOT,
    args: `--root ${process.env.WENSTAR_CC_ROOT || 'D:/tools/wenstar-cc'}`,
    error_file: path.join(PROJECT_ROOT, 'data/logs/mcp-error.log'),
    // ...
  }]
};
```

**文件**: 14 个文件（见附录 A 全量清单）

**工作量**: ~200 行

---

### D2. Windows Service 模式（P4-D 延期项）

**背景**: P4 架构师评审报告的核心建议——防御者和攻击者应是不同身份。当前 MCP/Sentinel/Agent 都以同一用户 `henry` 运行。

**方案**（保守渐进式——不改核心架构）：

#### 第一步：基础 Windows Service 包装（P7-D2a）

- 新建 `scripts/harness-service.cjs`：用 `node-windows` 或直接调 `sc.exe` 注册 Harness 为 Windows Service
- 启动 = 执行 `pm2 start ecosystem.config.cjs`，停止 = `pm2 stop all`
- 保证 Harness 在系统启动时自动运行，无需用户登录

```javascript
// scripts/harness-service.cjs
// 注册: node scripts/harness-service.cjs --install
// 卸载: node scripts/harness-service.cjs --uninstall

const { execSync } = require('child_process');
const path = require('path');

const SERVICE_NAME = 'HarnessGuard';
const PM2_PATH = execSync('where pm2', { encoding: 'utf-8' }).trim().split('\n')[0];
const ECOSYSTEM_PATH = path.resolve(__dirname, '..', 'ecosystem.config.cjs');

if (process.argv.includes('--install')) {
  execSync(`sc.exe create ${SERVICE_NAME} binPath= "cmd.exe /c ${PM2_PATH} start ${ECOSYSTEM_PATH} && ${PM2_PATH} logs" start= auto`);
  execSync(`sc.exe start ${SERVICE_NAME}`);
  console.log(`[Harness] Windows Service "${SERVICE_NAME}" 已注册并启动`);
} else if (process.argv.includes('--uninstall')) {
  execSync(`sc.exe stop ${SERVICE_NAME}`);
  execSync(`sc.exe delete ${SERVICE_NAME}`);
  console.log(`[Harness] Windows Service "${SERVICE_NAME}" 已停止并删除`);
}
```

**文件**: `scripts/harness-service.cjs` (新)

**工作量**: ~40 行

#### 第二步：ACL 权限分离（P7-D2b，可选——保守策略下可择机实施）

- 创建专用本地用户 `harness-svc`（`net user harness-svc /add`）
- `sc.exe` 注册时指定该用户为服务运行身份
- `harness-svc` 拥有 `data/tokens/`、`data/audit/`、`data/sentinel/` 的写权限
- `src/` 对 `harness-svc` 只读
- Agent/Claude Code 仍以 `henry` 身份运行，通过 MCP 请求 `harness-svc` 签发的 token 才能修改文件

这一步需要仔细测试——Windows 权限模型下跨用户文件操作有细微差别。标记为可选，建议在 P7 核心完成后单独评估。

**文件**: `scripts/setup-acl.cjs` (新) + `scripts/harness-service.cjs`

**工作量**: ~80 行

---

### D3. 低风险问题清理

| # | 问题 | 处理方式 |
|:--:|------|------|
| L1 | `convergence_round` 防御代码冗余 | 保留（防御性代码不删） |
| L2 | `tokenPath()` Unicode 同形字符 | 增加注释标注已知边界 |
| L3 | YAML 无原型污染风险 | 增加注释标注安全分析结论 |
| L4 | `stableStringify()` 无循环引用防护 | 增加 `try/catch` 包装 + 降级处理 |
| L5 | `encodeMachineSignal`/`decodeMachineSignal` 死代码 | 标记 `@internal`，保留供未来子 Agent 传输使用 |
| L6 | 默认 flow 硬编码 | 改为读取 `data/flows/` 中第一个 YAML |
| L7 | free mode 响应缺少 `token_issued` 字段 | 增加 `token_issued: false` 字段 |
| L8 | PROTECTED 列表小差异 | 统一到 `data/risk-policy.json` |

**文件**: 各对应文件

**工作量**: ~30 行

---

### P7-D 验证

```
1. harness-service.cjs --install → sc.exe query HarnessGuard → RUNNING
2. 移除所有硬编码路径后 → 在新目录 clone → npm install → pm2 start -- 100% 基于环境变量
3. 重启机器 → HarnessGuard Windows Service → pm2 status → 两个进程 online
```

---

## 全量改动清单

| 阶段 | 新文件 | 修改文件 | 预估行数 |
|:--:|------|------|:--:|
| **P7-A** | `scripts/risk-policy-loader.cjs` | `sentinel-service.cjs`, `watcher.cjs`, `start-services.cjs`, `sentinel-mcp-client.cjs`, `server.ts` | ~140 |
| **P7-B** | — | `FlowEngine.ts`, `RiskClassifier.ts`, `sentinel-mcp-client.cjs`, `harness-pre-check.cjs`, `harness-gate.cjs`, `wenstaros_core_repair_flow.yaml`, `NativeCommands.ts` | ~150 |
| **P7-C** | — | `EvolutionEngine.ts`, `server.ts`, `GlobalMemoStore.ts`, `token-store.ts`, `start.cjs`, `AuditLogger.ts` | ~85 |
| **P7-D** | `scripts/harness-service.cjs`, (optional: `scripts/setup-acl.cjs`) | `ecosystem.config.cjs`, `start-services.cjs`, `.claude/*.cjs` (5), `scripts/*.cjs` (4), `wenstaros_core_repair_flow.yaml`, `architecture-baseline-builder.ts`, 低风险散点 | ~350 |
| **总计** | 2-3 个新文件 | ~25 个修改文件 | **~725 行** |

---

## 发布计划

| 里程碑 | 内容 | 验证标准 |
|:--:|------|------|
| **P7-A** | Sentinel 盲区消除 | Sentinel 检测到 `.claude/`、`mcp/`、`scripts/` 的文件修改并回滚 |
| **P7-B** | 流水线缺陷修复 | 三道防线统一从 `risk-policy.json` 加载风险分类 |
| **P7-C** | 持久化与资源 | `EvolutionEngine.stop()` 后进程正常退出；原子写无残留 |
| **P7-D** | 运维基础设施 | `git clone` 后在任意目录 `npm ci && pm2 start` 即可运行 |

每个阶段独立提交、独立推送、独立验证。四阶段全部完成后打 `v2.1.0` tag。

---

> **方案版本**: v1.0  
> **下一步**: 人工审核通过后，按 P7-A → P7-B → P7-C → P7-D 顺序逐阶段实施

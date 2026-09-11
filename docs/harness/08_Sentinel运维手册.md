# Sentinel 运维手册

> 版本：2026-09-11（对应 Sentinel v3.0 基线恢复 + F2 删除检测）
> 适用：`harness-sentinel`（监管 wenstar-cc）与 `harness-self-sentinel`（监管 harness 自身）
> 配套：缺陷史见 `06_Sentinel回滚缺陷-2026-09-10.md`；改善路线见 `07_后续改善计划.md`

---

## 一、组件与数据布局

| 路径 | 内容 | 是否受监控 |
|---|---|---|
| `data/sentinel/baseline/<项目指纹>/index.json` | 基线索引：relPath → {hash, size, snap, at} | ❌ 不在 WATCH_ROOTS |
| `data/sentinel/baseline/<项目指纹>/files/<sha1(relPath)>.bin` | 内容快照（**内容寻址、每路径一份、刷新即覆盖**） | ❌ |
| `data/sentinel/quarantine/<ISO时间戳>/<relPath>` | 破坏性动作前的隔离副本 | ❌ |
| `data/sentinel/<日期>/<type>_<ts>.json` | 审计事件（allowed / reverted / exempt_allowed / noop / error / refused_no_baseline） | ❌ |
| `data/logs/{self-,}sentinel-error.log` | 运行日志（console.error 通道） | ❌ |
| `data/mcp-watchdog/start-<port>.lock` | **MCP 看守单实例锁**（v3.1 新增，见 §八） | ❌ |
| `data/mcp-watchdog/sentinel-<sha1(项目根前12)>.lock` | **哨兵单实例锁**（v3.1 新增，见 §八） | ❌ |

**监控范围（WATCH_ROOTS）**：`src/` `.claude/` `mcp/` `sentinel/` `scripts/` `hooks/` `data/flows/` `dist/`
（`dist/` 走哈希基线自愈，不走 token/回滚）。
**排除**：`node_modules` `.git` `.claude`（作为子目录时）`__tests__`；后缀 `.test.ts` `.spec.ts` `.d.ts`。
**受管后缀**：`.ts .json .yaml .yml .cjs .mjs .js`

**当前实测量级**（2026-09-11）：harness 自身 151 文件 / 2.2 MB；wenstar-cc 1222 文件 / 12 MB。

---

## 二、授权三分支（决策表）

文件变更事件到达后的唯一判定路径（`sentinel-service.cjs::processFileChange`）：

| 分支 | 条件 | 动作 | 审计事件 |
|---|---|---|---|
| 1 | **令牌有效**（`harness_run_flow` 签发，HMAC v2） | 放行 + **推进基线** | `allowed` |
| 2 | **豁免命中**（`exemptions.json` 内且未过期） | 记录、**不回滚** + **推进基线** | `exempt_allowed` |
| 3 | 两者皆无 | 进入回滚流程（见 §三） | `reverted` / `noop` / `refused_no_baseline` / `error` |

> ⚠️ 两个组件判定不同，勿混淆：
> - **Sentinel**：豁免**有效**（分支 2 不回滚）。
> - **`.claude/harness-pre-check.cjs`**（仅作用于 harness cwd 的 Claude 会话）：此前记载为
>   「`isExemptionApplicable` 对 harness 自身防线前缀返回 false → 豁免不生效，必须
>   「管理员解锁 + 流水线令牌」双因子」。
>
>   🔴 **2026-09-11 实测订正**：该记载与实际行为不符。对 harness 自身文件（本次验证覆盖
>   `mcp/` `sentinel/` `.claude/` `src/` 四类前缀，共 7 个文件）而言，**「管理员解锁 +
>   逐文件豁免（`--ops edit,write`）」这一对因子即足以放行 Edit**，Sentinel 相应记为
>   `exempt_allowed`（分支 2，不回滚），无需流水线令牌。
>   实测证据：解锁窗口内改 `src/NativeCommands.ts` → Edit 成功落盘 → 审计目录出现
>   `exempt_allowed_<ts>.json`。
>
>   ⚠️ 但**流水线令牌仍是唯一能推进基线并留下 `allowed` 记录的路径**，且 S4.5 前的
>   `harness_run_flow` 申报是流程合规要求。豁免只是「不阻断」的兜底授权，不等于流程合规。

---

## 三、回滚流程（v3.0 起，非破坏性）

```
分支3: 无授权
  ├─ 有基线 → baseline.restore()
  │     ├─ 成功         → reverted（method=baseline，内容精确回到「最后授权态」）
  │     ├─ 内容已一致   → noop（幂等：恢复动作自身重写文件会再触发一次事件）
  │     └─ 恢复失败     → 隔离当前内容 + fail-loud
  └─ 无基线 → 先隔离当前内容，再：
        ├─ untracked 新文件 → 隔离后删除（method=quarantine-delete，内容可找回）
        └─ git 已跟踪文件   → 【拒绝回滚】refused_no_baseline（绝不 git checkout）
```

🔴 **v3.0 的核心不变式**：任何路径都**不会静默销毁内容**。旧版 `git checkout -- <file>` 会
用 index 覆盖工作区（销毁未暂存工作）——2026-09-10 事故即由此而来，已整体移除。

### ⚠️ 行为变更：未授权的**新建文件**会被删除（2026-09-11 实测）

| 场景 | v2.x（旧） | v3.0 + F2（现行） |
|---|---|---|
| 未授权**修改**已存在文件 | `git checkout` 用 index 覆盖（**销毁未暂存工作**） | 从**基线**精确恢复 |
| 未授权**新建**文件（untracked） | `git checkout` 失败 → **文件幸存**（防御漏洞） | **隔离后删除**（内容存 `quarantine/`，可找回） |

**运维含义（重要）**：在受管目录（`src/` `mcp/` `scripts/` `sentinel/` `hooks/` `.claude/` `data/flows/`）
**新建**源文件时，必须**先**取豁免或流水线令牌，否则文件会被隔离删除。

- 正确姿势：`harness_run_flow` 的 `files` 里**预先声明**新文件路径 → 拿令牌 → 再创建；
  或先对新路径签豁免（`exempt add <new-path> --ops write,delete`）。
- 万一被删：内容在 `data/sentinel/quarantine/<时间戳>/<路径>`，可原样取回。
- 本会话早前新建的 `src/s6/*.ts`、`src/s7/*.ts` 能幸存，是旧实现的漏洞（`git checkout`
  对 untracked 必然失败）——现已堵上。

**基线的三个时点**：
1. **启动播种**：`seedDirs(WATCH_ROOTS)` 全量登记磁盘现状，**只补缺失、不覆盖已有**（重启不会冲掉授权态）。
2. **授权刷新**：分支 1 / 2 命中后 `refresh`，把「本次授权后的内容」立为新基线。
3. **恢复**：分支 3 有基线时 `restore`。

---

## 四、`refused-no-baseline` 处置 SOP

**症状**：日志出现

```
🛑 拒绝破坏性回滚（无基线）: <path>
   ⚠️ 需人工介入：确认该改动是否合法。合法 → 取豁免/令牌后重写以推进基线；非法 → 从隔离区比对后决定。
```

**含义**：该文件被未授权修改，且哨兵**没有它的基线**（哨兵启动后新建、或基线条目曾被移除），
因此无法自动恢复。哨兵选择「不猜、不破坏」。

**处置步骤**：

1. **定位隔离副本**：`data/sentinel/quarantine/<时间戳>/<relPath>` —— 未授权内容已完整保存。
2. **判断改动性质**：
   - **合法**（是自己或授权 agent 改的）：取豁免或流水线令牌后**重新写入该文件** →
     触发分支 1/2 → 基线建立/推进 → 后续受管。
   - **非法**：用 `git diff` / 与隔离副本比对决定如何还原；还原后同样走一次授权写入以建立基线。
3. **验证**：`data/sentinel/baseline/<指纹>/index.json` 中出现该路径即基线已建立。

> 为什么会「无基线」？基线在**哨兵启动时**播种。若某文件在哨兵停机期间被创建、或曾被授权删除
> （`refresh` 会移除索引条目），重启前它就处于「无基线」状态。这是有意的取舍——
> 拿陈旧基线去恢复反而会误伤。

---

## 五、存储与保留策略

**增长特性**：快照按 **sha1(relPath)** 命名 → **每路径恒一份、刷新即覆盖**，
所以体积上界 ≈ Σ(受管文件大小)，**不会随刷新次数线性膨胀**。

**真正会累积的是「孤儿快照」**：索引条目被移除后（授权删除 / 文件从监控范围消失），
其 `.bin` 仍留在 `files/` 中。

**建议的巡检与清理**（低频，手工或后续脚本化）：

1. 列出孤儿：`index.json` 的 `snap` 集合 与 `files/` 目录实际文件名的**差集**。
2. 清理前先确认对应文件确已不在监控范围（避免误删刚被临时移出的条目）。
3. 隔离区 `data/sentinel/quarantine/` 按时间戳目录**只增不减** —— 属人工取证材料，
   建议按「保留最近 N 天 / 或人工确认后删除」，**不建议自动清理**。

---

## 六、症状 → 处置 对照表

| 症状（日志/现象） | 含义 | 处置 |
|---|---|---|
| `🟡 豁免内修改(无令牌)` | 分支 2，豁免期内合法 | 无需动作（留意豁免到期时间） |
| `✅ 放行: <f> — 令牌有效` | 分支 1 | 无需动作 |
| `↩ 已按基线恢复: <f> (基线 xxxx)` | 未授权修改已被精确撤销 | 确认改动是否本该合法；若合法说明少了令牌/豁免 |
| `🗑 检测到文件删除（受管文件消失）: <f>` | F2 删除检测触发（v3.0+F2 起） | 同上；有基线会自动恢复该文件 |
| （`noop` 审计事件） | 恢复后重复触发，已幂等识别 | 无需动作；这是**正常收敛**信号 |
| `🛑 拒绝破坏性回滚（无基线）` | 见 §四 | 走 §四 SOP |
| `❌ 回滚失败: ... — git checkout...` | **v2.x 遗留**（该文案已随 v3.0 移除） | 若仍在出现说明哨兵未重启加载新代码 |
| `📁 文件变更` 计数长期不动 | 可能监控目录不存在 | 看启动日志 `⚠️ 监控目录不存在，跳过` |
| 改完 `sentinel/*.cjs` 无效果 | 长驻进程模块已缓存 | **`npx pm2 restart harness-self-sentinel harness-sentinel`** |

---

## 七、变更 Sentinel 自身时的强制步骤

1. 取该文件**有效豁免**（`--ops edit,write`）+ 管理员解锁。实测（2026-09-11）这对因子即足以
   放行 Edit 且在 Sentinel 层不回滚，见 §二 订正说明。
2. 改完 **必须重启**：`npx pm2 restart harness-self-sentinel harness-sentinel harness-mcp`。
   （`sentinel/*.cjs` 与 `mcp/*.cjs` 都是长驻进程，模块已被 require 缓存，不重启等于没改。）
3. 重启后确认日志出现：`🧬 基线播种完成: 新增 N / 已有 M / 失败 0`（M 应等于既有受管文件数，
   说明幂等播种未冲掉旧基线）。
4. 全量回归：`NODE_OPTIONS="--max-old-space-size=4096" npx vitest run --no-file-parallelism`。

---

## 八、单实例锁（v3.1 新增，2026-09-11 闪屏事故产物）

### 事故经过

2026-09-11 下午出现「**node 控制台窗口一直闪、无法操作**」。采样 60 秒发现：
同一个 MCP 被 **三份**看守进程同时拉起 —— `harness-auto-start.cjs` 用 `nohup` 拉起两份、
pm2 的 `harness-mcp` 一份。三者抢同一端口 8765，只有一份能绑上，其余每 ~7 秒崩溃重拉一轮
`npx`→`node`→`tsx`。

放大器在 `mcp/start.cjs::startChild()`：每次重启都会走「端口清理」分支 →
`taskkill /F /PID` **杀掉正常那份的 server.ts** → 正常那份发现子进程死亡又重启 → 抢回端口 →
再被杀 → **两边互杀永动机**。因为都是看守进程内部的重启循环，**pm2 的 `↺` 计数完全不动**，
从 pm2 侧看一切正常。

### 锁机制

| 项 | 值 |
|---|---|
| MCP 锁 | `data/mcp-watchdog/start-<port>.lock` |
| 哨兵锁 | `data/mcp-watchdog/sentinel-<sha1(归一化项目根).slice(0,12)>.lock` |
| 判定 | **mtime 心跳（15s 刷新）+ TTL（60s）为主，PID 存活为辅** |
| 冲突行为 | 后来者打印 `🛑 已有…在运行` 并 `exit(0)`（**不报错**） |
| 接管条件 | 锁龄 ≥ 60s，**或** 锁内 PID 已不存在（被 `taskkill /F` 后无退出钩子） |

**为什么不用纯 PID 判定**：Windows PID 复用常见，会误判「持锁者还活着」而永久拒绝启动。
**为什么不用纯 TTL 判定**：`taskkill /F` 后要空等满 60s 才能重启。两者结合取长补短。

**写锁 vs 读锁的分工**（重要）：只有**服务自己**（`mcp/start.cjs`、`sentinel-service.cjs`）
写锁；`harness-auto-start.cjs` 只**读**锁。若拉起方先占锁再 spawn，被拉起的子进程会误判
「已有人」而自杀。

### 关键设计点

- **MCP 锁在 `runTscCompileCheck()` 之前获取** —— 那 60 秒 `npx tsc --noEmit` 正是竞态窗口
  （端口还没 listen，只看端口的守卫会以为没实例）。败者在跑 tsc 和互杀逻辑之前就退出。
- **哨兵锁在 `--unlock` 提前退出之后获取** —— 哨兵兼作签发豁免的 CLI，若锁在 `--unlock`
  之前，`harness-cli.cjs exempt add` 会被常驻哨兵自己的锁挡住。
- **锁按项目区分**：harness 自身与 wenstar-cc 两个哨兵各持一把锁，互不影响。
- **fail-open**：锁机制自身抛异常时**继续启动**而不是拒绝 —— 宁可承担闪窗风险，
  也不能让 MCP / 哨兵起不来。

### `harness-auto-start.cjs` 顺带修掉的一个真 bug

`ensureSentinel()` 原实现拿 `tasklist /FO CSV` 的输出找 `"sentinel-service"` 字符串来判断
哨兵是否已在运行。但 **`tasklist` 根本不输出命令行**（只列映像名 / PID / 会话 / 内存），
该守卫**恒为假** → 每次调用都会重复拉起哨兵。已改为读哨兵单实例锁。

### 验证方法

```bash
# 1) 锁文件应存在且 pid 指向当前看守
cat data/mcp-watchdog/start-8765.lock

# 2) 主动拉起第二个看守 —— 应在跑 tsc 之前就打印 🛑 并 0 秒退出
node mcp/start.cjs --root D:/tools/wenstar-cc

# 3) 第二个哨兵同理
node sentinel/sentinel-service.cjs --project D:/tools/wenstar-cc
```

### 排查「闪屏」的标准动作

1. 采样：`Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 每 300ms 一轮，看哪类进程
   **反复以新 PID 出现**（首轮普查不算，只看重复出现的）。
2. 看进程树：`ParentProcessId` 指向谁 —— 若父进程是 pm2 看守，说明是**看守内部**的重启循环，
   pm2 的 `↺` 不会反映。
3. 查端口归属：`netstat -ano | findstr :8765` —— 被谁占、有几个在抢。
4. 锁文件若指向已死 PID → 直接删掉该 `.lock` 重启即可（锁会自动接管陈旧锁，通常无需手工删）。

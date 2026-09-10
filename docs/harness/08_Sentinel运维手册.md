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
> - **`.claude/harness-pre-check.cjs`**（仅作用于 harness cwd 的 Claude 会话）：`isExemptionApplicable`
>   对 harness 自身文件（`src/` `data/` `mcp/` 等防线前缀）**返回 false** → 豁免不生效，必须
>   「管理员解锁 + 流水线令牌」双因子。

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

1. 取该文件**有效豁免**（`src/sentinel/` 属 harness 自身防线，pre-check 层不豁免；但 Sentinel 层豁免有效）。
2. 改完 **必须重启**：`npx pm2 restart harness-self-sentinel harness-sentinel`。
3. 重启后确认日志出现：`🧬 基线播种完成: 新增 N / 已有 M / 失败 0`（M 应等于既有受管文件数，
   说明幂等播种未冲掉旧基线）。
4. 全量回归：`NODE_OPTIONS="--max-old-space-size=4096" npx vitest run --no-file-parallelism`。

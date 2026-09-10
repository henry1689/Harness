# Harness owner-adopted CK 精确基线合同 R1 并发任务书独立审阅停止裁决

- 日期：2026-09-01
- 审阅对象：`docs/harness-owner-adopted-ck-exact-baseline-contract-r1-taskbook-2026-09-01.md`
- 审阅对象：17,633 bytes
- 审阅对象 SHA-256：`e04f47a75919a7b69b35fe26ad3d7590bc0727f63186852bad4f16ab0ed5a8bf`
- 前置事实裁决：`docs/harness-owner-adopted-formal-deployment-gate4-failure-independent-review-and-gate0-2-handoff-2026-09-01.md`
- 最终裁决：`STOP_OWNER_CK_BASELINE_CONTRACT_EVIDENCE_CONTRADICTED_AND_SCOPE_UNAUTHORIZED`

## 一、时序与授权

该任务书于 `2026-09-01T13:08:38.1757576Z` 并发出现，早于前置事实裁决的远端投递。它声明 `TASKBOOK_DELIVERY_ONLY`，没有 Harness 实施、flow、token、服务、WenStar、H2、commit/push 授权；这一限制继续有效。

它的 Gate 0 只读建议也不得自动开始。原因不是只读动作本身危险，而是任务书的核心事实、目标和边界已被更晚且更完整的真实运行证据否定。继续沿该任务书产出候选，会把一次失败的五规则精确机制扩大成新的 CK 例外链，破坏已经冻结的“owner-closure 正式关闭后转 H2 Gate 0.2”顺序。

## 二、核心事实错误

任务书写道：

```text
S4.5 原始 CK 得分稳定为 83.9%、17/23
```

真实审计并不支持“稳定”：

- `run_mtin24i5_rgju` 七轮均为 79%、16/23；
- `run_mtino16d_2ehe` 首轮为 79%，后续为 83.9%；
- 同源码、同 memo/state 的只读 replay 为 83.9%、17/23；
- 主 run 还出现两次 S3 TypeScript 30 秒 timeout，后续又通过。

因此任何把 `83.9`、六个 CK、finding count 或 digest 直接称为“当前确定性基线”的合同都建立在错误前提上。即使 canonical JSON/digest 算法连续五次稳定，也只能证明同一批已取得的 raw object 可稳定序列化，不能证明 raw CK producer、扫描集合、timeout、cwd、cache、依赖和调度行为稳定。

## 三、范围与语义不获授权

原 Owner 授权只覆盖以下五个 S4 rule：

```text
DOC_SYNC_REQUIRED
STATIC_QUALITY_GATE
ROBUSTNESS_CORE_REQUIRED
HOOK_REQUIRED
HOOK_SIX_STAGE_HEALTH
```

R1 任务书新增把 `CK-02/05/06/06.5/07/08` 的 non-pass finding 签成 owner baseline，并在匹配时把副本改成 pass/empty violations。无论命名为 `effectiveCkResults`、derived view 还是 ordinary PASS，这都在实质上增加六类例外，不属于既有五规则授权。

其中 `CK-06.5` 涉及五个 owner-adopted 文件之外额外 61 个文件、138 处启发式模式。把这个全仓 finding 集合纳入五文件 owner-adopted closure，既不是最小范围，也不能证明这些债务是五文件的 inherited baseline 或与本次 actual delta 无关。

任务书还要求 raw non-pass 经派生视图变成全 pass，却把它描述为“普通 PASS”。普通 PASS 的语义应是检查事实满足标准；由 owner 签名把失败检查复制为通过属于显式 obligation/attribution 决策，必须以类型化事实保留并由中央 policy 裁决，不能伪装成原始标准已经满足。

## 四、合同仍漏掉真实故障面

即使忽略授权问题，建议包仍不能关闭本轮已发生的故障：

1. 未冻结并修复 S3/S5/S6 stage-specific handler、真实命令、cwd、timeout、stdout/stderr、退出码和 cache policy；
2. 未解决 MCP 客户端 60 秒 timeout 后 server 继续运行的 accepted/running/terminal 查询与 request idempotency；
3. 未限制同一 manifest/change set 同时只能有一个 active closure，也未提供发起者/claim 者 provenance；
4. 未让 audit 原子保存每轮逐 CK typed input、raw command result、finding、归因与 terminal truth；
5. 未处理真实 post-check/token 消费链的 change set、baseline、完整目标集和 actual delta 签名联结；
6. 未表达 inherited baseline debt、approved planned delta、actual current delta 与 current blocking 的 discriminated union；
7. 未纳入 3000 closed 时生产库仍持续变化这一明确外部停止条件。

只冻结 `main_harness_checker/Convergence/Scorer/DesignStandards/Reviewer/Dual/FlowEngine/server/core` 的源码 SHA，不能冻结 Node/TypeScript/vitest 版本、依赖树、文件枚举、工作目录、进程并发、timeout/cache 或外部文件状态，因此也不能把 79%↔83.9% 问题转化为可安全签名的确定性 CK baseline。

## 五、可复用但不构成开工授权的部分

下列设计元素可以作为 H2 Gate 0.2 的输入，而不是新 owner exception 的开工门：

- raw CK 与 policy decision 分离；
- finding canonicalization 排除 duration/timestamp/cache 等非决定字段；
- 路径归一、稳定排序、小写 SHA-256 与 UTF-8 明确语义；
- runtime consumer 字节漂移 fail-closed；
- 历史 failed record 永不复用；
- caller 不得自声明 allowed CK/skip CK；
- timeout 后禁止自动重试。

这些元素必须被放回 typed attribution/obligation、stage determinism、audit 和 token linkage 的统一合同中审阅，不能单独用来把六个 raw failure 改成 pass。

## 六、裁决与下一步

当前固定顺序不变：

```text
owner-closure v1 = 正式部署成功、Gate 4 失败、停止再试
  -> H2 Gate 0.2 只读重基线与完整补证
  -> Owner 独立审阅
  -> 才讨论任何源码实施
```

Gate 0.2 可以只读复用该 R1 任务书提出的 canonicalization 检查，并必须解释 79%↔83.9% 的 producer/handler 非确定性；但不得把 `83.9`、六个 CK 或 61 文件/138 finding 预先接受为 owner baseline，也不得建立 raw-fail-to-effective-pass 的新 closure 包。

在新的 Owner 明确裁决前，Claude Code 若已开始该任务书，只能停止并回报已经完成的只读证据；不得继续创建候选、源码/测试、record、manifest、flow、token 或服务动作。

```text
VERDICT = STOP_OWNER_CK_BASELINE_CONTRACT_EVIDENCE_CONTRADICTED_AND_SCOPE_UNAUTHORIZED
TASKBOOK_DELIVERY_ACCEPTED_AS_EVIDENCE_ONLY = true
TASKBOOK_GATE0_AUTHORIZED = false
OWNER_CK_BASELINE_EXCEPTION_AUTHORIZED = false
OWNER_CLOSURE_RETRY_AUTHORIZED = false
H2_GATE0_2_READ_ONLY_RESUBMISSION_REMAINS_NEXT = true
H2_IMPLEMENTATION_AUTHORIZED = false
FLOW_AUTHORIZED = false
TOKEN_OR_EXEMPTION_AUTHORIZED = false
SERVICE_OPERATION_AUTHORIZED = false
WENSTAR_WRITE_AUTHORIZED = false
PRODUCTION_DB_CONTENT_ACCESS_AUTHORIZED = false
COMMIT_OR_PUSH_AUTHORIZED = false
```

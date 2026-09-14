# dsh-agent-cluster — 语义文档（DSH 多实例通讯底座）

## 1. 元信息

| 项 | 值 |
|---|---|
| 版本 | v0.2（语义稿；v0.2 增补 P2 任务协议与参考适配器） |
| 日期 | 2026-09-14 |
| 状态 | 实现逼近中（验收清单逐条标注证据；A1–A11 已回修，B1–B7 为 P2 新增） |
| 实现落点 | `self-plugins/dsh-agent-cluster/src/{index,protocol,identity,bus,target,state}.ts` + `scripts/ref-node.mjs`（参考适配器） |
| 主副本 | 本文件（`docs/semantic.md`）；无同语义副本 |
| 设计者 | 爱丽丝（主人 2026-09-14 指令：「创建一个插件多个 DSH 实例之间通讯，打造多智能体工作台」） |

## 2. 定位与反定位

**定位**：本机（或共享盘）上**多个 DSH 实例之间**的**去中心化消息总线 + 在线名册**。每个实例安装同一插件即自动获得：稳定身份、全集群名册、点对点消息、广播、收件箱，并把收到的消息注入本实例会话交给 agent 处理。

**反定位**（同样重要，防误解）：

- **不是进程内编排**：同进程的 subagent / Agent Teams / workflow 属于 `packages/subagent`、`packages/workflow` 与 teammates 机制；本插件只管**跨进程/跨实例**。
- **不是中心 Broker**：没有常驻中枢进程，没有 leader 选举，没有单点。总线只是共享目录，任一节点都可以独立起停。
- **不替 agent 决策**：收到消息只是「注入会话」——回不回、怎么回、要不要行动，由该实例的 agent 自己决定。插件不做自动应答。
- **不是安全沙箱**：总线目录是普通文件系统对象，同机任何进程都能读写（能力 ≠ 隔离）。总线不存凭据。
- **不是授权通道**：来自 `cluster` 的消息是**平级实例的来信**，不是主人指令，不获得任何特权（见 §6 信任边界）。
- **不是任务调度器**（v0.2 明确）：任务台账是**主脑的账本**，插件不轮询台账、不推进状态、不替谁派活——状态推进由主脑按批处理节奏完成（§5.5）。

## 3. 术语表

| 术语 | 定义 |
|---|---|
| **实例（instance）** | 一个运行中的 DSH 进程（一个 profile / 一个端口 / 一个 DSH_HOME）；本插件的部署单元 |
| **节点（node）** | 实例在本插件中的身份视图——由 `nodeId` 标识，带 `role`/`tags`/`baseUrl`/`pid` 等元数据 |
| **nodeId** | 节点唯一标识。显式配置优先；否则按 `<hostname>-<profile>-<port>` 派生；冲突时自动改名并留痕（I1） |
| **总线（bus）** | 共享目录 `busDir`，所有节点都读写同一份（本机默认 `~/.dsh-cluster`） |
| **心跳** | 节点周期性重写自己的 `nodes/<nodeId>.json`，携带 `atMs`/`pid`/`startedAt`/`baseUrl` |
| **名册（roster）** | 扫描 `nodes/` 得到的全部节点视图（含离线节点） |
| **收件箱（mailbox）** | `mailbox/<nodeId>/` —— 发送方写入的消息文件；接收方投递成功后移入 `done/` |
| **投递（deliver）** | 把消息注入本实例会话的动作：`agent.steer(createUserMessage(...))` |
| **让位/接管** | 不适用——本插件无单点资源所有权，节点之间无互斥（对照 §SOUL 5.19，本条明确不引入） |
| **主脑（primary）** | 「主人 → 结果」链路的**细化者与裁断者**：产出台账、派发、验收、写 verdict。**是一个角色，不是特权**（可落在任一节点） |
| **执行节点（worker）** | 按台账 `acceptance` 干活的节点。**认知层不收窄**（可自省/自进化），**操作面按职责收窄** |
| **任务台账（task ledger）** | `tasks/<taskId>.json` —— 任务的意图、判据、状态、结果与裁决。**唯一写者 = 主脑**（I8） |
| **行为事件（action event）** | `logs/actions/<actionId>.jsonl` —— 结构性动作的**分阶段**落盘（每步一条），是「实时行为流」的数据源 |
| **适配器（adapter）** | 让某种运行时成为节点的**中间层**（DSH 只是第一个）。职责：注册心跳 → 收任务 → 执行 → 回结果 → 落行为事件 |
| **能力声明（capabilities）** | 节点心跳里的 `capabilities[]`——主脑**按能力寻址**（派活前先看节点会不会） |

## 4. 概念模型与不变量

```
        ┌──────────────────── 共享总线目录 busDir ────────────────────┐
        │ nodes/<nodeId>.json        心跳与身份（含 capabilities[]）    │
        │ mailbox/<nodeId>/*.json    收件箱（待投递）                   │
        │ mailbox/<nodeId>/done/     已投递归档                        │
        │ mailbox/<nodeId>/dead/     重试耗尽/过期                     │
        │ tasks/<taskId>.json        任务台账（意图/判据/状态/裁决）     │
        │ logs/actions/<id>.jsonl    结构性动作分阶段事件（实时行为流）  │
        │ logs/<nodeId>/<date>.jsonl 节点日志事件                       │
        │ logs/primary/decisions.jsonl 主脑决策（hash 链）              │
        │ state/<nodeId>.json        本节点游标与状态                   │
        │ cluster-trace.jsonl        侧车轨迹（全节点追加）             │
        └──────────────────────────────────────────────────────────────┘
             ▲                    ▲                 ▲
        nodeA web:3080       nodeB web:3081     nodeC headless
        （每节点只写自己的 nodes/<id>.json 与别人 mailbox 里的消息）
```

**不变量（每条都能被一次测量判真假）**：

- **I1 身份唯一且可见**：同一 `nodeId` 在同一时刻只对应一个活跃进程。启动时若发现同名心跳活跃且 `pid` 不同 → **改名**（`<base>-<pid>`）并写轨迹，绝不静默覆盖。
- **I2 消息不丢**：消息文件由发送方**原子发布**（同目录临时文件 + rename）；接收方**只在注入成功后**移入 `done/`；注入失败保留原位按退避重试；重试耗尽或超 `ttlMs` → 移入 `dead/` 并落轨迹（不静默丢弃）。
- **I3 幂等**：同一 `messageId` 至多注入一次。接收方状态持久化已处理 id 集合（滚动上限），重复投递直接归档。
- **I4 判活一致**：节点是否在线**只由**`now - heartbeat.atMs > offlineAfterMs` 判定；名册显示、发送警告、在线计数**共用同一常量**（判据单一真源）。
- **I5 单写者**：`nodes/<id>.json` 只有该节点写；`mailbox/<to>/*.json` 只有发送方创建（no-clobber）；`done//dead/` 的移动只有接收方做。无多写者竞争。
- **I6 模型可见即已记录**：注入消息经 `agent.steer(createUserMessage(...))` 进入会话事件流，可被会话日志重建。
- **I7 观测不反噬**：轨迹/状态落盘失败一律吞错并返回 `false`，绝不影响投递主流程（对照 SOUL 5.22 §3）。
- **I8 台账单写者**（v0.2）：`tasks/<taskId>.json` **只有主脑写**。执行节点**不写台账**——它只回 `event`/`result` 消息（状态推进由主脑批处理完成）。这样台账零竞争，代价是台账状态滞后于节点实况，最多一个主脑处理周期。
- **I9 判据先行**（v0.2）：无 `acceptance` 的台账**不得派发**（R8 的机器可判形式）。派发动作前的最后一道检查就是「`acceptance` 非空且非占位符」。
- **I10 适配器必落行为事件**（v0.2）：结构性动作**不落盘 = 不算节点**。适配器执行每一步必须写一行 `logs/actions/<actionId>.jsonl`；结束必须写 `stage: done|failed` 收口。
- **I11 路径白名单**（v0.2）：节点只在自己的 `--workdir` 白名单内执行文件操作；**越界即拒**并回 `status: blocked`（不是 `failed`——被拒不是执行失败，是需要主脑改派）。

## 5. 契约

### 5.1 消息文件格式（`mailbox/<to>/<id>.json`）

```jsonc
{
  "v": 1,                       // 协议版本，缺失/不识别 → 跳过并落痕
  "id": "m-<base36 时间>-<随机>", // 全局唯一，幂等键
  "from": "<nodeId>",
  "to": "<nodeId>",             // 广播时每个目标各写一份（"to" 仍是具体节点）
  "kind": "chat",               // chat | task | result | event | alert
  "text": "正文",                // ≤ maxTextChars（默认 8000）
  "replyTo": "m-...",           // 可选
  "createdAt": 1737000000000,   // ms
  "ttlMs": 86400000,            // 0 = 永不过期；过期进 dead/
  "meta": { "peer": "nodeA" }   // 可选，未知键忽略
}
```

### 5.2 组件契约（纯模块，便于离线测试）

| 模块 | 导出 | 职责 |
|---|---|---|
| `protocol.ts` | `makeMessage` / `parseMessage` / `messageId` | 构造与**校验**（不可信输入）；坏数据返回错误分类而非抛 |
| `identity.ts` | `deriveNodeId` / `resolveIdentity` / `renameOnCollision` | 身份派生与冲突改名（纯函数，喂真实冲突样本可测） |
| `bus.ts` | `listNodes` / `writeHeartbeat` / `writeMessage` / `claimInbox` / `archiveMessage` / `appendTrace` | 总线读写；原子发布、no-clobber、TTL 判定 |
| `target.ts` | `isUserSession` / `rankUserSessions` / `decideTarget` | 投递目标裁决（用户会话优先、最近活跃优先）——与 sentinel 的 wake-target 同源规则，**独立主副本**（禁止跨插件 import） |
| `state.ts` | `loadState` / `saveState` / `markHandled` / `isHandled` | 幂等集合与游标 |

### 5.3 工具面（模型可见契约）

| 工具 | 参数 | 返回 |
|---|---|---|
| `cluster_status` | 无 | 本节点身份、总线路径、在线邻居数、收发计数、待投递数、最近轨迹 |
| `cluster_nodes` | `includeOffline?` | 名册：id / role / profile / workspace / baseUrl / pid / lastSeenAgeMs / online / tags |
| `cluster_send` | `to`, `text`, `kind?`, `replyTo?`, `ttlMs?` | 是否写入、目标在线与否、消息 id；目标不存在 → 明确错误（不静默丢弃） |
| `cluster_broadcast` | `text`, `kind?`, `ttlMs?` | 逐目标写入结果表（含离线目标） |
| `cluster_inbox` | `limit?`, `peer?`, `pendingOnly?` | 收件箱条目（含已归档），按时间倒序 |

### 5.4 投递路径（调用点清单）

| 调用点 | 位置 | 说明 |
|---|---|---|
| 心跳 | `index.ts` 定时器 | 每 `heartbeatMs` 重写自身心跳 |
| 轮询 | `index.ts` 定时器 | 每 `pollIntervalMs` 扫描 `mailbox/<self>/` |
| 注入 | `deliver()` | `ctx.agents.get(sid)` → `agent.steer(createUserMessage(...))` |
| 目标裁决 | `deliver()` | 无用户会话/agent 未激活 → 保留原位 + 退避重试 |
| 归档 | `deliver()` 成功后 | `mailbox/<self>/done/`，并 `state.markHandled(id)` |
| 死信 | 重试耗尽/过期 | `mailbox/<self>/dead/` + 轨迹 |
| 启动自检 | `apply()` | 立即心跳一次 + 投递积压（不依赖首个定时器 tick） |
| 卸载 | `ctx.effect` disposer | 清定时器、删自身心跳文件（离线立即可见） |

### 5.5 任务台账（`tasks/<taskId>.json`）· v0.2 新增

```jsonc
{
  "v": 1,
  "taskId": "t-<base36>",
  "intentRef": "主人的原话摘录",        // 可追溯到「方向」原话，不转述
  "createdBy": "primary",              // 主脑 nodeId 或角色名
  "assignee": "<nodeId>",
  "acceptance": "可执行/可证伪的判据",   // I9：空或占位符 → 禁止派发
  "grade": "L1",                       // L1 可复现 / L2 可核对 / L3 仅声明
  "status": "drafted",
  "steps": ["…"],                      // 可选：主脑给出的粗拆解（节点可自行细化）
  "lastProgressAt": 0,
  "budget": { "turns": 20, "toolCalls": 80 },
  "result": { "status": "…", "summary": "…", "evidence": [], "unverified": [], "learnings": [] },
  "verdict": { "by": "primary", "at": 0, "pass": true, "method": "复现证据 / 核对证据", "note": "…" }
}
```

- **状态机**：`drafted → dispatched → running → returned → verifying → done | failed`；主脑失效期间未验收的落 `pendingVerification`（由新主脑接手）。
- **写者**：**只有主脑**（I8）。执行节点通过消息（`event` / `result`）回报，由主脑推进状态。
- **`budget` 是软上限**：节点可自报超限（回 `status: blocked` + 说明），主脑改派或放宽。

### 5.6 任务消息与结果消息 · v0.2 新增

**派发**（`kind: "task"`，`to = assignee`）：

```jsonc
{ "v": 1, "id": "m-…", "from": "<primary>", "to": "<worker>", "kind": "task",
  "text": "人读的派活说明（含意图与判据）",
  "meta": { "taskId": "t-…", "acceptance": "…", "grade": "L1",
            "payload": { "steps": [ /* 结构化指令，见 5.8 */ ] } } }
```

**结果**（`kind: "result"`，`meta.replyToTask = taskId`）：

```jsonc
{ "kind": "result",
  "meta": { "taskId": "t-…", "status": "ok|failed|blocked|partial",
            "summary": "一行结论",
            "evidence": [ { "kind": "file-digest|exit|assert", "path": "…", "sha256": "…", "note": "…" } ],
            "unverified": ["没能验证的部分"],
            "learnings": ["可复用经验（回流素材）"] } }
```

**过程三态**（`kind: "event"`，同 `meta.taskId`）：`started` / `progress` / `blocked`。**不报百分比**（spec §5.1）。

### 5.7 行为事件（`logs/actions/<actionId>.jsonl`）· v0.2 新增

```jsonc
{ "atMs": 0, "actionId": "a-…", "node": "<nodeId>", "actor": "primary|<nodeId>",
  "stage": "start|stage|done|failed", "step": 3, "total": 6,
  "humanText": "正在创建预设目录", "detail": { } }
```

- **强制分阶段**：结构性动作（创建/销毁实例、部署/更新插件、启停服务、大规模派发）**每步一条**，不得只在结束时写一条（I10）。
- 这是「实时行为流」的数据源；`humanText` 是给人看的一句话（**显示「正在做什么」，不假装显示「正在想什么」**）。
- **`actionId` 语义**：一次「结构性动作」= 一个 `actionId`；同一 `actionId` 的条目按写入顺序即时间线。

### 5.8 参考适配器（`scripts/ref-node.mjs`）· v0.2 新增

**存在意义**：它是**协议的活证明**（非 DSH 运行时也能成为节点 ⇒ harness 无关从声称变实测），也是**接入模板**（第三方照它写自己的适配器）。

**职责五拍**（强制，缺一不算节点）：

| # | 拍 | 落点 |
|---|---|---|
| 1 | 注册心跳（含 `capabilities[]`） | `nodes/<nodeId>.json` |
| 2 | 收任务 → **自己拆解**（把 payload 展开为带序号的 plan） | `logs/actions/<actionId>.jsonl` 首条 `stage: start` 的 `detail.plan` |
| 3 | 逐步执行（每步一条 `stage: stage`） | 同文件的 `step N/total` |
| 4 | 回结果（四字段 + 证据） | `mailbox/<primary>/<id>.json`，`kind: "result"` |
| 5 | 收口（`stage: done|failed`）+ 记录已处理任务（幂等） | 同文件 + `state/<nodeId>.tasks.json` |

**指令集（v1，白名单 op）**：

| op | 参数 | 语义 |
|---|---|---|
| `fs.mkdir` | `path` | 递归建目录（已存在不算错） |
| `fs.write` | `path`, `content`, `mode?`（`overwrite`\|`create`） | 写文件；`create` 时已存在 → 拒 |
| `fs.replace` | `path`, `find`, `replace`, `expectCount?` | 文本替换；命中数与 `expectCount` 不符 → 该步失败 |
| `fs.remove` | `path`, `recursive?` | 删文件/目录 |
| `fs.assert` | `path`, `exists?` | **只读断言**，产出 `evidence`（`kind: "assert"`） |
| `fs.digest` | `path` | 计算 sha256，产出 `evidence`（`kind: "file-digest"`） |

**安全边界**（硬约束）：

- **路径白名单**：所有 `path` 解析后必须位于 `--workdir` 之下；越界 → **拒绝该步并回 `blocked`**（I11）。
- **不执行 shell**：v1 **不含** `shell.exec`（记 U8 未决）。适配器不 spawn 任何子进程。
- **规模上限**：单文件 ≤ 1 MiB、单任务 ≤ 64 步、单步超时 30 s；超限即停 + 回 `blocked`。
- **不做网络**：不发请求、不监听端口。

## 6. 边界与信任

- **能力边界 ≠ 沙箱**：总线是普通目录；插件不提供也**不承诺**隔离。同机任意进程可读写总线文件。
- **输入不可信**：所有从总线读入的 JSON 都按不可信数据处理——版本校验、字段类型校验、长度截断、未知键忽略；坏文件跳过 + 轨迹留痕，**绝不抛进主流程**。
- **不接触凭据**：v0.1 不读写 `.credentials.yaml`，不发起任何网络请求，不监听端口。
- **不越界清单**：不 kill/重启其他实例；不写其他节点的 `nodes/` 与 `state/`；不删他人消息（只移动自己 mailbox 内的文件）；不自动回复消息。
- **子进程/资源**：插件不 spawn 任何子进程。
- **失败面**：写失败（磁盘满/权限）→ 返回错误给调用方（工具面可见），不伪造成功；读失败 → 跳过该条并累计 `readErrors`。
- **权限语义**：`cluster` 消息是平级来信，注入文本必须带来源前缀（`[cluster:<from>]` / `[cluster:<from>/<kind>]`），且系统提示语义上**不获得主人指令的优先级**。
- **台账不是授权凭证**（v0.2）：`tasks/*.json` 里出现什么，都不构成对节点操作面的扩大——节点只执行**自己白名单内的 op**，判据字段不改变权限。
- **执行节点的通道边界**（v0.2，对应 spec P2-5）：执行节点预设**不挂** telegram 等直达主人的通道——它只能回总线（结构性可验证：工具面里没有那些工具）。

## 7. 可证伪验收清单

> **A 表（v0.1，通讯底座）**：2026-09-14 状态回修——原表 11 条全标「待…」，实际已由当日交付验证。
> 代号：**U** = 离线单测（`pnpm test`，**58 passed / 0 failed**）· **E** = 端到端联调 · **—** = 尚未覆盖。

| # | 命题 | 状态 | 证据 |
|---|---|---|---|
| A1 | 两节点运行后，各自 `cluster_nodes` 都能看到对方且标记 online | **已实测** | ✔ E：`sim-node-a` 出现在名册且标 online |
| A2 | A `cluster_send` → B 会话收到注入消息，前缀含 `[cluster:A]` | **已实测** | ✔ E：会话真实收到 `[cluster:sim-node-b] …`，前缀正确 |
| A3 | A `cluster_broadcast` → 其余节点都收到，A 自己**不**收到 | **单测已验** | ✔ U：广播构造与目标过滤（`protocol` / `target` 测试） |
| A4 | 同一 messageId 重复投递只注入一次 | **单测已验** | ✔ U：`state.test.mjs` 滚动幂等集合 |
| A5 | 目标 agent 不可用时消息保留原位，agent 就绪后仍投递 | **已实测** | ✔ E：搁浅消息经接管后仍 `delivered`；U：退避重试账 |
| A6 | 心跳超过 `offlineAfterMs` → 名册标 offline；在线计数同步变化 | **单测已验** | ✔ U：`identity.test.mjs` 判活阈值 |
| A7 | 坏 JSON / 缺字段 / 超长 text / 未来版本 → 跳过并落痕，插件不崩 | **单测已验** | ✔ U：`protocol.test.mjs` + `bus.test.mjs` 坏样本 |
| A8 | 在线判定 / 名册显示 / 发送警告共用同一阈值常量（判据单源） | **单测已验** | ✔ U：断言 `DEFAULT_OFFLINE_AFTER_MS` 同源 |
| A9 | dispose 后无残留定时器、自身心跳文件已移除、无文件句柄泄漏 | **未覆盖** | ⚠ 待验收：无测试（HMR 安全相关，建议补一条尸体测试） |
| A10 | 写失败（只读目录）时工具返回明确错误，不静默；轨迹仍可写时不崩 | **单测已验** | ✔ U：`bus.test.mjs` 写失败路径 |
| A11 | 注入消息可从会话事件流重建（Model-visible ⟺ logged） | **已实测** | ✔ E：会话事件流中可见注入文本 |

> **给解析器与读者的约定（2026-09-15 补）**：`semantic_check` 判定「已证」看的是**证据列（行内最后一个非空单元格）**是否含 `✔`/`✓`/`✅` 或「已实测 / 实测通过 / 已通过验收」；判定「显式待验」看**整行**是否含「待验收 / 待线上验收」。此前我用「**已验证**」写在**状态列**，词不在词表、位置也不对 ⇒ 机器读作「既未证也未标待验」（`unprovenUnmarked`），18 条全被判未证。**声明必须是机器可读的形状，否则等于没有声明。**

> **B 表（v0.2，任务协议与参考适配器）**——与 spec §7-P2 的映射：

> **2026-09-14 深夜实测回填**：B1–B6 已在**独立测试总线**（`_tmp_p2/bus`，零污染真实总线）上端到端验证。
> 复现方式：起 `scripts/ref-node.mjs`（`--workdir` 白名单内）→ 用 `scripts/ledger.mjs` 走 `new → dispatch → collect → verdict`。

| # | 命题 | 对应 spec | 状态 | 证据 |
|---|---|---|---|---|
| B1 | 台账缺 `acceptance`（空/占位/过短）→ **拒绝派发**并报错，不静默发出 | P2-1 | **已实测** | ✔ 三组不合格全被拒（`exit 3`）：空判据（空格）→「判据为空」· 占位符「待定」→ 拒绝 · 过短「改好」→ 拒绝；合格判据 `exit 0`。另：**参数缺值 → `exit 2` 明确报错**（修复了「静默填 `'true'`」缺陷——PowerShell 吞空串会触发） |
| B2 | 参考适配器收到任务后**自己拆解**，plan 落盘可见（序号 + 每步意图） | P2-2 | **已实测** | ✔ `logs/actions/a-mu1ei9rq-….jsonl` 首条 `stage: start` 的 `detail.plan` = 6 项（`step`/`op`/`target`/`humanText`） |
| B3 | 结果四字段齐备（status/summary/evidence/unverified），且证据**可被主脑复现** | P2-3 | **已实测** | ✔ ① `config.txt`：节点报 `9897034597a904adf9f11c3e0bbbcab3519d74cbce7a61d86d0d09a0b6b7f5e1`，主脑独立复算**逐字符一致** ② `hello.txt`：`13ebcc8e…` 同；且文件字节数 40→33 与一次 `参考适配器`→`ref-node` 替换**算术吻合**（第二重独立证据）。四字段齐备，`unverified` 为空数组而非缺字段 |
| B4 | 结构性动作**分阶段**落盘（≥ 步数条），非只在结束时一条 | I10 | **已实测** | ✔ 6 步任务的 actionId 文件 **8 行** = `start` + 6×`stage` + `done`；每行含 `atMs/actionId/node/actor/step/total/humanText` |
| B5 | 路径越界（workdir 之外）→ 拒执行并回 `blocked`，不产生副作用 | I11 | **已实测** | ✔ `fs.write path:"../evil.txt"` → `status=blocked`（理由「路径越界（workdir 之外）」）；**白名单外无文件产生**；第 2 步**未执行**（`inside-ok.txt` 不存在）；行为事件以 `failed` 收口 |
| B6 | 同一 `taskId` 重复派发 → 适配器只执行一次（幂等） | I3 的推广 | **已实测** | ✔ 重发同 `taskId` → 回 `status=duplicate`；`hello.txt` sha256 **未变**（未被覆盖）；`state/<nodeId>.tasks.json` 的 `handled` 无重复项 |
| B7 | 执行节点**无直达主人通道**（工具面可验证） | P2-5 | **未达成** | ⚠ 待验收：预设侧已不挂 `tool-ask-user`；但 `dsh-agent-telegram` 由**宿主组合**提供（`plugin_list` 实测 `挂载: web`），**所有预设**都拿到 ⇒ 预设层面移不掉。需把 telegram 下移主脑预设（U11）。**诚实标注为未达成，不当作已解决** |

## 8. 与实现的关系

- 主实现：`self-plugins/dsh-agent-cluster/src/`（host-only，无 client 面）+ `scripts/ref-node.mjs`（参考适配器，独立进程，非插件代码）。
- 语义主副本：本文件。`README.md` 面向使用者（安装/配置/用法），不复制语义。
- 依赖：`ctx.tools`（工具面）、`ctx.agents`（投递）、`ctx.session`（用户会话枚举）。无对其他自研插件的 import（规则：不跨插件内部 import）。
- 与 `dsh-agent-sentinel` 的关系：**同源规则、独立实现**——哨兵的 `wake-target.ts` 是「唤醒目标裁决」主副本，本插件的 `target.ts` 是「收件投递目标裁决」主副本；两者规则一致但不是同一份代码（跨插件 import 违规），差异需在各自「实践修订记录」里对齐。
- 与 `alice-workbench` 的关系：工作台**只读**总线（`nodes/` / `mailbox/` / `cluster-trace.jsonl` / `tasks/` / `logs/actions/`），单一写面是 `mailbox/<node>/*.json`（`from: "owner"`）。任务视图的数据源 = `tasks/`。

## 9. 实践修订记录

| 日期 | 类型 | 内容 |
|---|---|---|
| 2026-09-14 | 立项 | 主人指令；取证确认跨实例投递官方路径（`/api/session/prompt` + browser-auth cookie）与进程内路径（`agent.steer`），v0.1 选**纯文件总线**（无端口、无凭据、跨 DSH_HOME 可用） |
| 2026-09-14 | **事故** | **插件杀死了宿主 web 进程**：会话尚未装载时 `Session.events === undefined`，`target.ts` 的 `lastRealUserPromptAt` 直读 `.length` → `TypeError` 从 `setInterval` 回调**逃逸**（插件与宿主**同进程**，异常无框架兜底）。指纹：时间线精确到 1 秒（消息到达 10:52:50.2 → 进程消失 10:52:51.1），且**侧车轨迹里没有该消息的任何记录** ⇒ **崩在第一次落盘之前**——所以「没有日志」≠「没被触发」。**修复三层**：① `guarded()` 包住心跳/轮询全部回调 ② `safeDeliver()` 包单条投递 ③ 代理访问各自 try/catch；并加 **4 条源码级守卫契约测试**（`guard-contract.test.mjs`）锁死「新回调不得绕过兜底」。真凶是靠轨迹里一条 `deliver-error` 定案的 |
| 2026-09-14 | 修复 | **收件箱接管（`takeOverInbox`）**：节点重启后 `nodeId` 带 pid 会改名，旧身份的收件箱必须被接管，否则「改名即丢消息」 |
| 2026-09-14 | 对齐 | **触发者绑定**（主人口头规则「谁触发，提醒就发到谁」）：同源规则落在 `dsh-agent-plugin-manager`（改用 `exec.agent` 调用者会话）与 `dsh-agent-sentinel`（`wakeTarget` 加 `trustAnchor`）。本插件 `target.ts` 与哨兵 `wake-target.ts` 是同源规则的两个独立实现，本次未改动本插件，记录以备下次对齐 |
| 2026-09-14 | **设计修订（v0.2）** | 写 P2 任务协议时发现 spec §3.2 的台账 schema **未指定写者**，而执行节点若直写台账会违反 I5（多写者竞争：主脑写 `verdict`、节点写 `status`/`result`，读-改-写窗口重叠）。**修正为 I8：台账单写者 = 主脑**；执行节点只回 `event`/`result` 消息。代价：台账状态滞后 ≤ 一个主脑处理周期（可接受——台账是验收账本，不是实时进度板；实时进度由 `logs/actions/` 承担）。新增 I9（判据先行）/I10（必落行为事件）/I11（路径白名单）三条不变量 |
| 2026-09-14 | 补充（v0.2） | **参考适配器升格为协议产物**：`scripts/ref-node.mjs` 从「联调工具」定位为「协议的活证明 + 接入模板」。原 `scripts/sim-node.mjs`（被动模拟器）保留为**测试夹具**，两者职责分离（夹具轻量无副作用；适配器要健壮、要写文档、要被第三方照抄） |

## 10. 未决问题

- **U1 实时推送通道**：轮询延迟（默认 2s）是否够用？是否需要 HTTP 推送（自建 `/cluster` 路由 + 总线密钥）？——若启用，需先确认非 `/api` 路由是否绕过宿主认证（取证进行中）。
- **U2 消息语义状态机**：`task`/`result` 是否需要回执（ack）、超时、状态流转？——**部分回答（v0.2）**：三态回报（started/progress/blocked）与 result 四字段已定；**ack 与超时重派仍未定**。
- **U3 面板可视化**：名册与消息流是否要以面板呈现（`dsh-panel` 形态）？
- **U4 跨机安全**：非 loopback 场景的密钥/TLS/白名单——仅在启用推送后才有意义。
- **U5 主人广播工作台**：是否需要「主会话 → 全体节点派发 + 汇总回收」的一等场景（而非靠广播消息手工拼）？
- **U6 端口真源**：心跳中 `port` 恒为 `0`、`baseUrl` 为空 ⇒ `webServer` 端口探测失败。需在心跳周期内**重试解析**（对照 §5.11 的锚点腐化处理：锚点不可用则回退运行时真源，两者皆无则显式置空而非填 0）。附带：`nodeId` 因端口缺失而退化为 `web-0`，重启后靠 pid 后缀改名——这既是 U6 的症状，也是收件箱接管机制的由来。
- **U7 语义文档覆盖度**：A9（dispose/HMR 残留）尚无测试，见 §7。
- **U8 命令执行能力的安全边界**（v0.2）：参考适配器 v1 **不含** `shell.exec`。要做「能跑命令的节点」需要先回答：白名单怎么做（命令级？参数级？）、超时与输出上限、失败如何回传、以及**插件/适配器同权限运行**的风险（能力 ≠ 沙箱）。在回答之前不实现。
- **U9 台账滞后容忍度**（v0.2）：I8 的代价是台账状态滞后一个主脑处理周期。若主人希望「点开任务即见实时进度」，需要引入**执行侧只读侧车**（如 `logs/actions/` 已承担）或让节点回更频繁的 `progress` 事件——取舍待实测（先看 P2 跑起来后主人是否真的需要实时进度）。
- **U10 陈旧节点清理**（v0.2）：`nodes/` 会随重启累积历史心跳（实测本机已 13 个 web 节点文件）。名册显示离线节点是**设计意图**（审计价值），但「半年后的 200 个死节点」需要归档策略（如 `nodes/archive/` + 保留期）。未定。
- **U11 宿主插件与预设边界的错配**（v0.2 实测）：`dsh-agent-cluster` 与 `dsh-agent-telegram` 都挂在**宿主组合**（web profile，`plugin_list` 实测 `挂载: web`）⇒ **所有预设**（含 `worker-base`）都会拿到它们。前者正合需要（节点自动有网络身份，无需预设挂载）；后者违反 spec §4.2「执行节点不挂 telegram」与 **P2-5「无直达主人通道」**——**预设层面无法移除宿主提供的插件**（预设只能「增加」本会话贡献的行，收不回宿主的）。候选修法：① 把 telegram 下移到主脑预设 `alice-v2`（需主会话在场 + 重启；注意 inbound 长轮询是宿主级长期连接，下移后仅主脑预设会话收信）；② 保留宿主，但在派发层用「节点不可用该工具」的**约定 + 审计**替代结构性隔离（弱保证，需明说）。**更一般的未决**：这条边界该沉淀为 harness 的组合纪律——「哪些能力属于宿主（全进程共享）、哪些属于预设（按会话收窄）」，以及**收窄型需求**（默认给、特定预设不给）在现行两平面模型下有没有一等表达。

# dsh-agent-cluster — 语义文档（DSH 多实例通讯底座）

## 1. 元信息

| 项 | 值 |
|---|---|
| 版本 | v0.3（语义稿；v0.2 增补 P2 任务协议与参考适配器；v0.3 增补身份回收与血统清扫） |
| 日期 | 2026-09-15 |
| 状态 | 实现逼近中（验收清单逐条标注证据；A1–A11 已回修，B1–B7 为 P2 新增，A12–A13 为 v0.3 新增） |
| 实现落点 | `self-plugins/dsh-agent-cluster/src/{index,protocol,identity,bus,target,state}.ts` + `scripts/ref-node.mjs`（参考适配器） |
| 主副本 | 本文件（`docs/semantic.md`）；无同语义副本 |
| 设计者 | 爱丽丝（主人 2026-09-14 指令：「创建一个插件多个 DSH 实例之间通讯，打造多智能体工作台」） |

> **复核记录（2026-09-22）**：`semantic_check` D3 复核为 **真过时**（impl 侧动过、文档无痕迹）——触发者是**未提交的工作区改动** `src/index.ts`（2026-09-19，已构建进 `lib/index.js`）：投递侧会话枚举由 `s.events` 改为 `s.snapshotEvents()`（上游 DSH 0.1.6 已移除 `Session.events` 公共属性）。本次补记见 §5.2 注 / §7 A14 / §9 / §10 U12。

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
| **结构性不可注入（structural miss）** | 本节点**没有**可注入的顶层用户会话——不是「暂时没投成」，是「这条路对我不可用」。处置为**保持态**：消息保留在 inbox、不消耗重试、由 TTL 兜底（§5.12） |
| **保持态（hold）** | 消息被刻意留在 inbox 等取用的状态。⚠ **与 `held` 不是一回事**：`held` 是**配置选择**（`autoInject=false`，留给 `cluster_inbox` 取用），保持态是**本节点结构性不可注入**。两者都留在 inbox，但理由与落痕不同（`held` vs `hold-no-session`） |

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

- **I1 身份唯一且可见**：同一 `nodeId` 在同一时刻只对应一个活跃进程。启动时若发现同名心跳，按下列顺序裁决（v0.3 起不再只看新鲜度，还看**心跳里那个 pid 是否还活着**）：
  - 那个 `pid` **同主机且确认已死** → 那是**我的前身**（不是别人）⇒ **回收原名**（`reclaimed`，不再改名）；
  - 心跳活跃（pid 存活，**或判活未知**）→ **改名**（`<base>-<pid>`）并写轨迹，绝不静默覆盖；
  - 心跳陈旧（超 `offlineAfterMs`）→ **接管**该身份。
  - **保守优先**：判活未知一律按「活着」处理——宁可多一次改名，不可误夺活节点的名。
- **I12 启动即收自己的尸**（v0.3）：启动时清扫**自己的死前身**留下的 `nodes/*.json` 与 `state/*.json`。判据（纯逻辑 `shouldReap`）：同主机 + 同 profile + id 落在 `<host>-<profile>` 前缀内 + pid **确认已死** + 不是自己。**不碰别人的血统**（`wb-0`/`ref-0`/其它主机各有其所有者）；**不删消息**（收件箱目录留给所有者与审计）。动机：每次重启都因「同名心跳仍新鲜」而改名避让，攒下死心跳——名册把它们当节点、工作台把它们画成离线星（实测一次攒到 **17** 个，其中两对同名 `web-0`）。
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

> **会话历史的读取路径（2026-09-22 复核补记）**：投递目标裁决要判「用户会话 / 最近活跃」，数据取自 `ctx.sessions.list()` 的会话摘要——其历史事件经 **`s.snapshotEvents()`** 同步读取（**DSH 0.1.6 已移除 `Session.events` 公共属性**：`packages/core/session/src/index.ts` 的 `Session` 类只暴露 `eventAt` / `snapshotEvents` / `ownEvents`），并保留 2026-09-14 事故的防线——**非数组一律归一为空数组**（会话未装载时不得抛，异常更不得从定时器逃逸）。
> ⚠ 该读取器在上游**已被标记 deprecated**（`@deprecated … new calls are prohibited`，见 DSH 仓 `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`）⇒ 本次是**恢复功能的临时适配**，长久方向是改读**投影 / 显式观察**（`SessionObservation.events` + cursor）。债务记在 U12。

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
| 目标裁决 | `deliverOne()` | **两种语义分开**（§5.12）：**无顶层用户会话** ⇒ 结构性不可注入，消息保留原位、**不消耗重试**、落一次 `hold-no-session`；**会话探测失败** / agent 取不到 / 注入抛错 ⇒ 可恢复，按有界退避重试（统一走 `retryLater` 出口） |
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

### 5.9 跨机承载（传输适配器 + 成员册）· 2026-09-22 新增

> 设计正本：`docs/members.md`（成员模型 / 身份与信任 / 为什么必须动这一层）。**本节只写契约，不重复设计理由。**

**缺口**：总线是**本地文件目录** ⇒ 当对方的「本机」与我的本机不是同一台时，文件**物理上到不了**。
这是「第二成员 = 上游 `dsh-tavern`」暴露出的唯一结构性缺口（`members.md` §1）。

**三条 `[MUST]`**：

1. **默认关闭**：`listenPort: 0`（默认）+ 未配 `secret` ⇒ **不监听、不推送**，行为与加网络层前**逐字节相同**。加网络层是对 §6 的**有意修订**，所以它不许成为默认。
2. **fail-closed**：无密钥 / 错密钥 / 非成员（`trust: unknown`）/ 时间戳过期 / 明文 http 到**非回环**地址 ⇒ **一律拒**；且**拒在网络之前**（不合规地址连请求都不发）。每次拒绝落 `http-inbound-reject` / `peer-push` 轨迹（可回答「为什么没收 / 为什么没发」）。
3. **承载可替换、协议不变**：跨机消息仍是 `protocol.ts` 的 v1 envelope；入站消息**落进本机收件箱**后走**同一条**轮询 → 裁决 → 注入管线——**不制造第二条投递路径**（有第二条路径就会漂移）。

**配置面**（全部有安全默认）：

| 键 | 默认 | 语义 |
|---|---|---|
| `listenPort` | `0` | 自开入站端点端口；`0` = 关闭 |
| `allowInbound` | `false` | 是否接受入站（跨机互联要显式打开） |
| `secret` | `''` | 共享密钥（HMAC-SHA256，签名载荷 `<ts>.<body>`）；空 = 既不收也不发 |

**成员册**：`<busDir>/members/<memberId>.json`（形状与信任级见 `members.md` §3）。
**它是唯一的准入真源**——心跳（`nodes/*.json`）只证明「在线」，**不证明「被允许」**；`trust: unknown` 一律不收。

**工具面**：`cluster_members`（看册子 + 承载状态）· `cluster_peer`（推给跨机成员；同机成员仍走 `cluster_send`）。

**可跑证据**（本节契约的验收命令——`13/13` 判据，`exit=0` 可直接当闸门）：

```bash
cd self-plugins/dsh-agent-cluster && node scripts/peer-demo.mjs
```

它起**两个真实端点**（`node:http`，端口 0 取系统分配）并验证：正常投递（**对照组**）· 错密钥 `401` · 未知成员 `403` · 不在册 `403` · 明文 http 到非回环**连请求都不发** · 无密钥拒发 · 存活探针只回协议版本；同时打印线级轨迹（回答「为什么收 / 为什么拒」）。
⚠ **边界**：全部跨机验证都在**同机双端口**上完成——**真实第二台机器未验证**。

**边界诚实**：HMAC 只挡**跨机 / 跨用户**的伪装；同机同用户的进程仍能读 `DSH_HOME` 里的密钥——§6 已承认这一点，本节**不改这个判断**。

### 5.10 宿主兼容与版本容忍（能力探测优先于版本号）· 2026-09-22 新增

**缺口（为什么需要这一节）**：本插件的**交付形态是「可安装」**——装到谁的机器上、对方的 DSH 是什么版本，**由对方决定，不由我决定**。上游 `dsh-tavern` 就锁在一个**比我更旧**的版本（`0.1.2-rc.1` vs 我本机 `0.1.6-alpha.2`）。

⚠ **2026-09-22 更正（本节曾写错）**：这里原先写着「第一个真实差异已实测到手：`Session.events`（0.1.2-rc.1 有）vs `snapshotEvents()`（0.1.6+ 有）」。**那是错的，而且它不是读数、是上一轮会话里一个未核实的假设**——我把它写进了代码注释、本节、`SUPPORTED_HOSTS` 与技能文档，于是「假设」长成了「事实」。静态取证（读 `0.1.2-rc.1` 自己的 `dsh-session/lib/index.js` 与其类声明）显示：**两个世代的会话读取面同形**——都有 `snapshotEvents()` / `ownEvents()` / `eventAt()` / `seq`，**都没有**公开 `events` 属性。
⇒ **本节的存在理由不变**（跨宿主兼容仍必须做，`inject` 仍不保证 API 形状），但**第一个「已知差异」的例子作废**：`events` 那条回退是给**未知/更旧宿主**留的兜底，不是为这两代准备的。
**教训（值得比这一节本身活得更久）**：**未核实的假设一旦写进正本，就会被后来的人——包括我自己——当成读数**；且它在四个载体间互相「印证」，更难被怀疑。⇒ 形状断言要么显式标「推断」，要么当场取证；`SUPPORTED_HOSTS.tested` 因此从两档扩为**三档**（`实测` / `静态` / `推断`）——「我读过对方代码」比我瞎猜强得多，**档位不够会逼人撒谎**。**2026-09-22 再扩为四档**：新增 **`进程外运行期`**（**执行了对方所带的真实产物**——进程外导入并枚举其运行期 API 面——但**不在**对方的进程里）。两次扩档是同一句话的两面：第一次防的是 **overclaim**（把「读过代码」说成「实测」），第二次防的是 **underclaim**（把「跑过它的产物」压成「读过源码」）。

**三条规则**：

1. **能力探测优先于版本号**。版本字符串**是提示、不是判据**——同一版本的不同构建/发行版能力可以不同，而版本号比较（`0.1.2-rc.1 < 0.1.6`）**推不出「哪个 API 在」**。判据永远是「**这个 API 在不在**」。
2. **`inject` 只保证「服务在」，保证不了「服务上的 API 还在」**。`inject` 是 cordis 的**激活门**（服务缺席 ⇒ 插件不激活），所以被注入的服务必然可用；但**服务对象上的方法与属性会跨版本漂移**（`Session.events` 就是这样丢的）。⇒ 服务存在性交给 `inject`（结构性保证），**API 形状交给探测**（运行期判断）。
3. **探测无副作用、绝不抛**。探测发生在 `apply` 期与投递链路里——**与宿主同进程**，抛异常会杀死宿主 web（§9 · 2026-09-14 事故）。所有探测经 `pickCallable` / `readSessionEvents`（内部吞错并**如实记录经由哪条路径**），**未知一律降级为「无候选会话」，绝不抛**。

**契约面**（`src/host-compat.ts`，纯模块，可离线测）：

| 导出 | 语义 |
|---|---|
| `pickCallable(obj, names)` | 按序返回第一个**可调用**成员（`{ name, fn }`）；非对象 / 全无 ⇒ `undefined`；**不抛** |
| `readSessionEvents(session)` | 返回 `{ events, via, fellBack }`；`via ∈ 'snapshotEvents' \| 'events-property' \| 'none'`；非数组归一为 `[]`；**不抛** |
| `probeHostCompat(sessions)` | 聚合探测：`sessionEvents` 采样 × `version`（尽力取得，取不到是常态）× `verdict ∈ supported \| degraded \| unsupported` × `reasons[]` |
| `describeCompat(compat)` | 一行可读串（落轨迹 / 工具面显示用） |
| `SUPPORTED_HOSTS` | **声明支持区间**：每条 `{ dsh, tested: '实测' \| '进程外运行期' \| '静态' \| '推断', note }`——**四档分列，不许混为一谈**（档位含义见类型定义；`进程外运行期` = 跑过对方的产物但不在其进程内） |

**判定语义**（`verdict`）：

- `supported`：会话历史读取路径可用（`via !== 'none'`）。
- `degraded`：**能跑但会变笨**——典型是 `sessionEvents === 'none'`（投递目标裁决退化为「无最近活跃」，**不报错、只变笨**）；或**尚无会话可采样**（`no-sessions-yet`：不是错，是时机）。
- `unsupported`：必需服务面自证缺失。⚠ 正常路径下**不该出现**（`inject` 会先让插件不激活）——出现即说明探测看到了异常宿主，须记录而非掩盖。

⚠ **`degraded` 必须响亮**：不许静默。落 `host-degraded` 轨迹 + `cluster_status` 的 `host` 段直接显示原因。（教训来自本插件自身：`s.events` 取不到时**不报错**，只是所有会话历史恒为空。）

**可见面**：`cluster_status` 新增 `host` 段（`verdict` / `sessionEvents.via` / `version` 或「未取得」/ 声明支持区间），`render` 显示一行 `宿主 <verdict> · 会话读取 <via> · 版本 <v|未取得>`。

**边界诚实**：

- 「支持区间」是**声明**不是保证——`SUPPORTED_HOSTS` 里 `tested: '推断'` 的条目**没有实测过**，不得当作已支持。
- 版本号**常常取不到**（本插件目前无**已实证**的版本源）⇒ `version: ''` 是**正常结果**、不是故障；**判定不依赖它**。

### 5.11 入网凭证与向导（邀请令牌 · 一步入网）· 2026-09-22 新增

**缺口**：§5.9 的成员册要**手工写 `members/<id>.json`** 才算加入。但本插件的交付形态是「**装了这个插件的智能体都能接入网络**」（主人 2026-09-22 定义）⇒ 入网必须是**对方一步就能做完**的事，不能要求对方手工拼 JSON，更不能要求他知道我的 `busDir`。

**令牌 = 一次入网的完整凭据**（`src/invite.ts`，纯模块）：

```
dshc1.<base64url(payload)>.<指纹 16 hex>
payload = { v:1, net, url, host, member, secret, exp, nonce }
```

| 字段 | 作用 |
|---|---|
| `net` | 网络标识——防止令牌被用到另一个网络（`not-my-network`） |
| `url` | 主脑入站端点地址（入网请求推到这里）⇒ **对方不需要知道我的 `busDir`** |
| `host` | 主脑成员 id |
| `member` | **本令牌唯一准入的成员 id**（准入决定在**签发时**就已做完） |
| `secret` | 该成员**专属**密钥（非全网共享密钥） |
| `exp` / `nonce` | 期限 / 重放检测 |

**四条设计判断**（都是为了「不把入网做成一个安全洞」）：

1. **令牌带专属密钥，不是全网共享密钥**。把共享密钥放进令牌，等于「一个令牌泄露 = 全网钥匙外流」。每张令牌现生成 32 字节密钥，只绑一个成员 id。
2. **指纹只抓损坏，不是认证**。持有令牌的人同时持有密钥，**他自己就能重算指纹** ⇒ 指纹的价值是「复制不全会**当场**报错」，而不是「防篡改者」。**不许把它说成签名。**
3. **一个令牌准入一个人**。`member` 在签发时定好，入网方**不能自选身份**；主脑侧再以 `expectedMember` 比对请求者自报身份（`member-mismatch`）。
4. **密钥绝不回显**。`describeInvite` 隐去密钥、`redactToken` 只留前缀与指纹——令牌会流经聊天与日志，那正是凭据最容易死的地方（AGENTS.md §5.25）。

**判定面**（全部纯函数，可离线证伪）：`mintInvite` · `parseInvite`（**never throws**，10 种理由：empty / bad-prefix / bad-payload / bad-fingerprint / bad-version / missing-field / bad-exp / expired / wrong-member / ok）· `decideJoin`（ok / not-my-network / **expired** / **replay** / member-mismatch）· `describeInvite` / `redactToken`。

**工具面**：

- `cluster_invite`（主脑侧）：为一个成员 id 签发令牌——**签发即准入**（同时写 `members/<id>.json`）。传 `member: '*'` 则签发**开放令牌**（谁拿到谁能进、身份由入网方自报）：此时**不**在签发时入册（还没有具体成员），准入发生在入网那一刻，且风险由工具输出**明写**、不藏在文档里。为什么要它：主人要的是「装上插件的智能体**都可以**接入」，而绑定式要求邀请方**先知道对方节点 id** = 鸡生蛋。
- `cluster_join <token>`（入网方）：解析 → 校验（`expectMember` = 本节点 id）→ 把入网请求推到 `url` → 取回主脑的成员记录写进自己的册子 ⇒ **双方互相入册**。

**端点**：`POST /cluster/join`（与 `/cluster/inbox` 并列）。⚠ 它**不用 HMAC 认证**——入网方此时**还没有**密钥（这正是令牌存在的理由），**令牌自己就是凭证**。fail-closed：缺令牌 / 指纹不符 / 过期 / 网络不符 / 重放 / 身份不符 ⇒ 一律拒，并落 `join-reject` 轨迹（**带理由**，可回答「为什么没进去」）。

**边界诚实**：

- 令牌是**持有者凭证（bearer）**——拿到就能用。这一点**无法用密码学消除**，只能靠「期限 + 一次性 + 单一身份绑定」把窗口收窄。
- 「一次性」由主脑侧记录已用 `nonce` 实现；**未做**的是吊销列表与已用记录的自动清理（长期运行会缓慢增长，见 U14）。
- **成员之间的互信仍是 v1 取舍**：专属密钥覆盖「该成员 ↔ 主脑」这条边；**成员与成员之间直连**（不经主脑）尚无共享密钥 ⇒ 要么各自互换令牌，要么继续走主脑。这条限制**必须对使用者明说**，不许含糊成「入网后大家都能互发」。

### 5.12 投递未成功的语义分类（`src/miss.ts`）· 2026-09-26 新增

**缺口（触发本节的实测断点）**：无会话节点（headless 执行节点）收到消息后走 `no-target` 分支，而该分支**消耗重试**（`noteFailure`）⇒ 20 次后消息进 `mailbox/<self>/dead/`。
后果不是「投递慢」，是**适配器再也读不到它**——headless 消费者直接读 mailbox（对照 `scripts/ref-node.mjs`），而 `dead/` 是死信区。**本该能工作的执行节点，被插件判死而结构性收不到活。**

**分类根据只有一条**：「这次没投成」是「**还没到时候**」，还是「**这条路对我不可用**」。

| 原因（`MissReason`） | 语义 | 类别 | 处置 |
|---|---|---|---|
| `no-target` | 探测**成功**、结果为空：本节点无可注入的顶层用户会话 | `structural` | 消息**保留原位**、不消耗重试、落一次 `hold-no-session`；TTL 兜底 |
| `sessions-unavailable` | 探测**失败**（宿主代理异常 / 会话面不可用） | `retryable` | 按有界退避重试 |
| `no-agent` | 已选中目标但 `ctx.agents.get()` 取不到 | `retryable` | 同上 |
| `inject-error` | `agent.steer()` 抛错 | `retryable` | 同上 |

⚠ **`no-target` 与 `sessions-unavailable` 必须分开**（本模块最容易写错的一条）：前者是「问到了，答案是没有」，后者是「根本没问到」。把后者归入 `structural`，等于把**宿主代理异常**静默成「本节点永久无会话」——**故障被美化成特性**。因此 `sessionLite()` 新增**探测失败位**（`sessionsProbeFailed`），使这两件事在投递侧可分。

**兜底与边界**：

- `structural` **不等于永不判死**：TTL（`isExpired`）仍会把它归入 `dead/`，只是**不由「重试耗尽」触发**。
- **落痕只做一次**（`state.ts` 的 `holdNoted` 簿记，滚动上限 200）：无会话节点每轮轮询都会走到这条分支，每轮都落会刷屏（2026-09-26 实测 **48** 条 `no-target` 只对应 **3** 条消息）。
- **`holdNoted` 不参与投递归宿**：既不阻止后续成功投递，也不影响 TTL；投递成功后由 `markHandled` 清除。
- **`attempts` 语义随之变窄**（只装可恢复的失败）：旧状态文件的 `attempts` 仍按原样读取，**字段缺失不判 `recovered`**（判 recovered 会让每个老节点重启后凭空丢掉重试账）。
- **不制造第二条注入路径**（§5.9 规则 3）：本次只纠正**错误的处置**，注入仍只有 `agent.steer` 一条路；保持态消息的消费方是**适配器**（直接读 mailbox）或**会话出现后的正常投递**，不是新的注入实现。

## 6. 边界与信任

- **能力边界 ≠ 沙箱**：总线是普通目录；插件不提供也**不承诺**隔离。同机任意进程可读写总线文件。
- **输入不可信**：所有从总线读入的 JSON 都按不可信数据处理——版本校验、字段类型校验、长度截断、未知键忽略；坏文件跳过 + 轨迹留痕，**绝不抛进主流程**。
- **不接触凭据**：不读写 `.credentials.yaml`。⚠ **2026-09-22 修订**：「不发起任何网络请求、不监听端口」这条**不再无条件成立**——加跨机承载后，显式配置 `listenPort > 0` 会**自开端点**（插件自己的端口，不碰宿主 web 端口）并允许出站推送。**默认仍成立**（`listenPort: 0` + 无密钥 ⇒ 不监听不推送）。新边界见 §5.9 与 `docs/members.md` §5。
- **不越界清单**：不 kill/重启其他实例；不写其他节点的 `nodes/` 与 `state/`；不删他人消息（只移动自己 mailbox 内的文件）；不自动回复消息。
- **子进程/资源**：插件不 spawn 任何子进程。
- **失败面**：写失败（磁盘满/权限）→ 返回错误给调用方（工具面可见），不伪造成功；读失败 → 跳过该条并累计 `readErrors`。
- **权限语义**：`cluster` 消息是平级来信，注入文本必须带来源前缀（`[cluster:<from>]` / `[cluster:<from>/<kind>]`），且系统提示语义上**不获得主人指令的优先级**。
- **台账不是授权凭证**（v0.2）：`tasks/*.json` 里出现什么，都不构成对节点操作面的扩大——节点只执行**自己白名单内的 op**，判据字段不改变权限。
- **执行节点的通道边界**（v0.2，对应 spec P2-5）：执行节点预设**不挂** telegram 等直达主人的通道——它只能回总线（结构性可验证：工具面里没有那些工具）。

## 7. 可证伪验收清单

> **A 表（v0.1，通讯底座）**：2026-09-14 状态回修——原表 11 条全标「待…」，实际已由当日交付验证。
> 代号：**U** = 离线单测（`pnpm test`，**63 passed / 0 failed**，v0.3 起）· **E** = 端到端联调 · **—** = 尚未覆盖。

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
| A12 | 同名心跳的进程**确认已死** → 回收原名；判活未知/他机/pid 无效 → 维持改名避让 | **单测已验** | ✔ U：`identity.test.mjs` 前身样本（`reclaimed=true`）+ 保守样本（未知/存活/他机一律 `renamed=true`）+ pid=0 不回收 |
| A13 | 启动即清扫自己的死前身（心跳 + 状态），**不碰他人血统、不删消息** | **已实测** | ✔ E：2026-09-15 15:02 重启，trace `reap-lineage reaped:15 … kept:4` 与 `reaped:2 … kept:3`；`nodes/` **19 → 4**（保住的正是 `wb-0`/`demo-worker`/`sim-node-a`/自己）、`state/` → 2、名册 **19 → 2**（全部在线）；本节点身份回收为 `web-0`（不再带 pid 后缀） |
| A14 | 投递侧会话枚举**不依赖已被上游移除的 `Session.events`**（改读 `snapshotEvents()`），且保留「非数组归空」防抛 | **已实测** | ✔ 源码 + 构建判据（2026-09-22 复核）：`src/index.ts` 的 `sessionLite()` 现调 `s.snapshotEvents()` 且外层保留 try/catch 归一；构建产物同步——`lib/index.js`（2026-09-20 11:49）含 `snapshotEvents`；运行中节点 `LAPTOP-BF4IAPLM-web-0` 心跳在案（2026-09-22 12:36，总线 `nodes/` 现算）。**范围标注**：本判据只证「不因属性移除而失效/不退化到全空历史」，**不等于端到端投递复验**（那一项见 U12） |

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
| B8 | 跨机消息**真的过网络**（不是文件旁路），且拒绝面有对照 | §5.9 | **已实测**（2026-09-22） | ✔ `tests/transport.test.mjs` 起**真 `node:http` 监听**（`port: 0` 取真实端口），`pushToPeer` 推 → 对端 `onInbound` 收到正文与来源 id（**对照组**）；同测内三组拒绝各就其位：错密钥 `401` · 非成员 `403` · 未开入站 `503`，且**被拒正文未进投递**（`received.length` 未增） |
| B9 | **默认关闭时行为与加网络前相同** | §5.9 规则 1 | **已实测**（2026-09-22） | ✔ `listenPort: 0` 不启动监听（`cluster_members` 报 `listening:false`）；出站策略在**网络之前**拦截不合规地址——spy 断言 `fetch` 调用数 **= 0**（`plaintext-http-to-non-loopback` / `no-secret` 两条路径各验一次） |

> **C 表（v0.4，宿主兼容 · §5.10）**——回答「**装到别人家能不能跑**」的可证伪判据：

| # | 命题 | 对应 | 状态 | 证据 |
|---|---|---|---|---|
| C1 | 三种**形状**都被正确读取：只有 `snapshotEvents`（已知世代的真实形状）/ 只有 `events` 属性（**未知或更旧宿主**的兜底形状）/ 两者皆无 ⇒ 各走对路径，**且都不抛** | §5.10 规则 1/3 | **单测已验** | ✔ U：`tests/host-compat.test.mjs`——形状样本互为对照组、两条都在时方法优先、抛错 / 非数组 / 抛错 getter / `null` / 原始值全部安全退化；`npm test` **113/113 exit=0**（2026-09-22 复跑）。⚠ **样本是「形状样本」不是「版本样本」**：原先把 property-only 那条标成「0.1.2-rc.1 的真实形状」是**错的**（见 §5.10 的 2026-09-22 更正） |
| C2 | `cluster_status` **现算**（不读缓存）并显示宿主兼容面：判定 / 读取路径 / 版本或「未取得」/ 声明支持区间 | §5.10 可见面 | **已实测**（2026-09-22） | ✔ E：重启后实调 `cluster_status` → `宿主 supported · 会话读取 snapshotEvents · 版本 未取得（走 snapshotEvents()（上游已标 deprecated）…；宿主版本未取得（无已实证的版本源）——判定不依赖它）` |
| C3 | 版本号取不到时**判定不受影响**，且**绝不**采信 `npm_package_version`（那是本插件自己的版本） | §5.10 边界诚实 | **单测已验** | ✔ U：`readVersion({npm_package_version:'0.2.0'})` → `{version:'', source:'unknown'}`（采信它 = 报出一个**自信的错数**）；同测断言此时 `verdict` 仍为 `supported` 且理由里带「未取得」 |
| C4 | 判定为 `degraded` 时**响**（落轨迹 + 日志），且 `no-sessions-yet` **不**告警（告警疲劳会让真降级没人看） | §5.10 ⚠ 响亮 | **部分已验** | ✔ U：判定层区分「全盲 ⇒ degraded」与「无样本 ⇒ degraded 但理由是时机」；⚠ **轨迹去重（`hostCompatTraced` 只落一次）与线上降级样本尚未取得**——当前宿主是 `supported`，无降级可观测 |

> **D 表（v0.5，入网凭证 · §5.11）**——回答「**陌生人拿一张令牌就能进来吗，而且只进到他该在的地方**」：

| # | 命题 | 对应 | 状态 | 证据 |
|---|---|---|---|---|
| D1 | 令牌端到端可用：签发 → 对方解析 → 推入网请求 → 主脑准入 → **双方互相入册**，且两边记的是**同一把专属密钥**（≠ 网络共享密钥） | §5.11 | **已实测**（2026-09-22） | ✔ `node scripts/join-demo.mjs` → **23/23 exit=0**（真 `node:http` 监听 + 真 `createJoinHandler`，与线上同一份代码，不是第二实现）；对照组含「签发即准入」「两边密钥一致且 ≠ 网络共享密钥」「令牌描述不回显密钥」 |
| D2 | 六类拒绝各就其位且**理由可诊断**：重放 `replay` / 篡改（指纹或载荷）/ 过期 `expired`（理由带到期 ISO 时刻）/ 串网 `not-my-network` / 冒名 `member-mismatch` / 入网方本地拦 `wrong-member` | §5.11 | **已实测**（2026-09-22） | ✔ 同 demo，原文取证：`{"ok":false,"reason":"expired","detail":"令牌已过期（到期 2026-09-21T07:53:53.091Z）"}` · `{"reason":"member-mismatch","detail":"令牌准入 guest-2，但请求者自报 冒名者"}` · `{"reason":"replay","detail":"该令牌已被使用过（nonce dc5f916cc598a95b）"}` · 本地拒：`令牌不可用（wrong-member）：这张令牌准入的是 someone-else，不是本节点 guest-1` |
| D3 | 拒绝**不留副作用**：不写成员文件、不消耗 nonce；密钥不出现在任何可打印描述里 | §5.11 边界诚实 | **已实测**（2026-09-22） | ✔ 同 demo：`拒绝路径不留成员文件` ✔ · `被拒令牌后已用 nonce 仍为 1` ✔ · `inviteLine` 中不含密钥 ✔ |
| D4 | 在本机真实宿主里 `cluster_invite` / `cluster_join` 两个工具可用（schema 真能被加载并执行），且**默认关闭时拒绝得响亮** | §5.11 工具面 | **已实测**（2026-09-22） | ✔ E：重启（14:57:32）后实调——`cluster_invite` 未配 `listenPort` ⇒ 拒绝并说明「本节点没有入站端点（未配置 listenPort 且未给 url）——对方无处投递入网请求，签不出可用令牌」（**这正是 §5.9 规则 1「默认关闭」应有的样子：响亮，而非静默失败**）；`cluster_join` 喂畸形令牌 ⇒ `令牌不可用（bad-payload）：载荷不是合法 base64url+JSON（多为复制不全）`。**两次调用均无副作用**（未写成员册） |
| D5 | **开放令牌**（`member: '*'`）可用：陌生实例自报身份即可入网；未自报则拒（`missing-claimant`，**不凭空造身份**）；且网络/期限/重放三条约束**照旧生效** | §5.11 | **已实测**（2026-09-22） | ✔ demo 第 [4] 组：`陌生实例凭开放令牌入网（身份自报）` ✔ · `册子里写的是自报身份` ✔ · `没自报身份 → 400 missing-claimant` ✔ · 单测另断言开放令牌**仍**受 `not-my-network` / `expired` / `replay` 约束，且**绑定令牌**的行为不因它而松动（互为对照） |

| C5 | 插件能**挂载并运行**在上游 `0.1.2-rc.1` 宿主里（启动 + 文件总线机制可用），但**会话事件读取路径的读数尚未取得** | §5.10 / U13 | **部分已实测**（2026-09-22） | ✔ 证据取自**共享总线轨迹**（跨节点可见，**不必驱动对方的 agent**）：`cluster-trace.jsonl` 里 `{"node":"LAPTOP-BF4IAPLM-tavern-3080","phase":"startup","busRoot":"C:\\Users\\tr\\.dsh-cluster","dirsOk":true}` 与 `{"phase":"startup-poll","scanned":0}`；配套结构证据（勘察分身逐条落盘）：`profiles/tavern/package.json` 的 `dependencies` 含 `"dsh-agent-cluster": "link:E:/alice/self-plugins/dsh-agent-cluster"`、`node_modules/dsh-agent-cluster` 是**真 link**、`cordis.patch.yml` 有 `insert` 行（id `agent-cluster`）、且 `dshTavern.managedBundles` **未**被污染（仍 6 项）。⚠ **未测到** `host-compat` 行——那次运行期间**没有会话**，而 `noteCompat` 按设计**不落** `no-sessions-yet`（防告警疲劳）⇒ **该宿主上没有运行期读数**；`SUPPORTED_HOSTS` 该条据此标为 **`静态`**。**2026-09-22 晚升为 `进程外运行期`**（不是 `实测`）：在进程外**执行**该宿主所带的真实产物——导入 `dsh-session@0.1.2-rc.1` 并枚举 `Session.prototype`（探针 `_tmp_review/probe-tavern-session-api.mjs`）⇒ `snapshotEvents` / `ownEvents` / `eventAt` / `seq` / `surface` **齐全**、**无**公开 `events` 属性 ⇒ 与 0.1.6 世代的会话读取面**运行期同形**（比「读源码」强，因为跑的是它实际装载的那份构建）。⚠ **`实测` 档仍未达**：该读数不在酒馆进程内，拿不到它自己算出的 verdict；进程内 `host-compat` 行的门槛依旧未过（见 U13）。**同时更正一条被写进 objective 的预期**：先前「预期会话读取 = `events-property`」源自那个未核实的假设，已被本读数**证伪**——真值是 `snapshotEvents` |**同日后续**：酒馆已被**起起来**并**修正身份**——旧心跳是 `-3080`，根因是酒馆启动器用 `{...process.env}` 透传了主 web 的 `DSH_WEB_URL=http://127.0.0.1:3080`，而插件的端口优先级里 **env 先于 argv**（`--port 3081` 其实传了，被抢）；修法 = 在 `cordis.patch.yml` 里**显式写 `port: 3081`**（配置层修，不动插件代码）⇒ 实测新心跳 `LAPTOP-BF4IAPLM-tavern-3081`（pid 31272、`baseUrl http://127.0.0.1:3081`），且**插件自己的血统清扫把旧的 `-3080` 心跳收掉了**（轨迹 `reap-lineage reaped:1 ids:["LAPTOP-BF4IAPLM-tavern-3080"]`）。⚠ 但**运行期 `host-compat` 读数仍缺**：它只在**有会话样本**时落，而酒馆当前无会话（`startup-poll scanned:0`）——造会话需 API Key + 导入人物卡，属**使用者自己的设置**（见 U13） |

> **E 表（v0.6，投递语义分类 · §5.12）**——回答「**无会话节点还会不会被判死，故障会不会被伪装成特性**」：

| # | 命题 | 对应 | 状态 | 证据 |
|---|---|---|---|---|
| E1 | `no-target` 归 `structural`、`sessions-unavailable` 归 `retryable`，且**两者必须分属不同类别**（语义不变量） | §5.12 | **单测已验** | ✔ U：`tests/miss.test.mjs` 7 条全绿。**三组尸体样本各就其位**（§5.9 规则 2）：① 把 `no-target` 改回 `retryable`（= 恢复断点行为）⇒ 5 pass / **2 fail**；② 把 `sessions-unavailable` 改成 `structural`（混淆「没问到」与「没有」）⇒ 5 pass / **2 fail**；③ 缺 `holdNoted` 字段判 `recovered` ⇒ 6 pass / **1 fail**。三组还原后全量 **157/157** exit=0 |
| E2 | 结构性不可注入时**不消耗重试**；落痕**只做一次**；滚动上限生效 | §5.12 | **单测已验** | ✔ U：`tests/hold-noted.test.mjs` 7 条（`HOLD_NOTED_CAP` 裁剪保留最新、重复标记不产生重复项、`markHandled` 清除保持态、坏值归一化） |
| E3 | 旧状态文件（无 `holdNoted`）⇒ 空数组且 `recovered=false`，**重试账完整保留** | §5.12 向后兼容 | **单测已验** | ✔ U：喂**老状态文件的真实形状**（v1 + `handled`/`attempts`/`counters`，无 `holdNoted`）⇒ `recovered=false` 且 `attempts['m-9'].n === 3` 保真。**尸体样本**：改判 `recovered` ⇒ 该条红 |
| E4 | 线上：无会话节点收到消息后落 `hold-no-session`（而非 `no-target` 重试链），消息**留在 inbox 不被移入 `dead/`** | §5.12 | **已实测**（2026-09-26 21:44） | ✔ E：由 `dsh-agent-nodeforge` 造出的 `LAPTOP-BF4IAPLM-node-b-3091`（`autoInject=true` + **零用户会话**）收到 `m-muify6kr-117fc910` ⇒ trace 里**恰好 1 条** `{"phase":"hold-no-session", …, "why":"共 0 个会话，但无顶层（用户）会话——不投递"}`；`mailbox/<该节点>/` 里消息**仍在**、`done/` 与 `dead/` **均空**；state 为 `holdNoted=["m-muify6kr-117fc910"]` · `attempts={}` · `counters.failed=0` · `dead=0`。**对照原现场**：修复前 `tavern-3081` 是 5 条 `no-target` + `exhausted(20)` ⇒ 进 `dead/`（消息对适配器不可见）。**范围标注**：本次验的是 `autoInject=true` 那条路；`autoInject=false` 走**更早的** `held` 分支——同批 `node-a` 上另行实测过，消息同样留在 inbox |
| E5 | **端到端真任务全链路**跑通：无会话节点收到 `task` → 自行拆解执行 → 回结果 → 台账推进到 `done` 含 `verdict` | §5.12 / P0 要求 3 | **已实测**（2026-09-26 22:29） | ✔ E：起 `scripts/ref-node.mjs`（`LAPTOP-BF4IAPLM-ref-0` · `harness=ref-node`（**不基于 DSH**）· `sessionIds=[]`）⇒ `ledger.mjs new → dispatch → collect → verdict` 四段全绿：台账 `t-muihjnuu-jf66gk` 走 `drafted → dispatched → returned → done`（`verdict.pass=true` · 方法「复现证据」）；`logs/actions/a-muihjut6-vejj4qfl.jsonl` **7 行** = `start` + 5×`stage` + `done`（每行含 `atMs/actionId/node/actor/step/total/humanText`）；结果**四字段齐备**（`status=ok` / `summary="完成 5 步，产出 5 条证据"` / `evidence`×5 / `unverified=[]`）。**证据双向复现**（对照 B3 纪律）：第 2 步 `fs.write` 报的 `sha256=d55f529a9604898ce86868a1b48077186534f767ab08a9a7daa5bd8e9901530d` 与第 4 步 `fs.digest` 的读数**逐字符一致**，且 `bytes=136` 与主脑侧实测产物 `artifacts/e2e-proof.txt`（136 字节）吻合。**范围标注**：本条证「链路通」；任务内容是**自证性**的 5 步文件操作，**不等于**生产负载（见 §10 U17） |

## 8. 与实现的关系

- 主实现：`self-plugins/dsh-agent-cluster/src/`（host-only，无 client 面）+ `scripts/ref-node.mjs`（参考适配器，独立进程，非插件代码）。
- **投递语义分类**（§5.12）：`src/miss.ts`（纯模块：`classifyMiss` / `describeMiss`，只做分类不做 IO）+ `src/state.ts` 的 `holdNoted` 簿记。分类结果的**消费点只有一个**：`index.ts` 的 `deliverOne()`；三种 `retryable` 分支统一走 `retryLater` 出口——避免「同一语义在多处各写一份」（本插件已有的教训）。
- 语义主副本：本文件。`README.md` 面向使用者（安装/配置/用法），不复制语义。
- 依赖：`ctx.tools`（工具面）、`ctx.agents`（投递）、`ctx.session`（用户会话枚举）。无对其他自研插件的 import（规则：不跨插件内部 import）。
- 与 `dsh-agent-sentinel` 的关系：**同源规则、独立实现**——哨兵的 `wake-target.ts` 是「唤醒目标裁决」主副本，本插件的 `target.ts` 是「收件投递目标裁决」主副本；两者规则一致但不是同一份代码（跨插件 import 违规），差异需在各自「实践修订记录」里对齐。
- 与 `alice-workbench` 的关系：工作台**只读**总线（`nodes/` / `mailbox/` / `cluster-trace.jsonl` / `tasks/` / `logs/actions/`），单一写面是 `mailbox/<node>/*.json`（`from: "owner"`）。任务视图的数据源 = `tasks/`。

## 9. 实践修订记录

| 日期 | 类型 | 内容 |
|---|---|---|
| 2026-09-14 | 立项 | 主人指令；取证确认跨实例投递官方路径（`/api/session/prompt` + browser-auth cookie）与进程内路径（`agent.steer`），v0.1 选**纯文件总线**（无端口、无凭据、跨 DSH_HOME 可用） |
| 2026-09-14 | **事故** | **插件杀死了宿主 web 进程**：会话尚未装载时 `Session.events === undefined`，`target.ts` 的 `lastRealUserPromptAt` 直读 `.length` → `TypeError` 从 `setInterval` 回调**逃逸**（插件与宿主**同进程**，异常无框架兜底）。指纹：时间线精确到 1 秒（消息到达 10:52:50.2 → 进程消失 10:52:51.1），且**侧车轨迹里没有该消息的任何记录** ⇒ **崩在第一次落盘之前**——所以「没有日志」≠「没被触发」。**修复三层**：① `guarded()` 包住心跳/轮询全部回调 ② `safeDeliver()` 包单条投递 ③ 代理访问各自 try/catch；并加 **4 条源码级守卫契约测试**（`guard-contract.test.mjs`）锁死「新回调不得绕过兜底」。真凶是靠轨迹里一条 `deliver-error` 定案的 |
| 2026-09-22 | **新增能力面** | **跨机承载 + 成员册**（主人「琢磨智能体网络」+「dsh-tavern 可作为第二个成员」）：新增 `src/transport.ts`（签名/成员/URL 策略，纯函数）· `src/http-node.ts`（自开端点 + 推送到成员）· `docs/members.md`（成员模型/身份与信任/网络层设计）· 工具 `cluster_members` / `cluster_peer` · 配置 `listenPort`/`allowInbound`/`secret`（全部安全默认）。**触发的是对 §6 的修订**（原文「不发起任何网络请求、不监听端口」在显式配置后不再成立）⇒ 已就地回修该行并写清「默认仍成立」 |
| 2026-09-22 | **修正（脆性判据 → 结构判据）** | `guard-contract.test.mjs` 的守卫契约 3 原以**写死的 700 字符窗口**定位 `sessionLite`。上游给它补 DSH 0.1.6 适配注释后函数体变长，`catch` 被挤出窗口 ⇒ **源码正确却报红（假红）**。改为**花括号配平的块提取**（`blockOf`）。教训：**窗口大小与注释长度耦合 = 脆性判据**；结构判据（块边界）不随内容长度漂移 |
| 2026-09-22 | **验收（合流）** | 并行实例留下的未提交改动（`s.events` → `s.snapshotEvents()` 的 DSH 0.1.6 适配，19 增 7 删）由本实例**独立验收**：`snapshotEvents` 已在本仓 `packages/api/session-controller`·`packages/compaction/compaction`·`packages/context/time-context`·`packages/core/agent-loop` 四处实证存在；配合上述结构判据修复后全绿（73/73） |
| 2026-09-14 | 修复 | **收件箱接管（`takeOverInbox`）**：节点重启后 `nodeId` 带 pid 会改名，旧身份的收件箱必须被接管，否则「改名即丢消息」 |
| 2026-09-14 | 对齐 | **触发者绑定**（主人口头规则「谁触发，提醒就发到谁」）：同源规则落在 `dsh-agent-plugin-manager`（改用 `exec.agent` 调用者会话）与 `dsh-agent-sentinel`（`wakeTarget` 加 `trustAnchor`）。本插件 `target.ts` 与哨兵 `wake-target.ts` 是同源规则的两个独立实现，本次未改动本插件，记录以备下次对齐 |
| 2026-09-14 | **设计修订（v0.2）** | 写 P2 任务协议时发现 spec §3.2 的台账 schema **未指定写者**，而执行节点若直写台账会违反 I5（多写者竞争：主脑写 `verdict`、节点写 `status`/`result`，读-改-写窗口重叠）。**修正为 I8：台账单写者 = 主脑**；执行节点只回 `event`/`result` 消息。代价：台账状态滞后 ≤ 一个主脑处理周期（可接受——台账是验收账本，不是实时进度板；实时进度由 `logs/actions/` 承担）。新增 I9（判据先行）/I10（必落行为事件）/I11（路径白名单）三条不变量 |
| 2026-09-14 | 补充（v0.2） | **参考适配器升格为协议产物**：`scripts/ref-node.mjs` 从「联调工具」定位为「协议的活证明 + 接入模板」。原 `scripts/sim-node.mjs`（被动模拟器）保留为**测试夹具**，两者职责分离（夹具轻量无副作用；适配器要健壮、要写文档、要被第三方照抄） |
| 2026-09-15 | **设计修订（v0.3）** | **身份回收 + 血统清扫**：起因是工作台星图上「**两颗都叫 web-0 的节点**」（一颗在线、一颗离线）——追下去发现 `nodes/` 已攒 **17 个死心跳**、`mailbox/` 23 个目录、名册 19 个节点里只有 2 个活的。**根因**：I1 的冲突裁决只看「心跳新鲜度」，**看不到心跳里那个 pid 还活着没有**；web 重启时上一版心跳仍新鲜 ⇒ 每次都被迫改名避让（`web-0` → `web-0-<pid>`），并留下一份前身心跳。**修法**：① 裁决加一层**前身判定**（同主机 + pid 确认已死 ⇒ 回收原名）② 启动时清扫自己的死血统（新增 **I12**）③ 判活事实由 IO 层查得后**显式传入**纯逻辑，**未知一律按「活着」处理**。**边界实测**：只清 `<host>-<profile>` 前缀内的血统——`demo-worker`/`sim-node-a`/`wb-0` 一个没动（`kept` 名单在案） |
| 2026-09-15 | 闭环 | **U10（陈旧节点清理）落地**：判据从「年龄/保留期」改成「**血统 + 判活**」——因此不需要保留期参数，也不会误删他人的节点。**U6（节点 id 退化）随之缓解**：身份稳定回 `web-0`，收件箱不再每次重启漂移（`takeOverInbox` 保留为改名路径的兜底）。**同时订正一条认知**：这不是「显示层该去重」的问题——工作台画的是总线真身，**数据不真，界面不可能真**；修在源头，界面自动变干净（实测星图 5 星 → 2 星，无需改前端一行） |
| 2026-09-19 | **上游适配**（本条 2026-09-22 复核补记） | DSH 0.1.6 **移除 `Session.events` 公共属性** ⇒ 投递侧会话枚举（`sessionLite()`）改读 `s.snapshotEvents()`，并把「非数组归空」的归一搬进 try/catch（会话未装载仍不抛——2026-09-14 宿主被杀事故的防线不得因适配而丢）。⚠ 两点如实记录：① 该改动**至今仍在工作区未提交**（`git status: M src/index.ts`），但**已构建进 `lib/index.js`（2026-09-20 11:49）并随重启生效**（判据：产物内含 `snapshotEvents` + 运行中节点心跳在案）；② 上游同时把 `snapshotEvents()` 标为 **deprecated（新调用被禁）** ⇒ 本次是恢复功能的**临时适配**，长久方向是投影/显式观察（见 U12） |
| 2026-09-22 | **复核回写（D3 驱动）** | `semantic_check` D3 报「实现比文档新」（impl `src/index.ts` 2026-09-19 > doc 2026-09-15）。复核结论 = **真过时**：上一条适配落在本插件自己的语义范围（投递侧会话枚举），而文档里**没有痕迹**。回写：① §5.2 补「会话历史的读取路径」注（含 deprecated 警示）；② §7 新增 **A14**；③ §10 新增 **U12**。**副产物（值得记住）**：本条的 D3 触发者不是已提交历史，而是**未提交的工作区改动**（文件 mtime 会进 impl 比对）⇒ D3 也会对「在建改动」报警，复核时必须人工分辨「已落地 / 在建」——本次两手都记（产物已生效、源码待提交） |
| 2026-09-22 | **提交（清 U12 ①）** | 跨版本读事件改动落库：`10eec5a`（`snapshotEvents()` 优先，回退 `events` 属性，8 增 5 删）。此前它「**已构建生效但未提交**」——而未提交意味着回滚/checkout 会丢掉它，后果是**静默退化**。判据：`npm run build` exit=0 + `npm test` **73/73** exit=0（提交时读数） |
| 2026-09-22 | **新增能力面（v0.4 · 宿主兼容）** | **能力探测优先于版本号**。触发来自主人的交付物定义：「**安装了这个插件的智能体，都可以接入到这个智能体网络当中**」⇒ 插件必须能装进**别人的 DSH**，版本由对方决定（上游 `dsh-tavern` 锁 `0.1.2-rc.1`，比我本机旧）。新增 `src/host-compat.ts`（`pickCallable` / `readSessionEvents` / `probeServices` / `probeHostCompat` / `describeCompat` / `SUPPORTED_HOSTS`，纯模块）· `sessionLite()` 改用它（**探测单源**——不再各处手写 `typeof` 判断，两份必然漂移）· `cluster_status` 增 `host` 段与 `hostLine` · 轨迹 `host-compat` / `host-degraded`（同描述只落一次）。**核心认知**：`inject` 只保证「**服务在**」，保证不了「**服务上的 API 还在**」——服务存在性交给激活门，API 形状交给探测 |
| 2026-09-22 | **修正（两条坑，都值得记住）** | ① **值 schema 的嵌套对象必须显式声明 `additionalProperties`**：给 `cluster_status` 加 `host` 对象后 tsc 报 `Property 'additionalProperties' is missing in type ... but required in type 'ObjectValueSchemaSpec'`（顶层写了、嵌套没写 ⇒ 报在嵌套那一层）。② **一条仪器错**：我先用 `node --test tests/`，Node 24 把 `tests/` 当**模块**加载 → `Cannot find module ...\tests` + `fail 1`，**看起来像代码坏了**；真入口是 `npm test` → `node --test "tests/*.test.mjs"`（换真入口后 73/73 全绿）。教训：**读数必须连同「用的哪条命令」一起报**——「73/73」只有配上入口才是可复现的证据 |
| 2026-09-22 | **新增能力面（v0.5 · 入网凭证）** | **令牌 = 一次入网的完整凭据**（主人把交付物定义为「装了这个插件的智能体都能接入网络」⇒ 入网必须对方**一步**做完，且**不必知道我的 `busDir`**）。新增 `src/invite.ts`（mint / parse / decide / describe / redact，纯模块 **never throws**）· `src/join.ts`（`createJoinHandler` → handleJoin 主脑裁决 / mintInviteFor **签发即准入** / joinNetwork 入网方）· 端点 `POST /cluster/join`（**唯一未认证入口**——令牌自己就是凭证）· 工具 `cluster_invite` / `cluster_join` · `config.network` · `MemberRecord.secret`（成员**专属**密钥，缺席回退共享密钥；`decideInbound` 与 `cluster_peer` 真的用它，否则令牌里的密钥只是装饰）。四条设计判断见 §5.11 |
| 2026-09-22 | **部分验收（U13 推进 · 真旧宿主）** | 插件已装进上游 `dsh-tavern` 的 `profiles/tavern`（dependencies link + node_modules 真 link + `cordis.patch.yml` insert 行，且**未**污染 `dshTavern.managedBundles`），并**真的在该 0.1.2-rc.1 宿主里跑起来过**——证据是共享总线轨迹里的 `startup`（`busRoot` 正确、`dirsOk:true`）与 `startup-poll scanned:0`，加上心跳 `nodes/LAPTOP-BF4IAPLM-tavern-3080.json`（`profile:'tavern'`）。⇒ **「可安装」的挂载+运行半程由此取证成立**。⚠ **未证**：会话事件读取路径（`events` 属性 vs `snapshotEvents()`）——那次运行期间没有会话，`noteCompat` 按设计不落 `no-sessions-yet`，所以 `host-compat` 行根本没产生 ⇒ `SUPPORTED_HOSTS` 的 `0.1.2-rc.1` **保持 `推断`**，不许因这次取证就升为 `实测`。**两条副产物值得记**：① 交付「装着就能跑的插件」时，**跨节点共享的侧车轨迹**是最便宜的验收通道（不必驱动对方的 agent、不必进它的会话）；② 但也正因如此，**「没落轨迹」既可能是「没发生」也可能是「判据刻意不落」**——本次必须读代码才分辨得出（§5.9 规则 6「读数自带范围标注」的同族）。 |
| 2026-09-22 | **更正（假设被写成了读数 · 跨四个载体）** | 本插件原先多处断言「上游 `0.1.2-rc.1` **没有** `snapshotEvents()`、只有 `events` 属性」——**这是错的**。它源自上一轮会话里一个**未核实**的形状假设，而我把它写进了 `src/host-compat.ts` 头注与 `SUPPORTED_HOSTS`、`src/index.ts` 注释、本节 §5.10 与 C1、以及一个刚炼化的技能文档 ⇒ **四个载体互相「印证」，比单一错误更难被怀疑**。静态取证（读该宿主自己的 `dsh-session/lib/index.js` 与它自己的类声明）显示：**两个世代的会话读取面同形**（都有 `snapshotEvents()` / `ownEvents()` / `eventAt()` / `seq`，都**无**公开 `events` 属性）。**修法**：① 四处同改，并在原处留痕（不改史）；② `SUPPORTED_HOSTS.tested` 由两档扩为**三档**（`实测` / `静态` / `推断`）——「我读过对方代码」既不是实测也不是瞎猜，**档位不够会逼人撒谎**；③ 测试文件里把「形状样本」与「版本样本」分清（样本锁的是**分支正确性**，与版本无关）；④ 诚实性断言随之升级（原来只检查 `推断` 条目，如今三档各有要求）。**教训**：**未核实的假设一旦写进正本，就会被后来的人（包括我自己）当成读数**——这条与 §5.9 规则 6（读数自带域标注）同族，但更狠：它不需要任何人主动撒谎，只需要一个人**忘了标「推断」**。 |
| 2026-09-22 | **互操作修复（端口身份）+ U13 阻塞定位** | 把酒馆**起起来**后实测到的根因链：① 酒馆启动器 `launcher-environment.mjs` 用 `{...process.env, …}` 透传环境、**未清洗 `DSH_WEB_URL`** ⇒ 主 web 的 `http://127.0.0.1:3080` 进了酒馆进程；② 本宿主（0.1.2-rc.1）`ctx.get('webServer')` 取不到 port ⇒ `livePort=0`；③ 我们没配 `port` ⇒ `config.port=0`；④ 插件端口优先级 **env 先于 argv** ⇒ 回退取到 3080（真值 `--port 3081` 在 argv 里、**被抢**）；⑤ `deriveNodeId` ⇒ `…-tavern-3080`。**影响仅限身份展示**（`listenPort=0` 未开监听、无端口冲突、无互投）。**修法** = `cordis.patch.yml` 显式写 `port: 3081`（配置层，不动插件代码）。**实测**：新心跳 `LAPTOP-BF4IAPLM-tavern-3081`（pid 31272 / `baseUrl 3081` / 持续续心跳）、`3081` 监听 owner = 31272；旧 `-3080` 心跳被插件**自己的血统清扫**自动收掉（`reap-lineage reaped:1`）。**U13 阻塞定位**：`host-compat` 需要会话样本，而酒馆**无会话**（`startup-poll scanned:0`）；造会话需 API Key + 人物卡 = **使用者设置**（凭据不擅自动）。**教训**：跨宿主互操作里，「**对方的启动器怎么组装环境**」与「**你的取值优先级**」会合谋出一个静默错误——**错的身份不报错，只会让名册显示一个不存在的节点**（§5.9 规则 6 的又一例）。 |
| 2026-09-22 | **可跑证据抓到的真缺陷（值得记）** | 加「开放令牌」时，demo 第 [4] 组**第一拍就崩**：`member: '*'` 被当成成员 id 去写册子，而 **`*` 在 Windows 上不是合法文件名** ⇒ 写失败 ⇒ 签发抛错，症状却看起来像「令牌生成失败」。**真因是设计错位**：开放令牌在签发时**根本没有具体成员可入册**（身份是入网时才自报的）——准入应当发生在 join 那一刻。修法：绑定令牌才「签发即准入」，开放令牌只登记令牌本身；并补一条判据「开放令牌**不**在签发时造成员」。教训：**可跑证据的价值不在于确认已知的能跑，而在于让「还没想清楚的边界」当场暴露**——这条如果只写单测（纯函数、不碰文件系统）根本抓不到 |
| 2026-09-22 | **重构（为可测性 · 同日本能反思）** | 入网裁决原**内联在 `apply` 闭包**里 ⇒ 只能靠假 ctx 测，而它恰是**唯一一条未认证入口**、最需要可跑证据。抽成 `src/join.ts` 后，`scripts/join-demo.mjs` 能用**真 `node:http` + 真裁决函数**（与线上同一份代码，不是第二实现）驱动全流程 ⇒ **18/18 exit=0**。顺带修 `PostJsonResult`：失败分支也要带 `body`——服务端的错误正文才是诊断，原来只把它拼进 `reason` 标签，于是「服务端说明了原因，调用方只看到一个状态码」 |
| 2026-09-22 | **证据阶梯扩为四档 + U13 的证据强一档（档次不变）** | 目标轮的 ② 要求「读到 `cluster_status` 的 host 段」。复核后**该宿主进程内读数仍取不到**，但取到了一种**更强的、此前无处安放**的证据：在进程外**执行**酒馆所带的真实产物（导入 `dsh-session@0.1.2-rc.1`，枚举 `Session.prototype`）⇒ `snapshotEvents` / `ownEvents` / `eventAt` / `seq` / `surface` 齐全、**无**公开 `events` 属性，与 0.1.6 世代**运行期同形**。**关键判断：不给它新开一档就会逼人撒谎**——塞进 `实测` 是 overclaim（读数不在其进程内，拿不到它自己算出的 verdict），塞进 `静态` 是 underclaim（我跑的是它装载的那份构建，不是源码文本）⇒ `SUPPORTED_HOSTS.tested` 由三档扩为**四档**（增 `进程外运行期`）。诚实性测试随之重写：档位契约抽成 `tierViolations()` 并配 **5 条合成坏样本对照**（否则「当前没有 `静态` 条目」会让那段断言恒空转——**恒为空不是证据**）。**同时证伪一条被写进 objective 的预期**：「预期会话读取 = `events-property`」源自同一批未核实假设，真值是 `snapshotEvents`。**教训**：档位表是**抗撒谎装置**，不是分类学——每多一种可获得的证据强度就该多一档，**短缺的档位会自己长出谎言**。 |
| 2026-09-22 | **U13 阻塞复核（性质：不在插件，在使用者设置）** | 重新取证该实例现状：`profile-data/tavern/data/chats` **为空**、无 `sessions` 根 ⇒ **从未有过会话**；`.credentials.yaml` 仅 **161 B / 7 行 / 0 个 provider 键** ⇒ **无法建会话**（与 `startup-poll scanned:0` 互相印证）；酒馆 UI 侧 `dsh web authentication required`。⇒ 三重证据同向：清 U13 **只差主人一次「配 Key + 导卡 + 开一局」**。**在清掉之前档次停在 `进程外运行期`——证据变强不等于档次该升。** |
| 2026-09-26 | **修复（语义错误 · 真实断点）+ 新增能力面（v0.6）** | **投递未成功的语义分类**（主人「加快建设进度」驱动；取证路径见下）。**断点实测**：`tavern-3081` 收到 `m-mudkvx0a-3751887f` 后连续 5 条 `{"phase":"no-target","why":"共 0 个会话，但无顶层（用户）会话——不投递"}`，最终 `{"phase":"exhausted","attempts":20}` ⇒ 消息进 `dead/`。**根因是语义错误、不是性能问题**：`no-target`（本节点**结构性**无可注入的顶层会话）与 `no-agent`/`inject-error`（**可恢复**）被同一套 `noteFailure` 处理 ⇒ 重试 20 次把消息**判死**；而 headless 适配器直接读 mailbox，**判死即读不到**——本该能工作的执行节点被插件判死而结构性收不到活。**修法**：新增 `src/miss.ts`（`classifyMiss` / `describeMiss`，纯模块 + 7 条判据）· `deliverOne` 的 `no-target` 分支改走 `structural`（保留原位、不消耗重试、落一次 `hold-no-session`）· `state.ts` 新增独立簿记 `holdNoted`（只防刷屏，滚动上限 200，**不参与投递归宿**）· 三种 `retryable` 分支统一走 `retryLater` 出口 · `sessionLite()` 新增**探测失败位**（`sessionsProbeFailed`），使「没问到」与「问到但为空」在投递侧可分。**验收**：`npm test` **157/157** exit=0（入口 `node --test tests/*.test.mjs`）+ 三组尸体样本（读数见 §7 E 表）。**同时证伪我先前的猜测**：心跳写入**本来就是原子的**（`bus.ts:85` 的 `atomicWriteJson` = 同目录临时文件 + `renameSync`）⇒ `tavern-3081` 那个「327 字节全 NUL」的心跳**不是**写非原子，真因另记（§10 U15）。**另一条读数修正**：`cluster_status` 报的「发 0 · 收 0」是**本进程**计数（不是「12 天零通信」）——trace 实测 **15459 行 / 1.76 MB**、历史上 `delivered` 仅 **4** 条，真问题是「机制在跑但没有真实协作负载」（§10 U16）。 |
| 2026-09-26 | **D3 复核（结论：真过时，但缺口不在本次改动）** | `semantic_check` 报 D3，触发者 = 提交 **`a81b579`**「feat(leader): 主脑从静态标签到真在任——能力门 + 租约续租 + 端类型」（2026-09-23），触发文件 `src/index.ts`。**复核结论：真过时，与本次投递语义修复无关**——文档里**没有主脑租约的契约章节**（`src/leader.ts` 的 `canLead` / `decideLeader` / `grantLease` / `parseLease` / `KIND_WEIGHT` / `DEFAULT_LEASE_TTL_MS` / epoch 单调递增等均无落点；§3 只有「主脑（primary）」的**角色定义**）。⇒ 记 **U18**。**处置的诚实面**：**不**用抑制标记掩饰（⚠ 本行措辞曾误含抑制关键词，反而把 D3 压掉了——解析器是文本匹配、**不读否定**，已改）、**不**更新 `lastReviewedAt`——缺口是真的，让它继续亮；本行即 D3 的处置留痕（复核过 / 判定真过时 / 给出缺口位置与编号）。 |
| 2026-09-26 | **验收（P0 收官 · 端到端真任务闭环）** | 断点修复的**线上验收**与 P0 要求 2/3 一并完成（判据见 §7 **E5**）：起 `scripts/ref-node.mjs` 作第一个**协议无关**执行节点（`LAPTOP-BF4IAPLM-ref-0` · `harness=ref-node` 不基于 DSH · `sessionIds=[]`）⇒ `ledger.mjs` 的 `new → dispatch → collect → verdict` 四段全绿，台账 `t-muihjnuu-jf66gk` 走到 `done`（verdict pass · 复现证据），行为事件 7 行、结果四字段齐备、`write` 与 `digest` 两处 sha256 逐字符一致。**副产品**：§10 **U17 首次破局**（`tasks/` 1 → 2、`logs/actions/` 1 → 2，名册多一个 online 的协议无关节点）。**同时新增一条真实发现（已登记任务板 `t-201a4c52`）**：`scripts/ledger.mjs` 的 `collect` 过滤条件只认 `kind=result`，其余类别**既不处理也不归档**，而插件轮询只扫自己的 nodeId（`primary` 不是注册节点）⇒ `mailbox/primary/` 里 2026-09-15 的 `demo-worker` `event` 消息**滞留 11 天**——这是 inbox 泄漏（滞留 ≠ 保留，它只是没人管），处置见任务板那条。 |

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
- **U10 陈旧节点清理**（v0.2）→ **已在 v0.3 闭环**（见 §9 与 I12）：判据改为「血统 + 判活」，启动即清扫自己的死前身；实测 `nodes/` 19 → 4。**残余**：`mailbox/` 的 23 个历史目录未清（**故意**——里面有已归档消息 = 审计价值；且空目录清理需要 `bus.ts` 侧的新原语）。若将来要清，**只清完全空的目录**。**别人的死节点**（`demo-worker`/`sim-node-a`）仍按设计保留：它们不是我的血统，由各自所有者负责（或将来引入归档区）。
- **U11 宿主插件与预设边界的错配**（v0.2 实测）：`dsh-agent-cluster` 与 `dsh-agent-telegram` 都挂在**宿主组合**（web profile，`plugin_list` 实测 `挂载: web`）⇒ **所有预设**（含 `worker-base`）都会拿到它们。前者正合需要（节点自动有网络身份，无需预设挂载）；后者违反 spec §4.2「执行节点不挂 telegram」与 **P2-5「无直达主人通道」**——**预设层面无法移除宿主提供的插件**（预设只能「增加」本会话贡献的行，收不回宿主的）。候选修法：① 把 telegram 下移到主脑预设 `alice-v2`（需主会话在场 + 重启；注意 inbound 长轮询是宿主级长期连接，下移后仅主脑预设会话收信）；② 保留宿主，但在派发层用「节点不可用该工具」的**约定 + 审计**替代结构性隔离（弱保证，需明说）。**更一般的未决**：这条边界该沉淀为 harness 的组合纪律——「哪些能力属于宿主（全进程共享）、哪些属于预设（按会话收窄）」，以及**收窄型需求**（默认给、特定预设不给）在现行两平面模型下有没有一等表达。
- **U12 DSH 0.1.6 会话读取适配的三件未了（2026-09-22 复核新增）**：① **未提交 → 已清（2026-09-22，提交 `10eec5a`）**——且顺手升级为「两个 API 都试」的**跨版本读**（见 §5.10）；② **落在 deprecated API 上**——上游 `snapshotEvents()` / `eventAt()` / `ownEvents()` 已 `@deprecated … new calls are prohibited`，本次只是「既有逻辑的延续」；长久方向是改读投影或 `SessionObservation.events` + cursor（DSH 仓 note `2026-09-09-deprecate-synchronous-session-event-reads`）；③ **端到端投递复验**——A1/A2/A5 的 E2E 证据取自 2026-09-14/09-15（DSH 0.1.6 之前），适配后只做到源码/构建级判据（A14），**尚无一次新的真实投递样本**。进展：**① 已清**（`10eec5a`）；余下 ③（补一次真实投递验收，与 U13 合办）与 ②（迁移到投影，须先确认目标宿主确有投影 API——否则会把兼容性又写死回单版本）。
- **U13「装到别人家」的端到端尚未验证（2026-09-22 新增 · 现已定位到具体阻塞）**：宿主兼容层已做到**离线单测 + 本机 0.1.6 运行期实测（= `实测` 档）+ 0.1.2-rc.1 进程外运行期取证（= `进程外运行期` 档）+ 0.1.2-rc.1 挂载运行取证**（C1/C2/C5）。**剩余缺口的性质已经查清——不在插件，在使用者设置**：① `host-compat` 只在**有会话样本**时落轨迹（刻意设计，防告警疲劳），而酒馆当前**没有任何会话**（`startup-poll scanned:0`）；② 要造一个会话，酒馆要求先配置 **API Key** 并**导入人物卡**，两者都属主人的凭据/内容（**我不擅自填**）。⇒ 清 U13 需要主人做一次「配 Key + 导卡 + 开一局」，之后我读一次 `cluster-trace.jsonl` 的 `host-compat` 行即可把该条从 `进程外运行期` 升为 `实测`，并顺手跑一次真互投。**2026-09-22 晚复核（阻塞判定不变，证据强一档）**：① 该实例**根本没有会话存储**（`profile-data/tavern/data/chats` 为空、无 `sessions` 根）；② `.credentials.yaml` 仅 **161 B / 7 行 / 0 个 provider 键** ⇒ 建不了会话；③ 已用**进程外运行期**取证把该宿主的会话读取面问清（见 C5）——但那只证明「**API 在**」，**不能替代**「该宿主**进程内**的 `host-compat` 行」。⇒ 清 U13 **仍然只差主人那一步**；在那之前档次停在 `进程外运行期`，**不许**因证据变强就自称 `实测`。**在清掉之前，不许把「可安装」说成已达成**。
  - **不要误读的一点**：`noteCompat` 不落 `no-sessions-yet` 是**刻意的**（否则每台刚装上的宿主都会先报一次「降级」，告警疲劳会把真降级淹掉）。⇒ 「轨迹里没有 `host-compat` 行」**既可能是「没跑」也可能是「没会话」**——分辨要靠 `startup-poll` 的 `scanned` 字段，不能只看有无。
- **U14 入网令牌的吊销与已用记录清理（2026-09-22 新增）**：三个已知缺口，都**如实列出而不是假装没有**：① **没有吊销**——令牌一旦签发，在到期前一直有效（签发时已写成员册，但**撤回**要手工删 `members/<id>.json`，且**不会通知对方**）；② `join-used.json` 的 nonce **上限 500 条、滚动丢弃最旧** ⇒ 极旧的令牌理论上在窗口外可重放（窗口长度取决于入网频率）；③ 令牌是**持有者凭证**，这一点无法用密码学消除，只能靠「期限 + 一次性 + 单一身份绑定」把窗口收窄。倾向：先按现状跑，等出现**真实**需求再做吊销列表与清理——不为想象的需求加机制（与 U9 同一条纪律）。
- **U15 心跳零字节（2026-09-26 新增 · 真因待确证）**：`nodes/LAPTOP-BF4IAPLM-tavern-3081.json` 实读 **327 字节全为 `0x00`**（`tr -dc '\000' | wc -c` = 327/327；mtime `2026-09-26 01:08:42`），名册因此报「无时间戳 · 心跳损坏」。**已排除**「写入非原子」——`bus.ts:85` 的 `atomicWriteJson` 本就是「同目录临时文件 + `renameSync`」（模块头注即写明「读者永远看到完整文件」）⇒ 形态更像**原子性 ≠ 持久性**（`writeFileSync` 后无 `fsync`：NTFS 元数据已落盘而数据页未落）。**旁证**：`state/` 里有 `LAPTOP-BF4IAPLM-web-2238.json.tmp-32732-mue87srv-ac8ac9`（**0 字节**，2026-09-23 22:56）——原子写中途死亡的化石。**待办**：先给出**可复现判据**（而非只凭形态相似就下结论），再定修法（写入侧补 `fsync` / 读取侧标损坏并显示「上次有效 mtime」，二者取一或都做）。**读者侧现状**：已能识别（`cluster_nodes` 报「心跳损坏」），但**不自愈、不清理**，且理由信息量为零（只有「无时间戳」）。
- **U16 轨迹刷屏（2026-09-26 新增）**：`cluster-trace.jsonl` 实测 **15459 行 / 1.76 MB**，其中 `leader-auto` **7132** + `leader-renew` **7128** = **14260 行（92%）** 全是主脑租约续期（约每 2.4 分钟一条）。真问题不是磁盘，是**信噪比**——定位断点时读数被淹没。候选修法：租约续期只在**状态变化**时落痕（取得 / 让位 / 换 epoch），稳定续期改为**计数汇总**（每 N 次落一条）。**判据**：改造后单日 trace 行数下降 ≥ 一个数量级，且「主脑何时变过」仍可从轨迹重建。
- **U18 主脑租约无文档（2026-09-26 D3 复核发现）**：`src/leader.ts`（`NodeKind` / `KIND_WEIGHT` / `DEFAULT_INELIGIBLE` / `DEFAULT_LEASE_TTL_MS` / `RENEW_DIVISOR` / `LeaderLease` / `canLead` / `decideLeader` / `grantLease` / `renewIntervalMs` / `parseLease` / `describeLeader`）是 **2026-09-23 提交 `a81b579`** 引入的能力面（「主脑从静态标签到真在任——能力门 + 租约续租 + 端类型」），但本文件**没有对应契约章节**——§3 只有「主脑（primary）」的角色定义，缺租约的 TTL / epoch 单调递增 / 能力门 / 续期与让位契约。**修法**：先读 `leader.ts`（**必须读实现再写**，本插件已吃过「未核实假设长成事实」的亏），再补 §5.13 与 §7 验收判据。**为何不立刻补**：本次会话在做 P0（投递语义分类 §5.12），补租约文档是**独立工作**——混做会让两次改动互相污染（本插件 §9 已有「一份实现散在多处必然漂移」的教训）。**在补上之前 D3 保持亮着**（不抑制、不更新 `lastReviewedAt`）。
- **U17 网络无真实协作负载（2026-09-26 新增 · 判据部分达成 2026-09-26 22:29）**：**原现场**：`tasks/` 只有 **1** 条台账（2026-09-15）、`logs/actions/` 只有 **1** 个行为事件文件（2026-09-15）、`members/` 目录不存在、历史上 `delivered` 仅 **4** 条 ⇒ 本插件的**机制完备度**远高于它的**使用量**。这是「智能体网络建设」的真瓶颈（不是协议不够标准）。**2026-09-26 22:29 进展**：P0 收官时跑通一条真任务全链路（判据见 §7 **E5**）⇒ `tasks/` **1 → 2**、`logs/actions/` **1 → 2**，且第一个**协议无关**的执行节点（`ref-node`，`harness=ref-node`、不基于 DSH）进了名册并**真的接到了活**。**仍未解的部分（不许把这一条读成已闭环）**：① 那条任务的内容是**自证性**的 5 步文件操作，**不是生产负载**；② `members/` 目录仍不存在（跨机面 U4/U14 无真实使用）；③ 台账里**只有 2 条**，每天并没有真任务在流。⇒ **「有没有」只走出第一步**，真瓶颈依旧是使用量而非协议完备度。**已拆解为任务板条目**：P0 解 no-target 断点（本条目所属的 v0.6 · **已完成**）→ P1 跨实例产物传递（借鉴 A2A 的 Part/Artifact）→ P2 身份卫生三件（+ `t-201a4c52` collect 的 inbox 泄漏）→ P3 Agent Card 化。**原判据**（一条真任务走完 `dispatch → running → result → verdict` 全链路）**已由 E5 满足**。

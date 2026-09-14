# dsh-agent-cluster — 语义文档（DSH 多实例通讯底座）

## 1. 元信息

| 项 | 值 |
|---|---|
| 版本 | v0.1（语义稿） |
| 日期 | 2026-09-14 |
| 状态 | 设计稿 → 实现逼近中（验收清单逐条标注证据） |
| 实现落点 | `self-plugins/dsh-agent-cluster/src/{index,protocol,identity,bus,target,state}.ts` |
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

## 4. 概念模型与不变量

```
        ┌──────────── 共享总线目录 busDir ────────────┐
        │ nodes/<nodeId>.json        心跳与身份        │
        │ mailbox/<nodeId>/*.json    收件箱（待投递）   │
        │ mailbox/<nodeId>/done/     已投递归档        │
        │ mailbox/<nodeId>/dead/     重试耗尽/过期     │
        │ state/<nodeId>.json        本节点游标与状态   │
        │ cluster-trace.jsonl        侧车轨迹（全节点追加）│
        └──────────────────────────────────────────────┘
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

## 6. 边界与信任

- **能力边界 ≠ 沙箱**：总线是普通目录；插件不提供也**不承诺**隔离。同机任意进程可读写总线文件。
- **输入不可信**：所有从总线读入的 JSON 都按不可信数据处理——版本校验、字段类型校验、长度截断、未知键忽略；坏文件跳过 + 轨迹留痕，**绝不抛进主流程**。
- **不接触凭据**：v0.1 不读写 `.credentials.yaml`，不发起任何网络请求，不监听端口。
- **不越界清单**：不 kill/重启其他实例；不写其他节点的 `nodes/` 与 `state/`；不删他人消息（只移动自己 mailbox 内的文件）；不自动回复消息。
- **子进程/资源**：不 spawn 任何子进程。
- **失败面**：写失败（磁盘满/权限）→ 返回错误给调用方（工具面可见），不伪造成功；读失败 → 跳过该条并累计 `readErrors`。
- **权限语义**：`cluster` 消息是平级来信，注入文本必须带来源前缀（`[cluster:<from>]` / `[cluster:<from>/<kind>]`），且系统提示语义上**不获得主人指令的优先级**。

## 7. 可证伪验收清单

> **2026-09-14 状态回修**：原表 11 条全标「待…」，实际已由当日交付验证。逐条给出证据来源。
> 代号：**U** = 离线单测（`pnpm test`，**58 passed / 0 failed**）· **E** = 端到端联调（两个真实节点 + `scripts/sim-node.mjs`）· **—** = 尚未覆盖。

| # | 命题 | 状态 | 证据 |
|---|---|---|---|
| A1 | 两节点运行后，各自 `cluster_nodes` 都能看到对方且标记 online | **已验证** | E：`sim-node-a` 出现在名册且标 online |
| A2 | A `cluster_send` → B 会话收到注入消息，前缀含 `[cluster:A]` | **已验证** | E：会话真实收到 `[cluster:sim-node-b] …`，前缀正确 |
| A3 | A `cluster_broadcast` → 其余节点都收到，A 自己**不**收到 | **单测覆盖** | U：广播构造与目标过滤（`protocol` / `target` 测试） |
| A4 | 同一 messageId 重复投递只注入一次 | **单测覆盖** | U：`state.test.mjs` 滚动幂等集合 |
| A5 | 目标 agent 不可用时消息保留原位，agent 就绪后仍投递 | **已验证** | E：搁浅消息经接管后仍 `delivered`；U：退避重试账 |
| A6 | 心跳超过 `offlineAfterMs` → 名册标 offline；在线计数同步变化 | **单测覆盖** | U：`identity.test.mjs` 判活阈值 |
| A7 | 坏 JSON / 缺字段 / 超长 text / 未来版本 → 跳过并落痕，插件不崩 | **单测覆盖** | U：`protocol.test.mjs` + `bus.test.mjs` 坏样本 |
| A8 | 在线判定 / 名册显示 / 发送警告共用同一阈值常量（判据单源） | **单测覆盖** | U：断言 `DEFAULT_OFFLINE_AFTER_MS` 同源 |
| A9 | dispose 后无残留定时器、自身心跳文件已移除、无文件句柄泄漏 | **未专门覆盖** | —（HMR 安全相关，建议补一条尸体测试） |
| A10 | 写失败（只读目录）时工具返回明确错误，不静默；轨迹仍可写时不崩 | **单测覆盖** | U：`bus.test.mjs` 写失败路径 |
| A11 | 注入消息可从会话事件流重建（Model-visible ⟺ logged） | **已验证** | E：会话事件流中可见注入文本 |

**唯一未覆盖项是 A9**（dispose/HMR 残留）——标注为未验证，不当作已解决。

## 8. 与实现的关系

- 主实现：`self-plugins/dsh-agent-cluster/src/`（host-only，无 client 面）。
- 语义主副本：本文件。`README.md` 面向使用者（安装/配置/用法），不复制语义。
- 依赖：`ctx.tools`（工具面）、`ctx.agents`（投递）、`ctx.session`（用户会话枚举）。无对其他自研插件的 import（规则：不跨插件内部 import）。
- 与 `dsh-agent-sentinel` 的关系：**同源规则、独立实现**——哨兵的 `wake-target.ts` 是「唤醒目标裁决」主副本，本插件的 `target.ts` 是「收件投递目标裁决」主副本；两者规则一致但不是同一份代码（跨插件 import 违规），差异需在各自「实践修订记录」里对齐。

## 9. 实践修订记录

| 日期 | 类型 | 内容 |
|---|---|---|
| 2026-09-14 | 立项 | 主人指令；取证确认跨实例投递官方路径（`/api/session/prompt` + browser-auth cookie）与进程内路径（`agent.steer`），v0.1 选**纯文件总线**（无端口、无凭据、跨 DSH_HOME 可用） |
| 2026-09-14 | **事故** | **插件杀死了宿主 web 进程**：会话尚未装载时 `Session.events === undefined`，`target.ts` 的 `lastRealUserPromptAt` 直读 `.length` → `TypeError` 从 `setInterval` 回调**逃逸**（插件与宿主**同进程**，异常无框架兜底）。指纹：时间线精确到 1 秒（消息到达 10:52:50.2 → 进程消失 10:52:51.1），且**侧车轨迹里没有该消息的任何记录** ⇒ **崩在第一次落盘之前**——所以「没有日志」≠「没被触发」。**修复三层**：① `guarded()` 包住心跳/轮询全部回调 ② `safeDeliver()` 包单条投递 ③ 代理访问各自 try/catch；并加 **4 条源码级守卫契约测试**（`guard-contract.test.mjs`）锁死「新回调不得绕过兜底」。真凶是靠轨迹里一条 `deliver-error` 定案的 |
| 2026-09-14 | 修复 | **收件箱接管（`takeOverInbox`）**：节点重启后 `nodeId` 带 pid 会改名，旧身份的收件箱必须被接管，否则「改名即丢消息」 |
| 2026-09-14 | 对齐 | **触发者绑定**（主人口头规则「谁触发，提醒就发到谁」）：同源规则落在 `dsh-agent-plugin-manager`（改用 `exec.agent` 调用者会话）与 `dsh-agent-sentinel`（`wakeTarget` 加 `trustAnchor`——触发者 `updatedAt` 滞后**不作为**腐化证据，因长 turn 期间工具事件不推进 `updatedAt`，误判会导致改投 → 改投目标变活跃 → **正反馈环**）。本插件 `target.ts` 与哨兵 `wake-target.ts` 是同源规则的两个独立实现，本次未改动本插件，记录以备下次对齐 |

## 10. 未决问题

- **U1 实时推送通道**：轮询延迟（默认 2s）是否够用？是否需要 HTTP 推送（自建 `/cluster` 路由 + 总线密钥）？——若启用，需先确认非 `/api` 路由是否绕过宿主认证（取证进行中）。
- **U2 消息语义状态机**：`task`/`result` 是否需要回执（ack）、超时、状态流转？——留给工作台第二阶段。
- **U3 面板可视化**：名册与消息流是否要以面板呈现（`dsh-panel` 形态）？
- **U4 跨机安全**：非 loopback 场景的密钥/TLS/白名单——仅在启用推送后才有意义。
- **U5 主人广播工作台**：是否需要「主会话 → 全体节点派发 + 汇总回收」的一等场景（而非靠广播消息手工拼）？
- **U6 端口真源**：心跳中 `port` 恒为 `0`、`baseUrl` 为空 ⇒ `webServer` 端口探测失败，名册的「端口/地址」字段当前不可用。需在心跳周期内**重试解析**（对照 §5.11 的锚点腐化处理：锚点不可用则回退运行时真源，两者皆无则显式置空而非填 0）。附带：`nodeId` 因端口缺失而退化为 `web-0`，重启后靠 pid 后缀改名——这既是 U6 的症状，也是收件箱接管机制的由来。
- **U7 语义文档覆盖度**：A9（dispose/HMR 残留）尚无测试，见 §7。

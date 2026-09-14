<!--
purpose: 多 DSH 实例之间的文件总线通讯底座（身份 / 名册 / 点对点 / 广播 / 收件箱 / 会话注入）
inject: 无（不依赖宿主 service，只用 fs 与 logger）
tools: cluster_status / cluster_nodes / cluster_send / cluster_broadcast / cluster_inbox
runtime: DSH 插件（host 形态）；Node 20+
envDeps: 无（文件系统即传输层；无端口、无凭据、无中央进程）
boundary: 总线不是安全边界（同机进程可读写）；`cluster:` 消息是平级实例来信，不获得主人指令的特权
compat: 总线协议 v1；alice-workbench 应用只读同一批标准产物（trace / nodes / mailbox）
-->

# dsh-agent-cluster

![version](https://img.shields.io/badge/version-0.1.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![tests](https://img.shields.io/badge/tests-58%20passed-brightgreen)
![node](https://img.shields.io/badge/node-%E2%89%A520-informational)

DSH 多实例通讯底座 —— 让本机（或共享盘）上的**多个 DeepSeek Harness 实例互相说话**，用来搭多智能体工作台。

同一台机器上跑多个 DSH 实例（不同 profile / 不同端口 / 不同 `DSH_HOME`），每个实例装上本插件后自动获得：**稳定身份、全集群名册、点对点消息、广播、收件箱**；收到的消息被注入本实例的会话，交给该实例的 agent 处理。

**为什么用它而不是自己搓一个**：跨进程通讯的坑几乎全在**失败路径**上——身份撞名、消息重复注入、投递目标选错、坏数据搞崩主流程、异常逃逸杀掉宿主。这些都在本插件的测试里（58 条，含 3 条真实事故回归）。

## 它是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 多个 DSH **进程之间**的去中心化消息总线 + 在线名册 | 进程内编排（那是 subagent / workflow / Agent Teams 的事） |
| 文件系统总线：无端口、无凭据、无中央进程 | 中心 Broker —— 没有常驻中枢，没有单点，没有 leader 选举 |
| 只负责「把信送到」，回不回由对方 agent 决定 | 自动应答机 / 调度器 |
| 能力边界诚实（同机进程可读写总线，**不是沙箱**） | 授权通道 —— `cluster:` 消息是**平级实例来信**，不是主人指令，不获得特权 |

## 安装

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile <profile> add github:jonah791/dsh-agent-cluster
```

或本地开发（link）：

```sh
dsh plugin --profile <profile> add link:<path-to>/dsh-agent-cluster
```

安装后重启该 profile。若要被插件管理面识别为自研插件，放进 `self-plugins/` 并用 `plugin_mount` 挂载。

## 快速开始（两个实例互通）

1. 两个实例都装本插件，`busDir` 留空（都落到 `~/.dsh-cluster`）——**同一份总线**是互通的前提。
2. 各自重启，然后任一侧调 `cluster_nodes`，应看到对方（含在线判定）。
3. 用 `cluster_send` 点名发消息，用 `cluster_broadcast` 广播。
4. 对方会在一个轮询周期（默认 2s）内收到，消息以其 `nodeId` 为前缀注入它最近的用户会话：

   ```
   [cluster:DESKTOP-ABC-web-3081] 帮我把 X 跑一下，结果回给我
   ```

**30 秒验证**：调 `cluster_status` —— 应看到本节点身份、总线目录、在线邻居数。若邻居数为 0 且名册里有离线条目，多半是**两个实例的 `busDir` 不一致**（最常见误配）。

## 工具面

| 工具 | 用途 |
|---|---|
| `cluster_status` | 本节点身份、总线目录、在线邻居数、收发计数、待投递数、最近轨迹。**消息异常先查它** |
| `cluster_nodes` | 集群名册：nodeId / 角色 / profile / 地址 / 在线 / 最后心跳 |
| `cluster_send` | 点对点发消息（`kind`: chat \| task \| result \| event \| alert） |
| `cluster_broadcast` | 广播给其余所有实例（离线节点默认也投，等它上线） |
| `cluster_inbox` | 本实例收件箱：待投递 / 已归档 / 死信 |

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `busDir` | `~/.dsh-cluster` | 总线根目录。**要互通的实例必须配同一个值** |
| `nodeId` | 自动派生 | `<hostname>-<profile>-<port>`；显式配置优先 |
| `role` | `''` | 本节点角色标签（主脑 / 研究员 / 执行器…），名册展示用 |
| `tags` | `[]` | 能力标签，名册展示用 |
| `profile` / `port` / `baseUrl` | 自动探测 | 名册元数据；探测来源为 `DSH_PROFILE` / `DSH_PORT` / `--profile` / `--port` |
| `heartbeatMs` | `10000` | 心跳周期 |
| `offlineAfterMs` | `30000` | 判活阈值（名册显示与在线计数共用同一判据） |
| `pollIntervalMs` | `2000` | 收件箱轮询周期 |
| `maxTextChars` | `8000` | 单条消息正文上限（超限拒绝，不静默截断） |
| `maxAttempts` | `20` | 单条消息最大投递尝试，超过进 `dead/` |
| `mainSessionId` | `''` | 钉死目标会话；空 = 自动选最近有真实用户输入的顶层会话 |
| `autoInject` | `true` | `false` = 只入收件箱，由 agent 用 `cluster_inbox` 取用 |
| `maxRoster` | `200` | 名册列出上限 |

## 总线磁盘布局

```
<busDir>/
  nodes/<nodeId>.json          心跳与身份（每节点只写自己那份）
  mailbox/<nodeId>/<id>.json   收件箱（发送方创建，no-clobber）
  mailbox/<nodeId>/done/       投递成功归档
  mailbox/<nodeId>/dead/       坏数据 / 过期 / 重试耗尽
  state/<nodeId>.json          本节点已处理集合与计数
  cluster-trace.jsonl          全节点追加的侧车轨迹（一行一 JSON）
```

消息就是一个文件 —— 写成功即在，读走才归档。排障只需 `ls` 与 `tail cluster-trace.jsonl`。

## 落盘与自证 ★

写盘的东西就是**证据层**：五问（谁发起 / 投给谁 / 断在哪段 / 结果质量 / 耗时）都能从轨迹直接读出来。

```sh
tail -3 "$HOME/.dsh-cluster/cluster-trace.jsonl"     # Windows: $env:USERPROFILE\.dsh-cluster\...
```

一行样本（实测）：

```json
{"atMs":1789383600912,"node":"DEMO-host-web-0-31116","pid":31116,"phase":"delivered",
 "id":"m-mu14jelv-0jclsah0","from":"sim-node-b","kind":"chat",
 "sid":"session-a5375716-…","why":"未指定锚点 → 投最近有真实用户输入的顶层会话","chars":53,"archived":true}
```

| 问题 | 字段 |
|---|---|
| ① 谁发起 / 投给谁 | `node` · `from` · `sid` |
| ② **断在哪一段** | `phase`（枚举即断点分类：`startup / startup-poll / sent / delivered / no-target / deliver-error / inbox-inherit / state-recovered / takeover`） |
| ③ 结果质量 | `chars`（字符数）· `archived` |
| ④ **为什么这样决策** | `why`（人话理由，如"锚点滞后 166s → 改投最近活跃"） |
| ⑤ 什么时候 | `atMs` |

`state/<nodeId>.json` 另存幂等集合与重试账（可判断某条消息是否已被处理过、失败了几次）。

## 生效判据与回退 ★

| 问题 | 判据 |
|---|---|
| 线上跑的是当前构建吗？ | `cluster_status` 自报的 build/身份 + `lib/index.js` 的 mtime 与宿主进程启动时间对照 |
| 改完代码怎么生效？ | `pnpm build` → 预检 → 哨兵重启（**重新构建 ≠ 生效**：产物 mtime 新只证明"构建过"，不证明"进程在跑它"） |
| 回退 | ① 源码 `git revert` + 重建 + 重启 ② 组合里置 `disabled: true` ③ 本插件运行期**无自有状态需要迁移**，回退不丢消息（账在总线里） |

## 测试 ★

```sh
pnpm test
```

**实测：58 passed / 0 failed / 182 ms**（`node --test`，离线，无需宿主）。

| 覆盖面 | 内容 |
|---|---|
| 协议 | 消息构造/校验、版本不符、超长正文、TTL 过期 |
| 身份 | 派生、撞名裁决（活跃则避让 / 陈旧则接管）、判活 |
| 总线 | 原子发布（no-clobber）、归档、`done/dead` 分类、接管旧收件箱 |
| **目标裁决** | 含 **3 条真实事故回归**：2026-09-03 自我强化循环（注入不使会话变"新"）、2026-09-12 漏投（子代理会话永不作目标）、锚点腐化改投 |
| 状态 | 幂等集合上限、指数退避、重试账 |
| **守卫契约** | 4 条源码级断言：定时器/轮询回调必须经 `guarded()` 兜底（防后来者绕过——逃逸异常会杀死宿主进程） |

## 设计要点（为什么这样做）

- **为什么是文件总线而不是 HTTP**：无端口冲突、无凭据传递、跨 `DSH_HOME` 与跨机（共享盘）都能用；崩溃语义简单。
- **no-clobber 原子发布**：消息用「同目录临时文件 + `link()`」创建（`link` 不可用时退化 `rename` 并在轨迹留痕），重复 id 不覆盖。
- **幂等**：同一 `messageId` 至多注入一次（`state/<nodeId>.json` 的滚动已处理集合）。
- **不丢**：投递失败保留原位、指数退避重试（有界），过期或超次数才进 `dead/` 并留痕 —— 绝不静默丢弃。
- **目标裁决只认真实用户输入**：注入型消息（含本插件自己注入的）不参与「谁最新」的判定，否则会形成「谁被注入谁变新」的自我强化循环；派生（子代理）会话永不作为投递目标。这两条都来自真实事故回归（见 `tests/target.test.mjs`）。
- **宿主内回调一律兜底**：插件与宿主**同进程**，定时器回调里逃逸的异常没有框架接住，等于宿主自杀（本项目真实事故：`Session.events` 为 undefined 时直读 `.length` 导致 web 进程被 `TypeError` 杀死）。故所有定时器入口经 `guarded()`，且用源码级测试锁死。
- **输入不可信**：总线文件按不可信数据处理，坏 JSON / 版本不符 / 超长正文一律分类拒绝并落痕，不让主流程崩。
- **观测不反噬**：轨迹与状态落盘失败只吞错返回 `false`，不影响投递。

## 开发

```sh
pnpm install
pnpm build      # tsc → lib/
pnpm test       # node --test tests/*.test.mjs（离线，无需宿主）
pnpm typecheck
```

`scripts/sim-node.mjs` 是**模拟第二节点**（不是 DSH），用来做双端联调与验收。

## 相关文档

- 语义文档（本插件契约主副本）：[`docs/semantic.md`](docs/semantic.md)
- 实施版规格（多智能体工作台全貌）：[`docs/spec.md`](docs/spec.md)
- 决策史（为什么这样设计，含被推翻的判断）：[`docs/design.md`](docs/design.md)
- 配套桌面控制台：[alice-workbench](https://github.com/jonah791/alice-workbench)
- 生态中心仓：[alice-digital-life](https://github.com/jonah791/alice-digital-life)

## 已知边界

- 总线文件同机可读写，**不是安全边界**；跨机共享盘场景下请自行用文件系统权限保护总线目录。
- v0.1 无 HTTP 推送通道，延迟 = 轮询周期（默认 2s）。
- 无自动清理：`done/`、`dead/` 归档只增不减（保留证据），需要时手动清理。
- 不做消息级回执（ack）与状态机；需要「收到请回」时用 `cluster_send` 带 `replyTo` 手工回。
- 端口探测可能失败（`port` 上报为 0）——此时名册仍可用，但依赖端口的推送能力降级。

## License

MIT © jonah791

---

本插件属于**爱丽丝 DSH 自研生态**（50 个插件）——见中心仓 [alice-digital-life](https://github.com/jonah791/alice-digital-life)。

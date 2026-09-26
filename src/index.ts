/**
 * dsh-agent-cluster — DSH 多实例通讯底座（host-only 插件）。
 *
 * 语义主副本：`docs/semantic.md`（本文件是它的实现逼近，不是另一份语义）。
 *
 * 一句话：本机（或共享盘）上多个 DSH 实例之间共享一个**文件总线目录**，
 * 各实例周期性写自己的心跳、投递自己的收件箱；`cluster_*` 工具负责发消息，
 * 收到的消息被注入本实例的顶层会话交给 agent 处理。
 *
 * 为什么是文件总线而不是 HTTP broker：
 *   - 无端口、无凭据、无中央进程 —— 跨 profile、跨 DSH_HOME、跨机（共享盘）都能用；
 *   - 崩溃语义简单：消息就是一个文件，写成功即在，读走才归档；
 *   - 不做安全承诺（能力 ≠ 沙箱）：同机进程可读写总线，故总线内容一律按不可信数据处理。
 *
 * 不替 agent 决策：本插件只投递「来信」，不做自动应答、不解析指令、不赋予特权。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent' // Context.agents 类型 merge
import type {} from '@deepseek-ai/dsh-session' // Session/事件类型 merge
import { randomBytes } from 'node:crypto'
import { homedir, hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import {
  appendTrace, atomicWriteJson, busPaths, countFilesRecursive, ensureBusDirs, inboxDir, isFile, listDirs, listJsonFiles,
  moveToBucket, nodeFile, publishNoClobber, readJsonValue, removeDirIfEmpty, removeIfExists,
  stateFile, tailTrace, takeOverInbox, type BusPaths,
} from './bus.ts'
import {
  ageText, deriveNodeId, nodeOnline, parseHeartbeat, pickReapableMailboxes, resolveCollision, sanitizeId, shouldReap, type Heartbeat,
} from './identity.ts'
import {
  canLead, decideLeader, describeLeader, grantLease, normalizeKind, parseLease, renewIntervalMs,
  type LeaderCandidate, type LeaderLease,
} from './leader.ts'
import {
  DEFAULT_MAX_TEXT_CHARS, injectionText, isExpired, makeMessage, parseMessage, MESSAGE_KINDS,
  type MessageKind,
} from './protocol.ts'
import {
  attemptCount, defaultState, isHandled, isHoldNoted, loadState, markHandled, markHoldNoted,
  noteFailure, readyToRetry, serializeState, type NodeState,
} from './state.ts'
import { decideTarget, type SessionEventLite, type SessionLite } from './target.ts'
// 投递未成功的**语义分类**（`miss.ts`）：区分「还没到时候」（可恢复 ⇒ 消耗重试）与
// 「这条路对我不可用」（结构性 ⇒ 保留原位）。2026-09-26 断点：无会话节点被当失败重试到 dead。
import { classifyMiss, describeMiss, type MissReason } from './miss.ts'
// 宿主兼容（`docs/semantic.md` §5.10）：本插件是**可安装**产物，装到谁的机器上、对方的 DSH
// 是什么版本，由对方决定。`inject` 只保证「服务在」，保证不了「服务上的 API 还在」
// （`Session.events` 就是这么丢的）——API 形状一律**探测**，不假设。
import { describeCompat, probeHostCompat, probeServices, readSessionEvents, type HostCompat } from './host-compat.ts'
// 跨机承载（`docs/members.md` §5）：传输适配器 + 自开端点 + 成员册。
// 这一层是对 §6「不做网络」的**有意修订**——纪律是默认关闭 + fail-closed。
import { parseMemberRecord, type MemberRecord } from './transport.ts'
import { JOIN_PATH, memberDirOf, postJson, pushToPeer, readMembersFromDisk, startHttpNode, type HttpNodeHandle } from './http-node.ts'
// 入网（§5.11）：令牌 = 一次入网的完整凭据（地址 + 该成员专属密钥 + 已裁决的准入）。
// 交付形态是「可安装」⇒ 入网必须对方**一步**做完，且**不需要知道我的 busDir**。
import { createJoinHandler } from './join.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-agent-cluster': { kind: 'dsh-agent-cluster' }
  }
}

/** 插件名（Loader 用）。 */
export const name = 'agent-cluster'

/** 必需 service：工具面 / agent 投递 / 会话枚举。 */
export const inject = ['agents', 'sessions', 'tools'] as const

/** 插件配置（全部可部署期覆盖，无源码常量）。 */
export interface Config {
  /** 总开关。 */
  enabled: boolean
  /** 总线根目录；空 = `~/.dsh-cluster`。所有要互通的实例必须配同一个值。 */
  busDir: string
  /** 本节点 id；空 = 按 `<hostname>-<profile>-<port>` 派生。 */
  nodeId: string
  /** 本节点角色标签（如 主脑/研究员/执行器），只用于名册展示。 */
  role: string
  /** 本节点能力标签，只用于名册展示与筛选。 */
  tags: string[]
  /** profile 名；空 = 从 `DSH_PROFILE` 或 `--profile` 探测。 */
  profile: string
  /** 对外地址（名册展示；本机默认 `http://127.0.0.1:<port>`）。 */
  baseUrl: string
  /** 监听端口；0 = 从 `DSH_PORT` 或 `--port` 探测。 */
  port: number
  /** 心跳周期（ms）。 */
  heartbeatMs: number
  /** 判活阈值（ms）：超过即视为离线（判据单一真源）。 */
  offlineAfterMs: number
  /** 收件箱轮询周期（ms）。 */
  pollIntervalMs: number
  /** 单条消息正文上限（字符）。 */
  maxTextChars: number
  /** 单条消息最大投递尝试次数，超过进 dead/。 */
  maxAttempts: number
  /** 钉死的目标会话 id（空 = 自动裁决最近有真实用户输入的顶层会话）。 */
  mainSessionId: string
  /** 是否自动把收到的消息注入会话；false = 只入收件箱，由 agent 用 cluster_inbox 取。 */
  autoInject: boolean
  /** 名册最多列出多少节点（防总线目录膨胀拖慢工具）。 */
  maxRoster: number
  /**
   * 跨机入站监听端口；**0 = 关闭**（默认）。
   * 默认关闭是硬纪律：加网络层是对 `semantic.md` §6「不做网络」的**有意修订**，
   * 不配置时必须与加网络前的行为**逐字节相同**（见 `docs/members.md` §5.3）。
   */
  listenPort: number
  /** 是否接受入站（缺省 `false`；跨机互联要显式打开）。 */
  allowInbound: boolean
  /** 跨机传输共享密钥（空 = 既不收也不发；fail-closed）。 */
  secret: string
  /** 网络名（§5.11）：令牌带着它，防止一张令牌被用去另一个网络（`not-my-network`）。 */
  network: string
  /** 本节点端类型（`server`/`desktop`/`phone`/`watch`/`glasses`）；空 = `unknown`。主脑资格按它判定。 */
  nodeKind: string
  /** 是否参与主脑选举（手表/眼镜等省电端可置 false）。 */
  leaderEligible: boolean
  /** 主脑租约存活期（ms）；续租间隔 = TTL/3（缺省 90s / 30s，见 `docs/design.md` §15.1）。 */
  leaderLeaseTtlMs: number
  /**
   * 是否**自动续租**（缺省 `false` = 显式配置才开，与「加网络层要显式配置」同一纪律）。
   *
   * 关闭时主脑只是**一次性任期**：TTL 一过租约失效、需再次 `claim`。
   * 打开后本节点在任期内每 TTL/3 续租一次，主脑才成为**持续角色**（设计 §15.1 的原意）。
   */
  leaderAutoRenew: boolean
}

/** 配置 schema（默认值即本机单机可用值）。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  busDir: z.string().default(''),
  nodeId: z.string().default(''),
  role: z.string().default(''),
  tags: z.array(z.string()).default([]),
  profile: z.string().default(''),
  baseUrl: z.string().default(''),
  port: z.number().default(0),
  heartbeatMs: z.number().default(10_000),
  offlineAfterMs: z.number().default(30_000),
  pollIntervalMs: z.number().default(2_000),
  maxTextChars: z.number().default(DEFAULT_MAX_TEXT_CHARS),
  maxAttempts: z.number().default(20),
  mainSessionId: z.string().default(''),
  autoInject: z.boolean().default(true),
  maxRoster: z.number().default(200),
  listenPort: z.number().default(0),
  allowInbound: z.boolean().default(false),
  secret: z.string().default(''),
  network: z.string().default('dsh-cluster'),
  nodeKind: z.string().default(''),
  leaderEligible: z.boolean().default(true),
  leaderLeaseTtlMs: z.number().default(90_000),
  leaderAutoRenew: z.boolean().default(false),
})

/** 运行时探测结果（进程环境事实，不是配置）。 */
interface RuntimeFacts {
  hostname: string
  profile: string
  port: number
  pid: number
}

/**
 * 从进程环境探测 profile 与端口（配置为空时的兜底；探测不到就回落 0/''）。
 * @returns 运行时事实
 */
export function detectRuntime(argv: readonly string[], env: Record<string, string | undefined>): RuntimeFacts {
  let profile = env['DSH_PROFILE'] ?? ''
  if (profile === '') {
    const i = argv.indexOf('--profile')
    if (i >= 0 && argv[i + 1] !== undefined) profile = argv[i + 1] as string
    if (profile === '') {
      for (const a of argv) {
        const m = /^--profile=(.+)$/.exec(a)
        if (m !== null && m[1] !== undefined) { profile = m[1]; break }
      }
    }
  }
  let port = Number(env['DSH_PORT'] ?? '')
  if (!Number.isFinite(port) || port <= 0) {
    // `DSH_WEB_URL`（宿主注入的环境事实，如 `http://127.0.0.1:3080`）是 web 端口最可靠的真源：
    // 实测 web 端口来自 profile patch（不在 argv 里），而 `ctx.get('webServer')` 在 apply 阶段
    // 尚未注册（返回 undefined）→ nodeId 曾退化为 `…-web-0`，每次重启改名、收件箱漂移。
    const m = /:(\d{2,5})\/?$/.exec(env['DSH_WEB_URL'] ?? '')
    if (m !== null && m[1] !== undefined) port = Number(m[1])
  }
  if (!Number.isFinite(port) || port <= 0) {
    port = 0
    const i = argv.indexOf('--port')
    if (i >= 0 && argv[i + 1] !== undefined) {
      const v = Number(argv[i + 1])
      if (Number.isFinite(v) && v > 0) port = v
    }
    if (port === 0) {
      for (const a of argv) {
        const m = /^--port=(\d+)$/.exec(a)
        if (m !== null && m[1] !== undefined) { port = Number(m[1]); break }
      }
    }
  }
  return { hostname: osHostname(), profile, port, pid: process.pid }
}

/**
 * 解析总线根目录：配置优先，空则 `~/.dsh-cluster`（**不落在 DSH_HOME 内**：
 * 不同实例可能各有 DSH_HOME，总线必须独立于它们）。
 */
export function resolveBusRoot(configured: string, home: string): string {
  const c = configured.trim()
  if (c !== '') return c
  return join(home, '.dsh-cluster')
}

const nonce = (): string => String(process.pid) + '-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex')

/**
 * 读某节点的心跳（身份冲突裁决用）：文件不存在或坏数据一律当作「无心跳」。
 * @param paths - 总线路径
 * @param id - 目标节点 id
 */
function readHeartbeat(paths: BusPaths, id: string): { pid?: number; atMs?: number; hostname?: string } | undefined {
  const raw = readJsonValue(nodeFile(paths, id))
  if (!raw.ok) return undefined
  const parsed = parseHeartbeat(raw.value)
  if (!parsed.ok) return undefined
  return { pid: parsed.hb.pid, atMs: parsed.hb.atMs, hostname: parsed.hb.hostname }
}

/**
 * 进程是否还活着（前身判定 / 血统清扫的依据）。
 * **未知一律按「活着」处理**（pid 非法、EPERM 等）——宁可留垃圾，不可误删活节点（保守优先）。
 * @param pid - 目标进程号
 */
function pidAlive(pid: number): boolean {
  if (!(typeof pid === 'number' && Number.isFinite(pid) && pid > 0)) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH = 进程不存在；其余（EPERM 等）= 存在但无权限 ⇒ 视为活着
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** 名册条目（工具与状态共用）。 */
interface RosterEntry {
  nodeId: string
  role: string
  profile: string
  workspace: string
  baseUrl: string
  port: number
  pid: number
  tags: string[]
  ageMs: number
  online: boolean
  self: boolean
  corrupt: boolean
}

/** 启动插件。 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const logger = ctx.logger('agent-cluster')
  const facts = detectRuntime(process.argv, process.env)
  const busRoot = resolveBusRoot(config.busDir, homedir())
  const paths: BusPaths = busPaths(busRoot)
  const profile = config.profile !== '' ? config.profile : (facts.profile !== '' ? facts.profile : 'unknown')
  // 端口真源优先级：显式配置 > **webServer 服务**（可选，用 ctx.get 不注入）> argv/env 探测。
  // argv 探测对本部署无效（web 端口来自 profile patch 的 `ctx.webStartup.port ?? 3080`，不在 argv 里），
  // 线上实测 nodeId 曾退化为 `…-web-0`（2026-09-14）——端口是身份的一部分，多实例必须能区分。
  const webServer = ctx.get('webServer' as never) as unknown as { port?: number } | undefined
  const livePort = typeof webServer?.port === 'number' && Number.isFinite(webServer.port) && webServer.port > 0 ? webServer.port : 0
  const port = config.port > 0 ? config.port : (livePort > 0 ? livePort : facts.port)
  const requestedId = sanitizeId(config.nodeId) !== ''
    ? sanitizeId(config.nodeId)
    : deriveNodeId(facts.hostname, profile, port)

  // ── 身份裁决（I1）：同名心跳活跃且非本进程 → 改名避让，绝不覆盖他人 ──
  // 2026-09-15（Round 3-b）加一层「前身判定」：同名 + 同主机 + 那个 pid 已死 = **我的前身**，不是别人
  // ⇒ 回收原名（而不是改名避让）。判活事实在 IO 层查得后**显式传入**纯逻辑；未知一律按「活着」处理。
  let identityError = ''
  const pre = ensureBusDirs(paths, requestedId)
  if (!pre.ok) identityError = pre.error ?? '总线目录创建失败'
  const existing = readHeartbeat(paths, requestedId)
  const decision = resolveCollision(
    { nodeId: requestedId, pid: facts.pid },
    existing,
    Date.now(),
    config.offlineAfterMs,
    String(facts.pid),
    {
      pidAlive: existing === undefined || existing.pid === undefined ? true : pidAlive(existing.pid),
      sameHost: existing?.hostname !== undefined && existing.hostname === facts.hostname,
    },
  )
  const nodeId = decision.nodeId
  const dirs = ensureBusDirs(paths, nodeId)
  if (!dirs.ok) identityError = dirs.error ?? identityError
  // ── 改名接管（I2 不丢消息）：改名避让后，旧身份的待投递收件箱整箱接管过来 ──
  if (decision.renamed) {
    const inh = takeOverInbox(paths, requestedId, nodeId)
    if (inh.moved > 0 || inh.skipped > 0 || inh.failed > 0) {
      appendTrace(paths.traceFile, { atMs: Date.now(), node: nodeId, pid: facts.pid, phase: 'inbox-inherit', from: requestedId, ...inh })
    }
  }
  const inbox = inboxDir(paths, nodeId)
  const heartbeatFile = nodeFile(paths, nodeId)
  const statePath = stateFile(paths, nodeId)

  /** 侧车轨迹：一行一 JSON，吞错（I7）。 */
  const trace = (phase: string, extra: Record<string, unknown> = {}): void => {
    appendTrace(paths.traceFile, { atMs: Date.now(), node: nodeId, pid: facts.pid, phase, ...extra })
  }
  trace('startup', { requestedId, nodeId, renamed: decision.renamed, reclaimed: decision.reclaimed, why: decision.why, busRoot, dirsOk: dirs.ok })
  if (identityError !== '') logger.error('总线目录异常：' + identityError)

  /**
   * 血统清扫（Round 3-b · 2026-09-15）：删除**自己的死前身**留下的心跳与状态文件——「重启收自己的尸」。
   * 判据（纯逻辑 `shouldReap`）：同主机 + 同 profile + id 在 `<host>-<profile>` 前缀内 + pid **确认已死** + 不是自己。
   * 边界：**不碰别人的节点**（`wb-0`/`ref-0`/其它主机各有其所有者）；**不删消息**（收件箱目录留给各自所有者与审计）。
   * 动机：每次 web 重启都因「同名心跳仍新鲜」而改名避让，攒下 17 个死心跳 —— 星图把它们画成离线星，
   * 名册把它们当成节点，而它们只是我的前任。
   */
  const sweepLineage = (): { reaped: string[]; kept: number } => {
    const reaped: string[] = []
    let kept = 0
    for (const f of listJsonFiles(paths.nodesDir)) {
      const id = f.replace(/\.json$/, '')
      if (id === nodeId) continue
      const raw = readJsonValue(join(paths.nodesDir, f))
      if (!raw.ok) { kept++; continue }
      const parsed = parseHeartbeat(raw.value)
      if (!parsed.ok) { kept++; continue }
      if (!shouldReap(parsed.hb, { nodeId, hostname: facts.hostname, profile }, { pidAlive: pidAlive(parsed.hb.pid) })) { kept++; continue }
      if (!removeIfExists(join(paths.nodesDir, f))) { kept++; continue }
      removeIfExists(stateFile(paths, id)) // 前身的状态文件同样无用；删失败无害
      reaped.push(id)
    }
    return { reaped, kept }
  }
  const swept = sweepLineage()
  if (swept.reaped.length > 0) trace('reap-lineage', { reaped: swept.reaped.length, ids: swept.reaped, kept: swept.kept })

  /**
   * 信箱空壳清扫（2026-09-26 · t-afbab493）：A13 收了前身的**心跳与状态**，却没管它留下的
   * **信箱目录**——web 每次重启因同名心跳新鲜而改名避让（`web-0` → `web-0-<pid>`），
   * 每个新 nodeId 就多一个 `mailbox/<nodeId>/`；实测一次扫出 **188 个空壳**
   * （2026-09-26 22:54，形态清一色 `LAPTOP-BF4IAPLM-web-<pid>`；已手工清理至 10）。
   *
   * 判据（三条，与 A13 同源）：
   *   ① 只碰**自己的血统**——目录名即 nodeId，走 `isOwnLineage`；别人的目录由各自所有者负责；
   *   ② 只清**完全空**的目录——`countFilesRecursive` 判「一个文件都没有」，
   *      再由 `removeDirIfEmpty` 执行（**只用 rmdir，永不删文件**）；
   *   ③ **不碰名册与投递**——只动 mailbox 目录，不碰 `nodes/`、不改消息。
   *
   * 动机：空壳让「这条总线上有谁」看起来比实际多（星图多画离线星）；而**有归档消息的
   * 目录是审计资产**（I12、U10 残余），一律保留。
   */
  const sweepEmptyMailbox = (): { removed: string[]; kept: number } => {
    const removed: string[] = []
    const names = listDirs(paths.mailboxDir)
    const me = { hostname: facts.hostname, profile }
    // 判据走纯函数（离线可测）：我的血统 + 完全空。目录内容由 IO 层探得后**显式传入**
    // ——「事实由 IO 查得、逻辑只做判定」是 A13 定下的同一分工（I12）。
    const reapable = pickReapableMailboxes(names, me, (name) => countFilesRecursive(join(paths.mailboxDir, name)))
    for (const name of reapable) {
      if (removeDirIfEmpty(join(paths.mailboxDir, name))) removed.push(name)
    }
    return { removed, kept: names.length - removed.length }
  }
  const sweptMailbox = sweepEmptyMailbox()
  if (sweptMailbox.removed.length > 0) {
    trace('reap-mailbox-empty', { removed: sweptMailbox.removed.length, ids: sweptMailbox.removed, kept: sweptMailbox.kept })
  }

  // ── 状态（I3 幂等集合 + 重试账）──
  const loaded = ((): NodeState => {
    const raw = readJsonValue(statePath)
    const r = loadState(raw.ok ? raw.value : null, nodeId, Date.now())
    if (r.recovered) trace('state-recovered', { why: r.why })
    return r.state
  })()
  let state: NodeState = loaded
  const persist = (): boolean => atomicWriteJson(statePath, JSON.parse(serializeState(state)) as unknown, nonce()).ok

  // ── 心跳 ──
  const startedAt = Date.now()
  const baseUrl = config.baseUrl !== '' ? config.baseUrl : (port > 0 ? 'http://127.0.0.1:' + String(port) : '')
  const beat = (): void => {
    const hb: Heartbeat = {
      v: 1,
      nodeId,
      role: config.role,
      profile,
      workspace: process.cwd(),
      baseUrl,
      port,
      pid: facts.pid,
      hostname: facts.hostname,
      startedAt,
      atMs: Date.now(),
      tags: config.tags,
      // 本构建实现了租约协议（`src/leader.ts`）⇒ 自报能力。**能力要自报，不靠别人猜**：
      // 缺这个字段的节点（老版本 / 别的应用里的旧构建）在选举里按「不具备」处理。
      leaderCapable: true,
      // 端类型也要自报，否则「手表/眼镜端默认不合格」这条判据在真实总线上是死的
      // （未声明一律 unknown = 桌面级 ⇒ 手表也会参选）。空配置 = 不写这个字段（老行为）。
      ...(config.nodeKind.trim() === '' ? {} : { kind: normalizeKind(config.nodeKind) }),
    }
    const r = atomicWriteJson(heartbeatFile, hb, nonce())
    if (!r.ok) logger.error('心跳写入失败：' + String(r.error))
  }
  beat()

  // ── 名册 ──
  const roster = (includeOffline: boolean): RosterEntry[] => {
    const now = Date.now()
    const out: RosterEntry[] = []
    for (const f of listJsonFiles(paths.nodesDir)) {
      if (out.length >= config.maxRoster) break
      const raw = readJsonValue(join(paths.nodesDir, f))
      if (!raw.ok) {
        out.push({ nodeId: f.replace(/\.json$/, ''), role: '', profile: '', workspace: '', baseUrl: '', port: 0, pid: 0, tags: [], ageMs: Number.POSITIVE_INFINITY, online: false, self: false, corrupt: true })
        continue
      }
      const parsed = parseHeartbeat(raw.value)
      if (!parsed.ok) {
        out.push({ nodeId: f.replace(/\.json$/, ''), role: '', profile: '', workspace: '', baseUrl: '', port: 0, pid: 0, tags: [], ageMs: Number.POSITIVE_INFINITY, online: false, self: false, corrupt: true })
        continue
      }
      const hb = parsed.hb
      const online = nodeOnline(hb, now, config.offlineAfterMs)
      if (!online && !includeOffline) continue
      out.push({
        nodeId: hb.nodeId,
        role: hb.role,
        profile: hb.profile,
        workspace: hb.workspace,
        baseUrl: hb.baseUrl,
        port: hb.port,
        pid: hb.pid,
        tags: hb.tags,
        ageMs: hb.atMs > 0 ? now - hb.atMs : Number.POSITIVE_INFINITY,
        online,
        self: hb.nodeId === nodeId,
        corrupt: false,
      })
    }
    return out.sort((a, b) => Number(b.online) - Number(a.online) || a.nodeId.localeCompare(b.nodeId))
  }

  // ── 发送 ──
  const sendTo = (to: string, text: string, kind: MessageKind, ttlMs: number | undefined, replyTo: string | undefined): { ok: boolean; id?: string; duplicate?: boolean; error?: string } => {
    if (to === nodeId) return { ok: false, error: '目标是自己（本节点 id=' + nodeId + '）' }
    if (to === '' || sanitizeId(to) !== to) return { ok: false, error: '目标 id 非法：' + JSON.stringify(to) }
    const known = roster(true).some((r) => r.nodeId === to)
    if (!known) return { ok: false, error: '目标节点不在名册（未运行过或 id 拼错）；可用 cluster_nodes 查看' }
    const msg = makeMessage({ from: nodeId, to, text, kind, ...(ttlMs !== undefined ? { ttlMs } : {}), ...(replyTo !== undefined ? { replyTo } : {}) }, Date.now(), randomBytes(4).toString('hex'))
    const dest = join(inboxDir(paths, to), msg.id + '.json')
    const r = publishNoClobber(dest, msg, nonce())
    if (!r.ok) {
      trace('send-error', { to, id: msg.id, error: r.error })
      return { ok: false, error: r.error ?? '写入失败' }
    }
    if (r.degraded === true) trace('send-degraded', { to, id: msg.id, why: 'link 不可用，退化 rename（可能覆盖同 id 消息）' })
    state = { ...state, counters: { ...state.counters, sent: state.counters.sent + 1 }, updatedAt: Date.now() }
    persist()
    trace('sent', { to, id: msg.id, kind: msg.kind, chars: text.length, duplicate: r.duplicate })
    return { ok: true, id: msg.id, duplicate: r.duplicate }
  }

  // ── 跨机承载（`docs/members.md` §5）──
  // **默认关闭**：`listenPort === 0` 时不启动任何监听、不发任何请求 ⇒ 与加网络层前逐字节相同。
  const memberDir = memberDirOf(busRoot)
  const readMemberList = (): MemberRecord[] => readMembersFromDisk(memberDir, parseMemberRecord).members

  // ── 入网（§5.11）：令牌 = 一次入网的完整凭据 ──
  // 缺口：成员册原本要**手工写 JSON** 才算加入。但本插件的交付形态是「装了这个插件的智能体
  // 都能接入网络」（主人 2026-09-22 定义）⇒ 入网必须对方**一步**做完，且不必知道我的 busDir
  // （地址写在令牌里）。这里只放**裁决**；令牌本身的解析/校验在纯模块 `invite.ts`。
  const joinUsedFile = join(busRoot, 'join-used.json')
  /** 已用 nonce 上限：长期运行不许无限增长（真正的清理策略见 §10 U14）。 */
  const JOIN_USED_CAP = 500

  const readUsedNonces = (): string[] => {
    const raw = readJsonValue(joinUsedFile)
    if (!raw.ok) return []
    const o = raw.value as { nonces?: unknown } | null
    const list = o !== null && typeof o === 'object' ? o.nonces : undefined
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : []
  }

  /** 标记令牌已用（防重放）。读-改-写窗口内的并发由上层「一台主脑」假设兜住（§5.14）。 */
  const markNonceUsed = (n: string): void => {
    const list = readUsedNonces()
    if (list.includes(n)) return
    list.push(n)
    atomicWriteJson(joinUsedFile, { nonces: list.slice(-JOIN_USED_CAP), updatedAt: Date.now() }, nonce())
  }

  /** 我自己的入站基址；**没有端点 ⇒ 空串**（此时签不出可用的令牌，因为对方没有可回的地址）。 */
  const joinBaseUrl = (): string => {
    const port = httpNode?.port ?? config.listenPort
    return port > 0 ? 'http://127.0.0.1:' + String(port) : ''
  }

  /** 回给入网方的「主脑记录」。 */
  const selfMemberRecord = (): MemberRecord => {
    const base = joinBaseUrl()
    return {
      memberId: nodeId,
      kind: 'self',
      trust: 'known',
      capabilities: ['cluster'],
      protocol: 'v1',
      ...(base !== '' ? { endpoint: base } : {}),
      notes: 'cluster 主脑（profile ' + profile + '，网络 ' + config.network + '）',
    }
  }

  /**
   * 入网裁决（§5.11）——**实现在纯模块 `join.ts`**，这里只注入 IO。
   *
   * 为什么不在 apply 里内联：内联的逻辑只能靠假 ctx 测，而这一段恰恰是最需要**可跑证据**的
   * （它是唯一一条「未认证」入口）。抽出来之后 `scripts/join-demo.mjs` 能用真 HTTP 驱动它。
   */
  const joins = createJoinHandler({
    network: config.network,
    nodeId,
    profile,
    nowMs: () => Date.now(),
    trace: (event, fields) => trace(event, fields ?? {}),
    readUsedNonces,
    markNonceUsed,
    writeMember: (rec) => {
      const w = atomicWriteJson(join(memberDir, rec.memberId + '.json'), JSON.parse(JSON.stringify(rec)) as unknown, nonce())
      return w.ok ? { ok: true } : { ok: false, ...(w.error !== undefined ? { error: w.error } : {}) }
    },
    selfRecord: selfMemberRecord,
    myBaseUrl: joinBaseUrl,
    post: (url, body) => postJson({ url, body }),
  })
  const handleJoin = joins.handleJoin

  let httpNode: HttpNodeHandle | undefined
  if (config.listenPort > 0) {
    void startHttpNode({
      port: config.listenPort,
      secret: config.secret,
      allowInbound: config.allowInbound,
      members: readMemberList,
      // 入站消息**复用既有投递管线**：落进本机收件箱，其余交给轮询 → 裁决 → 注入。
      // 这样跨机与同机走同一条投递逻辑（不制造第二条路径，也就不会漂移）。
      onInbound: (body, from) => {
        try {
          const parsed = parseMessage(JSON.parse(body) as unknown, { maxTextChars: config.maxTextChars })
          if (!parsed.ok) {
            trace('http-inbound-bad-envelope', { from, reason: parsed.reason })
            return
          }
          const msg = parsed.message
          if (isHandled(state, msg.id)) {
            trace('http-inbound-duplicate', { id: msg.id, from })
            return
          }
          const r = atomicWriteJson(join(inbox, msg.id + '.json'), JSON.parse(JSON.stringify(msg)) as unknown, nonce())
          trace('http-inbound-stored', { id: msg.id, from, kind: msg.kind, ok: r.ok })
        } catch (e) {
          trace('http-inbound-error', { from, message: e instanceof Error ? e.message : String(e) })
        }
      },
      onJoin: handleJoin,
      trace,
    }).then((h) => {
      httpNode = h
      trace('http-ready', { port: h.port })
    }).catch((e: unknown) => {
      trace('http-start-failed', { message: e instanceof Error ? e.message : String(e) })
    })
    ctx.effect(() => () => { void httpNode?.close() })
  }

  // ── 投递（接收侧）──
  /** 宿主兼容探针的最近一次结果（`cluster_status` 显示用）；`null` = 还没探过。 */
  let hostCompat: HostCompat | null = null
  let hostCompatTraced = ''

  /** 现算宿主兼容（不给会话样本就现取）。探测**不抛**——它跑在投递链路里，抛异常会杀宿主。 */
  const compatNow = (sessionsIn?: readonly unknown[]): HostCompat => {
    let sessions = sessionsIn
    if (sessions === undefined) {
      try {
        sessions = ctx.sessions.list()
      } catch (e) {
        trace('sessions-unavailable', { error: String(e) })
        sessions = []
      }
    }
    return probeHostCompat(sessions, { env: process.env, services: probeServices(ctx) })
  }

  /**
   * 记录宿主兼容状态：**只在有话可说时落轨迹**，且同一描述只落一次。
   * `no-sessions-yet` 不落——那是**时机**不是故障，为它告警会造成告警疲劳（真降级就没人看了）。
   */
  const noteCompat = (sessions: readonly unknown[]): void => {
    try {
      const c = compatNow(sessions)
      hostCompat = c
      if (c.sampled === 0) return
      const line = describeCompat(c)
      if (line === hostCompatTraced) return
      hostCompatTraced = line
      trace(c.verdict === 'supported' ? 'host-compat' : 'host-' + c.verdict, {
        verdict: c.verdict, sessionEvents: c.sessionEvents, sampled: c.sampled,
        blind: c.blindSessions, fellBack: c.fellBackSessions,
        version: c.version, versionSource: c.versionSource, reasons: c.reasons,
      })
      if (c.verdict !== 'supported') logger.warn('宿主兼容性降级：' + line)
    } catch (e) {
      trace('host-compat-error', { error: String(e) })
    }
  }

  /**
   * 上一次会话探测是否**失败**（而非「探测成功但结果为空」）。
   * ⚠ 这两者必须分开（对照 `miss.ts` 的模块注释）：把探测失败归入 structural，
   * 等于把**宿主代理异常**静默成「本节点永久无会话」——故障被美化成特性。
   */
  let sessionsProbeFailed = false

  const sessionLite = (): SessionLite[] => {
    try {
      const list = ctx.sessions.list()
      // 会话历史读取：探测实现**单源**在 `host-compat.ts`——判定与读取共用同一份，
      // 两处各写一份必然漂移（本插件已有「一份实现散在多处」的教训）。
      // ⚠ **别在这里写版本断言**：2026-09-22 此处曾写「0.1.2-rc.1 只有 events 属性」，
      // 那是未核实的假设且是错的（两个已知世代的会话读取面同形：都有 snapshotEvents()、
      // 都没有公开 events 属性）。凡形状断言要么标「推断」，要么当场取证。
      const reads = list.map((s) => readSessionEvents<SessionEventLite>(s))
      sessionsProbeFailed = false
      noteCompat(list)
      return list.map((s, i) => ({
        id: String(s.id),
        delegationDepth: Number(s.header?.delegationDepth ?? 0),
        events: reads[i]?.events ?? [],
      }))
    } catch (e) {
      // cordis 严格代理下 ctx.sessions 访问可能抛错（dsh-agent-plugin-manager 同款已知现象）；
      // 退化为「无候选会话」**并置探测失败位**——投递侧据此区分「没问到」与「没有」：
      // 前者按退避重试（可恢复），后者保留原位（结构性）。绝不让异常逃逸出定时器。
      sessionsProbeFailed = true
      trace('sessions-unavailable', { error: String(e) })
      return []
    }
  }

  const pendingFiles = (): string[] => listJsonFiles(inbox)

  /**
   * **可恢复失败**的统一出口：消耗重试 + 有界退避 + 落痕。
   * 分类的真源在 `miss.ts`（`classifyMiss`），这里只负责记账与留痕——所有 retryable
   * 分支都走这一条路，避免「同一语义在多处各写一份」（本插件已有的教训）。
   * @param reason - 未成功的原因（与 `MissReason` 同域）
   * @param id - 消息 id
   * @param nowMs - 当前时刻
   * @param extra - 附加落痕字段（sid / why / error 等）
   */
  const retryLater = (reason: MissReason, id: string, nowMs: number, extra: Record<string, unknown>): 'pending' => {
    state = noteFailure(state, id, nowMs)
    persist()
    trace('deliver-retry', { id, reason, note: describeMiss(reason), ...extra })
    return 'pending'
  }

  const deliverOne = (fileName: string, nowMs: number): 'delivered' | 'pending' | 'dead' | 'skip' => {
    const path = join(inbox, fileName)
    if (!isFile(path)) return 'skip'
    const raw = readJsonValue(path)
    if (!raw.ok) {
      state = { ...state, counters: { ...state.counters, readErrors: state.counters.readErrors + 1, dead: state.counters.dead + 1 }, updatedAt: nowMs }
      moveToBucket(inbox, fileName, 'dead', nonce())
      persist()
      trace('read-error', { file: fileName, error: raw.error })
      return 'dead'
    }
    const parsed = parseMessage(raw.value, { maxTextChars: config.maxTextChars })
    if (!parsed.ok) {
      state = { ...state, counters: { ...state.counters, corrupt: state.counters.corrupt + 1, dead: state.counters.dead + 1 }, updatedAt: nowMs }
      moveToBucket(inbox, fileName, 'dead', nonce())
      persist()
      trace('corrupt', { file: fileName, reason: parsed.reason, detail: parsed.detail })
      return 'dead'
    }
    const msg = parsed.message
    if (isHandled(state, msg.id)) {
      moveToBucket(inbox, fileName, 'done', nonce())
      trace('duplicate', { id: msg.id, file: fileName })
      return 'delivered'
    }
    if (isExpired(msg, nowMs)) {
      state = { ...state, counters: { ...state.counters, dead: state.counters.dead + 1 }, updatedAt: nowMs }
      markHandledInPlace(msg.id, nowMs)
      moveToBucket(inbox, fileName, 'dead', nonce())
      persist()
      trace('expired', { id: msg.id, ageMs: nowMs - msg.createdAt, ttlMs: msg.ttlMs })
      return 'dead'
    }
    if (attemptCount(state, msg.id) >= config.maxAttempts) {
      state = { ...state, counters: { ...state.counters, dead: state.counters.dead + 1 }, updatedAt: nowMs }
      moveToBucket(inbox, fileName, 'dead', nonce())
      persist()
      trace('exhausted', { id: msg.id, attempts: attemptCount(state, msg.id) })
      return 'dead'
    }
    if (!readyToRetry(state, msg.id, nowMs)) return 'pending'
    if (!config.autoInject) {
      // 落痕只做一次：与下方的 no-session 分支同一条纪律，同一个 `holdNoted` 簿记。
      // 这条分支同样每轮轮询都会走到——每轮都落会把 trace 刷满同一个 id，
      // 并让 `cluster_status` 的「最近」列表失去分辨力（2026-09-27 实测同 id 相隔 2007ms 连落三行）。
      // 两个分支天然互斥：此处 return 后走不到 no-session 分支，共用标记无干扰。
      if (!isHoldNoted(state, msg.id)) {
        state = markHoldNoted(state, msg.id, nowMs)
        persist()
        trace('held', { id: msg.id, why: 'autoInject=false，留给 cluster_inbox 取用' })
      }
      return 'pending'
    }
    const decisionT = decideTarget(sessionLite(), config.mainSessionId !== '' ? config.mainSessionId : undefined, {})
    if (decisionT.sid === undefined) {
      // ⚠ 未成功的原因**必须分清**：「没问到」（探测失败）与「问到了，答案是没有」（无顶层会话）
      // 是两回事——把前者归入结构性，等于把宿主代理异常静默成「本节点永久无会话」。
      const reason: MissReason = sessionsProbeFailed ? 'sessions-unavailable' : 'no-target'
      if (classifyMiss(reason) === 'structural') {
        // 结构性不可注入：**不消耗重试**。重试不会让会话长出来，而判死会把消息移进 `dead/`
        // —— 那正是 headless 适配器（直接读 mailbox 的消费者，对照 `scripts/ref-node.mjs`）
        // 读不到它的原因：本该能工作的执行节点，被插件判死而结构性收不到活。
        // 兜底是 TTL（`isExpired`）⇒ 不会无限堆积。
        // 落痕只做一次：每轮都落会刷屏（2026-09-26 实测 48 条 no-target 只对应 3 条消息）。
        if (!isHoldNoted(state, msg.id)) {
          state = markHoldNoted(state, msg.id, nowMs)
          persist()
          trace('hold-no-session', {
            id: msg.id, from: msg.from, kind: msg.kind, why: decisionT.why,
            ttlAtMs: msg.createdAt + msg.ttlMs, note: describeMiss(reason),
          })
        }
        return 'pending'
      }
      return retryLater(reason, msg.id, nowMs, { why: decisionT.why })
    }
    // 代理访问同样可能抛错：退化为 undefined → 走 no-agent 分支退避重试（不外抛）
    const agent = ((): ReturnType<typeof ctx.agents.get> => {
      try {
        return ctx.agents.get(decisionT.sid as never)
      } catch (e) {
        trace('agents-get-error', { id: msg.id, sid: decisionT.sid, error: String(e) })
        return undefined
      }
    })()
    if (agent === undefined) {
      return retryLater('no-agent', msg.id, nowMs, { sid: decisionT.sid })
    }
    try {
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: injectionText(msg) }],
        source: { kind: 'dsh-agent-cluster' },
      }))
    } catch (e) {
      return retryLater('inject-error', msg.id, nowMs, { sid: decisionT.sid, error: String(e) })
    }
    markHandledInPlace(msg.id, nowMs)
    state.counters.delivered += 1
    state.lastDeliveredAtMs = nowMs
    persist()
    const moved = moveToBucket(inbox, fileName, 'done', nonce())
    trace('delivered', { id: msg.id, from: msg.from, kind: msg.kind, sid: decisionT.sid, why: decisionT.why, chars: msg.text.length, archived: moved.ok })
    return 'delivered'
  }

  const markHandledInPlace = (id: string, nowMs: number): void => {
    state = markHandled(state, id, nowMs)
  }

  /**
   * 兜底：**定时器回调内任何逃逸异常都会杀死宿主进程**（插件与宿主同进程）。
   * 2026-09-14 实测事故：投递途中 `ctx.sessions.list()`（cordis 严格代理）抛错 →
   * 异常从 `setInterval` 逃逸 → web 退出 code=1（消息到达 1 秒后进程消失，而轨迹里连
   * 该消息的一条记录都没有——崩溃发生在第一次 trace 之前）。
   * 因此：单条消息投递、整轮轮询、心跳回调**各自**包一层；异常只落痕，绝不外抛。
   */
  const guarded = (where: string, fn: () => void): void => {
    try {
      fn()
    } catch (e) {
      trace('guarded-error', { where, error: String(e) })
    }
  }

  const safeDeliver = (fileName: string, nowMs: number): 'delivered' | 'pending' | 'dead' | 'skip' => {
    try {
      return deliverOne(fileName, nowMs)
    } catch (e) {
      const idFromFile = fileName.replace(/\.json$/, '')
      state = noteFailure(state, idFromFile, nowMs)
      persist()
      trace('deliver-error', { file: fileName, error: String(e) })
      return 'pending'
    }
  }

  const pollOnce = (): { scanned: number; delivered: number } => {
    const now = Date.now()
    let delivered = 0
    const files = pendingFiles()
    for (const f of files) {
      if (safeDeliver(f, now) === 'delivered') delivered += 1
    }
    state = { ...state, lastPollAtMs: now, updatedAt: now }
    persist()
    return { scanned: files.length, delivered }
  }

  // 启动自检：不等首个 tick（积压消息立即可投）
  if (dirs.ok) {
    guarded('startup-poll', () => {
      const r = pollOnce()
      trace('startup-poll', { scanned: r.scanned, delivered: r.delivered })
    })
  }

  // ── 定时器（fiber 拥有，可清理）──
  const heartbeatTimer = setInterval(() => { guarded('heartbeat', beat) }, Math.max(1000, config.heartbeatMs))
  const pollTimer = setInterval(() => { guarded('poll', () => { pollOnce() }) }, Math.max(500, config.pollIntervalMs))
  ctx.effect(() => () => {
    clearInterval(heartbeatTimer)
    clearInterval(pollTimer)
    // 卸载即下线：删掉自己的心跳（名册立刻反映），并留一行轨迹
    removeIfExists(heartbeatFile)
    trace('unload', {})
  }, 'agent-cluster.timers()')

  // ── 主脑（leader）──
  // 判据与选举在 `src/leader.ts`（纯函数 + 24 条单测）；本段只做 IO 与工具面。
  // 租约布局 `state/primary-lease-<epoch>.json`——**按 epoch 分文件**，让 `publishNoClobber`
  // 的 no-clobber 语义天然表达「同一 epoch 只许一个赢家」（`docs/design.md` §15.1 第 2 条）。
  // 读侧取最大 epoch；坏文件跳过（选举不因坏文件停摆）。

  /** 读总线上的最新主脑租约。 */
  const readLeaderLease = (): LeaderLease | null => {
    let best: LeaderLease | null = null
    for (const f of listJsonFiles(paths.stateDir)) {
      if (!f.startsWith('primary-lease-')) continue
      const raw = readJsonValue(join(paths.stateDir, f))
      if (!raw.ok) continue
      const parsed = parseLease(raw.value)
      if (parsed === null) continue
      if (best === null || parsed.epoch > best.epoch) best = parsed
    }
    return best
  }

  /**
   * 从名册构造选举候选。
   * ⚠ 心跳目前**不带** kind / trust / leaderEligible ⇒ 缺声明一律按 `unknown` / `known` / 可参选。
   * 即「手表端不合格」这类判据要生效，得先让心跳带上端类型声明（见 `docs/design.md` §15.1.1 已知边界）。
   */
  const leaderCandidates = (nowMs: number): LeaderCandidate[] => {
    const out: LeaderCandidate[] = []
    for (const f of listJsonFiles(paths.nodesDir)) {
      const raw = readJsonValue(join(paths.nodesDir, f))
      if (!raw.ok) continue
      const hb = raw.value as Record<string, unknown>
      const atMs = typeof hb['atMs'] === 'number' ? (hb['atMs'] as number) : 0
      const ageMs = nowMs - atMs
      out.push({
        nodeId: typeof hb['nodeId'] === 'string' ? (hb['nodeId'] as string) : f.replace(/\.json$/, ''),
        ageMs,
        online: ageMs <= config.offlineAfterMs,
        kind: normalizeKind(hb['kind']),
        trust: typeof hb['trust'] === 'string' ? (hb['trust'] as string) : 'known',
        leaderEligible: hb['leaderEligible'] !== false,
        // 缺省（老版本节点不写这个字段）= **不具备**——能力要自报，不靠猜。
        leaderCapable: hb['leaderCapable'] === true,
      })
    }
    return out
  }

  /**
   * 主脑动作的**唯一落盘路径**——工具面与自动续租共用它，不许两条路各写一次租约
   * （同一纪律见本插件的「各路径共用装配器」判据：一个职责一个写者）。
   *
   * `take` 与 `renew` 的写盘语义**不同**，这是本函数存在的第二个理由：
   * - **take** = 新建任期 ⇒ 用 `publishNoClobber`（原子 `link()`）表达「同一 epoch 只许一个赢家」；
   * - **renew** = **同一个 epoch 换新的 `atMs`** ⇒ 必须**覆盖**。若续租也用 no-clobber，它会因文件已存在
   *   而恒失败——租约到期、主脑消失。**no-clobber 只对抢占成立**，这一点不能混。
   *
   * @param nowMs - 本次裁决的时刻。
   * @returns 结果说明 + 是否真的写了总线（供调用方决定要不要记轨迹）。
   */
  const applyLeaderDecision = (nowMs: number): { note: string; wrote: boolean } => {
    const lease = readLeaderLease()
    const decision = decideLeader({
      self: nodeId, candidates: leaderCandidates(nowMs), lease, nowMs, ttlMs: config.leaderLeaseTtlMs,
    })
    if (decision.action === 'take') {
      const dest = join(paths.stateDir, 'primary-lease-' + decision.epoch + '.json')
      const r = publishNoClobber(
        dest, grantLease(nodeId, decision.epoch, nowMs, config.leaderLeaseTtlMs),
        'lease-' + decision.epoch + '-' + nodeId,
      )
      if (r.ok && !r.duplicate) {
        appendTrace(paths.traceFile, { at: nowMs, phase: 'leader-take', nodeId, epoch: decision.epoch })
        return { note: '已抢占 epoch ' + decision.epoch + ' → ' + dest, wrote: true }
      }
      return {
        note: '抢占失败（' + (r.duplicate ? '同一 epoch 已被别人创建' : String(r.error)) + '）——本轮不重试',
        wrote: false,
      }
    }
    if (decision.action === 'renew') {
      const dest = join(paths.stateDir, 'primary-lease-' + decision.epoch + '.json')
      const r = atomicWriteJson(
        dest, grantLease(nodeId, decision.epoch, nowMs, config.leaderLeaseTtlMs), nonce(),
      )
      if (r.ok) {
        appendTrace(paths.traceFile, { at: nowMs, phase: 'leader-renew', nodeId, epoch: decision.epoch })
        return {
          note: '已续租 epoch ' + decision.epoch + '（TTL ' + String(Math.round(config.leaderLeaseTtlMs / 1000)) + 's）',
          wrote: true,
        }
      }
      return { note: '续租失败（' + String(r.error) + '）', wrote: false }
    }
    return { note: '未抢占（action=' + decision.action + '）——不写总线', wrote: false }
  }

  ctx.tools.register(defineTool({
    name: 'cluster_leader',
    description: '主脑（leader）：查看当前主脑与各候选资格，或以本节点身份抢占租约。主脑**可迁移**——租约（TTL 缺省 90s）过期后任何合格节点都能接管，epoch 单调递增防脑裂；看到更高 epoch 的节点自降为 worker。无主时点对点通信照常（主脑只提供协调，不是单点依赖）。',
    parameters: {
      action: { type: 'string', description: 'status=只读查看（缺省）；claim=以本节点身份抢占租约' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          line: { type: 'string', required: true },
          action: { type: 'string', required: true },
          leaderId: { type: 'string' },
          epoch: { type: 'number', required: true },
          self: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          eligible: { type: 'boolean', required: true },
          eligibility: { type: 'string', required: true },
          candidates: { type: 'number', required: true },
          online: { type: 'number', required: true },
          claimed: { type: 'boolean' },
          claimNote: { type: 'string' },
        },
      },
      render: (_a: unknown, v: Record<string, unknown>) => {
        const head = '本节点 ' + String(v['self']) + '（端 ' + String(v['kind']) + '）资格：' + String(v['eligibility'])
        const roster = '候选 ' + String(v['candidates']) + ' 个（在线 ' + String(v['online']) + '）'
        const claim = String(v['claimNote'] ?? '')
        return [{ type: 'text', text: head + '\n' + String(v['line']) + '\n' + roster + (claim !== '' ? '\n' + claim : '') }]
      },
    },
    async execute(args: { action?: string }) {
      const nowMs = Date.now()
      const lease = readLeaderLease()
      const candidates = leaderCandidates(nowMs)
      const decision = decideLeader({ self: nodeId, candidates, lease, nowMs, ttlMs: config.leaderLeaseTtlMs })
      const selfCandidate = candidates.find((c) => c.nodeId === nodeId)
      const eligibility = selfCandidate === undefined ? '不在总线名册（心跳尚未写出）' : canLead(selfCandidate).why
      const base = {
        ok: true,
        line: describeLeader(decision, nowMs, lease),
        action: decision.action,
        ...(decision.leaderId === null ? {} : { leaderId: decision.leaderId }),
        epoch: decision.epoch,
        self: nodeId,
        kind: normalizeKind(config.nodeKind),
        eligible: selfCandidate !== undefined && canLead(selfCandidate).ok,
        eligibility,
        candidates: candidates.length,
        online: candidates.filter((c) => c.online).length,
      }
      if ((args.action ?? 'status') !== 'claim') return base
      const applied = applyLeaderDecision(nowMs)
      return { ...base, claimed: applied.wrote, claimNote: applied.note }
    },
  }))

  // ── 自动续租（**显式配置才开**，与「加网络层要显式配置」同一纪律）──
  //
  // 不自动续租时，主脑只是**一次性任期**：TTL（缺省 90s）一过租约就失效，需再次 `claim`
  // ⇒ 那不算「网络有主脑」，只算「主脑闪现过」。设计 §15.1 本就写了「TTL 90s / 每 30s 续租」。
  // 定时器由 fiber 拥有并可清理（§5.24：回调一律 guarded，绝不让异常逃逸出定时器）。
  /** 一次自动续租尝试（逻辑与工具面共用 `applyLeaderDecision`，不另写一条写租约的路）。 */
  const leaderTick = (): void => {
    const r = applyLeaderDecision(Date.now())
    if (r.wrote) trace('leader-auto', { note: r.note })
  }
  // ⚠ 形状有讲究：守卫契约测试**按行**断言 `setInterval(() => { guarded(`——回调体必须**恰好是一次 guarded 调用**，
  // 不能把 guarded 埋进多行或三元表达式里（2026-09-23 实测被该契约抓过一次：契约是对的，改的是我的代码）。
  const leaderTimer = config.leaderAutoRenew
    ? setInterval(() => { guarded('leader-auto', leaderTick) }, Math.max(5_000, renewIntervalMs(config.leaderLeaseTtlMs)))
    : null
  if (leaderTimer !== null) {
    ctx.effect(() => () => { clearInterval(leaderTimer) })
    logger.info('主脑自动续租已启用（每 %ds 一次，TTL %ds）',
      Math.round(Math.max(5_000, renewIntervalMs(config.leaderLeaseTtlMs)) / 1000),
      Math.round(config.leaderLeaseTtlMs / 1000))
  }

  // ── 工具面 ──
  ctx.tools.register(defineTool({
    name: 'cluster_status',
    description: '本节点在 DSH 集群中的身份与总线健康：nodeId/角色/总线目录/在线邻居数/收发计数/待投递数/最近轨迹。集群内消息异常（发不出、收不到）时先调它。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          nodeId: { type: 'string', required: true },
          role: { type: 'string' },
          profile: { type: 'string' },
          pid: { type: 'number' },
          busDir: { type: 'string', required: true },
          onlineNeighbors: { type: 'number', required: true },
          totalNodes: { type: 'number', required: true },
          pending: { type: 'number', required: true },
          delivered: { type: 'number', required: true },
          failed: { type: 'number', required: true },
          dead: { type: 'number', required: true },
          corrupt: { type: 'number', required: true },
          sent: { type: 'number', required: true },
          lastPollAgeMs: { type: 'number' },
          lastDeliveredAgeMs: { type: 'number' },
          recent: { type: 'array', items: { type: 'string' } },
          // 宿主兼容（§5.10）：本插件是「可安装」产物，装到别人家是什么情况必须一眼看得到。
          host: {
            type: 'object',
            // ⚠ 值 schema 的**嵌套对象必须显式声明 additionalProperties**（缺了 tsc 直接报
            // `Property 'additionalProperties' is missing ... but required in type 'ObjectValueSchemaSpec'`）。
            additionalProperties: false,
            properties: {
              verdict: { type: 'string' },
              sessionEvents: { type: 'string' },
              sampled: { type: 'number' },
              blindSessions: { type: 'number' },
              fellBackSessions: { type: 'number' },
              version: { type: 'string' },
              versionSource: { type: 'string' },
              supported: { type: 'array', items: { type: 'string' } },
              reasons: { type: 'array', items: { type: 'string' } },
            },
          },
          hostLine: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: Record<string, unknown>) => {
        const id = String(v['nodeId'])
        const role = v['role'] === '' || v['role'] === undefined ? '' : ' (' + String(v['role']) + ')'
        const bus = String(v['busDir'])
        const counts = '发 ' + String(v['sent']) + ' · 收 ' + String(v['delivered']) + ' · 待投 ' + String(v['pending']) + ' · 失败 ' + String(v['failed']) + ' · 死信 ' + String(v['dead'])
        const recent = Array.isArray(v['recent']) ? (v['recent'] as string[]).map((x) => '  · ' + x).join('\n') : ''
        const host = String(v['hostLine'] ?? '')
        return [{ type: 'text', text: '本节点 ' + id + role + '  在线邻居 ' + String(v['onlineNeighbors']) + '/' + String(v['totalNodes']) + '\n总线 ' + bus + (host !== '' ? '\n' + host : '') + '\n' + counts + (String(v['error'] ?? '') !== '' ? '\n异常：' + String(v['error']) : '') + (recent !== '' ? '\n最近：\n' + recent : '') }]
      },
    },
    async execute() {
      const now = Date.now()
      const all = roster(true)
      const recent = tailTrace(paths.traceFile, 6).map((e) => String(e['phase'] ?? '?') + ' ' + String(e['node'] ?? '?') + (typeof e['id'] === 'string' ? ' ' + e['id'] : '')).reverse()
      // 现算而非读缓存：这条工具要回答的是「**此刻**这台宿主什么情况」——读缓存会让
      // 「刚装进去」与「跑了一小时」显示同一结果（读数必须自带时间域）。
      const compat = compatNow()
      return {
        ok: true,
        nodeId,
        role: config.role,
        profile,
        pid: facts.pid,
        busDir: busRoot,
        onlineNeighbors: all.filter((r) => r.online && !r.self).length,
        totalNodes: all.length,
        pending: pendingFiles().length,
        delivered: state.counters.delivered,
        failed: state.counters.failed,
        dead: state.counters.dead,
        corrupt: state.counters.corrupt,
        sent: state.counters.sent,
        recent: recent.length > 0 ? recent : ['（尚无轨迹）'],
        host: {
          verdict: compat.verdict,
          sessionEvents: compat.sessionEvents,
          sampled: compat.sampled,
          blindSessions: compat.blindSessions,
          fellBackSessions: compat.fellBackSessions,
          version: compat.version,
          versionSource: compat.versionSource,
          supported: compat.hosts.map((h) => h.dsh + '（' + h.tested + '）'),
          reasons: compat.reasons,
        },
        hostLine: describeCompat(compat),
        // 可选键一律条件展开：DSH 的 output 校验要求 lossless JSON，**undefined 值会被拒**
        // （2026-09-14 线上实测：`cluster_status` 返回 undefined 字段 → "value is not lossless JSON"）
        ...(state.lastPollAtMs > 0 ? { lastPollAgeMs: now - state.lastPollAtMs } : {}),
        ...(state.lastDeliveredAtMs > 0 ? { lastDeliveredAgeMs: now - state.lastDeliveredAtMs } : {}),
        ...(identityError !== '' ? { error: identityError } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cluster_nodes',
    description: '列出集群名册：每个 DSH 实例的 nodeId / 角色 / profile / 地址 / 在线判定 / 最后心跳。发消息前用它确认目标 id；要了解某个实例的能力与状态，倾向直接给它发消息问（cluster_send）。',
    parameters: {
      includeOffline: { type: 'boolean', description: '是否包含已离线节点（默认 true；false 只看在线）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          total: { type: 'number', required: true },
          online: { type: 'number', required: true },
          selfNodeId: { type: 'string', required: true },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                nodeId: { type: 'string', required: true },
                role: { type: 'string' },
                profile: { type: 'string' },
                workspace: { type: 'string' },
                baseUrl: { type: 'string' },
                pid: { type: 'number' },
                tags: { type: 'array', items: { type: 'string' } },
                online: { type: 'boolean', required: true },
                ageText: { type: 'string' },
                self: { type: 'boolean', required: true },
                corrupt: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_a: unknown, v: Record<string, unknown>) => {
        const nodes = Array.isArray(v['nodes']) ? (v['nodes'] as Array<Record<string, unknown>>) : []
        if (nodes.length === 0) return [{ type: 'text', text: '名册为空（总线目录 ' + String(v['selfNodeId']) + ' 所在位置没有其他节点心跳）' }]
        const lines = nodes.map((n) => {
          const mark = n['self'] === true ? '←本节点' : (n['online'] === true ? '在线' : '离线')
          const role = n['role'] === '' || n['role'] === undefined ? '' : ' [' + String(n['role']) + ']'
          const age = n['ageText'] === undefined ? '' : ' · 心跳 ' + String(n['ageText']) + ' 前'
          const corrupt = n['corrupt'] === true ? ' · 心跳损坏' : ''
          return '- ' + String(n['nodeId']) + role + ' · ' + mark + age + corrupt
        })
        return [{ type: 'text', text: '集群名册（' + String(v['online']) + ' 在线 / 共 ' + String(v['total']) + '）\n' + lines.join('\n') }]
      },
    },
    async execute(args: { includeOffline?: boolean }) {
      const all = roster(args.includeOffline !== false)
      return {
        ok: true,
        total: all.length,
        online: all.filter((r) => r.online).length,
        selfNodeId: nodeId,
        nodes: all.map((r) => ({
          nodeId: r.nodeId,
          role: r.role,
          profile: r.profile,
          workspace: r.workspace,
          baseUrl: r.baseUrl,
          pid: r.pid,
          tags: r.tags,
          online: r.online,
          ageText: Number.isFinite(r.ageMs) ? ageText(r.ageMs) : '无时间戳',
          self: r.self,
          corrupt: r.corrupt,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cluster_send',
    description: '给集群中的另一个 DSH 实例发一条消息（写入它的收件箱；对方轮询到后会把消息注入自己的会话）。kind 语义：chat=对话/task=派活/result=回结果/event=事件/alert=告警。目标必须已在名册（先用 cluster_nodes 确认）。离线节点也可投递，消息等它上线后送达。',
    parameters: {
      to: { type: 'string', description: '目标节点 id（来自 cluster_nodes）', required: true },
      text: { type: 'string', description: '消息正文（默认上限 8000 字符）', required: true },
      kind: { type: 'string', description: '消息类别：chat|task|result|event|alert（默认 chat）', enum: MESSAGE_KINDS },
      replyTo: { type: 'string', description: '所回复消息的 id（可选）' },
      ttlMs: { type: 'number', description: '存活期 ms，过期不再投递（默认 86400000，0=永不过期）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string' },
          to: { type: 'string' },
          online: { type: 'boolean' },
          duplicate: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: Record<string, unknown>) => [{
        type: 'text',
        text: v['ok'] === true
          ? '已投递 ' + String(v['id']) + ' → ' + String(v['to']) + (v['online'] === true ? '（对方在线，将在一个轮询周期内收到）' : '（对方当前离线，消息已在收件箱等待）')
          : '发送失败：' + String(v['error'] ?? '未知'),
      }],
    },
    async execute(args: { to: string; text: string; kind?: string; replyTo?: string; ttlMs?: number }) {
      if (args.text.length > config.maxTextChars) {
        return { ok: false, to: args.to, error: '正文 ' + String(args.text.length) + ' 字符超过上限 ' + String(config.maxTextChars) }
      }
      const r = sendTo(args.to, args.text, (args.kind ?? 'chat') as MessageKind, args.ttlMs, args.replyTo)
      if (!r.ok) return { ok: false, to: args.to, error: r.error }
      const target = roster(true).find((x) => x.nodeId === args.to)
      return { ok: true, id: r.id, to: args.to, online: target?.online ?? false, duplicate: r.duplicate }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cluster_broadcast',
    description: '给集群中除自己以外的所有实例广播一条消息（逐目标写入各自收件箱）。用于通知、协同信号、全局广播。离线节点默认也投递（等它上线）。',
    parameters: {
      text: { type: 'string', description: '消息正文', required: true },
      kind: { type: 'string', description: '消息类别：chat|task|result|event|alert（默认 event）', enum: MESSAGE_KINDS },
      includeOffline: { type: 'boolean', description: '是否也投给离线节点（默认 true）' },
      ttlMs: { type: 'number', description: '存活期 ms（默认 86400000，0=永不过期）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sent: { type: 'number', required: true },
          skipped: { type: 'number', required: true },
          targets: { type: 'array', items: { type: 'string' } },
          errors: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_a: unknown, v: Record<string, unknown>) => {
        const t = Array.isArray(v['targets']) ? (v['targets'] as string[]) : []
        const errs = Array.isArray(v['errors']) ? (v['errors'] as string[]) : []
        return [{ type: 'text', text: t.length === 0 ? '广播无接收者（名册里没有其他节点）' : '已广播给 ' + String(v['sent']) + ' 个节点：' + t.join(', ') + (Number(v['skipped']) > 0 ? '（跳过离线 ' + String(v['skipped']) + '）' : '') + (errs.length > 0 ? '\n失败：' + errs.join('；') : '') }]
      },
    },
    async execute(args: { text: string; kind?: string; includeOffline?: boolean; ttlMs?: number }) {
      if (args.text.length > config.maxTextChars) {
        return { ok: false, sent: 0, skipped: 0, targets: [], errors: ['正文超上限 ' + String(config.maxTextChars)] }
      }
      const all = roster(true).filter((r) => !r.self)
      const targets: string[] = []
      const errors: string[] = []
      let skipped = 0
      for (const r of all) {
        if (!r.online && args.includeOffline === false) { skipped += 1; continue }
        const res = sendTo(r.nodeId, args.text, (args.kind ?? 'event') as MessageKind, args.ttlMs, undefined)
        if (res.ok) targets.push(r.nodeId)
        else errors.push(r.nodeId + ': ' + String(res.error))
      }
      state = { ...state, counters: { ...state.counters, broadcast: state.counters.broadcast + 1 }, updatedAt: Date.now() }
      persist()
      trace('broadcast', { targets: targets.length, skipped, errors: errors.length })
      return { ok: errors.length === 0, sent: targets.length, skipped, targets, errors }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cluster_inbox',
    description: '查看本实例的收件箱：待投递（pending）、已投递归档（done）、死信（dead）与已归档消息。心跳/总线正常但怀疑漏消息时用它核对。回执不是自动的——回消息用 cluster_send（可带 replyTo）。',
    parameters: {
      limit: { type: 'number', description: '返回条数上限（默认 20）' },
      peer: { type: 'string', description: '只看来自某节点的消息' },
      state: { type: 'string', description: '只看某类：pending|done|dead|all（默认 all）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          pending: { type: 'number', required: true },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                from: { type: 'string', required: true },
                kind: { type: 'string' },
                state: { type: 'string', required: true },
                ageText: { type: 'string' },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_a: unknown, v: Record<string, unknown>) => {
        const items = Array.isArray(v['items']) ? (v['items'] as Array<Record<string, unknown>>) : []
        if (items.length === 0) return [{ type: 'text', text: '收件箱为空（待投递 ' + String(v['pending']) + '）' }]
        const lines = items.map((i) => '- [' + String(i['state']) + '] ' + String(i['from']) + '/' + String(i['kind'] ?? 'chat') + ' · ' + String(i['ageText'] ?? '') + '\n  ' + String(i['text']))
        return [{ type: 'text', text: '收件箱（待投递 ' + String(v['pending']) + '，列出 ' + String(items.length) + ' 条）\n' + lines.join('\n') }]
      },
    },
    async execute(args: { limit?: number; peer?: string; state?: string }) {
      const limit = Math.max(1, Math.min(200, args.limit ?? 20))
      const want = args.state ?? 'all'
      const items: Array<{ id: string; from: string; kind: string; state: string; ageText: string; text: string }> = []
      const now = Date.now()
      const push = (file: string, dir: string, st: string): void => {
        if (items.length >= limit) return
        const raw = readJsonValue(join(dir, file))
        if (!raw.ok) {
          items.push({ id: file.replace(/\.json$/, ''), from: '?', kind: '?', state: st + '(损坏)', ageText: '?', text: raw.error.slice(0, 200) })
          return
        }
        const parsed = parseMessage(raw.value, { maxTextChars: config.maxTextChars })
        if (!parsed.ok) {
          items.push({ id: file.replace(/\.json$/, ''), from: '?', kind: '?', state: st + '(' + parsed.reason + ')', ageText: '?', text: parsed.detail.slice(0, 200) })
          return
        }
        const m = parsed.message
        if (args.peer !== undefined && m.from !== args.peer) return
        items.push({
          id: m.id,
          from: m.from,
          kind: m.kind,
          state: st,
          ageText: ageText(Math.max(0, now - m.createdAt)),
          text: m.text.length > 300 ? m.text.slice(0, 300) + '…' : m.text,
        })
      }
      if (want === 'all' || want === 'pending') for (const f of listJsonFiles(inbox)) push(f, inbox, 'pending')
      if (want === 'all' || want === 'done') for (const f of listJsonFiles(join(inbox, 'done'))) push(f, join(inbox, 'done'), 'done')
      if (want === 'all' || want === 'dead') for (const f of listJsonFiles(join(inbox, 'dead'))) push(f, join(inbox, 'dead'), 'dead')
      return { ok: true, pending: pendingFiles().length, items: items.slice(0, limit) }
    },
  }))

  // ---------- cluster_members（成员册：身份与信任，`docs/members.md` §3/§4）----------
  ctx.tools.register(defineTool({
    name: 'cluster_members',
    description: '列出网络成员册（身份与信任）：memberId / kind / trust / 能力 / 端点 / 协议，以及跨机承载状态。**trust=unknown 一律不投也不收**——不要靠「自称」当成员。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          members: { type: 'json', required: true },
          skipped: { type: 'json', required: true },
          transport: { type: 'json', required: true },
        },
      },
      render: (_a: unknown, v: Record<string, unknown>) => {
        const members = Array.isArray(v['members']) ? (v['members'] as Array<Record<string, unknown>>) : []
        const tr = (v['transport'] ?? {}) as Record<string, unknown>
        const head = '成员册 ' + String(members.length) + ' 位｜跨机承载：监听 ' + (tr['listening'] === true ? String(tr['listenPort']) : '关闭') + '｜入站 ' + (tr['allowInbound'] === true ? '开' : '关') + '｜密钥 ' + (tr['secretConfigured'] === true ? '已配' : '未配')
        if (members.length === 0) {
          const skipped = Array.isArray(v['skipped']) ? (v['skipped'] as string[]) : []
          return [{ type: 'text', text: head + '\n（空册——把成员记录写进 <busDir>/members/<memberId>.json 即入册；trust 只认 own/known）' + (skipped.length > 0 ? '\n跳过 ' + String(skipped.length) + ' 个坏记录：' + skipped.join('、') : '') }]
        }
        const lines = members.map((m) => {
          const caps = Array.isArray(m['capabilities']) ? (m['capabilities'] as string[]) : []
          return '- [' + String(m['trust']) + '/' + String(m['kind']) + '] ' + String(m['memberId']) +
            (m['endpoint'] === undefined ? '' : ' @ ' + String(m['endpoint'])) +
            (caps.length > 0 ? '\n  能力：' + caps.join('、') : '')
        })
        return [{ type: 'text', text: head + '\n' + lines.join('\n') }]
      },
    },
    async execute() {
      const inv = readMembersFromDisk(memberDir, parseMemberRecord)
      // 显式构造（而不是 JSON round-trip）+ 具体类型：schema 的 `type: 'json'` 需要 JsonValue，
      // `unknown` 过不了；显式字段也让「投影出去的是哪几个字段」一眼可见（§5.30 显式先于隐式）。
      const members = inv.members.map((m) => ({
        memberId: m.memberId,
        kind: m.kind,
        trust: m.trust,
        capabilities: [...m.capabilities],
        ...(m.endpoint !== undefined ? { endpoint: m.endpoint } : {}),
        ...(m.protocol !== undefined ? { protocol: m.protocol } : {}),
        ...(m.notes !== undefined ? { notes: m.notes } : {}),
      }))
      return {
        members,
        skipped: [...inv.skipped],
        transport: {
          listenPort: config.listenPort,
          allowInbound: config.allowInbound,
          listening: httpNode !== undefined,
          secretConfigured: config.secret !== '',
        },
      }
    },
  }))

  // ---------- cluster_peer（跨机投递，`docs/members.md` §5.3）----------
  ctx.tools.register(defineTool({
    name: 'cluster_peer',
    description: '把一条消息推给**跨机成员**（按其成员册里的 endpoint + HMAC 认证）。同机成员请用 cluster_send。要求已配 secret，且 endpoint 为 https 或本机回环（明文 http 到非回环一律拒发）。',
    parameters: {
      to: { type: 'string', required: true, description: '成员 id（见 cluster_members）' },
      text: { type: 'string', required: true, description: '消息正文' },
      kind: { type: 'string', enum: ['chat', 'task', 'result', 'event', 'alert'], description: '消息类别（缺省 chat）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          to: { type: 'string', required: true },
          id: { type: 'string', required: true },
          status: { type: 'number', required: true },
        },
      },
      render: (_a: unknown, v: Record<string, unknown>) => [{ type: 'text', text: '已跨机投递 → ' + String(v['to']) + '（' + String(v['id']) + '，HTTP ' + String(v['status']) + '）' }],
    },
    async execute(args: { to: string; text: string; kind?: string }) {
      const members = readMembersFromDisk(memberDir, parseMemberRecord).members
      const m = members.find((x) => x.memberId === args.to)
      if (m === undefined) throw new Error('成员册里没有 ' + args.to + '（先用 cluster_members 看册子）')
      if (m.trust === 'unknown') throw new Error('成员 ' + args.to + ' 的信任级是 unknown——先确认身份再投递（fail-closed）')
      if (m.endpoint === undefined || m.endpoint === '') throw new Error('成员 ' + args.to + ' 没登记 endpoint')
      if (config.secret === '') throw new Error('未配置跨机密钥（config.secret 为空）——拒绝以无签名形态发送')
      const kinds = ['chat', 'task', 'result', 'event', 'alert']
      const kind = (args.kind !== undefined && kinds.includes(args.kind) ? args.kind : 'chat') as MessageKind
      const msg = makeMessage({ from: nodeId, to: args.to, text: args.text, kind }, Date.now(), randomBytes(4).toString('hex'))
      // 密钥选择：该成员有**专属**密钥（邀请令牌下发）就用它，否则回退网络共享密钥（§5.11）。
      const r = await pushToPeer({ url: m.endpoint, secret: m.secret ?? config.secret, body: JSON.stringify(msg), fromMemberId: nodeId })
      trace('peer-push', { to: args.to, id: msg.id, ok: r.ok, status: r.status, reason: r.reason ?? null })
      if (!r.ok) throw new Error('跨机投递失败（HTTP ' + String(r.status) + '）：' + (r.reason ?? 'unknown'))
      return { ok: true, to: args.to, id: msg.id, status: r.status }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cluster_invite',
    description: '签发一张「入网令牌」给某个智能体——它一步就能接入本网络（**不需要知道我的总线目录**）。令牌里带网络名、我的入站地址、该成员**专属**密钥与到期时间。签发即准入（同时写进成员册）。⚠ 令牌是凭据：只该经可信渠道交给对方，不要公开发。',
    parameters: {
      member: { type: 'string', required: true, description: '被邀请者的成员 id（一张令牌只准入这一个 id）；传 * = **开放令牌**：谁拿到谁能进、身份由入网方自报' },
      ttlMinutes: { type: 'number', description: '有效期（分钟，缺省 1440 = 24 小时）' },
      url: { type: 'string', description: '我的入站基址覆盖（缺省 http://127.0.0.1:<listenPort>）；跨机邀请必须填对方能访问到的地址' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          member: { type: 'string', required: true },
          token: { type: 'string', required: true },
          joinUrl: { type: 'string', required: true },
          expiresAt: { type: 'string', required: true },
          inviteLine: { type: 'string', required: true },
          warning: { type: 'string' },
        },
      },
      render: (_a: unknown, v: Record<string, unknown>) => [{ type: 'text', text: '入网令牌（发给 ' + String(v['member']) + ' · 到期 ' + String(v['expiresAt']) + '）：\n' + String(v['token']) + '\n' + String(v['inviteLine']) + '\n对方把令牌交给它的实例后执行 cluster_join 即入网。' + (String(v['warning'] ?? '') !== '' ? '\n⚠ ' + String(v['warning']) : '') }],
    },
    async execute(args: { member: string; ttlMinutes?: number; url?: string }) {
      return joins.mintInviteFor(args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cluster_join',
    description: '用一张入网令牌接入一个智能体网络：解析 → 校验（令牌是否授予**本节点**）→ 把入网请求推到令牌里的地址 → 双方互相入册。成功后本节点与主脑即可互相投递（cluster_peer）。',
    parameters: {
      token: { type: 'string', required: true, description: '对方给的入网令牌（形态 dshc1.<载荷>.<指纹>）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          net: { type: 'string', required: true },
          host: { type: 'string', required: true },
          member: { type: 'string', required: true },
        },
      },
      render: (_a: unknown, v: Record<string, unknown>) => [{ type: 'text', text: '已入网：成员 ' + String(v['member']) + ' → 网络 ' + String(v['net']) + '（主脑 ' + String(v['host']) + '）\n双方已互相入册，可互相投递。' }],
    },
    async execute(args: { token: string }) {
      return joins.joinNetwork(args.token)
    },
  }))

  logger.info('agent-cluster 启动：nodeId=' + nodeId + ' bus=' + busRoot + ' autoInject=' + String(config.autoInject))
}

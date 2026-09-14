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
  appendTrace, atomicWriteJson, busPaths, ensureBusDirs, inboxDir, isFile, listJsonFiles,
  moveToBucket, nodeFile, publishNoClobber, readJsonValue, removeIfExists,
  stateFile, tailTrace, takeOverInbox, type BusPaths,
} from './bus.ts'
import {
  ageText, deriveNodeId, nodeOnline, parseHeartbeat, resolveCollision, sanitizeId, type Heartbeat,
} from './identity.ts'
import {
  DEFAULT_MAX_TEXT_CHARS, injectionText, isExpired, makeMessage, parseMessage, MESSAGE_KINDS,
  type MessageKind,
} from './protocol.ts'
import {
  attemptCount, defaultState, isHandled, loadState, markHandled, noteFailure, readyToRetry,
  serializeState, type NodeState,
} from './state.ts'
import { decideTarget, type SessionLite } from './target.ts'

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
function readHeartbeat(paths: BusPaths, id: string): { pid?: number; atMs?: number } | undefined {
  const raw = readJsonValue(nodeFile(paths, id))
  if (!raw.ok) return undefined
  const parsed = parseHeartbeat(raw.value)
  if (!parsed.ok) return undefined
  return { pid: parsed.hb.pid, atMs: parsed.hb.atMs }
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
  trace('startup', { requestedId, nodeId, renamed: decision.renamed, why: decision.why, busRoot, dirsOk: dirs.ok })
  if (identityError !== '') logger.error('总线目录异常：' + identityError)

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

  // ── 投递（接收侧）──
  const sessionLite = (): SessionLite[] => {
    try {
      return ctx.sessions.list().map((s) => ({
        id: String(s.id),
        delegationDepth: Number(s.header?.delegationDepth ?? 0),
        // `Session.events` 在会话尚未装载时可能为 undefined（2026-09-14 线上实测：
        // 直接读 `.length` → TypeError，且该异常当时从定时器逃逸、杀死宿主 web 进程）。归一为空数组。
        events: Array.isArray(s.events) ? (s.events as unknown as SessionLite['events']) : [],
      }))
    } catch (e) {
      // cordis 严格代理下 ctx.sessions 访问可能抛错（dsh-agent-plugin-manager 同款已知现象）；
      // 退化为「无候选会话」→ 投递走 no-target 分支退避重试——绝不让异常逃逸出定时器。
      trace('sessions-unavailable', { error: String(e) })
      return []
    }
  }

  const pendingFiles = (): string[] => listJsonFiles(inbox)

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
      trace('held', { id: msg.id, why: 'autoInject=false，留给 cluster_inbox 取用' })
      return 'pending'
    }
    const decisionT = decideTarget(sessionLite(), config.mainSessionId !== '' ? config.mainSessionId : undefined, {})
    if (decisionT.sid === undefined) {
      state = noteFailure(state, msg.id, nowMs)
      persist()
      trace('no-target', { id: msg.id, why: decisionT.why })
      return 'pending'
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
      state = noteFailure(state, msg.id, nowMs)
      persist()
      trace('no-agent', { id: msg.id, sid: decisionT.sid })
      return 'pending'
    }
    try {
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: injectionText(msg) }],
        source: { kind: 'plugin', plugin: 'dsh-agent-cluster' },
      }))
    } catch (e) {
      state = noteFailure(state, msg.id, nowMs)
      persist()
      trace('inject-error', { id: msg.id, sid: decisionT.sid, error: String(e) })
      return 'pending'
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
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: Record<string, unknown>) => {
        const id = String(v['nodeId'])
        const role = v['role'] === '' || v['role'] === undefined ? '' : ' (' + String(v['role']) + ')'
        const bus = String(v['busDir'])
        const counts = '发 ' + String(v['sent']) + ' · 收 ' + String(v['delivered']) + ' · 待投 ' + String(v['pending']) + ' · 失败 ' + String(v['failed']) + ' · 死信 ' + String(v['dead'])
        const recent = Array.isArray(v['recent']) ? (v['recent'] as string[]).map((x) => '  · ' + x).join('\n') : ''
        return [{ type: 'text', text: '本节点 ' + id + role + '  在线邻居 ' + String(v['onlineNeighbors']) + '/' + String(v['totalNodes']) + '\n总线 ' + bus + '\n' + counts + (String(v['error'] ?? '') !== '' ? '\n异常：' + String(v['error']) : '') + (recent !== '' ? '\n最近：\n' + recent : '') }]
      },
    },
    async execute() {
      const now = Date.now()
      const all = roster(true)
      const recent = tailTrace(paths.traceFile, 6).map((e) => String(e['phase'] ?? '?') + ' ' + String(e['node'] ?? '?') + (typeof e['id'] === 'string' ? ' ' + e['id'] : '')).reverse()
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

  logger.info('agent-cluster 启动：nodeId=' + nodeId + ' bus=' + busRoot + ' autoInject=' + String(config.autoInject))
}

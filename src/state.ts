/**
 * state.ts — 本节点状态：幂等集合、重试账、计数（纯逻辑 + 纯序列化，IO 由调用方做）。
 *
 * 不变量 I3（幂等）：同一 messageId 至多注入一次——靠 `handled` 滚动集合。
 * 不变量 I2 的重试账：`attempts[id]` 记尝试次数与下次可试时刻（有界退避，防止紧转轮）。
 * 状态文件损坏时**回落到默认状态**并报 `recovered`（不崩、不静默：调用方落痕）。
 */

/** 单条消息的重试账。 */
export interface AttemptRecord {
  n: number
  nextAtMs: number
}

/** 本节点持久化状态。 */
export interface NodeState {
  v: 1
  nodeId: string
  /** 已投递/已归档的消息 id（滚动上限 HANDLED_CAP）。 */
  handled: string[]
  /** 未投递成功消息的重试账（id → 记录）。 */
  attempts: Record<string, AttemptRecord>
  counters: {
    sent: number
    broadcast: number
    delivered: number
    failed: number
    dead: number
    corrupt: number
    readErrors: number
  }
  lastPollAtMs: number
  lastDeliveredAtMs: number
  updatedAt: number
}

/** `handled` 滚动上限（防状态文件无限增长）。 */
export const HANDLED_CAP = 500
/** 重试退避上限（ms）：连续失败时最长等这么久再试。 */
export const MAX_BACKOFF_MS = 30_000

/** 默认状态。 */
export function defaultState(nodeId: string, nowMs: number): NodeState {
  return {
    v: 1,
    nodeId,
    handled: [],
    attempts: {},
    counters: { sent: 0, broadcast: 0, delivered: 0, failed: 0, dead: 0, corrupt: 0, readErrors: 0 },
    lastPollAtMs: 0,
    lastDeliveredAtMs: 0,
    updatedAt: nowMs,
  }
}

/** 解析结果：状态 + 是否恢复过（坏数据回落）。 */
export interface LoadedState {
  state: NodeState
  recovered: boolean
  why: string
}

/**
 * 从任意值恢复状态（**纯函数**，接 JSON.parse 后的未知值）。
 * @param raw - 未知值（来自状态文件）
 * @param nodeId - 本节点 id（状态归属不符则重建——防串号）
 * @param nowMs - 当前时刻
 */
export function loadState(raw: unknown, nodeId: string, nowMs: number): LoadedState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: defaultState(nodeId, nowMs), recovered: true, why: '状态文件非对象' }
  }
  const o = raw as Record<string, unknown>
  if (o['v'] !== 1) {
    return { state: defaultState(nodeId, nowMs), recovered: true, why: '状态版本不识别 v=' + String(o['v']) }
  }
  if (o['nodeId'] !== nodeId) {
    return { state: defaultState(nodeId, nowMs), recovered: true, why: '状态归属不符（' + String(o['nodeId']) + '≠' + nodeId + '）' }
  }
  const handled = Array.isArray(o['handled']) ? o['handled'].filter((x): x is string => typeof x === 'string').slice(-HANDLED_CAP) : []
  const attempts: Record<string, AttemptRecord> = {}
  const rawAttempts = o['attempts']
  if (rawAttempts !== null && typeof rawAttempts === 'object' && !Array.isArray(rawAttempts)) {
    for (const [k, v] of Object.entries(rawAttempts as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object') continue
      const r = v as Record<string, unknown>
      if (typeof r['n'] !== 'number' || typeof r['nextAtMs'] !== 'number') continue
      attempts[k] = { n: r['n'], nextAtMs: r['nextAtMs'] }
    }
  }
  const rawCounters = (o['counters'] !== null && typeof o['counters'] === 'object' && !Array.isArray(o['counters']))
    ? (o['counters'] as Record<string, unknown>)
    : {}
  const num = (key: string): number => (typeof rawCounters[key] === 'number' && Number.isFinite(rawCounters[key]) ? (rawCounters[key] as number) : 0)
  const state: NodeState = {
    v: 1,
    nodeId,
    handled,
    attempts,
    counters: {
      sent: num('sent'),
      broadcast: num('broadcast'),
      delivered: num('delivered'),
      failed: num('failed'),
      dead: num('dead'),
      corrupt: num('corrupt'),
      readErrors: num('readErrors'),
    },
    lastPollAtMs: typeof o['lastPollAtMs'] === 'number' ? (o['lastPollAtMs'] as number) : 0,
    lastDeliveredAtMs: typeof o['lastDeliveredAtMs'] === 'number' ? (o['lastDeliveredAtMs'] as number) : 0,
    updatedAt: nowMs,
  }
  return { state, recovered: false, why: 'ok' }
}

/** 序列化状态（纯函数：IO 由调用方负责）。 */
export function serializeState(state: NodeState): string {
  return JSON.stringify(state, null, 2)
}

/** 是否已处理过该消息 id（幂等判据）。 */
export function isHandled(state: NodeState, id: string): boolean {
  return state.handled.includes(id)
}

/** 记录已处理（滚动裁剪，返回新状态——保持函数式，便于测）。 */
export function markHandled(state: NodeState, id: string, nowMs: number): NodeState {
  const handled = state.handled.filter((x) => x !== id)
  handled.push(id)
  return {
    ...state,
    handled: handled.slice(-HANDLED_CAP),
    attempts: omit(state.attempts, id),
    updatedAt: nowMs,
  }
}

/** 记一次失败尝试：次数 +1，下次可试时刻按指数退避（有界）。 */
export function noteFailure(state: NodeState, id: string, nowMs: number): NodeState {
  const prev = state.attempts[id]
  const n = (prev?.n ?? 0) + 1
  const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(n - 1, 5))
  return {
    ...state,
    attempts: { ...state.attempts, [id]: { n, nextAtMs: nowMs + backoff } },
    counters: { ...state.counters, failed: state.counters.failed + 1 },
    updatedAt: nowMs,
  }
}

/** 该消息当前是否到重试时刻（无记录 = 可试）。 */
export function readyToRetry(state: NodeState, id: string, nowMs: number): boolean {
  const rec = state.attempts[id]
  if (rec === undefined) return true
  return nowMs >= rec.nextAtMs
}

/** 该消息已尝试次数。 */
export function attemptCount(state: NodeState, id: string): number {
  return state.attempts[id]?.n ?? 0
}

function omit(rec: Record<string, AttemptRecord>, key: string): Record<string, AttemptRecord> {
  if (rec[key] === undefined) return rec
  const next: Record<string, AttemptRecord> = {}
  for (const [k, v] of Object.entries(rec)) if (k !== key) next[k] = v
  return next
}

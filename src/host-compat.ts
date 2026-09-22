/**
 * Host compatibility probing — capability first, version second.
 *
 * This plugin ships as an *installable* artifact: the target host's DSH release is
 * chosen by whoever installs it, not by us (the upstream `dsh-tavern` pins
 * `0.1.2-rc.1` while this machine runs `0.1.6-alpha.2`). `inject` guarantees a
 * service *exists*, but says nothing about the API shape *on* it — `Session.events`
 * was removed in 0.1.6, `snapshotEvents()` exists only there.
 *
 * Contract (see docs/semantic.md §5.10): every probe is side-effect free and
 * **never throws**. A missing capability degrades to "no candidate session",
 * never to an escaping exception — an exception escaping a timer callback kills
 * the host web process (docs/semantic.md §9, 2026-09-14).
 */

/** Which member supplied the session history. */
export type SessionEventsPath = 'snapshotEvents' | 'events-property' | 'none'

/** Where the host version string came from; `unknown` is a normal result. */
export type VersionSource = 'env' | 'unknown'

/** Aggregate judgement. */
export type HostVerdict = 'supported' | 'degraded' | 'unsupported'

/** A declared-supported host, with the strength of that claim spelled out. */
export interface SupportedHost {
  dsh: string
  /** `实测` = verified on that host; `推断` = inferred from its API surface alone. */
  tested: '实测' | '推断'
  note: string
}

/**
 * Declared support range. **This is a declaration, not a guarantee** — an entry
 * marked `推断` has not been exercised on that host, so it must not be read as
 * "supported".
 */
export const SUPPORTED_HOSTS: readonly SupportedHost[] = [
  { dsh: '0.1.6-alpha.2', tested: '实测', note: '本机主力宿主：`events` 属性已移除，走 `snapshotEvents()`' },
  { dsh: '0.1.2-rc.1', tested: '推断', note: '上游 dsh-tavern 锁定版本：无 `snapshotEvents`，走 `events` 属性。⚠ 尚未装进该宿主实测（§10 U13）' },
]

export interface CallablePick<F> {
  name: string
  fn: F
}

export interface SessionEventsRead<T> {
  events: T[]
  via: SessionEventsPath
  /** `snapshotEvents` existed but threw / returned a non-array, so we fell back. */
  fellBack: boolean
}

export interface ServicePresence {
  tools: boolean
  sessions: boolean
  agents: boolean
}

export interface HostCompat {
  verdict: HostVerdict
  /** How many sessions were inspected. `0` means "no verdict yet", not a fault. */
  sampled: number
  /** History-read path observed while sampling. */
  sessionEvents: SessionEventsPath | 'no-sessions-yet'
  /** Sampled sessions where *neither* path worked. */
  blindSessions: number
  /** `snapshotEvents` existed but threw on at least one sampled session. */
  fellBackSessions: number
  services: ServicePresence
  version: string
  versionSource: VersionSource
  /** Human-readable reasons, honest about which claims are unverified. */
  reasons: string[]
  hosts: readonly SupportedHost[]
}

/** Guarded property read: a throwing getter degrades to `undefined`, never throws. */
function guardedGet(obj: unknown, key: string): unknown {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined
  try {
    return (obj as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/** First *callable* member among `names`, in order; `undefined` if none. Never throws. */
export function pickCallable<F>(obj: unknown, names: readonly string[]): CallablePick<F> | undefined {
  for (const name of names) {
    const value = guardedGet(obj, name)
    if (typeof value === 'function') return { name, fn: value as F }
  }
  return undefined
}

/**
 * Read a session's event history across host generations.
 *
 * Order is deliberate: `snapshotEvents()` first (0.1.6+, where the property is
 * gone), then the `events` property (0.1.2-rc.1, where the method is absent).
 * Anything unexpected — a throw, a non-array — falls through to the next path and
 * is reported in `via` / `fellBack` rather than thrown.
 */
export function readSessionEvents<T = unknown>(session: unknown): SessionEventsRead<T> {
  let fellBack = false
  const method = pickCallable<() => unknown>(session, ['snapshotEvents'])
  if (method !== undefined) {
    try {
      const raw = method.fn.call(session)
      if (Array.isArray(raw)) return { events: raw as T[], via: 'snapshotEvents', fellBack: false }
      fellBack = true
    } catch {
      // 会话未装载 / 契约变更 ⇒ 回退，绝不外抛
      fellBack = true
    }
  }
  const direct = guardedGet(session, 'events')
  if (Array.isArray(direct)) return { events: direct as T[], via: 'events-property', fellBack }
  return { events: [], via: 'none', fellBack }
}

/**
 * Resolve required services through `ctx.get` rather than trusting `inject`.
 *
 * `inject` is an activation gate, so an active plugin implies these services
 * exist — this probe is therefore a **self-check**: `false` here means we are
 * looking at an anomalous host, not that the plugin failed to declare something.
 */
export function probeServices(ctx: unknown): ServicePresence {
  const getter = pickCallable<(name: string) => unknown>(ctx, ['get'])
  const has = (name: string): boolean => {
    if (getter === undefined) return false
    try {
      return getter.fn.call(ctx, name) !== undefined
    } catch {
      return false
    }
  }
  return { tools: has('tools'), sessions: has('sessions'), agents: has('agents') }
}

/**
 * Best-effort host version.
 *
 * There is currently **no verified** version source, so `version: ''` is the
 * normal answer and no judgement depends on it.
 *
 * ⚠ Never consult `npm_package_version`: when the host runs from an npm script
 * that variable holds *this plugin's* version, so it would report a confident
 * wrong number (AGENTS.md §5.9 rule 6 — a reading without its domain label lies).
 */
export function readVersion(env: Record<string, string | undefined> = {}): { version: string; source: VersionSource } {
  const raw = env['DSH_VERSION']
  if (typeof raw === 'string' && raw.trim() !== '') return { version: raw.trim(), source: 'env' }
  return { version: '', source: 'unknown' }
}

export interface ProbeOptions {
  env?: Record<string, string | undefined>
  services?: ServicePresence
}

/** Aggregate a host-compatibility verdict from sampled sessions. Pure; never throws. */
export function probeHostCompat(sessions: readonly unknown[], options: ProbeOptions = {}): HostCompat {
  const reasons: string[] = []
  let sampled = 0
  let blind = 0
  let fellBack = 0
  let via: SessionEventsPath | undefined
  let sawSnapshot = false
  let sawProperty = false

  for (const session of sessions) {
    if (session === null || (typeof session !== 'object' && typeof session !== 'function')) continue
    sampled += 1
    const read = readSessionEvents(session)
    if (read.fellBack) fellBack += 1
    if (read.via === 'none') blind += 1
    if (read.via === 'snapshotEvents') sawSnapshot = true
    if (read.via === 'events-property') sawProperty = true
    if (via === undefined && read.via !== 'none') via = read.via
  }

  const sessionEvents: HostCompat['sessionEvents'] = sampled === 0 ? 'no-sessions-yet' : (via ?? 'none')
  const services: ServicePresence = options.services ?? { tools: false, sessions: false, agents: false }

  let verdict: HostVerdict = 'supported'
  const missing = (['tools', 'sessions', 'agents'] as const).filter((k) => !services[k])
  if (missing.length > 0) {
    verdict = 'unsupported'
    reasons.push('必需服务面自证缺失：' + missing.join('/') + ' —— 正常路径下不该出现（`inject` 会先拦住不激活）')
  } else if (sampled === 0) {
    verdict = 'degraded'
    reasons.push('尚无会话可采样（时机问题，不是故障）——首次投递后重探')
  } else if (blind === sampled) {
    verdict = 'degraded'
    reasons.push('全部 ' + String(sampled) + ' 个会话的会话历史读取路径都不可用——投递目标裁决会退化为「无最近活跃」（不报错、只变笨）')
  } else if (blind > 0) {
    reasons.push('部分会话（' + String(blind) + '/' + String(sampled) + '）读不到历史')
  }

  if (sawSnapshot) reasons.push('走 snapshotEvents()（上游已标 deprecated）——现在可用，长久方向是改读投影')
  if (sawProperty) reasons.push('走 events 属性（0.1.6 前的路径）——该属性在上游 0.1.6 已移除')
  if (fellBack > 0) reasons.push(String(fellBack) + ' 个会话的 snapshotEvents 抛错/非数组，已回退')

  const { version, source } = readVersion(options.env)
  if (version === '') reasons.push('宿主版本未取得（无已实证的版本源）——判定不依赖它')

  return {
    verdict,
    sampled,
    sessionEvents,
    blindSessions: blind,
    fellBackSessions: fellBack,
    services,
    version,
    versionSource: source,
    reasons,
    hosts: SUPPORTED_HOSTS,
  }
}

/** One-line human summary for traces and the tool face. */
export function describeCompat(c: HostCompat): string {
  const v = c.version !== '' ? c.version : '未取得'
  const base = '宿主 ' + c.verdict + ' · 会话读取 ' + c.sessionEvents + ' · 版本 ' + v
  return c.reasons.length > 0 ? base + '（' + c.reasons.join('；') + '）' : base
}

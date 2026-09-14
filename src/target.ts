/**
 * target.ts — 投递目标裁决（纯逻辑，可离线用真实样本测）。
 *
 * 规则来源是**两次真实事故**，不是设计偏好：
 *   ① 2026-09-03 telegram 错投旧会话：按「最后任意事件时间」选目标 → 插件自己注入的消息让旧会话
 *      变「新」→ 下次又选它（自我强化循环）。**因此只认 `source.kind === 'user'` 的真实用户消息。**
 *   ② 2026-09-12 哨兵两次漏投：把「存在」当「活跃」、没排除子代理会话。
 *      **因此排除 `delegationDepth > 0`（子代理会话不可被人对话，也不该收集群消息）。**
 *
 * 与 dsh-agent-sentinel 的 wake-target.ts 同源规则、**独立实现**（禁止跨插件 import）：
 * 哨兵那份面向 `session/list` RPC 的条目，这份面向进程内 `ctx.sessions.list()` 的 Session 对象。
 */

/** 会话事件的最小投影（只读需要的字段）。 */
export interface SessionEventLite {
  type?: string
  time?: number
  data?: { source?: { kind?: string } }
}

/** 会话的最小投影。 */
export interface SessionLite {
  id: string
  /** 0 = 顶层会话；>0 = 子代理/分身派生会话。 */
  delegationDepth: number
  events: readonly SessionEventLite[]
}

/** 显式锚点新鲜度阈值：落后最近活跃超过它就认为锚点腐化（ms）。 */
export const DEFAULT_ANCHOR_STALE_MS = 10 * 60_000

/** 目标裁决结果。 */
export interface TargetDecision {
  sid: string | undefined
  why: string
  ranked: string[]
}

/** 是否「用户会话」（可被人对话、可收集群消息）：顶层派生深度。 */
export function isUserSession(s: SessionLite): boolean {
  return s.delegationDepth === 0
}

/**
 * 该会话最后一次**真实用户**输入的时刻（无则 0）。
 * 只认 `user/message` 且 `data.source.kind === 'user'`——插件注入（含本插件自己）不参与，
 * 否则会形成「谁被注入谁变新」的自我强化循环（2026-09-03 事故）。
 * @param s - 会话投影
 */
export function lastRealUserPromptAt(s: SessionLite): number {
  // 纵深防御：`events` 可能不是数组（会话未装载时为 undefined —— 2026-09-14 线上实测的
  // TypeError 根因，该异常曾经从定时器逃逸、杀死宿主 web 进程）。投影层已归一，这里再兜一层。
  const events: readonly SessionEventLite[] = Array.isArray(s.events) ? s.events : []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]
    if (ev === undefined) continue
    if (ev.type !== 'user/message') continue
    if (ev.data?.source?.kind !== 'user') continue
    const t = typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : 0
    return t
  }
  return 0
}

/**
 * 裁决投递目标会话。
 * @param sessions - 本进程全部会话
 * @param explicitId - 配置钉死的锚点会话（可空）
 * @param opts - 锚点新鲜度阈值
 * @returns 目标会话 id、裁决理由、候选排序（失败可换人）
 */
export function decideTarget(
  sessions: readonly SessionLite[],
  explicitId: string | undefined,
  opts: { anchorStaleMs?: number } = {},
): TargetDecision {
  const staleMs = opts.anchorStaleMs ?? DEFAULT_ANCHOR_STALE_MS
  const ranked = sessions
    .filter(isUserSession)
    .map((s) => ({ id: s.id, at: lastRealUserPromptAt(s) }))
    .sort((a, b) => b.at - a.at)
  const rankedIds = ranked.map((r) => r.id)
  if (ranked.length === 0) {
    return {
      sid: undefined,
      why: '共 ' + String(sessions.length) + ' 个会话，但无顶层（用户）会话——不投递',
      ranked: rankedIds,
    }
  }
  const newest = ranked[0]!
  const hasExplicit = explicitId !== undefined && explicitId !== ''
  if (!hasExplicit) {
    return {
      sid: newest.id,
      why: '未指定锚点 → 投最近有真实用户输入的顶层会话（' + (newest.at > 0 ? '有' : '无') + '真实输入记录）',
      ranked: rankedIds,
    }
  }
  const anchor = ranked.find((r) => r.id === explicitId)
  if (anchor === undefined) {
    const knownOther = sessions.some((s) => s.id === explicitId)
    return {
      sid: newest.id,
      why: knownOther
        ? '锚点 ' + String(explicitId) + ' 是派生（子代理）会话 → 改投最近顶层会话 ' + newest.id
        : '锚点 ' + String(explicitId) + ' 不在本进程会话列表 → 改投最近顶层会话 ' + newest.id,
      ranked: rankedIds,
    }
  }
  if (newest.id !== anchor.id && newest.at - anchor.at > staleMs) {
    return {
      sid: newest.id,
      why: '锚点 ' + String(explicitId) + ' 已滞后 ' + Math.round((newest.at - anchor.at) / 60000)
        + 'min（>阈值 ' + Math.round(staleMs / 60000) + 'min，锚点腐化）→ 改投 ' + newest.id,
      ranked: rankedIds,
    }
  }
  return { sid: String(explicitId), why: '锚点 ' + String(explicitId) + ' 新鲜，尊重显式指定', ranked: rankedIds }
}

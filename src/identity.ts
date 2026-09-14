/**
 * identity.ts — 节点身份：派生、规范化、冲突裁决（纯逻辑，可离线测）。
 *
 * 不变量 I1（语义文档）：同一 nodeId 同一时刻只对应一个活跃进程。
 * 冲突处置是**改名 + 留痕**，绝不静默覆盖别人的心跳（否则名册会互相抹掉，
 * 且两个实例都以为自己叫这个名字）。
 */

/** 心跳文件内容（`nodes/<nodeId>.json`）。 */
export interface Heartbeat {
  v: 1
  nodeId: string
  role: string
  profile: string
  workspace: string
  baseUrl: string
  port: number
  pid: number
  hostname: string
  startedAt: number
  atMs: number
  tags: string[]
}

/** 心跳判活阈值默认值（ms）：3× 默认心跳周期。 */
export const DEFAULT_OFFLINE_AFTER_MS = 30_000

/** 从任意字符串规范化出可用作文件名/身份的片段。 */
export function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 64)
}

/**
 * 派生 nodeId：`<hostname>-<profile>-<port>`。
 * 同一组参数派生同一 id（可复现），不同端口/主机自然区分。
 * @param hostname - 主机名（Windows 工作域名可以很长，只取首段）
 * @param profile - DSH profile 名
 * @param port - 监听端口（0 表示非 web 实例）
 */
export function deriveNodeId(hostname: string, profile: string, port: number): string {
  const host = sanitizeId(String(hostname).split('.')[0] ?? '') || 'host'
  const prof = sanitizeId(profile) || 'default'
  return host + '-' + prof + '-' + String(port)
}

/** 冲突裁决结果。 */
export interface CollisionDecision {
  nodeId: string
  renamed: boolean
  why: string
}

/**
 * 同名心跳冲突裁决。
 *
 * 规则：
 *   - 无既有心跳 → 用请求的 id；
 *   - 既有心跳是本进程写的（pid 相同）→ 复用（重启内的重复写）；
 *   - 既有心跳已陈旧（`now - atMs > offlineAfterMs`）→ **接管**该 id（原主已离线）；
 *   - 既有心跳活跃且 pid 不同 → **改名**为 `<nodeId>-<suffix>`（suffix 建议为本进程 pid）。
 *
 * @param requested - 本进程请求的身份（nodeId 已规范化）
 * @param existing - 同名心跳（来自总线扫描），无则 undefined
 * @param nowMs - 当前时刻
 * @param offlineAfterMs - 判活阈值
 * @param suffix - 改名后缀（调用方传本进程 pid）
 * @returns 最终 nodeId + 是否改名 + 理由（理由写进轨迹，事故可回答「为什么叫这个名字」）
 */
export function resolveCollision(
  requested: { nodeId: string; pid: number },
  existing: { pid?: number; atMs?: number } | undefined,
  nowMs: number,
  offlineAfterMs: number,
  suffix: string,
): CollisionDecision {
  const id = requested.nodeId
  if (existing === undefined) {
    return { nodeId: id, renamed: false, why: '无同名心跳，直接使用' }
  }
  if (typeof existing.pid === 'number' && existing.pid === requested.pid) {
    return { nodeId: id, renamed: false, why: '同名心跳来自本进程（pid 相同），复用' }
  }
  const atMs = typeof existing.atMs === 'number' && Number.isFinite(existing.atMs) ? existing.atMs : 0
  const ageMs = atMs > 0 ? Math.max(0, nowMs - atMs) : Number.POSITIVE_INFINITY
  if (ageMs > offlineAfterMs) {
    return {
      nodeId: id,
      renamed: false,
      why: '同名心跳已陈旧（' + (Number.isFinite(ageMs) ? Math.round(ageMs / 1000) + 's' : '无时间戳') + ' 未更新）→ 接管该身份',
    }
  }
  const newId = sanitizeId(id + '-' + suffix)
  return {
    nodeId: newId,
    renamed: true,
    why: '同名心跳活跃（pid=' + String(existing.pid ?? '?') + '，' + Math.round(ageMs / 1000) + 's 前）→ 改名避让，原名主保留',
  }
}

/**
 * 节点是否在线：唯一判据（I4 判据单一真源，名册显示/发送警告/计数共用它）。
 * @param hb - 心跳（至少含 atMs）
 * @param nowMs - 当前时刻
 * @param offlineAfterMs - 判活阈值
 */
export function nodeOnline(hb: { atMs?: number }, nowMs: number, offlineAfterMs: number): boolean {
  const atMs = typeof hb.atMs === 'number' && Number.isFinite(hb.atMs) ? hb.atMs : 0
  if (atMs <= 0) return false
  return nowMs - atMs <= offlineAfterMs
}

/**
 * 人类可读的「距今」。
 * @param ms - 时间差（ms）
 */
export function ageText(ms: number): string {
  if (!Number.isFinite(ms)) return '未知'
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 90) return sec + 's'
  const min = Math.round(sec / 60)
  if (min < 90) return min + 'min'
  const hr = Math.round(min / 60)
  return hr < 48 ? hr + 'h' : Math.round(hr / 24) + 'd'
}

/** 心跳解析结果。 */
export type HeartbeatParse = { ok: true; hb: Heartbeat } | { ok: false; reason: string }

/**
 * 校验一个来自总线的心跳文件值（**不可信输入**：字段类型错/版本错/缺 id 一律分类拒绝）。
 * @param raw - JSON.parse 后的未知值
 */
export function parseHeartbeat(raw: unknown): HeartbeatParse {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not-object' }
  const o = raw as Record<string, unknown>
  if (o['v'] !== 1) return { ok: false, reason: 'bad-version' }
  const nodeId = o['nodeId']
  if (typeof nodeId !== 'string' || nodeId === '') return { ok: false, reason: 'missing-nodeId' }
  const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
  const num = (k: string): number => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : 0)
  const tags = Array.isArray(o['tags'])
    ? o['tags'].filter((x): x is string => typeof x === 'string').slice(0, 16)
    : []
  return {
    ok: true,
    hb: {
      v: 1,
      nodeId,
      role: str('role'),
      profile: str('profile'),
      workspace: str('workspace'),
      baseUrl: str('baseUrl'),
      port: num('port'),
      pid: num('pid'),
      hostname: str('hostname'),
      startedAt: num('startedAt'),
      atMs: num('atMs'),
      tags,
    },
  }
}

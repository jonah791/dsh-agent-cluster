/**
 * identity.ts — 节点身份：派生、规范化、冲突裁决（纯逻辑，可离线测）。
 *
 * 不变量 I1（语义文档）：同一 nodeId 同一时刻只对应一个活跃进程。
 * 冲突处置是**改名 + 留痕**，绝不静默覆盖别人的心跳（否则名册会互相抹掉，
 * 且两个实例都以为自己叫这个名字）。
 *
 * 2026-09-15（Round 3-b）增强：裁决不再只看「心跳新鲜度」，还看**心跳里那个 pid 是否还活着**——
 * 同名 + 同主机 + pid 已死 = 那是**我的前身**，不是别人 ⇒ **回收原名**，而不是改名避让。
 * 判活信息由调用方（IO 层）查得后**显式传入**；**未知一律按「活着」处理**（保守：宁可改名，不夺名）。
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
  /** 是否**回收**了同名 id（前身进程已死）——与 `renamed` 互斥。 */
  reclaimed: boolean
  why: string
}

/**
 * 同名心跳冲突裁决。
 *
 * 规则（自上而下，先命中者生效）：
 *   - 无既有心跳 → 用请求的 id；
 *   - 既有心跳是本进程写的（pid 相同）→ 复用（重启内的重复写）；
 *   - **同名 + 同主机 + 那个 pid 已死**（`liveness.pidAlive === false`）→ **回收原名**（前身已亡，
 *     收尸交给调用方；这就是「重启收自己的尸」的裁决侧）；
 *   - 既有心跳已陈旧（`now - atMs > offlineAfterMs`）→ **接管**该 id（原主已离线）；
 *   - 其余（含「判活未知」）→ **改名**为 `<nodeId>-<suffix>`（suffix 建议为本进程 pid）。
 *
 * @param requested - 本进程请求的身份（nodeId 已规范化）
 * @param existing - 同名心跳（来自总线扫描），无则 undefined
 * @param nowMs - 当前时刻
 * @param offlineAfterMs - 判活阈值
 * @param suffix - 改名后缀（调用方传本进程 pid）
 * @param liveness - 既有心跳的**进程判活事实**（调用方查得）；缺省 = 未知 ⇒ 按「活着」处理
 * @returns 最终 nodeId + 是否改名 + 是否回收 + 理由（理由写进轨迹，事故可回答「为什么叫这个名字」）
 */
export function resolveCollision(
  requested: { nodeId: string; pid: number },
  existing: { pid?: number; atMs?: number } | undefined,
  nowMs: number,
  offlineAfterMs: number,
  suffix: string,
  liveness?: { pidAlive: boolean; sameHost: boolean },
): CollisionDecision {
  const id = requested.nodeId
  if (existing === undefined) {
    return { nodeId: id, renamed: false, reclaimed: false, why: '无同名心跳，直接使用' }
  }
  if (typeof existing.pid === 'number' && existing.pid === requested.pid) {
    return { nodeId: id, renamed: false, reclaimed: false, why: '同名心跳来自本进程（pid 相同），复用' }
  }
  const atMs = typeof existing.atMs === 'number' && Number.isFinite(existing.atMs) ? existing.atMs : 0
  const ageMs = atMs > 0 ? Math.max(0, nowMs - atMs) : Number.POSITIVE_INFINITY
  // 前身判定：同主机（pid 只在主机内有意义）+ 心跳里的进程**确认已死** + 不是本进程
  if (
    liveness !== undefined &&
    liveness.sameHost === true &&
    liveness.pidAlive === false &&
    typeof existing.pid === 'number' &&
    existing.pid > 0
  ) {
    return {
      nodeId: id,
      renamed: false,
      reclaimed: true,
      why: '同名心跳的进程已不存在（pid=' + String(existing.pid) + '，心跳 ' + (Number.isFinite(ageMs) ? Math.round(ageMs / 1000) + 's' : '无时间戳') + ' 前）→ 回收原名，前身由本进程收尸',
    }
  }
  if (ageMs > offlineAfterMs) {
    return {
      nodeId: id,
      renamed: false,
      reclaimed: false,
      why: '同名心跳已陈旧（' + (Number.isFinite(ageMs) ? Math.round(ageMs / 1000) + 's' : '无时间戳') + ' 未更新）→ 接管该身份',
    }
  }
  const newId = sanitizeId(id + '-' + suffix)
  return {
    nodeId: newId,
    renamed: true,
    reclaimed: false,
    why: '同名心跳活跃（pid=' + String(existing.pid ?? '?') + '，' + Math.round(ageMs / 1000) + 's 前）→ 改名避让，原名主保留',
  }
}

/**
 * 「我的血统」判据：同主机 + 同 profile + id 落在 `<host>-<profile>` 前缀内。
 * 用途：只清扫**自己的前身**，不碰别人的节点（`wb-0`/`ref-0`/其它主机都由各自的所有者负责）。
 */
export function isOwnLineage(
  candidate: { nodeId?: string; hostname?: string; profile?: string },
  me: { hostname: string; profile: string },
): boolean {
  const prefix = me.hostname + '-' + me.profile
  return candidate.hostname === me.hostname
    && candidate.profile === me.profile
    && typeof candidate.nodeId === 'string'
    && candidate.nodeId.startsWith(prefix)
}

/**
 * 是否应当**回收（删除）**这份心跳：我的血统 + pid 确认已死 + pid 有效（>0）+ 不是我自己那份。
 * 保守优先：任何一条不满足就**保留**（宁可留垃圾，不可误删活节点）。
 */
export function shouldReap(
  hb: { nodeId?: string; hostname?: string; profile?: string; pid?: number },
  me: { nodeId: string; hostname: string; profile: string },
  context: { pidAlive: boolean },
): boolean {
  if (hb.nodeId === me.nodeId) return false
  if (context.pidAlive !== false) return false
  if (!(typeof hb.pid === 'number' && hb.pid > 0)) return false
  return isOwnLineage(hb, me)
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

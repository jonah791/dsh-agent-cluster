/**
 * transport.ts — 传输适配器层（把「文件」换成「可替换的承载」）。
 *
 * 设计正本：`docs/members.md` §5。为什么需要它：现有总线是**本地文件目录**，
 * 跨成员时对方的「本机」不是我的本机 ⇒ 文件在物理上到不了。
 * 而 `semantic.md` §6 当时明写「**不做网络：不发请求、不监听端口**」——
 * 所以本层是对该不变量的**有意修订**，纪律是：
 *
 *   1. **默认关闭**（`listenPort: 0` + 无 peers）⇒ 不配置时行为与加网络前**逐字节相同**；
 *   2. **fail-closed**：无密钥 / 错密钥 / 非成员 / 非回环明文 ⇒ **一律拒**，不猜不降级；
 *   3. **协议不变**：仍走 `protocol.ts` 的 envelope——**协议是资产，承载是可替换件**。
 *
 * 分层：签名/验签、成员信任、URL 策略是**纯函数**（可离线测）；只有监听与推送碰 IO。
 * @module dsh-agent-cluster/transport
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** 传输名（进轨迹与状态，便于回答「这条消息是怎么到的」）。 */
export type TransportKind = 'file' | 'http'

/** 成员信任级（`docs/members.md` §3）。`unknown` 是默认值，也是**一律拒收**的值。 */
export type MemberTrust = 'own' | 'known' | 'unknown'

/** 成员类型。`peer` = 异组织智能体（有自己的用户与生命周期，如上游 dsh-tavern）。 */
export type MemberKind = 'self' | 'peer' | 'adapter'

/** 签名时间戳的容忍窗口（ms）——挡住重放与严重时钟漂移。 */
export const DEFAULT_SIG_WINDOW_MS = 5 * 60 * 1000

/** 单条入站消息正文上限（字节）——与总线的正文上限同源纪律，防大包打爆内存。 */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024

/**
 * 签名载荷：`<ts>.<body>`。
 * 把时间戳**绑进**被签名的内容（而不是只放 header）——否则时间戳可被单独篡改而不破坏签名。
 */
export function signingPayload(timestampMs: number, body: string): string {
  return String(Math.floor(timestampMs)) + '.' + body
}

/** 计算 HMAC-SHA256 签名（hex）。`secret` 为空 ⇒ 抛错（不返回「无签名」的假结果）。 */
export function signBody(secret: string, body: string, timestampMs: number): string {
  if (secret === '') throw new Error('cluster 传输密钥为空——拒绝以「无签名」形态发送（fail-closed）')
  return createHmac('sha256', secret).update(signingPayload(timestampMs, body), 'utf8').digest('hex')
}

/** 验签失败的原因（诊断要能回答「为什么拒」，不是笼统 false）。 */
export type VerifyReason = 'ok' | 'no-secret' | 'no-signature' | 'bad-timestamp' | 'expired' | 'mismatch'

/**
 * 验签（**纯函数**，常量时间比较）。
 * @param input - `secret` / `body` / `timestampMs` / `signature` / `nowMs` / `windowMs`
 * @returns `{ok, reason}`——reason 供调用方落痕（§5.22 断在哪一段）
 */
export function verifySignature(input: {
  secret: string
  body: string
  timestampMs: number
  signature: string
  nowMs: number
  windowMs?: number
}): { ok: boolean; reason: VerifyReason } {
  const { secret, body, timestampMs, signature, nowMs } = input
  const windowMs = input.windowMs ?? DEFAULT_SIG_WINDOW_MS
  if (secret === '') return { ok: false, reason: 'no-secret' }
  if (signature === '') return { ok: false, reason: 'no-signature' }
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return { ok: false, reason: 'bad-timestamp' }
  if (Math.abs(nowMs - timestampMs) > windowMs) return { ok: false, reason: 'expired' }
  let expected: string
  try {
    expected = signBody(secret, body, timestampMs)
  } catch {
    return { ok: false, reason: 'no-secret' }
  }
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  // 长度不等时 timingSafeEqual 会抛错 ⇒ 先比长度（长度本身不是秘密）
  if (a.length !== b.length) return { ok: false, reason: 'mismatch' }
  return timingSafeEqual(a, b) ? { ok: true, reason: 'ok' } : { ok: false, reason: 'mismatch' }
}

/** 成员记录（`members/<memberId>.json` 的形状；语义见 `docs/members.md` §3）。 */
export interface MemberRecord {
  memberId: string
  kind: MemberKind
  trust: MemberTrust
  /** 声明式能力（**自称**，不等于被授权）。 */
  capabilities: string[]
  /** 支持的协议版本（用于协商）。 */
  protocol?: string
  /** 可达地址（跨机成员给 URL）。 */
  endpoint?: string
  notes?: string
}

/**
 * 解析成员记录（**输入一律不可信**，承 §6「输入不可信」纪律）。
 * 缺 `memberId` / `trust` 非法 ⇒ 返回 null（调用方跳过并落痕，不抛进主流程）。
 */
export function parseMemberRecord(raw: unknown): MemberRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.memberId !== 'string' || o.memberId === '') return null
  const trust = o.trust === 'own' || o.trust === 'known' ? o.trust : ('unknown' as MemberTrust)
  const kind = o.kind === 'self' ? 'self' : o.kind === 'adapter' ? 'adapter' : ('peer' as MemberKind)
  const capabilities = Array.isArray(o.capabilities)
    ? o.capabilities.filter((c): c is string => typeof c === 'string' && c !== '')
    : []
  const rec: MemberRecord = { memberId: o.memberId, kind, trust, capabilities }
  if (typeof o.protocol === 'string') rec.protocol = o.protocol
  if (typeof o.endpoint === 'string') rec.endpoint = o.endpoint
  if (typeof o.notes === 'string') rec.notes = o.notes
  return rec
}

/**
 * 该来源是否被允许投递（**成员册是唯一的准入真源**；`unknown` 一律拒）。
 * 语义正本 `docs/members.md` §4.1 L0：挡住「陌生 id 注入」。
 */
export function canAcceptFrom(members: readonly MemberRecord[], memberId: string): boolean {
  if (memberId === '') return false
  return members.some((m) => m.memberId === memberId && m.trust !== 'unknown')
}

/**
 * 出站地址策略：**只允许 https 或本机回环**。
 * 明文 http 到非回环地址 ⇒ 拒发——**不假装自己有 TLS**；要跨公网请走隧道（§5.25 G6 同款思路）。
 * @returns 允许则 null；否则给拒绝原因（进轨迹，便于回答「为什么没发出去」）
 */
export function peerUrlRejection(rawUrl: string): string | null {
  if (rawUrl === '') return 'empty-url'
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return 'not-a-url'
  }
  if (u.protocol === 'https:') return null
  if (u.protocol !== 'http:') return 'scheme-not-allowed'
  const host = u.hostname
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  return loopback ? null : 'plaintext-http-to-non-loopback'
}

/** 入站判定结果（503 = 未开启入站；401 = 验签失败；403 = 非成员；400 = 载荷不合法）。 */
export type InboundDecision =
  | { ok: true; memberId: string; body: string }
  | { ok: false; status: number; reason: string }

/**
 * 入站准入判定（**纯函数**：把「该不该收」与「怎么收」分开，IO 只负责搬字节）。
 * @param input - 请求头形状（已归一为小写键）+ 正文 + 成员册 + 密钥 + 是否允许入站
 */
export function decideInbound(input: {
  allowInbound: boolean
  memberId: string
  timestampMs: number
  signature: string
  body: string
  secret: string
  members: readonly MemberRecord[]
  nowMs: number
  windowMs?: number
}): InboundDecision {
  if (!input.allowInbound) return { ok: false, status: 503, reason: 'inbound-disabled' }
  if (input.memberId === '') return { ok: false, status: 403, reason: 'no-member-id' }
  const v = verifySignature({
    secret: input.secret,
    body: input.body,
    timestampMs: input.timestampMs,
    signature: input.signature,
    nowMs: input.nowMs,
    ...(input.windowMs !== undefined ? { windowMs: input.windowMs } : {}),
  })
  if (!v.ok) return { ok: false, status: 401, reason: 'signature-' + v.reason }
  // 认证（签名）与授权（成员册）是两件事：**先证明身份，再判是否被允许**（§5.9 规则 1 的语义精确性）
  if (!canAcceptFrom(input.members, input.memberId)) return { ok: false, status: 403, reason: 'not-a-member' }
  if (input.body === '') return { ok: false, status: 400, reason: 'empty-body' }
  return { ok: true, memberId: input.memberId, body: input.body }
}

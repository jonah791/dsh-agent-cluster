/**
 * Invite tokens — one string that carries everything needed to join a network.
 *
 * Why this module exists: the plugin's delivery form is "installable", so joining must be
 * a **one-step act for a stranger** — they paste a token, and their instance is enrolled.
 * That means the token has to carry all three of: where the network is, what credential to
 * use, and which member id has already been admitted.
 *
 * Design decisions worth stating out loud:
 *
 * 1. **The token carries a per-invitee secret, not the network-wide secret.** A shared
 *    network key inside a token would mean "one leaked token = the whole network's key".
 *    Each invite mints a fresh secret bound to exactly one member id.
 * 2. **The fingerprint only detects mangling, it is not authentication.** Whoever holds the
 *    token also holds the secret, so they could re-mint the fingerprint. Its job is to catch
 *    truncation / bad copy-paste before a confusing failure happens deeper in the stack.
 * 3. **One token admits exactly one member id** (`member`). Admission is decided by the
 *    inviter *before* the token is minted, so the joiner cannot choose who to become.
 * 4. **Never print the secret.** `describeInvite` redacts it — tokens travel through chats
 *    and logs, which is exactly where credentials die.
 *
 * Contract: parsing never throws and always explains **why** it failed.
 */
import { createHash, randomBytes } from 'node:crypto'

/** Token version tag. Bump when the payload shape changes incompatibly. */
export const INVITE_PREFIX = 'dshc1'

/** Default lifetime: a day is long enough to pass a token along, short enough to expire. */
export const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000

/** Fingerprint length in hex chars (64 bits) — enough for corruption, not a signature. */
const FP_CHARS = 16

export interface InvitePayload {
  v: 1
  /** Human-readable network name; doubles as a guard against joining the wrong network. */
  net: string
  /** Base URL of the inviter's inbound endpoint (where the join request is pushed). */
  url: string
  /** Inviter's member id. */
  host: string
  /** The **only** member id this token admits. */
  member: string
  /** Secret bound to that member (see design note 1). */
  secret: string
  /** Expiry, ms epoch. */
  exp: number
  /** Random tag for audit trails and replay detection. */
  nonce: string
}

export type InviteParseReason =
  | 'ok'
  | 'empty'
  | 'bad-prefix'
  | 'bad-payload'
  | 'bad-fingerprint'
  | 'bad-version'
  | 'missing-field'
  | 'bad-exp'
  | 'expired'
  | 'wrong-member'

export interface InviteParseResult {
  ok: boolean
  reason: InviteParseReason
  invite?: InvitePayload
  /** Human-readable explanation — a reason code alone is not a finding. */
  detail: string
}

export interface MintInviteInput {
  net: string
  url: string
  host: string
  member: string
  nowMs: number
  /** Override the lifetime (tests use this). */
  ttlMs?: number
  /** Override the secret (tests use this); 缺省现生成 32 字节随机。 */
  secret?: string
  /** Override the nonce (tests use this). */
  nonce?: string
}

// ── 未验证输入一律按不可信处理：这些字段直接进 URL / 文件路径，控制字符与空白一律拒 ──
const FIELD_MAX = 256
const isSafeField = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= FIELD_MAX && !/[\s\u0000-\u001f]/.test(v)

/** Stable JSON (keys in fixed order) so the fingerprint is reproducible across writers. */
export function canonicalInviteJson(p: InvitePayload): string {
  return JSON.stringify({
    v: p.v, net: p.net, url: p.url, host: p.host, member: p.member,
    secret: p.secret, exp: p.exp, nonce: p.nonce,
  })
}

/** Short digest over the canonical payload (design note 2: integrity, not authentication). */
export function inviteFingerprint(p: InvitePayload): string {
  return createHash('sha256').update(canonicalInviteJson(p)).digest('hex').slice(0, FP_CHARS)
}

/** Mint a token for exactly one member id. Returns the payload too — callers need `secret`. */
export function mintInvite(input: MintInviteInput): { ok: boolean; token: string; invite?: InvitePayload; detail: string } {
  const ttl = input.ttlMs ?? DEFAULT_INVITE_TTL_MS
  const invite: InvitePayload = {
    v: 1,
    net: input.net,
    url: input.url,
    host: input.host,
    member: input.member,
    secret: input.secret ?? randomBytes(32).toString('hex'),
    exp: input.nowMs + ttl,
    nonce: input.nonce ?? randomBytes(8).toString('hex'),
  }
  for (const [key, value] of [['net', invite.net], ['url', invite.url], ['host', invite.host], ['member', invite.member]] as const) {
    if (!isSafeField(value)) return { ok: false, token: '', detail: '字段 ' + key + ' 非法（空/超长/含空白或控制字符）' }
  }
  if (!Number.isFinite(invite.exp) || invite.exp <= 0) return { ok: false, token: '', detail: '过期时刻非法' }
  const body = Buffer.from(canonicalInviteJson(invite), 'utf8').toString('base64url')
  return { ok: true, token: INVITE_PREFIX + '.' + body + '.' + inviteFingerprint(invite), invite, detail: '已生成令牌（含该成员专属密钥，勿公开）' }
}

/** Parse and validate a token. Never throws; every failure carries a reason + detail. */
export function parseInvite(token: unknown, opts: { nowMs: number; expectMember?: string } = { nowMs: 0 }): InviteParseResult {
  if (typeof token !== 'string' || token.trim() === '') return { ok: false, reason: 'empty', detail: '令牌为空' }
  const parts = token.trim().split('.')
  if (parts.length !== 3) return { ok: false, reason: 'bad-payload', detail: '令牌应有三段（前缀.载荷.指纹），实际 ' + String(parts.length) + ' 段' }
  const [prefix, body, fp] = parts
  if (prefix !== INVITE_PREFIX) return { ok: false, reason: 'bad-prefix', detail: '前缀不是 ' + INVITE_PREFIX + '（这可能是别的东西，或版本不符）' }

  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'bad-payload', detail: '载荷不是合法 base64url+JSON（多为复制不全）' }
  }
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'bad-payload', detail: '载荷不是对象' }
  const r = raw as Record<string, unknown>

  if (r['v'] !== 1) return { ok: false, reason: 'bad-version', detail: '版本不是 1（实际 ' + String(r['v']) + '）' }
  for (const key of ['net', 'url', 'host', 'member', 'secret', 'exp', 'nonce']) {
    if (r[key] === undefined) return { ok: false, reason: 'missing-field', detail: '载荷缺字段 ' + key }
  }
  if (!isSafeField(r['net']) || !isSafeField(r['host']) || !isSafeField(r['member'])) {
    return { ok: false, reason: 'missing-field', detail: 'net/host/member 非法（空/超长/含空白或控制字符）' }
  }
  if (typeof r['url'] !== 'string' || r['url'] === '') return { ok: false, reason: 'missing-field', detail: 'url 非法' }
  if (typeof r['secret'] !== 'string' || r['secret'].length < 16) return { ok: false, reason: 'missing-field', detail: 'secret 缺失或过短（<16 字符）' }
  if (typeof r['exp'] !== 'number' || !Number.isFinite(r['exp'])) return { ok: false, reason: 'bad-exp', detail: 'exp 不是数字' }

  const invite: InvitePayload = {
    v: 1,
    net: r['net'] as string,
    url: r['url'],
    host: r['host'] as string,
    member: r['member'] as string,
    secret: r['secret'],
    exp: r['exp'],
    nonce: String(r['nonce'] ?? ''),
  }

  if (inviteFingerprint(invite) !== fp) {
    return { ok: false, reason: 'bad-fingerprint', detail: '指纹不符——令牌在传递中被改动或截断' }
  }
  if (opts.nowMs > 0 && invite.exp <= opts.nowMs) {
    return { ok: false, reason: 'expired', detail: '令牌已过期（到期 ' + new Date(invite.exp).toISOString() + '）' }
  }
  if (opts.expectMember !== undefined && invite.member !== opts.expectMember) {
    return { ok: false, reason: 'wrong-member', detail: '这张令牌准入的是 ' + invite.member + '，不是本节点 ' + opts.expectMember }
  }
  return { ok: true, reason: 'ok', invite, detail: '令牌有效：网络 ' + invite.net + ' · 准入身份 ' + invite.member }
}

export type JoinReason = 'ok' | 'not-my-network' | 'expired' | 'replay' | 'member-mismatch'

export interface JoinDecision {
  admit: boolean
  reason: JoinReason
  detail: string
}

/**
 * Host-side admission decision (pure; replay state injected as a predicate).
 *
 * The inviter decides — the joiner only asks. `seenNonce` answers "has this token already
 * been spent?", which is how a leaked-and-reused token gets caught.
 */
export function decideJoin(
  invite: InvitePayload,
  host: { net: string; nowMs: number; expectedMember?: string; seenNonce?: (nonce: string) => boolean },
): JoinDecision {
  if (host.net !== invite.net) {
    return { admit: false, reason: 'not-my-network', detail: '令牌属于网络 ' + invite.net + '，本网络是 ' + host.net }
  }
  if (invite.exp <= host.nowMs) {
    return { admit: false, reason: 'expired', detail: '令牌已过期（到期 ' + new Date(invite.exp).toISOString() + '）' }
  }
  if (host.expectedMember !== undefined && invite.member !== host.expectedMember) {
    return { admit: false, reason: 'member-mismatch', detail: '令牌准入 ' + invite.member + '，但请求者自报 ' + host.expectedMember }
  }
  if (host.seenNonce !== undefined && host.seenNonce(invite.nonce)) {
    return { admit: false, reason: 'replay', detail: '该令牌已被使用过（nonce ' + invite.nonce + '）' }
  }
  return { admit: true, reason: 'ok', detail: '准入：' + invite.member + ' 加入 ' + invite.net }
}

/**
 * Safe one-line description for logs, tool output and chat.
 *
 * `secret` is **redacted** and the nonce is shortened: tokens travel through channels where
 * a printed credential is a leaked credential (AGENTS.md §5.25 — 凭据不落盘/不外传).
 */
export function describeInvite(p: InvitePayload): string {
  const exp = new Date(p.exp).toISOString().replace('T', ' ').slice(0, 16)
  return '网络 ' + p.net + ' · 主脑 ' + p.host + ' · 准入 ' + p.member + ' · 到期 ' + exp + ' · 密钥已隐去'
}

/** Also usable for a token that failed to parse but whose text we still want to log safely. */
export function redactToken(token: string): string {
  const parts = token.split('.')
  if (parts.length !== 3) return '（非令牌形状，已隐去）'
  return parts[0] + '.<载荷 ' + String((parts[1] ?? '').length) + ' 字符>.' + (parts[2] ?? '')
}

/**
 * Join flow — the two sides of "paste a token and you're in".
 *
 * Why this is a separate module instead of living inside `apply`: the whole point of the
 * invite flow is that it must be **provable**, and logic buried in an `apply` closure can
 * only be tested through a fake context. Here the decision is pure-ish — IO arrives through
 * `JoinDeps` — so `scripts/join-demo.mjs` can drive the real code over real HTTP.
 *
 * Division of labour with `invite.ts`:
 *   - `invite.ts`  = what a token *is* (mint / parse / verify / decide). No IO.
 *   - `join.ts`    = who does what with it (host admits, guest enrols). IO injected.
 *
 * Non-negotiable: `handleJoin` **never throws** — it is an HTTP request handler running
 * inside the host process, where an escaping exception kills the web daemon (§5.24).
 */
import { JOIN_PATH, type PostJsonResult } from './http-node.ts'
import { decideJoin, describeInvite, mintInvite, OPEN_INVITE_MEMBER, parseInvite, redactToken, type InvitePayload } from './invite.ts'
import { parseMemberRecord, type MemberRecord } from './transport.ts'

/** Injected IO + facts. Nothing here reaches for globals — tests supply their own. */
export interface JoinDeps {
  /** 网络名（令牌带着它，防串网）。 */
  network: string
  /** 本节点成员 id。 */
  nodeId: string
  profile: string
  nowMs: () => number
  trace: (event: string, fields?: Record<string, unknown>) => unknown
  /** 已用令牌 nonce（防重放）。 */
  readUsedNonces: () => string[]
  markNonceUsed: (nonce: string) => void
  /** 写成员记录（含该成员专属密钥）。 */
  writeMember: (rec: MemberRecord) => { ok: boolean; error?: string }
  /** 主脑自己的成员记录（入网时回给对方）。 */
  selfRecord: () => MemberRecord
  /** 本机可被回连的基址；**空串 = 没有端点**（跨机不可达）。 */
  myBaseUrl: () => string
  /** 未认证 POST（真实实现 = `http-node.postJson`；测试可给替身）。 */
  post: (url: string, body: string) => Promise<PostJsonResult>
  /** 令牌有效期（ms），缺省 24 小时。 */
  defaultTtlMs?: number
}

export interface InviteMintOutcome {
  ok: true
  member: string
  token: string
  joinUrl: string
  expiresAt: string
  inviteLine: string
  warning?: string
}

export interface JoinOutcome {
  ok: true
  net: string
  host: string
  member: string
}

export interface JoinHandler {
  /** 主脑侧：处理 `POST /cluster/join`。**不抛**。 */
  handleJoin: (body: string) => { status: number; body: Record<string, unknown> }
  /** 主脑侧：签发令牌 —— **签发即准入**。失败抛错（工具面据此报错）。 */
  mintInviteFor: (input: { member: string; ttlMinutes?: number; url?: string }) => InviteMintOutcome
  /** 入网方：用令牌入网并互相入册。失败抛错。 */
  joinNetwork: (token: string) => Promise<JoinOutcome>
}

const DAY_MS = 24 * 60 * 60 * 1000

export function createJoinHandler(deps: JoinDeps): JoinHandler {
  const now = (): number => deps.nowMs()

  const mintInviteFor: JoinHandler['mintInviteFor'] = (input) => {
    const base = input.url !== undefined && input.url !== '' ? input.url : deps.myBaseUrl()
    if (base === '') {
      throw new Error('本节点没有入站端点（未配置 listenPort 且未给 url）——对方无处投递入网请求，签不出可用令牌')
    }
    const ttl = (input.ttlMinutes !== undefined && input.ttlMinutes > 0 ? input.ttlMinutes : 1440) * 60_000
    const m = mintInvite({ net: deps.network, url: base, host: deps.nodeId, member: input.member, nowMs: now(), ttlMs: ttl || (deps.defaultTtlMs ?? DAY_MS) })
    if (!m.ok || m.invite === undefined) throw new Error('令牌生成失败：' + m.detail)
    const inv: InvitePayload = m.invite
    // **签发即准入**：绑定令牌此刻就把该成员写进册子（准入决定不留给入网方自选身份）。
    // ⚠ 开放令牌（`member: '*'`）**不写**——此时还没有具体成员可入册（身份是入网时才自报的），
    // 而且 `*` 在 Windows 上根本不是合法文件名（2026-09-22 被 join-demo 抓住的真缺陷：
    // 写册子失败 ⇒ 签发直接抛错，而症状看起来像「令牌生成失败」）。
    if (inv.member !== OPEN_INVITE_MEMBER) {
      const rec: MemberRecord = {
        memberId: inv.member, kind: 'peer', trust: 'known', capabilities: [], protocol: 'v1',
        secret: inv.secret, notes: '已签发邀请令牌 ' + new Date(now()).toISOString().slice(0, 10),
      }
      const w = deps.writeMember(rec)
      if (!w.ok) throw new Error('成员册写入失败：' + (w.error ?? ''))
    }
    deps.trace('invite-minted', { member: inv.member, net: inv.net, exp: inv.exp, base, open: inv.member === OPEN_INVITE_MEMBER })
    const loopback = base.startsWith('http://127.0.0.1') || base.startsWith('http://localhost')
    const warnings: string[] = []
    if (inv.member === OPEN_INVITE_MEMBER) {
      warnings.push('**开放令牌**：谁拿到谁能进，且身份由入网方自报——只交给可信对象，且用短有效期')
    }
    if (loopback) {
      warnings.push('基址是回环地址——只有**同一台机器**上的实例能用这张令牌；跨机邀请要用对方能访问到的地址重签（url 参数）')
    }
    return {
      ok: true,
      member: inv.member,
      token: m.token,
      joinUrl: base + JOIN_PATH,
      expiresAt: new Date(inv.exp).toISOString(),
      inviteLine: describeInvite(inv),
      ...(warnings.length > 0 ? { warning: warnings.join('；') } : {}),
    }
  }

  const handleJoin: JoinHandler['handleJoin'] = (body) => {
    let req: { token?: unknown; member?: unknown }
    try {
      req = JSON.parse(body) as { token?: unknown; member?: unknown }
    } catch {
      deps.trace('join-reject', { reason: 'bad-json' })
      return { status: 400, body: { ok: false, reason: 'bad-json' } }
    }
    const parsed = parseInvite(req.token, { nowMs: now() })
    if (!parsed.ok || parsed.invite === undefined) {
      deps.trace('join-reject', {
        reason: parsed.reason, detail: parsed.detail,
        token: typeof req.token === 'string' ? redactToken(req.token) : '',
      })
      return { status: 401, body: { ok: false, reason: parsed.reason, detail: parsed.detail } }
    }
    const inv = parsed.invite
    // 入网方自报的成员记录是不可信输入：过 parseMemberRecord 归一，坏了就当「没报」
    const claimant = parseMemberRecord(req.member)
    const decision = decideJoin(inv, {
      net: deps.network,
      nowMs: now(),
      ...(claimant !== null ? { expectedMember: claimant.memberId } : {}),
      seenNonce: (n) => deps.readUsedNonces().includes(n),
    })
    if (!decision.admit) {
      deps.trace('join-reject', { reason: decision.reason, detail: decision.detail, member: inv.member })
      return { status: 403, body: { ok: false, reason: decision.reason, detail: decision.detail } }
    }
    // 开放令牌（`member: '*'`）：身份由入网方自报 ⇒ **必须真的自报了**才准入，
    // 否则不知道要写进册子的 id 是什么（宁可拒，也不许凭空造一个身份）。
    const admittedId = inv.member === OPEN_INVITE_MEMBER ? (claimant?.memberId ?? '') : inv.member
    if (admittedId === '') {
      deps.trace('join-reject', { reason: 'missing-claimant', detail: '开放令牌要求入网方自报成员记录' })
      return { status: 400, body: { ok: false, reason: 'missing-claimant', detail: '开放令牌要求入网方在请求里带 member.memberId（身份自报）' } }
    }
    const rec: MemberRecord = {
      memberId: admittedId,
      kind: 'peer',
      trust: 'known',
      capabilities: claimant?.capabilities ?? [],
      protocol: 'v1',
      ...(claimant?.endpoint !== undefined ? { endpoint: claimant.endpoint } : {}),
      secret: inv.secret,
      notes: (inv.member === OPEN_INVITE_MEMBER ? '开放邀请令牌入网（身份自报）' : '通过邀请令牌入网') + ' ' + new Date(now()).toISOString().slice(0, 10),
    }
    const w = deps.writeMember(rec)
    if (!w.ok) {
      deps.trace('join-write-failed', { member: admittedId, error: w.error ?? '' })
      return { status: 500, body: { ok: false, reason: 'member-write-failed', detail: w.error ?? '' } }
    }
    deps.markNonceUsed(inv.nonce)
    deps.trace('join-admitted', { member: admittedId, net: inv.net, nonce: inv.nonce, open: inv.member === OPEN_INVITE_MEMBER })
    return { status: 200, body: { ok: true, net: deps.network, host: JSON.parse(JSON.stringify(deps.selfRecord())) as unknown } }
  }

  const joinNetwork: JoinHandler['joinNetwork'] = async (token) => {
    const parsed = parseInvite(token, { nowMs: now(), expectMember: deps.nodeId })
    if (!parsed.ok || parsed.invite === undefined) {
      throw new Error('令牌不可用（' + parsed.reason + '）：' + parsed.detail)
    }
    const inv = parsed.invite
    const base = deps.myBaseUrl()
    const me: MemberRecord = {
      memberId: deps.nodeId, kind: 'peer', trust: 'known', capabilities: ['cluster'], protocol: 'v1',
      ...(base !== '' ? { endpoint: base } : {}),
      notes: 'profile ' + deps.profile,
    }
    const r = await deps.post(inv.url + JOIN_PATH, JSON.stringify({ token, member: JSON.parse(JSON.stringify(me)) as unknown }))
    deps.trace('join-request', { host: inv.host, net: inv.net, ok: r.ok, status: r.status, ...(r.ok ? {} : { reason: r.reason }) })
    if (!r.ok) {
      throw new Error('入网请求失败（' + r.reason + '）：' + (r.body !== '' ? r.body.slice(0, 300) : '（无响应正文）'))
    }
    let resp: { ok?: unknown; net?: unknown; host?: unknown; reason?: unknown; detail?: unknown }
    try {
      resp = JSON.parse(r.body) as typeof resp
    } catch {
      throw new Error('主脑响应不是 JSON（前 200 字符）：' + r.body.slice(0, 200))
    }
    if (resp.ok !== true) {
      throw new Error('主脑拒绝入网（' + String(resp.reason ?? 'unknown') + '）：' + String(resp.detail ?? ''))
    }
    const hostRec = parseMemberRecord(resp.host)
    if (hostRec === null) throw new Error('主脑响应里没有可解析的成员记录——无法把它写进本机册子')
    // 主脑记进本机册子：密钥用令牌里的**专属**密钥（主脑出站签它、我入站验它）。
    const mine: MemberRecord = {
      ...hostRec, trust: 'known', secret: inv.secret,
      notes: '通过邀请令牌入网的主脑 ' + new Date(now()).toISOString().slice(0, 10),
    }
    const w = deps.writeMember(mine)
    if (!w.ok) throw new Error('写入主脑成员记录失败：' + (w.error ?? ''))
    deps.trace('join-ok', { net: inv.net, host: mine.memberId, member: deps.nodeId })
    return { ok: true, net: String(resp.net ?? inv.net), host: mine.memberId, member: deps.nodeId }
  }

  return { handleJoin, mintInviteFor, joinNetwork }
}

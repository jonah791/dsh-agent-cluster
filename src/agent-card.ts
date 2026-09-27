/**
 * agent-card.ts — 节点能力卡片：把「这个节点是谁 / 会什么 / 怎么连上它」变成一个**有形状、
 * 带来源标注**的可发现对象（形状对齐 A2A AgentCard，但**不引 SDK、不改协议信封**）。
 *
 * 动机（任务 t-1e1f5084 · `docs/members.md` §U5）：
 *  - `capabilities[]` 原本只活在**跨机成员册**（`members/*.json`），而**本机名册**
 *    （`nodes/*.json` 心跳）里没有这个字段 ⇒ `cluster_nodes` **看不到任何节点的能力**；
 *  - 成员册里那条是**自称**——没人验过它真能做。
 *
 * 两条承重设计：
 *  1. **来源三分**（`declared` / `inferred` / `undeclared`）：**没有的字段就说没有**，
 *     绝不伪造默认值。本卡刻意**不设「实测」档**——实测需探针任务（U 项），
 *     在那之前把 `claimed` 说成 `verified` 就是撒谎。
 *  2. **能力带验证状态**：`claimed` 恒真（出现在声明里即自称）；`verified` **只由探针
 *     实测置位**，缺席即未实测。**「不许默认 verified」正是这张卡存在的理由。**
 *
 * 输入一律不可信（心跳/成员册文件可能被手改或来自老版本）⇒ 参数取 `unknown`，
 * 内部规范化；任何畸形输入都**降级为 undeclared**，绝不抛（对齐 `parseMemberRecord` 的纪律）。
 *
 * @module dsh-agent-cluster/agent-card
 */

/** 字段来源三档（本卡无「实测」档：实测属 `CardCapability.verified` 的职责）。 */
export type CardSource = 'declared' | 'inferred' | 'undeclared'

/** 一个有来源标注的字段值。`undeclared` 时 `value` 恒为 `null`。 */
export interface CardField<T> {
  value: T | null
  source: CardSource
  /** 该值取自哪个输入字段（可追溯）；未声明时缺席。 */
  from?: string
}

/** 一条能力声明：出现在声明里即 `claimed`，实测后才可能 `verified`。 */
export interface CardCapability {
  tag: string
  /** 自称（恒真：能被列出来就说明它被声明过）。 */
  claimed: true
  /** 探针实测结论；**缺席 = 未实测**（不得默认 true）。 */
  verified?: boolean
  verifiedAt?: number
  /** 实测证据（探针任务的返回，形状由调用方定）。 */
  evidence?: unknown
}

/** 节点能力卡片。`capabilities` 是数组而非 `CardField`：空数组本身就是「未声明任何能力」。 */
export interface AgentCard {
  id: CardField<string>
  kind: CardField<string>
  role: CardField<string>
  capabilities: CardCapability[]
  skills: CardField<string[]>
  endpoint: CardField<string>
  auth: CardField<{ scheme: string }>
  protocolVersion: CardField<string>
  ttl: CardField<number>
}

/** 未声明字段的构造（单一真源，避免各处手写 `{value:null,source:'undeclared'}`）。 */
function undeclared<T>(): CardField<T> {
  return { value: null, source: 'undeclared' }
}

/** 声明字段（`from` 记来源字段名，便于回答「这个值哪来的」）。 */
function declared<T>(value: T, from: string): CardField<T> {
  return { value, source: 'declared', from }
}

/** 推断字段（**必须**写清推断依据的字段名）。 */
function inferred<T>(value: T, from: string): CardField<T> {
  return { value, source: 'inferred', from }
}

/** 宽松取对象（畸形输入一律当空对象，后续按「缺字段」处理）。 */
function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

/** 取非空字符串；非字符串或空串返回 undefined。 */
function nonEmptyString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/** 取字符串数组（滤掉非字符串与空串，保序去重）。 */
function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item !== '' && !out.includes(item)) out.push(item)
  }
  return out
}

/**
 * 由**心跳**（本机名册，`nodes/<nodeId>.json`）+ 可选**成员册记录**
 * （跨机面，`members/<memberId>.json`）派生能力卡片。
 *
 * 两张表**都可能是唯一真源**：能力只在成员册、端类型只在心跳 ⇒ 必须合看，
 * 且各自标各自的来源。
 *
 * @param heartbeat - 心跳内容（不可信，畸形按缺字段处理）
 * @param member - 成员册记录（可选；不在成员册的节点只有心跳面）
 * @param offlineAfterMs - 判活阈值（用于推断 `ttl`；缺省 30s = 3× 默认心跳周期）
 * @returns 卡片；**每个字段都带来源**，缺失字段为 `undeclared` 而非默认值
 */
export function deriveAgentCard(
  heartbeat: unknown,
  member?: unknown,
  offlineAfterMs = 30_000,
): AgentCard {
  const hb = asRecord(heartbeat)
  const mem = asRecord(member)

  const hbNodeId = nonEmptyString(hb['nodeId'])
  const memMemberId = nonEmptyString(mem['memberId'])

  const id = hbNodeId !== undefined
    ? declared(hbNodeId, 'heartbeat.nodeId')
    : (memMemberId !== undefined ? declared(memMemberId, 'member.memberId') : undeclared<string>())

  // kind：**缺声明就是缺声明**——不替它推断成 desktop。心跳注释写着「不因缺声明而
  // 剥夺选举资格」，那是选举侧的宽容；卡片侧的对应纪律是「也不替它声称」。
  const kindRaw = nonEmptyString(hb['kind'])
  const kind = kindRaw !== undefined ? declared(kindRaw, 'heartbeat.kind') : undeclared<string>()

  const roleRaw = nonEmptyString(hb['role'])
  const role = roleRaw !== undefined ? declared(roleRaw, 'heartbeat.role') : undeclared<string>()

  // 能力 = 成员册的 capabilities[] ∪ 心跳的 leaderCapable（同为**自称**，只是字段形态不同）。
  const caps: CardCapability[] = stringList(mem['capabilities'])
    .map((tag) => ({ tag, claimed: true as const }))
  if (hb['leaderCapable'] === true && !caps.some((c) => c.tag === 'leader')) {
    caps.push({ tag: 'leader', claimed: true })
  }

  const hbBaseUrl = nonEmptyString(hb['baseUrl'])
  const memEndpoint = nonEmptyString(mem['endpoint'])
  const endpoint = hbBaseUrl !== undefined
    ? declared(hbBaseUrl, 'heartbeat.baseUrl')
    : (memEndpoint !== undefined ? declared(memEndpoint, 'member.endpoint') : undeclared<string>())

  // protocolVersion：成员册的 protocol 是**显式声明**；心跳的 v 只是**心跳格式版本**，
  // 把它当协议版本是推断，故标 inferred 并写明依据。
  const protocolRaw = nonEmptyString(mem['protocol'])
  const hbVersion = typeof hb['v'] === 'number' ? hb['v'] : undefined
  const protocolVersion = protocolRaw !== undefined
    ? declared(protocolRaw, 'member.protocol')
    : (hbVersion !== undefined
      ? inferred('heartbeat-v' + String(hbVersion), 'heartbeat.v')
      : undeclared<string>())

  // ttl：由判活阈值推断——这是本卡唯一的纯推断字段（心跳不含节点自报的周期）。
  const ttl = Number.isFinite(offlineAfterMs) && offlineAfterMs > 0
    ? inferred(offlineAfterMs, 'liveness.offlineAfterMs')
    : undeclared<number>()

  return {
    id,
    kind,
    role,
    capabilities: caps,
    // 当前协议里没有 skills / auth 字段 ⇒ **恒 undeclared**。留字段是为了形状对齐，
    // 不是为了填内容：等真有这两个声明来源时再返回 declared。
    skills: undeclared<string[]>(),
    endpoint,
    auth: undeclared<{ scheme: string }>(),
    protocolVersion,
    ttl,
  }
}

/** 解析一张卡片（输入不可信）：形状不合即返回 `null`，不抛。 */
export function parseAgentCard(raw: unknown): AgentCard | null {
  const o = asRecord(raw)
  if (Object.keys(o).length === 0) return null
  const field = <T>(v: unknown): CardField<T> => {
    const f = asRecord(v)
    const source = f['source']
    if (source !== 'declared' && source !== 'inferred' && source !== 'undeclared') {
      return undeclared<T>()
    }
    const from = nonEmptyString(f['from'])
    return {
      value: (f['value'] ?? null) as T | null,
      source,
      ...(from === undefined ? {} : { from }),
    }
  }
  const capsRaw = Array.isArray(o['capabilities']) ? o['capabilities'] : []
  const capabilities: CardCapability[] = []
  for (const item of capsRaw) {
    const c = asRecord(item)
    const tag = nonEmptyString(c['tag'])
    if (tag === undefined) continue
    const cap: CardCapability = { tag, claimed: true }
    if (c['verified'] === true || c['verified'] === false) cap.verified = c['verified']
    if (typeof c['verifiedAt'] === 'number') cap.verifiedAt = c['verifiedAt']
    if ('evidence' in c) cap.evidence = c['evidence']
    capabilities.push(cap)
  }
  return {
    id: field<string>(o['id']),
    kind: field<string>(o['kind']),
    role: field<string>(o['role']),
    capabilities,
    skills: field<string[]>(o['skills']),
    endpoint: field<string>(o['endpoint']),
    auth: field<{ scheme: string }>(o['auth']),
    protocolVersion: field<string>(o['protocolVersion']),
    ttl: field<number>(o['ttl']),
  }
}

/** 来源档的中文短标（渲染用；单一真源，避免各处手写）。 */
export const CARD_SOURCE_LABEL: Record<CardSource, string> = {
  declared: '声明',
  inferred: '推断',
  undeclared: '未声明',
}

/**
 * 一行的卡片摘要（`cluster_nodes` 渲染用）。
 *
 * 只列**非未声明**的字段——未声明不占版面，但它们**仍然在结构化输出里**（诚实靠字段，
 * 不靠「没说就等于没有」）。
 * @param card - 卡片
 * @returns 形如 `kind=desktop(声明) · 能力 cluster,leader(自称) · 端点 …(声明) · 协议 v1(声明)`
 */
export function renderCardSummary(card: AgentCard): string {
  const parts: string[] = []
  const fieldPart = <T>(label: string, f: CardField<T>): void => {
    if (f.source === 'undeclared' || f.value === null) return
    parts.push(label + '=' + String(f.value) + '(' + CARD_SOURCE_LABEL[f.source] + ')')
  }
  fieldPart('kind', card.kind)
  fieldPart('role', card.role)
  fieldPart('端点', card.endpoint)
  fieldPart('协议', card.protocolVersion)
  if (card.capabilities.length > 0) {
    const tags = card.capabilities.map((c) => c.tag + (c.verified === true ? '✓' : '')).join(',')
    parts.push('能力 ' + tags + '(自称)')
  }
  return parts.length === 0 ? '卡片：全部字段未声明' : parts.join(' · ')
}

/**
 * leader.ts — 主脑资格、选举与租约裁决（**纯函数**：无 IO、无时间、无宿主耦合）。
 *
 * ## 缺口（2026-09-23 主人定调）
 * 「智能体网络肯定是多端的（手机、电脑、手表、智能眼镜等）……应该有主脑存在，
 *   但任何一个实例都可以在满足条件的情况下成为主脑。」
 * 补之前：**「主脑」只是一个静态标签**——谁签发入网令牌谁就被记成 host（`invite.ts` /
 * `join.ts`），名册里的 `role` 只是展示字符串。没有资格判据、没有选举、没有接管、
 * 没有自降级；主脑所在那台机器一关，网络就只剩点对点。
 *
 * ## 与既有设计的关系（不发明新机制）
 * `docs/design.md` §15.1 早已写下机制，但**零实现**（`src/` 全量 grep 无命中）：
 * 「租约 + epoch 竞选 + 文件系统当仲裁者」，并明写**复用 §5.19 的租约模式**。
 * 本模块实现它，并沿用它的字段名（`owner / epoch / atMs / ttlMs`）与周期（TTL 90s、每 30s 续租）。
 * 落盘与 CAS 抢占由调用方做（`publishNoClobber` 的原子 `link()`，见 `bus.ts`）——本模块只裁决。
 *
 * ## 三条不变量
 * - **I-L1 单主**：同一时刻至多一个主脑——靠**带 TTL 的租约**（过期即失效，不靠"宣告退出"）。
 * - **I-L2 可迁移**：租约过期后，**任何合格节点**都可接管，`epoch` 单调递增。
 * - **I-L3 降级不阻塞**：无主脑时点对点通信照常——主脑提供**协调**，不是单点依赖。
 *
 * ## 防脑裂（§15.1 第 4 条，本模块的核心）
 * 租约过期是**唯一**的接管前提，且接管必须 `epoch = 旧 epoch + 1`；主脑每次心跳读租约，
 * **若自己的 epoch 不是最新 ⇒ 立即自降为 worker 并落痕**（`step-down`）。
 * 这条自愈路径是「旧主复活不分裂网络」的唯一保证。
 *
 * ## 多端：端类型决定资格与权重
 * 手表与眼镜**默认不合格**（算力/续航/网络都不适合长期协调），手机是低权重候选，
 * 服务器与桌面是主力。判据是显式的（`canLead` 给理由），不是隐含偏好。
 */

/** 端类型。`unknown` 是缺省：未声明端类型的节点按桌面级对待（不因缺声明而剥夺资格）。 */
export type NodeKind = 'server' | 'desktop' | 'phone' | 'watch' | 'glasses' | 'unknown'

/** 端类型权重：越大越优先当主脑（同在线、同新鲜度时用来定序）。 */
export const KIND_WEIGHT: Record<NodeKind, number> = {
  server: 100,
  desktop: 80,
  unknown: 80,
  phone: 40,
  glasses: 10,
  watch: 5,
}

/** 默认**不合格**的端类型（可被节点显式声明 `leaderEligible: true` 覆盖）。 */
export const DEFAULT_INELIGIBLE: readonly NodeKind[] = ['watch', 'glasses']

/** 租约默认存活期（ms）——与 `docs/design.md` §15.1 的 `ttlMs: 90000` 一致。 */
export const DEFAULT_LEASE_TTL_MS = 90_000

/** 续租间隔 = TTL / RENEW_DIVISOR（§15.1：TTL 90s、每 30s 续租）。 */
export const RENEW_DIVISOR = 3

/** 主脑租约（字段名与 §15.1 逐字一致）。 */
export interface LeaderLease {
  /** 持有者 nodeId。 */
  readonly owner: string
  /** 任期号，单调递增。接管必须 +1；看到更大 epoch ⇒ 自己已不是主脑。 */
  readonly epoch: number
  /** 取得时刻（ms）。 */
  readonly atMs: number
  /** 存活期（ms）。 */
  readonly ttlMs: number
}

/** 一个候选节点的**可判定子集**（名册项 + 端类型声明）。 */
export interface LeaderCandidate {
  readonly nodeId: string
  /** 心跳年龄（ms）：越小越新鲜。 */
  readonly ageMs: number
  /** 是否在线（调用方按 `nodeOnline` 判定后传入）。 */
  readonly online: boolean
  /** 端类型（未声明 = `unknown`）。 */
  readonly kind: NodeKind
  /** 信任态（`unknown` 的成员**不参与**选举——与 `cluster_members` 同一条纪律）。 */
  readonly trust: string
  /** 显式退出选举（如该端要省电）。 */
  readonly leaderEligible: boolean
  /**
   * 该节点**是否具备主脑协议**（心跳里自报）。
   *
   * 与 `leaderEligible` 是两回事：`leaderEligible=false` 是「能但当」的**自愿退出**，
   * 本字段是「构建里根本没有这套协议」的**能力缺失**——后者当主脑会静默失败
   * （它永远不会写/续租约），所以必须是**硬前提**。
   */
  readonly leaderCapable: boolean
}

/** 本节点该做什么。 */
export type LeaderAction = 'renew' | 'take' | 'step-down' | 'none'

/** 选举裁决。 */
export interface LeaderDecision {
  /** 当前应认的主脑（`null` = 无人合格，网络处于无主态）。 */
  readonly leaderId: string | null
  /** 该主脑的任期号（无主 = 0）。 */
  readonly epoch: number
  readonly action: LeaderAction
  /** 理由（**必须可读**：状态要说得出为什么）。 */
  readonly reason: string
}

/** 端类型归一：未知值一律落到 `unknown`（不抛——名册可能来自旧版本节点）。 */
export function normalizeKind(raw: unknown): NodeKind {
  if (raw === 'server' || raw === 'desktop' || raw === 'phone' || raw === 'watch' || raw === 'glasses') return raw
  return 'unknown'
}

/** 租约到期时刻（ms）。 */
export function leaseExpiresAtMs(lease: LeaderLease): number {
  return lease.atMs + lease.ttlMs
}

/** 租约是否仍然有效（**边界定死**：`now === 到期时刻` 算**已过期**——接管不能早一刻也不该晚一刻）。 */
export function leaseActive(lease: LeaderLease | null | undefined, nowMs: number): boolean {
  if (lease === null || lease === undefined) return false
  if (!Number.isFinite(lease.atMs) || !Number.isFinite(lease.ttlMs) || lease.ttlMs <= 0) return false
  return nowMs < leaseExpiresAtMs(lease)
}

/** 资格判据结果。 */
export interface Eligibility {
  readonly ok: boolean
  readonly why: string
}

/**
 * 该候选是否有资格当主脑。**每条判据都给理由**（状态要能回答「为什么不是它」）。
 *
 * 判据顺序有讲究：**能力先于偏好**。前四条是「能不能」（能力/信任/显式退出/端类型），
 * 后一条是「数据是否可用」。
 * @param candidate - 候选的可判定子集。
 */
export function canLead(candidate: LeaderCandidate): Eligibility {
  // ⚠ 能力是**前提**，不是偏好（2026-09-23 真实总线实测后补）：
  // 当主脑意味着**真的去写/续租约**，没实现该协议的构建根本执行不了这个职责。
  // 此前判据里没有这一条，于是确定性排序把主脑判给「最在线 + 最新鲜」的节点，
  // 而那个节点若不具备协议就**永远不宣布接管** ⇒ 整个网络**永久停在无主态**
  // （实测：`tavern-3081` 心跳恒比本节点新鲜，而它的构建早于本模块，从不 claim）。
  if (!candidate.leaderCapable) return { ok: false, why: '不具备主脑协议（心跳未声明 leaderCapable）' }
  if (!candidate.online) return { ok: false, why: '不在线' }
  if (candidate.trust === 'unknown') return { ok: false, why: '信任态 unknown（未入册）' }
  if (!candidate.leaderEligible) return { ok: false, why: '显式退出选举（leaderEligible=false）' }
  if (DEFAULT_INELIGIBLE.includes(candidate.kind)) return { ok: false, why: candidate.kind + ' 端默认不合格（算力/续航）' }
  if (!Number.isFinite(candidate.ageMs) || candidate.ageMs < 0) return { ok: false, why: '心跳年龄无效' }
  return { ok: true, why: '合格' }
}

/**
 * 选举裁决——**本模块的核心**，也是唯一需要小心脑裂的地方。
 *
 * 规则（按序）：
 *   ① **自降级**（§15.1 第 4 条）：我记着自己的任期 `ownEpoch`，而总线租约的 `epoch` 更大
 *      ⇒ 别人已合法接管 ⇒ `step-down`（**即使我手上的租约看起来还没过期**——总线是仲裁者）。
 *   ② 租约有效：是我 ⇒ `renew`；不是我 ⇒ `none`（服从）。**稳定优先**。
 *   ③ 租约失效：从**合格候选**（含自己）里按 (端权重 ↓, 心跳年龄 ↑, nodeId ↑) 取第一：
 *      · 是我 ⇒ `take`，epoch = 旧 epoch + 1
 *      · 不是我 ⇒ `none`（等它宣布；**我不抢**——确定性排序保证各端算出同一个赢家）
 *   ④ 无人合格 ⇒ `leaderId: null`，无主态（I-L3：点对点照常）。
 *
 * @param input.self - 本节点的 nodeId。
 * @param input.candidates - 全部候选（含自己；调用方保证 id 唯一）。
 * @param input.lease - 总线上读到的最新租约（无则 `null`）。
 * @param input.ownEpoch - 本节点上次担任主脑时的 epoch（从未担任 ⇒ `undefined`）。
 * @param input.nowMs - 当前时刻。
 * @param input.ttlMs - 新租约的存活期（缺省 {@link DEFAULT_LEASE_TTL_MS}）。
 */
export function decideLeader(input: {
  self: string
  candidates: readonly LeaderCandidate[]
  lease: LeaderLease | null
  ownEpoch?: number
  nowMs: number
  ttlMs?: number
}): LeaderDecision {
  const { self, candidates, lease, nowMs } = input
  const ttl = input.ttlMs ?? DEFAULT_LEASE_TTL_MS

  if (lease !== null && input.ownEpoch !== undefined && lease.epoch > input.ownEpoch) {
    return {
      leaderId: lease.owner,
      epoch: lease.epoch,
      action: 'step-down',
      reason: '总线租约 epoch ' + lease.epoch + ' 高于本节点记录的 ' + input.ownEpoch + '（已被合法接管），自降为 worker',
    }
  }

  if (leaseActive(lease, nowMs) && lease !== null) {
    if (lease.owner === self) {
      return { leaderId: self, epoch: lease.epoch, action: 'renew', reason: '租约仍有效，续租' }
    }
    return { leaderId: lease.owner, epoch: lease.epoch, action: 'none', reason: '租约有效，服从现任主脑' }
  }

  const eligible = candidates
    .filter((c) => canLead(c).ok)
    .slice()
    .sort((a, b) =>
      KIND_WEIGHT[b.kind] - KIND_WEIGHT[a.kind]
      || a.ageMs - b.ageMs
      || (a.nodeId === b.nodeId ? 0 : a.nodeId < b.nodeId ? -1 : 1))

  const winner = eligible[0]
  if (winner === undefined) {
    return { leaderId: null, epoch: 0, action: 'none', reason: '无合格候选（无主态，点对点通信不受影响）' }
  }
  const nextEpoch = (lease?.epoch ?? 0) + 1
  // ⚠ 「无租约」与「租约已过期」是**两种不同状态**，不得用同一条文案掩盖（2026-09-23 真实总线实测）：
  // 此前两者都说「租约失效」，于是在一个**从未选举过**的总线上读出了「主脑：待接管 X（租约失效）」——
  // 让操作者以为曾有主脑而任期中断。区分后，运维一眼能看出「还没选」还是「选了但断了」。
  const leaseState = lease === null
    ? '无租约（本网络尚未选举）'
    : '租约已过期（原持有者 ' + lease.owner + '，epoch ' + lease.epoch + '）'
  if (winner.nodeId === self) {
    return { leaderId: self, epoch: nextEpoch, action: 'take', reason: leaseState + '，本节点胜出（' + winner.kind + '），接管 epoch ' + nextEpoch }
  }
  return { leaderId: winner.nodeId, epoch: nextEpoch, action: 'none', reason: leaseState + '，等待 ' + winner.nodeId + ' 宣布接管 epoch ' + nextEpoch }
}

/** 取到新租约（`take` / `renew` 成功后由调用方 CAS 落盘）。 */
export function grantLease(owner: string, epoch: number, nowMs: number, ttlMs: number = DEFAULT_LEASE_TTL_MS): LeaderLease {
  return { owner, epoch, atMs: nowMs, ttlMs }
}

/** 续租间隔（ms）——调用方据此排下一次心跳/续租。 */
export function renewIntervalMs(ttlMs: number = DEFAULT_LEASE_TTL_MS): number {
  return Math.max(1, Math.floor(ttlMs / RENEW_DIVISOR))
}

/** 解析总线上的租约文件（**纯函数**，坏数据一律 `null`——选举不因坏文件而停摆）。 */
export function parseLease(raw: unknown): LeaderLease | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const owner = o['owner']
  const epoch = o['epoch']
  const atMs = o['atMs']
  const ttlMs = o['ttlMs']
  if (typeof owner !== 'string' || owner === '') return null
  if (typeof epoch !== 'number' || !Number.isFinite(epoch) || epoch < 0) return null
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return null
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) return null
  return { owner, epoch, atMs, ttlMs }
}

/** 一行状态文案（工具面与名册共用同一句话，避免两处措辞漂移）。 */
export function describeLeader(decision: LeaderDecision, nowMs: number, lease: LeaderLease | null): string {
  if (decision.leaderId === null) return '主脑：无（' + decision.reason + '）'
  // 只有「租约正落在它手上」才算已就任；租约失效时选出的只是**待接管者**——
  // 第一版把两者混为一谈，真实总线上读出了「主脑：X（租约剩 0s）」这种自相矛盾的句子。
  const incumbent = leaseActive(lease, nowMs) && lease !== null && lease.owner === decision.leaderId
  if (!incumbent) {
    return '主脑：待接管 ' + decision.leaderId + '（epoch ' + decision.epoch + '，' + decision.reason + '）'
  }
  const left = lease !== null ? Math.max(0, Math.round((leaseExpiresAtMs(lease) - nowMs) / 1000)) : 0
  return '主脑：' + decision.leaderId + '（epoch ' + decision.epoch + '，租约剩 ' + left + 's，' + decision.reason + '）'
}

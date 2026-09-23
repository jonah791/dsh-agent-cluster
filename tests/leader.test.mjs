/**
 * leader.ts 套件：资格判据、选举确定性、租约边界、自降级（防脑裂）、坏数据回落。
 *
 * 判据来源：`docs/design.md` §15.1（租约 + epoch 竞选 + 文件系统当仲裁者，此前零实现）。
 * 每条不合格判据都配一个**尸体样本**——「合格」这类断言不喂坏样本就不算验过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LEASE_TTL_MS, KIND_WEIGHT, canLead, decideLeader, describeLeader, grantLease, leaseActive,
  leaseExpiresAtMs, normalizeKind, parseLease, renewIntervalMs,
} from '../lib/leader.js'

const NOW = 1_700_000_000_000

/** 造一个候选；缺省是「具备主脑协议、在线、desktop、known、可参选、心跳新鲜」。 */
function candidate(over = {}) {
  return {
    nodeId: 'n1', ageMs: 1000, online: true, kind: 'desktop', trust: 'known',
    leaderEligible: true, leaderCapable: true, ...over,
  }
}

// ─────────────────────────────────────────── 端类型

test('normalizeKind：已知端类型原样；未知/缺省一律 unknown（不抛）', () => {
  assert.equal(normalizeKind('server'), 'server')
  assert.equal(normalizeKind('watch'), 'watch')
  assert.equal(normalizeKind('toaster'), 'unknown')
  assert.equal(normalizeKind(undefined), 'unknown')
  assert.equal(normalizeKind(42), 'unknown')
})

test('KIND_WEIGHT：服务器 > 桌面 = unknown > 手机 > 眼镜 > 手表', () => {
  assert.ok(KIND_WEIGHT.server > KIND_WEIGHT.desktop)
  assert.equal(KIND_WEIGHT.desktop, KIND_WEIGHT.unknown)
  assert.ok(KIND_WEIGHT.desktop > KIND_WEIGHT.phone)
  assert.ok(KIND_WEIGHT.phone > KIND_WEIGHT.glasses)
  assert.ok(KIND_WEIGHT.glasses > KIND_WEIGHT.watch)
})

// ─────────────────────────────────────────── 资格（每条配尸体）

test('canLead：四条不合格判据各自带理由（尸体样本）', () => {
  assert.deepEqual(canLead(candidate({ online: false })), { ok: false, why: '不在线' })
  assert.deepEqual(canLead(candidate({ trust: 'unknown' })), { ok: false, why: '信任态 unknown（未入册）' })
  assert.deepEqual(canLead(candidate({ leaderEligible: false })), { ok: false, why: '显式退出选举（leaderEligible=false）' })
  assert.equal(canLead(candidate({ kind: 'watch' })).ok, false)
  assert.equal(canLead(candidate({ kind: 'glasses' })).ok, false)
  assert.match(canLead(candidate({ kind: 'watch' })).why, /watch 端默认不合格/)
})

test('canLead：合格候选通过；手机合格但权重低（不是不合格）', () => {
  assert.equal(canLead(candidate()).ok, true)
  assert.equal(canLead(candidate({ kind: 'server' })).ok, true)
  assert.equal(canLead(candidate({ kind: 'phone' })).ok, true)
})

test('canLead：心跳年龄为负或 NaN ⇒ 不合格（坏数据不当合格用）', () => {
  assert.equal(canLead(candidate({ ageMs: -1 })).ok, false)
  assert.equal(canLead(candidate({ ageMs: Number.NaN })).ok, false)
})

// ─────────────────────────────────────────── 租约边界

test('leaseActive：边界定死——now 恰等于到期时刻算【已过期】', () => {
  const lease = grantLease('a', 1, NOW, 90_000)
  assert.equal(leaseExpiresAtMs(lease), NOW + 90_000)
  assert.equal(leaseActive(lease, NOW), true)
  assert.equal(leaseActive(lease, NOW + 89_999), true)
  assert.equal(leaseActive(lease, NOW + 90_000), false)
  assert.equal(leaseActive(lease, NOW + 90_001), false)
})

test('leaseActive：null / 坏 ttl / 坏 atMs 一律视为无效', () => {
  assert.equal(leaseActive(null, NOW), false)
  assert.equal(leaseActive(undefined, NOW), false)
  assert.equal(leaseActive({ owner: 'a', epoch: 1, atMs: NOW, ttlMs: 0 }, NOW), false)
  assert.equal(leaseActive({ owner: 'a', epoch: 1, atMs: Number.NaN, ttlMs: 1000 }, NOW), false)
})

test('renewIntervalMs：TTL/3（§15.1：TTL 90s ⇒ 每 30s 续租）', () => {
  assert.equal(renewIntervalMs(DEFAULT_LEASE_TTL_MS), 30_000)
  assert.equal(renewIntervalMs(3), 1)
})

// ─────────────────────────────────────────── 选举

test('decideLeader：租约有效且是我 ⇒ renew（稳定优先，不重选）', () => {
  const lease = grantLease('self', 7, NOW, 90_000)
  const d = decideLeader({ self: 'self', candidates: [candidate({ nodeId: 'self' }), candidate({ nodeId: 'better', kind: 'server' })], lease, nowMs: NOW + 1000 })
  assert.equal(d.action, 'renew')
  assert.equal(d.leaderId, 'self')
  assert.equal(d.epoch, 7)
})

test('decideLeader：租约有效但不是 ⇒ none（服从现任，即使我更"强"）', () => {
  const lease = grantLease('other', 3, NOW, 90_000)
  const d = decideLeader({ self: 'self', candidates: [candidate({ nodeId: 'self', kind: 'server' }), candidate({ nodeId: 'other', kind: 'watch' })], lease, nowMs: NOW + 1000 })
  assert.equal(d.action, 'none')
  assert.equal(d.leaderId, 'other')
})

test('⭐ decideLeader：自降级——总线 epoch 高于自己记录 ⇒ step-down（§15.1 第 4 条，防脑裂）', () => {
  const lease = grantLease('usurper', 5, NOW, 90_000)
  const d = decideLeader({ self: 'self', candidates: [candidate({ nodeId: 'self' })], lease, ownEpoch: 4, nowMs: NOW + 1000 })
  assert.equal(d.action, 'step-down')
  assert.equal(d.leaderId, 'usurper')
  assert.equal(d.epoch, 5)
  assert.match(d.reason, /自降为 worker/)
})

test('decideLeader：自己 epoch 不落后 ⇒ 不降级（同 epoch 续租）', () => {
  const lease = grantLease('self', 5, NOW, 90_000)
  const d = decideLeader({ self: 'self', candidates: [candidate({ nodeId: 'self' })], lease, ownEpoch: 5, nowMs: NOW + 1000 })
  assert.equal(d.action, 'renew')
})

test('decideLeader：租约过期且我胜出 ⇒ take，epoch = 旧 + 1', () => {
  const expired = grantLease('dead', 9, NOW - 200_000, 90_000)
  const d = decideLeader({ self: 'self', candidates: [candidate({ nodeId: 'self', kind: 'server' })], lease: expired, nowMs: NOW })
  assert.equal(d.action, 'take')
  assert.equal(d.epoch, 10)
  assert.equal(d.leaderId, 'self')
})

test('decideLeader：租约过期且别人胜出 ⇒ none（我不抢；确定性排序保证各端同结论）', () => {
  const expired = grantLease('dead', 2, NOW - 200_000, 90_000)
  const d = decideLeader({ self: 'self', candidates: [candidate({ nodeId: 'self', kind: 'phone' }), candidate({ nodeId: 'z', kind: 'server' })], lease: expired, nowMs: NOW })
  assert.equal(d.action, 'none')
  assert.equal(d.leaderId, 'z')
  assert.equal(d.epoch, 3)
})

test('decideLeader：端权重优先于新鲜度（服务器胜过更新鲜的手机）', () => {
  const d = decideLeader({ self: 'self', candidates: [candidate({ nodeId: 'p', kind: 'phone', ageMs: 10 }), candidate({ nodeId: 's', kind: 'server', ageMs: 5000 })], lease: null, nowMs: NOW })
  assert.equal(d.leaderId, 's')
})

test('decideLeader：同权重同新鲜度 ⇒ 按 nodeId 字典序（平票可复现）', () => {
  const d = decideLeader({ self: 'self', candidates: [candidate({ nodeId: 'bbb' }), candidate({ nodeId: 'aaa' })], lease: null, nowMs: NOW })
  assert.equal(d.leaderId, 'aaa')
})

test('decideLeader：输入顺序不影响结果（确定性）', () => {
  const list = [candidate({ nodeId: 'a' }), candidate({ nodeId: 'b', kind: 'server' }), candidate({ nodeId: 'c', ageMs: 5 })]
  const forward = decideLeader({ self: 'x', candidates: list, lease: null, nowMs: NOW })
  const backward = decideLeader({ self: 'x', candidates: [...list].reverse(), lease: null, nowMs: NOW })
  assert.deepEqual(forward, backward)
})

test('decideLeader：无合格候选 ⇒ 无主态（leaderId null，不抛）', () => {
  const d = decideLeader({ self: 'self', candidates: [candidate({ nodeId: 'w', kind: 'watch' }), candidate({ nodeId: 'o', online: false })], lease: null, nowMs: NOW })
  assert.equal(d.leaderId, null)
  assert.equal(d.epoch, 0)
  assert.equal(d.action, 'none')
  assert.match(d.reason, /无主态/)
})

test('decideLeader：候选为空 ⇒ 无主态（冷启动，点对点不受影响）', () => {
  const d = decideLeader({ self: 'self', candidates: [], lease: null, nowMs: NOW })
  assert.equal(d.leaderId, null)
  assert.equal(d.action, 'none')
})

test('decideLeader：自己不合格时永不 take（fail-safe 方向是安静）', () => {
  const d = decideLeader({ self: 'self', candidates: [candidate({ nodeId: 'self', kind: 'watch' })], lease: null, nowMs: NOW })
  assert.equal(d.action, 'none')
  assert.equal(d.leaderId, null)
})

// ─────────────────────────────────────────── 坏数据

test('parseLease：坏数据一律 null（选举不因坏文件停摆）', () => {
  assert.equal(parseLease(null), null)
  assert.equal(parseLease([]), null)
  assert.equal(parseLease({}), null)
  assert.equal(parseLease({ owner: '', epoch: 1, atMs: NOW, ttlMs: 1000 }), null)
  assert.equal(parseLease({ owner: 'a', epoch: -1, atMs: NOW, ttlMs: 1000 }), null)
  assert.equal(parseLease({ owner: 'a', epoch: 1, atMs: NOW, ttlMs: 0 }), null)
  assert.equal(parseLease({ owner: 'a', epoch: 1, atMs: Number.NaN, ttlMs: 1000 }), null)
})

test('parseLease：合法租约原样返回（往返一致）', () => {
  const lease = { owner: 'a', epoch: 12, atMs: NOW, ttlMs: 90_000 }
  assert.deepEqual(parseLease(JSON.parse(JSON.stringify(lease))), lease)
})

// ─────────────────────────────────────────── 文案

test('describeLeader：无主 / 有主两种形态都说得出理由', () => {
  const none = decideLeader({ self: 's', candidates: [], lease: null, nowMs: NOW })
  assert.match(describeLeader(none, NOW, null), /主脑：无/)
  const lease = grantLease('self', 4, NOW, 90_000)
  const held = decideLeader({ self: 'self', candidates: [candidate({ nodeId: 'self' })], lease, nowMs: NOW })
  const line = describeLeader(held, NOW + 30_000, lease)
  assert.match(line, /主脑：self/)
  assert.match(line, /epoch 4/)
  assert.match(line, /租约剩 60s/)
})

test('describeLeader：租约失效时选出的是【待接管】而不是已就任（真实总线读出的自相矛盾句子）', () => {
  const expired = grantLease('desk', 1, NOW - 200_000, 90_000)
  const d = decideLeader({ self: 'desk', candidates: [candidate({ nodeId: 'desk' })], lease: expired, nowMs: NOW })
  const line = describeLeader(d, NOW, expired)
  assert.match(line, /待接管 desk/)
  assert.doesNotMatch(line, /租约剩/)
})

// ─────────────────────────────────────────── 语义精确性：「无租约」≠「租约已过期」
// 2026-09-23 真实总线实测：`state/` 里一个 primary-lease 文件都没有（从未选举过），
// 旧文案却报「租约失效」——让操作者以为曾有主脑而任期中断。两种状态必须措辞不同。

test('decideLeader：从未选举过的总线上，理由必须说【无租约】而不是【租约已过期】', () => {
  const d = decideLeader({ self: 'web', candidates: [candidate({ nodeId: 'desk' })], lease: null, nowMs: NOW })
  assert.equal(d.action, 'none')
  assert.match(d.reason, /无租约（本网络尚未选举）/)
  assert.doesNotMatch(d.reason, /租约已过期/)
  assert.match(d.reason, /宣布接管 epoch 1/)
})

test('decideLeader：租约确实过期时，理由必须点名原持有者与它的 epoch', () => {
  const expired = grantLease('old', 7, NOW - 200_000, 90_000)
  const d = decideLeader({ self: 'web', candidates: [candidate({ nodeId: 'desk' })], lease: expired, nowMs: NOW })
  assert.equal(d.action, 'none')
  assert.match(d.reason, /租约已过期（原持有者 old，epoch 7）/)
  assert.doesNotMatch(d.reason, /尚未选举/)
  // 接管 epoch 必须单调递增：7 + 1
  assert.match(d.reason, /宣布接管 epoch 8/)
})

test('decideLeader：本节点胜出时，理由同样区分【无租约】与【已过期】', () => {
  const fresh = decideLeader({ self: 'me', candidates: [candidate({ nodeId: 'me' })], lease: null, nowMs: NOW })
  assert.equal(fresh.action, 'take')
  assert.match(fresh.reason, /无租约（本网络尚未选举）/)
  assert.match(fresh.reason, /接管 epoch 1/)

  const expired = grantLease('old', 3, NOW - 200_000, 90_000)
  const after = decideLeader({ self: 'me', candidates: [candidate({ nodeId: 'me' })], lease: expired, nowMs: NOW })
  assert.equal(after.action, 'take')
  assert.match(after.reason, /租约已过期（原持有者 old，epoch 3）/)
  assert.match(after.reason, /接管 epoch 4/)
})

// ─────────────────────────── 能力是硬前提（2026-09-23 真实总线活性缺陷的修复）

test('canLead：不具备主脑协议的节点**不合格**（尸体样本）', () => {
  const no = canLead(candidate({ leaderCapable: false }))
  assert.equal(no.ok, false)
  assert.match(no.why, /不具备主脑协议/)
  assert.equal(canLead(candidate()).ok, true, '对照组：同一批断言对好样本必须全绿')
})

test('活性回归：不具备协议的「更新鲜」节点不得抢走主脑，本节点必须能接管', () => {
  // 真实总线实测形状：`tavern-3081` 心跳恒比本节点新鲜，而它的构建早于 leader.ts
  // ⇒ 旧判据（只按 在线+新鲜度 定序）把主脑判给它，而它**永远不会 claim** ⇒ 网络永久无主。
  const candidates = [
    candidate({ nodeId: 'tavern-3081', ageMs: 0, leaderCapable: false }),
    candidate({ nodeId: 'me', ageMs: 6_000 }),
  ]
  const d = decideLeader({ self: 'me', candidates, lease: null, nowMs: NOW })
  assert.equal(d.leaderId, 'me', '不具备协议的节点不能当主脑——哪怕它更新鲜')
  assert.equal(d.action, 'take', '本节点是唯一合格者 ⇒ 必须接管，而不是空等')
})

test('活性回归：若全网无人具备协议 ⇒ 无主态（而不是判给一个不会宣布的节点）', () => {
  const d = decideLeader({
    self: 'me',
    candidates: [candidate({ nodeId: 'a', leaderCapable: false }), candidate({ nodeId: 'b', leaderCapable: false })],
    lease: null,
    nowMs: NOW,
  })
  assert.equal(d.leaderId, null, '宁可显式无主，也不假造一个主脑')
  assert.equal(d.action, 'none')
  assert.match(d.reason, /无合格候选/)
})

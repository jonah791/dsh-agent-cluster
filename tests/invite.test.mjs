// 邀请令牌 —— 判据来源 docs/semantic.md §5.11（入网凭证）
//
// 纪律：① 每一条「拒绝」都配一个「该准入的准入」对照组（§5.9·2）；
//       ② 尸体样本用手工构造的**畸形令牌**，不是靠改代码去撞；
//       ③ 用模块自己的 canonical/指纹函数构造样本——这样指纹是**对的**，
//          从而把被测的那一道检查单独隔离出来（否则所有拒绝都退化成「指纹错」）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_INVITE_TTL_MS,
  INVITE_PREFIX,
  OPEN_INVITE_MEMBER,
  canonicalInviteJson,
  decideJoin,
  describeInvite,
  inviteFingerprint,
  mintInvite,
  parseInvite,
  redactToken,
} from '../lib/invite.js'

const NOW = Date.parse('2026-09-22T06:00:00Z')

const mint = (over = {}) => mintInvite({
  net: 'alice-net', url: 'http://127.0.0.1:3099', host: 'host-0', member: 'guest-1',
  nowMs: NOW, secret: 'a'.repeat(32), nonce: 'n-1', ...over,
})

/** 手工构造令牌（指纹默认正确）——用来隔离单条检查。 */
const craft = (payload, fpOverride) => {
  const body = Buffer.from(canonicalInviteJson(payload), 'utf8').toString('base64url')
  return INVITE_PREFIX + '.' + body + '.' + (fpOverride ?? inviteFingerprint(payload))
}
const basePayload = (over = {}) => ({
  v: 1, net: 'alice-net', url: 'http://127.0.0.1:3099', host: 'host-0', member: 'guest-1',
  secret: 'b'.repeat(32), exp: NOW + 3600_000, nonce: 'n-2', ...over,
})

test('对照组：自己签发的令牌能解回来，字段逐项一致', () => {
  const m = mint()
  assert.equal(m.ok, true)
  const r = parseInvite(m.token, { nowMs: NOW })
  assert.equal(r.ok, true, r.detail)
  assert.equal(r.reason, 'ok')
  assert.equal(r.invite.net, 'alice-net')
  assert.equal(r.invite.host, 'host-0')
  assert.equal(r.invite.member, 'guest-1')
  assert.equal(r.invite.secret, 'a'.repeat(32))
  assert.equal(r.invite.exp, NOW + DEFAULT_INVITE_TTL_MS)
})

test('每张令牌的密钥与 nonce 都是**新生成**的（一个令牌泄露 ≠ 全网钥匙外流）', () => {
  const a = mintInvite({ net: 'n', url: 'http://127.0.0.1:1', host: 'h', member: 'm1', nowMs: NOW })
  const b = mintInvite({ net: 'n', url: 'http://127.0.0.1:1', host: 'h', member: 'm2', nowMs: NOW })
  assert.notEqual(a.invite.secret, b.invite.secret)
  assert.notEqual(a.invite.nonce, b.invite.nonce)
  assert.equal(a.invite.secret.length, 64, '32 字节 → 64 hex')
})

test('篡改载荷 → 指纹不符（传输被改动/截断要能被抓住，而不是拿去用）', () => {
  const m = mint()
  const parts = m.token.split('.')
  const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  decoded.member = 'attacker'                       // 想把自己改成别人
  const forged = craft(decoded, parts[2])           // 载荷换了、指纹留着旧的
  const r = parseInvite(forged, { nowMs: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'bad-fingerprint')
})

test('截断令牌 → 明确报「载荷不合法」，不抛异常', () => {
  const m = mint()
  const r = parseInvite(m.token.slice(0, Math.floor(m.token.length / 2)), { nowMs: NOW })
  assert.equal(r.ok, false)
  assert.match(r.reason, /bad-payload|bad-fingerprint/)
})

test('前缀不对 / 空 / 非字符串 / 段数不对 —— 各自给不同的理由（不糊成一个「无效」）', () => {
  assert.equal(parseInvite('', { nowMs: NOW }).reason, 'empty')
  assert.equal(parseInvite('   ', { nowMs: NOW }).reason, 'empty')
  assert.equal(parseInvite(null, { nowMs: NOW }).reason, 'empty')
  assert.equal(parseInvite(42, { nowMs: NOW }).reason, 'empty')
  assert.equal(parseInvite('dshc9.abc.def', { nowMs: NOW }).reason, 'bad-prefix')
  assert.equal(parseInvite('只有一段', { nowMs: NOW }).reason, 'bad-payload')
  assert.equal(parseInvite('a.b.c.d', { nowMs: NOW }).reason, 'bad-payload')
})

test('过期 → 理由里带**到期时刻**（知道「什么时候死的」，不是只有「死了」）', () => {
  const r = parseInvite(craft(basePayload({ exp: NOW - 1000 })), { nowMs: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'expired')
  assert.match(r.detail, /2026-09-2\dT/, 'detail 必须写出到期 ISO 时刻')
})

test('过期判定只在给了 nowMs 时生效（纯函数不偷看系统时钟）', () => {
  const token = craft(basePayload({ exp: NOW - 1000 }))
  assert.equal(parseInvite(token).ok, true, '不给 nowMs 就不做过期检查——时钟由调用方注入')
})

test('准入身份不是我 → wrong-member，并说清「准入谁 / 我是谁」', () => {
  const r = parseInvite(craft(basePayload({ member: 'someone-else' })), { nowMs: NOW, expectMember: 'me-0' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'wrong-member')
  assert.ok(r.detail.includes('someone-else') && r.detail.includes('me-0'))
})

test('版本不对 → bad-version（未来格式要能被认出来，而不是当坏 JSON 丢掉）', () => {
  const r = parseInvite(craft(basePayload({ v: 2 })), { nowMs: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'bad-version')
})

test('缺字段 / 密钥过短 → missing-field（逐字段报，不笼统说「格式错」）', () => {
  for (const drop of ['net', 'url', 'host', 'member', 'secret', 'exp', 'nonce']) {
    const p = basePayload()
    delete p[drop]
    const r = parseInvite(craft(p), { nowMs: NOW })
    assert.equal(r.ok, false, drop + ' 缺失应被拒')
    assert.equal(r.reason, 'missing-field')
    assert.match(r.detail, new RegExp(drop), 'detail 要点出是哪个字段：' + drop)
  }
  const short = parseInvite(craft(basePayload({ secret: 'abc' })), { nowMs: NOW })
  assert.equal(short.reason, 'missing-field')
  assert.match(short.detail, /过短/)
})

test('签发侧也拒非法字段：含空白/控制字符的成员名不许进令牌（它会被拿去拼 URL/路径）', () => {
  for (const bad of ['has space', 'tab\there', '', 'x'.repeat(300)]) {
    const m = mintInvite({ net: 'n', url: 'http://127.0.0.1:1', host: 'h', member: bad, nowMs: NOW })
    assert.equal(m.ok, false, JSON.stringify(bad) + ' 应被拒')
    assert.match(m.detail, /member/)
  }
})

test('decideJoin 对照组：网络对、没过期、没用过、身份对 → 准入', () => {
  const d = decideJoin(basePayload(), { net: 'alice-net', nowMs: NOW, expectedMember: 'guest-1', seenNonce: () => false })
  assert.equal(d.admit, true)
  assert.equal(d.reason, 'ok')
})

test('decideJoin 四条拒绝各就其位（网络不符 / 过期 / 重放 / 身份不符）', () => {
  const p = basePayload()
  const notMine = decideJoin(p, { net: '别的网络', nowMs: NOW })
  assert.equal(notMine.reason, 'not-my-network')
  assert.ok(notMine.detail.includes('别的网络'))

  const expired = decideJoin(basePayload({ exp: NOW - 1 }), { net: 'alice-net', nowMs: NOW })
  assert.equal(expired.reason, 'expired')

  const replay = decideJoin(p, { net: 'alice-net', nowMs: NOW, seenNonce: (n) => n === 'n-2' })
  assert.equal(replay.reason, 'replay')
  assert.match(replay.detail, /n-2/)

  const mismatch = decideJoin(p, { net: 'alice-net', nowMs: NOW, expectedMember: '冒名者' })
  assert.equal(mismatch.reason, 'member-mismatch')
})

test('凭据输出卫生：describeInvite **绝不**回显密钥（令牌会流经聊天与日志）', () => {
  const m = mint()
  const line = describeInvite(m.invite)
  assert.ok(line.includes('alice-net'))
  assert.ok(line.includes('guest-1'))
  assert.ok(line.includes('密钥已隐去'))
  assert.equal(line.includes(m.invite.secret), false, '密钥不得出现在可打印描述里')
})

test('redactToken：保留前缀与指纹、隐去载荷正文（失败时也要能安全记日志）', () => {
  const m = mint()
  const red = redactToken(m.token)
  assert.ok(red.startsWith(INVITE_PREFIX + '.'))
  assert.equal(red.includes(m.invite.secret), false)
  assert.ok(red.includes('字符>'))
  assert.equal(redactToken('不是令牌'), '（非令牌形状，已隐去）')
})

test('解析面绝不抛：喂一组敌意输入仍然返回结构完整的结论', () => {
  const hostile = [null, undefined, 0, {}, [], 'dshc1..', 'dshc1.' + 'x'.repeat(5) + '.', '...', '\u0000', 'dshc1.@@@.###']
  for (const bad of hostile) {
    const r = parseInvite(bad, { nowMs: NOW })
    assert.equal(typeof r.ok, 'boolean')
    assert.equal(r.ok, false)
    assert.equal(typeof r.reason, 'string')
    assert.ok(r.detail.length > 0, '失败必须带 detail')
  }
})

test('开放令牌（member=*）：身份自报，但仍受网络/期限/重放约束；绑定令牌照旧拦「不是我」', () => {
  const open = mintInvite({ net: 'alice-net', url: 'http://127.0.0.1:1', host: 'host-0', member: OPEN_INVITE_MEMBER, nowMs: NOW })
  const r = parseInvite(open.token, { nowMs: NOW, expectMember: '任何自报身份' })
  assert.equal(r.ok, true, '开放令牌不该被「不是我」拦住')
  assert.match(r.detail, /开放令牌/)
  // 开放 ≠ 无约束：网络、期限、重放三条照旧
  assert.equal(decideJoin(open.invite, { net: '别的网络', nowMs: NOW }).reason, 'not-my-network')
  assert.equal(decideJoin(open.invite, { net: 'alice-net', nowMs: NOW + DEFAULT_INVITE_TTL_MS + 1 }).reason, 'expired')
  assert.equal(decideJoin(open.invite, { net: 'alice-net', nowMs: NOW, seenNonce: () => true }).reason, 'replay')
  assert.equal(decideJoin(open.invite, { net: 'alice-net', nowMs: NOW }).admit, true, '对照组：干净条件下应当准入')
  // 对照：绑定令牌的行为不因开放令牌的存在而松动
  const bound = mintInvite({ net: 'alice-net', url: 'http://127.0.0.1:1', host: 'host-0', member: 'guest-1', nowMs: NOW })
  assert.equal(parseInvite(bound.token, { nowMs: NOW, expectMember: 'me-0' }).reason, 'wrong-member')
  assert.equal(decideJoin(bound.invite, { net: 'alice-net', nowMs: NOW, expectedMember: '冒名者' }).reason, 'member-mismatch')
})

test('开放令牌的成员名可以签发，但**不该**悄悄改变绑定令牌的语义（mint 侧不擅自替换）', () => {
  const open = mintInvite({ net: 'n', url: 'http://127.0.0.1:1', host: 'h', member: OPEN_INVITE_MEMBER, nowMs: NOW })
  assert.equal(open.ok, true)
  assert.equal(open.invite.member, OPEN_INVITE_MEMBER, '签发侧必须原样保留，不许自作主张换成别的 id')
})

test('同一载荷生成同一指纹（指纹必须可复现，否则「传输损坏」与「内容改动」分不开）', () => {
  const p = basePayload()
  assert.equal(inviteFingerprint(p), inviteFingerprint({ ...p }))
  assert.notEqual(inviteFingerprint(p), inviteFingerprint({ ...p, member: 'x' }))
})

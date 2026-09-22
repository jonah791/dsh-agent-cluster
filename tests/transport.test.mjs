// 传输适配器层 —— 判据来源 docs/members.md §5（网络层）与 §4（身份与信任）
//
// 本组测试的纪律：**每一个「拒」都配一个「该放行的放行」对照组**——
// 否则一个「永远 401」的实现也能让所有安全断言全绿（§5.9·2 判据必须有分辨力）。
// 端到端用**真 node:http 监听**（不是 fetch 替身）：跨机承载的价值恰恰在「真的过网络」。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canAcceptFrom,
  decideInbound,
  parseMemberRecord,
  peerUrlRejection,
  signBody,
  signingPayload,
  verifySignature,
} from '../lib/transport.js'
import { INBOX_PATH, PING_PATH, pushToPeer, readMembers, startHttpNode } from '../lib/http-node.js'

const NOW = Date.parse('2026-09-22T06:00:00Z')
const SECRET = 'test-secret-0123456789'
const silentTrace = () => true

test('签名与验签：正确通过；错密钥 / 篡改 / 过期 / 缺签名 各自给出**可诊断的原因**', () => {
  const body = '{"id":"m-1"}'
  const sig = signBody(SECRET, body, NOW)
  assert.equal(verifySignature({ secret: SECRET, body, timestampMs: NOW, signature: sig, nowMs: NOW }).ok, true)
  assert.equal(verifySignature({ secret: '别的密钥', body, timestampMs: NOW, signature: sig, nowMs: NOW }).reason, 'mismatch')
  assert.equal(verifySignature({ secret: SECRET, body: body + ' ', timestampMs: NOW, signature: sig, nowMs: NOW }).reason, 'mismatch')
  assert.equal(verifySignature({ secret: SECRET, body, timestampMs: NOW, signature: '', nowMs: NOW }).reason, 'no-signature')
  assert.equal(verifySignature({ secret: '', body, timestampMs: NOW, signature: sig, nowMs: NOW }).reason, 'no-secret')
  assert.equal(verifySignature({ secret: SECRET, body, timestampMs: NOW, signature: sig, nowMs: NOW + 10 * 60 * 1000 }).reason, 'expired')
  assert.equal(verifySignature({ secret: SECRET, body, timestampMs: Number.NaN, signature: sig, nowMs: NOW }).reason, 'bad-timestamp')
})

test('时间戳被绑进被签名内容：只改时间戳而不重签必被检出（防重放窗口被绕过）', () => {
  const body = 'x'
  const sig = signBody(SECRET, body, NOW)
  // 同一个签名配一个新时间戳（攻击者想「续命」）⇒ 必须失败
  assert.equal(verifySignature({ secret: SECRET, body, timestampMs: NOW + 1000, signature: sig, nowMs: NOW + 1000 }).ok, false)
  assert.equal(signingPayload(NOW, body), String(Math.floor(NOW)) + '.' + body, '载荷形状是契约的一部分')
})

test('成员记录解析：输入不可信 ⇒ 坏数据返回 null，缺 trust 一律降为 unknown', () => {
  assert.equal(parseMemberRecord(null), null)
  assert.equal(parseMemberRecord({}), null, '缺 memberId 必须拒')
  assert.equal(parseMemberRecord({ memberId: '' }), null)
  const bare = parseMemberRecord({ memberId: 'peer-a' })
  assert.equal(bare.trust, 'unknown', '没声明信任级 ⇒ 默认 unknown（fail-closed）')
  assert.equal(bare.kind, 'peer')
  assert.deepEqual(bare.capabilities, [])
  const full = parseMemberRecord({ memberId: 'peer-a', kind: 'adapter', trust: 'known', capabilities: ['fs.write', 42, ''], protocol: 'v1', endpoint: 'https://x' })
  assert.equal(full.kind, 'adapter')
  assert.deepEqual(full.capabilities, ['fs.write'], '非字符串能力被过滤')
})

test('成员准入：own/known 放行，unknown 与不在册一律拒（挡住「自称即成员」）', () => {
  const members = [
    parseMemberRecord({ memberId: 'me', kind: 'self', trust: 'own' }),
    parseMemberRecord({ memberId: 'friend', kind: 'peer', trust: 'known' }),
    parseMemberRecord({ memberId: 'stranger', kind: 'peer' }), // trust 缺省 = unknown
  ]
  assert.equal(canAcceptFrom(members, 'me'), true)
  assert.equal(canAcceptFrom(members, 'friend'), true)
  assert.equal(canAcceptFrom(members, 'stranger'), false, 'unknown 必须拒')
  assert.equal(canAcceptFrom(members, 'never-heard-of'), false)
  assert.equal(canAcceptFrom(members, ''), false)
})

test('出站地址策略：https 或本机回环放行；明文 http 到非回环**拒发**', () => {
  assert.equal(peerUrlRejection('https://peer.example.com/cluster/inbox'), null)
  assert.equal(peerUrlRejection('http://127.0.0.1:8788/cluster/inbox'), null, '回环明文允许（本机测试/同机第二实例）')
  assert.equal(peerUrlRejection('http://localhost:8788/cluster/inbox'), null)
  assert.equal(peerUrlRejection('http://peer.example.com/cluster/inbox'), 'plaintext-http-to-non-loopback')
  assert.equal(peerUrlRejection('ftp://peer.example.com'), 'scheme-not-allowed')
  assert.equal(peerUrlRejection('不是 url'), 'not-a-url')
  assert.equal(peerUrlRejection(''), 'empty-url')
})

test('入站准入（纯判定）：未开入站 503 / 错签名 401 / 非成员 403 / 空正文 400 / 正常 ok', () => {
  const members = [parseMemberRecord({ memberId: 'friend', kind: 'peer', trust: 'known' })]
  const body = '{"hello":1}'
  const base = { memberId: 'friend', body, secret: SECRET, members, nowMs: NOW, timestampMs: NOW }
  const sig = signBody(SECRET, body, NOW)

  assert.deepEqual(decideInbound({ ...base, allowInbound: false, signature: sig }), { ok: false, status: 503, reason: 'inbound-disabled' })
  assert.deepEqual(decideInbound({ ...base, allowInbound: true, signature: sig }).ok, true, '对照：配好了必须能收')
  assert.deepEqual(decideInbound({ ...base, allowInbound: true, signature: signBody('坏密钥', body, NOW) }), { ok: false, status: 401, reason: 'signature-mismatch' })
  assert.deepEqual(decideInbound({ ...base, allowInbound: true, signature: '' }).reason, 'signature-no-signature')
  assert.deepEqual(decideInbound({ ...base, memberId: 'stranger', allowInbound: true, signature: signBody(SECRET, body, NOW) }), { ok: false, status: 403, reason: 'not-a-member' })
  assert.deepEqual(decideInbound({ ...base, allowInbound: true, body: '', signature: signBody(SECRET, '', NOW) }), { ok: false, status: 400, reason: 'empty-body' })
})

test('端到端：真监听 + 真推送——正确密钥送达，错密钥/非成员/未开入站 各自被拒', async () => {
  const received = []
  const node = await startHttpNode({
    port: 0,
    secret: SECRET,
    allowInbound: true,
    members: () => [parseMemberRecord({ memberId: 'sender-a', kind: 'peer', trust: 'known' })],
    onInbound: (b, from) => received.push({ b, from }),
    trace: silentTrace,
    nowMs: () => Date.now(),
  })
  try {
    const url = 'http://127.0.0.1:' + String(node.port) + INBOX_PATH
    // ① 正常路径：必须送达（对照组——没有它，下面三个「拒」可能只是因为整个链路是坏的）
    const ok = await pushToPeer({ url, secret: SECRET, body: '{"kind":"event","n":1}', fromMemberId: 'sender-a' })
    assert.equal(ok.ok, true, '正常推送必须成功：' + JSON.stringify(ok))
    assert.equal(received.length, 1)
    assert.equal(received[0].from, 'sender-a')
    assert.match(received[0].b, /"n":1/)

    // ② 错密钥 → 401 且正文**没有**进 onInbound
    const bad = await pushToPeer({ url, secret: 'wrong-secret', body: '{"n":2}', fromMemberId: 'sender-a' })
    assert.equal(bad.ok, false)
    assert.equal(bad.status, 401, '错密钥必须 401，实际：' + JSON.stringify(bad))
    assert.equal(received.length, 1, '被拒的正文不得进入投递')

    // ③ 非成员（不在册）→ 403
    const stranger = await pushToPeer({ url, secret: SECRET, body: '{"n":3}', fromMemberId: 'never-heard-of' })
    assert.equal(stranger.ok, false)
    assert.equal(stranger.status, 403, '非成员必须 403，实际：' + JSON.stringify(stranger))
    assert.equal(received.length, 1)

    // ④ 存活探针：未认证但只回协议版本
    const ping = await fetch('http://127.0.0.1:' + String(node.port) + PING_PATH)
    assert.equal(ping.status, 200)
    const pingBody = await ping.json()
    assert.deepEqual(Object.keys(pingBody).sort(), ['ok', 'protocol'], '探针不得泄漏其他信息')

    // ⑤ 别的路径 → 404（不猜测）
    const wrong = await fetch(url.replace(INBOX_PATH, '/cluster/anything'))
    assert.equal(wrong.status, 404)
  } finally {
    await node.close()
  }
})

test('端到端：入站关闭时 503（默认关闭 = 不配置时行为与加网络前相同）', async () => {
  const node = await startHttpNode({
    port: 0,
    secret: SECRET,
    allowInbound: false,
    members: () => [parseMemberRecord({ memberId: 'sender-a', kind: 'peer', trust: 'known' })],
    onInbound: () => assert.fail('未开入站时绝不能有投递'),
    trace: silentTrace,
  })
  try {
    const url = 'http://127.0.0.1:' + String(node.port) + INBOX_PATH
    const r = await pushToPeer({ url, secret: SECRET, body: '{"n":9}', fromMemberId: 'sender-a' })
    assert.equal(r.status, 503, '实际：' + JSON.stringify(r))
  } finally {
    await node.close()
  }
})

test('出站策略在**网络之前**生效：不合规地址根本不发请求', async () => {
  let called = 0
  const spy = async () => {
    called += 1
    return new Response('{}', { status: 200 })
  }
  const r = await pushToPeer({ url: 'http://peer.example.com/x', secret: SECRET, body: '{}', fromMemberId: 'a', fetchImpl: spy })
  assert.equal(r.ok, false)
  assert.match(r.reason, /plaintext-http-to-non-loopback/)
  assert.equal(called, 0, '不合规地址必须**连请求都不发**（fail-closed）')
  const r2 = await pushToPeer({ url: 'http://127.0.0.1:1/x', secret: '', body: '{}', fromMemberId: 'a', fetchImpl: spy })
  assert.equal(r2.reason, 'no-secret')
  assert.equal(called, 0)
})

test('成员册读取：目录不存在算空册；坏文件进 skipped（不抛进主流程）', () => {
  // 夹具用**文件名**作键（readMembers 的 listDir 契约是「名字」不是路径，与 readdirSync 一致）
  const files = {
    'peer-a.json': JSON.stringify({ memberId: 'peer-a', trust: 'known' }),
    'broken.json': '{ 不是 JSON',
    'no-id.json': JSON.stringify({ trust: 'known' }),
    'readme.txt': 'ignored',
  }
  const inv = readMembers('/m', () => Object.keys(files), (p) => files[p.split('/').pop()], parseMemberRecord)
  assert.deepEqual(inv.members.map((m) => m.memberId), ['peer-a'])
  assert.deepEqual(inv.skipped.sort(), ['broken.json', 'no-id.json'])
  const missing = readMembers('/nope', () => { throw new Error('ENOENT') }, () => '', parseMemberRecord)
  assert.deepEqual(missing, { members: [], skipped: [] })
})

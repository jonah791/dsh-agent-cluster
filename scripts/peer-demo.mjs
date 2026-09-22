#!/usr/bin/env node
/**
 * peer-demo.mjs — 跨机承载的**可跑证据**（照着跑就能看见消息真的过网络）。
 *
 * 为什么要有它：`docs/members.md` §6 明确写了「本期的目标不是让交换发生，而是让互联在技术上
 * **可行且可验证**」。单测证明的是函数行为；这个脚本证明的是**两个真实端点之间的投递**，
 * 并把线级的判据（签名头、拒绝码、正文落点）打印出来——「看起来对」不算证据。
 *
 * 用法（在 `self-plugins/dsh-agent-cluster` 下）：
 *   node scripts/peer-demo.mjs
 * 退出码：0 = 全部判据成立；1 = 有判据不成立（可直接当 CI 闸门）。
 *
 * @module dsh-agent-cluster/scripts/peer-demo
 */
import { parseMemberRecord } from '../lib/transport.js'
import { pushToPeer, startHttpNode, INBOX_PATH, PING_PATH } from '../lib/http-node.js'

const SECRET = 'demo-secret-' + process.pid
const results = []
/** 记录一条判据结果并打印。 */
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail === undefined ? '' : '  —  ' + detail))
}

/** 采集轨迹（demo 里直接打出来，便于肉眼核对「为什么拒」）。 */
const events = []
const trace = (event, fields) => {
  events.push([event, fields])
  return true
}

const members = [
  parseMemberRecord({ memberId: 'demo-sender', kind: 'peer', trust: 'known', capabilities: ['fs.assert'] }),
  parseMemberRecord({ memberId: 'demo-stranger', kind: 'peer' }), // 无 trust ⇒ unknown
]

console.log('【1】起一个真实的入站端点（端口 0 = 系统分配）')
const inbox = []
const node = await startHttpNode({
  port: 0,
  secret: SECRET,
  allowInbound: true,
  members: () => members,
  onInbound: (body, from) => inbox.push({ body, from }),
  trace,
})
const url = 'http://127.0.0.1:' + String(node.port) + INBOX_PATH
console.log('     端点 = ' + url)
check('监听成功且拿到真实端口', node.port > 0, 'port=' + String(node.port))

try {
  console.log('【2】正常投递：必须送达（对照组——没有它，下面的「拒」可能只是因为链路整个坏了）')
  const ok = await pushToPeer({ url, secret: SECRET, body: JSON.stringify({ kind: 'event', text: 'hello from peer' }), fromMemberId: 'demo-sender' })
  check('推送返回 ok', ok.ok === true, 'HTTP ' + String(ok.status))
  check('对端 onInbound 收到正文', inbox.length === 1, '收到 ' + String(inbox.length) + ' 条')
  check('来源 id 正确', inbox[0]?.from === 'demo-sender', String(inbox[0]?.from))
  check('正文未被改动', inbox[0]?.body.includes('hello from peer') === true)

  console.log('【3】拒绝面：三组各有对照，且被拒正文不得进入投递')
  const before = inbox.length
  const bad = await pushToPeer({ url, secret: 'wrong-secret', body: '{"n":2}', fromMemberId: 'demo-sender' })
  check('错密钥 → 401', bad.status === 401, JSON.stringify(bad.reason ?? bad.status))
  const stranger = await pushToPeer({ url, secret: SECRET, body: '{"n":3}', fromMemberId: 'demo-stranger' })
  check('未知成员（trust=unknown）→ 403', stranger.status === 403, JSON.stringify(stranger.reason ?? stranger.status))
  const ghost = await pushToPeer({ url, secret: SECRET, body: '{"n":4}', fromMemberId: 'nobody' })
  check('不在册的 id → 403', ghost.status === 403, JSON.stringify(ghost.reason ?? ghost.status))
  check('三次拒绝都没进投递', inbox.length === before, 'inbox 仍为 ' + String(inbox.length))

  console.log('【4】fail-closed：不合规地址**连请求都不发**；无密钥直接拒')
  let fetched = 0
  const spy = async () => {
    fetched += 1
    return new Response('{}', { status: 200 })
  }
  const plain = await pushToPeer({ url: 'http://peer.example.com/x', secret: SECRET, body: '{}', fromMemberId: 'demo-sender', fetchImpl: spy })
  check('明文 http 到非回环 → 拒发', plain.ok === false, String(plain.reason))
  const noKey = await pushToPeer({ url, secret: '', body: '{}', fromMemberId: 'demo-sender', fetchImpl: spy })
  check('无密钥 → 拒发', noKey.ok === false, String(noKey.reason))
  check('两条路径下 fetch 一次都没被调用', fetched === 0, 'fetch 调用数 = ' + String(fetched))

  console.log('【5】存活探针：未认证，但只回协议版本（不泄漏其他信息）')
  const ping = await fetch('http://127.0.0.1:' + String(node.port) + PING_PATH)
  const pingBody = await ping.json()
  check('探针 200 且只含 ok/protocol', ping.status === 200 && Object.keys(pingBody).sort().join(',') === 'ok,protocol', JSON.stringify(pingBody))

  console.log('\n线级轨迹（回答「为什么收 / 为什么拒」）：')
  for (const [ev, f] of events) console.log('  · ' + ev + ' ' + JSON.stringify(f ?? {}))
} finally {
  await node.close()
}

const failed = results.filter((r) => !r.ok)
console.log('\n判据：' + String(results.length - failed.length) + '/' + String(results.length) + ' 成立')
if (failed.length > 0) {
  console.log('未成立：' + failed.map((f) => f.name).join('、'))
  process.exit(1)
}
console.log('✅ 跨机承载可用（同机双端点验证；真实第二台机器未验证）')

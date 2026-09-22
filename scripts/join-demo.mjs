// 入网流程的可跑证据 —— 判据来源 docs/semantic.md §5.11
//
// 纪律：**每一个「拒」都配一个「该准入的准入」对照组**（§5.9·2：一个永远回 403 的实现
// 也能让所有拒绝断言全绿）。这里用**真 node:http 监听**（port 0 取系统分配）+ **真裁决函数**
// （`createJoinHandler`，与插件线上跑的是同一份代码，不是第二份实现）。
//
// 跑法：node scripts/join-demo.mjs    （exit 0 = 全过，可直接当闸门）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JOIN_PATH, postJson, startHttpNode } from '../lib/http-node.js'
import { mintInvite, parseInvite } from '../lib/invite.js'
import { createJoinHandler } from '../lib/join.js'
import { parseMemberRecord } from '../lib/transport.js'

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✔ ' + name + (detail !== '' ? ' — ' + detail : '')) }
  else { fail++; console.log('  ✖ ' + name + (detail !== '' ? ' — ' + detail : '')) }
}

/** 极简成员册（一个目录一份 JSON），与线上同一形状。 */
const makeStore = (dir) => {
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    write: (rec) => {
      try { writeFileSync(join(dir, rec.memberId + '.json'), JSON.stringify(rec, null, 2)); return { ok: true } }
      catch (e) { return { ok: false, error: String(e) } }
    },
    read: (id) => {
      try { return parseMemberRecord(JSON.parse(readFileSync(join(dir, id + '.json'), 'utf8'))) }
      catch { return null }
    },
    list: () => readdirSync(dir).filter((n) => n.endsWith('.json'))
      .map((n) => { try { return parseMemberRecord(JSON.parse(readFileSync(join(dir, n), 'utf8'))) } catch { return null } })
      .filter((r) => r !== null),
    has: (id) => existsSync(join(dir, id + '.json')),
  }
}

const silent = () => true
const root = mkdtempSync(join(tmpdir(), 'join-demo-'))
const hostStore = makeStore(join(root, 'host', 'members'))
const guestStore = makeStore(join(root, 'guest', 'members'))
const usedNonces = []
let hostBase = ''
let node

try {
  // ── 主脑侧 ──
  const hostJoins = createJoinHandler({
    network: 'demo-net', nodeId: 'host-0', profile: 'host',
    nowMs: () => Date.now(), trace: silent,
    readUsedNonces: () => usedNonces, markNonceUsed: (n) => usedNonces.push(n),
    writeMember: hostStore.write,
    selfRecord: () => ({ memberId: 'host-0', kind: 'self', trust: 'known', capabilities: ['cluster'], protocol: 'v1', endpoint: hostBase }),
    myBaseUrl: () => hostBase,
    post: (url, body) => postJson({ url, body }),
  })
  // 入站端点：**入网路径不认证**（入网方此刻没有密钥），fail-closed 全在裁决里。
  node = await startHttpNode({
    port: 0,
    secret: 'host-network-secret-0123456789',
    allowInbound: true,
    members: () => hostStore.list(),
    onInbound: () => { throw new Error('本演示不应有入站消息') },
    onJoin: hostJoins.handleJoin,
    trace: silent,
  })
  hostBase = 'http://127.0.0.1:' + String(node.port)
  console.log('主脑端点 ' + hostBase + JOIN_PATH + '（真实监听，port ' + String(node.port) + '）')

  // ── 入网方侧（另一份 handler，真裁决） ──
  const guestJoins = createJoinHandler({
    network: 'demo-net', nodeId: 'guest-1', profile: 'guest',
    nowMs: () => Date.now(), trace: silent,
    readUsedNonces: () => [], markNonceUsed: () => {},
    writeMember: guestStore.write,
    selfRecord: () => ({ memberId: 'guest-1', kind: 'self', trust: 'known', capabilities: [], protocol: 'v1' }),
    myBaseUrl: () => 'http://127.0.0.1:3999',
    post: (url, body) => postJson({ url, body }),
  })

  const postJoin = async (url, payload) => {
    const r = await postJson({ url, body: JSON.stringify(payload) })
    let body = null
    try { body = JSON.parse(r.body) } catch { body = null }
    return { r, body }
  }

  console.log('\n[1] 对照组：一次正常的入网')
  const minted = hostJoins.mintInviteFor({ member: 'guest-1' })
  check('令牌签发成功', minted.ok === true && minted.token.startsWith('dshc1.'), '前缀 ' + minted.token.slice(0, 6))
  check('签发即准入：主脑册子里**立刻**有该成员', hostStore.has('guest-1'))
  check('令牌描述**不回显密钥**', !minted.inviteLine.includes(hostStore.read('guest-1').secret), minted.inviteLine)

  const out = await guestJoins.joinNetwork(minted.token)
  check('入网成功', out.ok === true && out.host === 'host-0' && out.member === 'guest-1', JSON.stringify(out))
  check('主脑册子里 guest 带**专属**密钥', hostStore.read('guest-1')?.secret !== undefined)
  check('guest 册子里有主脑记录', guestStore.read('host-0') !== null)
  const hostSideSecret = hostStore.read('guest-1')?.secret
  const guestSideSecret = guestStore.read('host-0')?.secret
  check('同一条边两边密钥一致（主脑出站签它、guest 入站验它）', hostSideSecret === guestSideSecret && hostSideSecret !== 'host-network-secret-0123456789',
    '专属密钥 ≠ 网络共享密钥：' + String(hostSideSecret !== 'host-network-secret-0123456789'))

  console.log('\n[2] 拒绝面：每一类都必须拒，且理由可诊断')
  // 重放：同一张令牌再来一次
  const replay = await postJoin(hostBase + JOIN_PATH, { token: minted.token, member: { memberId: 'guest-1', trust: 'known' } })
  check('重放同一张令牌 → 拒（replay）', replay.r.status === 403 && replay.body?.reason === 'replay', JSON.stringify(replay.body))

  // 篡改：改载荷里的一个字符
  const tampered = minted.token.slice(0, 40) + (minted.token[40] === 'A' ? 'B' : 'A') + minted.token.slice(41)
  const tamperedOut = await postJoin(hostBase + JOIN_PATH, { token: tampered, member: { memberId: 'guest-1', trust: 'known' } })
  check('篡改令牌 → 拒（指纹/载荷）', tamperedOut.r.status === 401, JSON.stringify(tamperedOut.body))

  // 过期：用 mintInvite 直接造一张昨天签发、一小时有效的令牌
  const stale = mintInvite({ net: 'demo-net', url: hostBase, host: 'host-0', member: 'guest-late', nowMs: Date.now() - 86_400_000, ttlMs: 3_600_000 })
  const expired = await postJoin(hostBase + JOIN_PATH, { token: stale.token, member: { memberId: 'guest-late', trust: 'known' } })
  check('过期令牌 → 拒（expired），且理由带到期时刻', expired.r.status === 401 && /expired/.test(String(expired.body?.reason)), JSON.stringify(expired.body))

  // 串网：令牌属于另一个网络
  const otherNet = mintInvite({ net: 'some-other-net', url: hostBase, host: 'host-0', member: 'guest-x', nowMs: Date.now() })
  const wrongNet = await postJoin(hostBase + JOIN_PATH, { token: otherNet.token, member: { memberId: 'guest-x', trust: 'known' } })
  check('别的网络的令牌 → 拒（not-my-network）', wrongNet.r.status === 403 && wrongNet.body?.reason === 'not-my-network', JSON.stringify(wrongNet.body))
  check('被拒的成员**没进**主脑册子', hostStore.has('guest-x') === false)

  // 冒名：令牌准入的不是请求者自报的身份
  const forOther = hostJoins.mintInviteFor({ member: 'guest-2' })
  const impostor = await postJoin(hostBase + JOIN_PATH, { token: forOther.token, member: { memberId: '冒名者', trust: 'known' } })
  check('令牌准入 A、请求者自报 B → 拒（member-mismatch）', impostor.r.status === 403 && impostor.body?.reason === 'member-mismatch', JSON.stringify(impostor.body))

  // 入网方本地就拦住「不是给我的令牌」
  let localReject = ''
  try {
    await guestJoins.joinNetwork(hostJoins.mintInviteFor({ member: 'someone-else' }).token)
  } catch (e) { localReject = e instanceof Error ? e.message : String(e) }
  check('令牌准入别人 → 入网方**本地**就拒（wrong-member），不发请求', localReject.includes('wrong-member'), localReject)

  // 坏 JSON
  const badJson = await postJoin(hostBase + JOIN_PATH, { token: 12345 })
  check('令牌字段类型不对 → 拒（带理由）', badJson.r.status === 401, JSON.stringify(badJson.body))

  console.log('\n[3] 副作用面')
  check('拒绝路径**不留**成员文件', hostStore.has('guest-late') === false && hostStore.has('冒名者') === false)
  check('被拒令牌的 nonce **未**被消耗（不存在的那张）', usedNonces.length === 1, '已用 nonce 数 = ' + String(usedNonces.length))
  check('令牌解析器对畸形输入不抛', (() => { try { parseInvite('dshc1.@@@.###', { nowMs: Date.now() }); return true } catch { return false } })())

  console.log('\n[4] 开放令牌（member=*）：给「还不知道对方节点 id」的场景')
  const openMinted = hostJoins.mintInviteFor({ member: '*' })
  check('开放令牌在输出里**明写风险**（不藏在文档里）', /开放令牌/.test(String(openMinted.warning ?? '')), String(openMinted.warning))
  check('开放令牌**不**在签发时造成员（此刻还没有具体成员，准入发生在入网那一刻）', hostStore.has('*') === false)
  const stranger = await postJoin(hostBase + JOIN_PATH, {
    token: openMinted.token,
    member: { memberId: 'stranger-9', trust: 'known', capabilities: ['cluster'], endpoint: 'http://127.0.0.1:4100' },
  })
  check('陌生实例凭开放令牌入网（身份自报）', stranger.r.status === 200 && stranger.body?.ok === true, JSON.stringify(stranger.body))
  check('册子里写的是**自报**身份', hostStore.has('stranger-9'))
  const anon = await postJoin(hostBase + JOIN_PATH, { token: hostJoins.mintInviteFor({ member: '*' }).token, member: null })
  check('开放令牌但**没自报**身份 → 拒（missing-claimant），不凭空造身份', anon.r.status === 400 && anon.body?.reason === 'missing-claimant', JSON.stringify(anon.body))

  console.log('\n结果：' + String(pass) + ' 通过 / ' + String(fail) + ' 失败')
} finally {
  if (node !== undefined) await node.close()
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响判据 */ }
}
process.exitCode = fail === 0 ? 0 : 1

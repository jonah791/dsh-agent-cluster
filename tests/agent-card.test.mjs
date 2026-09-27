/**
 * AgentCard 派生与解析回归测试（任务 t-1e1f5084）。
 *
 * 承重判据两条：
 *  ① **对照组（尸体）**：只有旧格式心跳的节点 ⇒ 缺的字段一律 `undeclared`，
 *     **不伪造默认值**（这是「诚实标注」的可证伪形式——若实现里写了 `?? 'desktop'`，本条必红）；
 *  ② **`verified` 缺席**：能力出现在声明里即 `claimed`，但**未实测就不得有 `verified`**
 *     ——「不许默认 verified」是这张卡存在的理由。
 *
 * 其余：来源三分正确（协议版本从心跳 v 推来是 `inferred` 而非 `declared`）、往返保真、
 * 畸形输入不抛、当前协议没有的来源（skills/auth）恒 `undeclared`。
 *
 * 诚实边界：被验的是**派生与标注**；「探针实测置位 verified」需跨节点任务机制，属 U 项未做。
 *
 * 运行：先构建（tsc），再 node --test tests/agent-card.test.mjs
 */
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

/** 路径解析：Windows 形态优先，缺失时回退 WSL 形态（夹具不得依赖运行平台）。 */
function pickRoot(winPath) {
  if (existsSync(winPath)) return winPath
  return winPath.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
}

const PLUGIN = process.env.DSH_CLUSTER_ROOT ?? pickRoot('E:/alice/self-plugins/dsh-agent-cluster')
const cardLib = `${PLUGIN}/lib/agent-card.js`

if (!existsSync(cardLib)) {
  console.error(`[skip] 缺少已构建产物：${cardLib}`)
  process.exit(0)
}

const { deriveAgentCard, parseAgentCard, renderCardSummary } = await import(pathToFileURL(cardLib).href)

/** 一份完整的新格式心跳（本插件当前写的形状）。 */
function newHeartbeat() {
  return {
    v: 1,
    nodeId: 'LAPTOP-web-0',
    role: '主脑',
    profile: 'web',
    workspace: 'E:\\alice',
    baseUrl: 'http://127.0.0.1:3080',
    port: 3080,
    pid: 1234,
    hostname: 'LAPTOP',
    startedAt: 1,
    atMs: 2,
    tags: ['main'],
    leaderCapable: true,
    kind: 'desktop',
  }
}

test('① 尸体：旧格式心跳（只有 v/nodeId/atMs）⇒ 缺的字段是「未声明」，不是默认值', () => {
  const old = { v: 1, nodeId: 'old-node', atMs: 2 }
  const card = deriveAgentCard(old)

  assert.equal(card.id.value, 'old-node')
  assert.equal(card.id.source, 'declared')

  // 每一处「本来可以顺手填个默认值」的地方，都必须保持未声明。
  for (const [name, f] of [['kind', card.kind], ['role', card.role], ['endpoint', card.endpoint]]) {
    assert.equal(f.source, 'undeclared', `${name} 缺声明必须 undeclared（伪造默认值 = 让名册撒谎）`)
    assert.equal(f.value, null, `${name} 未声明时值必须为 null`)
  }
  // 真实的老节点**也写 `v`**（心跳格式版本从第一版起就有）⇒ 协议版本能从它推断出来。
  // 所以它不在这份「必须未声明」的名单里，而是单独断言：**能推断就标推断，不许冒充实测/声明**。
  assert.equal(card.protocolVersion.source, 'inferred', '由心跳 v 推来属推断，标 declared 就是抬高证据')
  assert.equal(card.protocolVersion.value, 'heartbeat-v1')
  assert.deepEqual(card.capabilities, [], '旧心跳没有能力字段 ⇒ 空能力表（不是造一个出来）')
  assert.equal(card.skills.source, 'undeclared')
  assert.equal(card.auth.source, 'undeclared')

  // 反向对照：新格式心跳必须真的声明的声明、推断的推断（否则上面那条可能因「全都未声明」而假绿）
  const fresh = deriveAgentCard(newHeartbeat())
  assert.equal(fresh.kind.source, 'declared')
  assert.equal(fresh.kind.value, 'desktop')
})

test('② 承重：能力恒 claimed，未实测时 verified 必须缺席（不许默认 verified）', () => {
  const card = deriveAgentCard(newHeartbeat(), { memberId: 'web', capabilities: ['cluster', 'fs.write'] })

  const tags = card.capabilities.map((c) => c.tag).sort()
  assert.deepEqual(tags, ['cluster', 'fs.write', 'leader'],
    '能力 = 成员册 capabilities[] ∪ 心跳 leaderCapable（两个面都要合看）')

  for (const cap of card.capabilities) {
    assert.equal(cap.claimed, true, '出现在声明里即为自称')
    assert.equal('verified' in cap, false,
      `${cap.tag} 未实测 ⇒ verified 必须缺席；写 false 也是撒谎（false 等于宣称「验过且不行」）`)
    assert.equal('verifiedAt' in cap, false)
  }
})

test('③ 来源三分正确：协议版本从心跳 v 推来是「推断」，成员册 protocol 是「声明」', () => {
  const fromHeartbeat = deriveAgentCard(newHeartbeat())
  assert.equal(fromHeartbeat.protocolVersion.source, 'inferred',
    '心跳的 v 是心跳格式版本，当协议版本用属于推断——标成 declared 就是抬高证据')
  assert.equal(fromHeartbeat.protocolVersion.value, 'heartbeat-v1')
  assert.equal(fromHeartbeat.protocolVersion.from, 'heartbeat.v', '推断必须写明依据字段')

  const fromMember = deriveAgentCard(newHeartbeat(), { memberId: 'web', capabilities: [], protocol: 'v1' })
  assert.equal(fromMember.protocolVersion.source, 'declared')
  assert.equal(fromMember.protocolVersion.value, 'v1')

  // ttl 是本卡唯一的纯推断字段
  assert.equal(fromHeartbeat.ttl.source, 'inferred')
  assert.equal(fromHeartbeat.ttl.value, 30_000)
})

test('④ 往返保真：derive → JSON → parse 等价', () => {
  const card = deriveAgentCard(newHeartbeat(), { memberId: 'web', capabilities: ['cluster'], protocol: 'v1' })
  const round = parseAgentCard(JSON.parse(JSON.stringify(card)))
  assert.notEqual(round, null)
  assert.deepEqual(round, card, '往返必须逐字段等价（含 source 与 from）')
})

test('⑤ 畸形输入一律不抛：null / 数组 / 字符串 / 数字 / 成员册乱填', () => {
  for (const bad of [null, undefined, [], 'x', 42, true, { nodeId: 123 }, { capabilities: 'nope' }]) {
    assert.doesNotThrow(() => deriveAgentCard(bad), `derive 不得对 ${JSON.stringify(bad)} 抛错`)
  }
  assert.doesNotThrow(() => deriveAgentCard(newHeartbeat(), 'not-an-object'))
  assert.doesNotThrow(() => deriveAgentCard(newHeartbeat(), { capabilities: [1, '', null, 'ok', 'ok'] }))

  // 多余字段与版本不符都不得影响派生（形状宽松，值从严）
  const extra = deriveAgentCard({ ...newHeartbeat(), v: 99, a2a: { whatever: true }, kind: 'quantum' })
  assert.equal(extra.kind.value, 'quantum', '不认识的 kind 照原样如实呈现（判断归读的人，不归本模块）')
  assert.equal(extra.protocolVersion.value, 'heartbeat-v99')

  assert.equal(parseAgentCard(null), null)
  assert.equal(parseAgentCard('x'), null)
  assert.equal(parseAgentCard({}), null, '空对象不是卡片')
  assert.doesNotThrow(() => parseAgentCard({ capabilities: [{ tag: 1 }, {}, 'x'] }))
  assert.deepEqual(parseAgentCard({ capabilities: [{ tag: 1 }, {}, 'x'] }).capabilities, [],
    '畸形能力项跳过，不造占位')
})

test('⑥ 当前协议没有的来源恒「未声明」：skills / auth', () => {
  const rich = deriveAgentCard(newHeartbeat(), {
    memberId: 'web', capabilities: ['cluster'], protocol: 'v1',
    // 就算输入里塞了这些字段，也不认——它们不是本插件声明的来源，认了就是替对方说话
    skills: ['a'], auth: { scheme: 'none' },
  })
  assert.equal(rich.skills.source, 'undeclared', 'skills 尚无声明来源 ⇒ 恒未声明')
  assert.equal(rich.auth.source, 'undeclared', 'auth 尚无声明来源 ⇒ 恒未声明')
})

test('⑦ 渲染：未声明字段不占版面，但能力标明「自称」', () => {
  // 真正空的心跳（连 v 都没有）才是「全部未声明」；含 v 的会推断出协议版本
  const empty = renderCardSummary(deriveAgentCard({ nodeId: 'old-node' }))
  assert.equal(empty, '卡片：全部字段未声明')

  const withV = renderCardSummary(deriveAgentCard({ v: 1, nodeId: 'old-node' }))
  assert.equal(withV, '协议=heartbeat-v1(推断)',
    '能从 v 推断就如实标「推断」——既不冒充「声明」，也不假装不知道')

  const fresh = renderCardSummary(deriveAgentCard(newHeartbeat(), { memberId: 'web', capabilities: ['cluster'] }))
  assert.match(fresh, /kind=desktop\(声明\)/)
  assert.match(fresh, /能力 .*cluster.*\(自称\)/)
  assert.ok(!fresh.includes('未声明'), '未声明字段不占版面（它们仍在结构化输出里）')
})

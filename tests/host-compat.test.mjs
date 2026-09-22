// 宿主兼容层 —— 判据来源 docs/semantic.md §5.10（能力探测优先于版本号）
//
// 纪律（§5.9·2）：每一条「降级」断言都必须配一个**该正常工作的对照组**，
// 否则一个「永远返回 none」的实现也能让所有降级断言全绿。
//
// ⚠ 2026-09-22 更正：本文件原先称「尸体样本取自真实世代差异——0.1.2-rc.1 只有 events 属性」。
// **那是错的**（源自一个未核实的假设）。静态取证表明 0.1.2-rc.1 与 0.1.6 的会话读取面**同形**
// （都有 snapshotEvents()、都没有公开 events 属性）。⇒ 下面这两个样本是**形状样本**
// （method-only / property-only），不是「某版本的真实形状」；property-only 那条对应的是
// **未知或更旧宿主**的兜底路径。样本本身仍然必要——它锁的是**分支正确性**，与版本无关。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SUPPORTED_HOSTS,
  describeCompat,
  pickCallable,
  probeHostCompat,
  probeServices,
  readSessionEvents,
  readVersion,
} from '../lib/host-compat.js'

// ── 形状样本（不是版本样本）：method-only 与 property-only ──
const sessionMethodOnly = () => ({ id: 's-1', snapshotEvents: () => [{ type: 'user/message', text: 'hi' }] })
const sessionPropertyOnly = () => ({ id: 's-2', events: [{ type: 'user/message', text: 'hi' }] })

test('读会话历史：只有 snapshotEvents 的形状走方法路径，内容原样返回（已知世代的真实形状）', () => {
  const r = readSessionEvents(sessionMethodOnly())
  assert.equal(r.via, 'snapshotEvents')
  assert.equal(r.fellBack, false)
  assert.deepEqual(r.events, [{ type: 'user/message', text: 'hi' }])
})

test('读会话历史：只有 events 属性的形状走属性路径（**未知/更旧宿主**的兜底）—— 且**不是**降级', () => {
  const r = readSessionEvents(sessionPropertyOnly())
  assert.equal(r.via, 'events-property')
  assert.equal(r.fellBack, false, '走属性本身是这条路线的正路，不该被记成「回退过」')
  assert.deepEqual(r.events, [{ type: 'user/message', text: 'hi' }])
})

test('读会话历史：两条路径都在时 snapshotEvents 优先（顺序是契约，不是巧合）', () => {
  const r = readSessionEvents({ snapshotEvents: () => ['新'], events: ['旧'] })
  assert.equal(r.via, 'snapshotEvents')
  assert.deepEqual(r.events, ['新'])
})

test('读会话历史：两条路径都没有 → via none + 空数组，**不抛**（这是投递链路，抛 = 杀宿主）', () => {
  const r = readSessionEvents({ id: 'bare' })
  assert.equal(r.via, 'none')
  assert.equal(r.fellBack, false)
  assert.deepEqual(r.events, [])
})

test('读会话历史：snapshotEvents 抛错 → 回退到 events 属性，并如实标注 fellBack', () => {
  const r = readSessionEvents({
    snapshotEvents: () => { throw new Error('会话未装载') },
    events: ['后备'],
  })
  assert.equal(r.via, 'events-property')
  assert.equal(r.fellBack, true)
  assert.deepEqual(r.events, ['后备'])
})

test('读会话历史：snapshotEvents 返回非数组 → 同样回退，不把非数组当历史用', () => {
  const r = readSessionEvents({ snapshotEvents: () => ({ not: 'an array' }), events: ['后备'] })
  assert.equal(r.via, 'events-property')
  assert.equal(r.fellBack, true)
  assert.deepEqual(r.events, ['后备'])
})

test('读会话历史：抛错的 getter 不逃逸（属性读取本身也要守卫）', () => {
  const hostile = { get events() { throw new Error('getter 爆炸') } }
  const r = readSessionEvents(hostile)
  assert.equal(r.via, 'none')
  assert.deepEqual(r.events, [])
})

test('读会话历史：null / 原始值 / undefined 一律安全退化', () => {
  for (const bad of [null, undefined, 0, 'x', true]) {
    const r = readSessionEvents(bad)
    assert.equal(r.via, 'none')
    assert.deepEqual(r.events, [])
  }
})

test('pickCallable：按序取第一个可调用成员；非对象与非函数都安全', () => {
  assert.equal(pickCallable(null, ['a']), undefined)
  assert.equal(pickCallable('str', ['a']), undefined)
  assert.equal(pickCallable({ a: 1, b: 'x' }, ['a', 'b']), undefined)
  const pick = pickCallable({ a: 1, b: () => 42 }, ['a', 'b'])
  assert.equal(pick?.name, 'b')
  assert.equal(pick?.fn(), 42)
  // 顺序即优先级：两个都在时取先声明的
  assert.equal(pickCallable({ a: () => 1, b: () => 2 }, ['b', 'a'])?.name, 'b')
})

test('probeServices：从 ctx.get 自证服务面；缺席与抛错都算「不可用」而不是崩', () => {
  const full = { get: (n) => ({ tools: {}, sessions: {}, agents: {} })[n] }
  assert.deepEqual(probeServices(full), { tools: true, sessions: true, agents: true })
  const partial = { get: (n) => (n === 'tools' ? {} : undefined) }
  assert.deepEqual(probeServices(partial), { tools: true, sessions: false, agents: false })
  const throwing = { get: () => { throw new Error('严格代理') } }
  assert.deepEqual(probeServices(throwing), { tools: false, sessions: false, agents: false })
  assert.deepEqual(probeServices({}), { tools: false, sessions: false, agents: false })
})

test('判定 supported：有会话可读 + 服务面自证 —— 对照组（证明上面的 degraded 不是「永远 degraded」）', () => {
  const c = probeHostCompat([sessionMethodOnly()], { services: { tools: true, sessions: true, agents: true } })
  assert.equal(c.verdict, 'supported')
  assert.equal(c.sessionEvents, 'snapshotEvents')
  assert.equal(c.sampled, 1)
  assert.equal(c.blindSessions, 0)
})

test('判定 degraded：全部会话都读不到历史 → 「能跑但会变笨」，且理由要写清退化成什么', () => {
  const c = probeHostCompat([{ id: 'a' }, { id: 'b' }], { services: { tools: true, sessions: true, agents: true } })
  assert.equal(c.verdict, 'degraded')
  assert.equal(c.sessionEvents, 'none')
  assert.equal(c.blindSessions, 2)
  assert.ok(c.reasons.some((r) => r.includes('无最近活跃')), '理由必须说清退化后果，不能只说「降级」')
})

test('判定 degraded：尚无会话可采样是**时机**不是故障（不许说成 supported，也不许说成故障）', () => {
  const c = probeHostCompat([], { services: { tools: true, sessions: true, agents: true } })
  assert.equal(c.verdict, 'degraded')
  assert.equal(c.sessionEvents, 'no-sessions-yet')
  assert.ok(c.reasons.some((r) => r.includes('时机')))
})

test('判定 unsupported：必需服务面自证缺失 —— 优先级高于会话采样结果', () => {
  const c = probeHostCompat([sessionMethodOnly()], { services: { tools: true, sessions: false, agents: true } })
  assert.equal(c.verdict, 'unsupported')
  assert.ok(c.reasons.some((r) => r.includes('sessions')))
})

test('判定：混合样本（一半可读一半盲）不算 degraded，但要把「部分读不到」说出来', () => {
  const c = probeHostCompat([sessionMethodOnly(), { id: 'blind' }], { services: { tools: true, sessions: true, agents: true } })
  assert.equal(c.verdict, 'supported')
  assert.equal(c.blindSessions, 1)
  assert.ok(c.reasons.some((r) => r.includes('1/2')))
})

test('判定：回退过的会话数被计入，不被静默吞掉', () => {
  const c = probeHostCompat([{ snapshotEvents: () => { throw new Error('x') }, events: [] }], { services: { tools: true, sessions: true, agents: true } })
  assert.equal(c.fellBackSessions, 1)
  assert.ok(c.reasons.some((r) => r.includes('回退')))
})

test('readVersion：只认 DSH_VERSION；**绝不**偷用 npm_package_version（那会是插件的版本，读数骗人）', () => {
  assert.deepEqual(readVersion({ DSH_VERSION: '0.1.2-rc.1' }), { version: '0.1.2-rc.1', source: 'env' })
  assert.deepEqual(readVersion({}), { version: '', source: 'unknown' })
  assert.deepEqual(readVersion({ npm_package_version: '0.2.0' }), { version: '', source: 'unknown' },
    'npm_package_version 在 npm script 里是**本插件**的版本，采信它 = 报出一个自信的错数')
  assert.deepEqual(readVersion({ DSH_VERSION: '   ' }), { version: '', source: 'unknown' })
})

test('版本取不到是**正常结果**：判定不依赖它，但理由里要标注', () => {
  const c = probeHostCompat([sessionMethodOnly()], { services: { tools: true, sessions: true, agents: true }, env: {} })
  assert.equal(c.version, '')
  assert.equal(c.versionSource, 'unknown')
  assert.equal(c.verdict, 'supported', '版本未知不得影响判定')
  assert.ok(c.reasons.some((r) => r.includes('未取得')))
})

test('describeCompat：一行可读，含判定/读取路径/版本（未取得时显式写未取得）', () => {
  const c = probeHostCompat([sessionPropertyOnly()], { services: { tools: true, sessions: true, agents: true }, env: {} })
  const line = describeCompat(c)
  assert.ok(line.includes('supported'))
  assert.ok(line.includes('events-property'))
  assert.ok(line.includes('未取得'), '版本取不到必须显示为「未取得」，不能空白或写 0')
})

test('声称诚实性：三档声明各有要求（实测/静态/推断），且「静态」不得被读成运行期读数', () => {
  assert.ok(SUPPORTED_HOSTS.length > 0)
  for (const h of SUPPORTED_HOSTS) {
    assert.ok(['实测', '静态', '推断'].includes(h.tested), 'tested 只能取三档之一：' + String(h.tested))
    assert.ok(h.note.length > 0, '每条声明都要有 note 说明它那句话的边界：' + h.dsh)
  }
  // 静态 = 读过对方代码/类型声明，但**没跑过** ⇒ note 必须让读者看得出这不是运行期读数。
  // （2026-09-22 新增这一档的原因：原先只有 实测/推断 两档，于是「我读了对方代码」无处安放，
  //   被硬塞进「推断」，而它其实比我瞎猜强得多——档位不够会逼人撒谎。）
  for (const h of SUPPORTED_HOSTS.filter((x) => x.tested === '静态')) {
    assert.ok(/静态/.test(h.note), '静态条目必须自曝「静态取证」：' + h.dsh)
    assert.ok(/未.*(运行期|实测)|尚未/.test(h.note), '静态条目必须写明「未取得运行期读数」：' + h.dsh)
  }
  // 推断 = 无证据 ⇒ 必须自曝
  for (const h of SUPPORTED_HOSTS.filter((x) => x.tested === '推断')) {
    assert.ok(/未|尚未|没/.test(h.note), '推断条目必须在 note 里明说没实测过：' + h.dsh)
  }
})

test('探测面绝不抛：喂一组敌意输入数组依然返回结构完整的判定', () => {
  const c = probeHostCompat([null, undefined, 1, 'x', { get events() { throw new Error('x') } }], { services: { tools: true, sessions: true, agents: true } })
  assert.equal(typeof c.verdict, 'string')
  assert.equal(c.sampled, 1, '只把「对象」算作会话样本（null/undefined/原始值跳过）')
  assert.equal(c.verdict, 'degraded')
})

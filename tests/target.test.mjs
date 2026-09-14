/**
 * target.ts 套件：投递目标裁决。
 * 样本全部来自**真实事故**（2026-09-03 telegram 错投 / 2026-09-12 哨兵漏投）——
 * 这些是回归夹具，不是构造出来的理想数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ANCHOR_STALE_MS, decideTarget, isUserSession, lastRealUserPromptAt } from '../lib/target.js'

const u = (time) => ({ type: 'user/message', time, data: { source: { kind: 'user' } } })
const pluginMsg = (time) => ({ type: 'user/message', time, data: { source: { kind: 'plugin' } } })
const otherEvent = (time) => ({ type: 'assistant/message', time, data: {} })
const sess = (id, events, delegationDepth = 0) => ({ id, delegationDepth, events })

test('lastRealUserPromptAt：只认 source.kind==="user" 的 user/message', () => {
  assert.equal(lastRealUserPromptAt(sess('a', [u(100), otherEvent(200)])), 100)
  assert.equal(lastRealUserPromptAt(sess('a', [pluginMsg(500)])), 0)
  assert.equal(lastRealUserPromptAt(sess('a', [])), 0)
  assert.equal(lastRealUserPromptAt(sess('a', [u(100), pluginMsg(900), u(300)])), 300, '倒序找到最后一条真实用户消息')
})

test('回归（2026-09-03 自我强化循环）：插件注入不使会话变"新"', () => {
  const sessions = [
    // 会话 A：真实用户输入很久之前，但最后一条事件是本插件/其他插件刚注入的
    sess('session-a', [u(100), pluginMsg(9999)]),
    // 会话 B：真实用户输入更近
    sess('session-b', [u(500)]),
  ]
  const d = decideTarget(sessions, undefined, {})
  assert.equal(d.sid, 'session-b', '必须按真实用户输入时间选，否则会形成"谁被注入谁变新"的循环')
})

test('回归（2026-09-12 漏投）：子代理会话（delegationDepth>0）永远不是投递目标', () => {
  const sessions = [
    sess('sub-agent-1', [u(99999)], 1),
    sess('session-main', [u(10)]),
  ]
  assert.deepEqual(sessions.filter(isUserSession).map((s) => s.id), ['session-main'])
  assert.equal(decideTarget(sessions, undefined, {}).sid, 'session-main')
})

test('无顶层会话 → 不投递，且理由里给出总数（可诊断）', () => {
  const d = decideTarget([sess('sub', [u(1)], 2)], undefined, {})
  assert.equal(d.sid, undefined)
  assert.match(d.why, /无顶层/)
})

test('显式锚点：新鲜时尊重指定', () => {
  const sessions = [sess('session-x', [u(1000)]), sess('session-y', [u(900)])]
  const d = decideTarget(sessions, 'session-y', {})
  assert.equal(d.sid, 'session-y')
  assert.match(d.why, /尊重显式指定/)
})

test('显式锚点腐化（滞后超阈值）→ 改投最近活跃，理由写明滞后', () => {
  const stale = DEFAULT_ANCHOR_STALE_MS + 60_000
  const sessions = [sess('session-old', [u(1000)]), sess('session-new', [u(1000 + stale)])]
  const d = decideTarget(sessions, 'session-old', {})
  assert.equal(d.sid, 'session-new')
  assert.match(d.why, /腐化/)
})

test('显式锚点不存在 / 指向派生会话 → 改投最近活跃，理由区分两种情形', () => {
  const sessions = [sess('session-main', [u(10)]), sess('sub-9', [u(99)], 1)]
  const d1 = decideTarget(sessions, 'session-ghost', {})
  assert.equal(d1.sid, 'session-main')
  assert.match(d1.why, /不在本进程会话列表/)
  const d2 = decideTarget(sessions, 'sub-9', {})
  assert.equal(d2.sid, 'session-main')
  assert.match(d2.why, /派生/)
})

test('候选排序：按真实用户输入倒序给出（失败可换人）', () => {
  const sessions = [sess('a', [u(1)]), sess('b', [u(3)]), sess('c', [u(2)])]
  assert.deepEqual(decideTarget(sessions, undefined, {}).ranked, ['b', 'c', 'a'])
})

test('从未有真实用户输入的顶层会话：仍可作为目标（新建会话场景），理由标注', () => {
  const d = decideTarget([sess('session-fresh', [])], undefined, {})
  assert.equal(d.sid, 'session-fresh')
  assert.match(d.why, /无.*真实输入记录/)
})

/**
 * state.ts 套件：幂等集合（I3）、重试退避账、坏状态恢复。
 * 关键纪律：状态损坏必须**回落默认并标记 recovered**（调用方落痕），既不崩也不静默沿用脏数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HANDLED_CAP, MAX_BACKOFF_MS, attemptCount, defaultState, isHandled, loadState, markHandled, noteFailure,
  readyToRetry, serializeState,
} from '../lib/state.js'

const NOW = 1_700_000_000_000

test('defaultState：字段齐全、计数归零', () => {
  const s = defaultState('n1', NOW)
  assert.equal(s.v, 1)
  assert.equal(s.nodeId, 'n1')
  assert.deepEqual(s.handled, [])
  assert.deepEqual(s.attempts, {})
  assert.equal(s.counters.delivered, 0)
  assert.equal(s.lastDeliveredAtMs, 0)
})

test('loadState：序列化往返（含 handled/attempts/counters）', () => {
  const s = markHandled(noteFailure(defaultState('n1', NOW), 'm-9', NOW), 'm-1', NOW)
  const r = loadState(JSON.parse(serializeState(s)), 'n1', NOW)
  assert.equal(r.recovered, false)
  assert.deepEqual(r.state.handled, ['m-1'])
  assert.equal(r.state.attempts['m-9'].n, 1)
  assert.equal(r.state.counters.failed, 1)
})

test('loadState 尸体样本：非对象 / 版本不识别 / 归属不符 → 重建并标记 recovered', () => {
  assert.equal(loadState(null, 'n1', NOW).recovered, true)
  assert.equal(loadState(['x'], 'n1', NOW).recovered, true)
  const badVer = loadState({ v: 9, nodeId: 'n1' }, 'n1', NOW)
  assert.equal(badVer.recovered, true)
  assert.match(badVer.why, /版本/)
  const other = loadState({ v: 1, nodeId: 'n2', handled: ['m-1'] }, 'n1', NOW)
  assert.equal(other.recovered, true)
  assert.match(other.why, /归属/)
  assert.deepEqual(other.state.handled, [], '串号状态必须丢弃，绝不沿用别的节点的已处理集合')
})

test('loadState 尸体样本：坏 handled/attempts/counters 清洗而不抛', () => {
  const r = loadState({
    v: 1,
    nodeId: 'n1',
    handled: ['ok', 42, null],
    attempts: { 'm-1': { n: 2, nextAtMs: 5 }, 'm-2': 'nonsense', 'm-3': { n: 'x' } },
    counters: { delivered: 'many', failed: 3 },
    lastPollAtMs: 'soon',
  }, 'n1', NOW)
  assert.equal(r.recovered, false)
  assert.deepEqual(r.state.handled, ['ok'])
  assert.deepEqual(Object.keys(r.state.attempts), ['m-1'])
  assert.equal(r.state.counters.delivered, 0)
  assert.equal(r.state.counters.failed, 3)
  assert.equal(r.state.lastPollAtMs, 0)
})

test('markHandled：幂等去重（同 id 不重复入集合）并清掉它的重试账', () => {
  let s = defaultState('n1', NOW)
  s = noteFailure(s, 'm-1', NOW)
  s = markHandled(s, 'm-1', NOW)
  s = markHandled(s, 'm-1', NOW + 1)
  assert.deepEqual(s.handled, ['m-1'])
  assert.equal(attemptCount(s, 'm-1'), 0, '归档后重试账应清空')
  assert.equal(isHandled(s, 'm-1'), true)
})

test('markHandled：滚动上限（长跑不撑爆状态文件）', () => {
  let s = defaultState('n1', NOW)
  for (let i = 0; i < HANDLED_CAP + 120; i += 1) s = markHandled(s, 'm-' + String(i), NOW)
  assert.equal(s.handled.length, HANDLED_CAP)
  assert.equal(isHandled(s, 'm-' + String(HANDLED_CAP + 119)), true, '最新保留')
  assert.equal(isHandled(s, 'm-0'), false, '最旧被裁剪')
})

test('noteFailure/readyToRetry：退避递增、封顶，且计数累加', () => {
  let s = defaultState('n1', NOW)
  s = noteFailure(s, 'm-1', NOW)
  assert.equal(attemptCount(s, 'm-1'), 1)
  assert.equal(readyToRetry(s, 'm-1', NOW), false, '刚失败不可立刻重试')
  assert.equal(readyToRetry(s, 'm-1', NOW + 1000), true)
  let last = s.attempts['m-1'].nextAtMs - NOW
  for (let i = 0; i < 10; i += 1) {
    s = noteFailure(s, 'm-1', NOW)
    const gap = s.attempts['m-1'].nextAtMs - NOW
    assert.ok(gap >= last, '退避不缩小')
    last = gap
  }
  assert.equal(last, MAX_BACKOFF_MS, '退避封顶')
  assert.equal(s.counters.failed, 11)
})

test('readyToRetry：无记录视为可试（新消息立即可投）', () => {
  assert.equal(readyToRetry(defaultState('n1', NOW), 'm-new', NOW), true)
  assert.equal(attemptCount(defaultState('n1', NOW), 'm-new'), 0)
})

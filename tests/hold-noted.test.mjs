/**
 * 保持态簿记（`state.ts` 的 `holdNoted`）套件。
 *
 * 护两件事：
 *   ① **防刷屏**：无会话节点每轮轮询都会走到「结构性不可注入」分支，落痕必须只做一次；
 *   ② **向后兼容**：旧状态文件没有 `holdNoted` 字段 ⇒ 空数组，且**不得**因此判 `recovered`
 *      —— 判 recovered 会让每个老节点重启后凭空丢掉重试账（`attempts`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HOLD_NOTED_CAP, defaultState, isHoldNoted, loadState, markHandled, markHoldNoted, serializeState,
} from '../lib/state.js'

const NOW = 1_700_000_000_000

test('defaultState：holdNoted 是空数组', () => {
  assert.deepEqual(defaultState('n1', NOW).holdNoted, [])
})

test('markHoldNoted：记一次后可查到；重复标记不产生重复项', () => {
  let s = defaultState('n1', NOW)
  assert.equal(isHoldNoted(s, 'm-1'), false)
  s = markHoldNoted(s, 'm-1', NOW)
  assert.equal(isHoldNoted(s, 'm-1'), true)
  const again = markHoldNoted(s, 'm-1', NOW + 1000)
  assert.deepEqual(again.holdNoted, ['m-1'], '重复标记若产生重复项，滚动上限会被同一个 id 占满')
})

test('markHoldNoted：滚动裁剪到 HOLD_NOTED_CAP，保留最新', () => {
  let s = defaultState('n1', NOW)
  for (let i = 0; i < HOLD_NOTED_CAP + 25; i += 1) s = markHoldNoted(s, 'm-' + String(i), NOW)
  assert.equal(s.holdNoted.length, HOLD_NOTED_CAP)
  assert.equal(isHoldNoted(s, 'm-' + String(HOLD_NOTED_CAP + 24)), true, '最新一条必须保留')
  assert.equal(isHoldNoted(s, 'm-0'), false, '最老一条应被裁掉')
})

test('markHandled：投递成功后清掉该 id 的保持态记录（状态不残留）', () => {
  let s = markHoldNoted(defaultState('n1', NOW), 'm-1', NOW)
  s = markHandled(s, 'm-1', NOW)
  assert.equal(isHoldNoted(s, 'm-1'), false)
})

test('loadState 向后兼容：缺 holdNoted 字段 ⇒ 空数组，且 recovered=false', () => {
  // 尸体样本：**老状态文件的真实形状**（v1、有 handled/attempts/counters，没有 holdNoted）。
  const legacy = {
    v: 1, nodeId: 'n1', handled: ['m-1'],
    attempts: { 'm-9': { n: 3, nextAtMs: NOW + 4000 } },
    counters: { sent: 1, broadcast: 0, delivered: 1, failed: 3, dead: 0, corrupt: 0, readErrors: 0 },
    lastPollAtMs: NOW, lastDeliveredAtMs: NOW, updatedAt: NOW,
  }
  const r = loadState(legacy, 'n1', NOW)
  assert.equal(r.recovered, false, '缺一个新字段不该把整份状态判为损坏：' + r.why)
  assert.deepEqual(r.state.holdNoted, [])
  assert.equal(r.state.attempts['m-9'].n, 3, '重试账必须完整保留（判 recovered 会丢掉它）')
  assert.deepEqual(r.state.handled, ['m-1'])
})

test('loadState 向后兼容：序列化往返保真', () => {
  const s = markHoldNoted(defaultState('n1', NOW), 'm-7', NOW)
  const r = loadState(JSON.parse(serializeState(s)), 'n1', NOW)
  assert.equal(r.recovered, false)
  assert.deepEqual(r.state.holdNoted, ['m-7'])
})

test('loadState 归一化：坏 holdNoted（非数组 / 含非字符串）⇒ 过滤，不崩', () => {
  const base = JSON.parse(serializeState(defaultState('n1', NOW)))
  assert.deepEqual(loadState({ ...base, holdNoted: 'not-an-array' }, 'n1', NOW).state.holdNoted, [])
  assert.deepEqual(loadState({ ...base, holdNoted: ['ok', 42, null, 'fine'] }, 'n1', NOW).state.holdNoted, ['ok', 'fine'])
})

/**
 * protocol.ts 套件：构造 + 校验（正常路径 + 尸体样本）。
 * 断言纪律：坏数据必须返回**分类原因**而不是抛异常——总线内容不可信，
 * 一条坏消息不能让插件崩（语义文档 A7）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_TEXT_CHARS, injectionText, isExpired, makeMessage, messageId, parseMessage, MESSAGE_KINDS,
} from '../lib/protocol.js'

const NOW = 1_700_000_000_000

test('messageId/makeMessage：id 含时间基与随机片段，字段规范化', () => {
  assert.equal(messageId(NOW, 'abcd'), 'm-' + Math.floor(NOW).toString(36) + '-abcd')
  const m = makeMessage({ from: 'a', to: 'b', text: 'hi' }, NOW, 'r1')
  assert.equal(m.v, 1)
  assert.equal(m.kind, 'chat')
  assert.equal(m.ttlMs, 86_400_000)
  assert.equal(m.replyTo, undefined)
  assert.equal(m.id, 'm-' + Math.floor(NOW).toString(36) + '-r1')
})

test('makeMessage：可选字段为空串/未给时不产生键（保持落盘紧凑）', () => {
  const m = makeMessage({ from: 'a', to: 'b', text: 'x', replyTo: '' }, NOW, 'r')
  assert.equal('replyTo' in m, false)
  const m2 = makeMessage({ from: 'a', to: 'b', text: 'x', replyTo: 'm-1', meta: { peer: 'z' } }, NOW, 'r')
  assert.equal(m2.replyTo, 'm-1')
  assert.deepEqual(m2.meta, { peer: 'z' })
})

test('parseMessage：合法消息往返（构造 → 校验）', () => {
  const m = makeMessage({ from: 'a', to: 'b', text: ' 正文 ', kind: 'task' }, NOW, 'r')
  const r = parseMessage(JSON.parse(JSON.stringify(m)))
  assert.equal(r.ok, true)
  assert.equal(r.message.from, 'a')
  assert.equal(r.message.kind, 'task')
})

test('parseMessage：未知 meta 键被忽略但整条保留（向前兼容）', () => {
  const raw = {
    v: 1, id: 'm-1', from: 'a', to: 'b', text: 'x', kind: 'chat', createdAt: NOW, ttlMs: 1000,
    meta: { peer: 'z', nested: { deep: true }, long: 'x'.repeat(600) },
  }
  const r = parseMessage(raw)
  assert.equal(r.ok, true)
  assert.deepEqual(r.message.meta, { peer: 'z' })
})

test('parseMessage 尸体样本：非对象/数组/null → not-object', () => {
  for (const bad of [null, undefined, 42, 'text', true, ['a']]) {
    const r = parseMessage(bad)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'not-object')
  }
})

test('parseMessage 尸体样本：版本不识别 → bad-version（不猜、不降级）', () => {
  const r = parseMessage({ v: 2, id: 'm-1', from: 'a', to: 'b', text: 'x', createdAt: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'bad-version')
})

test('parseMessage 尸体样本：缺字段/空串 → missing-field', () => {
  const base = { v: 1, id: 'm-1', from: 'a', to: 'b', text: 'x', createdAt: NOW }
  for (const key of ['id', 'from', 'to', 'text']) {
    const raw = { ...base, [key]: '' }
    const r = parseMessage(raw)
    assert.equal(r.ok, false, key)
    assert.equal(r.reason, 'missing-field', key)
  }
  const r2 = parseMessage({ ...base, createdAt: 'soon' })
  assert.equal(r2.ok, false)
  assert.equal(r2.reason, 'bad-field')
})

test('parseMessage 尸体样本：未知 kind → unknown-kind；空正文 → empty-text', () => {
  const base = { v: 1, id: 'm-1', from: 'a', to: 'b', text: 'x', createdAt: NOW }
  const r = parseMessage({ ...base, kind: 'nonsense' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unknown-kind')
  const r2 = parseMessage({ ...base, text: '   ' })
  assert.equal(r2.ok, false)
  assert.equal(r2.reason, 'empty-text')
  for (const k of MESSAGE_KINDS) {
    assert.equal(parseMessage({ ...base, kind: k }).ok, true, k)
  }
})

test('parseMessage 尸体样本：超长正文被拒（不静默截断——截断会让收发语义不一致）', () => {
  const r = parseMessage({ v: 1, id: 'm-1', from: 'a', to: 'b', text: 'x'.repeat(101), createdAt: NOW }, { maxTextChars: 100 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'oversize-text')
  assert.equal(parseMessage({ v: 1, id: 'm-1', from: 'a', to: 'b', text: 'x'.repeat(100), createdAt: NOW }, { maxTextChars: 100 }).ok, true, '边界=恰好上限应通过')
  assert.equal(DEFAULT_MAX_TEXT_CHARS, 8000)
})

test('isExpired：ttlMs 0 永不过期；未到期不过期；超过即过期', () => {
  assert.equal(isExpired({ createdAt: 0, ttlMs: 0 }, NOW), false)
  assert.equal(isExpired({ createdAt: NOW - 999, ttlMs: 1000 }, NOW), false)
  assert.equal(isExpired({ createdAt: NOW - 1001, ttlMs: 1000 }, NOW), true)
})

test('injectionText：kind=chat 用 cluster:<from>；其他带 kind 标注（不会与主人指令混淆）', () => {
  assert.equal(injectionText({ from: 'nodeA', kind: 'chat', text: '来了' }), '[cluster:nodeA] 来了')
  assert.equal(injectionText({ from: 'nodeA', kind: 'task', text: '跑一下' }), '[cluster:nodeA/task] 跑一下')
})

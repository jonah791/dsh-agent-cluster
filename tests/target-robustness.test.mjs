/**
 * target-robustness.test.mjs — 2026-09-14 真事故的回归夹具。
 *
 * 事故：会话尚未装载时 `Session.events === undefined`，`lastRealUserPromptAt` 直接读
 * `.length` → `TypeError: Cannot read properties of undefined (reading 'length')`，
 * 该异常从 `setInterval` 回调逃逸 → **宿主 web 进程退出 code=1**。
 *
 * 夹具判据：这类坏输入必须退化为「无真实用户输入（0）」，**永不抛**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideTarget, lastRealUserPromptAt } from '../lib/target.js'

test('尸体样本：events 为 undefined/null/非数组 → 返回 0 且不抛（真事故根因）', () => {
  for (const bad of [undefined, null, 'nope', 42, {}]) {
    assert.equal(
      lastRealUserPromptAt({ id: 'session-x', delegationDepth: 0, events: bad }),
      0,
      '输入=' + String(bad),
    )
  }
})

test('events 缺失的顶层会话仍可作为投递目标（新建会话场景），理由可诊断', () => {
  const d = decideTarget([{ id: 'session-x', delegationDepth: 0, events: undefined }], undefined, {})
  assert.equal(d.sid, 'session-x')
  assert.match(d.why, /无.*真实输入记录/)
})

test('有真实用户输入的会话优先于 events 缺失者（缺失 = 0，不是最大值）', () => {
  const d = decideTarget([
    { id: 'session-a', delegationDepth: 0, events: undefined },
    { id: 'session-b', delegationDepth: 0, events: [{ type: 'user/message', time: 5, data: { source: { kind: 'user' } } }] },
  ], undefined, {})
  assert.equal(d.sid, 'session-b')
})

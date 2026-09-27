/**
 * leader-trace.test.mjs — 主脑稳定态落痕决策的判据（U16 · 2026-09-27）。
 *
 * 判据分两类，都要有：
 * - **行为判据**：汇总阈值、计数归零、时间兜底、跨 tick 累积、失败不计数；
 * - **尸体样本**：`take` / `step-down` 在本模块**必须**返回 null——若哪天有人在
 *   `decideLeaderTrace` 里补上它们，就会与 `applyLeaderDecision` 的逐条落痕**重复**
 *   （这正是本次重构拆分工时要防的）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideLeaderTrace, initialLeaderTraceState, DEFAULT_LEADER_TRACE,
} from '../lib/leader-trace.js'

test('① 稳定续租不逐条落：前 N-1 次都返回 null，只累计', () => {
  let s = initialLeaderTraceState(0)
  for (let i = 1; i < DEFAULT_LEADER_TRACE.everyN; i++) {
    const r = decideLeaderTrace('renew', true, s, i * 1000)
    assert.equal(r.decision.kind, null, '第 ' + i + ' 次不该落痕')
    assert.equal(r.next.renewsSinceSummary, i)
    s = r.next
  }
})

test('② 第 N 次达阈值 ⇒ 落一条汇总，带计数且下一状态归零', () => {
  let s = initialLeaderTraceState(0)
  for (let i = 1; i <= DEFAULT_LEADER_TRACE.everyN; i++) {
    const r = decideLeaderTrace('renew', true, s, i * 1000)
    s = r.next
    if (i < DEFAULT_LEADER_TRACE.everyN) continue
    assert.equal(r.decision.kind, 'leader-renew-summary')
    assert.equal(r.decision.count, DEFAULT_LEADER_TRACE.everyN)
    assert.equal(r.next.renewsSinceSummary, 0, '汇总后计数必须归零')
  }
})

test('③ 时间兜底：续租稀疏时由 everyMs 触发（低频也要有「还活着」的证据）', () => {
  const s = initialLeaderTraceState(0)
  const r = decideLeaderTrace('renew', true, s, DEFAULT_LEADER_TRACE.everyMs)
  assert.equal(r.decision.kind, 'leader-renew-summary')
  assert.equal(r.decision.count, 1)
})

test('④ ★尸体样本：take / step-down / none 在本模块必须返回 null', () => {
  const s = initialLeaderTraceState(0)
  for (const action of ['take', 'step-down', 'none']) {
    const r = decideLeaderTrace(action, true, s, 999_999_999)
    assert.equal(r.decision.kind, null, action + ' 不得由本模块落痕（会与 applyLeaderDecision 重复）')
  }
})

test('⑤ 续租失败（wrote=false）不落痕、不计数', () => {
  const s = initialLeaderTraceState(0)
  const r = decideLeaderTrace('renew', false, s, 999_999_999)
  assert.equal(r.decision.kind, null)
  assert.equal(r.next.renewsSinceSummary, 0)
})

test('⑥ 计数跨 tick 累积；传旧 state 会回退（state 是唯一真源，调用方必须用 next）', () => {
  const s0 = initialLeaderTraceState(0)
  const a = decideLeaderTrace('renew', true, s0, 1000)
  const b = decideLeaderTrace('renew', true, a.next, 2000)
  assert.equal(a.next.renewsSinceSummary, 1)
  assert.equal(b.next.renewsSinceSummary, 2)
  const c = decideLeaderTrace('renew', true, s0, 3000)
  assert.equal(c.next.renewsSinceSummary, 1, '传旧 state ⇒ 回到 1，证明它不读外部状态')
})

test('⑦ 行数账：一天 2880 次续租，汇总行数比原来（5760 条）低至少一个数量级', () => {
  let s = initialLeaderTraceState(0)
  let lines = 0
  const ticksPerDay = 2880
  for (let i = 1; i <= ticksPerDay; i++) {
    const r = decideLeaderTrace('renew', true, s, i * 30_000)
    s = r.next
    if (r.decision.kind !== null) lines++
  }
  assert.ok(lines > 0, '不能一条都不落——否则「还活着」就没证据了')
  assert.ok(lines < 5760 / 10, '必须比原 5760 条低至少一个数量级，实测 ' + lines)
})

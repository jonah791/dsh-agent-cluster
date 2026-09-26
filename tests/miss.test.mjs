/**
 * miss.ts 套件：投递未成功的语义分类。
 *
 * 本套件护的是一个**语义不变量**（不是实现细节）：
 *   「没问到」（sessions-unavailable）与「问到了，答案是没有」（no-target）**必须分属不同类别**。
 * 把前者归成 structural，等于把宿主代理异常静默成「本节点永久无会话」——故障被美化成特性。
 *
 * 尸体样本纪律：每条断言都对应一个**具体的错误实现**会挂掉（见各条注释），不是同义反复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyMiss, describeMiss } from '../lib/miss.js'

/** 全部原因（穷举——新增 `MissReason` 必须同步这里，否则下面的覆盖判据会静默漏掉新成员）。 */
const ALL_REASONS = ['no-target', 'no-agent', 'inject-error', 'sessions-unavailable']

test('classifyMiss：no-target 是结构性的（无顶层会话 ⇒ 换时刻也不会变）', () => {
  // 尸体样本：改回「消耗重试」（retryable）即红 —— 那正是 2026-09-26 的断点本身。
  assert.equal(classifyMiss('no-target'), 'structural')
})

test('classifyMiss：sessions-unavailable 是可恢复的（「没问到」≠「没有」）', () => {
  // 尸体样本：图省事把它并进 no-target（structural）即红。
  assert.equal(classifyMiss('sessions-unavailable'), 'retryable')
})

test('语义不变量：no-target 与 sessions-unavailable 必须分属不同类别', () => {
  // 这一条是本模块的**存在理由**（对照 miss.ts 模块注释的 ⚠ 段）。
  assert.notEqual(classifyMiss('no-target'), classifyMiss('sessions-unavailable'))
})

test('classifyMiss：缺能力 / 缺连接类失败一律可恢复', () => {
  for (const r of ['no-agent', 'inject-error']) {
    assert.equal(classifyMiss(r), 'retryable', r + ' 应是可恢复')
  }
})

test('classifyMiss：穷举全部原因都返回合法类别（不留未分类分支）', () => {
  for (const r of ALL_REASONS) {
    const k = classifyMiss(r)
    assert.ok(k === 'retryable' || k === 'structural', r + ' 的类别非法：' + String(k))
  }
})

test('describeMiss：每个原因都有非空且互不相同的理由（可诊断）', () => {
  const texts = ALL_REASONS.map((r) => describeMiss(r))
  for (let i = 0; i < texts.length; i += 1) {
    assert.ok(typeof texts[i] === 'string' && texts[i].length > 0, ALL_REASONS[i] + ' 的理由为空')
  }
  assert.equal(new Set(texts).size, texts.length, '存在理由串重复——两个不同原因给出同一句话就无法诊断')
})

test('describeMiss：结构性理由必须说清「保留原位 + 不消耗重试」（使用者据此判断消息去向）', () => {
  const t = describeMiss('no-target')
  assert.ok(t.includes('保留'), '理由未说明消息去向：' + t)
  assert.ok(t.includes('不消耗'), '理由未说明不消耗重试：' + t)
})

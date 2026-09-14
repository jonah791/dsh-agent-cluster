/**
 * identity.ts 套件：身份规范化、派生、冲突裁决（I1）、判活（I4 判据单源）、心跳校验尸体样本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_OFFLINE_AFTER_MS, ageText, deriveNodeId, nodeOnline, parseHeartbeat, resolveCollision, sanitizeId,
} from '../lib/identity.js'

const NOW = 1_700_000_000_000

test('sanitizeId：非法字符折叠为 -，去首尾，限长 64', () => {
  assert.equal(sanitizeId('my node:3080'), 'my-node-3080')
  assert.equal(sanitizeId('  --weird--  '), 'weird')
  assert.equal(sanitizeId('x'.repeat(100)).length, 64)
  assert.equal(sanitizeId('中文'), '')
})

test('deriveNodeId：可复现；主机名取首段；空片段回落 host/default', () => {
  assert.equal(deriveNodeId('DESKTOP-ABC.localdomain', 'web', 3080), 'DESKTOP-ABC-web-3080')
  assert.equal(deriveNodeId('host', 'web', 3080), deriveNodeId('host', 'web', 3080))
  assert.equal(deriveNodeId('', '', 0), 'host-default-0')
  assert.notEqual(deriveNodeId('host', 'web', 3080), deriveNodeId('host', 'web', 3081))
})

test('resolveCollision：无同名心跳 → 直接用', () => {
  const d = resolveCollision({ nodeId: 'n', pid: 100 }, undefined, NOW, 30_000, '100')
  assert.deepEqual([d.nodeId, d.renamed], ['n', false])
})

test('resolveCollision：同名且同 pid（本进程重复写）→ 复用', () => {
  const d = resolveCollision({ nodeId: 'n', pid: 100 }, { pid: 100, atMs: NOW }, NOW, 30_000, '100')
  assert.equal(d.renamed, false)
  assert.match(d.why, /本进程/)
})

test('resolveCollision：同名、pid 不同、心跳新鲜 → 改名避让（绝不覆盖他人）', () => {
  const d = resolveCollision({ nodeId: 'n', pid: 200 }, { pid: 100, atMs: NOW - 5_000 }, NOW, 30_000, '200')
  assert.equal(d.nodeId, 'n-200')
  assert.equal(d.renamed, true)
  assert.match(d.why, /活跃/)
})

test('resolveCollision 边界样本：恰好等于判活阈值 → 不算陈旧（阈值语义一致）', () => {
  const d = resolveCollision({ nodeId: 'n', pid: 200 }, { pid: 100, atMs: NOW - 30_000 }, NOW, 30_000, '200')
  assert.equal(d.renamed, true, '= 阈值仍视为在线（nodeOnline 同口径）')
  const d2 = resolveCollision({ nodeId: 'n', pid: 200 }, { pid: 100, atMs: NOW - 30_001 }, NOW, 30_000, '200')
  assert.equal(d2.renamed, false)
  assert.match(d2.why, /接管/)
})

test('resolveCollision 尸体样本：心跳无时间戳 → 视为陈旧并接管（不无限避让）', () => {
  const d = resolveCollision({ nodeId: 'n', pid: 200 }, { pid: 100 }, NOW, 30_000, '200')
  assert.equal(d.nodeId, 'n')
  assert.equal(d.renamed, false)
})

test('nodeOnline：唯一判据，边界与缺字段行为固定', () => {
  assert.equal(nodeOnline({ atMs: NOW }, NOW, 30_000), true)
  assert.equal(nodeOnline({ atMs: NOW - 30_000 }, NOW, 30_000), true)
  assert.equal(nodeOnline({ atMs: NOW - 30_001 }, NOW, 30_000), false)
  assert.equal(nodeOnline({}, NOW, 30_000), false)
  assert.equal(nodeOnline({ atMs: Number.NaN }, NOW, 30_000), false)
  assert.equal(DEFAULT_OFFLINE_AFTER_MS, 30_000)
})

test('ageText：分档可读', () => {
  assert.equal(ageText(5_000), '5s')
  assert.equal(ageText(120_000), '2min')
  assert.equal(ageText(7_200_000), '2h')
  assert.equal(ageText(Number.POSITIVE_INFINITY), '未知')
})

test('parseHeartbeat：合法心跳往返；未知字段忽略', () => {
  const raw = {
    v: 1, nodeId: 'n', role: '研究员', profile: 'web', workspace: 'E:/alice', baseUrl: 'http://127.0.0.1:3080',
    port: 3080, pid: 42, hostname: 'h', startedAt: NOW - 100, atMs: NOW, tags: ['a', 'b', 3], extra: 'ignored',
  }
  const r = parseHeartbeat(raw)
  assert.equal(r.ok, true)
  assert.equal(r.hb.nodeId, 'n')
  assert.equal(r.hb.role, '研究员')
  assert.deepEqual(r.hb.tags, ['a', 'b'])
})

test('parseHeartbeat 尸体样本：非对象/坏版本/缺 id → 分类拒绝', () => {
  assert.equal(parseHeartbeat(null).reason, 'not-object')
  assert.equal(parseHeartbeat(['x']).reason, 'not-object')
  assert.equal(parseHeartbeat({ v: 9, nodeId: 'n' }).reason, 'bad-version')
  assert.equal(parseHeartbeat({ v: 1 }).reason, 'missing-nodeId')
  assert.equal(parseHeartbeat({ v: 1, nodeId: '' }).reason, 'missing-nodeId')
  // 字段类型全错也不抛：回落默认值
  const r = parseHeartbeat({ v: 1, nodeId: 'n', atMs: 'soon', port: {}, tags: 'no' })
  assert.equal(r.ok, true)
  assert.equal(r.hb.atMs, 0)
  assert.equal(r.hb.port, 0)
  assert.deepEqual(r.hb.tags, [])
})

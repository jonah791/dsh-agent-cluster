/**
 * identity.ts 套件：身份规范化、派生、冲突裁决（I1）、判活（I4 判据单源）、心跳校验尸体样本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_OFFLINE_AFTER_MS, ageText, deriveNodeId, isOwnLineage, nodeOnline, parseHeartbeat, resolveCollision,
  sanitizeId, shouldReap,
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

/* ─────────── Round 3-b（2026-09-15）：前身判定 + 血统清扫 ─────────── */

test('resolveCollision 前身样本：同名 + 同主机 + pid 已死 → 回收原名（不再改名避让）', () => {
  const d = resolveCollision({ nodeId: 'h-web-0', pid: 200 }, { pid: 100, atMs: NOW - 5_000 }, NOW, 30_000, '200',
    { pidAlive: false, sameHost: true })
  assert.equal(d.nodeId, 'h-web-0', '回收原名：不另立 pid 后缀门户')
  assert.equal(d.renamed, false)
  assert.equal(d.reclaimed, true)
  assert.match(d.why, /进程已不存在/)
})

test('resolveCollision 保守样本：判活未知 / pid 仍活 / 别的机器 → 一律维持改名避让（不夺名）', () => {
  const alive = resolveCollision({ nodeId: 'h-web-0', pid: 200 }, { pid: 100, atMs: NOW - 5_000 }, NOW, 30_000, '200',
    { pidAlive: true, sameHost: true })
  assert.deepEqual([alive.nodeId, alive.renamed, alive.reclaimed], ['h-web-0-200', true, false])
  const unknown = resolveCollision({ nodeId: 'h-web-0', pid: 200 }, { pid: 100, atMs: NOW - 5_000 }, NOW, 30_000, '200')
  assert.deepEqual([unknown.renamed, unknown.reclaimed], [true, false], '缺省 liveness = 未知 ⇒ 按活着处理')
  const otherHost = resolveCollision({ nodeId: 'h-web-0', pid: 200 }, { pid: 100, atMs: NOW - 5_000 }, NOW, 30_000, '200',
    { pidAlive: false, sameHost: false })
  assert.deepEqual([otherHost.renamed, otherHost.reclaimed], [true, false], 'pid 只在主机内有意义：别机心跳不回收')
})

test('resolveCollision：回收路径要求 pid 有效（pid=0 不回收，避免误伤未知写者）', () => {
  const d = resolveCollision({ nodeId: 'n', pid: 200 }, { pid: 0, atMs: NOW - 1_000 }, NOW, 30_000, '200',
    { pidAlive: false, sameHost: true })
  assert.deepEqual([d.renamed, d.reclaimed], [true, false])
})

test('isOwnLineage：同主机 + 同 profile + 前缀内；别人的节点一律不算我的血统', () => {
  const me = { hostname: 'H', profile: 'web' }
  assert.equal(isOwnLineage({ nodeId: 'H-web-0', hostname: 'H', profile: 'web' }, me), true)
  assert.equal(isOwnLineage({ nodeId: 'H-web-0-9776', hostname: 'H', profile: 'web' }, me), true)
  assert.equal(isOwnLineage({ nodeId: 'H-web-1485', hostname: 'H', profile: 'web' }, me), true, '改名血统（无 -0- 段）也算自己的')
  assert.equal(isOwnLineage({ nodeId: 'H-wb-0', hostname: 'H', profile: 'web' }, me), false, '工作台起的节点不归我清扫')
  assert.equal(isOwnLineage({ nodeId: 'H-web-0', hostname: 'OTHER', profile: 'web' }, me), false)
  assert.equal(isOwnLineage({ nodeId: 'H-web-0', hostname: 'H', profile: 'cli' }, me), false)
  assert.equal(isOwnLineage({ hostname: 'H', profile: 'web' }, me), false, '缺 nodeId 不算')
})

test('shouldReap 尸体测试：只有「我的血统 + pid 确认已死 + 不是自己」才回收', () => {
  const me = { nodeId: 'H-web-0-9776', hostname: 'H', profile: 'web' }
  const hb = (over) => ({ nodeId: 'H-web-0-31116', hostname: 'H', profile: 'web', pid: 31116, ...over })
  assert.equal(shouldReap(hb({}), me, { pidAlive: false }), true, '正样本：我的死前身')
  assert.equal(shouldReap(hb({}), me, { pidAlive: true }), false, '活着不能删')
  assert.equal(shouldReap(hb({ nodeId: 'H-wb-0', pid: 5 }), me, { pidAlive: false }), false, '不是我的血统')
  assert.equal(shouldReap(hb({ nodeId: 'H-web-0-9776' }), me, { pidAlive: false }), false, '自己那份不能删')
  assert.equal(shouldReap(hb({ pid: 0 }), me, { pidAlive: false }), false, 'pid 无效 ⇒ 保留')
  assert.equal(shouldReap(hb({ hostname: 'OTHER' }), me, { pidAlive: false }), false, '别的机器')
})

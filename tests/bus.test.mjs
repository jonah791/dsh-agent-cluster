/**
 * bus.ts 套件：文件系统原语（真实临时目录；含写失败/坏数据的尸体样本）。
 * 不变量：观测层（trace/状态）失败必须**吞错返回 false**，绝不把异常抛进投递主流程（I7/§5.22 §3）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendTrace, atomicWriteJson, busPaths, ensureBusDirs, inboxDir, isFile, listDirs, listJsonFiles,
  moveToBucket, nodeFile, publishNoClobber, readJsonValue, removeIfExists, stateFile, tailTrace,
} from '../lib/bus.js'

const freshRoot = () => mkdtempSync(join(tmpdir(), 'cluster-bus-'))

test('busPaths/nodeFile/inboxDir/stateFile：路径布局稳定（跨节点一致）', () => {
  const p = busPaths('/bus')
  assert.equal(p.nodesDir, join('/bus', 'nodes'))
  assert.equal(p.traceFile, join('/bus', 'cluster-trace.jsonl'))
  assert.equal(nodeFile(p, 'n1'), join('/bus', 'nodes', 'n1.json'))
  assert.equal(inboxDir(p, 'n1'), join('/bus', 'mailbox', 'n1'))
  assert.equal(stateFile(p, 'n1'), join('/bus', 'state', 'n1.json'))
})

test('ensureBusDirs：幂等创建（含本节点收件箱）', () => {
  const root = freshRoot()
  const p = busPaths(root)
  assert.equal(ensureBusDirs(p, 'n1').ok, true)
  assert.equal(ensureBusDirs(p, 'n1').ok, true, '重复调用不应失败')
  assert.equal(existsSync(inboxDir(p, 'n1')), true)
  assert.equal(existsSync(p.stateDir), true)
})

test('atomicWriteJson：覆盖写可往返', () => {
  const root = freshRoot()
  ensureBusDirs(busPaths(root), 'n1')
  const dest = join(root, 'nodes', 'n1.json')
  assert.equal(atomicWriteJson(dest, { a: 1 }, 'x').ok, true)
  assert.deepEqual(readJsonValue(dest).value, { a: 1 })
  assert.equal(atomicWriteJson(dest, { a: 2 }, 'y').ok, true, '覆盖语义（心跳/状态用）')
  assert.deepEqual(readJsonValue(dest).value, { a: 2 })
  assert.equal(readdirSync(join(root, 'nodes')).filter((f) => f.includes('.tmp-')).length, 0, '临时文件不残留')
})

test('atomicWriteJson 尸体样本：父路径是文件 → 返回 ok:false 且不抛', () => {
  const root = freshRoot()
  const asFile = join(root, 'afile')
  writeFileSync(asFile, 'x', 'utf8')
  const r = atomicWriteJson(join(asFile, 'sub.json'), { a: 1 }, 'z')
  assert.equal(r.ok, false)
  assert.equal(typeof r.error, 'string')
})

test('publishNoClobber：首次创建；重复创建 → duplicate 且**不覆盖**原内容（I3 载体）', () => {
  const root = freshRoot()
  const p = busPaths(root)
  ensureBusDirs(p, 'n2')
  const dest = join(inboxDir(p, 'n2'), 'm-1.json')
  const r1 = publishNoClobber(dest, { id: 'm-1', text: 'first' }, 'a')
  assert.deepEqual([r1.ok, r1.duplicate], [true, false])
  const r2 = publishNoClobber(dest, { id: 'm-1', text: 'second' }, 'b')
  assert.deepEqual([r2.ok, r2.duplicate], [true, true])
  assert.equal(JSON.parse(readFileSync(dest, 'utf8')).text, 'first')
})

test('readJsonValue 尸体样本：坏 JSON / 不存在 → 分类错误而非抛', () => {
  const root = freshRoot()
  const bad = join(root, 'bad.json')
  writeFileSync(bad, '{ not json', 'utf8')
  assert.equal(readJsonValue(bad).ok, false)
  assert.equal(readJsonValue(join(root, 'nope.json')).ok, false)
})

test('listJsonFiles/listDirs：只列对应种类，目录缺失返回空数组', () => {
  const root = freshRoot()
  mkdirSync(join(root, 'd1'))
  mkdirSync(join(root, 'd2'))
  writeFileSync(join(root, 'a.json'), '{}', 'utf8')
  writeFileSync(join(root, 'b.txt'), 'x', 'utf8')
  assert.deepEqual(listJsonFiles(root), ['a.json'])
  assert.deepEqual(listDirs(root), ['d1', 'd2'])
  assert.deepEqual(listJsonFiles(join(root, 'missing')), [])
  assert.deepEqual(listDirs(join(root, 'missing')), [])
})

test('moveToBucket：投递成功归档到 done/；同名已存在时加 .dup- 后缀，绝不覆盖既有归档', () => {
  const root = freshRoot()
  const p = busPaths(root)
  const p2 = busPaths(root)
  ensureBusDirs(p2, 'n3')
  const inbox = inboxDir(p, 'n3')
  writeFileSync(join(inbox, 'm-1.json'), '{"id":"m-1"}', 'utf8')
  const r1 = moveToBucket(inbox, 'm-1.json', 'done', 'x')
  assert.equal(r1.ok, true)
  assert.equal(existsSync(join(inbox, 'm-1.json')), false)
  assert.equal(existsSync(join(inbox, 'done', 'm-1.json')), true)
  writeFileSync(join(inbox, 'm-1.json'), '{"id":"m-1","again":true}', 'utf8')
  const r2 = moveToBucket(inbox, 'm-1.json', 'done', 'y')
  assert.equal(r2.ok, true)
  assert.match(r2.path, /m-1\.dup-y\.json$/)
  assert.equal(JSON.parse(readFileSync(join(inbox, 'done', 'm-1.json'), 'utf8')).again, undefined, '原归档未被覆盖')
})

test('moveToBucket 尸体样本：源不存在 → ok:false 且不抛', () => {
  const root = freshRoot()
  const p = busPaths(root)
  ensureBusDirs(p, 'n4')
  const r = moveToBucket(inboxDir(p, 'n4'), 'ghost.json', 'dead', 'z')
  assert.equal(r.ok, false)
})

test('appendTrace/tailTrace：一行一 JSON，尾部读取；坏行跳过', () => {
  const root = freshRoot()
  const p = busPaths(root)
  ensureBusDirs(p, 'n5')
  assert.equal(appendTrace(p.traceFile, { phase: 'a', n: 1 }), true)
  assert.equal(appendTrace(p.traceFile, { phase: 'b', n: 2 }), true)
  writeFileSync(p.traceFile, readFileSync(p.traceFile, 'utf8') + '{ broken\n', 'utf8')
  const tail = tailTrace(p.traceFile, 10)
  assert.deepEqual(tail.map((e) => e.phase), ['a', 'b'])
  assert.deepEqual(tailTrace(p.traceFile, 1).map((e) => e.phase), ['b'])
})

test('appendTrace 尸体样本：目录不存在 → 返回 false 且不抛（I7 观测不反噬）', () => {
  const root = freshRoot()
  assert.equal(appendTrace(join(root, 'no-such-dir', 'trace.jsonl'), { phase: 'x' }), false)
  assert.deepEqual(tailTrace(join(root, 'no-such-dir', 'trace.jsonl'), 5), [])
})

test('isFile/removeIfExists：普通文件判定与幂等删除', () => {
  const root = freshRoot()
  const f = join(root, 'f.json')
  writeFileSync(f, '{}', 'utf8')
  assert.equal(isFile(f), true)
  assert.equal(isFile(root), false)
  assert.equal(removeIfExists(f), true)
  assert.equal(removeIfExists(f), true, '再删不存在的路径仍算成功（幂等）')
})

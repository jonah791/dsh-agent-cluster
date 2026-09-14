#!/usr/bin/env node
/**
 * sim-node.mjs — 第二节点模拟器（联调/验收工具，不依赖 DSH 宿主）。
 *
 * 用途：在一个真实 DSH 实例之外，扮演一个「另一个 DSH 实例」，
 * 从而对 dsh-agent-cluster 做闭环验收：
 *   - 写自己的心跳 → 真实实例的 `cluster_nodes` 应该看到它；
 *   - 给真实实例的收件箱写消息 → 真实实例应在轮询周期内把消息注入会话；
 *   - 监听自己的收件箱 → 真实实例的 `cluster_send` 应该送到这里。
 *
 * 用法：
 *   node scripts/sim-node.mjs --bus <busDir> [--id sim-node] [--role 模拟节点]
 *        [--send <targetNodeId> --text "正文"] [--kind chat] [--listen true|false]
 *        [--heartbeatMs 5000] [--oneshot true] [--ttlMs 600000]
 *
 * 协议版本与真实插件一致（见 src/protocol.ts）。写心跳用临时文件 + rename 原子发布；
 * 创建消息用 `wx`（O_EXCL，no-clobber）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname as osHostname } from 'node:os'
import { join } from 'node:path'

const argv = process.argv
const args = {}
for (let i = 2; i < argv.length; i += 1) {
  const a = argv[i]
  if (typeof a === 'string' && a.startsWith('--')) {
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { args[k] = next; i += 1 } else { args[k] = 'true' }
  }
}

const busDir = args.bus ?? join(homedir(), '.dsh-cluster')
const nodeId = args.id ?? 'sim-node'
const role = args.role ?? '模拟节点'
const heartbeatMs = Number(args.heartbeatMs ?? 5000)
const oneshot = args.oneshot === 'true'
const listen = args.listen !== 'false'
const sendTo = args.send ?? ''
const sendText = args.text ?? ''
const kind = args.kind ?? 'chat'
const ttlMs = Number(args.ttlMs ?? 600000)
const startedAt = Date.now()

const nodesDir = join(busDir, 'nodes')
const inbox = join(busDir, 'mailbox', nodeId)
const log = (msg) => process.stdout.write('[sim ' + new Date().toISOString() + '] ' + msg + '\n')

mkdirSync(nodesDir, { recursive: true })
mkdirSync(inbox, { recursive: true })

const beat = () => {
  const hb = {
    v: 1,
    nodeId,
    role,
    profile: 'sim',
    workspace: process.cwd(),
    baseUrl: '',
    port: 0,
    pid: process.pid,
    hostname: osHostname(),
    startedAt,
    atMs: Date.now(),
    tags: ['sim'],
  }
  const dest = join(nodesDir, nodeId + '.json')
  const tmp = dest + '.tmp-' + String(process.pid)
  writeFileSync(tmp, JSON.stringify(hb, null, 2), 'utf8')
  renameSync(tmp, dest)
}

const newId = () => 'm-' + Math.floor(Date.now()).toString(36) + '-' + Math.random().toString(36).slice(2, 10)

const send = (to, text, k) => {
  const msg = { v: 1, id: newId(), from: nodeId, to, kind: k, text, createdAt: Date.now(), ttlMs }
  const dest = join(busDir, 'mailbox', to, msg.id + '.json')
  mkdirSync(join(busDir, 'mailbox', to), { recursive: true })
  try {
    writeFileSync(dest, JSON.stringify(msg, null, 2), { encoding: 'utf8', flag: 'wx' })
    log('已投递 ' + msg.id + ' → ' + to)
  } catch (e) {
    log('投递失败：' + String(e))
  }
  return msg.id
}

const drain = () => {
  let names = []
  try { names = readdirSync(inbox).filter((n) => n.endsWith('.json')) } catch { return }
  for (const n of names.sort()) {
    try {
      const m = JSON.parse(readFileSync(join(inbox, n), 'utf8'))
      log('收到 from=' + String(m.from) + ' kind=' + String(m.kind) + ' id=' + String(m.id) + ' :: ' + String(m.text).slice(0, 400))
    } catch (e) {
      log('坏消息文件 ' + n + '：' + String(e))
    }
    const done = join(inbox, 'done')
    mkdirSync(done, { recursive: true })
    try { renameSync(join(inbox, n), join(done, n)) } catch { /* 移动失败留待下次 */ }
  }
}

beat()
log('sim 节点启动：id=' + nodeId + ' bus=' + busDir)
if (sendTo !== '' && sendText !== '') {
  send(sendTo, sendText, kind)
  if (!listen) {
    if (oneshot) { rmSync(join(nodesDir, nodeId + '.json'), { force: true }); log('oneshot 结束'); process.exit(0) }
  }
}
if (listen) {
  drain()
  setInterval(() => { beat(); drain() }, heartbeatMs)
  log('监听中（心跳 ' + String(heartbeatMs) + 'ms）… Ctrl+C 退出')
} else if (!oneshot) {
  setInterval(beat, heartbeatMs)
  log('只发不收模式（心跳 ' + String(heartbeatMs) + 'ms）')
}
if (oneshot) {
  setTimeout(() => {
    if (existsSync(join(nodesDir, nodeId + '.json'))) rmSync(join(nodesDir, nodeId + '.json'), { force: true })
    log('oneshot 结束（心跳已移除）')
    process.exit(0)
  }, 1500)
}

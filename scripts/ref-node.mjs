#!/usr/bin/env node
/**
 * ref-node.mjs — 参考适配器（Reference Node Adapter）
 *
 * 存在意义（语义见 docs/semantic.md §5.8）：
 *  1. **协议的活证明**——它不基于 DSH，却照样是节点 ⇒ 「harness 无关」从声称变实测；
 *  2. **接入模板**——第三方照它写自己的适配器（照抄五个职责 + 安全边界即可）。
 *
 * 职责五拍（缺一不算节点，I10）：
 *   ① 注册心跳（含 capabilities[]）→ nodes/<nodeId>.json
 *   ② 收任务 → 自己拆解（payload 展开成带序号的 plan）
 *   ③ 逐步执行（每步一条行为事件）→ logs/actions/<actionId>.jsonl
 *   ④ 回结果（status/summary/evidence/unverified）→ 派发者的收件箱
 *   ⑤ 收口（stage: done|failed）+ 记录已处理任务（幂等）
 *
 * 用法：
 *   node scripts/ref-node.mjs --workdir <dir> [--bus <busDir>] [--id <nodeId>]
 *        [--role 执行节点] [--displayName 参考节点] [--heartbeatMs 5000] [--pollMs 2000]
 *        [--once true] [--hold <sendTo> <text>]   # --hold 用于联调：向某节点发一条 chat
 *
 * 安全边界（硬约束，I11）：
 *   - 所有 path 解析后必须位于 --workdir 之内；越界 → 该步拒绝 + 整体回 `blocked`
 *   - **不执行 shell**（v1 无 shell.exec，见未决 U8）；不 spawn 子进程；不发网络请求
 *   - 单文件 ≤ 1 MiB · 单任务 ≤ 64 步
 *
 * 工程纪律：
 *   - 定时器/回调一律 `guarded()` 兜底（对照 SOUL §5.24：逃逸异常 = 进程死因）
 *   - 心跳用临时文件 + rename 原子发布；消息创建用 wx（no-clobber）
 *   - 观测失败不静默：行为事件写不进去 → 该任务判失败（「不落盘 = 不算节点」），但绝不崩
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, hostname as osHostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/* ── 参数 ─────────────────────────────────────────────────────────── */
const argv = process.argv
/** 缺值哨兵：本脚本**没有布尔标志**，任何 `--key` 都必须带值（对照 ledger.mjs 的同款修复） */
const MISSING = '\u0000MISSING'
const args = {}
const missingArg = []
for (let i = 2; i < argv.length; i += 1) {
  const a = argv[i]
  if (typeof a === 'string' && a.startsWith('--')) {
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { args[k] = next; i += 1 } else { args[k] = MISSING; missingArg.push(k) }
  }
}
if (missingArg.length > 0) {
  process.stderr.write('[ref] 参数缺少值：' + missingArg.join(', ') + '（本脚本没有布尔标志，所有 --key 都必须带值）\n')
  process.exit(2)
}

const busDir = resolve(args.bus ?? join(homedir(), '.dsh-cluster'))
const nodeId = args.id ?? String(osHostname()).toUpperCase() + '-ref-0'
const role = args.role ?? '执行节点'
const displayName = args.displayName ?? '参考适配器'
const heartbeatMs = Number(args.heartbeatMs ?? 5000)
const pollMs = Number(args.pollMs ?? 2000)
const once = args.once === 'true'
const startedAt = Date.now()

/** 能力声明（主脑按能力寻址；与 §5.8 指令集一一对应） */
const CAPABILITIES = ['fs.mkdir', 'fs.write', 'fs.replace', 'fs.remove', 'fs.assert', 'fs.digest']

const MAX_STEPS = 64
const MAX_FILE_BYTES = 1024 * 1024
const MAX_HANDLED = 200

if (args.workdir === undefined) {
  process.stderr.write('[ref] 缺少 --workdir（路径白名单根）。拒绝启动：没有白名单就没有安全边界。\n')
  process.exit(2)
}
const workRoot = resolve(args.workdir)

const nodesDir = join(busDir, 'nodes')
const inbox = join(busDir, 'mailbox', nodeId)
const actionsDir = join(busDir, 'logs', 'actions')
const stateFile = join(busDir, 'state', nodeId + '.tasks.json')

const log = (msg) => process.stdout.write('[ref ' + new Date().toISOString() + '] ' + msg + '\n')

/** 兜底包装：任何逃逸异常都不得杀死进程（SOUL §5.24） */
const guarded = (name, fn) => (...a) => {
  try { return fn(...a) } catch (e) {
    const m = e && e.message !== undefined ? e.message : String(e)
    log('[guard] ' + name + ' 异常已兜底：' + m)
    return null
  }
}

/* ── 路径白名单（I11） ────────────────────────────────────────────── */
class BlockedError extends Error {}

const normCase = (s) => (process.platform === 'win32' ? s.toLowerCase() : s)

/** 解析路径并断言落在 workRoot 内；越界抛 BlockedError */
const resolveSafe = (p) => {
  const abs = resolve(workRoot, String(p ?? ''))
  const rel = relative(workRoot, abs)
  const safe = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  if (!safe) throw new BlockedError('路径越界（workdir 之外）：' + String(p))
  if (!normCase(abs).startsWith(normCase(workRoot))) throw new BlockedError('路径越界（大小写规范化后仍在外）：' + String(p))
  return abs
}

/* ── 原子写 / 小工具 ─────────────────────────────────────────────── */
const writeAtomic = (dest, text) => {
  const tmp = dest + '.tmp-' + String(process.pid)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, dest)
}

const newId = (p) => p + '-' + Math.floor(Date.now()).toString(36) + '-' + Math.random().toString(36).slice(2, 10)

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const readJsonSafe = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/* ── ⑤ 幂等状态 ───────────────────────────────────────────────────── */
const loadHandled = () => {
  const s = readJsonSafe(stateFile)
  return Array.isArray(s && s.handled) ? s.handled : []
}
const markHandled = (taskId) => {
  const list = loadHandled().filter((x) => x !== taskId)
  list.push(taskId)
  const trimmed = list.slice(-MAX_HANDLED)
  try {
    writeAtomic(stateFile, JSON.stringify({ v: 1, nodeId, updatedAt: Date.now(), handled: trimmed }, null, 2))
  } catch (e) { log('状态落盘失败（不影响幂等内存视图）：' + String(e)) }
}
const isHandled = (taskId) => loadHandled().includes(taskId)

/* ── ① 心跳 ───────────────────────────────────────────────────────── */
const beat = () => {
  const hb = {
    v: 1,
    nodeId,
    role,
    displayName,
    profile: 'ref',
    workspace: workRoot,
    baseUrl: '',
    port: 0,
    pid: process.pid,
    hostname: osHostname(),
    startedAt,
    atMs: Date.now(),
    tags: ['ref', 'adapter'],
    // 扩展字段（spec §3.4）——「harness 无关」的落点
    harness: 'ref-node',
    adapter: 'ref-node/1',
    capabilities: CAPABILITIES,
    sessionIds: [],
    load: running ? 1 : 0,
    ctxPressure: null,
  }
  writeAtomic(join(nodesDir, nodeId + '.json'), JSON.stringify(hb, null, 2))
}

/* ── ③ 行为事件（I10） ────────────────────────────────────────────── */
let eventBroken = false
const actionEvent = (actionId, o) => {
  const line = JSON.stringify({
    atMs: Date.now(), actionId, node: nodeId, actor: nodeId,
    stage: o.stage, step: o.step ?? 0, total: o.total ?? 0,
    humanText: o.humanText ?? '', detail: o.detail ?? {},
  }) + '\n'
  try {
    mkdirSync(actionsDir, { recursive: true })
    appendFileSync(join(actionsDir, actionId + '.jsonl'), line, 'utf8')
  } catch (e) {
    eventBroken = true
    log('行为事件落盘失败（判该任务失败，但不崩）：' + String(e))
  }
}

/* ── 指令集（§5.8 v1） ────────────────────────────────────────────── */
const describe = (s) => {
  const op = String(s && s.op)
  const p = String(s && s.path)
  switch (op) {
    case 'fs.mkdir': return '创建目录 ' + p
    case 'fs.write': return '写文件 ' + p
    case 'fs.replace': return '替换 ' + p + ' 中的文本'
    case 'fs.remove': return '删除 ' + p
    case 'fs.assert': return '断言 ' + p + ' ' + (s.exists === false ? '不存在' : '存在')
    case 'fs.digest': return '计算摘要 ' + p
    default: return '未知操作 ' + op
  }
}

/** 执行一步；返回 { evidence? }；越界抛 BlockedError，其它错误抛 Error */
const execStep = (s) => {
  const op = String(s.op)
  if (!CAPABILITIES.includes(op)) throw new Error('不支持的操作：' + op)
  const abs = resolveSafe(s.path)

  switch (op) {
    case 'fs.mkdir': {
      mkdirSync(abs, { recursive: true })
      return { evidence: { kind: 'assert', path: s.path, ok: existsSync(abs), note: '目录已就绪' } }
    }
    case 'fs.write': {
      const content = String(s.content ?? '')
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('内容超过 1 MiB 上限')
      const mode = s.mode ?? 'overwrite'
      if (mode === 'create' && existsSync(abs)) throw new Error('create 模式：文件已存在 ' + s.path)
      writeAtomic(abs, content)
      return { evidence: { kind: 'file-digest', path: s.path, sha256: sha256(Buffer.from(content, 'utf8')), note: 'written' } }
    }
    case 'fs.replace': {
      if (!existsSync(abs)) throw new Error('目标不存在：' + s.path)
      const before = readFileSync(abs, 'utf8')
      const find = String(s.find ?? '')
      if (find === '') throw new Error('find 不能为空')
      const count = before.split(find).length - 1
      const expect = s.expectCount === undefined ? null : Number(s.expectCount)
      if (count === 0) throw new Error('未命中：' + find)
      if (expect !== null && count !== expect) throw new Error('命中数 ' + String(count) + ' ≠ expectCount ' + String(expect))
      const after = before.split(find).join(String(s.replace ?? ''))
      writeAtomic(abs, after)
      return { evidence: { kind: 'file-digest', path: s.path, sha256: sha256(Buffer.from(after, 'utf8')), note: 'replaced×' + String(count) } }
    }
    case 'fs.remove': {
      if (!existsSync(abs)) return { evidence: { kind: 'assert', path: s.path, ok: true, note: '本就不存在' } }
      rmSync(abs, { recursive: s.recursive === true, force: true })
      return { evidence: { kind: 'assert', path: s.path, ok: !existsSync(abs), note: '已删除' } }
    }
    case 'fs.assert': {
      const want = s.exists !== false
      const got = existsSync(abs)
      if (want !== got) throw new Error('断言失败：期待 exists=' + String(want) + '，实际 ' + String(got) + '（' + s.path + '）')
      return { evidence: { kind: 'assert', path: s.path, ok: true, note: 'exists=' + String(got) } }
    }
    case 'fs.digest': {
      if (!existsSync(abs)) throw new Error('目标不存在：' + s.path)
      const buf = readFileSync(abs)
      return { evidence: { kind: 'file-digest', path: s.path, sha256: sha256(buf), bytes: buf.length, note: 'digest' } }
    }
    default:
      throw new Error('未实现：' + op)
  }
}

/* ── ②④ 收任务 → 拆解 → 执行 → 回结果 ─────────────────────────────── */
let running = false

const runTask = (msg) => {
  const meta = msg.meta !== null && typeof msg.meta === 'object' ? msg.meta : {}
  const taskId = String(meta.taskId ?? '')
  const steps = meta.payload !== undefined && Array.isArray(meta.payload.steps) ? meta.payload.steps : null
  const actionId = newId('a')
  const from = String(msg.from ?? '')

  if (taskId === '') return { status: 'blocked', summary: '任务缺少 meta.taskId', evidence: [], unverified: ['未执行'] }
  if (steps === null || steps.length === 0) {
    actionEvent(actionId, { stage: 'start', humanText: '收到任务 ' + taskId + '，但 payload.steps 缺失', detail: { taskId } })
    actionEvent(actionId, { stage: 'failed', humanText: '无法拆解：没有可执行的步骤', detail: { taskId } })
    return { status: 'blocked', summary: 'payload.steps 缺失或为空——适配器不会猜意图', evidence: [], unverified: ['全部'] }
  }
  if (steps.length > MAX_STEPS) {
    actionEvent(actionId, { stage: 'start', humanText: '收到任务 ' + taskId, detail: { taskId } })
    actionEvent(actionId, { stage: 'failed', humanText: '步数 ' + String(steps.length) + ' 超过上限 ' + String(MAX_STEPS), detail: { taskId } })
    return { status: 'blocked', summary: '步数超上限', evidence: [], unverified: ['全部'] }
  }

  // ② 自己拆解：展开为带序号的 plan（可见产物）
  const plan = steps.map((s, i) => ({
    step: i + 1,
    op: String(s && s.op),
    target: String((s && s.path) ?? ''),
    humanText: describe(s),
  }))
  actionEvent(actionId, {
    stage: 'start', step: 0, total: steps.length,
    humanText: '收到任务 ' + taskId + '，拆解为 ' + String(steps.length) + ' 步',
    detail: { taskId, from, acceptance: String(meta.acceptance ?? ''), plan },
  })

  const evidence = []
  const unverified = []

  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i]
    actionEvent(actionId, {
      stage: 'stage', step: i + 1, total: steps.length,
      humanText: '第 ' + String(i + 1) + '/' + String(steps.length) + ' 步：' + describe(s),
      detail: { op: String(s && s.op), path: String((s && s.path) ?? '') },
    })
    try {
      const r = execStep(s)
      if (r !== undefined && r !== null && r.evidence !== undefined) evidence.push(r.evidence)
    } catch (e) {
      const blocked = e instanceof BlockedError
      const status = blocked ? 'blocked' : 'failed'
      actionEvent(actionId, {
        stage: 'failed', step: i + 1, total: steps.length,
        humanText: (blocked ? '越界被拒：' : '第 ' + String(i + 1) + ' 步失败：') + String(e && e.message !== undefined ? e.message : e),
        detail: { op: String(s && s.op), path: String((s && s.path) ?? '') },
      })
      unverified.push('第 ' + String(i + 1) + ' 步起的后续步骤')
      return {
        status,
        summary: (blocked ? '越界被拒（路径白名单）' : '执行失败') + '：' + String(e && e.message !== undefined ? e.message : e),
        evidence, unverified, learnings: blocked ? ['派发前应校验路径落在节点的 workdir 内'] : [],
      }
    }
  }

  const ok = !eventBroken
  actionEvent(actionId, {
    stage: 'done', step: steps.length, total: steps.length,
    humanText: (ok ? '任务完成' : '任务执行完毕但行为事件落盘失败') + '，' + String(evidence.length) + ' 条证据',
    detail: { taskId, evidenceCount: evidence.length },
  })
  return {
    status: ok ? 'ok' : 'partial',
    summary: '完成 ' + String(steps.length) + ' 步，产出 ' + String(evidence.length) + ' 条证据' + (ok ? '' : '（行为事件落盘失败）'),
    evidence,
    unverified: ok ? [] : ['行为事件未能完整落盘'],
    learnings: [],
  }
}

const send = (to, kind, text, meta) => {
  const msg = { v: 1, id: newId('m'), from: nodeId, to, kind, text, createdAt: Date.now(), ttlMs: 86400000 }
  if (meta !== undefined) msg.meta = meta
  const dest = join(busDir, 'mailbox', to, msg.id + '.json')
  try {
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, JSON.stringify(msg, null, 2), { encoding: 'utf8', flag: 'wx' })
    log('已回信 ' + msg.id + ' → ' + to + '（' + kind + '）')
    return true
  } catch (e) {
    log('回信失败：' + String(e))
    return false
  }
}

const archive = (file, name) => {
  const dest = join(inbox, 'done', name)
  try { mkdirSync(dirname(dest), { recursive: true }); renameSync(file, dest) } catch { /* 留待下次 */ }
}

const drain = () => {
  let names = []
  try { names = readdirSync(inbox).filter((n) => n.endsWith('.json')) } catch { return }
  for (const n of names.sort()) {
    const file = join(inbox, n)
    const msg = readJsonSafe(file)
    if (msg === null) { log('坏消息文件（跳过并归档）：' + n); archive(file, n); continue }

    const kind = String(msg.kind ?? '')
    const taskId = msg.meta !== undefined && msg.meta !== null ? String(msg.meta.taskId ?? '') : ''

    if (kind === 'task' && taskId !== '') {
      if (isHandled(taskId)) {
        log('任务 ' + taskId + ' 已处理过（幂等跳过）')
        send(String(msg.from), 'event', '任务 ' + taskId + ' 此前已处理，本次跳过（幂等）', { taskId, status: 'duplicate' })
        archive(file, n)
        continue
      }
      log('收到任务 ' + taskId + '（来自 ' + String(msg.from) + '）')
      send(String(msg.from), 'event', '已开始执行 ' + taskId, { taskId, status: 'started' })
      running = true
      let outcome
      try { outcome = runTask(msg) } catch (e) {
        outcome = { status: 'failed', summary: '适配器内部异常已兜底：' + String(e && e.message), evidence: [], unverified: ['全部'] }
        log('runTask 逃逸异常已兜底：' + String(e))
      }
      running = false
      send(String(msg.from), 'result', outcome.summary, {
        taskId,
        status: outcome.status,
        summary: outcome.summary,
        evidence: outcome.evidence,
        unverified: outcome.unverified,
        learnings: outcome.learnings ?? [],
      })
      markHandled(taskId)
      archive(file, n)
      continue
    }

    // 其它类别：记录 + 读一次即归档（适配器不处理 chat/result/alert）
    log('收到 from=' + String(msg.from) + ' kind=' + kind + ' id=' + String(msg.id) + ' :: ' + String(msg.text).slice(0, 200))
    archive(file, n)
  }
}

/* ── 启动 ─────────────────────────────────────────────────────────── */
const cleanup = () => {
  try { rmSync(join(nodesDir, nodeId + '.json'), { force: true }) } catch { /* ignore */ }
}

mkdirSync(nodesDir, { recursive: true })
mkdirSync(inbox, { recursive: true })
mkdirSync(actionsDir, { recursive: true })

guarded('beat', beat)()
log('参考节点启动：id=' + nodeId + ' harness=ref-node bus=' + busDir + ' workdir=' + workRoot)
log('能力声明：' + CAPABILITIES.join(', '))

if (args.hold !== undefined) {
  send(String(args.hold), 'chat', String(args.text ?? '（无正文）'))
}

if (once) {
  guarded('drain', drain)()
  const st = existsSync(stateFile) ? statSync(stateFile) : null
  log('once 模式结束（state ' + (st === null ? '未写' : String(st.size) + ' 字节') + '）')
  process.exit(0)
}

process.on('SIGINT', () => { log('收到 SIGINT，清理心跳后退出'); cleanup(); process.exit(0) })
process.on('SIGTERM', () => { cleanup(); process.exit(0) })

guarded('drain', drain)()
setInterval(guarded('beat', beat), heartbeatMs)
setInterval(guarded('drain', drain), pollMs)
log('监听中（心跳 ' + String(heartbeatMs) + 'ms · 轮询 ' + String(pollMs) + 'ms）… Ctrl+C 退出')

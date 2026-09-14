#!/usr/bin/env node
/**
 * ledger.mjs — 主脑侧任务台账工具（primary-side ledger CLI）
 *
 * 目的：把 spec §5.1 的主链路（方向 → 细化 → 派发 → 验收 → verdict）落成**可复用命令**，
 *       并把 R8「无判据不派发」变成**机器可判的硬门**（semantic.md I9）——不靠主脑记得。
 *
 * 为什么不是插件：插件改动需重启 DSH（会杀死主脑会话）。台账是主脑的账本，
 * 主脑用命令行完全够用（零模型成本），后续若需常驻能力再升格为插件工具。
 *
 * 命令：
 *   new      --intent <原话> --acceptance <判据> --assignee <nodeId> [--grade L1|L2|L3]
 *            [--steps "a;b;c"] [--budget-turns N] [--budget-calls N]
 *   dispatch --task <taskId> [--payload <file.json>] [--text <说明>]
 *   collect  --as <primaryNodeId>          # 扫自己收件箱，把 result 回填台账（批处理）
 *   verdict  --task <taskId> --pass true|false --method <复现证据|核对证据> --note <说明>
 *   list     [--status <s>] [--assignee <id>]
 *   show     --task <taskId>
 *
 * 通用参数：--bus <busDir>（默认 ~/.dsh-cluster）
 *
 * 硬门（I9）：`new` 与 `dispatch` **两处都校验** acceptance；不合格 → 拒绝并打印原因，
 *            退出码 3。派发前的最后一道检查就是它。
 * 写者（I8）：台账只有主脑写；本工具即主脑的手。节点侧不写台账（节点只回消息）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const argv = process.argv
const cmd = argv[2] ?? ''
/** 缺值哨兵：本 CLI **没有布尔标志**，任何 `--key` 都必须带值 */
const MISSING = '\u0000MISSING'
const args = {}
const missingArg = []
for (let i = 3; i < argv.length; i += 1) {
  const a = argv[i]
  if (typeof a === 'string' && a.startsWith('--')) {
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { args[k] = next; i += 1 } else { args[k] = MISSING; missingArg.push(k) }
  }
}

const busDir = resolve(args.bus ?? join(homedir(), '.dsh-cluster'))
const tasksDir = join(busDir, 'tasks')

const die = (msg, code = 1) => { process.stderr.write(msg + '\n'); process.exit(code) }
const ok = (msg) => process.stdout.write(msg + '\n')

const writeAtomic = (dest, text) => {
  const tmp = dest + '.tmp-' + String(process.pid)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, dest)
}

const newId = (p) => p + '-' + Math.floor(Date.now()).toString(36) + '-' + Math.random().toString(36).slice(2, 8)
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))
const readJsonSafe = (f) => { try { return readJson(f) } catch { return null } }
const taskPath = (id) => join(tasksDir, id + '.json')

/* ── I9 判据硬门 ──────────────────────────────────────────────────── */
const PLACEHOLDER = /^(tbd|todo|to be determined|待定|待补|待填|无|none|n\/?a|\.{2,}|—+|-+|\?+)$/i

/** 返回 null = 合格；否则返回拒绝原因 */
const acceptanceProblem = (s) => {
  const t = String(s ?? '').trim()
  if (t === '') return '判据为空'
  if (t.length < 8) return '判据过短（< 8 字符）：' + t
  if (PLACEHOLDER.test(t)) return '判据是占位符：' + t
  return null
}

const gate = (task) => {
  const bad = acceptanceProblem(task.acceptance)
  if (bad !== null) {
    die('!! I9 硬门拒绝派发：' + bad + '\n   taskId=' + String(task.taskId) + '\n   修正 acceptance 后重试（R8：无判据不派发）', 3)
  }
}

/* ── 命令 ─────────────────────────────────────────────────────────── */
const loadTask = (id) => {
  if (id === undefined || id === '') die('缺少 --task')
  const p = taskPath(id)
  if (!existsSync(p)) die('台账不存在：' + p)
  return readJson(p)
}

const saveTask = (t) => { t.lastProgressAt = Date.now(); writeAtomic(taskPath(t.taskId), JSON.stringify(t, null, 2)) }

const cmdNew = () => {
  const intentRef = String(args.intent ?? '').trim()
  const acceptance = String(args.acceptance ?? '').trim()
  const assignee = String(args.assignee ?? '').trim()
  if (intentRef === '') die('缺少 --intent（主人的原话摘录，不转述）')
  if (assignee === '') die('缺少 --assignee')
  const bad = acceptanceProblem(acceptance)
  if (bad !== null) die('!! 拒绝建账：' + bad + '\n   R8/I9：无判据不派发——先想清楚「怎么算完成」再建账', 3)

  const taskId = newId('t')
  const task = {
    v: 1,
    taskId,
    intentRef,
    createdBy: 'primary',
    assignee,
    acceptance,
    grade: String(args.grade ?? 'L1'),
    status: 'drafted',
    steps: args.steps !== undefined ? String(args.steps).split(';').map((s) => s.trim()).filter((s) => s !== '') : [],
    createdAt: Date.now(),
    lastProgressAt: Date.now(),
    budget: { turns: Number(args['budget-turns'] ?? 20), toolCalls: Number(args['budget-calls'] ?? 80) },
    result: null,
    verdict: null,
  }
  saveTask(task)
  ok('created ' + taskId + ' (drafted, assignee=' + assignee + ')')
  ok('  acceptance: ' + acceptance)
}

const cmdDispatch = () => {
  const task = loadTask(args.task)
  if (['returned', 'verifying', 'done', 'failed'].includes(task.status)) die('任务已是 ' + task.status + '，不再派发')
  gate(task) // ← 派发前的最后一道检查（I9）

  let payload
  if (args.payload !== undefined) {
    if (!existsSync(String(args.payload))) die('payload 文件不存在：' + args.payload)
    payload = readJson(String(args.payload))
  } else {
    die('缺少 --payload <file.json>（节点执行的是结构化指令，不是自然语言——适配器不会猜意图）')
  }

  const msgId = newId('m')
  const msg = {
    v: 1,
    id: msgId,
    from: 'primary',
    to: task.assignee,
    kind: 'task',
    text: String(args.text ?? ('任务 ' + task.taskId + '：' + task.intentRef)),
    createdAt: Date.now(),
    ttlMs: Number(args.ttlMs ?? 86400000),
    meta: { taskId: task.taskId, acceptance: task.acceptance, grade: task.grade, payload },
  }
  const dest = join(busDir, 'mailbox', task.assignee, msgId + '.json')
  if (existsSync(dest)) die('投递目标文件已存在（no-clobber）：' + dest)
  writeAtomic(dest, JSON.stringify(msg, null, 2))

  task.status = 'dispatched'
  saveTask(task)
  ok('dispatched ' + task.taskId + ' → ' + task.assignee + ' (msg ' + msgId + ')')
}

const cmdCollect = () => {
  const as = String(args.as ?? '')
  if (as === '') die('缺少 --as <primaryNodeId>（主脑自己的 nodeId）')
  const inbox = join(busDir, 'mailbox', as)
  if (!existsSync(inbox)) die('收件箱不存在：' + inbox)
  let n = 0
  for (const name of readdirSync(inbox).filter((x) => x.endsWith('.json'))) {
    const file = join(inbox, name)
    const msg = readJsonSafe(file)
    if (msg === null) continue
    const taskId = msg.meta !== undefined && msg.meta !== null ? String(msg.meta.taskId ?? '') : ''
    if (String(msg.kind) !== 'result' || taskId === '') continue
    const p = taskPath(taskId)
    if (!existsSync(p)) { ok('!! 收到 ' + taskId + ' 的结果但无台账（孤儿结果）：' + name); continue }
    const task = readJson(p)
    task.result = {
      status: String(msg.meta.status ?? ''),
      summary: String(msg.meta.summary ?? msg.text ?? ''),
      evidence: Array.isArray(msg.meta.evidence) ? msg.meta.evidence : [],
      unverified: Array.isArray(msg.meta.unverified) ? msg.meta.unverified : [],
      learnings: Array.isArray(msg.meta.learnings) ? msg.meta.learnings : [],
      by: String(msg.from ?? ''),
      at: Number(msg.createdAt ?? Date.now()),
    }
    if (task.status !== 'done' && task.status !== 'failed') task.status = 'returned'
    saveTask(task)
    const done = join(inbox, 'done')
    mkdirSync(done, { recursive: true })
    try { renameSync(file, join(done, name)) } catch { /* 留待下次 */ }
    n += 1
    ok('collected ' + taskId + ' ← ' + String(msg.from) + '  status=' + String(msg.meta.status) + '  evidence=' + String(task.result.evidence.length))
  }
  ok('collect 完成：回填 ' + String(n) + ' 条')
}

const cmdVerdict = () => {
  const task = loadTask(args.task)
  if (task.result === null) die('任务尚未回结果，不能裁决（先 collect）')
  const pass = String(args.pass ?? '') === 'true'
  const method = String(args.method ?? '').trim()
  if (method === '') die('缺少 --method（复现证据 / 核对证据 / …）—— 裁决必须写明用什么方法验的')
  task.verdict = { by: 'primary', at: Date.now(), pass, method, note: String(args.note ?? '') }
  task.status = pass ? 'done' : 'failed'
  saveTask(task)
  ok('verdict ' + task.taskId + ' → ' + task.status + ' (' + method + ')')
}

const cmdList = () => {
  if (!existsSync(tasksDir)) { ok('（无台账目录）'); return }
  const rows = readdirSync(tasksDir).filter((x) => x.endsWith('.json')).map((x) => readJsonSafe(join(tasksDir, x))).filter((t) => t !== null)
  const st = args.status !== undefined ? String(args.status) : null
  const as = args.assignee !== undefined ? String(args.assignee) : null
  const sel = rows.filter((t) => (st === null || t.status === st) && (as === null || t.assignee === as))
  if (sel.length === 0) { ok('（无匹配任务）'); return }
  ok(['taskId', 'status', 'assignee', 'evidence', 'summary'].join('\t'))
  for (const t of sel.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
    const ev = t.result !== null && Array.isArray(t.result.evidence) ? t.result.evidence.length : 0
    const sum = t.result !== null ? String(t.result.summary).slice(0, 48) : String(t.intentRef).slice(0, 48)
    ok([t.taskId, t.status, t.assignee, String(ev), sum].join('\t'))
  }
}

const cmdShow = () => { const t = loadTask(args.task); ok(JSON.stringify(t, null, 2)) }

const USAGE = [
  'usage: node scripts/ledger.mjs <new|dispatch|collect|verdict|list|show> [--bus <dir>] …',
  '  new      --intent <原话> --acceptance <判据> --assignee <nodeId> [--grade L1] [--steps "a;b"]',
  '  dispatch --task <id> --payload <file.json> [--text <说明>]',
  '  collect  --as <primaryNodeId>',
  '  verdict  --task <id> --pass true|false --method <方法> [--note <说明>]',
  '  list     [--status <s>] [--assignee <id>]',
  '  show     --task <id>',
].join('\n')

// 缺值一律显式报错——绝不静默填默认值。
// 教训（实测）：PowerShell 会吞掉空字符串参数（`--acceptance "" --assignee x` 到 node 时只剩
// `--acceptance --assignee`），旧解析器据此判定「布尔标志」→ 静默填 'true' → 判据门被绕过。
// 现在缺值 → 明确告知「缺少值」，让「空判据」与「参数写错」可区分。
if (missingArg.length > 0) {
  die('参数缺少值：' + missingArg.join(', ') + '\n  本工具没有布尔标志——所有 --key 都必须带值。\n  （PowerShell 会吞掉空字符串参数：传空判据请用带引号的空格，或改由文件传入）', 2)
}

switch (cmd) {
  case 'new': cmdNew(); break
  case 'dispatch': cmdDispatch(); break
  case 'collect': cmdCollect(); break
  case 'verdict': cmdVerdict(); break
  case 'list': cmdList(); break
  case 'show': cmdShow(); break
  default: die(USAGE)
}

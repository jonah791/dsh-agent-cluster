#!/usr/bin/env node
/**
 * leader.mjs — 主脑租约的 CLI 与验收装置（`src/leader.ts` 的可执行面）。
 *
 * 为什么是脚本而不是插件工具（2026-09-23）：本窗口内 `src/index.ts` 上有别人的未提交改动，
 * 接线要动配置 schema + 工具注册 + 心跳协议，tsc 与契约风险都在；而**选举逻辑的验收**
 * 不需要工具面。⇒ 先用 CLI 把机制跑通并留下可复现读数，工具面接线列为待办。
 *
 * 命令：
 *   node scripts/leader.mjs status [--bus <dir>]      # 总线上的主脑 + 候选资格（只读）
 *   node scripts/leader.mjs claim  --self <nodeId>    # 以该身份抢占租约（CAS，写总线）
 *   node scripts/leader.mjs sim                       # 三端竞争 + 失效接管 + 自降级（临时目录，不碰生产总线）
 *
 * 租约布局（沿用 `docs/design.md` §15.1）：`<busDir>/state/primary-lease-<epoch>.json`
 * 内容 `{ owner, epoch, atMs, ttlMs }`。**谁先原子创建成功谁是主脑**——用 `publishNoClobber`
 * 的 `link()` 语义当 CAS，不发明新机制。
 *
 * ⚠ 读数范围标注：候选的 `kind` / `trust` / `leaderEligible` **不在心跳里**（心跳只有
 * role/profile/port/atMs 等），因此 status 从总线名册构造候选时一律按 `unknown`（= 桌面权重）
 * 且 `trust='known'`、`leaderEligible=true`。⇒ **当前总线上的选举实际上只按「在线 + 新鲜度」定序**；
 * 「手表端不合格」这类判据要生效，必须先让心跳带上端类型声明（待办）。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteJson, publishNoClobber } from '../lib/bus.js'
import {
  DEFAULT_LEASE_TTL_MS, decideLeader, describeLeader, grantLease, normalizeKind, parseLease,
} from '../lib/leader.js'

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 本机默认总线目录（与插件 `busRoot` 缺省一致）。 */
function defaultBusDir() {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.'
  return join(home, '.dsh-cluster')
}

/** 读总线上的**最新**租约：列 `primary-lease-*.json`，取 epoch 最大的那个。 */
function readLease(busDir) {
  const stateDir = join(busDir, 'state')
  let files
  try { files = readdirSync(stateDir) } catch { return { lease: null, note: 'state 目录不存在（尚未有过任何租约）' } }
  let best = null
  let scanned = 0
  for (const f of files) {
    if (!f.startsWith('primary-lease-') || !f.endsWith('.json')) continue
    scanned++
    try {
      const parsed = parseLease(JSON.parse(readFileSync(join(stateDir, f), 'utf8')))
      if (parsed === null) continue
      if (best === null || parsed.epoch > best.epoch) best = parsed
    } catch { /* 坏文件跳过——选举不因坏文件停摆 */ }
  }
  return { lease: best, note: '扫到 ' + scanned + ' 个租约文件' }
}

/** 从总线名册构造候选（心跳里没有端类型声明 ⇒ 一律 unknown，见文件头的范围标注）。 */
function candidatesFromBus(busDir, nowMs, offlineAfterMs) {
  const nodesDir = join(busDir, 'nodes')
  let files
  try { files = readdirSync(nodesDir) } catch { return [] }
  const out = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const hb = JSON.parse(readFileSync(join(nodesDir, f), 'utf8'))
      const atMs = typeof hb.atMs === 'number' ? hb.atMs : 0
      const ageMs = nowMs - atMs
      out.push({
        nodeId: String(hb.nodeId ?? f.replace(/\.json$/, '')),
        ageMs,
        online: ageMs <= offlineAfterMs,
        kind: normalizeKind(hb.kind),
        trust: typeof hb.trust === 'string' ? hb.trust : 'known',
        leaderEligible: hb.leaderEligible !== false,
        // 缺省 = 不具备：能力要自报，不靠猜（老版本节点 / 别的应用里的旧构建不写这个字段）。
        leaderCapable: hb.leaderCapable === true,
      })
    } catch { /* 坏心跳跳过 */ }
  }
  return out
}

const command = process.argv[2]
const busDir = argValue('--bus') ?? defaultBusDir()
const nowMs = Date.now()
const OFFLINE_AFTER_MS = 30_000

if (command === 'status') {
  const { lease, note } = readLease(busDir)
  const candidates = candidatesFromBus(busDir, nowMs, OFFLINE_AFTER_MS)
  const decision = decideLeader({ self: '__observer__', candidates, lease, nowMs })
  console.log('总线 ' + busDir + '（' + note + '）')
  console.log(describeLeader(decision, nowMs, lease))
  console.log('候选 ' + candidates.length + ' 个（在线 ' + candidates.filter((c) => c.online).length + '）')
  for (const c of candidates.slice().sort((a, b) => a.ageMs - b.ageMs).slice(0, 8)) {
    console.log('  ' + (c.online ? '在线' : '离线') + '  ' + c.nodeId + '  心跳 ' + Math.round(c.ageMs / 1000) + 's 前  端=' + c.kind)
  }
  process.exit(0)
}

if (command === 'claim') {
  const self = argValue('--self')
  if (self === undefined || self === '') { console.error('claim 需要 --self <nodeId>'); process.exit(3) }
  const { lease } = readLease(busDir)
  const candidates = candidatesFromBus(busDir, nowMs, OFFLINE_AFTER_MS)
  if (!candidates.some((c) => c.nodeId === self)) {
    console.error('拒绝：' + self + ' 不在总线名册里（先让该节点写心跳）')
    process.exit(4)
  }
  const decision = decideLeader({ self, candidates, lease, nowMs })
  console.log(describeLeader(decision, nowMs, lease))
  if (decision.action !== 'take') {
    console.log('未抢占（action=' + decision.action + '）——不写总线')
    process.exit(0)
  }
  const dest = join(busDir, 'state', 'primary-lease-' + decision.epoch + '.json')
  const r = publishNoClobber(dest, grantLease(self, decision.epoch, nowMs), 'lease-' + decision.epoch + '-' + self)
  if (r.ok) {
    console.log('已抢占：epoch ' + decision.epoch + ' → ' + dest)
    process.exit(0)
  }
  console.log('抢占失败（' + (r.duplicate ? '别人先创建了同一 epoch' : String(r.error)) + '）——本轮不重试，避免紧转轮')
  process.exit(0)
}

if (command === 'sim') {
  const dir = mkdtempSync(join(tmpdir(), 'leader-sim-'))
  try {
    const nodes = [
      { nodeId: 'desk', ageMs: 2000, online: true, kind: 'desktop', trust: 'known', leaderEligible: true, leaderCapable: true },
      { nodeId: 'phone', ageMs: 500, online: true, kind: 'phone', trust: 'known', leaderEligible: true, leaderCapable: true },
      { nodeId: 'watch', ageMs: 100, online: true, kind: 'watch', trust: 'known', leaderEligible: true, leaderCapable: true },
    ]
    const t0 = nowMs
    let pass = 0
    let fail = 0
    const check = (name, cond, detail) => {
      if (cond) { pass++; console.log('  ok   ' + name + (detail === undefined ? '' : '  [' + detail + ']')) }
      else { fail++; console.log('  FAIL ' + name + (detail === undefined ? '' : '  [' + detail + ']')) }
    }

    console.log('模拟目录 ' + dir + '（临时，不碰生产总线）')
    console.log('\n① 无租约 ⇒ 端权重定胜负（服务器/桌面 > 手机 > 手表）')
    const d1 = decideLeader({ self: 'watch', candidates: nodes, lease: null, nowMs: t0 })
    check('desktop 胜出', d1.leaderId === 'desk', 'leader=' + String(d1.leaderId) + ' epoch=' + d1.epoch)
    check('watch 未自认主脑', d1.action === 'none', 'action=' + d1.action)

    console.log('\n② 手表自认主脑 ⇒ 拒绝（不合格端永不 take）')
    const d2 = decideLeader({ self: 'watch', candidates: [nodes[2]], lease: null, nowMs: t0 })
    check('watch 不合格 ⇒ 无主', d2.leaderId === null && d2.action === 'none', 'reason=' + d2.reason)

    console.log('\n③ CAS 抢占：同一 epoch 文件第二个创建者必须失败')
    const lease = grantLease('desk', 1, t0)
    const first = publishNoClobber(join(dir, 'primary-lease-1.json'), lease, 'n1')
    const second = publishNoClobber(join(dir, 'primary-lease-1.json'), grantLease('phone', 1, t0), 'n2')
    check('第一个创建成功（新建）', first.ok === true && first.duplicate === false, JSON.stringify(first))
    // `publishNoClobber` 的语义是「不覆盖」：文件已存在 ⇒ ok:true + duplicate:true（幂等，不是错误）。
    // ⇒ 抢占成功 = ok && !duplicate。本条断言第一版写成 `ok === false`，被本模拟当场抓出。
    check('第二个未落盘（duplicate=true 即未新建）', second.ok === true && second.duplicate === true, JSON.stringify(second))

    console.log('\n④ 租约过期 ⇒ 接管，epoch + 1')
    const expired = grantLease('desk', 1, t0 - 200_000, DEFAULT_LEASE_TTL_MS)
    const d4 = decideLeader({ self: 'desk', candidates: nodes, lease: expired, nowMs: t0 })
    check('接管且 epoch=2', d4.action === 'take' && d4.epoch === 2, 'action=' + d4.action + ' epoch=' + d4.epoch)

    console.log('\n⑤ 自降级：旧主看到更高 epoch ⇒ step-down（防脑裂）')
    const usurped = grantLease('phone', 7, t0, DEFAULT_LEASE_TTL_MS)
    const d5 = decideLeader({ self: 'desk', candidates: nodes, lease: usurped, ownEpoch: 6, nowMs: t0 })
    check('step-down', d5.action === 'step-down', 'leader=' + String(d5.leaderId) + ' epoch=' + d5.epoch)

    console.log('\n⑥ 租约有效 ⇒ 稳定优先（不因别人更强而重选）')
    const held = grantLease('phone', 3, t0, DEFAULT_LEASE_TTL_MS)
    const d6 = decideLeader({ self: 'desk', candidates: nodes, lease: held, nowMs: t0 })
    check('服从现任', d6.action === 'none' && d6.leaderId === 'phone', 'action=' + d6.action)

    console.log('\n⑦ 全部离线 ⇒ 无主态（点对点不受影响）')
    const offline = nodes.map((n) => ({ ...n, online: false }))
    const d7 = decideLeader({ self: 'desk', candidates: offline, lease: null, nowMs: t0 })
    check('无主', d7.leaderId === null, 'reason=' + d7.reason)

    console.log('\n⑧ 续租：在任者看到自己的有效租约 ⇒ renew（不是 take，不涨 epoch）')
    const mine = grantLease('desk', 4, t0, DEFAULT_LEASE_TTL_MS)
    const d8 = decideLeader({ self: 'desk', candidates: nodes, lease: mine, ownEpoch: 4, nowMs: t0 })
    check('renew 且 epoch 不变', d8.action === 'renew' && d8.epoch === 4, 'action=' + d8.action + ' epoch=' + d8.epoch)

    console.log('\n⑨ take 与 renew 的**写盘语义不同**（本次改动的核心，必须验）')
    // take = 新建任期 ⇒ no-clobber 表达「同一 epoch 只许一个赢家」；
    // renew = 同一 epoch 换新 atMs ⇒ **必须覆盖**。若续租也用 no-clobber，它会因文件已存在而恒失败
    // ⇒ 租约到期、主脑消失。这条检查就是那个陷阱的尸体样本。
    const leasePath = join(dir, 'primary-lease-1.json')
    const renewViaNoClobber = publishNoClobber(leasePath, grantLease('desk', 1, t0 + 30_000), 'n3')
    check('续租若用 no-clobber 会失败（duplicate=true ⇒ 这是陷阱本身）',
      renewViaNoClobber.duplicate === true, JSON.stringify(renewViaNoClobber))
    const renewed = atomicWriteJson(leasePath, grantLease('desk', 1, t0 + 30_000), 'n4')
    check('续租用覆盖写 ⇒ 成功', renewed.ok === true, JSON.stringify(renewed))
    const after = JSON.parse(readFileSync(leasePath, 'utf8'))
    check('覆盖后 owner/epoch 不变、atMs 前进',
      after.owner === 'desk' && after.epoch === 1 && after.atMs === t0 + 30_000, JSON.stringify(after))

    console.log('\n模拟汇总：pass ' + pass + ' / fail ' + fail)
    process.exit(fail === 0 ? 0 : 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.error('usage: node scripts/leader.mjs status|claim --self <id>|sim [--bus <dir>]')
process.exit(3)

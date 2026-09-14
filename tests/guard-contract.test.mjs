/**
 * guard-contract.test.mjs — 进程存活守卫契约（源码级回归守卫）。
 *
 * 事故（2026-09-14 实测）：投递途中 `ctx.sessions.list()`（cordis 严格代理）抛错 →
 * 异常从 `setInterval` 回调逃逸 → **web 退出 code=1**（消息到达 1 秒后进程消失，
 * 轨迹里连该消息的一条记录都没有）。插件与宿主**同进程**：任何逃逸异常都是宿主的死因。
 *
 * 本套件不测行为，测**结构**——防止后来者（包括我自己）绕过兜底：
 *   1. 所有定时器回调必须经 `guarded(...)` 包装；
 *   2. `deliverOne` 只能从 `safeDeliver` 单点进入；
 *   3. 代理访问（ctx.sessions / ctx.agents）必须在 try 内。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const lines = src.split('\n')

test('守卫契约 1：所有 setInterval 回调都经 guarded 包装（逃逸即杀宿主）', () => {
  const timerLines = lines.filter((l) => l.includes('setInterval('))
  assert.ok(timerLines.length >= 2, '应有两个定时器（心跳/轮询），实际 ' + String(timerLines.length))
  for (const l of timerLines) {
    assert.match(l, /setInterval\(\(\)\s*=>\s*\{\s*guarded\(/, '定时器回调必须包 guarded：' + l.trim())
  }
})

test('守卫契约 2：deliverOne 只能经 safeDeliver 单点调用（保证单条消息的异常不外抛）', () => {
  const callSites = lines.filter((l) => /\bdeliverOne\(/.test(l) && !/const deliverOne\s*=/.test(l))
  assert.equal(callSites.length, 1, '只允许 safeDeliver 内的唯一调用点，实际 ' + String(callSites.length) + ' 处')
  assert.match(callSites[0], /return deliverOne\(/)
})

test('守卫契约 3：代理访问（ctx.sessions.list / ctx.agents.get）都在 try 内', () => {
  const sessionsFn = src.slice(src.indexOf('const sessionLite'), src.indexOf('const sessionLite') + 700)
  assert.match(sessionsFn, /try\s*\{/, 'sessionLite 必须自带 try')
  assert.match(sessionsFn, /catch\s*\(/, 'sessionLite 必须自带 catch')
  const agentsIdx = src.indexOf('ctx.agents.get(')
  assert.ok(agentsIdx > 0, '应存在 ctx.agents.get 调用')
  const around = src.slice(Math.max(0, agentsIdx - 260), agentsIdx + 120)
  assert.match(around, /catch\s*\(/, 'ctx.agents.get 必须在 try/catch 内')
})

test('守卫契约 4：投递失败的退避账不会静默丢失（deliver-error 分支存在）', () => {
  assert.match(src, /trace\('deliver-error'/, 'safeDeliver 的异常分支必须落痕')
  assert.match(src, /trace\('guarded-error'/, 'guarded 的异常分支必须落痕')
  assert.match(src, /takeOverInbox/, '改名时必须接管旧收件箱（I2 不丢消息）')
})

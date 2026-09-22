/**
 * http-node.ts — 跨机承载的 IO 层：一个**自己开的**小 HTTP 端点 + 出站推送。
 *
 * 为什么自己开端口：DSH web 只监听 loopback（官方明确拒绝 `0.0.0.0`）⇒ 想跨机必须自建端点，
 * 且**不能碰宿主的 web 端口**（`design.md` §八 约束 6 已定，本文件把它落成代码）。
 *
 * 纪律（`docs/members.md` §5.3）：
 *   · 出入站都由**调用方**决定开关（本模块不读配置，便于离线测）；
 *   · 无密钥 / 错密钥 / 非成员 ⇒ 拒，且**不解析正文**；
 *   · 正文有**字节上限**（防大包打爆内存）；
 *   · 所有拒绝都走 `trace` 留痕——机制要能回答「为什么没收 / 为什么没发」。
 * @module dsh-agent-cluster/http-node
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { decideInbound, peerUrlRejection, signBody } from './transport.ts'
import type { MemberRecord } from './transport.ts'

/** 入站路径（`members.md` §5.3 的协议面）。 */
export const INBOX_PATH = '/cluster/inbox'
/** 存活探针路径：**未认证**且只回协议版本（不含任何敏感信息）。 */
export const PING_PATH = '/cluster/ping'

/**
 * 轨迹写入函数形状。
 * 返回 `unknown` 而不是 `boolean`：本仓库既有的 `trace` 返回 void，而新写的观测层返回 bool——
 * 契约收在「**不抛、不反噬主流程**」这一条上（§5.22 §3），不强行统一返回值形态。
 */
export type TraceFn = (event: string, fields?: Record<string, unknown>) => unknown

/** 监听器选项（全部由调用方注入：本模块不做配置决策）。 */
export interface HttpNodeOptions {
  /** 监听端口；0 = 系统分配（测试用）。 */
  port: number
  /** 监听地址；缺省 `127.0.0.1`（跨机需显式改，**故意不是默认**）。 */
  host?: string
  secret: string
  allowInbound: boolean
  /** 现读成员册（可变：成员登记/撤销后立刻生效，不需要重启）。 */
  members: () => readonly MemberRecord[]
  /** 收到**已通过全部准入**的消息正文时调用（调用方负责落进本地总线收件箱）。 */
  onInbound: (body: string, fromMemberId: string) => void
  trace: TraceFn
  /** 时钟（测试可注入）。 */
  nowMs?: () => number
  /** 正文字节上限。 */
  maxBodyBytes?: number
}

/** 监听器句柄。 */
export interface HttpNodeHandle {
  /** 实际监听端口（`port: 0` 时是系统分配的）。 */
  port: number
  close: () => Promise<void>
}

/** 读请求正文（带**字节上限**；超限即拒并停止累积）。 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; body: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const done = (r: { ok: true; body: string } | { ok: false; reason: string }): void => {
      if (settled) return
      settled = true
      resolve(r)
    }
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxBytes) {
        done({ ok: false, reason: 'body-too-large' })
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => done({ ok: true, body: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', () => done({ ok: false, reason: 'read-error' }))
  })
}

/** 写 JSON 响应（观测不反噬：写失败只吞，不抛）。 */
function reply(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  } catch {
    try {
      res.destroy()
    } catch { /* 连接已断 */ }
  }
}

/** 取头（归一为小写键；非字符串一律空串——输入不可信）。 */
function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name]
  return typeof v === 'string' ? v : ''
}

/**
 * 启动入站端点。
 * @param opts - 见 `HttpNodeOptions`
 * @returns 句柄（含真实端口与 `close`）
 */
export function startHttpNode(opts: HttpNodeOptions): Promise<HttpNodeHandle> {
  const maxBodyBytes = opts.maxBodyBytes ?? 64 * 1024
  const now = opts.nowMs ?? (() => Date.now())
  const host = opts.host ?? '127.0.0.1'

  const server: Server = createServer((req, res) => {
    // 回调整体兜底（§5.24：逃逸异常会杀死宿主 web）
    try {
      const url = (req.url ?? '').split('?')[0]
      if (req.method === 'GET' && url === PING_PATH) {
        reply(res, 200, { ok: true, protocol: 'v1' })
        return
      }
      if (req.method !== 'POST' || url !== INBOX_PATH) {
        reply(res, 404, { ok: false, reason: 'not-found' })
        return
      }
      void readBody(req, maxBodyBytes).then((r) => {
        try {
          if (!r.ok) {
            opts.trace('http-inbound-reject', { reason: r.reason })
            reply(res, 413, { ok: false, reason: r.reason })
            return
          }
          const decision = decideInbound({
            allowInbound: opts.allowInbound,
            memberId: header(req, 'x-cluster-from'),
            timestampMs: Number(header(req, 'x-cluster-ts')),
            signature: header(req, 'x-cluster-sig'),
            body: r.body,
            secret: opts.secret,
            members: opts.members(),
            nowMs: now(),
          })
          if (!decision.ok) {
            opts.trace('http-inbound-reject', { status: decision.status, reason: decision.reason, from: header(req, 'x-cluster-from') })
            reply(res, decision.status, { ok: false, reason: decision.reason })
            return
          }
          opts.onInbound(decision.body, decision.memberId)
          opts.trace('http-inbound-ok', { from: decision.memberId, bytes: Buffer.byteLength(decision.body) })
          reply(res, 200, { ok: true })
        } catch (e) {
          opts.trace('http-inbound-error', { message: e instanceof Error ? e.message : String(e) })
          reply(res, 500, { ok: false, reason: 'internal' })
        }
      })
    } catch (e) {
      opts.trace('http-handler-error', { message: e instanceof Error ? e.message : String(e) })
      reply(res, 500, { ok: false, reason: 'internal' })
    }
  })

  return new Promise((resolve, reject) => {
    server.on('error', (e) => {
      opts.trace('http-listen-error', { message: e instanceof Error ? e.message : String(e) })
      reject(e instanceof Error ? e : new Error(String(e)))
    })
    server.listen(opts.port, host, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port
      opts.trace('http-listen', { port, host, allowInbound: opts.allowInbound })
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

/** 出站推送结果。 */
export interface PushResult {
  ok: boolean
  status: number
  reason?: string
}

/**
 * 推一条消息到远端成员。
 * **本地策略先于网络**：地址不合规（明文 http 到非回环）⇒ 请求根本不发出（fail-closed）。
 * @param opts - `url` / `secret` / `body` / `fromMemberId` / 可选 `fetchImpl`（测试替身）/ `timeoutMs`
 */
export async function pushToPeer(opts: {
  url: string
  secret: string
  body: string
  fromMemberId: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  nowMs?: number
}): Promise<PushResult> {
  const rejection = peerUrlRejection(opts.url)
  if (rejection !== null) return { ok: false, status: 0, reason: 'url-' + rejection }
  if (opts.secret === '') return { ok: false, status: 0, reason: 'no-secret' }
  const ts = opts.nowMs ?? Date.now()
  let sig: string
  try {
    sig = signBody(opts.secret, opts.body, ts)
  } catch (e) {
    return { ok: false, status: 0, reason: e instanceof Error ? e.message : 'sign-failed' }
  }
  const doFetch = opts.fetchImpl ?? fetch
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000)
  try {
    const res = await doFetch(opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-cluster-from': opts.fromMemberId,
        'x-cluster-ts': String(ts),
        'x-cluster-sig': sig,
      },
      body: opts.body,
      signal: ac.signal,
    })
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, reason: 'http-' + String(res.status) }
  } catch (e) {
    return { ok: false, status: 0, reason: 'network: ' + (e instanceof Error ? e.message : String(e)) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 便捷封装：直接读磁盘成员册（要注入 IO 的版本见 `readMembers`）。
 * 之所以放在这里而不是调用方：让 `index.ts` 不必为了读册子再引入 `node:fs`
 * （依赖面越小，插件越可维护——§5.22）。
 */
export function readMembersFromDisk(
  dir: string,
  parse: (raw: unknown) => MemberRecord | null,
): { members: MemberRecord[]; skipped: string[] } {
  return readMembers(dir, (p) => readdirSync(p), (p) => readFileSync(p, 'utf8'), parse)
}

/** 成员册目录（总线内的标准位置：`<busDir>/members/<memberId>.json`）。 */
export function memberDirOf(busRoot: string): string {
  return busRoot + '/members'
}

/**
 * 读成员册目录（IO 注入，纯解析在 `transport.parseMemberRecord`）。
 * 目录不存在 ⇒ 空册（首次使用是正常状态）；坏文件跳过并计入 `skipped`。
 */
export function readMembers(
  dir: string,
  listDir: (p: string) => string[],
  readFile: (p: string) => string,
  parse: (raw: unknown) => MemberRecord | null,
): { members: MemberRecord[]; skipped: string[] } {
  let names: string[]
  try {
    names = listDir(dir)
  } catch {
    return { members: [], skipped: [] }
  }
  const members: MemberRecord[] = []
  const skipped: string[] = []
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const parsed = parse(JSON.parse(readFile(dir + '/' + name)) as unknown)
      if (parsed === null) skipped.push(name)
      else members.push(parsed)
    } catch {
      skipped.push(name)
    }
  }
  return { members, skipped }
}

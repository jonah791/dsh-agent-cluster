/**
 * protocol.ts — 集群消息协议：构造 + 校验（纯逻辑，可离线测）。
 *
 * 设计要点（语义文档 §5.1）：
 *   - 总线文件是**不可信输入**（同机任何进程都能写）→ 一切字段必须校验，
 *     坏数据返回**分类原因**（reason）而不是抛异常，由调用方落痕并跳过。
 *   - 消息 id 是幂等键：同一 id 至多注入一次（I3）。
 *   - `text` 有硬上限（默认 8000 字符）——超长消息必须显式拒绝（附原因），
 *     不做静默截断（静默截断 = 收方看到的内容与发方不同，属语义失真）。
 */

/** 协议版本：不识别即拒绝（不猜、不降级）。 */
export const PROTOCOL_VERSION = 1

/** 消息类别：chat 对话 / task 派活 / result 回结果 / event 事件 / alert 告警。 */
export const MESSAGE_KINDS = ['chat', 'task', 'result', 'event', 'alert'] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]

/** 正文默认上限（字符）。 */
export const DEFAULT_MAX_TEXT_CHARS = 8000
/** 消息默认存活期（ms，0 = 永不过期）。 */
export const DEFAULT_TTL_MS = 86_400_000

/** 一条集群消息（落盘形态）。 */
export interface ClusterMessage {
  v: number
  id: string
  from: string
  to: string
  kind: MessageKind
  text: string
  replyTo?: string
  createdAt: number
  ttlMs: number
  meta?: Record<string, string>
}

/** 校验失败原因（分类，不是一句笼统 error）。 */
export type ParseReason =
  | 'not-object'
  | 'bad-version'
  | 'missing-field'
  | 'bad-field'
  | 'empty-text'
  | 'oversize-text'
  | 'unknown-kind'

/** 校验结果。 */
export type ParseResult =
  | { ok: true; message: ClusterMessage }
  | { ok: false; reason: ParseReason; detail: string }

/**
 * 生成消息 id：`m-<createdAt 的 base36>-<rand>`。
 * @param createdAt - 创建时刻 ms（保证同毫秒内可排序）
 * @param rand - 随机片段（由调用方提供，便于离线测试确定性）
 */
export function messageId(createdAt: number, rand: string): string {
  return 'm-' + Math.floor(createdAt).toString(36) + '-' + rand
}

/** 构造入参（除 id/createdAt/v 外的字段）。 */
export interface NewMessageInput {
  from: string
  to: string
  text: string
  kind?: MessageKind
  replyTo?: string
  ttlMs?: number
  meta?: Record<string, string>
}

/**
 * 构造一条合法消息（发送侧）。
 * @param input - 发送参数
 * @param nowMs - 当前时刻
 * @param rand - id 随机片段
 * @returns 规范化消息
 */
export function makeMessage(input: NewMessageInput, nowMs: number, rand: string): ClusterMessage {
  const msg: ClusterMessage = {
    v: PROTOCOL_VERSION,
    id: messageId(nowMs, rand),
    from: input.from,
    to: input.to,
    kind: input.kind ?? 'chat',
    text: input.text,
    createdAt: nowMs,
    ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
  }
  if (input.replyTo !== undefined && input.replyTo !== '') msg.replyTo = input.replyTo
  if (input.meta !== undefined) msg.meta = input.meta
  return msg
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * 校验一条来自总线的未知值。
 * @param raw - 解析后的 JSON 值（未经验证）
 * @param opts - 正文上限
 * @returns 合法消息或分类失败原因
 */
export function parseMessage(raw: unknown, opts: { maxTextChars?: number } = {}): ParseResult {
  const maxText = opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not-object', detail: Array.isArray(raw) ? 'array' : String(raw === null ? 'null' : typeof raw) }
  }
  const o = raw as Record<string, unknown>
  if (o['v'] !== PROTOCOL_VERSION) {
    return { ok: false, reason: 'bad-version', detail: 'v=' + String(o['v']) }
  }
  for (const key of ['id', 'from', 'to', 'text'] as const) {
    if (!isNonEmptyString(o[key])) {
      return { ok: false, reason: 'missing-field', detail: key + '=' + String(o[key]) }
    }
  }
  if (typeof o['createdAt'] !== 'number' || !isFiniteNumber(o['createdAt']) || o['createdAt'] <= 0) {
    return { ok: false, reason: 'bad-field', detail: 'createdAt=' + String(o['createdAt']) }
  }
  if (o['ttlMs'] !== undefined && (!isFiniteNumber(o['ttlMs']) || o['ttlMs'] < 0)) {
    return { ok: false, reason: 'bad-field', detail: 'ttlMs=' + String(o['ttlMs']) }
  }
  const kind = o['kind'] === undefined ? 'chat' : o['kind']
  if (typeof kind !== 'string' || !(MESSAGE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: 'unknown-kind', detail: String(kind) }
  }
  const text = o['text'] as string
  if (text.trim().length === 0) return { ok: false, reason: 'empty-text', detail: 'len=' + String(text.length) }
  if (text.length > maxText) {
    return { ok: false, reason: 'oversize-text', detail: text.length + '>' + String(maxText) }
  }
  if (o['replyTo'] !== undefined && !isNonEmptyString(o['replyTo'])) {
    return { ok: false, reason: 'bad-field', detail: 'replyTo 非字符串' }
  }
  let meta: Record<string, string> | undefined
  if (o['meta'] !== undefined) {
    if (o['meta'] === null || typeof o['meta'] !== 'object' || Array.isArray(o['meta'])) {
      return { ok: false, reason: 'bad-field', detail: 'meta 非对象' }
    }
    meta = {}
    for (const [k, v] of Object.entries(o['meta'] as Record<string, unknown>)) {
      // 未知键忽略（不拒绝整条消息）；只保留字符串值，防注入任意结构
      if (typeof v === 'string' && v.length <= 512) meta[k] = v
    }
  }
  const message: ClusterMessage = {
    v: PROTOCOL_VERSION,
    id: o['id'] as string,
    from: o['from'] as string,
    to: o['to'] as string,
    kind: kind as MessageKind,
    text,
    createdAt: o['createdAt'] as number,
    ttlMs: o['ttlMs'] === undefined ? DEFAULT_TTL_MS : (o['ttlMs'] as number),
  }
  if (o['replyTo'] !== undefined) message.replyTo = o['replyTo'] as string
  if (meta !== undefined && Object.keys(meta).length > 0) message.meta = meta
  return { ok: true, message }
}

/**
 * 消息是否已过期（ttlMs 0 = 永不过期）。
 * @param msg - 合法消息
 * @param nowMs - 当前时刻
 */
export function isExpired(msg: Pick<ClusterMessage, 'createdAt' | 'ttlMs'>, nowMs: number): boolean {
  if (msg.ttlMs <= 0) return false
  return nowMs - msg.createdAt > msg.ttlMs
}

/**
 * 注入会话时给人看的来源前缀（模型可见文本的一部分，I6/§6）。
 * @param msg - 合法消息
 */
export function injectionText(msg: Pick<ClusterMessage, 'from' | 'kind' | 'text'>): string {
  const tag = msg.kind === 'chat' ? 'cluster:' + msg.from : 'cluster:' + msg.from + '/' + msg.kind
  return '[' + tag + '] ' + msg.text
}

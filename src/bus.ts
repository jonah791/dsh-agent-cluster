/**
 * bus.ts — 共享总线目录的读写原语（IO 层）。
 *
 * 磁盘布局（语义文档 §4）：
 *   <root>/nodes/<nodeId>.json        心跳（每节点只写自己那份）
 *   <root>/mailbox/<nodeId>/<id>.json 收件箱（发送方创建，no-clobber）
 *   <root>/mailbox/<nodeId>/done/     投递成功归档
 *   <root>/mailbox/<nodeId>/dead/     重试耗尽/过期
 *   <root>/state/<nodeId>.json        本节点游标与计数
 *   <root>/cluster-trace.jsonl        全节点追加的侧车轨迹
 *
 * 写纪律（对照官方 session-persistence-jsonl）：
 *   - 覆盖式写（心跳/状态）：同目录临时文件 + rename（原子发布，读者永远看到完整文件）；
 *   - 创建式写（消息）：同目录临时文件 + `link()`（**no-clobber 原子**）+ unlink 临时文件；
 *     link 不可用（网络盘/权限）时退化为 rename 并**由调用方落痕**（宁可覆盖也不丢消息）。
 *   - 一切观测写（trace/状态）吞错返回 false，绝不反噬主流程（I7）。
 */

import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 总线路径集合。 */
export interface BusPaths {
  root: string
  nodesDir: string
  mailboxDir: string
  stateDir: string
  traceFile: string
}

/**
 * 计算总线路径集合（纯函数，不触盘）。
 * @param root - 总线根目录
 */
export function busPaths(root: string): BusPaths {
  return {
    root,
    nodesDir: join(root, 'nodes'),
    mailboxDir: join(root, 'mailbox'),
    stateDir: join(root, 'state'),
    traceFile: join(root, 'cluster-trace.jsonl'),
  }
}

/** 本节点心跳文件路径。 */
export function nodeFile(paths: BusPaths, nodeId: string): string {
  return join(paths.nodesDir, nodeId + '.json')
}

/** 本节点收件箱目录。 */
export function inboxDir(paths: BusPaths, nodeId: string): string {
  return join(paths.mailboxDir, nodeId)
}

/** 本节点状态文件路径。 */
export function stateFile(paths: BusPaths, nodeId: string): string {
  return join(paths.stateDir, nodeId + '.json')
}

/**
 * 确保总线目录存在。
 * @returns 是否全部就绪（失败时 dirs 给出缺失项）
 */
export function ensureBusDirs(paths: BusPaths, self: string): { ok: boolean; error?: string } {
  const dirs = [paths.root, paths.nodesDir, paths.mailboxDir, paths.stateDir, inboxDir(paths, self)]
  for (const d of dirs) {
    try {
      mkdirSync(d, { recursive: true })
    } catch (e) {
      return { ok: false, error: 'mkdir ' + d + ' 失败: ' + String(e) }
    }
  }
  return { ok: true }
}

const tmpName = (dest: string, nonce: string): string => dest + '.tmp-' + nonce

/**
 * 原子覆盖写 JSON（临时文件 + rename）。
 * @param dest - 目标路径
 * @param value - 任意可序列化值
 * @param nonce - 临时文件后缀（调用方给 pid+随机，避免并发撞名）
 * @returns 成功与否（失败**不抛**，由调用方决定是否升级为工具错误）
 */
export function atomicWriteJson(dest: string, value: unknown, nonce: string): { ok: boolean; error?: string } {
  const tmp = tmpName(dest, nonce)
  try {
    mkdirSync(join(dest, '..'), { recursive: true })
  } catch { /* 目录已存在或上级已在，忽略 */ }
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, dest)
    return { ok: true }
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* 清理失败不影响结论 */ }
    return { ok: false, error: String(e) }
  }
}

/**
 * no-clobber 创建 JSON（临时文件 + link + unlink）。
 * @param dest - 目标路径（已存在即视为重复，不覆盖）
 * @param value - 值
 * @param nonce - 临时文件后缀
 * @returns duplicate=true 表示已存在（幂等成功）；error 仅在真失败时给出
 */
export function publishNoClobber(dest: string, value: unknown, nonce: string): { ok: boolean; duplicate: boolean; error?: string; degraded?: boolean } {
  if (existsSync(dest)) return { ok: true, duplicate: true }
  const tmp = tmpName(dest, nonce)
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  } catch (e) {
    return { ok: false, duplicate: false, error: '写临时文件失败: ' + String(e) }
  }
  try {
    linkSync(tmp, dest)
    try { rmSync(tmp, { force: true }) } catch { /* 残留临时文件无害 */ }
    return { ok: true, duplicate: false }
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'EEXIST') {
      try { rmSync(tmp, { force: true }) } catch { /* 同上 */ }
      return { ok: true, duplicate: true }
    }
    // link 不可用（EXDEV/EPERM/ENOSYS/网络盘）→ 退化为 `wx`（O_EXCL 原子创建，**仍不覆盖**）
    try {
      writeFileSync(dest, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' })
      try { rmSync(tmp, { force: true }) } catch { /* 残留临时文件无害 */ }
      return { ok: true, duplicate: false, degraded: true }
    } catch (e2) {
      if ((e2 as { code?: string }).code === 'EEXIST') {
        try { rmSync(tmp, { force: true }) } catch { /* 同上 */ }
        return { ok: true, duplicate: true }
      }
      // 最后手段：rename（**覆盖语义**）。官方 session-persistence 明确禁止 rename——
      // 它会在并发下静默覆盖；此处只在 link 与 wx 都不可用的介质上兜底，并由调用方落痕。
      try {
        renameSync(tmp, dest)
        return { ok: true, duplicate: false, degraded: true }
      } catch (e3) {
        try { rmSync(tmp, { force: true }) } catch { /* 同上 */ }
        return { ok: false, duplicate: false, error: 'link/wx/rename 均失败: ' + String(e) + ' / ' + String(e2) + ' / ' + String(e3) }
      }
    }
  }
}

/** 读 JSON（失败返回分类错误，不抛）。 */
export function readJsonValue(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const text = readFileSync(path, 'utf8')
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 列出目录下的 `*.json` 文件名（排序；目录不存在返回空）。 */
export function listJsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort()
  } catch {
    return []
  }
}

/** 列出目录下的子目录名（排序；目录不存在返回空）。 */
export function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

/** 删除文件（不存在即成功）。 */
export function removeIfExists(path: string): boolean {
  try {
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}

/** 文件是否存在于且是普通文件。 */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 把收件箱文件移入 bucket 目录（done/dead）。
 * @returns 成功与否；目标重名时加 `.dup-<nonce>` 后缀，绝不覆盖既有归档
 */
export function moveToBucket(inbox: string, fileName: string, bucket: 'done' | 'dead', nonce: string): { ok: boolean; path?: string; error?: string } {
  const dir = join(inbox, bucket)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    return { ok: false, error: 'mkdir ' + dir + ' 失败: ' + String(e) }
  }
  const src = join(inbox, fileName)
  let dest = join(dir, fileName)
  if (existsSync(dest)) dest = join(dir, fileName.replace(/\.json$/, '') + '.dup-' + nonce + '.json')
  try {
    renameSync(src, dest)
    return { ok: true, path: dest }
  } catch (e) {
    return { ok: false, error: '移动到 ' + bucket + ' 失败: ' + String(e) }
  }
}

/**
 * 接管旧身份的待投递收件箱（改名避让时用，守护 I2「消息不丢」）。
 *
 * 2026-09-14 实测缺陷：web 重启后因同名心跳仍新鲜而改名（`web-0` → `web-0-26704`），
 * 新实例的收件箱是全新的目录，**旧收件箱里已投递的消息从此无人消费**（实测一条消息搁浅）。
 * 改名即接管：把旧 id 收件箱里的消息搬到新收件箱；同 id 已存在则跳过（保留原有）。
 *
 * @param paths - 总线路径
 * @param from - 旧身份 id（requestedId）
 * @param to - 新身份 id（改名后的 nodeId）
 * @returns 搬运/跳过/失败计数（写进轨迹，可诊断）
 */
export function takeOverInbox(paths: BusPaths, from: string, to: string): { moved: number; skipped: number; failed: number } {
  if (from === to || from === '' || to === '') return { moved: 0, skipped: 0, failed: 0 }
  const src = inboxDir(paths, from)
  const dst = inboxDir(paths, to)
  if (!existsSync(src)) return { moved: 0, skipped: 0, failed: 0 }
  try {
    mkdirSync(dst, { recursive: true })
  } catch {
    return { moved: 0, skipped: 0, failed: 1 }
  }
  let moved = 0
  let skipped = 0
  let failed = 0
  for (const f of listJsonFiles(src)) {
    const dest = join(dst, f)
    if (existsSync(dest)) { skipped += 1; continue }
    try {
      renameSync(join(src, f), dest)
      moved += 1
    } catch {
      failed += 1
    }
  }
  return { moved, skipped, failed }
}

/**
 * 追加一行轨迹（侧车，一行一 JSON）。
 * 观测层：**吞错返回 false**，绝不抛（I7）。
 * @param event - 事件对象（调用方保证可序列化且不含凭据）
 */
export function appendTrace(traceFile: string, event: Record<string, unknown>): boolean {
  try {
    appendFileSync(traceFile, JSON.stringify(event) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 读轨迹尾部若干条**有效**记录（诊断用）。
 *
 * 语义是「最近 N 条能解析的轨迹」而不是「最后 N 行」——轨迹文件是**追加写**的，
 * 崩溃时最后一行可能是半截 JSON；若按「最后 N 行」取，一次崩溃就会让诊断视图空白。
 * @param traceFile - 轨迹文件
 * @param limit - 条数上限
 */
export function tailTrace(traceFile: string, limit: number): Array<Record<string, unknown>> {
  try {
    const lines = readFileSync(traceFile, 'utf8').split('\n')
    const out: Array<Record<string, unknown>> = []
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const line = lines[i]
      if (line === undefined || line.trim().length === 0) continue
      try {
        out.push(JSON.parse(line) as Record<string, unknown>)
      } catch { /* 单行坏数据跳过（崩溃留下的半截行） */ }
    }
    return out.reverse()
  } catch {
    return []
  }
}

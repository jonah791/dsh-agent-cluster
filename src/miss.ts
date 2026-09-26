/**
 * miss.ts — 投递未成功的**语义分类**（纯逻辑，可离线用真实样本测）。
 *
 * 存在理由（2026-09-26 实测断点）：无会话节点（headless 执行节点）收到消息后，
 * `no-target` 被当成投递失败**消耗重试**，20 次后消息进 `dead/`。后果不是「投递慢」，
 * 而是**适配器再也读不到它**——headless 消费者直接读 mailbox（对照 `scripts/ref-node.mjs`），
 * 而 `dead/` 是死信区 ⇒ 本该能工作的执行节点，被插件判死而结构性收不到活。
 *
 * 分类根据只有一条：**「这次没投成」是「还没到时候」，还是「这条路对我不可用」**。
 *   - `structural`：**缺目标**——本节点没有可注入的顶层用户会话。换时刻也不会变，
 *     且判死有害 ⇒ 消息保留原位，交给「会话出现」或「适配器直接消费」，由 TTL 兜底。
 *   - `retryable`：**缺能力/缺连接**——目标选不出或选出了但取不到、注入抛错、
 *     会话列表探测失败。下个时刻可能就好 ⇒ 消耗重试，有界退避。
 *
 * ⚠ **`no-target` 与 `sessions-unavailable` 必须分开**（本模块最容易被写错的一条）：
 * 前者是「问到了，答案是没有」，后者是「根本没问到」。把后者归入 structural，
 * 等于把**宿主代理异常**误判成「本节点永久无会话」——那是把故障静默成特性。
 */

/** 投递未成功的类别。 */
export type MissKind = 'retryable' | 'structural'

/** 投递未成功的原因（与 `index.ts` 落痕的 phase 一一对应）。 */
export type MissReason = 'no-target' | 'no-agent' | 'inject-error' | 'sessions-unavailable'

/**
 * 分类一次投递未成功。
 * @param reason - 未成功的原因
 * @returns `structural` = 保留原位、不消耗重试；`retryable` = 按退避消耗重试
 */
export function classifyMiss(reason: MissReason): MissKind {
  switch (reason) {
    case 'no-target':
      // 探测**成功**但结果为空：本节点没有可注入的顶层用户会话。
      // 这不是「暂时没投成」——重试 20 次不会让会话长出来，只会把消息判死。
      return 'structural'
    case 'sessions-unavailable':
      // 探测**失败**（宿主代理异常 / 会话面不可用）：这是「没问到」，不是「没有」。
      // 归入可恢复 ⇒ 仍按退避重试，避免把故障静默成「结构性无会话」。
      return 'retryable'
    case 'no-agent':
    case 'inject-error':
      // 目标已选中，但 agent 取不到 / 注入抛错 ⇒ 下个时刻可能就好。
      return 'retryable'
  }
}

/**
 * 分类结果的人类可读理由（落轨迹用，让「为什么没投成」可诊断）。
 * @param reason - 未成功的原因
 */
export function describeMiss(reason: MissReason): string {
  switch (reason) {
    case 'no-target':
      return '本节点无顶层（用户）会话 ⇒ 结构性不可注入：消息保留在 inbox（不消耗投递重试），待会话出现或由适配器直接消费；TTL 到期进 dead'
    case 'sessions-unavailable':
      return '会话列表探测失败（宿主代理异常）⇒ 这是「没问到」而非「没有」：按退避重试'
    case 'no-agent':
      return '已选中目标会话但 agent 取不到 ⇒ 按退避重试'
    case 'inject-error':
      return '注入抛错 ⇒ 按退避重试'
  }
}

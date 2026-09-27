/**
 * leader-trace.ts — 主脑**稳定态**的落痕决策（纯函数：无 IO、无时间、无宿主耦合）。
 *
 * ## 存在理由（U16 · 2026-09-27）
 * 原实现在**每次续租成功**时落一条 `leader-renew`，而调用方 `leaderTick` 又在 `wrote`
 * 时**再落**一条 `leader-auto` ⇒ 30 秒一次、每次两条。实测：`leader-renew` 7128 +
 * `leader-auto` 7132 = **全文件 92%**，把真正的断点读数淹没。真问题不是磁盘，是**信噪比**。
 *
 * ## 与本模块的分工（职责切干净，避免两处都落 = 重复）
 * | 事件 | 性质 | 谁落 |
 * |---|---|---|
 * | `take`（取得，epoch 变） | **状态变化** | `index.ts` 的 `applyLeaderDecision` —— 逐条落 |
 * | `step-down`（让位） | **状态变化** | 同上 —— 逐条落（★ 此前完全缺失，见下） |
 * | `renew`（同一 epoch 续租成功） | **稳定态** | **本模块** —— 按「N 次 或 M 毫秒」汇总一条 |
 * | `none` 等 | 无事件 | 都不落 |
 *
 * 分工的判据是**「这件事改变状态吗」**：改变的逐条留证（排查脑裂的第一手材料），
 * 不改变的只证明「还活着」，逐条落等于噪音。
 *
 * ⚠ **一条曾经完全缺失的**：`step-down` 此前**一个字节都不落痕**，而 `leader.ts` 头注
 * 明写「立即自降为 worker **并落痕**」——承诺与实现不符，且静默的恰是防脑裂路径上
 * **最重要**的那个事件。修复与它的回归测试见 `tests/leader-trace.test.mjs` 与 `index.ts`。
 *
 * ## 汇总阈值为什么是「N 次 **或** M 毫秒」
 * 两个阈值互为兜底：续租间隔正常（TTL/3 = 30s）时由次数触发；若某段时间续租变稀（或时钟
 * 跳变），时间阈值保证「还活着」仍有证据。**只用一个都会在自己的盲区里失声。**
 */

/** 落痕决策：`'leader-renew-summary'` = 该落一条汇总；`null` = 这次不落。 */
export type LeaderTraceKind = 'leader-renew-summary' | null

/** 累计状态：跨 tick 保存（调用方持有）。 */
export interface LeaderTraceState {
  /** 自上次汇总以来成功续租的次数。 */
  readonly renewsSinceSummary: number
  /** 上一次汇总落痕的时刻（ms）。 */
  readonly lastSummaryAtMs: number
}

/** 汇总阈值。 */
export interface LeaderTraceConfig {
  /** 每 N 次续租至少汇总一条。 */
  readonly everyN: number
  /** 或每 M 毫秒至少汇总一条（低频兜底）。 */
  readonly everyMs: number
}

/** 缺省阈值：20 次 ≈ 10 分钟（续租间隔 30s 时两者几乎同时触发）⇒ 约 144 条/天，较原 5760 条降约 40 倍。 */
export const DEFAULT_LEADER_TRACE: LeaderTraceConfig = { everyN: 20, everyMs: 10 * 60_000 }

/** 决策结果。 */
export interface LeaderTraceDecision {
  readonly kind: LeaderTraceKind
  /** 汇总时带的自上次汇总以来的计数（不落时为 0）。 */
  readonly count: number
}

/** 决策 + 下一次的状态（调用方**必须**用 `next` 覆盖自己的状态，否则计数不前进）。 */
export interface LeaderTraceResult {
  readonly decision: LeaderTraceDecision
  readonly next: LeaderTraceState
}

/** 初态（插件启动时）。 */
export function initialLeaderTraceState(nowMs: number): LeaderTraceState {
  return { renewsSinceSummary: 0, lastSummaryAtMs: nowMs }
}

/**
 * 决定这次**稳定态**动作要不要落汇总痕。
 *
 * 只处理「成功续租」（`renew` 且 `wrote`）：累计，达 `everyN` 或 `everyMs` 才返回
 * `'leader-renew-summary'`（并把计数归零、时间戳前移）。
 *
 * **其余动作一律返回 `null`** —— `take` / `step-down` 是状态变化，由 `applyLeaderDecision`
 * 逐条落痕；若这里也返回它们，就会**重复落两条**（这正是本分工表要防的）。
 *
 * @param action - `decideLeader` 给出的动作。
 * @param wrote - 是否真的写了总线（`renew` 成功才为 true）。
 * @param state - 自上次汇总以来的累计状态。
 * @param nowMs - 本次时刻。
 * @param config - 阈值（缺省 {@link DEFAULT_LEADER_TRACE}）。
 */
export function decideLeaderTrace(
  action: string,
  wrote: boolean,
  state: LeaderTraceState,
  nowMs: number,
  config: LeaderTraceConfig = DEFAULT_LEADER_TRACE,
): LeaderTraceResult {
  const idle: LeaderTraceResult = { decision: { kind: null, count: 0 }, next: state }
  if (action !== 'renew' || !wrote) return idle

  const n = state.renewsSinceSummary + 1
  const dueByCount = n >= config.everyN
  const dueByTime = nowMs - state.lastSummaryAtMs >= config.everyMs
  if (dueByCount || dueByTime) {
    return {
      decision: { kind: 'leader-renew-summary', count: n },
      next: { renewsSinceSummary: 0, lastSummaryAtMs: nowMs },
    }
  }
  return {
    decision: { kind: null, count: 0 },
    next: { renewsSinceSummary: n, lastSummaryAtMs: state.lastSummaryAtMs },
  }
}

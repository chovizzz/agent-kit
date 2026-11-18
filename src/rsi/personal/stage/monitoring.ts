/**
 * §21 V1 装配块 C1a——**监测信号表**(C v2 §3.3;冻结;只有常量,无 I/O)。承载入口 = `agent-kit doctor` 的只读检查项 `rsi_safety_residual`
 * (C2 落地为 D18「安全残余」,W0-29 ⑥:doctor 只读、不拿锁;三个信号与本文件冻结阈值一一对应)。
 *
 * 背景(R-W 残余):TTL 不是释放点,spawn 闸才是调度上界;只有 worker 才能做的减影响动作**没有已证明的有限上界**,安全论证只依赖 hint 每次现读的拒绝集合。
 * 这些信号让「P 在饿死」「breaker 永不半开却仍可注入」可见;全部只读(不写任何文件)。阈值已冻结。
 */
import { RSI_LOCK_TTL_MS } from '../../../contracts/rsi.js';

export const MONITOR_THRESHOLDS = Object.freeze({
  /** `log.jsonl` 末尾连续 `skipped_locked` 的最少条数 */
  skippedLockedMinCount: 3,
  /** 首尾跨度下限 = 2 × TTL(30 分钟) */
  skippedLockedMinSpanMs: 2 * RSI_LOCK_TTL_MS,
  /** `last_tick.completed_at` 年龄上限(24 小时) */
  lastTickMaxAgeMs: 24 * 60 * 60 * 1000,
} as const);

/** 信号的只读输入端口(取法 = 现有只读原语) */
export const MONITOR_INPUTS = Object.freeze([
  'peekRsiLock',
  'log_tail',
  'state_json',
  'canary_json',
  'marker_lstat',
] as const);
export type MonitorInput = (typeof MONITOR_INPUTS)[number];

export interface MonitorSignal {
  readonly id: string;
  readonly inputs: readonly MonitorInput[];
  /** 含义(一句) */
  readonly meaning: string;
  /** 只在条件成立时才计入最低验收(`state_written_not_muted` 仅当「hint 读 state 三行」未采纳) */
  readonly conditional: boolean;
  /** 已知误报 / 近似说明 */
  readonly caveat: string | null;
}

const sig = (s: MonitorSignal): MonitorSignal => Object.freeze(s);

export const MONITOR_SIGNALS: readonly MonitorSignal[] = Object.freeze([
  sig({
    id: 'lock_starvation',
    inputs: ['peekRsiLock', 'log_tail'],
    meaning:
      '锁长期被占:`peekRsiLock` = held_over_ttl ∨ stale,且 log 末尾连续 ≥ 3 条 skipped_locked、首尾跨度 ≥ 30 分钟——持锁者非回收对象,P 在饿死',
    conditional: false,
    caveat: null,
  }),
  sig({
    id: 'safety_breaker_inject',
    inputs: ['state_json', 'canary_json', 'marker_lstat'],
    meaning:
      '安全熔断下仍可能注入:state.breaker.kind=safety ∧ canary.json.agents_inject ≠ [] ∧ B/U 皆不在——breaker 永不半开 ⇒ P 永不运行 ⇒ 该 canary 不会被 worker 静音',
    conditional: false,
    caveat: null,
  }),
  sig({
    id: 'p_heartbeat_approx',
    inputs: ['state_json'],
    meaning: 'P 心跳近似:last_tick.completed_at 年龄 > 24 小时 ∧ rsi 为 on ∧ 熔断未打开',
    conditional: false,
    caveat:
      '近似且可能对不活跃用户误报:常态零写入,P 没有自己的时间戳;不另加心跳写;hook 活动没有可靠的只读痕迹,故不作合取条件',
  }),
  sig({
    id: 'state_written_not_muted',
    inputs: ['state_json', 'canary_json', 'marker_lstat'],
    meaning:
      '状态已写未静音:auto_pause.reasons ≠ ∅ ∨ 标志 ∧ canary.json.agents_inject ≠ [] ∧ B/U 皆不在',
    conditional: true,
    caveat:
      '仅当 hint 读已提交 state.json 的 auto_pause / diverged / owner_changed(问题 1)未被采纳时才计入',
  }),
]);

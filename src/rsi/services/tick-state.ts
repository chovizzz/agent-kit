/**
 * tick 的 state 变更纯函数(R20-A2 B5 方案 §2;B5a 实装;A3 的 worker 也会用)。
 */
import type { RsiState } from '../../contracts/rsi.js';
import type { StateMutator } from '../l0/types.js';

/**
 * 读-改-写(R3):返回值**必须展开 `prev`**(含 `confirm` / `projects_ack_generation` / `armed_listing`);调用方另外再包一层 `carryConfirm`(双保险)。
 * `last_tick = {completed_at, trigger, outcome, code, duration_ms, files_read, bytes_read}`(`code`:成功为 `null`,其余取 outcome 名);`attempt = null`;
 * 成功(`ok` / `ok_partial`)→ `breaker = null`、`consecutive_failures = 0`(R20-3.1.2:成功清熔断,retryable 与 safety 都清);正常跳过类 → `breaker` 与 `consecutive_failures` 原样不动。
 * 不处理可重试 / 安全阻断(那些路径是抛错,不调 mutator;A3 交接)。
 */
export function tickStateMutator(i: {
  trigger: 'tick' | 'poke' | 'kit';
  now: () => Date;
}): StateMutator {
  return (prev, s) => {
    const base = prev ?? defaultState();
    const ok = s.outcome === 'ok' || s.outcome === 'ok_partial';
    return {
      ...base,
      attempt: null,
      last_tick: {
        completed_at: i.now().toISOString(),
        trigger: i.trigger,
        outcome: s.outcome,
        code: ok ? null : s.outcome,
        duration_ms: s.duration_ms,
        files_read: s.files_read,
        bytes_read: s.bytes_read,
      },
      ...(ok ? { breaker: null, consecutive_failures: 0 } : {}),
    };
  };
}

/** `{schema_version:1, confirm:null, projects_ack_generation:0, attempt:null, last_tick:null, consecutive_failures:0, breaker:null}` */
export function defaultState(): RsiState {
  return {
    schema_version: 1,
    confirm: null,
    projects_ack_generation: 0,
    attempt: null,
    last_tick: null,
    consecutive_failures: 0,
    breaker: null,
  };
}

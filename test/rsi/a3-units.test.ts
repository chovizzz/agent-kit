/**
 * R20-A3:纯函数单元(假时钟)。跳过条件 R20-1.6、熔断 R20-6.5 / R20-6.6、L0 到期 R20-6.3、窗口 R20-6.2、
 * hint 唯一出口 R20-3.3.2、钩子形状识别 R20-1.2a、顺带调度白名单 R20-1.7。
 */
import { describe, expect, it } from 'vitest';
import {
  RSI_BREAKER_OPEN_MS,
  RSI_L0_MIN_INTERVAL_MS,
  RSI_POKE_WINDOW_MS,
  type RsiOutcome,
  type RsiState,
} from '../../src/contracts/rsi.js';
import {
  applyBreaker,
  breakerView,
  classifyOutcome,
  l0Due,
  windowIndex,
} from '../../src/rsi/services/breaker.js';
import { defaultState } from '../../src/rsi/services/tick-state.js';
import { autoSkip } from '../../src/rsi/skip.js';
import { armedTemplate, confirmedTemplate, finalizeHint, showCount } from '../../src/rsi/hint.js';
import { hookShapeOf } from '../../src/rsi/hook-entry.js';
import { kitScheduleEligible } from '../../src/rsi/kit-schedule.js';
import { parseAgentArg } from '../../src/rsi/poke.js';
import { isRecordable, outcomeOfError } from '../../src/rsi/worker.js';
import { RsiLockError } from '../../src/rsi/lock-error.js';
import { RsiFailClosedError } from '../../src/rsi/types.js';

const T0 = Date.parse('2026-10-24T08:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

describe('R20-1.6 跳过条件(KIT_AUTO_RSI 严格 = "0" 才关,只能关不能开)', () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, false],
    ['', false],
    ['0', true],
    ['1', false],
    ['false', false],
    ['off', false],
    ['no', false],
    [' 0 ', false],
  ];
  for (const [v, off] of cases) {
    it(`KIT_AUTO_RSI=${JSON.stringify(v)} → ${off ? '跳过' : '不跳过'}(四类自动入口一致)`, () => {
      for (const kind of ['poke', 'hint', 'worker', 'kit'] as const) {
        expect(autoSkip({ KIT_AUTO_RSI: v }, kind)).toBe(off ? 'auto_off' : null);
      }
    });
  }
  it('KIT_RSI_CHILD=1 → child;CI 任一为真 → ci', () => {
    expect(autoSkip({ KIT_RSI_CHILD: '1' }, 'poke')).toBe('child');
    expect(autoSkip({ KIT_RSI_CHILD: '0' }, 'poke')).toBe(null);
    for (const k of [
      'CI',
      'GITHUB_ACTIONS',
      'GITLAB_CI',
      'BUILDKITE',
      'CIRCLECI',
      'TF_BUILD',
      'JENKINS_URL',
    ]) {
      expect(autoSkip({ [k]: 'true' }, 'hint'), k).toBe('ci');
    }
    expect(autoSkip({ CI: 'false' }, 'hint')).toBe(null);
  });
  it('KIT_LAUNCHED 只跳过顺带调度(worker 的子进程恒带它,不得因此空操作)', () => {
    expect(autoSkip({ KIT_LAUNCHED: '1' }, 'kit')).toBe('launched');
    for (const kind of ['poke', 'hint', 'worker'] as const) {
      expect(autoSkip({ KIT_LAUNCHED: '1' }, kind)).toBe(null);
    }
    expect(autoSkip({ KIT_LAUNCHED: '0' }, 'kit')).toBe(null);
  });
});

describe('R20-6.3 L0 到期(假时钟)', () => {
  const at = (ms: number): Pick<RsiState, 'last_tick'> => ({
    last_tick: {
      completed_at: iso(ms),
      trigger: 'poke',
      outcome: 'ok',
      code: null,
      duration_ms: 0,
      files_read: 0,
      bytes_read: 0,
    },
  });
  it('从未完成 → 到期', () => expect(l0Due(null, T0)).toBe(true));
  it('恰 6 小时 → 到期;差 1 毫秒 → 不到期(节流比较取反 → 红)', () => {
    expect(l0Due(at(T0), T0 + RSI_L0_MIN_INTERVAL_MS)).toBe(true);
    expect(l0Due(at(T0), T0 + RSI_L0_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(l0Due(at(T0), T0 + 1)).toBe(false);
  });
  it('时钟往回走 → 视为到期', () => expect(l0Due(at(T0), T0 - 1)).toBe(true));
});

describe('R20-6.2 窗口序号', () => {
  it('floor(now / 30 分钟);跨边界 +1', () => {
    const w = windowIndex(T0);
    expect(windowIndex(T0 + RSI_POKE_WINDOW_MS)).toBe(w + 1);
    const start = w * RSI_POKE_WINDOW_MS;
    expect(windowIndex(start)).toBe(w);
    expect(windowIndex(start - 1)).toBe(w - 1);
  });
});

describe('R20-6.5 / R20-6.6 熔断', () => {
  const s0 = defaultState();
  const now = new Date(T0);
  it('分类表', () => {
    const t: [RsiOutcome, string][] = [
      ['ok', 'success'],
      ['ok_partial', 'success'],
      ['skipped_throttled', 'skip'],
      ['skipped_binding_changed', 'skip'],
      ['stopped', 'skip'],
      ['io_error', 'retryable'],
      ['crashed', 'retryable'],
      ['internal', 'retryable'],
      ['salt_invalid', 'safety'],
      ['purge_incomplete', 'safety'],
      ['lock_lost', 'safety'],
    ];
    for (const [o, c] of t) expect(classifyOutcome(o), o).toBe(c);
  });
  it('可重试连续 3 次 → 打开 24h;前两次只计数', () => {
    let s = applyBreaker(s0, 'io_error', now, false);
    expect(s.consecutive_failures).toBe(1);
    expect(s.breaker).toBeNull();
    s = applyBreaker(s, 'crashed', now, false);
    expect(s.consecutive_failures).toBe(2);
    s = applyBreaker(s, 'internal', now, false);
    expect(s.breaker).toEqual({
      kind: 'retryable',
      opened_at: iso(T0),
      until: iso(T0 + RSI_BREAKER_OPEN_MS),
    });
    expect(s.consecutive_failures).toBe(0);
  });
  it('跳过类不动熔断与计数;成功清零并关闭', () => {
    const open = applyBreaker({ ...s0, consecutive_failures: 2 }, 'io_error', now, false);
    expect(applyBreaker({ ...s0, consecutive_failures: 2 }, 'skipped_locked', now, false)).toEqual({
      ...s0,
      consecutive_failures: 2,
    });
    expect(applyBreaker(open, 'ok', now, true)).toEqual({
      ...open,
      breaker: null,
      consecutive_failures: 0,
    });
  });
  it('半开尝试失败 → 立刻再开 24h(不等累计 3 次)', () => {
    const s = applyBreaker(s0, 'io_error', now, true);
    expect(s.breaker?.kind).toBe('retryable');
  });
  it('安全阻断 → 立即打开、kind=safety、until=null、不自动半开', () => {
    const s = applyBreaker(s0, 'signal_store_corrupt', now, false);
    expect(s.breaker).toEqual({ kind: 'safety', opened_at: iso(T0), until: null });
    expect(breakerView(s, T0 + 10 * RSI_BREAKER_OPEN_MS)).toBe('open');
  });
  it('视图:关闭 / 打开(到 until 之前)/ 半开(到点);until 不可解析 → 打开', () => {
    expect(breakerView(s0, T0)).toBe('closed');
    const r = applyBreaker(
      applyBreaker(applyBreaker(s0, 'io_error', now, false), 'io_error', now, false),
      'io_error',
      now,
      false,
    );
    expect(breakerView(r, T0 + RSI_BREAKER_OPEN_MS - 1)).toBe('open');
    expect(breakerView(r, T0 + RSI_BREAKER_OPEN_MS)).toBe('half_open');
    expect(breakerView(r, T0 - 60_000)).toBe('open'); // 时钟回拨仍以 until 判
    const bad = {
      breaker: { kind: 'retryable' as const, opened_at: iso(T0), until: 'x' as unknown as string },
    };
    expect(breakerView(bad, T0 + 10 * RSI_BREAKER_OPEN_MS)).toBe('open');
  });
});

describe('worker 抛错分类与可记录性', () => {
  it('锁占用 → skipped_locked;失锁 / 状态目录不安全 / 写出口拒绝 → 不可记录', () => {
    expect(outcomeOfError(new RsiLockError('locked'))).toBe('skipped_locked');
    expect(outcomeOfError(new RsiLockError('locked_over_ttl'))).toBe('skipped_locked');
    for (const k of ['lock_lost', 'state_dir_unsafe', 'write_denied'] as const) {
      const o = outcomeOfError(new RsiLockError(k));
      expect(o).toBe(k);
      expect(isRecordable(o)).toBe(false);
    }
  });
  it('fail-closed 原因码:在结果表里的原样,不在的记 internal;errno 白名单 → io_error;其余 internal', () => {
    expect(outcomeOfError(new RsiFailClosedError('salt_invalid'))).toBe('salt_invalid');
    expect(outcomeOfError(new RsiFailClosedError('staging_unsafe_entry'))).toBe('internal');
    expect(outcomeOfError(Object.assign(new Error('x'), { code: 'EMFILE' }))).toBe('io_error');
    expect(outcomeOfError(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('internal');
    expect(outcomeOfError('boom')).toBe('internal');
    for (const o of ['state_invalid', 'snapshot_invalid'] as const)
      expect(isRecordable(o)).toBe(false);
    for (const o of ['salt_invalid', 'purge_incomplete', 'io_error', 'internal'] as const) {
      expect(isRecordable(o)).toBe(true);
    }
  });
});

describe('R20-3.3.2 hint 唯一出口与模板', () => {
  it('200 字节放行、201 字节 → 空串;多字节 UTF-8 按字节算(字节上限去掉 → 红)', () => {
    const at200 = 'a'.repeat(199); // + 换行 = 200
    expect(finalizeHint(at200)).toBe(`${at200}\n`);
    expect(finalizeHint('a'.repeat(200))).toBe('');
    const cjk66 = '新'.repeat(66); // 198 字节 + 换行 = 199
    expect(Buffer.byteLength(finalizeHint(cjk66))).toBe(199);
    expect(finalizeHint(`${cjk66}a`)).toBe(`${cjk66}a\n`); // 200
    expect(finalizeHint(`${cjk66}ab`)).toBe(''); // 201
    expect(finalizeHint('')).toBe('');
  });
  it('计数取极值时两个模板都 ≤ 200 字节(confirmed 194 / armed 106);9999 封顶', () => {
    const big = 10 ** 9;
    const c = confirmedTemplate({ N: big, K: big, M: big, P: big, n: big, X: big, U: big });
    expect(Buffer.byteLength(finalizeHint(c))).toBe(194);
    expect(Buffer.byteLength(finalizeHint(armedTemplate(big)))).toBe(106);
    expect(showCount(9999)).toBe('9999');
    expect(showCount(10000)).toBe('9999+');
  });
});

describe('参数与形状', () => {
  it('poke / hint 的 --agent:只接受恰好一对合法值', () => {
    expect(parseAgentArg(['--agent', 'claude'])).toBe('claude');
    expect(parseAgentArg(['--agent', 'kimi'])).toBeUndefined();
    expect(parseAgentArg(['--agent=claude'])).toBeUndefined();
    expect(parseAgentArg(['--agent', 'pi', '--agent', 'pi'])).toBeUndefined();
    expect(parseAgentArg([])).toBeUndefined();
  });
  it('钩子形状识别(与根入口 cli.ts 同口径):全局选项与 help / version 不阻止识别', () => {
    expect(hookShapeOf(['rsi', 'poke', '--agent', 'claude'])).toMatchObject({
      kind: 'poke',
      hadGlobal: false,
    });
    expect(hookShapeOf(['--root', '/x', 'rsi', 'hint'])).toMatchObject({
      kind: 'hint',
      hadGlobal: true,
    });
    expect(hookShapeOf(['--help', '__rsi', '--background'])).toMatchObject({
      kind: 'worker',
      hadGlobal: true,
    });
    expect(hookShapeOf(['rsi', 'poke', '--help'])).toMatchObject({
      kind: 'poke',
      rest: ['--help'],
    });
    expect(hookShapeOf(['rsi', 'status'])).toBeUndefined();
    expect(hookShapeOf(['build'])).toBeUndefined();
  });
  it('R20-1.7 顺带调度白名单', () => {
    for (const a of [['build'], ['check'], ['sync'], ['reflect'], ['--root', '/r', 'build']]) {
      expect(kitScheduleEligible(a), a.join(' ')).toBe(true);
    }
    for (const a of [
      ['reflect', '--run-llm'],
      ['reflect', '--gc'],
      ['doctor'],
      ['update'],
      ['rsi', 'status'],
      ['__update', '--background'],
      ['build', '--help'],
      ['--version'],
      [],
    ]) {
      expect(kitScheduleEligible(a), a.join(' ')).toBe(false);
    }
  });
});

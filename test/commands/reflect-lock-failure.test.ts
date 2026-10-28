/**
 * R20-A2 B5d 评审订正:`rsiLockFailure` 把锁内抛出的快照占线映射成退 4(占线不是失败),与 stableOf / signals-collect 同口径。
 * 每条负向断言旁边有正向对照(其它错误仍退 3)。
 */
import { describe, expect, it } from 'vitest';
import { rsiLockFailure } from '../../src/commands/reflect.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { RsiSnapshotBusyError } from '../../src/rsi/exit.js';
import { RsiSnapshotError } from '../../src/rsi/snapshot-read.js';

describe('rsiLockFailure × 快照占线', () => {
  it.each(['REFLECT', 'JUDGE'] as const)(
    '%s:RsiSnapshotBusyError 退 4 NOT_RUN,不是退 3',
    (prefix) => {
      const r = rsiLockFailure(new RsiSnapshotBusyError(), prefix);
      expect(r).toEqual({
        line: `${prefix}_NOT_RUN reason=snapshot_busy\n`,
        exit: ExitCode.NOT_RUN,
      });
    },
  );

  it('正向对照:带病快照(RsiSnapshotError)仍退 3 RSI_FAIL_CLOSED', () => {
    const r = rsiLockFailure(new RsiSnapshotError('snapshot_invalid'), 'REFLECT');
    expect(r?.exit).toBe(ExitCode.FAIL_CLOSED);
    expect(r?.line).toBe('RSI_FAIL_CLOSED reason=snapshot_invalid\n');
  });

  it('正向对照:无关异常返回 undefined(交回调用方走 internal)', () => {
    expect(rsiLockFailure(new Error('x'), 'JUDGE')).toBeUndefined();
  });
});

/**
 * R20-A2 B3-0:服务层桩(B3c / B3a 实装)的冻结签名。
 *  - 每个桩 `throw new Error('not implemented')`(后续块替换时这些断言一并改成行为测试);
 *  - 类型层:`commitUnderLock` 必须带锁句柄。这些用例放在「不执行但会被 tsc 检查」的函数里,`pnpm typecheck` 才是判定者
 *    (vitest 只转译不查类型)。`@ts-expect-error` 只在该行恰有一个类型错误时才不报「未使用」,所以每条都配了合法三参调用做正例。
 */
import { describe, expect, it } from 'vitest';
import type { RsiConfigOn } from '../../src/rsi/config.js';
import type { RsiLockHandle } from '../../src/rsi/lock.js';
import { commitUnderLock, writeCountsProjection } from '../../src/rsi/services/commit.js';
import { immediateGate, judgeGateCallbacks } from '../../src/rsi/services/immediate-gate.js';
import {
  detectPurgeJournal,
  resumeTaint,
  taintNewlyExcluded,
} from '../../src/rsi/services/taint.js';
import type { RsiCommitPlan, RsiServiceCtx } from '../../src/rsi/types.js';
import { baseCtx } from '../helpers/tmp.js';

const ctx: RsiServiceCtx = {
  io: baseCtx(),
  config: { status: 'on' } as unknown as RsiConfigOn,
};
const lock = {} as RsiLockHandle;
const plan: RsiCommitPlan = { trigger: 'kit' };

describe('服务层桩', () => {
  it('全部 throw not implemented(B3c 替换;openRsiIo 已由 B3a 实装,见 open.test.ts)', async () => {
    const msg = 'not implemented';
    await expect(resumeTaint(ctx, lock)).rejects.toThrow(msg);
    await expect(detectPurgeJournal(ctx)).rejects.toThrow(msg);
    await expect(immediateGate(ctx, { kind: 'judge', runId: 'r' })).rejects.toThrow(msg);
    expect(() => judgeGateCallbacks(ctx, { kind: 'judge', runId: 'r' })).toThrow(msg);
    await expect(commitUnderLock(ctx, lock, plan)).rejects.toThrow(msg);
    await expect(writeCountsProjection(ctx, lock, {})).rejects.toThrow(msg);
    await expect(taintNewlyExcluded(ctx, lock, { source: 'exclude' })).rejects.toThrow(msg);
  });
});

/** 不执行;只给 tsc 检查。 */
export async function typeLevelOnly(maybe: RsiLockHandle | null): Promise<void> {
  // 正例:三参合法
  await commitUnderLock(ctx, lock, plan);
  await resumeTaint(ctx, lock);
  // @ts-expect-error 无锁句柄:缺第三个参数
  await commitUnderLock(ctx, plan);
  // @ts-expect-error 传 null 句柄(strictNullChecks)
  await commitUnderLock(ctx, null, plan);
  // @ts-expect-error 可能为 null 的句柄(withRsiLockIfGated 的 off 分支)必须先收窄
  await commitUnderLock(ctx, maybe, plan);
  // @ts-expect-error resumeTaint 同样要求句柄
  await resumeTaint(ctx);
  // @ts-expect-error resumeTaint 不接受 null 句柄
  await resumeTaint(ctx, null);
  await writeCountsProjection(ctx, lock, {});
  // @ts-expect-error counts 投影写入同样必须带句柄
  await writeCountsProjection(ctx, {});
  await taintNewlyExcluded(ctx, lock, { source: 'exclude' });
  // @ts-expect-error 新 taint 扫描同样必须带句柄
  await taintNewlyExcluded(ctx, null, { source: 'exclude' });
}

/**
 * 服务层共用:锁句柄必须真属于 `ctx.io` 的 rsi 状态目录(契约 R20-5.6 / B3-0 `commitUnderLock` 实装契约 ②:不得「持 A 的锁写 B 的状态」)。
 * 先 `assertHeld()`(锁文件的 nonce 仍是自己的),再核对 `lock.path === <rsiDir>/lock`。不符 → fail-closed `internal`。
 * 用只读的 `rsiDirReadonly`(不建目录、不 chmod):目录已由 `acquireRsiLock` 建好,这里零写入(「无副作用复检」之前不能先写)。
 */
import * as path from 'node:path';
import { rsiDirReadonly, type RsiLockHandle } from '../lock.js';
import { RsiFailClosedError, type RsiServiceCtx } from '../types.js';

export async function assertLockBelongs(ctx: RsiServiceCtx, lock: RsiLockHandle): Promise<string> {
  await lock.assertHeld();
  const d = await rsiDirReadonly(ctx.io);
  if (d.kind === 'unsafe') throw new RsiFailClosedError('state_dir_unsafe');
  if (d.kind === 'missing' || lock.path !== path.join(d.dir, 'lock')) {
    throw new RsiFailClosedError('internal');
  }
  return d.dir;
}

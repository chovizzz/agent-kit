/**
 * `.state/rsi/` 下 worker 持锁写的整文件(`canary.json`、`canary-admission.json`)的原子写:临时文件 `createExclusive`(0600)→ `rename`(提交点)。
 * 与 `services/fixed-write.ts` 同一写法,但锁由调用方以窄接口 `{ assertHeld }` 传入(每个写点之前复核:丢锁 → 抛错、不写)。
 * 读者(hint)要么看到旧文件、要么看到新文件,不会看到半截。
 */
import * as path from 'node:path';
import { RSI_FILE_MODE } from '../../contracts/rsi.js';
import type { IoContext } from '../../io/paths.js';
import { createExclusive, remove, rename } from '../../io/safe-fs.js';

export interface HeldLock {
  assertHeld(): Promise<void>;
}

export async function writeRsiFileAtomic(
  io: IoContext,
  rsiDir: string,
  name: string,
  text: string,
  held: readonly HeldLock[],
): Promise<void> {
  const dest = path.join(rsiDir, name);
  const tmp = `${dest}.tmp`;
  const assertAll = async (): Promise<void> => {
    for (const h of held) await h.assertHeld();
  };
  await assertAll();
  await remove(io, tmp); // 上次崩溃留下的临时文件
  await assertAll();
  await createExclusive(io, tmp, text, RSI_FILE_MODE);
  await assertAll();
  await rename(io, tmp, dest); // 提交点
}

/** 删除整文件(同样先复核锁) */
export async function removeRsiFile(
  io: IoContext,
  rsiDir: string,
  name: string,
  held: readonly HeldLock[],
): Promise<void> {
  for (const h of held) await h.assertHeld();
  await remove(io, path.join(rsiDir, name));
}

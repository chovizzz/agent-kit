/**
 * `canary.json` 的**只减影响**写:`muteCanary`(置为不注入)与 `removeCanary`(删文件)。只需 `rsi/lock`。
 * 从 `canary-writer.ts` 原样拆出(行为不变;那里再导出),原因:worker 的安全骨架(装配块 C1b)的 import 闭包必须不含授予入口 `grantCanary` 所在模块。
 */
import { CanaryDocSchema } from '../../contracts/rsi-personal.js';
import { canonicalJson } from '../../io/canonical-json.js';
import type { IoContext } from '../../io/paths.js';
import { removeRsiFile, writeRsiFileAtomic, type HeldLock } from './atomic-write.js';
import { CANARY_FILES } from './files.js';
import { readCanaryDoc } from './permit-read.js';

export interface CanaryMuteDeps {
  io: IoContext;
  rsiDir: string;
  locks: { rsi: HeldLock };
}

/** `AUTO_PAUSE` / 熔断:置为不注入(`generation + 1`)。无现有有效文件 = 无事可做。返回是否写了 */
export async function muteCanary(d: CanaryMuteDeps): Promise<boolean> {
  await d.locks.rsi.assertHeld();
  const cur = await readCanaryDoc(d.rsiDir);
  if (cur.kind !== 'ok') return false;
  if (cur.value.agents_inject.length === 0) return false;
  const next = CanaryDocSchema.parse({
    ...cur.value,
    agents_inject: [],
    p_by_agent: {},
    generation: cur.value.generation + 1,
  });
  await writeRsiFileAtomic(d.io, d.rsiDir, CANARY_FILES.canary, canonicalJson(next), [d.locks.rsi]);
  return true;
}

/** 撤销路径清理:删除缓存文件(只收紧) */
export async function removeCanary(d: CanaryMuteDeps): Promise<void> {
  await removeRsiFile(d.io, d.rsiDir, CANARY_FILES.canary, [d.locks.rsi]);
}

/**
 * 写命令处理函数表(`AutoEntryDeps.write` 的值):规范名 → 处理函数。端口经 `ports(ctx)` 注入(生产 = `deps-write.ts`,未接线的一律缺失 → 预检退 3)。
 * 本目录与 `read/` 分开:只读命令的 import 闭包不得带进任何写出口(`zero-write.test.ts`)。
 */
import type { AutoCanonical } from '../route.js';
import { runClearWrite } from './clear-write.js';
import { runPause } from './pause.js';
import type { WriteHandler, WritePorts, WritePortsGetter } from './ports.js';
import { runRebase } from './rebase.js';
import { runResume } from './resume.js';
import { runRollbackWrite } from './rollback-write.js';
import { runVeto } from './veto.js';
import type { RsiEarlyContext } from '../../types.js';

export type WritePortsFactory = (ctx: RsiEarlyContext) => Promise<WritePorts>;

export function makeWriteHandlers(
  ports: WritePortsFactory,
): Partial<Record<AutoCanonical, WriteHandler>> {
  const wrap =
    (
      run: (ctx: RsiEarlyContext, rest: readonly string[], g: WritePortsGetter) => Promise<number>,
    ): WriteHandler =>
    async (ctx, rest) =>
      run(ctx, rest, () => ports(ctx));
  return {
    'auto pause': wrap(runPause),
    'auto resume': wrap(runResume),
    'auto clear': wrap(runClearWrite),
    'auto rebase-baseline': wrap(runRebase),
    veto: wrap(runVeto),
    'rollback --to': wrap(runRollbackWrite),
  };
}

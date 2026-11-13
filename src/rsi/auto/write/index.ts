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

/**
 * `clearPorts`:`auto clear --write`(缩减入口,R21-9.5)专用的端口工厂——配置不可信时仍要能完成 HOME 侧撤销,所以它与其它写命令的工厂**分开**
 * (其它写命令的工厂在配置不可信时 fail-closed;分开 = 结构上保证「放宽只对缩减入口」,不是靠一个开关)。缺省 = 与 `ports` 相同。
 */
export function makeWriteHandlers(
  ports: WritePortsFactory,
  clearPorts: WritePortsFactory = ports,
): Partial<Record<AutoCanonical, WriteHandler>> {
  const wrapWith =
    (factory: WritePortsFactory) =>
    (
      run: (ctx: RsiEarlyContext, rest: readonly string[], g: WritePortsGetter) => Promise<number>,
    ): WriteHandler =>
    async (ctx, rest) =>
      run(ctx, rest, () => factory(ctx));
  const wrap = wrapWith(ports);
  return {
    'auto pause': wrap(runPause),
    'auto resume': wrap(runResume),
    'auto clear': wrapWith(clearPorts)(runClearWrite),
    'auto rebase-baseline': wrap(runRebase),
    veto: wrap(runVeto),
    'rollback --to': wrap(runRollbackWrite),
  };
}

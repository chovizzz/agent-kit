/**
 * §21 W8 命令面的装配入口(`src/commands/rsi.ts` 的分发表从这里取):读命令与相位闸在 `entry.ts`(静态闭包不含任何写出口,`zero-write.test.ts`),
 * 写命令的生产处理函数表(`write/`)与生产端口(`deps-write.ts`)**只在本文件**接进去——与 `status` / `status-ack.ts` 同一手法:写路径与只读路径分文件。
 * 分发器是静态 import 本文件的;`entry.ts` 不得 import 本文件或 `write/`、`deps-write.ts`(静态 + 无动态 import)。
 */
import type { RsiSubcommand } from '../types.js';
import { productionClearWritePorts, productionWritePorts } from './deps-write.js';
import { runAutoFamily, type AutoEntryDeps } from './entry.js';
import type { AutoFamily } from './route.js';
import { makeWriteHandlers } from './write/index.js';

/** 生产的写处理函数表:端口由 `deps-write.ts` 装配(未接线的缺失 → 预检退 3);只在相位够了且命中写路由时才会被调用 */
const productionWrite = makeWriteHandlers(
  (ctx) => productionWritePorts(ctx),
  (ctx) => productionClearWritePorts(ctx),
);

const make = (name: AutoFamily): RsiSubcommand => ({
  name,
  owner: 'W8',
  run: (ctx) => runAutoFamily(name, ctx, { write: productionWrite } satisfies AutoEntryDeps),
});

export const autoSubcommand = make('auto');
export const vetoSubcommand = make('veto');
export const rollbackSubcommand = make('rollback');
export const reportSubcommand = make('report');
export const showSubcommand = make('show');

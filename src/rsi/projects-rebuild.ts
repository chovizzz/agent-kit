/**
 * `agent-kit rsi projects --rebuild-index --write` 入口(命令桩;R20-A2 B5-0 冻结入口文件名与导出形状)。实装块:B5a(契约 R20-3.5.5,方案 §4.3)。
 *
 * 为什么是独立文件:`projects.ts` 属于只读闭包(`READONLY_ENTRIES`);重建索引要拿锁并写索引 / counts / 快照清单,
 * 所以由分发器在 argv **同时**含精确 token `--rebuild-index` 与 `--write` 时路由到这里。
 * 只带 `--rebuild-index`(干跑)仍留在 `projects.ts`(只读,B5a 在那里实装干跑)。
 * 实装时保持 `export const subcommand: RsiSubcommand`(`name` 仍是 `projects`,表外对象);参数合法性由本入口的 `parseFlags` 判。
 * 桩:退出 64,stderr 只有 `RSI_NOT_IMPLEMENTED subcommand=projects.rebuild_index`,stdout 空,不读配置、不写任何东西。
 */
import { rsiStubExit } from './stub.js';
import type { RsiSubcommand } from './types.js';

export const subcommand: RsiSubcommand = {
  name: 'projects',
  owner: 'B5',
  run: (ctx) => Promise.resolve(rsiStubExit(ctx, 'projects.rebuild_index')),
};

/**
 * `agent-kit rsi status --ack` 入口(命令桩;R20-A2 B5-0 冻结入口文件名与导出形状)。实装块:B5a(契约 R20-3.4.3,方案 §4.1)。
 *
 * 为什么是独立文件:`status.ts` 属于只读闭包(`test/rsi/readonly-zero-write.test.ts` 的 `READONLY_ENTRIES`),闭包里禁止出现 safe-fs / 锁 / 提交服务;
 * `--ack` 要拿锁并写 `state.json`,所以由分发器({@link ../commands/rsi.ts} 的 `routeRsi`)在 argv 含精确 token `--ack` 时路由到这里。
 * 实装时保持 `export const subcommand: RsiSubcommand`(`name` 仍是 `status`,它是表外对象,不进 `RSI_SUBCOMMAND_TABLE`);参数合法性由本入口的 `parseFlags` 判。
 * 桩:退出 64,stderr 只有 `RSI_NOT_IMPLEMENTED subcommand=status.ack`,stdout 空,不读配置、不写任何东西。
 */
import { rsiStubExit } from './stub.js';
import type { RsiSubcommand } from './types.js';

export const subcommand: RsiSubcommand = {
  name: 'status',
  owner: 'B5',
  run: (ctx) => Promise.resolve(rsiStubExit(ctx, 'status.ack')),
};

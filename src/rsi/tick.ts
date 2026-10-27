/**
 * `agent-kit rsi tick` 入口(命令桩;B3-0 冻结入口文件名与导出形状)。实装块:B5。
 * 实装时保持 `export const subcommand: RsiSubcommand`,经 `openRsiIo` 取上下文(顺序见 `types.ts` 头注释),不 import llm-exec / reflect 后端 / net / 更新启动器(R20-1.1)。
 */
import { rsiStubExit } from './stub.js';
import type { RsiSubcommand } from './types.js';

export const subcommand: RsiSubcommand = {
  name: 'tick',
  owner: 'B5',
  run: (ctx) => Promise.resolve(rsiStubExit(ctx, 'tick')),
};

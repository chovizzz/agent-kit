import { stubExit } from './types.js';
import type { CommandDef } from './types.js';

export const command: CommandDef = {
  name: 'inventory',
  summary: '存量盘点(P0 是 haiku 一次性交付物 inventory/*.md,不是 CLI 输出)',
  phase: 'P1',
  ownerBlock: 'B15(只产出 inventory/ 下的文件,不实装本命令)',
  async run(ctx) {
    return stubExit(ctx, command.name, '盘点是 P0 交付物(inventory/*.md),P1 才进 CLI');
  },
};

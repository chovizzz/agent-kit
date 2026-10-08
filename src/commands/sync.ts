import { stubExit, stubReason } from './types.js';
import type { CommandDef } from './types.js';

export const command: CommandDef = {
  name: 'sync',
  summary: '把渲染产物同步到本机(需用户批准写全局)',
  phase: 'P2',
  ownerBlock: 'P2',
  async run(ctx) {
    return stubExit(ctx, command.name, stubReason(command));
  },
};

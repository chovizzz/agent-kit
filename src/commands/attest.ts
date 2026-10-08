import { stubExit, stubReason } from './types.js';
import type { CommandDef } from './types.js';

export const command: CommandDef = {
  name: 'attest',
  summary: '生成本机证据摘要',
  phase: 'P1',
  ownerBlock: 'P1',
  async run(ctx) {
    return stubExit(ctx, command.name, stubReason(command));
  },
};

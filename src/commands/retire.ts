import { stubExit, stubReason } from './types.js';
import type { CommandDef } from './types.js';

export const command: CommandDef = {
  name: 'retire',
  summary: '生成退役 PR',
  phase: 'P1',
  ownerBlock: 'P1',
  async run(ctx) {
    return stubExit(ctx, command.name, stubReason(command));
  },
};

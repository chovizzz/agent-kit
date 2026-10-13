import { stubExit, stubReason } from './types.js';
import type { CommandDef } from './types.js';

export const command: CommandDef = {
  name: 'judge',
  summary: '裁判:对 reflect 暂存的提案做跨厂商评审',
  phase: 'P1',
  ownerBlock: 'P1',
  async run(ctx) {
    return stubExit(ctx, command.name, stubReason(command));
  },
};

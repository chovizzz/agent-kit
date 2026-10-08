import { stubExit, stubReason } from './types.js';
import type { CommandDef } from './types.js';

export const command: CommandDef = {
  name: 'reflect',
  summary: '反思器:从信号生成提案',
  phase: 'P1',
  ownerBlock: 'P1',
  async run(ctx) {
    return stubExit(ctx, command.name, stubReason(command));
  },
};

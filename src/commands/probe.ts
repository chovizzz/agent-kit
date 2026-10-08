import { stubExit, stubReason } from './types.js';
import type { CommandDef } from './types.js';

export const command: CommandDef = {
  name: 'probe',
  summary: '渲染产物对各 agent 的有效性探针',
  phase: 'P1',
  ownerBlock: 'P1',
  async run(ctx) {
    return stubExit(ctx, command.name, stubReason(command));
  },
};

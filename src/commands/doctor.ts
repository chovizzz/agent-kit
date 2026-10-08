import { stubExit, stubReason } from './types.js';
import type { CommandDef } from './types.js';

export const command: CommandDef = {
  name: 'doctor',
  summary: '本机状态与遮蔽文件诊断',
  phase: 'P2',
  ownerBlock: 'P2',
  async run(ctx) {
    return stubExit(ctx, command.name, stubReason(command));
  },
};

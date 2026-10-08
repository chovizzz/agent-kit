import { stubExit, stubReason } from './types.js';
import type { CommandDef } from './types.js';

export const command: CommandDef = {
  name: 'signals collect',
  summary: '只读解析会话文件,输出归一化信号(--source <路径> --dry)',
  phase: 'P0',
  ownerBlock: 'B10b',
  flags: [
    { name: '--source <路径>', description: '会话目录或文件(只读打开);必填' },
    { name: '--dry', description: '只输出计数与报告,不写 .state/' },
  ],
  async run(ctx) {
    return stubExit(ctx, command.name, stubReason(command));
  },
};

import { stubExit, stubReason } from './types.js';
import type { CommandDef } from './types.js';

export const command: CommandDef = {
  name: 'redact',
  summary: '脱敏:--selftest 跑种子集,--stdin 处理输入',
  phase: 'P0',
  ownerBlock: 'B09',
  flags: [
    { name: '--selftest', description: '跑种子集自检(第一遍替换 + 第二遍复扫)' },
    { name: '--stdin', description: '从标准输入读文本,输出脱敏结果;失败退出 3' },
  ],
  async run(ctx) {
    return stubExit(ctx, command.name, stubReason(command));
  },
};

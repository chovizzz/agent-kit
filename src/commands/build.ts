import { stubExit, stubReason } from './types.js';
import type { CommandDef } from './types.js';

export const command: CommandDef = {
  name: 'build',
  summary: '合并 + 渲染到 out/(只写仓库内 out/)',
  phase: 'P0',
  ownerBlock: 'B19(集成;依赖 B05/B06/B07/B08)',
  async run(ctx) {
    return stubExit(ctx, command.name, stubReason(command));
  },
};

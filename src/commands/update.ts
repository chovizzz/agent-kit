import { stubExit } from './types.js';
import type { CommandDef } from './types.js';

/**
 * S0 命令桩(docs/contracts.md §19.4)。S6 实装检查与版本策略,S7 实装安装器 / 启动器 / 回滚;
 * 届时保持 `export const command: CommandDef` 的形状,不改 cli.ts。
 */
export const command: CommandDef = {
  name: 'update',
  summary: '检查并安装新版本(默认干跑;自动更新只换 CLI 本体)',
  phase: 'P2',
  ownerBlock: 'S6/S7',
  flags: [
    { name: '--write', description: '真正安装 / 回滚(缺省只打印会做什么)' },
    { name: '--now', description: '本次忽略冷却期(其余校验照旧)' },
    { name: '--major', description: '允许跨 major 升级(需要 --write)' },
    { name: '--rollback', description: '把 current 切回上一个保留版本(需要 --write)' },
    { name: '--json', description: '以 canonical JSON 输出' },
  ],
  async run(ctx) {
    return stubExit(ctx, command.name, 'P2 才实现(契约见 docs/contracts.md §19.4;块 S6/S7 实装)');
  },
};

import { parseArgs } from 'node:util';
import { ExitCode } from '../contracts/exit-codes.js';
import { run as runBudget } from './check-budget.js';
import { run as runGuards } from './guards-cmd.js';
import { run as runLint } from './lint-cmd.js';
import { combineExitCodes } from './types.js';
import type { CheckOptions, CommandDef } from './types.js';

function parseCheckArgs(argv: readonly string[]): CheckOptions {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      guards: { type: 'boolean', default: false },
      base: { type: 'string' },
      head: { type: 'string' },
      label: { type: 'string' },
      report: { type: 'boolean', default: false },
    },
  });
  return {
    guards: values.guards === true,
    base: values.base,
    head: values.head,
    label: values.label,
    report: values.report === true,
  };
}

export const command: CommandDef = {
  name: 'check',
  summary: '检查:原子/技能/子代理 lint + 预算;--guards 追加状态守卫 G1–G4(--base/--head/--label)',
  phase: 'P0',
  ownerBlock: 'B03 + B04 + B05(各自替换对应子 runner)',
  flags: [
    { name: '--guards', description: '追加状态守卫 G1–G4(必须同时给 --base 与 --head)' },
    { name: '--base <ref>', description: '守卫比较的基线 git 引用' },
    { name: '--head <ref>', description: '守卫比较的头部 git 引用' },
    {
      name: '--label <name>',
      description: '模拟 PR 标签(kit:promotion|kit:retire|kit:attest),只做与转移方向的一致性比对',
    },
    { name: '--report', description: '打印机器可读的预算统计表' },
  ],
  async run(ctx) {
    let opts: CheckOptions;
    try {
      opts = parseCheckArgs(ctx.argv);
    } catch (e) {
      ctx.stderr(`agent-kit check: ${(e as Error).message}\n`);
      return ExitCode.USAGE;
    }
    if (opts.guards && (opts.base === undefined || opts.head === undefined)) {
      ctx.stderr('agent-kit check: --guards 需要同时给 --base 和 --head\n');
      return ExitCode.USAGE;
    }
    const codes = [await runLint(ctx, opts), await runBudget(ctx, opts)];
    if (opts.guards) codes.push(await runGuards(ctx, opts));
    return combineExitCodes(codes);
  },
};

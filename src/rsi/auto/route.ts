/**
 * `rsi auto <二级命令>` 与 `--write` 分流(纯函数:只看 token 在不在,不读配置、不碰文件系统;合法性由各处理函数的参数解析判)。
 * 规范名 = `RSI_AUTO_SUBCOMMAND_CAPS` 的键字面(桩的 `subcommand=` 与能力闸都用它)。
 *   - `auto status | pause | resume | clear | rebase-baseline`:二级命令缺失 / 未知 → `undefined`(调用方退 2 `unknown_subcommand`,不回显输入);
 *   - 写命令(`pause` / `resume` / `rebase-baseline` / `veto` 恒写;`clear` / `rollback` 仅在 argv 含精确 token `--write` 时写):`write: true`,W8a 接到「未实现」桩,W8b 替换处理函数;
 *   - `rollback` 的规范名恒为 `rollback --to`(能力 `cmd_rollback_to`,V1b)。
 */
import type { RSI_AUTO_SUBCOMMAND_CAPS } from '../../contracts/rsi.js';

export type AutoCanonical = keyof typeof RSI_AUTO_SUBCOMMAND_CAPS;
export type AutoFamily = 'auto' | 'veto' | 'rollback' | 'report' | 'show';

export interface AutoRoute {
  canonical: AutoCanonical;
  write: boolean;
  /** 二级命令名之后的参数 */
  rest: readonly string[];
}

const AUTO_SUBS: Readonly<Record<string, AutoCanonical>> = Object.freeze({
  status: 'auto status',
  pause: 'auto pause',
  resume: 'auto resume',
  clear: 'auto clear',
  'rebase-baseline': 'auto rebase-baseline',
});

export function routeAuto(family: AutoFamily, argv: readonly string[]): AutoRoute | undefined {
  switch (family) {
    case 'auto': {
      const sub = argv[0];
      if (sub === undefined || !Object.hasOwn(AUTO_SUBS, sub)) return undefined;
      const rest = argv.slice(1);
      const canonical = AUTO_SUBS[sub] as AutoCanonical;
      const write = sub === 'clear' ? rest.includes('--write') : sub !== 'status';
      return { canonical, write, rest };
    }
    case 'veto':
      return { canonical: 'veto', write: true, rest: argv };
    case 'rollback':
      return { canonical: 'rollback --to', write: argv.includes('--write'), rest: argv };
    case 'report':
      return { canonical: 'report', write: false, rest: argv };
    case 'show':
      return { canonical: 'show', write: false, rest: argv };
  }
}

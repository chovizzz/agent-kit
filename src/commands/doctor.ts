/**
 * `agent-kit doctor [--json] [--only <id>]… [--online] [--home <dir>]`(S5,docs/contracts.md §19.3)。
 *
 * - **零写入、零网络**:只经只读 API 读 HOME / 包内 payload / 仓库配置;不建 `~/.local/state`,不 import `src/io/net.ts`、home-fs、safe-fs。
 *   `--online` 本块不实现联网:D12 标 `n_a`(`online_unavailable`),stderr 一行 `DOCTOR_ONLINE_UNAVAILABLE`,退出 4(S7c 后再接)。
 * - **HOME**:缺省 `getRealHome()`;`--home` 只接受真实 HOME 或 KIT_TMP 严格之内的目录,否则退出 2 `home_not_allowed`。
 * - **输出面**:stdout 只含 id / 枚举 / 计数 / 版本号 / sha 前缀 / 写死的受管相对路径(`~/<表内路径>`);不输出文件内容、摘录、绝对路径、用户名。
 *   `--json` 为 canonical JSON、键集合固定。stderr 只含稳定码。终端再过一道泄漏闸:输出里出现 HOME / KIT_TMP / 状态目录的绝对路径 →
 *   整份输出作废,退出 3 `DOCTOR_FAIL_CLOSED reason=output_leak`。
 * - 退出码:0 只有 ok / warn / n_a;1 有任一 fail(drifted / corrupt / over 等);2 用法错误;3 doctor 自身 fail-closed
 *   (`state_dir_unsafe`、`state_unreadable`、`output_leak`);4 用了 `--online`。多项用 `combineExitCodes`。
 */
import { DOCTOR_CHECK_IDS } from '../contracts/doctor.js';
import type { DoctorCheckId } from '../contracts/doctor.js';
import { ExitCode } from '../contracts/exit-codes.js';
import {
  checkD01,
  checkD02,
  checkD03,
  checkD04,
  checkD05,
  checkD06,
  checkD07,
  checkD08,
  checkD09,
  checkD10,
  checkD11,
  checkD12,
  checkD13,
  checkD14,
  checkD15,
  checkD16,
} from '../doctor/checks.js';
import { Collector } from '../doctor/collect.js';
import type { CollectDeps } from '../doctor/collect.js';
import { result } from '../doctor/types.js';
import type { CheckResult } from '../doctor/types.js';
import { canonicalJson } from '../io/canonical-json.js';
import { getRealHome } from '../io/paths.js';
import { resolveAllowedHome } from '../sync/snapshot.js';
import { combineExitCodes } from './types.js';
import type { CommandContext, CommandDef } from './types.js';

export interface DoctorCommandDeps extends CollectDeps {
  /** 测试钩子:在输出前改写结果(用来演练泄漏闸);生产代码不设 */
  mutateResults?: (results: CheckResult[]) => void;
}

export const DOCTOR_USAGE_REASONS_ALL = [
  'unknown_arg',
  'bad_check_id',
  'home_not_allowed',
] as const;

interface Parsed {
  json: boolean;
  online: boolean;
  only: DoctorCheckId[];
  home: string | undefined;
  error: string | undefined;
}

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = { json: false, online: false, only: [], home: undefined, error: undefined };
  const fail = (m: string): void => {
    out.error ??= m;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (name: string): string | undefined => {
      if (a === name) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) {
          fail('unknown_arg');
          return undefined;
        }
        i++;
        return v;
      }
      return a.slice(name.length + 1);
    };
    if (a === '--json') out.json = true;
    else if (a === '--online') out.online = true;
    else if (a === '--only' || a.startsWith('--only=')) {
      const v = value('--only');
      if (v === undefined) continue;
      if (!(DOCTOR_CHECK_IDS as readonly string[]).includes(v)) fail('bad_check_id');
      else if (!out.only.includes(v as DoctorCheckId)) out.only.push(v as DoctorCheckId);
    } else if (a === '--home' || a.startsWith('--home=')) {
      const v = value('--home');
      if (v !== undefined) out.home = v;
    } else fail('unknown_arg');
  }
  return out;
}

const skipped = (id: DoctorCheckId, why: string): CheckResult => result(id, 'n_a', why);

/** 触发 fail-closed(退出 3)的 result → 原因码 */
const FAIL_CLOSED_BY_RESULT: Readonly<Record<string, 'state_dir_unsafe' | 'state_unreadable'>> = {
  link_or_not_dir: 'state_dir_unsafe',
  skipped_state_unsafe: 'state_dir_unsafe',
  state_unreadable: 'state_unreadable',
  ledger_unreadable: 'state_unreadable',
};

const STATE_DEPENDENT: readonly DoctorCheckId[] = ['D04', 'D05', 'D06', 'D07', 'D08', 'D12', 'D16'];

function renderText(results: readonly CheckResult[], summary: Record<string, number>): string {
  const lines: string[] = [];
  for (const r of results) {
    const kv = [
      ...Object.keys(r.counts)
        .sort()
        .map((k) => `${k}=${String(r.counts[k])}`),
      ...Object.keys(r.facts)
        .sort()
        .map((k) => `${k}=${String(r.facts[k])}`),
    ];
    lines.push([r.id, r.status, r.result, ...kv].join(' '));
    for (const it of r.items) lines.push(`  - ${it}`);
  }
  lines.push(
    `doctor ok=${summary['ok']} warn=${summary['warn']} fail=${summary['fail']} n_a=${summary['n_a']}`,
  );
  return `${lines.join('\n')}\n`;
}

export function createDoctorCommand(deps: DoctorCommandDeps = {}): CommandDef {
  const def: CommandDef = {
    name: 'doctor',
    summary: '本机状态与遮蔽文件诊断(默认零写入、零网络)',
    phase: 'P2',
    ownerBlock: 'S5',
    flags: [
      { name: '--json', description: 'stdout 输出 canonical JSON(键集合固定)' },
      { name: '--only <id>', description: '只跑指定检查(D01–D16),可重复' },
      {
        name: '--online',
        description: '多读一次 registry(本版未实现联网:D12 标 n_a,退出 4)',
      },
      { name: '--home <dir>', description: '只接受真实 HOME 或 KIT_TMP 之内的目录' },
    ],
    async run(ctx: CommandContext): Promise<number> {
      const args = parseArgs(ctx.argv);
      const env = ctx.env ?? {};
      if (args.error !== undefined) {
        ctx.stderr(`DOCTOR_USAGE reason=${args.error}\n`);
        return ExitCode.USAGE;
      }
      const homeArg = args.home ?? getRealHome(env);
      let home: string | undefined;
      try {
        home = await resolveAllowedHome(homeArg, ctx.io.tmpDir, env);
      } catch {
        home = undefined;
      }
      if (home === undefined) {
        ctx.stderr('DOCTOR_USAGE reason=home_not_allowed\n');
        return ExitCode.USAGE;
      }
      const col = new Collector({
        home,
        env,
        tmpDir: ctx.io.tmpDir,
        repoRoot: ctx.io.repoRoot,
        stateDir: ctx.io.stateDir,
        overlayPath: ctx.overlayPath,
        deps,
      });
      const selected: readonly DoctorCheckId[] =
        args.only.length > 0
          ? DOCTOR_CHECK_IDS.filter((id) => args.only.includes(id))
          : DOCTOR_CHECK_IDS;

      const unsafe = await col.stateUnsafe();
      const run = async (id: DoctorCheckId): Promise<CheckResult> => {
        if (unsafe && STATE_DEPENDENT.includes(id)) return skipped(id, 'skipped_state_unsafe');
        switch (id) {
          case 'D01':
            return checkD01(await col.d01());
          case 'D02':
            return checkD02(await col.d02());
          case 'D03':
            return checkD03(await col.d03());
          case 'D04': {
            if ((await col.ledgerRead()).state === 'unsafe') {
              return result('D04', 'fail', 'ledger_unreadable');
            }
            return checkD04(await col.d04());
          }
          case 'D05':
            return checkD05(await col.d05());
          case 'D06':
            return checkD06(await col.d06());
          case 'D07':
            return checkD07({ plan: await col.plan() });
          case 'D08':
            return checkD08({ plan: await col.plan() });
          case 'D09':
            return checkD09(await col.d09());
          case 'D10':
            return checkD10(await col.d10());
          case 'D11':
            return checkD11(await col.d11());
          case 'D12': {
            if ((await col.updateState()).s === 'unreadable') {
              return result('D12', 'fail', 'state_unreadable');
            }
            return checkD12(await col.d12(args.online));
          }
          case 'D13':
            return checkD13();
          case 'D14':
            return checkD14(await col.stateDir());
          case 'D15':
            return checkD15(await col.d15());
          case 'D16': {
            const s = await col.updateState();
            if (s.s === 'unreadable') return result('D16', 'fail', 'state_unreadable');
            return checkD16(s.s === 'ok' ? s.state.last_auto_sync : undefined);
          }
        }
      };

      const results: CheckResult[] = [];
      for (const id of selected) {
        try {
          results.push(await run(id));
        } catch {
          results.push(result(id, 'fail', 'check_error'));
        }
      }
      // --online:本块不实现联网;只影响 D12
      if (args.online) {
        const i = results.findIndex((r) => r.id === 'D12');
        if (i >= 0 && FAIL_CLOSED_BY_RESULT[results[i]?.result ?? ''] === undefined) {
          results[i] = result('D12', 'n_a', 'online_unavailable');
        }
      }

      deps.mutateResults?.(results);
      const summary: Record<string, number> = { ok: 0, warn: 0, fail: 0, n_a: 0 };
      for (const r of results) summary[r.status] = (summary[r.status] ?? 0) + 1;
      const text = args.json
        ? canonicalJson({
            schema_version: 1,
            summary,
            checks: results.map((r) => ({
              id: r.id,
              status: r.status,
              result: r.result,
              counts: r.counts,
              facts: r.facts,
              items: r.items,
            })),
          })
        : renderText(results, summary);

      // 泄漏闸:任何绝对路径(HOME / KIT_TMP / 状态目录 / 仓库根)出现在输出里 → 整份作废
      const forbidden = [home, homeArg, ctx.io.tmpDir, ctx.io.stateDir, ctx.io.repoRoot].filter(
        (x): x is string => x !== undefined && x.length >= 4,
      );
      if (forbidden.some((f) => text.includes(f))) {
        ctx.stderr('DOCTOR_FAIL_CLOSED reason=output_leak\n');
        return ExitCode.FAIL_CLOSED;
      }
      ctx.stdout(text);

      const codes: number[] = [];
      for (const r of results) {
        if (r.status === 'fail') {
          const fc = FAIL_CLOSED_BY_RESULT[r.result];
          if (fc === undefined) {
            ctx.stderr(`DOCTOR_CHECK_FAILED check=${r.id} result=${r.result}\n`);
            codes.push(ExitCode.CHECK_FAILED);
          }
        }
      }
      const fcReasons = new Set<string>();
      for (const r of results) {
        const fc = FAIL_CLOSED_BY_RESULT[r.result];
        if (fc !== undefined) fcReasons.add(fc);
      }
      for (const fc of [...fcReasons].sort()) {
        ctx.stderr(`DOCTOR_FAIL_CLOSED reason=${fc}\n`);
        codes.push(ExitCode.FAIL_CLOSED);
      }
      if (args.online && selected.includes('D12')) {
        ctx.stderr('DOCTOR_ONLINE_UNAVAILABLE\n');
        codes.push(ExitCode.NOT_RUN);
      }
      return combineExitCodes(codes);
    },
  };
  return def;
}

export const command: CommandDef = createDoctorCommand();

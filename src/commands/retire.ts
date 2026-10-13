/**
 * `agent-kit retire --rule <id> --to deprecated|retired --reason manual|expired|superseded|no_exposure|harmful|rejected
 *  [--by <id>] [--today YYYY-MM-DD] [--write] [--json]`(L6,退役 T3–T6,docs/contracts.md §18)。
 *
 * 在内存里构造 head 视图并调用真 `checkG3('kit:retire')`(L2 判据:六个理由码的机械证据、deprecated→retired 的冷却、记录一致性),
 * 全绿才生成补丁(原子只改 `status:` 一行 + 新增 `lifecycle/<rule-id>/<recorded_at>-<run_id>.json`)与 `out/` 进出清单;红则不写。
 * 实现见 `lifecycle/retire.ts`。
 *
 * - **纯本地、零网络**:不 import llm-exec / backends;`--run-llm` / `--allow-egress` 出现即退出 2。
 * - **默认干跑**:只算、只打印;`--write` 才写,且只写 `.state/retire/<retire_id>/{retire.patch, pr-body.md, report.json}`
 *   (目录 0700、文件 0600,先 `.tmp-<retire_id>` 再整体 rename),一律经 safe-fs;不写 `rules/` / `lifecycle/`。
 * - 幂等:retire_id 由输入内容决定;目录已存在且三个文件都一致 → 退出 0 不重写;不一致 → 退出 3 `RETIRE_RUN_EXISTS`。
 * - 退出码:0 完成 / 已是目标状态(`already=1`)/ 已存在且一致;1 判据不过(含工作树与 HEAD 不同 `PROMOTE_WORKTREE_DIRTY`、
 *   方向或理由配对不允许、理由证据不满足、模拟 G3 红、预算阻断);2 用法(含 personal `PERSONAL_LAYER_P2` / org
 *   `ORG_LAYER_NOT_PROMOTABLE` / project 层、`superseded` 缺 `--by`);3 fail-closed(git 不可用、配置/out 清单算不出、写出口拒绝、
 *   `RETIRE_RUN_EXISTS`);4 `no_exposure` 但没有任何计入口径的 attest(`NO_ATTEST_IN_WINDOW`)。
 * - stdout 只含计数、枚举、id、哈希(`--json` 为 canonical JSON);stderr 只含稳定码 `RETIRE_* reason=<码>`。
 */
import { IsoDateSchema, KebabIdSchema } from '../contracts/common.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { canonicalJson } from '../io/canonical-json.js';
import { WriteDeniedError } from '../io/safe-fs.js';
import type { IoContext } from '../io/paths.js';
import { createGuardGit, GitError } from '../guards/git.js';
import type { GuardGit } from '../guards/types.js';
import { isRetireReason, planRetirement, RetireError } from '../lifecycle/retire.js';
import type { RetireTarget } from '../lifecycle/retire.js';
import type { RetireReason } from '../contracts/lifecycle.js';
import { StateOutError, writeStateOut } from './state-out.js';
import type { CommandContext, CommandDef } from './types.js';

export interface RetireCommandDeps {
  /** 测试注入;`--today` 缺省取它的 UTC 日期 */
  now?(): Date;
  /** 测试注入;缺省 = 以仓库根为 cwd 的只读 git(`createGuardGit`) */
  git?: GuardGit;
  /** 测试注入:传给 git 子进程的额外环境 */
  gitEnv?: Readonly<Record<string, string>>;
}

interface Parsed {
  rule: string | undefined;
  to: string | undefined;
  reason: string | undefined;
  by: string | undefined;
  today: string | undefined;
  write: boolean;
  json: boolean;
  error: string | undefined;
}

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = {
    rule: undefined,
    to: undefined,
    reason: undefined,
    by: undefined,
    today: undefined,
    write: false,
    json: false,
    error: undefined,
  };
  const fail = (m: string): void => {
    out.error ??= m;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (name: string): string | undefined => {
      if (a === name) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) {
          fail(`needs_value:${name}`);
          return undefined;
        }
        i++;
        return v;
      }
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      return undefined;
    };
    if (a === '--write') {
      out.write = true;
      continue;
    }
    if (a === '--json') {
      out.json = true;
      continue;
    }
    if (
      a === '--run-llm' ||
      a === '--allow-egress' ||
      a.startsWith('--run-llm=') ||
      a.startsWith('--allow-egress=')
    ) {
      fail('no_egress_flags');
      continue;
    }
    let matched = false;
    for (const key of ['rule', 'to', 'reason', 'by', 'today'] as const) {
      const v = value(`--${key}`);
      if (v !== undefined) {
        out[key] = v;
        matched = true;
        break;
      }
    }
    if (!matched) fail('unknown_arg');
  }
  if (out.error === undefined) {
    if (out.rule === undefined || !KebabIdSchema.safeParse(out.rule).success)
      out.error = out.rule === undefined ? 'rule_required' : 'bad_rule_id';
    else if (out.to !== 'deprecated' && out.to !== 'retired') out.error = 'bad_to';
    else if (out.reason === undefined || !isRetireReason(out.reason)) out.error = 'bad_reason';
    else if (out.today !== undefined && !IsoDateSchema.safeParse(out.today).success)
      out.error = 'bad_today';
    else if (out.reason === 'superseded' && out.by === undefined) out.error = 'by_required';
    else if (out.reason !== 'superseded' && out.by !== undefined) out.error = 'by_only_superseded';
    else if (out.by !== undefined && !KebabIdSchema.safeParse(out.by).success) out.error = 'bad_by';
    else if (out.by === out.rule) out.error = 'by_is_self';
  }
  return out;
}

class Exit extends Error {
  constructor(
    readonly code: number,
    readonly tag: 'USAGE' | 'CHECK_FAILED' | 'NOT_RUN' | 'FAIL_CLOSED',
    readonly reason: string,
  ) {
    super(reason);
  }
}

async function writeOut(
  io: IoContext,
  plan: { retireId: string; patch: string; prBody: string; report: string },
): Promise<{ wrote: boolean; existing: boolean }> {
  try {
    return await writeStateOut(
      io,
      'retire',
      plan.retireId,
      { 'retire.patch': plan.patch, 'pr-body.md': plan.prBody, 'report.json': plan.report },
      'RETIRE_RUN_EXISTS',
    );
  } catch (e) {
    if (e instanceof StateOutError) throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', e.reason);
    throw e;
  }
}

export function createRetireCommand(deps: RetireCommandDeps = {}): CommandDef {
  const def: CommandDef = {
    name: 'retire',
    summary: '生成退役 PR(--rule --to deprecated|retired --reason <码>)',
    phase: 'P1',
    ownerBlock: 'P1',
    flags: [
      { name: '--rule <id>', description: '要退役的规则 id(team 层)' },
      {
        name: '--to <deprecated|retired>',
        description:
          'T3/T4 advisory|active→deprecated;T5 deprecated→retired(须已出现在基线祖先 stable tag);T6 proposed→retired',
      },
      {
        name: '--reason <码>',
        description:
          'manual | expired | superseded | no_exposure | harmful | rejected(各有机械证据,不满足退出 1)',
      },
      {
        name: '--by <id>',
        description: '仅 superseded:接替者原子 id(须 active 且 supersedes 含本 id)',
      },
      {
        name: '--today <YYYY-MM-DD>',
        description: 'expired 的比较日,也是记录的 recorded_at(缺省取时钟的 UTC 日期)',
      },
      {
        name: '--write',
        description:
          '写 .state/retire/<retire_id>/(retire.patch + pr-body.md + report.json);缺省只打印',
      },
      { name: '--json', description: 'stdout 输出 canonical JSON' },
    ],
    async run(ctx: CommandContext): Promise<number> {
      const args = parseArgs(ctx.argv);
      try {
        if (args.error !== undefined) throw new Exit(ExitCode.USAGE, 'USAGE', args.error);
        const io = ctx.io;
        const to = args.to as RetireTarget;
        const ruleId = args.rule as string;
        const reason = args.reason as RetireReason;
        const today =
          args.today ?? (deps.now ?? ((): Date => new Date()))().toISOString().slice(0, 10);
        const git = deps.git ?? createGuardGit(io, io.repoRoot, deps.gitEnv);

        let plan;
        try {
          plan = await planRetirement(io, { ruleId, to, reason, by: args.by, today, git });
        } catch (e) {
          if (!(e instanceof RetireError)) throw e;
          const failures = [...e.codes];
          if (args.json) {
            ctx.stdout(
              canonicalJson({ ok: false, rule_id: ruleId, to, reason: e.reason, failures }),
            );
          } else {
            ctx.stdout(
              `${[`ok=false`, `rule_id=${ruleId}`, `to=${to}`, `reason=${e.reason}`, ...failures.map((f) => `fail ${f}`)].join('\n')}\n`,
            );
          }
          ctx.stderr(`RETIRE_${e.tag} reason=${e.reason}\n`);
          return e.code;
        }

        if (plan.already) {
          if (args.json) {
            ctx.stdout(canonicalJson({ already: true, rule_id: plan.ruleId, status: plan.status }));
          } else ctx.stdout(`already=1\nrule_id=${plan.ruleId}\nstatus=${plan.status}\n`);
          return ExitCode.OK;
        }

        let wrote = false;
        let existing = false;
        if (args.write) ({ wrote, existing } = await writeOut(io, plan));
        const ch = (name: string): { atomsIn: string[]; atomsOut: string[] } =>
          plan.outDiff.channels.find((c) => c.channel === name) ?? { atomsIn: [], atomsOut: [] };
        const summary = {
          already: false,
          rule_id: plan.ruleId,
          from: plan.from,
          to: plan.to,
          reason: plan.reason,
          by: plan.by,
          dry: !args.write,
          retire_id: plan.retireId,
          record_path: plan.recordPath,
          record_sha256: plan.recordSha256,
          rule_sha256: plan.ruleSha256,
          patch_sha256: plan.patchSha256,
          attest_files: plan.attestDigests.length,
          out_canary_in: ch('canary').atomsIn.length,
          out_canary_out: ch('canary').atomsOut.length,
          out_stable_in: ch('stable').atomsIn.length,
          out_stable_out: ch('stable').atomsOut.length,
          wrote,
          existing,
        };
        if (args.json) ctx.stdout(canonicalJson(summary));
        else {
          ctx.stdout(
            `${Object.entries(summary)
              .map(([k, v]) => `${k}=${v === null ? '-' : String(v)}`)
              .join('\n')}\n`,
          );
        }
        return ExitCode.OK;
      } catch (e) {
        let x: Exit;
        if (e instanceof Exit) x = e;
        else if (e instanceof GitError)
          x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'git_failed');
        else if (e instanceof WriteDeniedError)
          x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', e.code);
        else x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'internal');
        ctx.stderr(`RETIRE_${x.tag} reason=${x.reason}\n`);
        return x.code;
      }
    },
  };
  return def;
}

export const command: CommandDef = createRetireCommand();

/**
 * `agent-kit promote --run <run_id> [--write] [--json]`(L3,T0 采纳,docs/contracts.md §18;修缺口 G-a):
 * 读 `.state/reflect/<run_id>/`,逐条提案跑 C1–C9,全过的团队层提案用**当前**(已含 judge 记录的)提案与规则文件
 * 重新生成补丁 `promote.patch`——暂存区里 judge 之前生成的 `apply.patch` 作废。
 *
 * `promote --rule <id> --to advisory|active`(L4,晋升)本块**未实装**:参数合法时退出 64(`PROMOTE_NOT_IMPLEMENTED`)。
 *
 * - **纯本地、零网络**:不 import llm-exec / backends(也不经 commands/reflect.ts 传递引入);`--run-llm` / `--allow-egress` 出现即退出 2。
 * - **默认干跑**:只算、只打印;`--write` 才写,且只写 `.state/promote/<promo_id>/{promote.patch, pr-body.md, report.json}`
 *   (目录 0700、文件 0600,先 `.tmp-<promo_id>` 再整体 rename),一律经 safe-fs(写出口守卫);不写 `rules/`、不改暂存区。
 * - 幂等:promo_id 由输入内容决定;目录已存在且三个文件都一致 → 退出 0 不重写;不一致 → 退出 3 `PROMOTE_RUN_EXISTS`。
 * - 退出码:0 完成(含已存在且一致);1 有提案被丢(任一判据不过)或没有可采纳项;2 用法(含 personal 层 `PERSONAL_LAYER_P2`、
 *   run 不存在、`--run` 与 `--rule` 同给或都不给);3 fail-closed(状态损坏、信号库损坏、脱敏扫描异常、写出口拒绝、
 *   同 id 不一致、补丁自检不过);4 本机无法核对(证据信号查不到、judge 冷却挂起)且没有硬失败;64 `--rule` 模式未实装。
 *   多结果合并走 `combineExitCodes`。
 * - stdout 只含计数、枚举、id、哈希(`--json` 为 canonical JSON);stderr 只含稳定码 `PROMOTE_* reason=<码>`。
 */
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { IsoDateSchema, RunIdSchema } from '../contracts/common.js';
import { OverlaySchema } from '../contracts/config.js';
import type { Overlay } from '../contracts/config.js';
import { ExitCode } from '../contracts/exit-codes.js';
import type { Redactor } from '../contracts/redact.js';
import { canonicalJson } from '../io/canonical-json.js';
import type { IoContext } from '../io/paths.js';
import { exists, lstat, readText } from '../io/read-fs.js';
import { chmod, mkdirp, rename, writeFile, WriteDeniedError } from '../io/safe-fs.js';
import { JudgeRunNotFoundError } from '../judge/store.js';
import { JudgeStateError } from '../judge/errors.js';
import { AdoptFailClosedError, planAdoption } from '../lifecycle/adopt.js';
import type { AdoptPlan } from '../lifecycle/adopt.js';
import { createRedactor } from '../redact/redactor.js';
import { SignalStoreError } from '../signals/state-store.js';
import { combineExitCodes } from './types.js';
import type { CommandContext, CommandDef } from './types.js';

/** 脱敏每条每遍的时间预算:与 reflect 同取舍,负载抖动不应当成泄露。 */
export const PROMOTE_REDACT_TIMEOUT_MS = 5000;

export interface PromoteCommandDeps {
  /** 测试注入;缺省按覆盖层建真实 Redactor */
  redactor?: Pick<Redactor, 'pass2'>;
}

interface Parsed {
  run: string | undefined;
  rule: string | undefined;
  to: string | undefined;
  today: string | undefined;
  write: boolean;
  json: boolean;
  error: string | undefined;
}

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = {
    run: undefined,
    rule: undefined,
    to: undefined,
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
    if (a === '--run-llm' || a === '--allow-egress' || a.startsWith('--run-llm=')) {
      fail('no_egress_flags');
      continue;
    }
    const run = value('--run');
    if (run !== undefined) {
      out.run = run;
      continue;
    }
    const rule = value('--rule');
    if (rule !== undefined) {
      out.rule = rule;
      continue;
    }
    const to = value('--to');
    if (to !== undefined) {
      out.to = to;
      continue;
    }
    const today = value('--today');
    if (today !== undefined) {
      out.today = today;
      continue;
    }
    fail('unknown_arg');
  }
  if (out.error === undefined) {
    if ((out.run === undefined) === (out.rule === undefined)) out.error = 'run_xor_rule';
    else if (out.run !== undefined) {
      if (out.to !== undefined || out.today !== undefined) out.error = 'to_today_need_rule';
      else if (!RunIdSchema.safeParse(out.run).success) out.error = 'bad_run_id';
    } else {
      if (out.to !== 'advisory' && out.to !== 'active') out.error = 'bad_to';
      else if (out.today !== undefined && !IsoDateSchema.safeParse(out.today).success)
        out.error = 'bad_today';
    }
  }
  return out;
}

class Exit extends Error {
  constructor(
    readonly code: number,
    readonly tag: 'USAGE' | 'CHECK_FAILED' | 'NOT_RUN' | 'FAIL_CLOSED' | 'NOT_IMPLEMENTED',
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** 读覆盖层(只经 `--overlay` 显式传入)。失败不回显内容。本文件不经 commands/reflect.ts,免得传递引入 llm-exec。 */
async function readOverlay(ctx: CommandContext): Promise<Overlay | undefined> {
  if (ctx.overlayPath === undefined) return undefined;
  try {
    return OverlaySchema.parse(parseToml(await readText(ctx.overlayPath)));
  } catch {
    throw new Exit(ExitCode.USAGE, 'USAGE', 'overlay_unreadable');
  }
}

async function assertRealDir(dir: string): Promise<void> {
  if (!(await exists(dir))) return;
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'state_dir_unsafe');
  }
}

async function assertRegularFile(file: string): Promise<void> {
  const st = await lstat(file);
  if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) {
    throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'state_file_unsafe');
  }
}

async function put(io: IoContext, file: string, content: string): Promise<void> {
  await mkdirp(io, path.dirname(file), 0o700);
  await chmod(io, path.dirname(file), 0o700);
  await writeFile(io, file, content, { mode: 0o600 });
  await chmod(io, file, 0o600);
}

const OUT_FILES = ['promote.patch', 'pr-body.md', 'report.json'] as const;

/** 写 `.state/promote/<promo_id>/`;返回 wrote / existing。 */
async function writeOut(
  io: IoContext,
  plan: AdoptPlan,
): Promise<{ wrote: boolean; existing: boolean }> {
  const content: Record<(typeof OUT_FILES)[number], string> = {
    'promote.patch': plan.patch,
    'pr-body.md': plan.prBody,
    'report.json': plan.report,
  };
  const root = path.join(io.stateDir, 'promote');
  const dir = path.join(root, plan.promoId);
  await assertRealDir(root);
  if (await exists(dir)) {
    await assertRealDir(dir);
    // 内容一致还不够:已有产物的权限被放宽(补丁里有提案与证据)也要拒,不能静默报「已存在」
    if (((await lstat(dir)).mode & 0o777) !== 0o700) {
      throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'state_perm_unsafe');
    }
    for (const n of OUT_FILES) {
      if (!(await exists(path.join(dir, n)))) {
        throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'PROMOTE_RUN_EXISTS');
      }
      await assertRegularFile(path.join(dir, n));
      if (((await lstat(path.join(dir, n))).mode & 0o777) !== 0o600) {
        throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'state_perm_unsafe');
      }
      if ((await readText(path.join(dir, n))) !== content[n]) {
        throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'PROMOTE_RUN_EXISTS');
      }
    }
    return { wrote: false, existing: true };
  }
  const tmp = path.join(root, `.tmp-${plan.promoId}`);
  if (await exists(tmp)) throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'tmp_exists');
  for (const n of OUT_FILES) await put(io, path.join(tmp, n), content[n]);
  await rename(io, tmp, dir);
  return { wrote: true, existing: false };
}

export function createPromoteCommand(deps: PromoteCommandDeps = {}): CommandDef {
  async function adopt(ctx: CommandContext, args: Parsed): Promise<number> {
    const io = ctx.io;
    const overlay = await readOverlay(ctx);
    let redactor = deps.redactor;
    if (redactor === undefined) {
      try {
        redactor = createRedactor(
          {
            sensitive_words: overlay?.sensitive_words ?? [],
            timeout_ms: PROMOTE_REDACT_TIMEOUT_MS,
          },
          { internalDomains: overlay?.internal_domains ?? [] },
        );
      } catch {
        throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'redactor_init');
      }
    }

    const plan = await planAdoption(io, {
      runId: args.run as string,
      redactor,
      teamProjectKeys: overlay?.reflect?.team_project_keys ?? [],
      vendorOverrides: overlay?.reflect?.vendor_overrides ?? {},
    });

    const hard = plan.dropped.filter((d) => !d.unverifiable && !d.personal).length;
    const unverifiable = plan.dropped.filter((d) => d.unverifiable).length;
    const personal = plan.dropped.filter((d) => d.personal).length;

    let wrote = false;
    let existing = false;
    if (args.write && plan.adopted.length > 0) ({ wrote, existing } = await writeOut(io, plan));

    const summary = {
      run_id: plan.runId,
      dry: !args.write,
      promo_id: plan.promoId,
      proposals: plan.total,
      adopted: plan.adopted.length,
      dropped: plan.dropped.length,
      adopted_ids: plan.adopted.map((a) => a.proposalId),
      dropped_by_reason: plan.droppedByReason,
      patch_sha256: plan.patchSha256,
      wrote,
      existing,
    };
    if (args.json) ctx.stdout(canonicalJson(summary));
    else {
      const lines = Object.entries(summary)
        .filter(([k]) => k !== 'dropped_by_reason' && k !== 'adopted_ids')
        .map(([k, v]) => `${k}=${String(v)}`);
      lines.push(`adopted_ids=${summary.adopted_ids.join(',')}`);
      for (const [r, n] of Object.entries(summary.dropped_by_reason)) lines.push(`drop ${r}=${n}`);
      ctx.stdout(`${lines.join('\n')}\n`);
    }

    const codes: number[] = [];
    if (personal > 0) {
      ctx.stderr('PROMOTE_USAGE reason=PERSONAL_LAYER_P2\n');
      codes.push(ExitCode.USAGE);
    }
    if (hard > 0) {
      ctx.stderr('PROMOTE_CHECK_FAILED reason=proposals_dropped\n');
      codes.push(ExitCode.CHECK_FAILED);
    }
    if (unverifiable > 0) {
      ctx.stderr('PROMOTE_NOT_RUN reason=unverifiable\n');
      codes.push(ExitCode.NOT_RUN);
    }
    if (plan.adopted.length === 0 && plan.dropped.length === 0) {
      ctx.stderr('PROMOTE_CHECK_FAILED reason=empty_run\n');
      codes.push(ExitCode.CHECK_FAILED);
    }
    return combineExitCodes(codes);
  }

  const def: CommandDef = {
    name: 'promote',
    summary: '生成晋升 PR(--run 采纳:重新生成含 judge 记录的补丁)',
    phase: 'P1',
    ownerBlock: 'P1',
    flags: [
      {
        name: '--run <run_id>',
        description: '采纳:.state/reflect/<run_id>/ 下已评审的 reflect 运行',
      },
      { name: '--rule <id> --to <advisory|active>', description: '晋升(L4,尚未实装,退出 64)' },
      { name: '--today <YYYY-MM-DD>', description: '晋升模式用的日期(L4)' },
      {
        name: '--write',
        description:
          '写 .state/promote/<promo_id>/(promote.patch + pr-body.md + report.json);缺省只打印',
      },
      { name: '--json', description: 'stdout 输出 canonical JSON' },
    ],
    async run(ctx: CommandContext): Promise<number> {
      const args = parseArgs(ctx.argv);
      try {
        if (args.error !== undefined) throw new Exit(ExitCode.USAGE, 'USAGE', args.error);
        if (args.rule !== undefined) {
          throw new Exit(ExitCode.NOT_IMPLEMENTED, 'NOT_IMPLEMENTED', 'rule_mode_not_implemented');
        }
        return await adopt(ctx, args);
      } catch (e) {
        let x: Exit;
        if (e instanceof Exit) x = e;
        else if (e instanceof JudgeRunNotFoundError)
          x = new Exit(ExitCode.USAGE, 'USAGE', 'run_not_found');
        else if (e instanceof JudgeStateError)
          x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'state_invalid');
        else if (e instanceof AdoptFailClosedError)
          x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', e.code);
        else if (e instanceof SignalStoreError)
          x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'signal_store');
        else if (e instanceof WriteDeniedError)
          x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', e.code);
        else x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'internal');
        ctx.stderr(`PROMOTE_${x.tag} reason=${x.reason}\n`);
        return x.code;
      }
    },
  };
  return def;
}

export const command: CommandDef = createPromoteCommand();

/**
 * `agent-kit promote --run <run_id> [--write] [--json]`(L3,T0 采纳,docs/contracts.md §18;修缺口 G-a):
 * 读 `.state/reflect/<run_id>/`,逐条提案跑 C1–C9,全过的团队层提案用**当前**(已含 judge 记录的)提案与规则文件
 * 重新生成补丁 `promote.patch`——暂存区里 judge 之前生成的 `apply.patch` 作废。
 *
 * `promote --rule <id> --to advisory|active [--today YYYY-MM-DD] [--write] [--json]`(L4,晋升 T1/T2):
 * 在内存里构造 head 视图并调用真 `checkG3`(+ C1/C1b/C3 治理版/C5/C6/C7/C8),全绿才生成只改 `status:`(T2 再加 `review_by:`)的补丁
 * 与 `out/` 进出清单;红则不写。实现见 `lifecycle/promote-rule.ts`。退出码:0 完成 / 已是目标状态(`already=1`)/ 已存在且一致;
 * 1 判据不过(含工作树与 HEAD 不同 `PROMOTE_WORKTREE_DIRTY`、规则/提案找不到、方向不允许、无 signature `SIGNATURE_MISSING`、模拟 G3 红、预算阻断);
 * 2 用法(含 personal `PERSONAL_LAYER_P2` / org `ORG_LAYER_NOT_PROMOTABLE` / project 层);3 fail-closed(git 不可用、配置/out 清单算不出、
 * 写出口拒绝、`PROMOTE_RUN_EXISTS`);4 `judge_pending:cooldown`。产物 `.state/promote/<promo_id>/{promote.patch,pr-body.md,report.json}`。
 *
 * - **纯本地、零网络**:不 import llm-exec / backends(也不经 commands/reflect.ts 传递引入);`--run-llm` / `--allow-egress` 出现即退出 2。
 * - **默认干跑**:只算、只打印;`--write` 才写,且只写 `.state/promote/<promo_id>/{promote.patch, pr-body.md, report.json}`
 *   (目录 0700、文件 0600,先 `.tmp-<promo_id>` 再整体 rename),一律经 safe-fs(写出口守卫);不写 `rules/`、不改暂存区。
 * - 幂等:promo_id 由输入内容决定;目录已存在且三个文件都一致 → 退出 0 不重写;不一致 → 退出 3 `PROMOTE_RUN_EXISTS`。
 * - **rsi 隐私闸与即时闸(R20-A2 B5g,契约 R20-4.8 / §20.9 第 11、21 条;只管 `--run`,`--rule` 不读暂存区、不在其内)**:`[rsi]` 配置为 on 时才做,
 *   没有 `[rsi]` / 未启用 → 逐字节同接线前。顺序:`privacyCheck`(`cfg_*` 等不可用 → 退出 3 `RSI_FAIL_CLOSED`,此前零副作用)→
 *   干跑:`immediateGate`(`planAdoption` 之前)→ `planAdoption` → `immediateGate`(输出前);
 *   `--write`:`withRsiLockIfGated`(拿不到 → 退出 4 `PROMOTE_NOT_RUN reason=locked`;状态目录不安全 → 3)→ 锁内 `resumeTaint`(不 recover:本命令不写受快照清单管辖的文件)→
 *   闸 #1 → `planAdoption` → 闸 #2 → `writeStateOut`(每个写操作前 `assertHeld`)→ 输出。非 allow → `RSI_RUN_TAINTED` / `RSI_RUN_ATTRIBUTION_UNKNOWN`(1)/ `RSI_FAIL_CLOSED`(3),零写入、零输出。
 *   独立状态树(锁闸门 off)下照样 enforce(不拿锁、不 resumeTaint)。
 * - **tainted 产物目录(契约第 21 条)**:`--write` 在「已存在」比较之前,若 `.state/promote/<promo_id>/TAINTED` 在场 → 退出 1 `RSI_RUN_TAINTED reason=<r> run_id=<promo_id>`、零写入;
 *   **不论闸门结果、不论 `[rsi]` 是否启用**都查(没有 rsi 的用户没有 TAINTED 目录,行为不变)。原来「已存在但不一致 → 3 `PROMOTE_RUN_EXISTS`」的 tainted 目录因此改退 1。
 * - 退出码:0 完成(含已存在且一致);1 有提案被丢(任一判据不过)或没有可采纳项;2 用法(含 personal 层 `PERSONAL_LAYER_P2`、
 *   run 不存在、`--run` 与 `--rule` 同给或都不给);3 fail-closed(状态损坏、信号库损坏、脱敏扫描异常、写出口拒绝、
 *   同 id 不一致、补丁自检不过);4 本机无法核对(证据信号查不到、judge 冷却挂起)且没有硬失败;64 `--rule` 模式未实装。
 *   多结果合并走 `combineExitCodes`。
 * - stdout 只含计数、枚举、id、哈希(`--json` 为 canonical JSON);stderr 只含稳定码 `PROMOTE_* reason=<码>`。
 */
import { parse as parseToml } from 'smol-toml';
import { IsoDateSchema, KebabIdSchema, RunIdSchema } from '../contracts/common.js';
import { OverlaySchema } from '../contracts/config.js';
import type { Overlay } from '../contracts/config.js';
import { ExitCode } from '../contracts/exit-codes.js';
import type { Redactor } from '../contracts/redact.js';
import { canonicalJson } from '../io/canonical-json.js';
import type { IoContext } from '../io/paths.js';
import { readText } from '../io/read-fs.js';
import { WriteDeniedError } from '../io/safe-fs.js';
import { createGuardGit, GitError } from '../guards/git.js';
import type { GuardGit } from '../guards/types.js';
import { JudgeRunNotFoundError } from '../judge/store.js';
import { RsiLockError } from '../rsi/lock.js';
import type { RsiLockHandle } from '../rsi/lock.js';
import { immediateGate } from '../rsi/services/immediate-gate.js';
import { readMark } from '../rsi/services/staging.js';
import { resumeTaint } from '../rsi/services/taint.js';
import { RsiFailClosedError } from '../rsi/types.js';
import type { RsiServiceCtx } from '../rsi/types.js';
import { withRsiLockIfGated } from '../rsi/with-lock.js';
import type { WithRsiLockIfGatedOptions } from '../rsi/with-lock.js';
import { JudgeStateError } from '../judge/errors.js';
import { AdoptFailClosedError, planAdoption } from '../lifecycle/adopt.js';
import { PROMOTE_HINT_SIGNATURE, PromoteError, planPromotion } from '../lifecycle/promote-rule.js';
import type { PromoteTarget } from '../lifecycle/promote-rule.js';
import { createRedactor } from '../redact/redactor.js';
import { SignalStoreError } from '../signals/state-store.js';
import { GateStop, gateExitOf, gateIoOf, isGateExit, privacyCheck } from './rsi-gate-wiring.js';
import type { GateExit } from './rsi-gate-wiring.js';
import { StateOutError, writeStateOut } from './state-out.js';
import type { WriteGate } from './state-out.js';
import { combineExitCodes } from './types.js';
import type { CommandContext, CommandDef } from './types.js';

/** 脱敏每条每遍的时间预算:与 reflect 同取舍,负载抖动不应当成泄露。 */
export const PROMOTE_REDACT_TIMEOUT_MS = 5000;

export interface PromoteCommandDeps {
  /** 测试注入;缺省按覆盖层建真实 Redactor */
  redactor?: Pick<Redactor, 'pass2'>;
  /** 测试注入;`--today` 缺省取它的 UTC 日期 */
  now?(): Date;
  /** 测试注入;缺省 = 以仓库根为 cwd 的只读 git(`createGuardGit`) */
  git?: GuardGit;
  /** 测试注入:传给 git 子进程的额外环境 */
  gitEnv?: Readonly<Record<string, string>>;
  /** 测试缝:`planAdoption` 返回之后、闸 #2 之前调用(用来演练「第一次检查之后状态改变」);生产不传 */
  betweenGates?: () => Promise<void>;
  /** 测试注入:透传给 `withRsiLockIfGated`(`gate` / `lock`:时钟、pid、isAlive 等);只在 `[rsi]` 启用且 `--run --write` 时用到 */
  lockDeps?: WithRsiLockIfGatedOptions;
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
      if (!KebabIdSchema.safeParse(out.rule).success) out.error = 'bad_rule_id';
      else if (out.to !== 'advisory' && out.to !== 'active') out.error = 'bad_to';
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

async function writeOut(
  io: IoContext,
  plan: { promoId: string; patch: string; prBody: string; report: string },
  opts: { beforeWrite?: WriteGate; checkTaint?: boolean } = {},
): Promise<{ wrote: boolean; existing: boolean }> {
  const beforeWrite = opts.beforeWrite;
  if (opts.checkTaint === true) {
    // 契约第 21 条:tainted 的产物目录在「已存在」比较之前就拒(不论闸门结果;没有 rsi 的用户没有 TAINTED,此处只多一次 lstat)
    let mark: Awaited<ReturnType<typeof readMark>>;
    try {
      mark = await readMark(io, 'promote', plan.promoId);
    } catch (e) {
      // 链接 / 非目录等不安全状态:沿用 writeStateOut 一贯的稳定码(逐字节同接线前)
      if (e instanceof RsiFailClosedError) {
        throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', e.reason);
      }
      throw e;
    }
    if (mark.present) {
      throw new GateStop({
        exit: ExitCode.CHECK_FAILED,
        stderr: `RSI_RUN_TAINTED reason=${mark.reason} run_id=${plan.promoId}\n`,
      });
    }
  }
  try {
    return await writeStateOut(
      io,
      'promote',
      plan.promoId,
      { 'promote.patch': plan.patch, 'pr-body.md': plan.prBody, 'report.json': plan.report },
      'PROMOTE_RUN_EXISTS',
      beforeWrite !== undefined ? { beforeWrite } : {},
    );
  } catch (e) {
    if (e instanceof StateOutError) throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', e.reason);
    throw e;
  }
}

/** 拿锁 / 锁内 / 失锁相关失败的稳定码;不是这类错误返回 undefined,交给原有映射 */
function rsiFailureOf(e: unknown): GateExit | undefined {
  if (e instanceof RsiLockError) {
    const st = e.toStable();
    return st.code === 'RSI_NOT_RUN'
      ? { exit: ExitCode.NOT_RUN, stderr: 'PROMOTE_NOT_RUN reason=locked\n' }
      : { exit: ExitCode.FAIL_CLOSED, stderr: `RSI_FAIL_CLOSED reason=${st.reason}\n` };
  }
  if (e instanceof RsiFailClosedError) {
    return { exit: ExitCode.FAIL_CLOSED, stderr: `RSI_FAIL_CLOSED reason=${e.reason}\n` };
  }
  return undefined;
}

export function createPromoteCommand(deps: PromoteCommandDeps = {}): CommandDef {
  function makeRedactor(overlay: Overlay | undefined): Pick<Redactor, 'pass2'> {
    if (deps.redactor !== undefined) return deps.redactor;
    try {
      return createRedactor(
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

  /** 晋升(L4):`--rule <id> --to advisory|active`。 */
  async function promoteRule(ctx: CommandContext, args: Parsed): Promise<number> {
    const io = ctx.io;
    const overlay = await readOverlay(ctx);
    const redactor = makeRedactor(overlay);
    const to = args.to as PromoteTarget;
    const ruleId = args.rule as string;
    const today = args.today ?? (deps.now ?? ((): Date => new Date()))().toISOString().slice(0, 10);
    const git = deps.git ?? createGuardGit(io, io.repoRoot, deps.gitEnv);

    let plan;
    try {
      plan = await planPromotion(io, { ruleId, to, today, git, redactor });
    } catch (e) {
      if (!(e instanceof PromoteError)) throw e;
      const failures = [...e.codes];
      if (args.json) {
        ctx.stdout(canonicalJson({ ok: false, rule_id: ruleId, to, reason: e.reason, failures }));
      } else {
        ctx.stdout(
          `${[`ok=false`, `rule_id=${ruleId}`, `to=${to}`, `reason=${e.reason}`, ...failures.map((f) => `fail ${f}`)].join('\n')}\n`,
        );
      }
      ctx.stderr(`PROMOTE_${e.tag} reason=${e.reason}\n`);
      if (failures.includes('G3:SIGNATURE_MISSING')) {
        ctx.stderr(
          `PROMOTE_CHECK_FAILED reason=SIGNATURE_MISSING hint=${PROMOTE_HINT_SIGNATURE}\n`,
        );
      }
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
      dry: !args.write,
      promo_id: plan.promoId,
      review_by_new: plan.reviewBy,
      rule_sha256: plan.ruleSha256,
      patch_sha256: plan.patchSha256,
      attest_files: plan.attestHashes.length,
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
  }

  /** `--run`(采纳)入口:隐私闸 → (rsi 启用 + `--write`)拿锁 + 锁内 resumeTaint → {@link adoptCore} */
  async function adopt(ctx: CommandContext, args: Parsed): Promise<number> {
    const pc = await privacyCheck(ctx);
    if (isGateExit(pc)) {
      ctx.stderr(pc.stderr);
      return pc.exit;
    }
    if (pc.kind === 'legacy') return adoptCore(ctx, args, undefined, null);
    const gctx: RsiServiceCtx = { io: gateIoOf(ctx.io, pc.home), config: pc.config };
    if (!args.write) return adoptCore(ctx, args, gctx, null);
    return withRsiLockIfGated(
      { io: ctx.io, config: pc.config },
      async (lock) => {
        // 只 resumeTaint、不 recover:promote 不写受快照清单管辖的文件
        if (lock !== null) await resumeTaint(gctx, lock);
        return adoptCore(ctx, args, gctx, lock);
      },
      deps.lockDeps,
    );
  }

  /** 计划与落盘。`gctx` = rsi 启用(过即时闸);`lock` = 持有的 `rsi/lock`(每个写操作前 `assertHeld`) */
  async function adoptCore(
    ctx: CommandContext,
    args: Parsed,
    gctx: RsiServiceCtx | undefined,
    lock: RsiLockHandle | null,
  ): Promise<number> {
    const io = ctx.io;
    const runId = args.run as string;
    const gate = async (): Promise<void> => {
      if (gctx === undefined) return;
      const r = gateExitOf(await immediateGate(gctx, { kind: 'promote', runId }));
      if (r !== null) throw new GateStop(r);
    };
    await gate(); // 闸 #1:读暂存区(planAdoption)之前
    const overlay = await readOverlay(ctx);
    const redactor = makeRedactor(overlay);

    const plan = await planAdoption(io, {
      runId,
      redactor,
      teamProjectKeys: overlay?.reflect?.team_project_keys ?? [],
      vendorOverrides: overlay?.reflect?.vendor_overrides ?? {},
    });
    await deps.betweenGates?.();
    await gate(); // 闸 #2:落盘与输出之前(干跑:输出之前)

    const hard = plan.dropped.filter((d) => !d.unverifiable && !d.personal).length;
    const unverifiable = plan.dropped.filter((d) => d.unverifiable).length;
    const personal = plan.dropped.filter((d) => d.personal).length;

    let wrote = false;
    let existing = false;
    if (args.write && plan.adopted.length > 0) {
      ({ wrote, existing } = await writeOut(io, plan, {
        checkTaint: true,
        ...(lock !== null ? { beforeWrite: (): Promise<void> => lock.assertHeld() } : {}),
      }));
    }

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
    summary: '生成晋升 PR(--run 采纳 / --rule --to 晋升)',
    phase: 'P1',
    ownerBlock: 'P1',
    flags: [
      {
        name: '--run <run_id>',
        description: '采纳:.state/reflect/<run_id>/ 下已评审的 reflect 运行',
      },
      {
        name: '--rule <id> --to <advisory|active>',
        description:
          '晋升(T1 proposed→advisory / T2 advisory→active):生成只改 status/review_by 的补丁',
      },
      {
        name: '--today <YYYY-MM-DD>',
        description: '晋升模式用的日期(T2 的 review_by 新值由它算出;缺省取时钟的 UTC 日期)',
      },
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
        if (args.rule !== undefined) return await promoteRule(ctx, args);
        return await adopt(ctx, args);
      } catch (e) {
        // rsi 闸 / 锁:原样输出稳定码(`RSI_*` / `PROMOTE_NOT_RUN reason=locked`),零写入
        if (e instanceof GateStop) {
          ctx.stderr(e.gate.stderr);
          return e.gate.exit;
        }
        const lf = rsiFailureOf(e);
        if (lf !== undefined) {
          ctx.stderr(lf.stderr);
          return lf.exit;
        }
        let x: Exit;
        if (e instanceof Exit) x = e;
        else if (e instanceof JudgeRunNotFoundError)
          x = new Exit(ExitCode.USAGE, 'USAGE', 'run_not_found');
        else if (e instanceof JudgeStateError)
          x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'state_invalid');
        else if (e instanceof AdoptFailClosedError)
          x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', e.code);
        else if (e instanceof GitError)
          x = new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'git_failed');
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

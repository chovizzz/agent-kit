/**
 * `agent-kit judge --run <run_id> [--run-llm --allow-egress] [--max-calls N] [--strict]`(R4,契约 #24–#28):
 * 对 reflect 暂存的提案做跨厂商评审。
 *
 * - 默认干跑:读提案、建提示、列出每跳计划;**不调用后端、不写任何文件**。
 * - 真跑须同时给 `--run-llm` 与 `--allow-egress`(提案摘录会离开本机);缺后者退出 2。
 * - 后端经依赖注入(`createJudgeCommand(deps)`)。默认的 `command`(R5 接线)用与 reflect 同一套 `buildCliBackends`
 *   (覆盖层 `reflect.backends` → `buildBackends`),**只在 `--run-llm --allow-egress` 时构造**,干跑不构造;
 *   覆盖层须 `reflect.egress = true`,否则退出 2。没有已配置的槽位 → 真跑退出 4 并提示。
 *   本文件不 import llm-exec 与 `src/reflect/backends/**`(经 ./reflect.js 的接线辅助)。
 * - 真跑还读 kit.toml `[lifecycle]` 与仓库 HEAD 提交 oid,写入 `judge.prediction` / `judge.acceptance`(冻结验收协议,K3);
 *   读不到 kit.toml 或取不到 HEAD → 退出 3(fail-closed)。
 * - 读写只经 read-fs/safe-fs;写入限 `.state/reflect/<run_id>/proposals/` 下的 judge/judge_attempts。
 * - 没评上且无跨厂商可用:拆成两个稳定码(P1 D4):`JUDGE_NOT_CONFIGURED`(链上没有任何已配置后端,配置问题)
 *   与 `JUDGE_SAME_VENDOR_ONLY`(有已配置后端但都与反思器同厂商);默认仍退出 0(决策 ⑩A),`--strict` 时退出 4。
 *   `--strict` 只影响这两种情形;干跑不产生 pending,故不受影响。
 * - **rsi/lock(R20-A2 B3b,契约 R20-5.1 / R20-5.2)**:谁拿锁——只有 `--run-llm`(真跑),按 `lockGate` 判定:`[rsi]` 未启用 / 状态树确定独立 →
 *   不拿锁、不建 `.state/rsi/`(逐字节同接线前);同一状态树 → 在**构造后端之前**试锁(不排队),整个评审期间持有(锁序 `rsi/lock` → `reflect/llm.lock`),
 *   拿不到 `JUDGE_NOT_RUN reason=locked` 退出 4;状态目录无法证明安全 → `RSI_FAIL_CLOSED reason=state_dir_unsafe` 退出 3,不写任何东西。
 *   每次 LLM 返回后与每次写提案前都先 `assertHeld()`;失锁 → 不再外发 / 不再写,`RSI_FAIL_CLOSED reason=lock_lost` 退出 3。
 *   干跑不拿锁、不改。
 * - **隐私闸与即时闸(R20-A2 B5g,契约 R20-4.8 / §20.9 第 11 条)**:`[rsi]` 配置为 on(armed / confirmed / stopped)时才做,没有 `[rsi]` / 未启用 → 逐字节同接线前。
 *   顺序:参数 → `privacyCheck`(`loadRsiConfig({env})`;`cfg_*` / `repo_invalid` / `overlay_invalid` / `exclude_invalid` → 退出 3 `RSI_FAIL_CLOSED`,此前零副作用)→
 *   (真跑)拿锁 → 锁内 `assertNoPurgeInProgress` → `immediateGate`(读暂存区、构造后端之前;干跑也过一次)→ `runJudge` → 输出前再过一次。
 *   `runJudge` 内部的三个点用**包装器**接回调(不改 `src/judge/run.ts`):后端包装(在 `guardBackend` 外层)每次 `complete` 前过 `beforeExternalCall`、
 *   `StoreFs` 包装在每次落盘序列开头(`writeFile` tmp 前;chmod / rename / 清 tmp 属同一次落盘,见 `gateStoreFs`)过 `beforePersist`、打印(含异常分支的部分结果)前过 `beforeOutput`;任何一次非 allow → 之后不再外发 / 不再落盘 / 不打印,
 *   退出码取 {@link gateExitOf}(与已有结果经 `combineExitCodes` 合并)。已经写下的 judge 记录不撤销(同 B3b 失锁语义)。独立状态树(锁闸门 off)下照样 enforce。
 *   judge 锁内的 recover / resumeTaint / counts.staged 属 B5d,本块不做。
 * - 退出码:0 完成(含 pending=not_configured / same_vendor_only,非 --strict);1 有提案 reject / injection_suspected / 没评上且出现过评审输出校验不通过;
 *   2 用法错(含 run 不存在);3 状态损坏、提示复扫残留、厂商不可证明、写出口拒绝;
 *   4 后端不可用/全部冷却/超出 --max-calls。
 */
import type { Overlay } from '../contracts/config.js';
import type { Redactor } from '../contracts/redact.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { canonicalJson } from '../io/canonical-json.js';
import { WriteDeniedError } from '../io/safe-fs.js';
import {
  JudgeFailClosedError,
  JudgeProviderMismatchError,
  JudgeStateError,
} from '../judge/errors.js';
import { runJudge } from '../judge/run.js';
import type { JudgeBackends, JudgeReport, ProposalOutcome } from '../judge/run.js';
import { JudgeRunNotFoundError, SAFE_STORE_FS } from '../judge/store.js';
import type { StoreFs } from '../judge/store.js';
import type { RsiLockHandle } from '../rsi/lock.js';
import { immediateGate, judgeGateCallbacks } from '../rsi/services/immediate-gate.js';
import { assertNoPurgeInProgress } from '../rsi/services/taint.js';
import type { ImmediateGateCheck, RsiServiceCtx } from '../rsi/types.js';
import type { LlmBackend, LlmCompleteResult } from '../reflect/backend-iface.js';
import { createRedactor } from '../redact/redactor.js';
import type { RsiConfig } from '../rsi/config.js';
import { stableOf } from '../rsi/exit.js';
import { RsiStagingBlockedError } from '../rsi/services/staging.js';
import { parseDecimalUint } from './args.js';
import {
  buildCliBackends,
  checkHeld,
  guardBackend,
  loadOverlay,
  overlayAllowsEgress,
  rsiLockFailure,
  withRsiWriterLock,
} from './reflect.js';
import type { LockLossState, RsiLockWiring } from './reflect.js';
import { GateStop, gateExitOf, gateIoOf, isGateExit, privacyCheck } from './rsi-gate-wiring.js';
import type { GateExit } from './rsi-gate-wiring.js';
import { enterWriterLock, serviceCtxOf, settleStaged } from './rsi-staged-wiring.js';
import { combineExitCodes } from './types.js';
import type { CommandContext, CommandDef } from './types.js';

export const DEFAULT_MAX_CALLS = 5;
/** 与 llm-exec 的 LLM_MAX_SPAWNS 对齐 */
export const MAX_CALLS_CEILING = 10;
/** 评审提示/输出的脱敏复扫每遍时间预算(与 signals collect 同一取舍:负载抖动不应当成泄露)。 */
export const DEFAULT_JUDGE_REDACT_TIMEOUT_MS = 250;

export interface JudgeCommandDeps extends RsiLockWiring {
  /**
   * 后端工厂:返回「兜底链槽位 → 后端」。必须无副作用(干跑也会调用它来列计划,但不得 complete)。
   * `mode.live` = 用户同时给了 `--run-llm --allow-egress`;默认接线的工厂只在 live 时构造后端。
   * 缺省 = 没有任何可用后端。
   */
  createBackends?(
    ctx: CommandContext,
    mode: { live: boolean; maxCalls: number; overlay: Overlay | undefined },
  ): Promise<JudgeBackends> | JudgeBackends;
  /** 真跑要求覆盖层 `reflect.egress = true`。缺省 = 要求;只有注入进程内假后端的测试才传 false */
  requireOverlayEgress?: boolean;
  /** 测试注入;缺省按覆盖层建真实 Redactor */
  redactor?: Pick<Redactor, 'pass2'>;
  /** 测试注入:仓库 HEAD 提交 oid(缺省经 git 取);取不到 → 真跑退出 3 */
  resolveHead?: () => string | undefined;
  /** 测试注入:judge 时钟(frozen_at) */
  now?: () => Date;
}

interface Parsed {
  run: string | undefined;
  runLlm: boolean;
  allowEgress: boolean;
  maxCalls: number;
  strict: boolean;
  error: string | undefined;
}

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = {
    run: undefined,
    runLlm: false,
    allowEgress: false,
    maxCalls: DEFAULT_MAX_CALLS,
    strict: false,
    error: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (name: string): string | undefined => {
      if (a === name) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) {
          out.error = `${name} 需要一个值`;
          return undefined;
        }
        i++;
        return v;
      }
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      return undefined;
    };
    if (a === '--run-llm') {
      out.runLlm = true;
      continue;
    }
    if (a === '--allow-egress') {
      out.allowEgress = true;
      continue;
    }
    if (a === '--strict') {
      out.strict = true;
      continue;
    }
    const run = value('--run');
    if (run !== undefined) {
      out.run = run;
      continue;
    }
    const mc = value('--max-calls');
    if (mc !== undefined) {
      const n = parseDecimalUint(mc);
      if (n === undefined || n < 1 || n > MAX_CALLS_CEILING) {
        out.error = `--max-calls 需要 1..${MAX_CALLS_CEILING} 的十进制整数`;
      } else out.maxCalls = n;
      continue;
    }
    if (out.error === undefined) out.error = `未知参数:${a}`;
  }
  if (out.error === undefined) {
    if (out.run === undefined) out.error = '缺少 --run <run_id>';
    else if (out.runLlm && !out.allowEgress) {
      out.error = '--run-llm 必须同时给 --allow-egress:提案摘录将离开本机,发送给所选评审厂商';
    }
  }
  return out;
}

function outcomeExit(o: ProposalOutcome, strict: boolean): number {
  // 厂商不可证明导致没评上(或干跑里没有任何可调用的跳):配置问题,fail-closed
  if (
    o.vendorUnknown &&
    (o.status === 'pending' ||
      (o.status === 'planned' && !o.hops.some((h) => h.result === 'planned:call')))
  ) {
    return ExitCode.FAIL_CLOSED;
  }
  switch (o.status) {
    case 'judged':
    case 'already_judged':
      return o.verdict === 'reject' || o.injectionSuspected === true
        ? ExitCode.CHECK_FAILED
        : ExitCode.OK;
    case 'pending':
      if (o.pending === 'cooldown') return ExitCode.NOT_RUN;
      if (o.pending === 'all_failed')
        return o.invalidOutput ? ExitCode.CHECK_FAILED : ExitCode.NOT_RUN;
      // not_configured / same_vendor_only:单厂商环境照常出提案,晋升时机械拒绝(决策 ⑩A);--strict 才升为 4
      return strict ? ExitCode.NOT_RUN : ExitCode.OK;
    case 'not_run':
      return ExitCode.NOT_RUN;
    case 'planned':
      return ExitCode.OK;
  }
}

export function judgeExitCode(report: JudgeReport, opts: { strict?: boolean } = {}): number {
  const strict = opts.strict === true;
  const codes = report.outcomes.map((o) => outcomeExit(o, strict));
  if (report.budgetExhausted) codes.push(ExitCode.NOT_RUN);
  return combineExitCodes(codes);
}

function summarize(report: JudgeReport): string {
  return canonicalJson({
    run_id: report.runId,
    dry: report.dry,
    calls_made: report.callsMade,
    calls_limit: report.callsLimit,
    budget_exhausted: report.budgetExhausted,
    proposals: report.outcomes.map((o) => ({
      id: o.proposalId,
      status: o.status,
      ...(o.verdict !== undefined ? { verdict: o.verdict } : {}),
      ...(o.injectionSuspected !== undefined ? { injection_suspected: o.injectionSuspected } : {}),
      ...(o.pending !== undefined ? { judge_pending: o.pending } : {}),
      wrote: o.wrote,
      hops: o.hops.map((h) => ({ hop: h.hop, vendor: h.vendor, model: h.model, result: h.result })),
    })),
  });
}

/** 写提案的出口:每次写 / 删 / 改名 / chmod 前先复核 `rsi/lock`;失锁 → 记入 `loss` 并抛(命令随后改报 lock_lost) */
export function guardStoreFs(lock: RsiLockHandle, loss: LockLossState): StoreFs {
  const held = async (): Promise<void> => {
    if (!(await checkHeld(lock, loss))) throw loss.lost;
  };
  return {
    async writeFile(io, target, data, opts) {
      await held();
      return SAFE_STORE_FS.writeFile(io, target, data, opts);
    },
    async chmod(io, target, mode) {
      await held();
      return SAFE_STORE_FS.chmod(io, target, mode);
    },
    async rename(io, from, to) {
      await held();
      return SAFE_STORE_FS.rename(io, from, to);
    },
    async remove(io, target) {
      await held();
      return SAFE_STORE_FS.remove(io, target);
    },
  };
}

/** 即时闸回调的一次现算;回调自己抛(非预期错误)按 fail-closed internal,不让它变成「放行」 */
async function evalGate(check: ImmediateGateCheck): Promise<GateExit | null> {
  try {
    return gateExitOf(await check());
  } catch {
    return gateExitOf({
      kind: 'fail_closed',
      code: 'RSI_FAIL_CLOSED',
      reason: 'internal',
      exit: ExitCode.FAIL_CLOSED,
    });
  }
}

/** 一次 judge 运行内共享的闸状态:一旦 `stop` 有值就不再外发 / 不再落盘 / 不再打印(保持到命令结束) */
interface GateRunState {
  stop: GateExit | undefined;
}

/**
 * 后端外发前的闸(`beforeExternalCall`):每次 `complete` 前现算;非 allow → 记入 `state.stop` 并返回失败结果(不调用真后端)。
 * 不抛:`runJudge` 会把后端抛错吞成 backend_error 继续走链、再去落盘;返回失败结果后,后续的落盘由 {@link gateStoreFs} 拦下。
 */
export function gateBackend(
  backend: LlmBackend,
  check: ImmediateGateCheck,
  state: GateRunState,
): LlmBackend {
  const failed: LlmCompleteResult = { ok: false, reason: 'error' };
  return {
    slot: backend.slot,
    vendor: backend.vendor,
    model: backend.model,
    cli: backend.cli,
    provider: backend.provider,
    async complete(req) {
      if (state.stop === undefined) state.stop = (await evalGate(check)) ?? undefined;
      if (state.stop !== undefined) return failed;
      return backend.complete(req);
    },
  };
}

/**
 * 落盘前的闸(`beforePersist`):非 allow → 抛 {@link GateStop},不落盘。
 * 一次「落盘」= `writeProposal` 的 writeFile(tmp) → chmod → rename 序列:**只在序列开头(writeFile)过闸**。
 * 原因:tmp 文件一旦落在 `proposals/` 里,证据扫描(`staging.ts` 的 walkFiles)就把它当「未完成的写入」报 unknown(U),
 * 序列中途再过闸会被自己的 tmp 拦下(并留下孤儿 tmp)。chmod / rename / 失败后清 tmp 的 remove 属于同一次落盘,不再单独过闸;
 * 序列内部的失锁复核仍由 {@link guardStoreFs}(每步 `assertHeld`)负责。
 */
export function gateStoreFs(
  inner: StoreFs,
  check: ImmediateGateCheck,
  state: GateRunState,
): StoreFs {
  return {
    async writeFile(io, target, data, opts) {
      if (state.stop === undefined) state.stop = (await evalGate(check)) ?? undefined;
      if (state.stop !== undefined) throw new GateStop(state.stop);
      return inner.writeFile(io, target, data, opts);
    },
    chmod: (io, target, mode) => inner.chmod(io, target, mode),
    rename: (io, from, to) => inner.rename(io, from, to),
    remove: (io, target) => inner.remove(io, target),
  };
}

export function createJudgeCommand(deps: JudgeCommandDeps = {}): CommandDef {
  const def: CommandDef = {
    name: 'judge',
    summary: '裁判:对 reflect 暂存的提案做跨厂商评审',
    phase: 'P1',
    ownerBlock: 'P1',
    flags: [
      { name: '--run <run_id>', description: '.state/reflect/<run_id>/ 下的 reflect 运行;必填' },
      { name: '--run-llm', description: '真跑:调用评审后端(须同时给 --allow-egress);缺省干跑' },
      { name: '--allow-egress', description: '同意把提案摘录发送给评审厂商' },
      { name: '--max-calls <n>', description: '本次最多调用后端次数,默认 5,上限 10' },
      {
        name: '--strict',
        description:
          '没评上且无跨厂商可用(JUDGE_NOT_CONFIGURED / JUDGE_SAME_VENDOR_ONLY)时退出 4,而不是 0',
      },
    ],
    async run(ctx: CommandContext): Promise<number> {
      const args = parseArgs(ctx.argv);
      if (args.error !== undefined || args.run === undefined) {
        ctx.stderr(`agent-kit judge: ${args.error ?? '参数错误'}\n`);
        return ExitCode.USAGE;
      }

      // 隐私闸:在读暂存区 / 构造后端 / 拿锁之前判定,此前零副作用(deny → 3)
      let gateCtx: RsiServiceCtx | undefined;
      try {
        const pc = await privacyCheck(ctx);
        if (isGateExit(pc)) {
          ctx.stderr(pc.stderr);
          return pc.exit;
        }
        if (pc.kind === 'enforce') {
          gateCtx = { io: gateIoOf(ctx.io, pc.home), config: pc.config };
        }
      } catch {
        ctx.stderr('RSI_FAIL_CLOSED reason=internal\n');
        return ExitCode.FAIL_CLOSED;
      }

      const runId = args.run; // 闭包里保持 string 窄化
      const live = args.runLlm && args.allowEgress;
      const loadedOverlay = await loadOverlay(ctx);
      if (!loadedOverlay.ok) {
        ctx.stderr('agent-kit judge: 覆盖层读取或校验失败\n'); // 不回显覆盖层内容
        return ExitCode.USAGE;
      }
      const overlay = loadedOverlay.overlay;
      if (live && deps.requireOverlayEgress !== false && !overlayAllowsEgress(overlay)) {
        ctx.stderr(
          'agent-kit judge: 覆盖层未同意外发(reflect.egress = true 才允许提案摘录离开本机);未调用、未写入\n',
        );
        return ExitCode.USAGE;
      }

      let redactor = deps.redactor;
      if (redactor === undefined) {
        try {
          redactor = createRedactor(
            {
              sensitive_words: overlay?.sensitive_words ?? [],
              timeout_ms: DEFAULT_JUDGE_REDACT_TIMEOUT_MS,
            },
            { internalDomains: overlay?.internal_domains ?? [] },
          );
        } catch {
          ctx.stderr('REDACT_FAIL_CLOSED reason=init\n');
          return ExitCode.FAIL_CLOSED;
        }
      }

      // 真跑才拿 rsi/lock,且在构造后端之前拿;干跑不读 rsi 配置、不拿锁
      const loss: LockLossState = { lost: undefined };
      const execute = async (lock: RsiLockHandle | null, cfg?: RsiConfig): Promise<number> => {
        // 锁内、改任何提案之前:purge 进行中拒绝(assertNoPurgeInProgress)
        if (lock !== null) await (deps.assertNoPurge ?? assertNoPurgeInProgress)({ io: ctx.io });
        // B5d(方案 §8):assertNoPurge 之后、即时闸 #1 之前:recoverUnderLock → resumeTaint(补完上一次中断的提交与 taint)。
        // 与 reflect 的顺序故意不同(reflect 在 assertNoPurge 之前,见 reflect.ts):有 purge journal 时 judge 直接拒绝、不补 taint;reflect 先补 taint 再拒绝——两者都按方案字面,不是疏漏
        const sctx = lock !== null ? serviceCtxOf(ctx, cfg, deps.now) : undefined;
        if (lock !== null && sctx !== undefined)
          await enterWriterLock(sctx, lock, deps.serviceHooks);
        // 即时闸 #1:读暂存区、构造后端之前(干跑也过)。非 allow → 零外发、零落盘、零输出
        const gstate: GateRunState = { stop: undefined };
        const scope = { kind: 'judge', runId } as const;
        const callbacks = gateCtx !== undefined ? judgeGateCallbacks(gateCtx, scope) : undefined;
        if (gateCtx !== undefined) {
          let first: GateExit | null;
          try {
            first = gateExitOf(await immediateGate(gateCtx, scope));
          } catch {
            first = { exit: ExitCode.FAIL_CLOSED, stderr: 'RSI_FAIL_CLOSED reason=internal\n' };
          }
          if (first !== null) {
            ctx.stderr(first.stderr);
            return first.exit;
          }
        }
        let backends: JudgeBackends;
        try {
          backends =
            (await deps.createBackends?.(ctx, { live, maxCalls: args.maxCalls, overlay })) ?? {};
        } catch {
          ctx.stderr('JUDGE_FAIL_CLOSED reason=internal\n');
          return ExitCode.FAIL_CLOSED;
        }
        if (lock !== null) {
          // LLM 返回后先 assertHeld(guardBackend);每次写提案前也复核(失锁后不再写 judge / judge_attempts)
          backends = Object.fromEntries(
            Object.entries(backends).map(([hop, b]) => [hop, guardBackend(b, lock, loss)]),
          ) as JudgeBackends;
        }
        if (callbacks !== undefined) {
          // 在 guardBackend 外层:每次 complete 前先过即时闸(beforeExternalCall)
          backends = Object.fromEntries(
            Object.entries(backends).map(([hop, b]) => [
              hop,
              gateBackend(b, callbacks.beforeExternalCall, gstate),
            ]),
          ) as JudgeBackends;
        }
        if (args.runLlm && Object.keys(backends).length === 0) {
          ctx.stderr(
            'JUDGE_NOT_CONFIGURED reason=no_backends agent-kit judge: 没有可用的评审后端(本命令不自带后端,须由接线块注入);未调用、未写入\n',
          );
          return ExitCode.NOT_RUN;
        }

        let report: JudgeReport;
        const done: ProposalOutcome[] = [];
        /** 打印前的闸(beforeOutput):已经停了就保持停;否则现算。非 allow → 不打印任何东西,按闸的码退出(与已有结果合并) */
        const outputStop = async (): Promise<number | undefined> => {
          if (callbacks === undefined) return undefined;
          if (gstate.stop === undefined) {
            gstate.stop = (await evalGate(callbacks.beforeOutput)) ?? undefined;
          }
          if (gstate.stop === undefined) return undefined;
          // 闸停与失锁同时发生:失锁(fail-closed 3)不得被闸的 1 压掉,报 lock_lost
          if (loss.lost !== undefined) {
            const lost = rsiLockFailure(loss.lost, 'JUDGE');
            ctx.stderr(lost?.line ?? 'RSI_FAIL_CLOSED reason=lock_lost\n');
            return combineExitCodes([
              gstate.stop.exit,
              ExitCode.FAIL_CLOSED,
              ...done.map((o) => outcomeExit(o, args.strict)),
            ]);
          }
          ctx.stderr(gstate.stop.stderr);
          return combineExitCodes([
            gstate.stop.exit,
            ...done.map((o) => outcomeExit(o, args.strict)),
          ]);
        };
        const partial = (): void => {
          if (done.length === 0) return;
          ctx.stdout(
            summarize({
              runId,
              dry: !args.runLlm,
              callsMade: 0,
              callsLimit: args.maxCalls,
              budgetExhausted: false,
              outcomes: done,
            }),
          );
        };
        /**
         * B5d(方案 §8):评审记录写完之后、同一把锁内更新 `counts.staged`(只写 `TAINTED` 文件事实)并提交清单;没拿锁 / 已失锁 / 没写过任何记录 → 跳过。
         * 失败 → 稳定码退 3(由调用方先 `partial()` 告诉用户哪些提案已写盘);已经写下的 judge 记录不撤销。
         */
        const settle = async (): Promise<GateExit | undefined> => {
          if (lock === null || sctx === undefined || loss.lost !== undefined) return undefined;
          if (!done.some((o) => o.wrote)) return undefined;
          try {
            await settleStaged(sctx, lock, redactor, deps.serviceHooks);
            return undefined;
          } catch (e) {
            // RsiSnapshotBusyError 会退 4(占线不是失败),是 stableOf 的既有口径;RsiStagingBlockedError 按自带的稳定码
            if (e instanceof RsiStagingBlockedError) {
              return { exit: e.exit, stderr: `RSI_FAIL_CLOSED reason=${e.reason}\n` };
            }
            const st = stableOf(e);
            return { exit: st.exit, stderr: `${st.line}\n` };
          }
        };
        const lockedFs: StoreFs | undefined = lock !== null ? guardStoreFs(lock, loss) : undefined;
        const storeFs: StoreFs | undefined =
          callbacks !== undefined
            ? gateStoreFs(lockedFs ?? SAFE_STORE_FS, callbacks.beforePersist, gstate)
            : lockedFs;
        try {
          report = await runJudge(
            {
              io: ctx.io,
              redactor,
              backends,
              ...(storeFs !== undefined ? { storeFs } : {}),
              onOutcome: (o) => done.push(o),
              ...(deps.resolveHead !== undefined ? { resolveHead: deps.resolveHead } : {}),
              ...(deps.now !== undefined ? { now: deps.now } : {}),
            },
            { runId, dry: !args.runLlm, maxCalls: args.maxCalls },
          );
        } catch (e) {
          // 闸已经停了(GateStop 或停在外发点之后的任何后续错误):不打印部分结果,按闸的码退出;**闸停之后不再写 rsi 投影**(先判闸,再 settle)
          const stopped = await outputStop();
          if (stopped !== undefined) return stopped;
          const settledErr = await settle();
          if (settledErr !== undefined) {
            partial();
            ctx.stderr(settledErr.stderr);
            return settledErr.exit;
          }
          partial(); // 中途失败时仍告诉用户哪些提案已处理(已写盘)
          if (loss.lost !== undefined) {
            const lost = rsiLockFailure(loss.lost, 'JUDGE');
            ctx.stderr(lost?.line ?? 'RSI_FAIL_CLOSED reason=lock_lost\n');
            return ExitCode.FAIL_CLOSED;
          }
          if (e instanceof JudgeRunNotFoundError) {
            ctx.stderr(`agent-kit judge: ${e.code}\n`);
            return ExitCode.USAGE;
          }
          if (
            e instanceof JudgeStateError ||
            e instanceof JudgeFailClosedError ||
            e instanceof JudgeProviderMismatchError ||
            e instanceof WriteDeniedError
          ) {
            // 只报稳定码:异常消息里不放任何提案/评审文本
            ctx.stderr(`JUDGE_FAIL_CLOSED reason=${e.code}\n`);
            return ExitCode.FAIL_CLOSED;
          }
          ctx.stderr('JUDGE_FAIL_CLOSED reason=internal\n');
          return ExitCode.FAIL_CLOSED;
        }

        const stoppedAfter = await outputStop();
        if (stoppedAfter !== undefined) return stoppedAfter; // 闸停之后不再写 rsi 投影
        const settledOk = await settle();
        if (settledOk !== undefined) {
          partial();
          ctx.stderr(settledOk.stderr);
          return settledOk.exit;
        }
        if (loss.lost !== undefined) {
          partial();
          const lost = rsiLockFailure(loss.lost, 'JUDGE');
          ctx.stderr(lost?.line ?? 'RSI_FAIL_CLOSED reason=lock_lost\n');
          return ExitCode.FAIL_CLOSED;
        }
        ctx.stdout(summarize(report));
        for (const o of report.outcomes) {
          if (o.pending === 'not_configured') {
            ctx.stderr(
              `JUDGE_NOT_CONFIGURED proposal=${o.proposalId} hint=没有已配置的评审后端,检查覆盖层 reflect.backends\n`,
            );
          } else if (o.pending === 'same_vendor_only') {
            ctx.stderr(
              `JUDGE_SAME_VENDOR_ONLY proposal=${o.proposalId} hint=已配置的评审后端都与反思器同厂商,需配置另一家厂商的后端\n`,
            );
          } else if (o.pending !== undefined) {
            ctx.stderr(`JUDGE_PENDING proposal=${o.proposalId} reason=${o.pending}\n`);
          }
          if (o.injectionSuspected === true) {
            ctx.stderr(`JUDGE_INJECTION_SUSPECTED proposal=${o.proposalId}\n`);
          }
        }
        return judgeExitCode(report, { strict: args.strict });
      };
      try {
        return args.runLlm ? await withRsiWriterLock(ctx, deps, execute) : await execute(null);
      } catch (e) {
        const locked = rsiLockFailure(e, 'JUDGE');
        if (locked !== undefined) {
          ctx.stderr(locked.line);
          return locked.exit;
        }
        ctx.stderr('JUDGE_FAIL_CLOSED reason=internal\n');
        return ExitCode.FAIL_CLOSED;
      }
    },
  };
  return def;
}

/** 默认接线:只在 live(--run-llm --allow-egress)时按覆盖层构造真实 CLI 后端;干跑返回 {}(不构造)。 */
function defaultCreateBackends(
  ctx: CommandContext,
  mode: { live: boolean; maxCalls: number; overlay: Overlay | undefined },
): JudgeBackends {
  if (!mode.live) return {};
  return buildCliBackends({
    ctx: ctx,
    overlay: mode.overlay,
    now: () => new Date(),
    maxSpawns: mode.maxCalls,
  });
}

export const command: CommandDef = createJudgeCommand({ createBackends: defaultCreateBackends });

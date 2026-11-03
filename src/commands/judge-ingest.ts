/**
 * `agent-kit judge --ingest - --run <run_id> [--write] [--replace] [--json]` 与
 * `agent-kit judge --confirm-reflector --run <run_id> [--proposal <id>]… --write [--json]`
 * (N4,docs/contracts.md §20.18;R20-18.3 ~ R20-18.12、R20-18.22)的命令入口。**独立成文件,不并入 `judge.ts`**(R20-18.25:两个确认流不塞同一文件);
 * `src/cli.ts` 在 `judge` 命令的参数里看到 `--ingest` / `--confirm-reflector` 时把它路由到这里。
 *
 * 命令层只做:严格参数 → **TTY 门(仅 `--write`,先于隐私闸与一切文件 / 配置读取,含 stdin)** → 隐私闸 → 读 stdin(> 64 KiB 拒绝,不拿锁)→
 * 装配端口(终端、锁、即时闸)→ 调服务 `runJudgeIngest` → 把结果映射成稳定码与退出码。stderr 只含稳定码与固定提示,不回显用户键入的内容、payload 文本或异常消息。
 *
 * 不读也不判 `[rsi.session]`(Q-N4-7 = A,R20-18.10)。确认屏与全部提示写 `/dev/tty` 句柄(经 `src/io/tty.ts` 的端口),stdout 只剩 `--json` 结果。
 * 自动入口(poke / hint / worker / 顺带调度 / sync / update / §21)的 import 闭包不得含本文件(lint + `test/rsi/import-closure.test.ts`)。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import {
  JUDGE_INGEST_CODES,
  MAX_INGEST_INPUT_BYTES,
  type JudgeUsageReason,
} from '../contracts/judge-ingest.js';
import { RunIdSchema } from '../contracts/common.js';
import { KIT_VERSION } from '../contracts/meta.js';
import type { Redactor } from '../contracts/redact.js';
import { canonicalJson } from '../io/canonical-json.js';
import { REAL_TTY_PORT, type TtyHandle, type TtyPort } from '../io/tty.js';
import { runJudgeIngest } from '../judge/ingest/service.js';
import {
  IngestLockLostError,
  IngestPurgePendingError,
  type IngestExit,
  type IngestOutcome,
  type LockedSession,
} from '../judge/ingest/types.js';
import type { StoreFs } from '../judge/store.js';
import { createRedactor } from '../redact/redactor.js';
import type { RsiLockHandle } from '../rsi/lock.js';
import { immediateGate } from '../rsi/services/immediate-gate.js';
import { assertNoPurgeInProgress } from '../rsi/services/taint.js';
import { RsiFailClosedError } from '../rsi/types.js';
import type { RsiServiceCtx } from '../rsi/types.js';
import { forbiddenPaths } from '../rsi/output.js';
import { stableOf } from '../rsi/exit.js';
import { RsiStagingBlockedError } from '../rsi/services/staging.js';
import { checkHeld, loadOverlay, rsiLockFailure, withRsiWriterLock } from './reflect.js';
import type { LockLossState, RsiLockWiring } from './reflect.js';
import { gateExitOf, gateIoOf, isGateExit, privacyCheck } from './rsi-gate-wiring.js';
import { enterWriterLock, serviceCtxOf, settleStaged } from './rsi-staged-wiring.js';
import { resolveReadStdin } from './types.js';
import type { CommandContext, CommandDef } from './types.js';

export interface JudgeIngestCommandDeps extends RsiLockWiring {
  /** 控制终端端口;缺省 = 真实 `/dev/tty`(测试注入假终端) */
  tty?: TtyPort;
  /** stdin 是不是 TTY;缺省读 `process.stdin.isTTY` */
  stdinIsTty?: () => boolean;
  redactor?: Pick<Redactor, 'pass2'>;
  resolveHead?: () => string | undefined;
  now?: () => Date;
  storeFs?: StoreFs;
  kitVersion?: string;
  hooks?: { afterConfirm?: () => Promise<void> | void };
}

/** 本命令识别的互斥模式开关;出现在 `judge` 的 argv 里即路由到本命令 */
export const INGEST_MODE_FLAGS: readonly string[] = ['--ingest', '--confirm-reflector'];
/** 与新模式互斥的既有 `judge --run-llm` 参数 */
const CONFLICT_FLAGS: readonly string[] = [
  '--run-llm',
  '--allow-egress',
  '--max-calls',
  '--strict',
];

interface Parsed {
  mode: 'ingest' | 'confirm_reflector' | undefined;
  run: string | undefined;
  write: boolean;
  replace: boolean;
  json: boolean;
  proposals: string[];
  error: JudgeUsageReason | undefined;
}

export function parseIngestArgs(argv: readonly string[]): Parsed {
  const out: Parsed = {
    mode: undefined,
    run: undefined,
    write: false,
    replace: false,
    json: false,
    proposals: [],
    error: undefined,
  };
  let ingest = false;
  let confirm = false;
  let conflict = false;
  let unknown = false;
  let ingestValueOk = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const takeValue = (name: string): string | undefined => {
      if (a === name) {
        const v = argv[i + 1];
        if (v === undefined || (v.startsWith('--') && v !== '-')) {
          unknown = true;
          return undefined;
        }
        i++;
        return v;
      }
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      return undefined;
    };
    if (a === '--confirm-reflector') {
      confirm = true;
      continue;
    }
    if (a === '--write') {
      out.write = true;
      continue;
    }
    if (a === '--replace') {
      out.replace = true;
      continue;
    }
    if (a === '--json') {
      out.json = true;
      continue;
    }
    if (a === '--ingest' || a.startsWith('--ingest=')) {
      ingest = true;
      const v = takeValue('--ingest');
      if (v !== '-') ingestValueOk = false; // 只接受 `-` = stdin
      continue;
    }
    if (a === '--run' || a.startsWith('--run=')) {
      const v = takeValue('--run');
      if (v !== undefined) out.run = v;
      continue;
    }
    if (a === '--proposal' || a.startsWith('--proposal=')) {
      const v = takeValue('--proposal');
      if (v !== undefined) out.proposals.push(v);
      continue;
    }
    if (CONFLICT_FLAGS.some((f) => a === f || a.startsWith(`${f}=`))) {
      conflict = true;
      // `--max-calls` 带值:吞掉,不让值被当成未知参数
      if (a === '--max-calls' && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) i++;
      continue;
    }
    unknown = true;
  }
  if (unknown || !ingestValueOk) out.error = 'unknown_arg';
  else if (
    conflict ||
    (ingest && confirm) ||
    (out.replace && !(ingest && out.write)) ||
    (out.proposals.length > 0 && !confirm)
  ) {
    out.error = 'mode_conflict';
  } else if (out.run === undefined) out.error = 'missing:--run';
  else if (confirm && !out.write) out.error = 'write_required';
  else if (!RunIdSchema.safeParse(out.run).success) out.error = 'bad_run';
  out.mode = ingest ? 'ingest' : confirm ? 'confirm_reflector' : undefined;
  return out;
}

function usage(ctx: CommandContext, reason: JudgeUsageReason): number {
  ctx.stderr(`${JUDGE_INGEST_CODES.usage} reason=${reason}\n`);
  return ExitCode.USAGE;
}

interface JsonDoc {
  result: 'dry' | 'written' | 'partial' | 'declined' | 'rejected' | 'not_run';
  reason: string | null;
  run_id: string | null;
  proposals: readonly string[];
  reflector_confirmed: readonly string[];
  written: number;
  replaced: number;
}

function emit(ctx: CommandContext, json: boolean, doc: JsonDoc, text: string): void {
  ctx.stdout(json ? canonicalJson(doc) : text);
}

/** 服务结果 → stdout / stderr / 退出码(R20-18.22) */
function report(ctx: CommandContext, json: boolean, runId: string, o: IngestOutcome): number {
  const base: Omit<JsonDoc, 'result' | 'reason'> = {
    run_id: runId,
    proposals: [],
    reflector_confirmed: [],
    written: 0,
    replaced: 0,
  };
  switch (o.kind) {
    case 'dry': {
      if (o.nothingToConfirm) {
        emit(
          ctx,
          json,
          { ...base, result: 'dry', reason: 'nothing_to_confirm' },
          'nothing_to_confirm\n',
        );
        return ExitCode.OK;
      }
      const text = o.plan
        .map(
          (p) =>
            `proposal=${p.id} layer=${p.layer} verdict=${p.verdict} overfit=${p.overfit} injection=${String(p.injection)} conflicts=${p.conflicts} prediction=${p.prediction} reflector_confirm=${p.needsReflectorConfirm ? 'required' : 'not_required'} freeze=deferred\n`,
        )
        .join('');
      emit(ctx, json, { ...base, result: 'dry', reason: null }, `dry run=${runId}\n${text}`);
      return ExitCode.OK;
    }
    case 'written': {
      const doc: JsonDoc = {
        ...base,
        result: o.partial ? 'partial' : 'written',
        reason: o.failure ?? null,
        proposals: o.proposals,
        reflector_confirmed: o.reflectorConfirmed,
        written: o.written,
        replaced: o.replaced,
      };
      const text =
        `written=${o.written}/${o.total} run=${runId} proposals=${o.proposals.join(',')} ` +
        `reflector_confirmed=${o.reflectorConfirmed.join(',')} replaced=${o.replaced}` +
        (o.reflectorUnconfirmed > 0 ? ` reflector_unconfirmed=${o.reflectorUnconfirmed}` : '') +
        '\n';
      emit(ctx, json, doc, text);
      if (o.failure !== undefined) {
        ctx.stderr(`${JUDGE_INGEST_CODES.failClosed} reason=${o.failure}\n`);
        return ExitCode.FAIL_CLOSED;
      }
      return ExitCode.OK;
    }
    case 'rejected':
      ctx.stderr(`${JUDGE_INGEST_CODES.rejected} reason=${o.reason}\n`);
      emit(ctx, json, { ...base, result: 'rejected', reason: o.reason }, '');
      return ExitCode.CHECK_FAILED;
    case 'declined':
      ctx.stderr(
        o.reason === 'stale'
          ? `${JUDGE_INGEST_CODES.stale}\n`
          : `${JUDGE_INGEST_CODES.declined} reason=${o.reason}\n`,
      );
      emit(ctx, json, { ...base, result: 'declined', reason: o.reason }, '');
      return ExitCode.CHECK_FAILED;
    case 'usage':
      return usage(ctx, o.reason);
    case 'fail_closed':
      ctx.stderr(`${JUDGE_INGEST_CODES.failClosed} reason=${o.reason}\n`);
      emit(ctx, json, { ...base, result: 'not_run', reason: o.reason }, '');
      return ExitCode.FAIL_CLOSED;
    case 'not_run':
      ctx.stderr(`${o.code} reason=${o.reason}\n`);
      emit(ctx, json, { ...base, result: 'not_run', reason: o.reason }, '');
      return ExitCode.NOT_RUN;
    case 'exit':
      ctx.stderr(o.exit.stderr);
      emit(ctx, json, { ...base, result: 'not_run', reason: firstWord(o.exit.stderr) }, '');
      return o.exit.exit;
  }
}

const firstWord = (s: string): string => s.trim().split(/\s+/)[0] ?? '';

export function createJudgeIngestCommand(deps: JudgeIngestCommandDeps = {}): CommandDef {
  const tty = deps.tty ?? REAL_TTY_PORT;
  const def: CommandDef = {
    name: 'judge',
    summary: '裁判:接收会话 agent 的评审(--ingest)/ 补做反思器侧人工确认(--confirm-reflector)',
    phase: 'P1',
    ownerBlock: 'P1',
    flags: [
      {
        name: '--ingest -',
        description: '从 stdin 接收会话 agent 交来的裁决(JSON;干跑可在无 TTY 下预检)',
      },
      { name: '--confirm-reflector', description: '补做反思器侧人工确认(须 --write)' },
      { name: '--run <run_id>', description: '.state/reflect/<run_id>/;必填' },
      { name: '--write', description: '真写:需要控制终端,在那里当场键入厂商名确认' },
      {
        name: '--replace',
        description: '只与 --ingest --write 同用:替换既有的自报裁决(不得替换 spawned 裁决)',
      },
      { name: '--proposal <id>', description: '只与 --confirm-reflector 同用:限定提案(可重复)' },
      { name: '--json', description: '输出固定键集合的 JSON 结果' },
    ],
    async run(ctx: CommandContext): Promise<number> {
      const a = parseIngestArgs(ctx.argv);
      if (a.error !== undefined) return usage(ctx, a.error);
      const mode = a.mode as 'ingest' | 'confirm_reflector';
      const runId = a.run as string;

      // TTY 门(仅 --write):先于隐私闸与一切文件 / 配置读取,含 stdin、暂存区、[rsi] 配置
      let handle: TtyHandle | undefined;
      if (a.write) {
        handle = tty.open();
        if (handle === undefined) return usage(ctx, 'not_tty');
        const stdinIsTty = deps.stdinIsTty ?? ((): boolean => process.stdin.isTTY === true);
        if (mode === 'ingest' && stdinIsTty()) {
          tty.close(handle);
          return usage(ctx, 'stdin_is_tty');
        }
      }
      try {
        return await execute(ctx, a, mode, runId, handle);
      } catch {
        ctx.stderr(`${JUDGE_INGEST_CODES.failClosed} reason=internal\n`);
        return ExitCode.FAIL_CLOSED;
      } finally {
        if (handle !== undefined) tty.close(handle);
      }
    },
  };

  async function execute(
    ctx: CommandContext,
    a: Parsed,
    mode: 'ingest' | 'confirm_reflector',
    runId: string,
    handle: TtyHandle | undefined,
  ): Promise<number> {
    // 隐私闸:在读 stdin / 暂存区 / 拿锁之前判定(deny → 3)
    let gateCtx: RsiServiceCtx | undefined;
    const pc = await privacyCheck(ctx);
    if (isGateExit(pc)) {
      ctx.stderr(pc.stderr);
      return pc.exit;
    }
    if (pc.kind === 'enforce') gateCtx = { io: gateIoOf(ctx.io, pc.home), config: pc.config };

    let payloadText: string | undefined;
    if (mode === 'ingest') {
      try {
        const read = await resolveReadStdin(ctx)(MAX_INGEST_INPUT_BYTES);
        if (read.tooLarge) {
          return report(ctx, a.json, runId, { kind: 'rejected', reason: 'input_too_large' });
        }
        payloadText = read.text;
      } catch {
        return report(ctx, a.json, runId, { kind: 'fail_closed', reason: 'stdin_unreadable' });
      }
    }

    let redactor = deps.redactor;
    if (redactor === undefined) {
      const loaded = await loadOverlay(ctx);
      if (!loaded.ok) {
        ctx.stderr('agent-kit judge: 覆盖层读取或校验失败\n'); // 不回显覆盖层内容
        return ExitCode.USAGE;
      }
      try {
        redactor = createRedactor(
          { sensitive_words: loaded.overlay?.sensitive_words ?? [], timeout_ms: 250 },
          { internalDomains: loaded.overlay?.internal_domains ?? [] },
        );
      } catch {
        ctx.stderr('REDACT_FAIL_CLOSED reason=init\n');
        return ExitCode.FAIL_CLOSED;
      }
    }

    const forbidden = await forbiddenPaths(ctx.env, [ctx.io.repoRoot, ctx.io.stateDir]);
    const evalGate = async (): Promise<IngestExit | null> => {
      if (gateCtx === undefined) return null;
      try {
        return gateExitOf(await immediateGate(gateCtx, { kind: 'judge', runId }));
      } catch {
        return { exit: ExitCode.FAIL_CLOSED, stderr: 'RSI_FAIL_CLOSED reason=internal\n' };
      }
    };
    const loss: LockLossState = { lost: undefined };
    const sessionOf = (
      lock: RsiLockHandle | null,
      cfg: Parameters<typeof serviceCtxOf>[1],
    ): LockedSession => {
      const sctx = lock !== null ? serviceCtxOf(ctx, cfg, deps.now) : undefined;
      return {
        async enter() {
          if (lock === null || sctx === undefined) return;
          try {
            await (deps.assertNoPurge ?? assertNoPurgeInProgress)({ io: ctx.io });
          } catch (e) {
            if (e instanceof RsiFailClosedError && e.reason === 'purge_incomplete') {
              throw new IngestPurgePendingError();
            }
            throw e;
          }
          await enterWriterLock(sctx, lock, deps.serviceHooks);
        },
        async assertHeld() {
          if (lock === null) return;
          if (!(await checkHeld(lock, loss))) throw new IngestLockLostError();
        },
        gate: evalGate,
        async settle(wrote) {
          if (lock === null || sctx === undefined || loss.lost !== undefined || !wrote)
            return undefined;
          try {
            await settleStaged(sctx, lock, redactor as Pick<Redactor, 'pass2'>, deps.serviceHooks);
            return undefined;
          } catch (e) {
            if (e instanceof RsiStagingBlockedError) {
              return { exit: e.exit, stderr: `RSI_FAIL_CLOSED reason=${e.reason}\n` };
            }
            const st = stableOf(e);
            return { exit: st.exit, stderr: `${st.line}\n` };
          }
        },
      };
    };

    try {
      const outcome = await runJudgeIngest(
        {
          io: ctx.io,
          redactor,
          tty,
          ttyHandle: handle,
          now: deps.now ?? ((): Date => new Date()),
          kitVersion: deps.kitVersion ?? KIT_VERSION,
          forbidden,
          gate: evalGate,
          underLock: (fn) => withRsiWriterLock(ctx, deps, (lock, cfg) => fn(sessionOf(lock, cfg))),
          ...(deps.resolveHead !== undefined ? { resolveHead: deps.resolveHead } : {}),
          ...(deps.storeFs !== undefined ? { storeFs: deps.storeFs } : {}),
          ...(deps.hooks !== undefined ? { hooks: deps.hooks } : {}),
        },
        {
          mode,
          runId,
          write: a.write,
          replace: a.replace,
          proposalFilter: a.proposals,
          payloadText,
        },
      );
      return report(ctx, a.json, runId, outcome);
    } catch (e) {
      const locked = rsiLockFailure(e, 'JUDGE');
      if (locked !== undefined) {
        ctx.stderr(locked.line);
        return locked.exit;
      }
      ctx.stderr(`${JUDGE_INGEST_CODES.failClosed} reason=internal\n`);
      return ExitCode.FAIL_CLOSED;
    }
  }
  return def;
}

export const command: CommandDef = createJudgeIngestCommand();

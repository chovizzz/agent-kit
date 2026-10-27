/**
 * `agent-kit rsi projects --rebuild-index --write`(契约 R20-3.5.5;R20-A2 B5a 实装,方案 §4.3)。
 *
 * 为什么是独立文件:`projects.ts` 属于只读闭包;重建索引要拿锁并写索引 / counts / 快照清单,所以分发器在 argv **同时**含精确 token `--rebuild-index` 与 `--write` 时路由到这里。
 * 只带 `--rebuild-index`(干跑)仍在 `projects.ts`。参数判定与 `projects.ts` 一致(未知 → 2 `unknown_arg`;`--paths` → 2 `mode_conflict`)。
 *
 * 锁前早拒(只读):off → 4;盐缺失 / 空 → 4 `not_confirmed`;盐违规 → 3 `salt_invalid`;purge journal 在场 → 3(`purge_incomplete` / `journal_invalid`,重建会把 purge 目标 key 从会话文件重新认进索引)。
 * 锁内:`observeRsi` 复检(先于 recover)→ `recoverUnderLock` → `assertNoPurgeInProgress` → `resumeTaintWith` → `planRebuildForWrite` →
 * `verdict.write === false`(列举不完整且旧索引无效,Q-G)→ 3 `index_invalid`,stdout 附 `complete=false`;否则 **generation = max(旧索引 generation, projects_ack_generation) + 1**
 * (旧索引无效时 plan 的 generation 是 0,而 ack 可能是 40:不取 max 之后新增项目永远排不到 ack 之后)→ `writeIndexFile` → `taintNewlyExcludedWith`(**索引落盘之后**:新认出的 X 才会被 taint)→
 * `writeAllCountsUnderLock`(四段)→ `commitUnderLockWith`(trigger `rebuild`)。不碰 `baseline_pending`。
 * 三套 generation(索引 / counts / 快照清单)各自单调、互不比对;重建可以让索引 generation 跳号。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import type { RsiProjectIndex } from '../contracts/rsi.js';
import { canonicalJson } from '../io/canonical-json.js';
import { SaltError, readSaltFile } from '../signals/salt-read.js';
import { parseFlags } from './args.js';
import { failExit } from './exit.js';
import type { LockGateOptions } from './gate.js';
import { makeGate } from './l0/commit.js';
import { planRebuildForWrite } from './l0/rebuild-gate.js';
import { RebuildNoSaltError } from './l0/rebuild-plan.js';
import { buildRedactor } from './l0/run.js';
import type { BeforeWrite, L0Deps } from './l0/types.js';
import type { RsiLockDeps } from './lock.js';
import { emitLines, forbiddenPaths, jsonLines } from './output.js';
import type { OutLine } from './sanitize.js';
import { commitUnderLockWith, recoverUnderLock } from './services/commit.js';
import { hooksFromGate, readStateForWrite, writeIndexFile } from './services/fixed-write.js';
import { observeRsi } from './services/observe.js';
import { openRsiIo, piDirIsSet, type OpenRsiIoDeps } from './services/open.js';
import { writeAllCountsUnderLock } from './services/projections.js';
import {
  assertNoPurgeInProgress,
  resumeTaintWith,
  taintNewlyExcludedWith,
} from './services/taint.js';
import { flattenDoc } from './status.js';
import {
  RsiFailClosedError,
  type RsiEarlyContext,
  type RsiServiceCtx,
  type RsiSubcommand,
} from './types.js';
import { withRsiLockIfGated } from './with-lock.js';

export interface RsiRebuildDeps {
  now?: () => Date;
  open?: OpenRsiIoDeps;
  gate?: LockGateOptions;
  lock?: RsiLockDeps;
  /** L0 测试缝(`piDirSet`、`limits`、`beforeStep`、`probe`……) */
  l0?: L0Deps;
  /** 每个写点之前(故障注入 / 失锁演练) */
  beforeWrite?: BeforeWrite;
  /** 锁内、复检之前(演练「拿锁之后改配置」) */
  afterLock?: () => Promise<void> | void;
}

type Done =
  | { kind: 'refused'; reason: 'off' | 'not_confirmed' }
  | { kind: 'incomplete' }
  | { kind: 'written'; doc: Record<string, unknown> };

async function precheckSalt(sctx: RsiServiceCtx): Promise<'ok' | 'no_salt'> {
  try {
    return (await readSaltFile(sctx.io.stateDir)).kind === 'ok' ? 'ok' : 'no_salt';
  } catch (e) {
    if (e instanceof SaltError) throw new RsiFailClosedError('salt_invalid');
    throw e;
  }
}

export async function runProjectsRebuild(
  ctx: RsiEarlyContext,
  deps: RsiRebuildDeps = {},
): Promise<number> {
  const parsed = parseFlags(ctx.argv, ['--json', '--paths', '--rebuild-index', '--write']);
  if (!parsed.ok) {
    ctx.stderr('RSI_USAGE reason=unknown_arg\n');
    return ExitCode.USAGE;
  }
  const f = parsed.flags;
  if (!f.has('--rebuild-index') || !f.has('--write')) {
    ctx.stderr('RSI_USAGE reason=unknown_arg\n');
    return ExitCode.USAGE;
  }
  if (f.has('--paths')) {
    ctx.stderr('RSI_USAGE reason=mode_conflict\n');
    return ExitCode.USAGE;
  }
  const json = f.has('--json');
  try {
    const open = await openRsiIo(ctx, deps.open);
    if (open.kind === 'usage') {
      ctx.stderr(`${open.code} reason=${open.reason}\n`);
      return ExitCode.USAGE;
    }
    const notRun = (reason: string): number => {
      ctx.stderr(`RSI_NOT_RUN reason=${reason}\n`);
      return ExitCode.NOT_RUN;
    };
    if (open.kind === 'off') return notRun('off');
    const sctx: RsiServiceCtx = {
      ...open.ctx,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    };
    const { io, config } = sctx;
    // 锁前早拒(只读)
    if ((await precheckSalt(sctx)) === 'no_salt') return notRun('not_confirmed');
    await assertNoPurgeInProgress(sctx);

    const l0: L0Deps = {
      ...(deps.l0 ?? {}),
      piDirSet: deps.l0?.piDirSet ?? piDirIsSet(ctx.env),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    };
    const done = await withRsiLockIfGated(
      sctx,
      async (lock): Promise<Done> => {
        if (lock === null) throw new RsiFailClosedError('internal');
        await deps.afterLock?.();
        // 无副作用复检(先于 recover)
        const obs = await observeRsi(io, ctx.env);
        if (obs.state.state === 'off') return { kind: 'refused', reason: 'off' };
        if (obs.state.stateInvalid) throw new RsiFailClosedError('state_invalid');
        if ((await precheckSalt(sctx)) === 'no_salt')
          return { kind: 'refused', reason: 'not_confirmed' };
        const hooks = hooksFromGate(makeGate(lock, deps.beforeWrite));
        await recoverUnderLock(sctx, lock, hooks);
        await assertNoPurgeInProgress(sctx);
        await resumeTaintWith(sctx, lock, hooks);
        let planned;
        try {
          planned = await planRebuildForWrite(io, config, l0);
        } catch (e) {
          if (e instanceof RebuildNoSaltError) return { kind: 'refused', reason: 'not_confirmed' };
          if (e instanceof SaltError) throw new RsiFailClosedError('salt_invalid');
          throw e;
        }
        const { plan, oldIndexValid, verdict } = planned;
        if (!verdict.write) return { kind: 'incomplete' };
        const st = await readStateForWrite(io);
        const ack = st.prev?.projects_ack_generation ?? 0;
        const generation = Math.max(plan.index.generation, ack) + 1;
        // 旧索引有效时,plan 把新 key 的 first_indexed_generation 记成「旧 generation + 1」;最终 generation 若更大,新 key 要跟着走,否则排不到 ack 之后
        const planNext = plan.index.generation + 1;
        const index: RsiProjectIndex = {
          ...plan.index,
          generation,
          entries: plan.index.entries.map((e) =>
            oldIndexValid && e.first_indexed_generation === planNext
              ? { ...e, first_indexed_generation: generation }
              : e,
          ),
        };
        await writeIndexFile(sctx, lock, index, hooks);
        await taintNewlyExcludedWith(sctx, lock, { source: 'exclude' }, hooks);
        await writeAllCountsUnderLock(sctx, lock, await buildRedactor(config), hooks);
        await commitUnderLockWith(
          sctx,
          lock,
          {
            trigger: 'rebuild',
            log: {
              action: 'rebuilt',
              code: 'ok',
              counts: {
                entries: index.entries.length,
                kept: plan.keptFromOld,
                observed: plan.observed,
                remaining_files: plan.remainingFiles,
              },
            },
          },
          hooks,
        );
        return {
          kind: 'written',
          doc: {
            result: 'rebuilt',
            generation,
            entries: index.entries.length,
            kept_from_old: plan.keptFromOld,
            observed: plan.observed,
            unknown_sessions: plan.unknownSessions,
            remaining_files: plan.remainingFiles,
            limits_hit: plan.limitsHit,
            complete: plan.complete,
          },
        };
      },
      {
        ...(deps.gate !== undefined ? { gate: deps.gate } : {}),
        ...(deps.lock !== undefined ? { lock: deps.lock } : {}),
      },
    );
    if (done.kind === 'refused') return notRun(done.reason);
    if (done.kind === 'incomplete') {
      // Q-G:列举不完整且旧索引无效:不写;stdout 只有这一行固定文本(不含路径)
      ctx.stdout('complete=false\n');
      return failExit(ctx.stderr, new RsiFailClosedError('index_invalid'));
    }
    const lines: OutLine[] = json
      ? jsonLines(canonicalJson(done.doc))
      : flattenDoc(done.doc).map((head) => ({ head }));
    return emitLines(
      ctx,
      lines,
      await forbiddenPaths(ctx.env, [io.stateDir, io.repoRoot, config.repo]),
    );
  } catch (e) {
    return failExit(ctx.stderr, e);
  }
}

export const subcommand: RsiSubcommand = {
  name: 'projects',
  owner: 'B5',
  run: (ctx) => runProjectsRebuild(ctx),
};

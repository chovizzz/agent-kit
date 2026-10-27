/**
 * `agent-kit rsi purge (--project <绝对路径> | --excluded | --resume) [--write] [--json]`(契约 R20-3.8;R20-A2 B5c 实装,方案 §6.3)。
 *
 * 参数:三选一(0 个或多个 → 2 `mode_conflict`);`--project` 的值不是绝对路径(含缺值)→ 2 `bad_path`;其余未知 / 重复 → 2 `unknown_arg`。`--write` 要求 TTY(先于任何读,否则 2 `not_tty`),
 * 只要求 TTY、不要求输入 yes。状态 `armed` / `confirmed` / `stopped` 都允许(它完成的是用户已授权的删除);purge **不删 STOP、不写 state.json**。
 *
 * 顺序:`openRsiIo`(off → 4 `off`)→ 盐(缺失 / 空 → 4 `not_confirmed`;违规 → 3 `salt_invalid`)→ journal 预检(新 purge:已有任何 journal → 3 `purge_incomplete`,必须先 `--resume`(Q-J);
 * `--resume`:没有 → 4 `no_journal`,读不出 → 3 `purge_incomplete`)→ 干跑:不拿锁、零写入;`--write`:拿锁后**无副作用复检**(`observeRsi`:off → 4;`state.json` 不合规 → 3;journal 复检;
 * 新 purge 的「未排除」复检 → 1 `RSI_PURGE_NOT_EXCLUDED`,此时除锁文件与 `rsi/` 外零写入)→ `recoverUnderLock` → `resumeTaintWith`(journal invalid 时**跳过**:它对 invalid 先抛 `journal_invalid`)→
 * 锁内权威重算 K 与待 taint 目标 → 阶段机(见 `services/purge-engine.ts`)。
 * 命中集合 K 为空 → 0、输出全 0 计数、零写入(`done=false`)。journal 建立之后失败:报底层稳定码(`lock_lost` / `signal_store_corrupt` …),journal 保留(`status` 显示 `purge.journal=present`)。
 *
 * `--resume --write`:journal 合规(purge 或 salvage 形态)→ recover → resumeTaint → `resumePurgeUnderLock`;**invalid** → recover → `salvageInvalidJournal`(Q-A:原子替换成 salvage journal,
 * 超集 taint 全部暂存目录,不删信号;stdout 固定提示重新 `rsi purge --excluded --write`);**unreadable** → 3 `purge_incomplete`,零写入(人工修复)。
 *
 * 输出(**契约缺口,订正待并入**):`--json` 键集合固定 `{mode: "dry"|"write"|"resume", phase, keys, signals, session_rows, cursor_entries, index_entries, taint_runs, taint_promotes, done}`;
 * `phase` 是 journal 阶段名或 `null`(新 purge 干跑 / K 为空)/ `"invalid"`(干跑遇到不合规 journal)/ `"salvaged"`(salvage 完成);`done` 仅在本次调用把 purge / salvage 做完时为真。
 * 文本模式同键 `key=value` 逐行,另附固定说明行(不含路径 / key)。`--write` 的 `signals` / `session_rows` / `cursor_entries` / `index_entries` / `taint_*` 是**本次调用**实际做的数。
 * 不 import llm-exec / reflect 后端 / net / 更新启动器(R20-1.1)。
 */
import * as path from 'node:path';
import { resolveIsTty } from '../commands/types.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { canonicalJson } from '../io/canonical-json.js';
import { SaltError, readSaltFile, type SaltRead } from '../signals/salt-read.js';
import { failExit } from './exit.js';
import type { LockGateOptions } from './gate.js';
import { makeGate } from './l0/commit.js';
import type { BeforeWrite } from './l0/types.js';
import type { RsiLockDeps } from './lock.js';
import { emitLines, forbiddenPaths, jsonLines } from './output.js';
import { recoverUnderLock } from './services/commit.js';
import { hooksFromGate } from './services/fixed-write.js';
import { observeRsi } from './services/observe.js';
import { openRsiIo, type OpenRsiIoDeps } from './services/open.js';
import {
  resumePurgeUnderLock,
  runPurgeUnderLock,
  salvageInvalidJournal,
  type PurgeDeps,
  type PurgeResult,
} from './services/purge-engine.js';
import { readPurgeJournal, type PurgeJournalRead } from './services/purge-journal.js';
import {
  countPurge,
  planPurgeTargets,
  resolvePurgeKeys,
  type PurgeMode,
} from './services/purge-plan.js';
import { listStaging, RsiStagingBlockedError } from './services/staging.js';
import { resumeTaintWith } from './services/taint.js';
import type { OutLine } from './sanitize.js';
import { flattenDoc } from './status.js';
import {
  RsiFailClosedError,
  type RsiEarlyContext,
  type RsiServiceCtx,
  type RsiSubcommand,
} from './types.js';
import { withRsiLockIfGated } from './with-lock.js';

export interface RsiPurgeDeps {
  now?: () => Date;
  open?: OpenRsiIoDeps;
  gate?: LockGateOptions;
  lock?: RsiLockDeps;
  /** 每个写点之前(测试的故障注入 / 失锁演练;与 `makeGate` 同一入口,经 `assertHeld`) */
  beforeWrite?: BeforeWrite;
  /** 每个阶段结束、写 journal 之前(阶段名;测试的崩溃注入点) */
  beforePhase?: PurgeDeps['beforeWrite'];
  /** 锁内、复检之前(演练「拿锁之后改配置」) */
  afterLock?: () => Promise<void> | void;
}

/** 固定说明(R20-3.8.2):不含路径 / key */
const NOTE_OUT_OF_SCOPE = '已合进 git、发成 PR 或 git apply 到工作树的内容不在 kit 管辖范围';
const NOTE_SALVAGE = '未删除任何信号;请重新运行 rsi purge --excluded --write';

type ReportMode = 'dry' | 'write' | 'resume';

interface Report {
  mode: ReportMode;
  phase: string | null;
  keys: number;
  signals: number;
  session_rows: number;
  cursor_entries: number;
  index_entries: number;
  taint_runs: number;
  taint_promotes: number;
  done: boolean;
}

const zeroReport = (mode: ReportMode, phase: string | null = null): Report => ({
  mode,
  phase,
  keys: 0,
  signals: 0,
  session_rows: 0,
  cursor_entries: 0,
  index_entries: 0,
  taint_runs: 0,
  taint_promotes: 0,
  done: false,
});

type Parsed =
  | { ok: true; mode: PurgeMode; write: boolean; json: boolean }
  | { ok: false; reason: 'unknown_arg' | 'mode_conflict' | 'bad_path' };

function parseArgs(argv: readonly string[]): Parsed {
  const seen = new Set<string>();
  let project: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--project') {
      if (seen.has(a)) return { ok: false, reason: 'unknown_arg' };
      seen.add(a);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--') || !path.isAbsolute(v) || v.includes('\0')) {
        return { ok: false, reason: 'bad_path' };
      }
      project = v;
      i++;
    } else if (a === '--excluded' || a === '--resume' || a === '--write' || a === '--json') {
      if (seen.has(a)) return { ok: false, reason: 'unknown_arg' };
      seen.add(a);
    } else {
      return { ok: false, reason: 'unknown_arg' };
    }
  }
  const modes = ['--project', '--excluded', '--resume'].filter((m) => seen.has(m));
  if (modes.length !== 1) return { ok: false, reason: 'mode_conflict' };
  const mode: PurgeMode = seen.has('--resume')
    ? { kind: 'resume' }
    : seen.has('--excluded')
      ? { kind: 'excluded' }
      : { kind: 'project', path: project as string };
  return { ok: true, mode, write: seen.has('--write'), json: seen.has('--json') };
}

function notRun(ctx: RsiEarlyContext, reason: string): number {
  ctx.stderr(`RSI_NOT_RUN reason=${reason}\n`);
  return ExitCode.NOT_RUN;
}

const notExcluded = (ctx: RsiEarlyContext): number => {
  ctx.stderr('RSI_PURGE_NOT_EXCLUDED\n');
  return ExitCode.CHECK_FAILED;
};

async function saltState(sctx: RsiServiceCtx): Promise<SaltRead> {
  try {
    return await readSaltFile(sctx.io.stateDir);
  } catch (e) {
    if (e instanceof SaltError) throw new RsiFailClosedError('salt_invalid');
    throw e;
  }
}

async function emitReport(
  ctx: RsiEarlyContext,
  sctx: RsiServiceCtx,
  rep: Report,
  json: boolean,
  notes: readonly string[],
): Promise<number> {
  const lines: OutLine[] = json
    ? jsonLines(canonicalJson(rep))
    : [...flattenDoc(rep), ...notes].map((head) => ({ head }));
  return emitLines(
    ctx,
    lines,
    await forbiddenPaths(ctx.env, [sctx.io.stateDir, sctx.io.repoRoot, sctx.config.repo]),
  );
}

function reportOf(r: PurgeResult): Report {
  return {
    mode: 'write',
    phase: 'done',
    keys: r.keys,
    signals: r.signalsRemoved,
    session_rows: r.sessionRowsRemoved,
    cursor_entries: r.cursorRemoved,
    index_entries: r.indexRemoved,
    taint_runs: r.runsTainted,
    taint_promotes: r.promotesTainted,
    done: true,
  };
}

/** 干跑(不拿锁、零写入) */
async function dryRun(
  ctx: RsiEarlyContext,
  sctx: RsiServiceCtx,
  mode: PurgeMode,
  jr: PurgeJournalRead,
  json: boolean,
): Promise<number> {
  const { io, config } = sctx;
  if (mode.kind === 'resume') {
    if (jr.state !== 'present' && jr.state !== 'invalid') throw new RsiFailClosedError('internal');
    if (jr.state === 'invalid') {
      // 将 taint 的 = 全部暂存目录;不会删任何信号
      const rep = zeroReport('resume', 'invalid');
      rep.taint_runs = (await listStaging(io, 'run')).length;
      rep.taint_promotes = (await listStaging(io, 'promote')).length;
      return emitReport(ctx, sctx, rep, json, [NOTE_SALVAGE]);
    }
    const j = jr.journal;
    const c = j.keys.length > 0 ? await countPurge(io, j.keys) : null;
    const rep: Report = {
      ...zeroReport('resume', j.phase),
      keys: j.keys.length,
      signals: c?.signals ?? 0,
      session_rows: c?.sessionRows ?? 0,
      cursor_entries: c?.cursorEntries ?? 0,
      index_entries: c?.indexEntries ?? 0,
      taint_runs: j.taint_targets.runs.length,
      taint_promotes: j.taint_targets.promotes.length,
    };
    return emitReport(ctx, sctx, rep, json, [
      NOTE_OUT_OF_SCOPE,
      ...(j.mode === 'salvage' ? [NOTE_SALVAGE] : []),
    ]);
  }
  const r = await resolvePurgeKeys(io, config, mode);
  if (r.notExcluded) return notExcluded(ctx);
  if (r.keys.length === 0)
    return emitReport(ctx, sctx, zeroReport('dry'), json, [NOTE_OUT_OF_SCOPE]);
  const c = await countPurge(io, r.keys);
  const rep: Report = {
    ...zeroReport('dry'),
    keys: r.keys.length,
    signals: c.signals,
    session_rows: c.sessionRows,
    cursor_entries: c.cursorEntries,
    index_entries: c.indexEntries,
    taint_runs: c.runs,
    taint_promotes: c.promotes,
  };
  return emitReport(ctx, sctx, rep, json, [NOTE_OUT_OF_SCOPE]);
}

type Locked =
  | { kind: 'refused'; reason: 'off' | 'not_confirmed' | 'no_journal' }
  | { kind: 'not_excluded' }
  | { kind: 'empty' }
  | { kind: 'purged'; result: PurgeResult }
  | { kind: 'salvaged'; runs: number; promotes: number };

async function writeRun(
  ctx: RsiEarlyContext,
  deps: RsiPurgeDeps,
  sctx: RsiServiceCtx,
  mode: PurgeMode,
  json: boolean,
): Promise<number> {
  if (mode.kind !== 'resume') {
    // D2 锁前预检:未排除 / K 为空 → 零写入(不拿锁)
    const pre = await resolvePurgeKeys(sctx.io, sctx.config, mode);
    if (pre.notExcluded) return notExcluded(ctx);
    if (pre.keys.length === 0) {
      return emitReport(ctx, sctx, zeroReport('write'), json, [NOTE_OUT_OF_SCOPE]);
    }
  }
  const out = await withRsiLockIfGated(
    sctx,
    async (lock): Promise<Locked> => {
      if (lock === null) throw new RsiFailClosedError('internal');
      await deps.afterLock?.();
      // ① 无副作用复检(直读;先于 recover)
      const obs = await observeRsi(sctx.io, ctx.env);
      if (obs.config.status !== 'on' || obs.state.state === 'off') {
        return { kind: 'refused', reason: 'off' };
      }
      if (obs.state.stateInvalid) throw new RsiFailClosedError('state_invalid');
      const lctx: RsiServiceCtx = { ...sctx, config: obs.config };
      if ((await saltState(lctx)).kind !== 'ok')
        return { kind: 'refused', reason: 'not_confirmed' };
      const jr = await readPurgeJournal(lctx.io);
      const hooks = hooksFromGate(makeGate(lock, deps.beforeWrite));
      const pdeps: PurgeDeps = {
        hooks,
        ...(deps.beforePhase !== undefined ? { beforeWrite: deps.beforePhase } : {}),
      };
      if (mode.kind === 'resume') {
        if (jr.state === 'absent') return { kind: 'refused', reason: 'no_journal' };
        if (jr.state === 'unreadable') throw new RsiFailClosedError('purge_incomplete');
        if (jr.state === 'invalid') {
          // 暂存目录数超限(> 5000)先于任何写(含 recover 的清理)报 staging_too_large:先 promote 后 run,与 taint 同序
          await listStaging(lctx.io, 'promote');
          await listStaging(lctx.io, 'run');
        }
        await recoverUnderLock(lctx, lock, hooks);
        if (jr.state === 'invalid') {
          // 跳过 resumeTaint(它对 invalid 先抛 journal_invalid):salvage 自己先原子替换成合法 journal 再 taint
          const s = await salvageInvalidJournal(lctx, lock, pdeps);
          return { kind: 'salvaged', runs: s.runsTainted, promotes: s.promotesTainted };
        }
        await resumeTaintWith(lctx, lock, hooks);
        const wasSalvage = jr.journal.mode === 'salvage';
        const r = await resumePurgeUnderLock(lctx, lock, pdeps);
        return wasSalvage
          ? { kind: 'salvaged', runs: r.runsTainted, promotes: r.promotesTainted }
          : { kind: 'purged', result: r };
      }
      // 新 purge(Q-J:已有任何 journal → 必须先 --resume)
      if (jr.state !== 'absent') throw new RsiFailClosedError('purge_incomplete');
      const first = await resolvePurgeKeys(lctx.io, obs.config, mode);
      if (first.notExcluded) return { kind: 'not_excluded' };
      if (first.keys.length === 0) return { kind: 'empty' };
      await recoverUnderLock(lctx, lock, hooks);
      await resumeTaintWith(lctx, lock, hooks);
      // 锁内权威:recover / taint 之后重算 K 与待 taint 目标(journal 一旦写下,续做就只认它)
      const k = await resolvePurgeKeys(lctx.io, obs.config, mode);
      if (k.notExcluded) return { kind: 'not_excluded' };
      if (k.keys.length === 0) return { kind: 'empty' };
      const targets = await planPurgeTargets(lctx.io, k.keys);
      const result = await runPurgeUnderLock(lctx, lock, { keys: k.keys, targets }, pdeps);
      return { kind: 'purged', result };
    },
    {
      ...(deps.gate !== undefined ? { gate: deps.gate } : {}),
      ...(deps.lock !== undefined ? { lock: deps.lock } : {}),
    },
  );
  switch (out.kind) {
    case 'refused':
      return notRun(ctx, out.reason);
    case 'not_excluded':
      return notExcluded(ctx);
    case 'empty':
      return emitReport(ctx, sctx, zeroReport('write'), json, [NOTE_OUT_OF_SCOPE]);
    case 'purged': {
      const rep = reportOf(out.result);
      return emitReport(
        ctx,
        sctx,
        { ...rep, mode: mode.kind === 'resume' ? 'resume' : 'write' },
        json,
        [NOTE_OUT_OF_SCOPE],
      );
    }
    case 'salvaged': {
      const rep: Report = {
        ...zeroReport('resume', 'salvaged'),
        taint_runs: out.runs,
        taint_promotes: out.promotes,
        done: true,
      };
      return emitReport(ctx, sctx, rep, json, [NOTE_SALVAGE]);
    }
  }
}

export async function runPurge(ctx: RsiEarlyContext, deps: RsiPurgeDeps = {}): Promise<number> {
  const parsed = parseArgs(ctx.argv);
  if (!parsed.ok) {
    ctx.stderr(`RSI_USAGE reason=${parsed.reason}\n`);
    return ExitCode.USAGE;
  }
  if (parsed.write && !resolveIsTty(ctx)) {
    ctx.stderr('RSI_USAGE reason=not_tty\n');
    return ExitCode.USAGE;
  }
  try {
    const open = await openRsiIo(ctx, deps.open);
    if (open.kind === 'usage') {
      ctx.stderr(`${open.code} reason=${open.reason}\n`);
      return ExitCode.USAGE;
    }
    if (open.kind === 'off') return notRun(ctx, 'off');
    const sctx: RsiServiceCtx = {
      ...open.ctx,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    };
    if ((await saltState(sctx)).kind !== 'ok') return notRun(ctx, 'not_confirmed');
    const jr = await readPurgeJournal(sctx.io);
    if (parsed.mode.kind === 'resume') {
      if (jr.state === 'absent') return notRun(ctx, 'no_journal');
      if (jr.state === 'unreadable') throw new RsiFailClosedError('purge_incomplete');
    } else if (jr.state !== 'absent') {
      throw new RsiFailClosedError('purge_incomplete'); // Q-J
    }
    return parsed.write
      ? await writeRun(ctx, deps, sctx, parsed.mode, parsed.json)
      : await dryRun(ctx, sctx, parsed.mode, jr, parsed.json);
  } catch (e) {
    if (e instanceof RsiStagingBlockedError) {
      ctx.stderr(`RSI_FAIL_CLOSED reason=${e.reason}\n`);
      return e.exit;
    }
    return failExit(ctx.stderr, e);
  }
}

export const subcommand: RsiSubcommand = {
  name: 'purge',
  owner: 'B5',
  run: (ctx) => runPurge(ctx),
};

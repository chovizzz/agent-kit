/**
 * `agent-kit rsi dismiss <run_id>... | --all [--write] [--json]`(契约 R20-17.5–R20-17.10;A6)。
 *
 * 前台命令,默认干跑(列出将忽略的 run_id 与数量),`--write` 才写。只写 `.state/rsi/dismissed.json`:**不删、不改任何 run 目录与 promote 产物**;
 * 忽略只停止提醒与待审计数,**不释放暂存容量**(R20-17.7)。
 *
 * 状态:`off` → 退 4 `RSI_NOT_RUN reason=off`;`armed` / `confirmed` / `stopped` 均可(订正 ①);不受 `KIT_AUTO_RSI` 影响。
 * 锁与 taint(R20-17.9、订正 ②):`--write` 顶层拿 `rsi/lock` 一次(拿不到 → 4 `locked`),锁内复检、重算待审集合后写入;这是**窄记账写入**:
 * 不提交信号 / run / promote 内容,不承担 R20-4.7 的 taint 前置,也不 recover 快照、不写 counts / state / 日志(订正 ⑧);待审判定本身按当前规则过滤 X / U。
 * 扫描未知(子项过多 / 总读取超限)→ 4 `run_scan_incomplete`,零写入(干跑与 `--write`、具名与 `--all` 一致,R20-17.4a)。
 * `dismissed.json` 损坏 → 写路径退 3 `dismissed_invalid`,不覆盖、不重建(R20-17.8)。
 */
import * as path from 'node:path';
import { RunIdSchema } from '../contracts/common.js';
import { ExitCode } from '../contracts/exit-codes.js';
import { RSI_DISMISSED_MAX, type RsiDismissed } from '../contracts/rsi.js';
import { canonicalJson } from '../io/canonical-json.js';
import { attribute, type AttributionProbe } from './attribution.js';
import { failExit } from './exit.js';
import type { LockGateOptions } from './gate.js';
import type { RsiLockDeps } from './lock.js';
import {
  readDismissed,
  scanPending,
  type DismissedRead,
  type PendingScan,
  type ScanDeps,
} from './pending.js';
import { readRsiState } from './read-state.js';
import { writeAccountingFile } from './services/fixed-write.js';
import { observeRsi } from './services/observe.js';
import { openRsiIo, type OpenRsiIoDeps } from './services/open.js';
import type { ServiceHooks } from './services/staging.js';
import {
  RsiFailClosedError,
  type RsiEarlyContext,
  type RsiServiceCtx,
  type RsiSubcommand,
} from './types.js';
import { withRsiLockIfGated } from './with-lock.js';

export interface RsiDismissDeps {
  now?: () => Date;
  open?: OpenRsiIoDeps;
  gate?: LockGateOptions;
  lock?: RsiLockDeps;
  probe?: AttributionProbe;
  /** 测试缝:覆盖扫描上限(默认路径下 `dismiss_full` 不可达:已忽略条目 ⊆ 仍存在的目录 ≤ 1000,见 A6i-12) */
  scanLimits?: ScanDeps['limits'];
  /** 测试缝:每个写点(`before:` / `after:`)与锁内复检之前 */
  hooks?: ServiceHooks;
  afterLock?: () => Promise<void> | void;
}

interface Parsed {
  all: boolean;
  write: boolean;
  json: boolean;
  ids: string[];
}

type ParseOutcome =
  { ok: true; value: Parsed } | { ok: false; reason: 'unknown_arg' | 'mode_conflict' };

/** 参数解析:`--all` / `--write` / `--json` 不得重复;其余记号必须是合规且不重复的 run_id(否则 `unknown_arg`);`--all` 与具名互斥、都没有 → `mode_conflict` */
export function parseDismissArgs(argv: readonly string[]): ParseOutcome {
  const flags = new Set<string>();
  const ids: string[] = [];
  for (const a of argv) {
    if (a.startsWith('-')) {
      if (!['--all', '--write', '--json'].includes(a) || flags.has(a)) {
        return { ok: false, reason: 'unknown_arg' };
      }
      flags.add(a);
    } else {
      if (!RunIdSchema.safeParse(a).success || ids.includes(a)) {
        return { ok: false, reason: 'unknown_arg' };
      }
      ids.push(a);
    }
  }
  const all = flags.has('--all');
  if (all === ids.length > 0) return { ok: false, reason: 'mode_conflict' };
  return {
    ok: true,
    value: { all, write: flags.has('--write'), json: flags.has('--json'), ids: ids.sort() },
  };
}

type Refused = {
  kind: 'refused';
  reason: 'off' | 'run_not_pending' | 'dismiss_full' | 'run_scan_incomplete';
};
type Done = Refused | { kind: 'done'; result: 'dry' | 'dismissed' | 'unchanged'; runs: string[] };

interface Snapshot {
  scan: PendingScan;
  dismissed: DismissedRead;
}

async function pendingNow(
  sctx: RsiServiceCtx,
  probe: AttributionProbe | undefined,
  limits: ScanDeps['limits'] | undefined,
): Promise<Snapshot> {
  const data = await readRsiState(sctx.io);
  const att = await attribute({
    config: sctx.config,
    indexStatus: data.index.status,
    index: data.index.value,
    counts: data.counts,
    ...(probe !== undefined ? { probe } : {}),
  });
  const dismissed = await readDismissed(data.rsiDir);
  const scan = await scanPending(
    {
      stateDir: data.rsiDir === null ? sctx.io.stateDir : path.dirname(data.rsiDir),
      staged: data.counts?.staged ?? [],
      classify: att.classify,
      dismissed: dismissed.ids,
      notified: null,
    },
    limits === undefined ? {} : { limits },
  );
  return { scan, dismissed };
}

/** 选出本次要忽略的集合;具名里有一个不是待审即整批拒 */
function select(
  p: Parsed,
  scan: Extract<PendingScan, { known: true }>,
): string[] | 'run_not_pending' {
  const pending = scan.pending.map((r) => r.runId).sort();
  if (p.all) return pending;
  const set = new Set(pending);
  return p.ids.every((id) => set.has(id)) ? p.ids : 'run_not_pending';
}

export async function runDismiss(ctx: RsiEarlyContext, deps: RsiDismissDeps = {}): Promise<number> {
  const parsed = parseDismissArgs(ctx.argv);
  if (!parsed.ok) {
    ctx.stderr(`RSI_USAGE reason=${parsed.reason}\n`);
    return ExitCode.USAGE;
  }
  const p = parsed.value;
  try {
    const open = await openRsiIo(ctx, deps.open);
    if (open.kind === 'usage') {
      ctx.stderr(`${open.code} reason=${open.reason}\n`);
      return ExitCode.USAGE;
    }
    if (open.kind === 'off') {
      ctx.stderr('RSI_NOT_RUN reason=off\n');
      return ExitCode.NOT_RUN;
    }
    const sctx: RsiServiceCtx = {
      ...open.ctx,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    };

    let done: Done;
    if (!p.write) {
      // 干跑:不拿锁、不写
      const snap = await pendingNow(sctx, deps.probe, deps.scanLimits);
      // 干跑预告 --write 的结果:dismissed.json 损坏时 --write 必退 3,干跑同样退 3(A6i-13),不预告一个不可能执行的写入
      if (snap.dismissed.kind === 'invalid') throw new RsiFailClosedError('dismissed_invalid');
      if (!snap.scan.known) done = { kind: 'refused', reason: 'run_scan_incomplete' };
      else {
        const sel = select(p, snap.scan);
        if (sel === 'run_not_pending') done = { kind: 'refused', reason: 'run_not_pending' };
        else done = { kind: 'done', result: sel.length === 0 ? 'unchanged' : 'dry', runs: sel };
      }
    } else {
      done = await withRsiLockIfGated(
        sctx,
        async (lock): Promise<Done> => {
          if (lock === null) throw new RsiFailClosedError('internal');
          await deps.afterLock?.();
          // 无副作用复检(拿锁之后配置可能已变)
          const obs = await observeRsi(sctx.io, ctx.env);
          if (obs.state.state === 'off') return { kind: 'refused', reason: 'off' };
          if (obs.state.stateInvalid) throw new RsiFailClosedError('state_invalid');
          const snap = await pendingNow(sctx, deps.probe, deps.scanLimits);
          if (!snap.scan.known) return { kind: 'refused', reason: 'run_scan_incomplete' };
          if (snap.dismissed.kind === 'invalid') throw new RsiFailClosedError('dismissed_invalid');
          const sel = select(p, snap.scan);
          if (sel === 'run_not_pending') return { kind: 'refused', reason: 'run_not_pending' };
          if (sel.length === 0) return { kind: 'done', result: 'unchanged', runs: [] };
          const at = (deps.now ?? ((): Date => new Date()))().toISOString();
          const chosen = new Set(sel);
          // 顺带移除目录已不存在的条目;新条目与保留条目合并后按 run_id 升序
          const scan = snap.scan; // 上面已因 known:false 提前返回,此处类型已收窄为 known:true
          const kept = snap.dismissed.runs.filter(
            (r) => scan.dirNames.has(r.run_id) && !chosen.has(r.run_id),
          );
          const runs = [...kept, ...sel.map((run_id) => ({ run_id, at }))].sort((a, b) =>
            a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0,
          );
          if (runs.length > RSI_DISMISSED_MAX) return { kind: 'refused', reason: 'dismiss_full' };
          const doc: RsiDismissed = { schema_version: 1, runs };
          await writeAccountingFile(
            sctx,
            lock,
            { name: 'dismissed.json', doc },
            {
              ...(deps.hooks !== undefined ? { hooks: deps.hooks } : {}),
            },
          );
          return { kind: 'done', result: 'dismissed', runs: sel };
        },
        {
          ...(deps.gate !== undefined ? { gate: deps.gate } : {}),
          ...(deps.lock !== undefined ? { lock: deps.lock } : {}),
        },
      );
    }

    if (done.kind === 'refused') {
      ctx.stderr(`RSI_NOT_RUN reason=${done.reason}\n`);
      return ExitCode.NOT_RUN;
    }
    if (p.json) {
      ctx.stdout(
        `${canonicalJson({ result: done.result, runs: done.runs, count: done.runs.length })}\n`,
      );
    } else {
      // 人读输出只含 run_id 与数量,不含路径、提案正文
      ctx.stdout(`dismiss ${done.result} count=${done.runs.length}\n`);
      for (const id of done.runs) ctx.stdout(`run_id=${id}\n`);
    }
    return ExitCode.OK;
  } catch (e) {
    return failExit(ctx.stderr, e);
  }
}

export const subcommand: RsiSubcommand = {
  name: 'dismiss',
  owner: 'A6',
  run: (ctx) => runDismiss(ctx),
};

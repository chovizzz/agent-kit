/**
 * `agent-kit rsi status --ack`(契约 R20-3.4.3;R20-A2 B5a 实装,方案 §4.1)。
 *
 * 为什么是独立文件:`status.ts` 属于只读闭包(`test/rsi/readonly-zero-write.test.ts` 的 `READONLY_ENTRIES`),闭包里禁止出现 safe-fs / 锁 / 提交服务;
 * 分发器({@link ../commands/rsi.ts} 的 `routeRsi`)在 argv 含精确 token `--ack` 时路由到这里。参数合法性由本入口的 `parseFlags` 判。
 *
 * 顺序:`parseFlags` → TTY(stdin 与 stdout 都是 TTY,否则 2 `not_tty`)→ `openRsiIo`(off → 4)→ 拿锁 → **无副作用复检**(`observeRsi`:off → 4;`state.json` 不合规 → 3)→
 * 直读索引(缺失 → 退 0 `ack noop`,此时除锁文件与 `rsi/` 外零写入;无效 / 盐不符 → 3 `index_invalid`)→ `recoverUnderLock` → `resumeTaintWith` →
 * `projects_ack_generation = 索引 generation`(「新增项目 n」清零;经 `carryConfirm` 原样带回 confirm,**不碰 `baseline_pending`**)→ `commitUnderLockWith`(trigger `status`)。
 * `--json`(订正待并入):`{"ack":"ok","generation":n}` / `{"ack":"noop","index":"absent"}`。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import { RsiProjectIndexSchema, type RsiProjectIndex } from '../contracts/rsi.js';
import { canonicalJson } from '../io/canonical-json.js';
import { resolveIsTty } from '../commands/types.js';
import { SaltError, readSaltFile } from '../signals/salt-read.js';
import { parseFlags } from './args.js';
import { failExit } from './exit.js';
import type { LockGateOptions } from './gate.js';
import { makeGate } from './l0/commit.js';
import { carryConfirm } from './l0/state-mutate.js';
import type { BeforeWrite } from './l0/types.js';
import type { RsiLockDeps } from './lock.js';
import { readRsiFixed } from './services/attribution.js';
import { commitUnderLockWith, recoverUnderLock } from './services/commit.js';
import { hooksFromGate, readStateForWrite, writeStateFile } from './services/fixed-write.js';
import { observeRsi } from './services/observe.js';
import { openRsiIo, type OpenRsiIoDeps } from './services/open.js';
import { defaultState } from './services/tick-state.js';
import { resumeTaintWith } from './services/taint.js';
import {
  RsiFailClosedError,
  type RsiEarlyContext,
  type RsiServiceCtx,
  type RsiSubcommand,
} from './types.js';
import { withRsiLockIfGated } from './with-lock.js';

export interface RsiStatusAckDeps {
  now?: () => Date;
  open?: OpenRsiIoDeps;
  gate?: LockGateOptions;
  lock?: RsiLockDeps;
  /** 每个写点之前(测试的故障注入 / 失锁演练) */
  beforeWrite?: BeforeWrite;
  /** 锁内、复检之前(演练「拿锁之后改配置」) */
  afterLock?: () => Promise<void> | void;
}

type Done =
  { kind: 'refused'; reason: 'off' } | { kind: 'noop' } | { kind: 'acked'; generation: number };

async function readIndexForAck(sctx: RsiServiceCtx): Promise<RsiProjectIndex | null> {
  const r = await readRsiFixed(sctx.io, 'projects.json');
  if (r.kind === 'missing') return null;
  let idx: RsiProjectIndex;
  try {
    idx = RsiProjectIndexSchema.parse(JSON.parse(r.bytes.toString('utf8')));
  } catch {
    throw new RsiFailClosedError('index_invalid');
  }
  let salt;
  try {
    salt = await readSaltFile(sctx.io.stateDir);
  } catch (e) {
    if (e instanceof SaltError) throw new RsiFailClosedError('salt_invalid');
    throw e;
  }
  if (salt.kind !== 'ok' || salt.saltFp !== idx.salt_fp)
    throw new RsiFailClosedError('index_invalid');
  return idx;
}

export async function runStatusAck(
  ctx: RsiEarlyContext,
  deps: RsiStatusAckDeps = {},
): Promise<number> {
  const parsed = parseFlags(ctx.argv, ['--json', '--ack']);
  if (!parsed.ok) {
    ctx.stderr('RSI_USAGE reason=unknown_arg\n');
    return ExitCode.USAGE;
  }
  if (!resolveIsTty(ctx)) {
    ctx.stderr('RSI_USAGE reason=not_tty\n');
    return ExitCode.USAGE;
  }
  const json = parsed.flags.has('--json');
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
    const done = await withRsiLockIfGated(
      sctx,
      async (lock): Promise<Done> => {
        if (lock === null) throw new RsiFailClosedError('internal');
        await deps.afterLock?.();
        // 无副作用复检(先于 recover)
        const obs = await observeRsi(sctx.io, ctx.env);
        if (obs.state.state === 'off') return { kind: 'refused', reason: 'off' };
        if (obs.state.stateInvalid) throw new RsiFailClosedError('state_invalid');
        const idx = await readIndexForAck(sctx);
        if (idx === null) return { kind: 'noop' };
        const hooks = hooksFromGate(makeGate(lock, deps.beforeWrite));
        await recoverUnderLock(sctx, lock, hooks);
        await resumeTaintWith(sctx, lock, hooks);
        const st = await readStateForWrite(sctx.io);
        const next = carryConfirm(st.prev, {
          ...(st.prev ?? defaultState()),
          projects_ack_generation: idx.generation,
        });
        await writeStateFile(sctx, lock, next, st.rawConfirm, hooks);
        await commitUnderLockWith(
          sctx,
          lock,
          { trigger: 'status', log: { action: 'acked', code: 'ok' } },
          hooks,
        );
        return { kind: 'acked', generation: idx.generation };
      },
      {
        ...(deps.gate !== undefined ? { gate: deps.gate } : {}),
        ...(deps.lock !== undefined ? { lock: deps.lock } : {}),
      },
    );
    if (done.kind === 'refused') {
      ctx.stderr('RSI_NOT_RUN reason=off\n');
      return ExitCode.NOT_RUN;
    }
    if (done.kind === 'noop') {
      ctx.stdout(
        json ? `${canonicalJson({ ack: 'noop', index: 'absent' })}\n` : 'ack noop index=absent\n',
      );
    } else {
      ctx.stdout(
        json
          ? `${canonicalJson({ ack: 'ok', generation: done.generation })}\n`
          : `ack generation=${done.generation}\n`,
      );
    }
    return ExitCode.OK;
  } catch (e) {
    return failExit(ctx.stderr, e);
  }
}

export const subcommand: RsiSubcommand = {
  name: 'status',
  owner: 'B5',
  run: (ctx) => runStatusAck(ctx),
};

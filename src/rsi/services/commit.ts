/**
 * 持锁提交 / 快照服务(契约 R20-5.6、R20-4.5、R20-6.9;v2 §3;R20-A2 B3c)。所有 `counts.json` 写入方(reflect / judge / taint / purge / tick …)共用。
 *
 * 提交顺序(R20-6.9,由调用方与本服务共同固定):信号库 / 会话计数 / 索引 → {@link writeCountsProjection}(counts.json)→ state.json → cursor.json →
 * {@link commitUnderLock}(日志 + 快照清单,**最后一步**)。`commitUnderLock` 不写 counts / state / cursor,只追加日志并重算清单;它之后不得再写任何受清单管辖的文件。
 *
 * 锁内顺序(`types.ts` 头注释):`recoverUnderLock`(inspect → recover)→ `resumeTaint` → 即时闸 → 业务 → `writeCountsProjection` → … → `commitUnderLock`。
 * 每个写点:`hook(before)` → `lock.assertHeld()` → 单次写 → `hook(after)`(钩子只给测试);句柄必须属于 `ctx.io` 的 rsi 状态目录。
 *
 * 失败一律抛(`RsiLockError('lock_lost')` / `RsiSnapshotError` / `RsiFailClosedError`),不返回部分完成。已知残余:
 *  - 日志先于清单:崩在二者之间,重跑会多一行日志(不丢提交记录);
 *  - 只覆盖进程崩溃,不含断电的 fsync 屏障;`assertHeld` 是检测不是 fencing;
 *  - `RsiLockHandle` 是结构类型,伪造对象能过类型检查,安全边界是运行时的 `assertHeld()` 与「锁路径 = `<rsiDir>/lock`」核对。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  RSI_COUNTS_MAX_STAGED,
  RsiCountsSchema,
  RsiLogLineSchema,
  type RsiCounts,
} from '../../contracts/rsi.js';
import { canonicalJson, canonicalJsonLine } from '../../io/canonical-json.js';
import type { IoContext } from '../../io/paths.js';
import { readFileSafe } from '../../io/read-fs.js';
import { appendFile, createExclusive, remove, rename } from '../../io/safe-fs.js';
import { SALT_RE } from '../../signals/ids.js';
import type { RsiLockHandle } from '../lock.js';
import {
  inspectSnapshot,
  recoverSnapshot,
  commitSnapshot,
  type RecoverOutcome,
} from '../snapshot.js';
import { productionSnapshotValidator } from '../validators.js';
import {
  RsiFailClosedError,
  type CountsProjectionInput,
  type RsiCommitPlan,
  type RsiCommitResult,
  type RsiServiceCtx,
} from '../types.js';
import { readRsiFixed } from './attribution.js';
import { assertLockBelongs } from './lock-scope.js';
import { Writer, type ServiceHooks } from './staging.js';

/** 与 reflect 干跑聚类门槛 `DEFAULT_MIN_RETRY_SESSIONS` 同值(测试钉住相等;这里不 import reflect,免得拖进 rsi 入口的 import 闭包) */
export const RSI_CLUSTER_MIN_DEFAULT = 2;

const nowOf = (ctx: RsiServiceCtx): Date => (ctx.now ?? ((): Date => new Date()))();

/** 盐文件的指纹(`sha256(盐)` 前 12 位,R20-4.2)。缺失 / 链接 / 权限宽 / 格式非法一律 `salt_invalid`,不回退到旧 counts 的值 */
async function saltFpOf(io: IoContext): Promise<string> {
  const r = await readFileSafe(path.join(io.stateDir, 'salt'), {
    maxBytes: 256,
    owner: { maxPerm: 0o600 },
  });
  if (r.kind !== 'ok') throw new RsiFailClosedError('salt_invalid');
  const salt = r.bytes.toString('utf8').trim();
  if (!SALT_RE.test(salt)) throw new RsiFailClosedError('salt_invalid');
  return createHash('sha256').update(salt).digest('hex').slice(0, 12);
}

/**
 * 所有 `counts.json` 写入方共用的投影写入(R20-4.5、R20-6.9 第 4 位:在索引之后、state / cursor 之前)。目标值语义,见 `CountsProjectionInput`:
 * 给了哪一段(含空数组 / 空对象 / 0)就整段替换,没给(`undefined`)的段保留磁盘现值;`generation`(旧 + 1,首次 1)/ `computed_at` / `salt_fp` / `cluster_min` 由服务填。
 * 重复提交同一份输入不会重复累加(业务投影相同);`generation` 与 `computed_at` 随每次写入推进,不承诺字节级幂等。
 * 前置:盐必须在且合规(`salt_invalid`);现有 `counts.json` 不合规 → `counts_invalid`;现有 counts 的 `salt_fp` 与盐不符时,只有四段全部给出(全量重算)才允许覆盖,否则 `counts_invalid`;
 * 合成结果 `staged` 超 5000 → `staging_too_large`,重复 `run_id` / 其它 schema 不过 → `counts_invalid`。`cluster_min`:保留现值,首次建立取 reflect 干跑门槛常量(`RSI_CLUSTER_MIN_DEFAULT`)。
 * 只写 `counts.json`(临时文件 + rename),不更新快照清单(由随后的 `commitUnderLock` 一次覆盖)。
 */
export async function writeCountsProjection(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  input: CountsProjectionInput,
): Promise<void> {
  return writeCountsProjectionWith(ctx, lock, input);
}

export async function writeCountsProjectionWith(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  input: CountsProjectionInput,
  hooks: ServiceHooks = {},
): Promise<void> {
  const dir = await assertLockBelongs(ctx, lock);
  const prevRead = await readRsiFixed(ctx.io, 'counts.json');
  let prev: RsiCounts | undefined;
  if (prevRead.kind === 'ok') {
    try {
      prev = RsiCountsSchema.parse(JSON.parse(prevRead.bytes.toString('utf8')));
    } catch {
      throw new RsiFailClosedError('counts_invalid');
    }
  }
  const saltFp = await saltFpOf(ctx.io);
  const full =
    input.staged !== undefined &&
    input.clusters !== undefined &&
    input.perKey !== undefined &&
    input.unknownKeysSignals !== undefined;
  if (prev !== undefined && prev.salt_fp !== saltFp && !full) {
    throw new RsiFailClosedError('counts_invalid');
  }
  const staged = input.staged !== undefined ? [...input.staged] : (prev?.staged ?? []);
  if (staged.length > RSI_COUNTS_MAX_STAGED) throw new RsiFailClosedError('staging_too_large');
  if (new Set(staged.map((s) => s.run_id)).size !== staged.length) {
    throw new RsiFailClosedError('counts_invalid');
  }
  const candidate = {
    schema_version: 1,
    salt_fp: saltFp,
    generation: (prev?.generation ?? 0) + 1,
    computed_at: nowOf(ctx).toISOString(),
    cluster_min: prev?.cluster_min ?? RSI_CLUSTER_MIN_DEFAULT,
    per_key: input.perKey ?? prev?.per_key ?? {},
    clusters: input.clusters ?? prev?.clusters ?? [],
    staged,
    unknown_keys_signals: input.unknownKeysSignals ?? prev?.unknown_keys_signals ?? 0,
  };
  const parsed = RsiCountsSchema.safeParse(candidate);
  if (!parsed.success) throw new RsiFailClosedError('counts_invalid');
  const body = canonicalJson(parsed.data);
  const dest = path.join(dir, 'counts.json');
  const tmp = `${dest}.tmp`;
  const w = new Writer(ctx.io, lock, hooks);
  await w.op('tmp-remove:counts.json', () => remove(ctx.io, tmp)); // 上次崩溃留下的临时文件
  await w.op('tmp-write:counts.json', () => createExclusive(ctx.io, tmp, body, 0o600));
  await w.op('rename:counts.json', () => rename(ctx.io, tmp, dest)); // rename 是提交点
}

/**
 * 锁内第一步(契约 R20-5.6、v2 §3):无副作用复检(`inspectSnapshot`,坏数据在写任何东西之前就抛)→ `recoverSnapshot`(未完成提交按当前文件重建清单)。
 * 一律用 `productionSnapshotValidator`。deny / refuse 路径在更前面就已退出,不会走到这里。
 */
export async function recoverUnderLock(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  hooks: ServiceHooks = {},
): Promise<RecoverOutcome> {
  await assertLockBelongs(ctx, lock);
  await inspectSnapshot(ctx.io, productionSnapshotValidator);
  await hooks.point?.('before:recover');
  return recoverSnapshot(ctx.io, lock, productionSnapshotValidator, {
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
  });
}

/**
 * 提交义务:**锁句柄是必填的第二个位置参数**,不传 / 传 `null` 编译不过(`test/rsi/services.test.ts` 用 `@ts-expect-error` 固定)。
 * ①`assertHeld()` 与句柄归属核对先于一切磁盘访问;②无副作用复验当前全部数据(`inspectSnapshot`):坏数据不得被清单背书(`needs_rebuild` / `absent` / `consistent` 都放行);
 * ③追加日志(若给 `plan.log`)→ ④`commitSnapshot`(最后一步,内部 `assertHeld` 紧接 rename)。counts / state / cursor 由调用方先写。失败一律抛。
 */
export async function commitUnderLock(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  plan: RsiCommitPlan,
): Promise<RsiCommitResult> {
  return commitUnderLockWith(ctx, lock, plan);
}

export async function commitUnderLockWith(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  plan: RsiCommitPlan,
  hooks: ServiceHooks = {},
): Promise<RsiCommitResult> {
  const dir = await assertLockBelongs(ctx, lock);
  await inspectSnapshot(ctx.io, productionSnapshotValidator);
  const now = nowOf(ctx);
  if (plan.log !== undefined) {
    const fields = Object.fromEntries(Object.entries(plan.log).filter(([, v]) => v !== undefined));
    const line = canonicalJsonLine(
      RsiLogLineSchema.parse({ at: now.toISOString(), trigger: plan.trigger, ...fields }),
    );
    const w = new Writer(ctx.io, lock, hooks);
    await w.op('log-append', () =>
      appendFile(ctx.io, path.join(dir, 'log.jsonl'), line, { mode: 0o600 }),
    );
  }
  const snap = await commitSnapshot(ctx.io, lock, {
    now: () => now,
    beforeRename: () => hooks.point?.('before:snapshot-rename'),
  });
  await hooks.point?.('after:snapshot-rename');
  return { kind: 'committed', generation: snap.generation };
}

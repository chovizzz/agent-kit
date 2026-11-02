/**
 * digest 槽位与槽位锁(docs/contracts.md R20-16.10 / R20-16.12 / R20-16.13 / R20-16.15 第 3、5 步;R20-A4)。
 *
 * 存活上限 = 20 个固定槽位 `s00.json` … `s19.json`(`.state/rsi/digests/` 下只有这些合法文件名;写临时文件 `.tmp-<token>` 只在持锁期间存在)。
 * 同一槽位的全部生命周期操作(预留 / 发布 / 放弃 / 清理 / `--revoke` / ingest 读取与消费)**只在持有槽位锁 `digests/lock` 时进行**——本文件所有变更函数
 * 都**必须接收锁句柄**,每个写出口(建临时文件、rename、unlink)之前先 `assertHeld()`(token / 哈希复读不能代替失锁复核),rename / unlink 之后 fsync 目录。
 * 持锁期间只做目录列举、`readFileSafe` 读、写临时文件、rename、unlink、fsync,**不做聚类 / 复扫等计算**(毫秒级)。
 * 锁用 A1 锁库(`acquireRsiLock(io, deps, { sub: 'digests' })`,同一套 nonce / TTL / 回收 / `isAlive`);锁序 `rsi/lock` → `digests/lock`:持槽位锁时再取 `rsi/lock` 在 `lock.ts` 里抛 `internal`。
 * 保证强度如实继承 A1(陈旧锁回收的双持有窗口,契约 R20-16.10):后果限于某个 digest / 预留被误删或覆盖、一次 `--revoke` 或清理未生效;
 * 隐私闸(授权指纹、归属复核、严格批次、复扫、最终复核)不依赖本文件的严格互斥。
 */
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import {
  RSI_DIGEST_FILE_MAX_BYTES,
  RSI_DIGEST_LOCK_POLL_MS,
  RSI_DIGEST_LOCK_WAIT_MS,
  RSI_DIGEST_RESERVE_TTL_MS,
  RSI_DIGEST_SLOT_COUNT,
  RSI_DIGEST_SLOT_NAME_RE,
  RSI_FILE_MODE,
  RsiDigestRecordSchema,
  RsiDigestReservationSchema,
  slotName,
  type RsiDigestRecord,
} from '../contracts/rsi.js';
import { canonicalJson } from '../io/canonical-json.js';
import type { IoContext } from '../io/paths.js';
import { lstat, readDir, readFileSafe } from '../io/read-fs.js';
import { createExclusiveSynced, fsyncDir, remove, rename } from '../io/safe-fs.js';
import { RsiLockError } from './lock-error.js';
import { RSI_FILE_OWNER, rsiDirReadonly } from './lock-read.js';
import { acquireRsiLock, type RsiLockDeps, type RsiLockHandle } from './lock.js';
import { digestsDir } from './rsi-dir.js';

/** 测试缝:每个写出口之前调用(`reserve:create`、`publish:tmp`、`publish:rename`、`unlink:<slot>` …);抛错 = 在该点崩溃 */
export interface SlotHooks {
  point?(name: string): Promise<void> | void;
}

export interface SlotDeps {
  lock?: RsiLockDeps;
  hooks?: SlotHooks;
  /** 墙钟毫秒(取锁等待用);缺省 `Date.now` */
  clockMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  randomHex?: (bytes: number) => string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const defaultRandom = (n: number): string => randomBytes(n).toString('hex');

/**
 * 取槽位锁:最多等 2 秒(每 50ms 试一次,R20-16.10),仍拿不到 → 抛 `RsiLockError('locked')`(`--revoke` 同样)。
 * 只有「占用」(`locked` / `locked_over_ttl`)才重试;路径不安全 / 写拒绝等直接上抛。
 */
export async function acquireDigestsLock(
  io: IoContext,
  deps: SlotDeps = {},
): Promise<RsiLockHandle> {
  const clock = deps.clockMs ?? ((): number => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = clock() + RSI_DIGEST_LOCK_WAIT_MS;
  for (;;) {
    try {
      return await acquireRsiLock(io, deps.lock ?? {}, { sub: 'digests' });
    } catch (e) {
      const busy =
        e instanceof RsiLockError && (e.kind === 'locked' || e.kind === 'locked_over_ttl');
      if (!busy) throw e;
      if (clock() + RSI_DIGEST_LOCK_POLL_MS > deadline) throw new RsiLockError('locked');
      await sleep(RSI_DIGEST_LOCK_POLL_MS);
    }
  }
}

/** 持槽位锁执行 `fn`,一定释放。`fn` 内**不得**取 `rsi/lock`(锁序) */
export async function withDigestsLock<T>(
  io: IoContext,
  fn: (lock: RsiLockHandle) => Promise<T>,
  deps: SlotDeps = {},
): Promise<T> {
  const lock = await acquireDigestsLock(io, deps);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}

export type SlotContent =
  | { kind: 'empty' }
  | { kind: 'reserved'; reserved: string; at: string }
  /** `sha256` = 槽位文件原始字节的哈希(ingest 第 3 步与第 5 步比对用) */
  | { kind: 'digest'; record: RsiDigestRecord; sha256: string }
  /** 读不过(链接 / FIFO / 硬链接 / 超大 / 属主权限不对 / 不是合法内容):视为无效,不跟随、不挂住;清理时跳过不删 */
  | { kind: 'invalid' };

const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function dirOf(io: IoContext): Promise<string> {
  return digestsDir(io);
}

/** 读一个槽位(`readFileSafe`:`O_NOFOLLOW|O_NONBLOCK`、句柄 fstat、普通文件、`nlink == 1`、属主当前 uid、mode ≤ 0600、解析前 64KiB 上限) */
export async function readSlot(dir: string, n: number): Promise<SlotContent> {
  const r = await readFileSafe(path.join(dir, slotName(n)), {
    maxBytes: RSI_DIGEST_FILE_MAX_BYTES,
    owner: RSI_FILE_OWNER,
  });
  if (r.kind === 'missing') return { kind: 'empty' };
  if (r.kind === 'unsafe') return { kind: 'invalid' };
  let raw: unknown;
  try {
    raw = JSON.parse(r.bytes.toString('utf8'));
  } catch {
    return { kind: 'invalid' };
  }
  if (typeof raw === 'object' && raw !== null && 'reserved' in raw) {
    const p = RsiDigestReservationSchema.safeParse(raw);
    return p.success
      ? { kind: 'reserved', reserved: p.data.reserved, at: p.data.at }
      : { kind: 'invalid' };
  }
  const p = RsiDigestRecordSchema.safeParse(raw);
  return p.success
    ? { kind: 'digest', record: p.data, sha256: sha256Hex(r.bytes) }
    : { kind: 'invalid' };
}

/** 写点闸:钩子 → `assertHeld()`(每个写出口之前) */
async function gate(lock: RsiLockHandle, deps: SlotDeps, name: string): Promise<void> {
  await deps.hooks?.point?.(name);
  await lock.assertHeld();
}

async function unlinkSlot(
  io: IoContext,
  dir: string,
  lock: RsiLockHandle,
  deps: SlotDeps,
  n: number,
): Promise<void> {
  await gate(lock, deps, `unlink:${slotName(n)}`);
  await remove(io, path.join(dir, slotName(n)));
}

/** 清理残留的 `.tmp-*`(只有持锁方会建它们,所以持锁时见到的都是崩溃遗留)与槽位目录里不合法的文件名不碰 */
async function removeStaleTmp(
  io: IoContext,
  dir: string,
  lock: RsiLockHandle,
  deps: SlotDeps,
): Promise<boolean> {
  let removed = false;
  for (const e of await readDir(dir)) {
    if (!e.name.startsWith('.tmp-')) continue;
    await gate(lock, deps, `unlink:${e.name}`);
    await remove(io, path.join(dir, e.name));
    removed = true;
  }
  return removed;
}

/**
 * R20-16.10 ① 的清理:删内容已过期(`expires_at ≤ now`)的 digest、删「预留超过 10 分钟仍未发布」的预留。读不过的槽位**跳过不删**。
 * 返回被删的槽位数。
 */
export async function cleanupSlots(
  io: IoContext,
  lock: RsiLockHandle,
  now: Date,
  deps: SlotDeps = {},
): Promise<number> {
  const dir = await dirOf(io);
  let n = 0;
  let touched = await removeStaleTmp(io, dir, lock, deps);
  for (let i = 0; i < RSI_DIGEST_SLOT_COUNT; i++) {
    const c = await readSlot(dir, i);
    const expired =
      (c.kind === 'digest' && Date.parse(c.record.expires_at) <= now.getTime()) ||
      (c.kind === 'reserved' && now.getTime() - Date.parse(c.at) > RSI_DIGEST_RESERVE_TTL_MS);
    if (!expired) continue;
    await unlinkSlot(io, dir, lock, deps, i);
    n++;
    touched = true;
  }
  if (touched) await fsyncDir(io, dir);
  return n;
}

export interface Reservation {
  slot: number;
  token: string;
}

/**
 * R20-16.10 ① 预留(持锁):先清理,再取序号最小的空位**独占创建**预留文件 `{reserved: <token>, at}`(token = 16 位随机十六进制)。无空位 → `null`
 * (调用方退出 4 `RSI_NOT_RUN reason=digest_backlog`)。读不过的槽位算占用。
 */
export async function reserveSlot(
  io: IoContext,
  lock: RsiLockHandle,
  now: Date,
  deps: SlotDeps = {},
): Promise<Reservation | null> {
  await cleanupSlots(io, lock, now, deps);
  const dir = await dirOf(io);
  const token = (deps.randomHex ?? defaultRandom)(8);
  const body = canonicalJson({ reserved: token, at: now.toISOString() });
  for (let i = 0; i < RSI_DIGEST_SLOT_COUNT; i++) {
    await gate(lock, deps, `reserve:create:${slotName(i)}`);
    try {
      await createExclusiveSynced(io, path.join(dir, slotName(i)), body, RSI_FILE_MODE);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    await fsyncDir(io, dir);
    return { slot: i, token };
  }
  return null;
}

/**
 * R20-16.10 ③ 发布(持锁):本槽位内容必须**仍是本进程的预留 token**(否则已被回收 → `lost`,不碰该槽位);是 → 临时文件写完 → fsync → rename 覆盖本槽位 → fsync 目录。
 */
export async function publishSlot(
  io: IoContext,
  lock: RsiLockHandle,
  r: Reservation,
  record: RsiDigestRecord,
  deps: SlotDeps = {},
): Promise<'published' | 'lost'> {
  const dir = await dirOf(io);
  const cur = await readSlot(dir, r.slot);
  if (cur.kind !== 'reserved' || cur.reserved !== r.token) return 'lost';
  const tmp = path.join(dir, `.tmp-${r.token}`);
  await gate(lock, deps, 'publish:tmp');
  await createExclusiveSynced(io, tmp, canonicalJson(record), RSI_FILE_MODE);
  try {
    await gate(lock, deps, 'publish:rename');
    await rename(io, tmp, path.join(dir, slotName(r.slot)));
  } catch (e) {
    // 异常清理也是写出口:先复核仍持锁;已失锁则保留临时文件(留给后继持锁者清理),并保持原始错误
    try {
      await lock.assertHeld();
      await remove(io, tmp);
    } catch {
      // 尽力
    }
    throw e;
  }
  await fsyncDir(io, dir);
  return 'published';
}

/** R20-16.10 ④ 放弃(持锁):只在本槽位内容仍是本进程 token 时删除 */
export async function abandonSlot(
  io: IoContext,
  lock: RsiLockHandle,
  r: Reservation,
  deps: SlotDeps = {},
): Promise<boolean> {
  const dir = await dirOf(io);
  const cur = await readSlot(dir, r.slot);
  if (cur.kind !== 'reserved' || cur.reserved !== r.token) return false;
  await unlinkSlot(io, dir, lock, deps, r.slot);
  await fsyncDir(io, dir);
  return true;
}

/** R20-16.12 ① `--revoke`:持槽位锁删除全部槽位文件(含预留与读不过的);返回删除个数 */
export async function revokeAllSlots(
  io: IoContext,
  lock: RsiLockHandle,
  deps: SlotDeps = {},
): Promise<number> {
  const dir = await dirOf(io);
  let n = 0;
  for (const e of await readDir(dir)) {
    const slot = RSI_DIGEST_SLOT_NAME_RE.test(e.name);
    if (!slot && !e.name.startsWith('.tmp-')) continue;
    await gate(lock, deps, `unlink:${e.name}`);
    await remove(io, path.join(dir, e.name));
    if (slot) n++;
  }
  if (n > 0) await fsyncDir(io, dir);
  return n;
}

export interface FoundDigest {
  slot: number;
  record: RsiDigestRecord;
  sha256: string;
}

/** R20-16.13:按 `digest_id` 逐个读 20 个槽位查找(路径由内部构造,不接受外部路径);预留文件不参与匹配;读不过的槽位视为无效(不匹配) */
export async function findDigest(
  io: IoContext,
  _lock: RsiLockHandle,
  digestId: string,
): Promise<FoundDigest | null> {
  const dir = await dirOf(io);
  for (let i = 0; i < RSI_DIGEST_SLOT_COUNT; i++) {
    const c = await readSlot(dir, i);
    if (c.kind === 'digest' && c.record.digest_id === digestId) {
      return { slot: i, record: c.record, sha256: c.sha256 };
    }
  }
  return null;
}

/**
 * 删除一份已发布的 digest(持锁):重读本槽位,`digest_id` 与 sha256 必须仍与 `expect` 一致才删(否则 `gone`:已被撤销 / 清理 / 复用,不碰该槽位),
 * 一致 → `assertHeld()` → unlink → fsync 目录。ingest 第 5 步「消费」与第 3 步「删除过期 / 策略变化的 digest」共用。
 */
export async function removeDigestIfSame(
  io: IoContext,
  lock: RsiLockHandle,
  expect: FoundDigest,
  deps: SlotDeps = {},
): Promise<'removed' | 'gone'> {
  const dir = await dirOf(io);
  const cur = await readSlot(dir, expect.slot);
  if (
    cur.kind !== 'digest' ||
    cur.record.digest_id !== expect.record.digest_id ||
    cur.sha256 !== expect.sha256
  ) {
    return 'gone';
  }
  await unlinkSlot(io, dir, lock, deps, expect.slot);
  await fsyncDir(io, dir);
  return 'removed';
}

/**
 * R20-16.12 ② 观察性作废(尽力):**只试一次**取槽位锁(取不到就跳过,不改变调用方的结果、不等待),持锁时删除 `pred` 命中的**已发布** digest(预留不算)。
 * 任何错误都吞掉(本来就是尽力)。返回删除个数。**不得在持有 `rsi/lock` 之后再调用以外的方式取 `rsi/lock`**:本函数只取槽位锁,符合锁序。
 */
export async function invalidateDigests(
  io: IoContext,
  pred: (r: RsiDigestRecord) => boolean,
  deps: SlotDeps = {},
): Promise<number> {
  let lock: RsiLockHandle | undefined;
  try {
    // 没有 digests/ 目录 = 没有任何 digest:不建目录、不取锁(worker 的每次运行都会走到这里,不得因此多出写入)
    const ro = await rsiDirReadonly(io);
    if (ro.kind !== 'ok') return 0;
    try {
      await lstat(path.join(ro.dir, 'digests'));
    } catch {
      return 0;
    }
    lock = await acquireRsiLock(io, deps.lock ?? {}, { sub: 'digests' });
    const dir = await dirOf(io);
    let n = 0;
    for (let i = 0; i < RSI_DIGEST_SLOT_COUNT; i++) {
      const c = await readSlot(dir, i);
      if (c.kind !== 'digest' || !pred(c.record)) continue;
      await unlinkSlot(io, dir, lock, deps, i);
      n++;
    }
    if (n > 0) await fsyncDir(io, dir);
    return n;
  } catch {
    return 0;
  } finally {
    await lock?.release().catch(() => undefined);
  }
}

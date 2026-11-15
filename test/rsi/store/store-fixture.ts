/**
 * B1a 存储核测试夹具:内存 `StoreFs` 假件(与真实现同一份契约:不存在 = missing,不安全 = unsafe,写失败 = 抛错)、故障注入包装(ENOSPC / EACCES / rename 失败 / 部分写 / fsync 失败)、
 * 假锁(`assertHeld` 丢锁 = `RsiLockError('lock_lost')`)、世界构造(`real` = 真 `safeStoreFs` + 临时目录;`mem` = 内存)。**不调用被测的合并 / 规划函数**:期望值由测试自己手写。
 */
import * as path from 'node:path';
import type { RsiAuditLine } from '../../../src/contracts/rsi-personal.js';
import {
  RSI_AUDIT_COMPACTION_FILE,
  RSI_AUDIT_FILE,
  RSI_EFFECTS_FILE,
} from '../../../src/contracts/rsi-store.js';
import { canonicalJsonLine } from '../../../src/io/canonical-json.js';
import { createIoContext, type IoContext } from '../../../src/io/paths.js';
import { readDir } from '../../../src/io/read-fs.js';
import { RsiLockError } from '../../../src/rsi/lock-error.js';
import { createBackend, type StoreBackend } from '../../../src/rsi/store/backend.js';
import { safeStoreFs, type StoreFileRead, type StoreFs } from '../../../src/rsi/store/fs-port.js';
import type { ApplyOnceMeta, LockCap } from '../../../src/rsi/store/ports.js';
import { assembleRsiStore, type RsiStore } from '../../../src/rsi/store/store.js';
import type { TransitionEffect } from '../../../src/rsi/personal/transition.js';
import { rsiDir } from '../../../src/rsi/rsi-dir.js';
import { baseCtx, makeTempDir, REPO_ROOT } from '../../helpers/tmp.js';

export const ID = 'ra_0123456789ab';
export const ID2 = 'ra_ba9876543210';
export const SHA = 'a'.repeat(64);
export const SHA2 = 'b'.repeat(64);
export const FP = '0123456789abcdef';
/** 假时钟的「今天」 */
export const TODAY_ISO = '2026-11-15T12:00:00.000Z';
export const AT1 = '2026-11-15T08:00:00.000Z';
export const AT_OLD = '2026-10-01T08:00:00.000Z';

export const hex16 = (n: number): string => n.toString(16).padStart(16, '0');

// ---------- 效果 / 元信息 / 审计行构造 ----------
export const veto = (id = ID, sha = SHA): TransitionEffect => ({
  type: 'blacklist_veto',
  id,
  content_sha256: sha,
});
export const tomb = (id = ID, terminal = 'rejected', reason = 'vetoed'): TransitionEffect => ({
  type: 'write_tombstone',
  id,
  terminal,
  reason,
});
export const cool = (
  cluster = 'cl-1',
  kind: 'auto_rollback' | 'expired' = 'auto_rollback',
  days = 90,
): TransitionEffect => ({ type: 'start_cooldown', cluster_id: cluster, kind, days });
export const meta = (
  at = AT1,
  extra: Partial<ApplyOnceMeta> = {},
): ApplyOnceMeta & { fp_hmac: string } =>
  ({ event_at: at, fp_hmac: FP, ...extra }) as ApplyOnceMeta & { fp_hmac: string };
export const trow = (idem: string, at = AT1, over: Partial<RsiAuditLine> = {}): RsiAuditLine => ({
  at,
  kind: 'transition',
  id: ID,
  dim: 'lifecycle',
  from: 'proposed',
  to: 'shadow',
  reason: 'gates_passed',
  idem_key: idem,
  ...over,
});
/** 终态空操作观察行(R5):`from === to` 且在终态 */
export const noopRow = (idem: string, at = AT1): RsiAuditLine =>
  trow(idem, at, { from: 'rejected', to: 'rejected', reason: 'noop:vetoed' });
export const obsRow = (at = AT1): RsiAuditLine => ({
  at,
  kind: 'evaluation',
  id: ID,
  counts: { hits: 1 },
});
export const auditEffect = (row: RsiAuditLine): TransitionEffect => ({
  type: 'append_audit',
  line: row,
  ...(row.idem_key !== undefined ? { idem_key: row.idem_key } : {}),
});
export const markEffect = (idem: string, at = AT1): TransitionEffect => ({
  type: 'protection_mark',
  idem_key: idem,
  line: {
    at,
    kind: 'reconcile',
    id: ID,
    reason: 'protection_unknown',
  },
});

// ---------- 错误 ----------
export const errno = (code: string): Error => Object.assign(new Error(code), { code });

// ---------- 假锁 ----------
export class FakeLock implements LockCap {
  held = true;
  releases = 0;
  asserts = 0;
  constructor(
    readonly name: string,
    private readonly log: string[],
  ) {}
  async assertHeld(): Promise<void> {
    this.asserts++;
    if (!this.held) throw new RsiLockError('lock_lost');
  }
  async release(): Promise<void> {
    this.log.push(`release:${this.name}`);
    this.held = false;
    this.releases++;
  }
}

// ---------- 内存 StoreFs ----------
export class MemFs implements StoreFs {
  files = new Map<string, Buffer>();
  tmps = new Map<string, Buffer>();
  unsafe = new Set<string>();
  async read(name: string, maxBytes: number): Promise<StoreFileRead> {
    if (this.unsafe.has(name)) return { kind: 'unsafe', why: 'link' };
    const b = this.files.get(name);
    if (b === undefined) return { kind: 'missing' };
    if (b.length > maxBytes) return { kind: 'unsafe', why: 'too_large' };
    return { kind: 'ok', bytes: Buffer.from(b) };
  }
  async writeTmp(name: string, text: string): Promise<void> {
    this.tmps.set(name, Buffer.from(text, 'utf8'));
  }
  async commitTmp(name: string): Promise<void> {
    const t = this.tmps.get(name);
    if (t === undefined) throw errno('ENOENT');
    this.files.set(name, t);
    this.tmps.delete(name);
  }
  async removeTmp(name: string): Promise<void> {
    this.tmps.delete(name);
  }
  async appendSynced(name: string, text: string): Promise<void> {
    this.files.set(
      name,
      Buffer.concat([this.files.get(name) ?? Buffer.alloc(0), Buffer.from(text, 'utf8')]),
    );
  }
}

// ---------- 故障注入 ----------
export type FsOp = 'read' | 'writeTmp' | 'commitTmp' | 'removeTmp' | 'appendSynced';
export interface Fault {
  op: FsOp;
  /** 缺省 = 任意文件名 */
  name?: string;
  code: string;
  /**
   * `before`(缺省)= 未做任何事就抛;`partial` = `appendSynced` 先写一半字节再抛(部分写);`after` = 操作做完再抛(fsync 失败:追加的行已落盘,或 tmp 已写完)
   */
  mode?: 'before' | 'partial' | 'after';
  /** 先放过几次匹配(缺省 0) */
  skip?: number;
  /** 命中几次后停止注入(缺省 1) */
  times?: number;
}

export function faulty(
  inner: StoreFs,
  faults: Fault[],
): StoreFs & { hits: string[]; calls: string[] } {
  const hits: string[] = [];
  const calls: string[] = [];
  const state = faults.map(() => ({ seen: 0, fired: 0 }));
  const match = (op: FsOp, name: string): { f: Fault } | null => {
    for (let i = 0; i < faults.length; i++) {
      const f = faults[i] as Fault;
      const s = state[i] as { seen: number; fired: number };
      if (f.op !== op || (f.name !== undefined && f.name !== name)) continue;
      s.seen++;
      if (s.seen <= (f.skip ?? 0)) continue;
      if (s.fired >= (f.times ?? 1)) continue;
      s.fired++;
      hits.push(`${op}:${name}:${f.code}`);
      return { f };
    }
    return null;
  };
  return {
    hits,
    calls,
    async read(name, max) {
      calls.push(`read:${name}`);
      const m = match('read', name);
      if (m !== null) throw errno(m.f.code);
      return inner.read(name, max);
    },
    async writeTmp(name, text) {
      calls.push(`writeTmp:${name}`);
      const m = match('writeTmp', name);
      if (m === null) return inner.writeTmp(name, text);
      if (m.f.mode === 'after') await inner.writeTmp(name, text);
      throw errno(m.f.code);
    },
    async commitTmp(name) {
      calls.push(`commitTmp:${name}`);
      const m = match('commitTmp', name);
      if (m !== null) throw errno(m.f.code);
      return inner.commitTmp(name);
    },
    async removeTmp(name) {
      calls.push(`removeTmp:${name}`);
      const m = match('removeTmp', name);
      if (m !== null) throw errno(m.f.code);
      return inner.removeTmp(name);
    },
    async appendSynced(name, text) {
      calls.push(`appendSynced:${name}`);
      const m = match('appendSynced', name);
      if (m === null) return inner.appendSynced(name, text);
      if (m.f.mode === 'partial') {
        await inner.appendSynced(
          name,
          Buffer.from(text, 'utf8')
            .subarray(0, Math.floor(text.length / 2))
            .toString('utf8'),
        );
      } else if (m.f.mode === 'after') {
        await inner.appendSynced(name, text);
      }
      throw errno(m.f.code);
    },
  };
}

// ---------- 世界 ----------
export type FsKind = 'real' | 'mem';
export interface World {
  kind: FsKind;
  dir: string;
  io: IoContext;
  /** 未包故障的底层(读文件字节、播种用) */
  raw: StoreFs;
  /** 装配所用(可能包了故障) */
  fs: StoreFs;
  rsi: FakeLock;
  personal: FakeLock;
  log: string[];
  clock: { iso: string };
  store: RsiStore;
  backend: StoreBackend;
  /** 底层所有 `*.tmp` 文件名 */
  tmpFiles(): Promise<string[]>;
  bytes(name: string): Promise<Buffer | null>;
}

export interface WorldOptions {
  wrap?: (inner: StoreFs) => StoreFs;
  clockIso?: string;
  reconcile?: Parameters<typeof assembleRsiStore>[0]['reconcile'];
}

export async function makeWorld(kind: FsKind, opts: WorldOptions = {}): Promise<World> {
  const log: string[] = [];
  const clock = { iso: opts.clockIso ?? TODAY_ISO };
  let raw: StoreFs;
  let io: IoContext = baseCtx();
  let dir = '';
  let tmpFiles: () => Promise<string[]>;
  if (kind === 'mem') {
    const m = new MemFs();
    raw = m;
    tmpFiles = async () => [...m.tmps.keys()].map((n) => `${n}.tmp`);
  } else {
    const t = await makeTempDir('rsi-store-');
    dir = t.dir;
    io = createIoContext({
      cwd: REPO_ROOT,
      env: { KIT_TMP: dir, KIT_STATE_DIR: path.join(dir, 'state'), PATH: baseCtx().execPath },
    });
    const rsi = await rsiDir(io);
    raw = safeStoreFs(io, rsi);
    tmpFiles = async () =>
      (await readDir(rsi)).map((e) => e.name).filter((n) => n.endsWith('.tmp'));
  }
  const fs = opts.wrap === undefined ? raw : opts.wrap(raw);
  const rsiLock = new FakeLock('rsi', log);
  const personalLock = new FakeLock('personal', log);
  const clockFn = (): Date => new Date(clock.iso);
  const store = assembleRsiStore({
    fs,
    rsi: rsiLock,
    personal: personalLock,
    clock: clockFn,
    ...(opts.reconcile !== undefined ? { reconcile: opts.reconcile } : {}),
  });
  const backend = createBackend(raw, clockFn);
  return {
    kind,
    dir,
    io,
    raw,
    fs,
    rsi: rsiLock,
    personal: personalLock,
    log,
    clock,
    store,
    backend,
    tmpFiles,
    async bytes(name) {
      const r = await raw.read(name, 256 * 1024 * 1024);
      return r.kind === 'ok' ? r.bytes : null;
    },
  };
}

export const FILES = {
  effects: RSI_EFFECTS_FILE,
  audit: RSI_AUDIT_FILE,
  compaction: RSI_AUDIT_COMPACTION_FILE,
} as const;

/** 播种:直接写底层文件(绕过被测写路径) */
export async function seed(w: World, name: string, text: string): Promise<void> {
  await w.raw.writeTmp(name, text);
  await w.raw.commitTmp(name);
}

/** 在文件系统层面给 `name` 追加字节(造撕裂尾等) */
export async function rawAppend(w: World, name: string, text: string): Promise<void> {
  await w.raw.appendSynced(name, text);
}

/** 与追加器写出的行逐字节一致(规范化单行 JSON) */
export const jsonLine = (o: unknown): string => canonicalJsonLine(o);

export const compactionDoc = (through: string | null, gen = 1) => ({
  schema_version: 1 as const,
  gen,
  through,
  months: {},
});

let fullAuditCache: string | null = null;
/** 20000 行(审计硬线)的合法审计文件;键从 0x100000 起,不与测试里常用的 hex16(1..) 冲突。进程内只构造一次 */
export function fullAuditText(): string {
  fullAuditCache ??= Array.from({ length: 20000 }, (_, i) =>
    jsonLine(trow(hex16(i + 0x100000))),
  ).join('');
  return fullAuditCache;
}

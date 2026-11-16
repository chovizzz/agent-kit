/**
 * B1a 存储核测试夹具:内存 `StoreFs` 假件(与真实现同一份契约:不存在 = missing,不安全 = unsafe,写失败 = 抛错)、故障注入包装(ENOSPC / EACCES / rename 失败 / 部分写 / fsync 失败)、
 * 假锁(`assertHeld` 丢锁 = `RsiLockError('lock_lost')`)、世界构造(`real` = 真 `safeStoreFs` + 临时目录;`mem` = 内存)。**不调用被测的合并 / 规划函数**:期望值由测试自己手写。
 */
import * as path from 'node:path';
import { expect } from 'vitest';
import type { RsiAuditLine } from '../../../src/contracts/rsi-personal.js';
import {
  RSI_AUDIT_COMPACTION_FILE,
  RSI_AUDIT_FILE,
  RSI_EFFECTS_FILE,
} from '../../../src/contracts/rsi-store.js';
import { canonicalJsonLine } from '../../../src/io/canonical-json.js';
import { createIoContext, type IoContext } from '../../../src/io/paths.js';
import { appendFileSynced, writeFile } from '../../../src/io/safe-fs.js';
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
  /** 与真实句柄同一契约:挂上的释放屏障在 `release()` 真正动手前先等(同一句柄只接受同一个屏障) */
  private gate: { beforeRelease(): Promise<void> } | undefined;
  constructor(
    readonly name: string,
    private readonly log: string[],
    readonly path?: string,
    readonly kind?: 'rsi' | 'personal',
  ) {}
  /** 与真实句柄同一契约:无副作用预检(空槽或已是同一个屏障才可挂) */
  canAttachReleaseGate(gate: { beforeRelease(): Promise<void> }): boolean {
    return this.gate === undefined || this.gate === gate;
  }
  attachReleaseGate(gate: { beforeRelease(): Promise<void> }): void {
    if (this.gate !== undefined && this.gate !== gate) throw new RsiLockError('internal');
    this.gate = gate;
  }
  async assertHeld(): Promise<void> {
    this.asserts++;
    if (!this.held) throw new RsiLockError('lock_lost');
  }
  async release(): Promise<void> {
    await this.gate?.beforeRelease();
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
    // 里氏替换:包装器保留底层的 `root`(真实装配的身份校验依赖它),不论是否经 `makeWorld` 的 `wrap`
    ...(inner.root !== undefined ? { root: inner.root } : {}),
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

/** 给任意 `StoreFs` 加上 `root`(委托其余方法;内存假件没有 root 时用来演示「锁带 path、fs 带 root」的真实装配形状) */
export function withRoot(inner: StoreFs, root: string): StoreFs {
  return {
    root,
    read: (n, m) => inner.read(n, m),
    writeTmp: (n, t) => inner.writeTmp(n, t),
    commitTmp: (n) => inner.commitTmp(n),
    removeTmp: (n) => inner.removeTmp(n),
    appendSynced: (n, t) => inner.appendSynced(n, t),
  };
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
  // 真实世界按生产形状装配:`fs.root` + 两把锁都带 path 与锁种类(rsi = <root>/lock,personal 在 root 之外);
  // 包装器(故障注入等)必须保留 `root`——没有转发就补上(原地定义,不换对象,`hits` / `calls` 等包装器自带成员保留)。
  // 内存世界两者都不带(假件形状),装配照旧走「都不声明」分支。
  let rsiPath: string | undefined;
  let personalPath: string | undefined;
  if (raw.root !== undefined) {
    rsiPath = path.join(raw.root, 'lock');
    personalPath = path.join(dir, 'home', 'rsi-personal', 'lock');
    if (fs.root === undefined) Object.defineProperty(fs, 'root', { value: raw.root });
  }
  const rsiLock = new FakeLock('rsi', log, rsiPath, rsiPath === undefined ? undefined : 'rsi');
  const personalLock = new FakeLock(
    'personal',
    log,
    personalPath,
    personalPath === undefined ? undefined : 'personal',
  );
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

/**
 * 字节相等断言(大文件用)。**不要**对 MB 级 Buffer 用 `expect(...).toEqual(...)`:vitest 逐元素比较,2.5MB 要 ~26s(实测,seal),
 * 一条用例比两次再叠加负载就撞 120s 超时。这里用 `Buffer.equals`(memcmp),失败时给长度与首个差异下标。
 */
export function expectSameBytes(actual: Buffer | null, expected: Buffer | null): void {
  if (actual === null || expected === null) {
    expect(actual === null).toBe(expected === null);
    return;
  }
  expect(actual.length).toBe(expected.length);
  expect(actual.equals(expected) ? -1 : actual.findIndex((b, i) => b !== expected[i])).toBe(-1);
}

let fullAuditCache: string | null = null;
/** 20000 行(审计硬线)的合法审计文件;键从 0x100000 起,不与测试里常用的 hex16(1..) 冲突。进程内只构造一次 */
export function fullAuditText(): string {
  fullAuditCache ??= Array.from({ length: 20000 }, (_, i) =>
    jsonLine(trow(hex16(i + 0x100000))),
  ).join('');
  return fullAuditCache;
}

// ---------- 字节级播种(撕裂尾可停在多字节字符中间;`StoreFs` 端口只收字符串,所以直接写底层) ----------
const absOf = async (w: World, name: string): Promise<string> =>
  path.join(await rsiDir(w.io), name);

/** 用任意字节覆盖 `name`(内存:直接放 Buffer;真文件:经 `safe-fs`) */
export async function seedBytes(w: World, name: string, bytes: Uint8Array): Promise<void> {
  if (w.kind === 'mem') (w.raw as MemFs).files.set(name, Buffer.from(bytes));
  else await writeFile(w.io, await absOf(w, name), bytes, { mode: 0o600 });
}

/** 在 `name` 末尾追加任意字节(模拟停在字符中间的短写) */
export async function rawAppendBytes(w: World, name: string, bytes: Uint8Array): Promise<void> {
  if (w.kind === 'mem') {
    const m = w.raw as MemFs;
    m.files.set(name, Buffer.concat([m.files.get(name) ?? Buffer.alloc(0), Buffer.from(bytes)]));
  } else await appendFileSynced(w.io, await absOf(w, name), bytes, 0o600);
}

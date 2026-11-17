/**
 * B1b 测试夹具(压缩与水位线):在 B1a 的 `makeWorld`(假锁 / 内存或真文件系统 / 时钟)之上,**自己装配**带 `source` 的存储核与 `Compactor`;
 * 权威记录用假的 `RecordsPort`(内存里的 `PersonalLifecycleRecord`,可计数、可注入读失败)接真 `createReconcileSource` 适配器;
 * 崩溃注入 `crashFs`(能在操作**完成之后**才抛,模拟「rename 已落、进程随后死」;还有半截 tmp)。**不调用被测的合并 / 规划函数**:期望字节由测试自己手写,或来自「不中断的对照世界」。
 */
import type { PersonalLifecycleRecord, RsiAuditLine } from '../../../src/contracts/rsi-personal.js';
import type { RsiAuditCompaction, RsiEffectsLedger } from '../../../src/contracts/rsi-store.js';
import { canonicalJson } from '../../../src/io/canonical-json.js';
import { compactorOf, createCompactor, type Compactor } from '../../../src/rsi/store/compactor.js';
import type { StoreFs } from '../../../src/rsi/store/fs-port.js';
import type { LedgerRecoveryPort, ReconcileSource } from '../../../src/rsi/store/ports.js';
import {
  createReconcileSource,
  type RecordsPort,
} from '../../../src/rsi/store/reconcile-source.js';
import { assembleRsiStore, type RsiStore } from '../../../src/rsi/store/store.js';
import { entry, rec } from '../personal/transition-fixture.js';
import {
  FILES,
  ID,
  SHA,
  hex16,
  jsonLine,
  makeWorld,
  seed,
  trow,
  type FsKind,
  type World,
  type WorldOptions,
} from './store-fixture.js';

export { entry, rec };

// ---------- 权威记录 ----------
export interface FakeRecords extends RecordsPort {
  list: PersonalLifecycleRecord[];
  reads: number;
  /** 非空时 `readAll` 返回该 kind(模拟读不到) */
  failKind: string | null;
  /** 非空时 `readAll` 抛该错误 */
  throws: Error | null;
}
export function fakeRecords(list: PersonalLifecycleRecord[] = []): FakeRecords {
  const f: FakeRecords = {
    list,
    reads: 0,
    failKind: null,
    throws: null,
    async readAll() {
      f.reads++;
      if (f.throws !== null) throw f.throws;
      if (f.failKind !== null) return { kind: f.failKind };
      return { kind: 'ok', value: structuredClone(f.list) };
    },
  };
  return f;
}

/** 终态 `rejected`(vetoed)记录:创建条目 2026-10-01,终态条目 2026-10-02;E2 = 黑名单 + 墓碑(无冷却,无保护标记) */
export const T_CREATE_AT = '2026-10-01T08:00:00.000Z';
export const T_TERM_AT = '2026-10-02T08:00:00.000Z';
export function terminalRecord(
  id = ID,
  sha = SHA,
  keys: [string, string] = [hex16(0xa1), hex16(0xa2)],
): PersonalLifecycleRecord {
  return rec('rejected', {
    id,
    content_sha256: sha,
    terminal_reason: 'vetoed',
    transitions: [
      {
        dim: 'lifecycle',
        from: 'none',
        to: 'proposed',
        at: T_CREATE_AT,
        reason: 'ingested',
        idem_key: keys[0],
      },
      {
        dim: 'lifecycle',
        from: 'proposed',
        to: 'rejected',
        at: T_TERM_AT,
        reason: 'vetoed',
        idem_key: keys[1],
      },
    ],
  });
}

/** 记录里一条条目对应的审计行(= 即时落地的行,`auditOf` 的形状;测试自己手写) */
export const rowOfEntry = (
  id: string,
  e: PersonalLifecycleRecord['transitions'][number],
): RsiAuditLine => ({
  at: e.at,
  kind: 'transition',
  id,
  dim: e.dim,
  from: e.from,
  to: e.to,
  reason: e.reason,
  idem_key: e.idem_key,
});

// ---------- 世界 ----------
export interface CWorld extends World {
  /** 带 `reconcile`(= source)的存储核,附 `compactorOf` 造的 `compactor`(与 `w.store` 不同:后者无 source、无 compactor) */
  s: RsiStore & { compactor: Compactor };
  records: FakeRecords;
  source: ReconcileSource;
  compactor: Compactor;
  /** 压缩前恢复端口的调用日志(每次调用的 batch key 列表) */
  recoveryCalls: string[][];
}

export interface CWorldOptions extends WorldOptions {
  records?: PersonalLifecycleRecord[];
  /** 不接 source(未接线) */
  unwired?: boolean;
}

export async function makeCWorld(kind: FsKind, o: CWorldOptions = {}): Promise<CWorld> {
  const w = await makeWorld(kind, o);
  const records = fakeRecords(o.records ?? []);
  const source = createReconcileSource({ records });
  const clock = (): Date => new Date(w.clock.iso);
  const base = assembleRsiStore({
    fs: w.fs,
    rsi: w.rsi,
    personal: w.personal,
    clock,
    ...(o.unwired === true ? {} : { reconcile: source }),
  });
  const s = Object.assign(base, {
    compactor: compactorOf(base, {
      clock,
      ...(o.unwired === true ? {} : { source }),
    }),
  });
  const recoveryCalls: string[][] = [];
  const recovery: LedgerRecoveryPort = {
    async recoverThrough(W, batches) {
      recoveryCalls.push(batches.map((b) => b.key));
      return s.recovery.recoverThrough(W, batches);
    },
  };
  const compactor = createCompactor({
    held: s.held,
    registry: s.registry,
    recovery,
    clock,
    ...(o.unwired === true ? {} : { reconcile: source }),
  });
  return Object.assign(w, { s, records, source, compactor, recoveryCalls });
}

// ---------- 播种与字节快照 ----------
export const auditText = (rows: readonly RsiAuditLine[]): string =>
  rows.map((r) => jsonLine(r)).join('');
export const seedAudit = (w: World, rows: readonly RsiAuditLine[], extra = ''): Promise<void> =>
  seed(w, FILES.audit, auditText(rows) + extra);
export const seedLedger = (w: World, l: RsiEffectsLedger): Promise<void> =>
  seed(w, FILES.effects, canonicalJson(l));
export const seedCompaction = (w: World, c: unknown): Promise<void> =>
  seed(w, FILES.compaction, canonicalJson(c));

export interface Snap {
  effects: string | null;
  audit: string | null;
  compaction: string | null;
}
export async function snap(w: World): Promise<Snap> {
  const t = async (n: string): Promise<string | null> =>
    (await w.bytes(n))?.toString('utf8') ?? null;
  return {
    effects: await t(FILES.effects),
    audit: await t(FILES.audit),
    compaction: await t(FILES.compaction),
  };
}

export const emptyLedger = (gen = 0): RsiEffectsLedger => ({
  schema_version: 1,
  gen,
  blacklist: [],
  tombstones: [],
  cooldowns: [],
  applied: [],
});

/** 旧日期的 n 行合法审计(键从 0x200000 起;不与常用 hex16(1..) 冲突) */
export function oldRows(n: number, at = '2026-09-01T00:00:00.000Z'): RsiAuditLine[] {
  return Array.from({ length: n }, (_, i) => trow(hex16(0x200000 + i), at));
}
let fullOldCache: string | null = null;
/** 20000 行(审计硬线)、日期 2026-09-01 的审计文本(可被压缩;进程内只构造一次) */
export function fullOldAuditText(): string {
  fullOldCache ??= auditText(oldRows(20000));
  return fullOldCache;
}

// ---------- 崩溃注入 ----------
export type CrashOp = 'read' | 'writeTmp' | 'commitTmp' | 'removeTmp' | 'appendSynced';
export interface Crash {
  op: CrashOp;
  name: string;
  code: string;
  /**
   * `before`(缺省)= 未做就抛(ENOSPC / EACCES / rename 失败);`after` = 操作做完才抛(rename 已落或 tmp 已写完、进程随后死 / fsync 失败);
   * `partial` = `writeTmp` 只写前一半字节再抛(部分写,tmp 留盘由调用方清理)。
   */
  mode?: 'before' | 'after' | 'partial';
  /** 先放过几次匹配(缺省 0) */
  skip?: number;
}
export interface CrashFs extends StoreFs {
  hits: string[];
  calls: string[];
  /** 关掉注入(「重启」后的世界) */
  disarm(): void;
}
const err = (code: string): Error => Object.assign(new Error(code), { code });
export function crashFs(inner: StoreFs, crashes: Crash[]): CrashFs {
  const seen = crashes.map(() => 0);
  const fired = crashes.map(() => false);
  let armed = true;
  const hits: string[] = [];
  const calls: string[] = [];
  const match = (op: CrashOp, name: string): Crash | null => {
    if (!armed) return null;
    for (let i = 0; i < crashes.length; i++) {
      const c = crashes[i] as Crash;
      if (c.op !== op || c.name !== name || fired[i] === true) continue;
      seen[i] = (seen[i] as number) + 1;
      if ((seen[i] as number) <= (c.skip ?? 0)) continue;
      fired[i] = true;
      hits.push(`${op}:${name}:${c.code}:${c.mode ?? 'before'}`);
      return c;
    }
    return null;
  };
  return {
    hits,
    calls,
    disarm: () => {
      armed = false;
    },
    async read(name, max) {
      calls.push(`read:${name}`);
      const c = match('read', name);
      if (c !== null) throw err(c.code);
      return inner.read(name, max);
    },
    async writeTmp(name, text) {
      calls.push(`writeTmp:${name}`);
      const c = match('writeTmp', name);
      if (c === null) return inner.writeTmp(name, text);
      if (c.mode === 'after') await inner.writeTmp(name, text);
      else if (c.mode === 'partial') {
        await inner.writeTmp(name, text.slice(0, Math.floor(text.length / 2)));
      }
      throw err(c.code);
    },
    async commitTmp(name) {
      calls.push(`commitTmp:${name}`);
      const c = match('commitTmp', name);
      if (c === null) return inner.commitTmp(name);
      if (c.mode === 'after') await inner.commitTmp(name);
      throw err(c.code);
    },
    async removeTmp(name) {
      calls.push(`removeTmp:${name}`);
      return inner.removeTmp(name);
    },
    async appendSynced(name, text) {
      calls.push(`appendSynced:${name}`);
      const c = match('appendSynced', name);
      if (c === null) return inner.appendSynced(name, text);
      if (c.mode === 'after') await inner.appendSynced(name, text);
      throw err(c.code);
    },
  };
}

/** 在 `commitTmp(name)` 处挂起,直到 `release()`(用来在 P2 中途做别的事) */
export function gateCommit(
  inner: StoreFs,
  name: string,
): { fs: StoreFs; reached: Promise<void>; release(): void } {
  let release = (): void => undefined;
  let reach = (): void => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const reached = new Promise<void>((r) => {
    reach = r;
  });
  return {
    reached,
    release: () => release(),
    fs: {
      read: (n, m) => inner.read(n, m),
      writeTmp: (n, t) => inner.writeTmp(n, t),
      removeTmp: (n) => inner.removeTmp(n),
      appendSynced: (n, t) => inner.appendSynced(n, t),
      async commitTmp(n) {
        if (n === name) {
          reach();
          await gate;
        }
        return inner.commitTmp(n);
      },
    },
  };
}

/**
 * 第一次 `read(name)`:**先读到结果**,再挂起到 `release()` 才返回(模拟「读到了旧值、返回前别的操作完成」);之后的读不受影响。
 * `reached` 在第一次读已拿到结果、开始挂起时落定。
 */
export function gateFirstRead(
  inner: StoreFs,
  name: string,
): { fs: StoreFs; reached: Promise<void>; release(): void } {
  let release = (): void => undefined;
  let reach = (): void => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const reached = new Promise<void>((r) => {
    reach = r;
  });
  let used = false;
  return {
    reached,
    release: () => release(),
    fs: {
      writeTmp: (n, t) => inner.writeTmp(n, t),
      commitTmp: (n) => inner.commitTmp(n),
      removeTmp: (n) => inner.removeTmp(n),
      appendSynced: (n, t) => inner.appendSynced(n, t),
      async read(n, m) {
        const r = await inner.read(n, m);
        if (n === name && !used) {
          used = true;
          reach();
          await gate;
        }
        return r;
      },
    },
  };
}

/**
 * 编码后恰好 `bytes` 字节(UTF-8)的合法压缩文档:全零计数的 `by_kind` 键垫出体积(`lines = 0`,各和不变量成立),
 * 40 字符的固定键 + 一个可变长度的键补齐余数。字节数由 `canonicalJson` 实测,不靠手算;凑不出就抛。
 */
export function paddedCompaction(
  bytes: number,
  o: { gen?: number; through?: string; month?: string } = {},
): RsiAuditCompaction {
  const month = o.month ?? '2026-09';
  const doc = (n: number, len: number): ReturnType<typeof paddedCompaction> => {
    const byKind: Record<string, number> = {};
    for (let i = 0; i < n; i++) byKind[`k${i.toString(16).padStart(39, '0')}`] = 0;
    byKind['v'.repeat(len)] = 0;
    return {
      schema_version: 1,
      gen: o.gen ?? 1,
      through: o.through ?? '2026-11-01',
      months: {
        [month]: {
          lines: 0,
          deleted: 0,
          derived_missing: 0,
          by_kind: byKind,
          transition_by_to: {},
        },
      },
    };
  };
  const size = (n: number, len: number): number =>
    Buffer.byteLength(canonicalJson(doc(n, len)), 'utf8');
  const per = size(2, 1) - size(1, 1);
  const n = Math.floor((bytes - size(0, 1)) / per);
  const len = 1 + (bytes - size(n, 1));
  if (len < 1 || len > 64 || size(n, len) !== bytes) throw new Error('cannot pad to exact size');
  return doc(n, len);
}

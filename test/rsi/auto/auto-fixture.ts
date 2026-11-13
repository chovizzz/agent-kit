/**
 * W8a 只读命令的测试夹具:内存端口(与生产端口同一份契约:读失败 = `unreadable` / 抛错,绝不返回「空」冒充成功)。
 * 假的记录提交 = `commits[oid] = { <仓库相对路径>: <正文> }`;blob 的 oid 取内容的 sha1(只作夹具里的对象名)。
 * 端口调用计数在 `calls`;`hooks` 让测试在两次读取之间改动世界(演练双读协议)。**不调用被测函数**,期望值由测试自己手写。
 */
import { createHash } from 'node:crypto';
import type { AutoView } from '../../../src/contracts/rsi-personal.js';
import type {
  AutoConfigRead,
  AutoReadPorts,
  JudgeVerdictRead,
  MarkerRead,
  RawRead,
  StateRead,
} from '../../../src/rsi/auto/read/ports.js';
import type { RecordedWhy } from '../../../src/rsi/personal/read/recorded-port.js';

export const HEAD = '0123456789abcdef0123456789abcdef01234567';
export const HEAD2 = 'fedcba9876543210fedcba9876543210fedcba98';
export const NOW = new Date('2026-11-13T09:00:00.000Z');
export const SHA = 'a'.repeat(64);
export const ID = 'ra_0123456789ab';

const OID_RE = /^[0-9a-f]{40}$/;
const sha1 = (s: string): string => createHash('sha1').update(s, 'utf8').digest('hex');

export interface World {
  now: Date;
  cfg: AutoConfigRead;
  state: StateRead;
  view: RawRead;
  markers: MarkerRead;
  audit: RawRead;
  prior: boolean;
  head: RawRead;
  rev: RawRead;
  names: string[];
  namesUnreadable: boolean;
  journals: Record<string, RawRead>;
  commits: Record<string, Record<string, string>>;
  missingCommits: Set<string>;
  recordedUnreadable: RecordedWhy | null;
  judge: JudgeVerdictRead | 'throw';
  calls: {
    config: number;
    state: number;
    markers: number;
    head: number;
    rev: number;
    names: number;
    journal: number;
    commit: number;
    tree: number;
    blob: number;
  };
  /** 每次端口调用之后(计数已加一):测试在这里改动世界 */
  hooks: { after?: (op: string, n: number) => void };
}

export function makeWorld(over: Partial<World> = {}): World {
  return {
    now: NOW,
    cfg: { rsiOn: true, enabled: true, profile: 'medium' },
    state: { kind: 'ok', autoPause: null },
    view: { kind: 'absent' },
    markers: { user: 'absent', breaker: 'absent' },
    audit: { kind: 'absent' },
    prior: false,
    head: { kind: 'absent' },
    rev: { kind: 'absent' },
    names: [],
    namesUnreadable: false,
    journals: {},
    commits: {},
    missingCommits: new Set(),
    recordedUnreadable: null,
    judge: { kind: 'absent' },
    calls: {
      config: 0,
      state: 0,
      markers: 0,
      head: 0,
      rev: 0,
      names: 0,
      journal: 0,
      commit: 0,
      tree: 0,
      blob: 0,
    },
    hooks: {},
    ...over,
  };
}

export function portsOf(w: World): AutoReadPorts {
  /** 先取得本次调用的结果,再计数并触发钩子:钩子改动世界只影响**之后**的调用(「两次读取之间」) */
  const done = <T>(op: keyof World['calls'], v: T): T => {
    w.calls[op] += 1;
    w.hooks.after?.(op, w.calls[op]);
    return v;
  };
  const tick = (op: keyof World['calls']): void => void done(op, undefined);
  const blobs = (): Map<string, string> => {
    const m = new Map<string, string>();
    for (const files of Object.values(w.commits)) {
      for (const c of Object.values(files)) m.set(sha1(c), c);
    }
    return m;
  };
  return {
    now: () => w.now,
    async config() {
      return done('config', w.cfg);
    },
    async state() {
      return done('state', w.state);
    },
    view: async () => w.view,
    async markers() {
      return done('markers', w.markers);
    },
    audit: async () => w.audit,
    priorActivity: async () => w.prior,
    home: {
      async head() {
        return done('head', w.head);
      },
      async revocations() {
        return done('rev', w.rev);
      },
      async txnNames() {
        return done(
          'names',
          w.namesUnreadable
            ? ({ kind: 'unreadable' } as const)
            : ({ kind: 'ok', names: [...w.names].sort() } as const),
        );
      },
      async journal(id) {
        return done('journal', w.journals[id] ?? ({ kind: 'absent' } as const));
      },
    },
    recorded: {
      async readCommit(oid) {
        tick('commit');
        if (!OID_RE.test(oid)) return { kind: 'unreadable', why: 'bad_oid' };
        if (w.recordedUnreadable !== null) return { kind: 'unreadable', why: w.recordedUnreadable };
        if (w.missingCommits.has(oid) || w.commits[oid] === undefined) return { kind: 'missing' };
        return { kind: 'ok', value: { oid } };
      },
      async listTree(oid) {
        tick('tree');
        if (!OID_RE.test(oid)) return { kind: 'unreadable', why: 'bad_oid' };
        if (w.recordedUnreadable !== null) return { kind: 'unreadable', why: w.recordedUnreadable };
        const files = w.commits[oid];
        if (files === undefined) return { kind: 'missing' };
        return {
          kind: 'ok',
          value: Object.entries(files).map(([path, c]) => ({ path, oid: sha1(c), mode: '100644' })),
        };
      },
      async readBlob(oid) {
        tick('blob');
        if (!OID_RE.test(oid)) return { kind: 'unreadable', why: 'bad_oid' };
        if (w.recordedUnreadable !== null) return { kind: 'unreadable', why: w.recordedUnreadable };
        const c = blobs().get(oid);
        return c === undefined ? { kind: 'missing' } : { kind: 'ok', value: c };
      },
    },
    judge: {
      async verdictFor() {
        if (w.judge === 'throw') throw new Error('judge store broken');
        return w.judge;
      },
    },
  };
}

/** 把 head.json 指向 `oid`,并让该提交含这些文件 */
export function setCommit(w: World, oid: string, files: Record<string, string>): void {
  w.commits[oid] = files;
  w.head = {
    kind: 'ok',
    text: JSON.stringify({ schema_version: 1, head: oid, owner_repo_fp: '0123456789abcdef' }),
  };
}

export const recordFile = (rec: { id: string }): Record<string, string> => ({
  [`lifecycle/${rec.id}.json`]: JSON.stringify(rec),
});

export function viewOf(over: Partial<AutoView> = {}): AutoView {
  return {
    schema_version: 1,
    as_of: '2026-11-13T08:00:00.000Z',
    record_oid: HEAD,
    pipeline: {
      states: { shadow: 1 },
      last30d: { rejected: 0, rolled_back: 0, expired: 0, retired: 0 },
    },
    budget: { used_pct: 10 },
    cost: { injected_bytes_mean: 0, s2_count: 0 },
    canary: null,
    last_rollback: null,
    rolling_back: [],
    rolling_back_truncated: false,
    protection_marks: [],
    protection_marks_truncated: false,
    ...over,
  };
}

export const rawView = (v: AutoView | string): RawRead => ({
  kind: 'ok',
  text: typeof v === 'string' ? v : JSON.stringify(v),
});

export interface Sink {
  out: string[];
  err: string[];
  stdout(t: string): void;
  stderr(t: string): void;
  text(): { out: string; err: string };
}
export function makeSink(): Sink {
  const s: Sink = {
    out: [],
    err: [],
    stdout: (t) => void s.out.push(t),
    stderr: (t) => void s.err.push(t),
    text: () => ({ out: s.out.join(''), err: s.err.join('') }),
  };
  return s;
}

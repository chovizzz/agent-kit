/**
 * B4c2 测试共用夹具:真实 rsi 目录 / 配置 / 锁 / 假 HOME 里的会话文件,经 `runL0UnderLock` 真跑。全部写在 KIT_TMP 内,不碰真实 HOME。
 */
import * as path from 'node:path';
import { createRedactor } from '../../src/redact/index.js';
import type { RsiState } from '../../src/contracts/rsi.js';
import { exists, readText } from '../../src/io/read-fs.js';
import { mkdirp, remove } from '../../src/io/safe-fs.js';
import type { CommitL0Result } from '../../src/rsi/l0/commit.js';
import { runL0UnderLock, type RunL0Deps } from '../../src/rsi/l0/run.js';
import type {
  Checkpoint,
  CheckpointVerdict,
  RunL0Input,
  StateMutator,
} from '../../src/rsi/l0/types.js';
import { claudeLine, jl, put as putSession, uuid } from './l0-fixture.js';
import { treeOf } from './rsi-fixture.js';
import { makeSvc, withLock, type MakeSvcOptions, type Svc } from './services-fixture.js';

export const CONT: CheckpointVerdict = { kind: 'continue' };
export const go: Checkpoint = async () => CONT;
export const redactor = createRedactor({ timeout_ms: 5000 });

export const emptyState = (): RsiState => ({
  schema_version: 1,
  confirm: null,
  projects_ack_generation: 0,
  attempt: null,
  last_tick: null,
  consecutive_failures: 0,
  breaker: null,
});

export const mutator: StateMutator = (prev, s) => ({
  ...(prev ?? emptyState()),
  attempt: null,
  last_tick: {
    completed_at: '2026-10-26T12:00:00.000Z',
    trigger: 'tick',
    outcome: s.outcome,
    code: null,
    duration_ms: 0,
    files_read: s.files_read,
    bytes_read: s.bytes_read,
  },
});

export function inputOf(over: Partial<RunL0Input> = {}): RunL0Input {
  return {
    trigger: 'tick',
    recovered: 'absent',
    binding: {
      repoSha256: 'a'.repeat(64),
      repoDevIno: { dev: 1, ino: 1 },
      policyFp: 'b'.repeat(64),
      agents: ['claude', 'codex', 'pi'],
      confirmedAt: null,
    },
    checkpoint: go,
    stateMutator: mutator,
    ...over,
  };
}

export interface RunFx {
  s: Svc;
  /** 建项目目录(`dir/work/<name>`)并返回路径 */
  work(name: string): Promise<string>;
  /** 写一个 claude 会话:`n` 个 uuid 文件名,每个 `lines` 行,首行带 `timestamp` */
  claude(
    n: number,
    cwd: string,
    opts?: { ts?: string; lines?: number; text?: string },
  ): Promise<string>;
}

export async function makeRunFx(prefix: string, opts: MakeSvcOptions = {}): Promise<RunFx> {
  const s = await makeSvc(prefix, opts);
  return {
    s,
    async work(name) {
      const p = path.join(s.f.dir, 'work', name);
      await mkdirp(s.f.fx, p, 0o755);
      return p;
    },
    async claude(n, cwd, o = {}) {
      const ts = o.ts ?? '2026-10-01T00:00:00.000Z';
      const lines = Array.from({ length: o.lines ?? 2 }, (_, i) =>
        claudeLine(cwd, {
          timestamp: new Date(Date.parse(ts) + i * 1000).toISOString(),
          ...(o.text !== undefined && i === 0
            ? { message: { role: 'user', content: o.text } }
            : {}),
        }),
      );
      return putSession(s.f, 'claude', `p/${uuid(n)}.jsonl`, jl(...lines));
    },
  };
}

/** 持锁真跑一次 confirmed L0;`deps.redactor` 缺省用测试的 5 秒预算脱敏器 */
export async function runL0(
  fx: RunFx,
  input: RunL0Input = inputOf(),
  deps: RunL0Deps = {},
): Promise<CommitL0Result> {
  return withLock(fx.s, (lock) => runL0UnderLock(fx.s.ctx, lock, input, { redactor, ...deps }));
}

/** 换掉锁文件的 nonce(「失锁」):`assertHeld` 之后会报 lock_lost */
export async function loseLock(s: Svc): Promise<void> {
  await remove(s.f.fx, path.join(s.rsi, 'lock'));
}

/** 四类数据文件的内容摘要(信号库 / 会话计数库 / 索引 / cursor):[A0] 字节不变与「零数据提交」断言用 */
export async function dataDigest(s: Svc): Promise<string[]> {
  const stateTree = await treeOf(s.state);
  const rsiTree = (await treeOf(s.rsi)).filter(
    (l) => l.startsWith('projects.json ') || l.startsWith('cursor.json '),
  );
  const store = stateTree.filter((l) => /^(signals|sessions)\/.+\.jsonl /.test(l));
  return [...store, ...rsiTree.map((l) => `rsi/${l}`)];
}

export const rsiFile = async (s: Svc, name: string): Promise<unknown> => {
  const p = path.join(s.rsi, name);
  return (await exists(p)) ? JSON.parse(await readText(p)) : null;
};

export type ScenarioKind = 'first' | 'incremental';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 故障注入 / 崩溃矩阵共用的场景(下一次 `runL0` 就是被测的那一次):
 *  - `first`:两个项目、两个月份(2026-09 / 2026-10),其中一条是显式教训(会成一个聚类);索引 / cursor / (默认)盐都不存在;
 *  - `incremental`:先把 `first` 正常提交一轮,再① 原样重写 alpha 的会话(mtime 变 → 重读,信号全部被去重 → 走 `chmod-existing`)、
 *    ② 在已有的 2026-10 月文件里追加一个新项目 gamma、③ 新开 2026-11 月文件(delta)。
 */
export async function scenario(
  kind: ScenarioKind,
  prefix: string,
  opts: MakeSvcOptions = {},
): Promise<RunFx> {
  const fx = await makeRunFx(prefix, opts);
  const alpha = await fx.work('alpha');
  await fx.claude(1, alpha, {
    ts: '2026-09-15T00:00:00.000Z',
    text: 'from now on stop running the slow suite',
  });
  await fx.claude(2, await fx.work('beta'), { ts: '2026-10-01T00:00:00.000Z' });
  if (kind === 'incremental') {
    await runL0(fx);
    await sleep(15);
    await fx.claude(1, alpha, {
      ts: '2026-09-15T00:00:00.000Z',
      text: 'from now on stop running the slow suite',
    });
    await fx.claude(3, await fx.work('gamma'), { ts: '2026-10-02T00:00:00.000Z' });
    await fx.claude(4, await fx.work('delta'), { ts: '2026-11-05T00:00:00.000Z' });
  }
  return fx;
}

export interface OpRecord {
  op: string;
  path: string;
  /** 该写点**之前**的 safe-fs 写调用数(`svc.audit` 长度) */
  audit: number;
}

/** 跑一遍场景,记下每个写点(`beforeWrite` 调用)的名字 / 路径 / 之前的写调用数 */
export async function recordOps(
  kind: ScenarioKind,
  prefix: string,
  opts: MakeSvcOptions = {},
): Promise<{ fx: RunFx; ops: OpRecord[]; auditTotal: number }> {
  const fx = await scenario(kind, prefix, opts);
  const base = fx.s.audit.length;
  const ops: OpRecord[] = [];
  await runL0(fx, inputOf(), {
    beforeWrite: async (op, p) => {
      ops.push({ op, path: p, audit: fx.s.audit.length - base });
    },
  });
  return { fx, ops, auditTotal: fx.s.audit.length - base };
}

/**
 * R20-A4 测试夹具(docs/contracts.md §20.16):在 `makeSvc` 的真实目录 / 真实 `[rsi]` 配置 / 假 HOME 上造一个「已确认」的世界——
 * 三个项目(cur = 当前会话所在项目;other = 另一个采集中项目;ex = 被 `exclude_dirs` 排除)、信号库、索引、counts、确认记录、已提交的快照清单、一份合法的 `[rsi.session]`。
 * 固定时钟 2026-10-26T12:00:00Z。全部经 safe-fs 写在 KIT_TMP(夹具目录)内,假 HOME;不碰真实 HOME;测试用 {@link assertNoRealHomeWrites} 断言写审计里没有夹具目录之外的路径。
 */
import * as path from 'node:path';
import { expect } from 'vitest';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { projectKeyFor } from '../../src/signals/ids.js';
import { canonical } from '../../src/signals/exclude.js';
import { runDigest, type RunDigestDeps } from '../../src/rsi/digest.js';
import { commitSnapshot } from '../../src/rsi/snapshot.js';
import type { RsiEarlyContext } from '../../src/rsi/types.js';
import type { Signal } from '../../src/contracts/signal.js';
import type { LoadedSignal } from '../../src/reflect/types.js';
import { sig, fakeKey } from '../fixtures/reflect/world.js';
import { writeConfirmed } from './b5c-fixture.js';
import { rsiToml, writeCfg } from './rsi-fixture.js';
import {
  SALT,
  countsDoc,
  makeRoot,
  makeSvc,
  put,
  withLock,
  writeIndex,
  type Svc,
} from './services-fixture.js';

export const NOW0 = Date.parse('2026-10-26T12:00:00.000Z');
export const L_TEST = 'from now on always run the unit tests before pushing any code';
export const L_FILES = 'never again commit generated files into the repository going forward';
export { fakeKey };

export interface A4World {
  s: Svc;
  env: Record<string, string>;
  roots: { cur: string; other: string; ex: string };
  keys: { cur: string; other: string; ex: string };
}

export interface WorldOpts {
  /** `[rsi.session]` 段文本(含表头);`null` = 不写这一段;缺省 = 合法授权(claude + codex,2026-12-31) */
  session?: string | null;
  /** `[rsi]` 里追加的顶层键(须在 `[rsi.session]` 之前) */
  rsiExtra?: string;
  /** 额外排除的目录(除 ex 之外) */
  noExclude?: boolean;
  /** 不写入信号 */
  noSignals?: boolean;
  /** 不写确认记录(armed) */
  armed?: boolean;
  /** 额外信号 */
  extraSignals?: (w: { keys: A4World['keys'] }) => Signal[];
}

export const SESSION_OK = `[rsi.session]\nenabled = true\nagents = ["claude", "codex"]\nexpires = "2026-12-31"\n`;

export interface CfgOpts {
  session?: string | null | undefined;
  rsiExtra?: string | undefined;
  /** `false` = 不写 exclude_dirs;数组 = 这些目录;缺省 = 只排除 ex */
  exclude?: boolean | readonly string[] | undefined;
}

export function tomlOf(w: A4World, o: CfgOpts): string {
  const dirs = Array.isArray(o.exclude) ? (o.exclude as readonly string[]) : [w.roots.ex];
  const excl =
    o.exclude === false
      ? ''
      : `exclude_dirs = [${dirs.map((d) => JSON.stringify(d)).join(', ')}]\n`;
  const sess = o.session === undefined ? SESSION_OK : (o.session ?? '');
  return rsiToml(w.s.f, `${excl}${o.rsiExtra ?? ''}\n${sess}`);
}

/** 重写用户配置(下一次重读即生效) */
export async function rewriteCfg(w: A4World, o: CfgOpts): Promise<void> {
  await writeCfg(w.s.f, tomlOf(w, o));
}

/** 信号:`kind=user_message` 的显式教训;`sess` 区分会话 */
export function lesson(key: string, sess: string, index: number, text: string): LoadedSignal {
  return { ...sig({ project: 'x', session: sess, index, text }), project_key: key } as LoadedSignal;
}

/** 一次「失败后重试」(三条信号:调用、失败结果、重试调用);重试调用带摘录 */
export function retry(key: string, sess: string, text: string): Signal[] {
  const base = (index: number, kind: 'tool_call' | 'tool_result_failed', t: string): Signal => ({
    ...sig({ project: 'x', session: sess, index, kind, tool: 'Bash', text: t }),
    project_key: key,
  });
  return [
    base(1, 'tool_call', `${text} first`),
    base(2, 'tool_result_failed', ''),
    base(3, 'tool_call', text),
  ];
}

export async function writeSignalFile(
  w: A4World,
  list: readonly Signal[],
  month = '202610',
): Promise<void> {
  const file = path.join(w.s.state, 'signals', 'claude', `${month}.jsonl`);
  await put(w.s, file, `${list.map((x) => JSON.stringify(x)).join('\n')}\n`, 0o600);
}

/** 重新提交快照清单(改过 `.state` 里的数据文件后必须调) */
export async function recommit(w: A4World): Promise<void> {
  await withLock(w.s, (lock) => commitSnapshot(w.s.io, lock));
}

export async function makeA4World(prefix: string, o: WorldOpts = {}): Promise<A4World> {
  const s = await makeSvc(prefix);
  const mk = async (n: string): Promise<string> => canonical(await makeRoot(s, n));
  const roots = { cur: await mk('cur'), other: await mk('other'), ex: await mk('ex') };
  const keys = {
    cur: projectKeyFor(SALT, roots.cur),
    other: projectKeyFor(SALT, roots.other),
    ex: projectKeyFor(SALT, roots.ex),
  };
  const env = { KIT_TMP: s.f.repo, KIT_REAL_HOME_OVERRIDE: s.f.home, PATH: '/usr/bin:/bin' };
  const w: A4World = { s, env, roots, keys };
  await writeCfg(
    s.f,
    tomlOf(w, { session: o.session, rsiExtra: o.rsiExtra, exclude: o.noExclude !== true }),
  );
  await writeIndex(s, [
    { key: keys.cur, root: roots.cur },
    { key: keys.other, root: roots.other },
    { key: keys.ex, root: roots.ex },
  ]);
  if (o.noSignals !== true) {
    const list: Signal[] = [
      // 簇 1(显式教训):cur 3 条(3 个会话)、other 2 条
      lesson(keys.cur, 'c1', 0, L_TEST),
      lesson(keys.cur, 'c2', 0, L_TEST),
      lesson(keys.cur, 'c3', 0, L_TEST),
      lesson(keys.other, 'o1', 0, L_TEST),
      lesson(keys.other, 'o2', 0, L_TEST),
      // 簇 2:cur 2 条
      lesson(keys.cur, 'c4', 0, L_FILES),
      lesson(keys.cur, 'c5', 0, L_FILES),
      // 只有被排除项目的教训(不得出现)
      lesson(keys.ex, 'x1', 0, 'stop using the legacy deploy script from now on please'),
      ...(o.extraSignals?.({ keys }) ?? []),
    ];
    await writeSignalFile(w, list);
  }
  await put(s, path.join(s.rsi, 'counts.json'), `${JSON.stringify(countsDoc())}\n`, 0o600);
  if (o.armed !== true) await writeConfirmed(s);
  await recommit(w);
  return w;
}

export interface Ran {
  code: number;
  out: string;
  err: string;
}

export function ctxOf(w: A4World, argv: string[], out: { o: string; e: string }): RsiEarlyContext {
  return {
    argv,
    overlayPath: undefined,
    explicitRoot: undefined,
    env: w.env,
    cwd: w.roots.cur,
    writeAudit: (op, p) => void w.s.audit.push(`${op} ${p}`),
    stdout: (t) => void (out.o += t),
    stderr: (t) => void (out.e += t),
  };
}

export async function digestCmd(
  w: A4World,
  argv: string[],
  deps: RunDigestDeps = {},
): Promise<Ran> {
  const out = { o: '', e: '' };
  const code = await runDigest(ctxOf(w, argv, out), {
    now: () => new Date(w.s.clock.t),
    cwd: w.roots.cur,
    ...deps,
  });
  return { code, out: out.o, err: out.e };
}

export const DIGEST_ARGS = (agent = 'claude'): string[] => ['--agent', agent, '--json'];

export const parseDigest = (
  t: string,
): {
  digest_id: string;
  expires_at: string;
  agent: string;
  reason: string;
  clusters: {
    alias: string;
    kind: string;
    evidence: { alias: string; excerpt: string }[];
    other_evidence: number;
  }[];
  truncated: { clusters_dropped: number; evidence_dropped: number };
} => JSON.parse(t) as never;

/** 夹具目录之外没有任何写(真实 HOME 不被写):写审计里的每个路径都在夹具目录内 */
export function assertNoRealHomeWrites(w: A4World): void {
  for (const a of w.s.audit) {
    const p = a.slice(a.indexOf(' ') + 1);
    expect(p.startsWith(w.s.f.dir), `写到了夹具目录之外:${a}`).toBe(true);
  }
}

export { ExitCode };

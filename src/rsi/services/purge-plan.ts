/**
 * purge 的只读规划(R20-3.8;R20-A2 B5 方案 §6.1;B5c 实装)。干跑、锁前预检、锁内规划共用。**只读**:不 import 任何写出口、不拿锁、不建目录。
 *
 * - {@link resolvePurgeKeys}:命中集合 K。`excluded` = 当前判为 X 的全部索引 key;`project` = 任一索引根(canonical + 折叠大小写 + 路径段边界,R20-4.4 口径)落在 `p` 之内的 key,
 *   且每个都必须是 X,否则 `notExcluded: true`(**预检的核心**:「未排除」先于任何写)。索引缺失 / 损坏 / 与盐不符 → fail-closed `index_invalid`。
 *   `resume` 模式不由这里解析(K 以 journal 为准),调用即 `internal`。
 * - {@link planPurgeTargets}:待 taint 的暂存目标。run = 证据 sig 经信号库映射到 K 的 run;promote = `report.json.run_id` 指向这些 run 的产物(与 `taint.ts` 的 `planPromotes` 同口径;
 *   找不到关联的 promote 由 taint 的保守回退兜底,不在这里)。
 * - {@link countPurge}:干跑与汇总用的计数(流式数信号库 / 会话计数行,cursor / 索引条目数,待 taint 的 run / promote 数)。
 */
import { RsiCursorSchema, type RsiProjectIndex } from '../../contracts/rsi.js';
import type { IoContext } from '../../io/paths.js';
import { readRsiFixed, classifierFor, loadSigKeys, readIndex } from './attribution.js';
import { SaltError, readSaltFile } from '../../signals/salt-read.js';
import { canonical } from '../../signals/exclude.js';
import { listMonthFiles, projectKeyOf, scanMonthFile } from '../../signals/store-scan.js';
import type { RsiConfigOn } from '../config.js';
import { RsiFailClosedError } from '../types.js';
import { isStagingId, listStaging, promoteRunId, readRunEvidence } from './staging.js';

export type PurgeMode =
  { kind: 'project'; path: string } | { kind: 'excluded' } | { kind: 'resume' };

/** 全部升序去重 */
export interface PurgeTargets {
  keys: string[];
  runs: string[];
  promotes: string[];
}

export interface PurgeCounts {
  signals: number;
  sessionRows: number;
  cursorEntries: number;
  indexEntries: number;
  runs: number;
  promotes: number;
}

const fold = (s: string): string => s.toLowerCase();
const within = (dir: string, child: string): boolean =>
  child === dir || child.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

/** 索引必须可读、过 schema、且 `salt_fp` 与盐一致,否则 `index_invalid`(盐文件违规 → `salt_invalid`) */
async function usableIndex(io: IoContext): Promise<RsiProjectIndex> {
  const idx = await readIndex(io);
  if (idx.kind !== 'ok') throw new RsiFailClosedError('index_invalid');
  let salt;
  try {
    salt = await readSaltFile(io.stateDir);
  } catch (e) {
    if (e instanceof SaltError) throw new RsiFailClosedError('salt_invalid');
    throw e;
  }
  if (salt.kind !== 'ok' || salt.saltFp !== idx.index.salt_fp) {
    throw new RsiFailClosedError('index_invalid');
  }
  return idx.index;
}

export async function resolvePurgeKeys(
  io: IoContext,
  config: RsiConfigOn,
  mode: PurgeMode,
): Promise<{ keys: string[]; notExcluded: boolean }> {
  if (mode.kind === 'resume') throw new RsiFailClosedError('internal');
  const index = await usableIndex(io);
  const classify = await classifierFor(io, config);
  let hit = index.entries.map((e) => e.key);
  if (mode.kind === 'project') {
    const dir = fold(await canonical(mode.path));
    const roots = new Map<string, string[]>();
    for (const e of index.entries)
      roots.set(
        e.key,
        e.roots.map((r) => r.path),
      );
    const hits: string[] = [];
    for (const [key, paths] of roots) {
      for (const p of paths) {
        if (within(dir, fold(await canonical(p)))) {
          hits.push(key);
          break;
        }
      }
    }
    hit = hits;
  }
  const keys = [...new Set(hit)].sort();
  if (mode.kind === 'excluded') {
    const xs: string[] = [];
    for (const k of keys) if ((await classify(k)) === 'X') xs.push(k);
    return { keys: xs, notExcluded: false };
  }
  for (const k of keys) {
    if ((await classify(k)) !== 'X') return { keys, notExcluded: true };
  }
  return { keys, notExcluded: false };
}

export async function planPurgeTargets(
  io: IoContext,
  keys: readonly string[],
): Promise<PurgeTargets> {
  const kset = new Set(keys);
  const runIds = (await listStaging(io, 'run')).sort();
  const evidence = new Map<string, Set<string>>();
  const needed = new Set<string>();
  for (const id of runIds) {
    const ev = await readRunEvidence(io, id);
    if (!ev.exists) continue;
    evidence.set(id, ev.sigs);
    for (const s of ev.sigs) needed.add(s);
  }
  const sigKeys = await loadSigKeys(io, needed);
  const runs: string[] = [];
  for (const [id, sigs] of evidence) {
    for (const s of sigs) {
      const k = sigKeys.get(s);
      if (k !== undefined && kset.has(k)) {
        runs.push(id);
        break;
      }
    }
  }
  const runSet = new Set(runs);
  const promotes: string[] = [];
  for (const id of (await listStaging(io, 'promote')).sort()) {
    const linked = await promoteRunId(io, id);
    if (linked !== undefined && runSet.has(linked) && isStagingId(id, 'promote')) promotes.push(id);
  }
  return { keys: [...kset].sort(), runs: runs.sort(), promotes };
}

async function countStore(
  io: IoContext,
  kind: 'signals' | 'sessions',
  kset: ReadonlySet<string>,
): Promise<number> {
  let n = 0;
  for (const file of await listMonthFiles(io, kind)) {
    await scanMonthFile(file, (_raw, v) => {
      const k = projectKeyOf(v);
      if (k === null) return false;
      if (kset.has(k)) n++;
      return true;
    });
  }
  return n;
}

export async function countPurge(io: IoContext, keys: readonly string[]): Promise<PurgeCounts> {
  const kset = new Set(keys);
  const signals = await countStore(io, 'signals', kset);
  const sessionRows = await countStore(io, 'sessions', kset);
  let cursorEntries = 0;
  const c = await readRsiFixed(io, 'cursor.json');
  if (c.kind === 'ok') {
    let cursor;
    try {
      cursor = RsiCursorSchema.parse(JSON.parse(c.bytes.toString('utf8')));
    } catch {
      throw new RsiFailClosedError('cursor_invalid');
    }
    for (const f of Object.values(cursor.files)) {
      if (f.project_key !== null && kset.has(f.project_key)) cursorEntries++;
    }
  }
  let indexEntries = 0;
  const idx = await readIndex(io);
  if (idx.kind === 'ok') indexEntries = idx.index.entries.filter((e) => kset.has(e.key)).length;
  const targets = await planPurgeTargets(io, keys);
  return {
    signals,
    sessionRows,
    cursorEntries,
    indexEntries,
    runs: targets.runs.length,
    promotes: targets.promotes.length,
  };
}

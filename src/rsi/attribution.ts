/**
 * 项目归属的现算(契约 R20-4.3 / R20-4.4 / R20-4.6;R20-A2 B3a + 统一)。**唯一的 P / X / U 分类实现**:`rsi status`、`rsi projects`(展示)与
 * 暂存区即时闸、taint(隐私路径,经 `services/attribution.ts` 的 `classifierFor`)共用,B4 的 L0 / hint 也应复用。
 * 只读(read-fs 的 stat / lstat / realpath),**每次调用现算**:缓存只活在一个分类器实例内(同一路径的探测只做一次),
 * 不跨调用、不落盘——写下排除后的下一次调用即生效。
 *
 * 决策表(优先级 X > U > P;先命中先算;一个 key 恰好落入一类):
 *  | 条件                                                                                              | 类 |
 *  | ------------------------------------------------------------------------------------------------- | -- |
 *  | key 不在索引里(含索引缺失 / 损坏:此时没有任何条目)                                              | U  |
 *  | 该 key 的**任一**根路径命中排除规则(R20-4.4;根已不存在也照算;**与盐是否相符无关**)              | X  |
 *  | `salt_fp` 无法与 `counts.json` 核对(counts 缺失 / 损坏)或两者不符                                  | U  |
 *  | 所有根路径都已不存在(lstat 均失败)                                                                | U  |
 *  | 最近一次见到的根(`last_seen` 最大,并列取数组里靠后的)现在的 `realpath` 与记录不逐字节相等 / 不存在 | U  |
 *  | 该根现在的 `(dev, ino)` ≠ 记录                                                                    | U  |
 *  | 其余                                                                                              | P  |
 * 证据集合:索引条目、`counts.per_key` 的 key、暂存 run 与聚类证据里的 key(含字面量 `?`)都经 `classify`:不在索引里的一律 U。
 *
 * 排除比较(R20-4.4):排除项与根路径先 `canonical()`,比较时折叠大小写;`exclude_dirs` = 根路径等于排除路径或位于其下(按 `/` 段边界);
 * `exclude_names` = 任一根路径**canonical 之后**的 basename 等于该名字;排除路径当前存在时,根路径的任一祖先(含自身)的 `(dev, ino)` 与之相同也算命中。
 * 非绝对路径的排除项(`block = exclude_invalid`)不参与目录比较(无法 canonical),名字项照常。
 */
import * as path from 'node:path';
import type { RsiCounts, RsiProjectIndex } from '../contracts/rsi.js';
import { lstat, realpath, stat } from '../io/read-fs.js';
import { canonical } from '../signals/exclude.js';
import type { RsiConfigOn } from './config.js';

export type Attribution = 'P' | 'X' | 'U';

/** fs 探测的注入点(测试用);缺省是 read-fs */
export interface AttributionProbe {
  exists(p: string): Promise<boolean>;
  realpath(p: string): Promise<string | null>;
  devIno(p: string): Promise<{ dev: number; ino: number } | null>;
}

export const defaultProbe: AttributionProbe = {
  async exists(p) {
    try {
      await lstat(p);
      return true;
    } catch {
      return false;
    }
  },
  async realpath(p) {
    try {
      return await realpath(p);
    } catch {
      return null;
    }
  },
  async devIno(p) {
    try {
      const s = await stat(p);
      return { dev: s.dev, ino: s.ino };
    } catch {
      return null;
    }
  },
};

export type IndexStatus = 'ok' | 'absent' | 'invalid';

export interface AttributionInput {
  config: RsiConfigOn;
  indexStatus: IndexStatus;
  index: RsiProjectIndex | null;
  /** `counts.json`(缺失 / 损坏 = null):只用它的 `salt_fp` 与索引核对;null = 无法核对盐 → 非 X 的 key 一律 U */
  counts: Pick<RsiCounts, 'salt_fp'> | null;
  probe?: AttributionProbe;
}

export interface AttributionResult {
  /** 索引状态 ok(可读且过 schema);盐不符 / counts 缺失不改变它,只让非 X 的 key 变 U */
  indexUsable: boolean;
  /** 索引状态 ok 但盐指纹与 counts 不符(counts 缺失不算「不符」,见 {@link AttributionResult.saltVerified}) */
  saltMismatch: boolean;
  /** 索引 ok 且 counts 在、盐指纹相符 */
  saltVerified: boolean;
  /** 索引条目的类(索引不可用时为空 Map) */
  byKey: ReadonlyMap<string, Attribution>;
  /** 任意证据 key 的类:不在索引里 / 索引不可用 / 字面量 `?` 一律 U */
  classify(key: string): Attribution;
}

const fold = (s: string): string => s.toLowerCase();
const within = (dir: string, child: string): boolean =>
  child === dir || child.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

interface ExcludeSet {
  dirs: { folded: string; devIno: { dev: number; ino: number } | null }[];
  names: string[];
}

/** 惰性分类器:按 key 现算并在实例内记忆;`attribute()` 对全部条目调用它(批量),即时闸 / taint 只对用到的 key 调用 */
export interface Attributor {
  indexUsable: boolean;
  saltMismatch: boolean;
  saltVerified: boolean;
  classify(key: string): Promise<Attribution>;
}

export async function createAttributor(input: AttributionInput): Promise<Attributor> {
  const probe = input.probe ?? defaultProbe;
  const { config, index, counts } = input;
  const indexUsable = input.indexStatus === 'ok' && index !== null;
  const saltMismatch = indexUsable && counts !== null && index.salt_fp !== counts.salt_fp;
  const saltVerified = indexUsable && counts !== null && !saltMismatch;
  const entries = new Map(indexUsable ? index.entries.map((e) => [e.key, e]) : []);

  const canonCache = new Map<string, Promise<string>>();
  const canon = (p: string): Promise<string> => {
    let v = canonCache.get(p);
    if (v === undefined) {
      v = canonical(p);
      canonCache.set(p, v);
    }
    return v;
  };
  const inoCache = new Map<string, Promise<{ dev: number; ino: number } | null>>();
  const ino = (p: string): Promise<{ dev: number; ino: number } | null> => {
    let v = inoCache.get(p);
    if (v === undefined) {
      v = probe.devIno(p);
      inoCache.set(p, v);
    }
    return v;
  };

  const ex: ExcludeSet = { dirs: [], names: config.excludeNames.map(fold) };
  if (entries.size > 0) {
    for (const d of config.excludeDirs) {
      if (!d.startsWith('/')) continue;
      const c = await canon(d);
      ex.dirs.push({ folded: fold(c), devIno: await ino(c) });
    }
  }
  const anyDevIno = ex.dirs.some((d) => d.devIno !== null);

  const matchesExclude = async (rootPath: string): Promise<boolean> => {
    const c = await canon(rootPath);
    const f = fold(c);
    if (ex.dirs.some((d) => within(d.folded, f))) return true;
    if (ex.names.includes(fold(path.basename(c)))) return true;
    if (anyDevIno) {
      for (let cur = c; ; cur = path.dirname(cur)) {
        const di = await ino(cur);
        if (
          di !== null &&
          ex.dirs.some((d) => d.devIno?.dev === di.dev && d.devIno.ino === di.ino)
        ) {
          return true;
        }
        if (path.dirname(cur) === cur) break;
      }
    }
    return false;
  };

  const memo = new Map<string, Promise<Attribution>>();
  const compute = async (e: RsiProjectIndex['entries'][number]): Promise<Attribution> => {
    for (const r of e.roots) if (await matchesExclude(r.path)) return 'X';
    if (!saltVerified) return 'U';
    let anyExists = false;
    for (const r of e.roots) {
      if (await probe.exists(r.path)) {
        anyExists = true;
        break;
      }
    }
    if (!anyExists) return 'U';
    const latest = latestRoot(e.roots);
    const real = await probe.realpath(latest.path);
    const di = await probe.devIno(latest.path);
    return real !== latest.path || di === null || di.dev !== latest.dev || di.ino !== latest.ino
      ? 'U'
      : 'P';
  };
  return {
    indexUsable,
    saltMismatch,
    saltVerified,
    classify(key) {
      let hit = memo.get(key);
      if (hit === undefined) {
        const e = entries.get(key);
        hit = e === undefined ? Promise.resolve<Attribution>('U') : compute(e);
        memo.set(key, hit);
      }
      return hit;
    },
  };
}

export async function attribute(input: AttributionInput): Promise<AttributionResult> {
  const a = await createAttributor(input);
  const byKey = new Map<string, Attribution>();
  if (a.indexUsable && input.index !== null) {
    for (const e of input.index.entries) byKey.set(e.key, await a.classify(e.key));
  }
  return {
    indexUsable: a.indexUsable,
    saltMismatch: a.saltMismatch,
    saltVerified: a.saltVerified,
    byKey,
    classify: (key) => byKey.get(key) ?? 'U',
  };
}

/** 最近一次见到的根:`last_seen` 最大;并列取数组里靠后的 */
export function latestRoot<T extends { last_seen: string }>(roots: readonly T[]): T {
  let best = roots[0] as T;
  for (const r of roots) if (r.last_seen >= best.last_seen) best = r;
  return best;
}

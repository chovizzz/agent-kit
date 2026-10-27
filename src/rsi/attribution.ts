/**
 * 项目归属的现算(R20-4.3 / R20-4.4 / R20-4.6;R20-A2 B3a)。`rsi status`、`rsi projects` 共用,B4 的 L0 / hint 应复用同一实现。
 * 只读(read-fs 的 stat / lstat / realpath),**每次调用现算**:缓存只活在一次 {@link attribute} 调用内(同一路径的探测只做一次),
 * 不跨调用、不落盘——写下排除后的下一次调用即生效。
 *
 * 决策表(先命中先算;一个 key 恰好落入一类):
 *  | 条件                                                                                  | 类 |
 *  | ------------------------------------------------------------------------------------- | -- |
 *  | 索引缺失 / 损坏 / `salt_fp` 与 `counts.json` 的 `salt_fp` 不符(**两者都存在才比较**)    | U(整个索引不可用:任何 key,含已在索引里的,都按 U) |
 *  | key 不在索引里                                                                        | U  |
 *  | 该 key 的**任一**根路径命中排除规则(R20-4.4)                                          | X  |
 *  | 所有根路径都已不存在(lstat 均失败)                                                    | U  |
 *  | 最近一次见到的根(`last_seen` 最大,并列取数组里靠后的)现在的 `realpath` ≠ 记录路径    | U  |
 *  | 该根现在的 `(dev, ino)` ≠ 记录                                                        | U  |
 *  | 其余                                                                                  | P  |
 * 因此 X 优先于 U(排除命中时,即使身份校验同时失败也算 X);「索引不可用」优先于 X(此时 key 本身就不可信)。
 * 证据集合:索引条目、`counts.per_key` 的 key、暂存 run 与聚类证据里的 key(含字面量 `?`)都经 {@link AttributionResult.classify}:
 * 不在索引里的一律 U。
 *
 * 排除比较(R20-4.4):排除项与根路径先 `canonical()`,比较时折叠大小写;`exclude_dirs` = 根路径等于排除路径或位于其下(按 `/` 段边界);
 * `exclude_names` = 任一根路径的 basename 等于该名字;排除路径当前存在时,根路径的任一祖先(含自身)的 `(dev, ino)` 与之相同也算命中。
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
  /** `counts.json`(缺失 = null):只用它的 `salt_fp` 与索引核对 */
  counts: RsiCounts | null;
  probe?: AttributionProbe;
}

export interface AttributionResult {
  /** 索引是否可用于归属(状态 ok 且盐指纹不冲突) */
  indexUsable: boolean;
  /** 索引状态 ok 但盐指纹与 counts 不符 */
  saltMismatch: boolean;
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

export async function attribute(input: AttributionInput): Promise<AttributionResult> {
  const probe = input.probe ?? defaultProbe;
  const { config, index, counts } = input;
  const saltMismatch =
    input.indexStatus === 'ok' &&
    index !== null &&
    counts !== null &&
    index.salt_fp !== counts.salt_fp;
  const indexUsable = input.indexStatus === 'ok' && index !== null && !saltMismatch;
  const byKey = new Map<string, Attribution>();
  if (indexUsable && index !== null) {
    // 一次调用内的缓存
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
    for (const d of config.excludeDirs) {
      if (!d.startsWith('/')) continue;
      const c = await canon(d);
      ex.dirs.push({ folded: fold(c), devIno: await ino(c) });
    }
    const anyDevIno = ex.dirs.some((d) => d.devIno !== null);

    const matchesExclude = async (rootPath: string): Promise<boolean> => {
      const c = await canon(rootPath);
      const f = fold(c);
      if (ex.dirs.some((d) => within(d.folded, f))) return true;
      if (ex.names.includes(fold(path.basename(rootPath)))) return true;
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

    for (const e of index.entries) {
      let excluded = false;
      for (const r of e.roots) {
        if (await matchesExclude(r.path)) {
          excluded = true;
          break;
        }
      }
      if (excluded) {
        byKey.set(e.key, 'X');
        continue;
      }
      let anyExists = false;
      for (const r of e.roots) {
        if (await probe.exists(r.path)) {
          anyExists = true;
          break;
        }
      }
      if (!anyExists) {
        byKey.set(e.key, 'U');
        continue;
      }
      const latest = latestRoot(e.roots);
      const real = await probe.realpath(latest.path);
      const di = await probe.devIno(latest.path);
      byKey.set(
        e.key,
        real !== latest.path || di === null || di.dev !== latest.dev || di.ino !== latest.ino
          ? 'U'
          : 'P',
      );
    }
  }
  return {
    indexUsable,
    saltMismatch,
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

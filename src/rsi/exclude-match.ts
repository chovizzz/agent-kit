/**
 * 排除匹配的**唯一**实现(B3c-11 / R20-4.3;B4-0 冻结签名,B4a 从 `attribution.ts` 抽出、纯重构)。归属判定(`attribution.ts`)与采集策略(`l0/collect-policy.ts`)都调它。
 * 抽出来的 matcher **无条件**加载 `exclude_dirs`:`createAttributor` 只在索引非空时才加载(空索引下所有 key 本来就是 U),但判 cwd 不能这样——否则首次 L0 会漏掉全部目录排除。
 * 比较口径与 `signals/exclude.ts` 一致:最长已存在前缀的 realpath、`path.resolve` 折叠 `..`、去尾斜杠、不区分大小写、`(dev,ino)` 祖先匹配。
 * 规划侧闭包内:不得 import safe-fs / state-store / lock / snapshot。
 */
import * as path from 'node:path';
import { canonical } from '../signals/exclude.js';
import { defaultProbe, type AttributionProbe } from './attribution.js';
import type { RsiConfigOn } from './config.js';

export interface ExcludeMatcher {
  /** 项目根(绝对路径)是否落在任一 `exclude_dirs` 之内(含相等),或其目录名命中 `exclude_names` */
  matchesRoot(projectRoot: string): Promise<boolean>;
}

const fold = (s: string): string => s.toLowerCase();
const within = (dir: string, child: string): boolean =>
  child === dir || child.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

type DevIno = { dev: number; ino: number };

export async function createExcludeMatcher(
  config: RsiConfigOn,
  probe: AttributionProbe = defaultProbe,
): Promise<ExcludeMatcher> {
  const canonCache = new Map<string, Promise<string>>();
  const canon = (p: string): Promise<string> => {
    let v = canonCache.get(p);
    if (v === undefined) {
      v = canonical(p);
      canonCache.set(p, v);
    }
    return v;
  };
  const inoCache = new Map<string, Promise<DevIno | null>>();
  const ino = (p: string): Promise<DevIno | null> => {
    let v = inoCache.get(p);
    if (v === undefined) {
      v = probe.devIno(p);
      inoCache.set(p, v);
    }
    return v;
  };

  const names = config.excludeNames.map(fold);
  // 无条件加载:不看索引是否为空(首次 L0 的索引一定是空的)
  const dirs: { folded: string; devIno: DevIno | null }[] = [];
  for (const d of config.excludeDirs) {
    if (!d.startsWith('/')) continue; // 非绝对路径的排除项(block = exclude_invalid)无法 canonical,不参与目录比较
    const c = await canon(d);
    dirs.push({ folded: fold(c), devIno: await ino(c) });
  }
  const anyDevIno = dirs.some((d) => d.devIno !== null);

  return {
    async matchesRoot(projectRoot) {
      const c = await canon(projectRoot);
      const f = fold(c);
      if (dirs.some((d) => within(d.folded, f))) return true;
      if (names.includes(fold(path.basename(c)))) return true;
      if (anyDevIno) {
        for (let cur = c; ; cur = path.dirname(cur)) {
          const di = await ino(cur);
          if (
            di !== null &&
            dirs.some((d) => d.devIno?.dev === di.dev && d.devIno.ino === di.ino)
          ) {
            return true;
          }
          if (path.dirname(cur) === cur) break;
        }
      }
      return false;
    },
  };
}

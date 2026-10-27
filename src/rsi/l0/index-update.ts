/**
 * 项目索引更新(R20-4.2,B4 方案 §3.4;B4-0 冻结签名,B4c1 实现)。**纯函数**:是否可写(D7:索引 ok 且 `salt_fp` 与真实盐一致,或索引与 cursor 都缺失)由调用方判。
 * 合并:同 key 同 path 只更新 `last_seen`;roots 超 8 条保留最早一条加 `last_seen` 最近的 7 条;新 key 的 `first_indexed_generation` = `generation`;
 * 满 `RSI_INDEX_MAX_ENTRIES` 后新 key 不入索引;条目 `sessions` / `signals` 取 `perKey` 的重算结果;entries 按 key 升序。
 *
 * 细则(B4c1 订正,待并入契约):
 *  - `prev` 为空 → 用 `saltFp` 建新索引;`prev` 非空且 `prev.salt_fp !== saltFp` 是调用方违约(D7),抛 `RangeError`,不静默改写 `salt_fp`。
 *  - 观测按 (key, path) 升序处理,所以「满员后谁先入」是确定的;同一批里重复的观测等价于一条。
 *  - 同 key 同 path:`(dev, ino)` 与记录一致才更新 `last_seen`;不一致(目录被换过)**不动**这条根(不刷新 `last_seen`、不改记录的 `(dev, ino)`、
 *    不追加同路径的第二条根)——归属判定本来就据此把它判 U,只有 `--rebuild-index` 能重新认定,这里不自愈。
 *  - 同 key 不同 path:追加为新根(`first_seen = last_seen = today`),再按上面的规则收敛到 ≤ 8 条;「最早」= `first_seen` 最小(并列取数组里靠前的),
 *    其余按 `last_seen` 降序(并列取靠后的)取 7 条;保留下来的根在数组里的相对顺序不变。
 *  - 索引里存在、本次没被观测的条目:roots 原样保留,`sessions` / `signals` 同样取 `perKey`(`perKey` 是全量重算,缺席 = 0)。
 *  - 结果过 `RsiProjectIndexSchema`(输入不合规,例如非绝对路径,会抛;不产出写不出去的索引)。
 */
import {
  RSI_INDEX_MAX_ENTRIES,
  RsiProjectIndexSchema,
  type RsiProjectIndex,
} from '../../contracts/rsi.js';
import type { UpdateIndexInput, UpdateIndexResult } from './types.js';

type Entry = RsiProjectIndex['entries'][number];
type Root = Entry['roots'][number];

const MAX_ROOTS = 8;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 超过 8 条时保留最早一条 + `last_seen` 最近的 7 条;保留项维持数组里的相对顺序 */
function trimRoots(roots: readonly Root[]): Root[] {
  if (roots.length <= MAX_ROOTS) return [...roots];
  let earliest = 0;
  roots.forEach((r, i) => {
    if (r.first_seen < (roots[earliest] as Root).first_seen) earliest = i;
  });
  const rest = roots
    .map((r, i) => ({ r, i }))
    .filter((x) => x.i !== earliest)
    .sort((a, b) => cmp(b.r.last_seen, a.r.last_seen) || b.i - a.i)
    .slice(0, MAX_ROOTS - 1);
  const keep = new Set<number>([earliest, ...rest.map((x) => x.i)]);
  return roots.filter((_, i) => keep.has(i));
}

export function updateIndex(input: UpdateIndexInput): UpdateIndexResult {
  const { prev, observations, perKey, saltFp, generation, today } = input;
  if (prev !== null && prev.salt_fp !== saltFp) {
    throw new RangeError('updateIndex: prev.salt_fp 与真实盐指纹不符(调用方应先按 D7 判可写)');
  }
  const byKey = new Map<string, Entry>();
  for (const e of prev?.entries ?? []) {
    byKey.set(e.key, { ...e, roots: e.roots.map((r) => ({ ...r })) });
  }

  const obs = [...observations].sort((a, b) => cmp(a.key, b.key) || cmp(a.path, b.path));
  const newKeys = new Set<string>();
  let full = false;
  for (const o of obs) {
    const existing = byKey.get(o.key);
    if (existing === undefined) {
      if (byKey.size >= RSI_INDEX_MAX_ENTRIES) {
        full = true;
        continue;
      }
      byKey.set(o.key, {
        key: o.key,
        roots: [{ path: o.path, dev: o.dev, ino: o.ino, first_seen: today, last_seen: today }],
        sessions: 0,
        signals: 0,
        first_indexed_generation: generation,
      });
      newKeys.add(o.key);
      continue;
    }
    const same = existing.roots.find((r) => r.path === o.path);
    if (same !== undefined) {
      if (same.dev === o.dev && same.ino === o.ino) same.last_seen = today;
      continue;
    }
    existing.roots = trimRoots([
      ...existing.roots,
      { path: o.path, dev: o.dev, ino: o.ino, first_seen: today, last_seen: today },
    ]);
  }

  const entries = [...byKey.values()]
    .sort((a, b) => cmp(a.key, b.key))
    .map((e) => ({
      ...e,
      sessions: perKey[e.key]?.sessions ?? 0,
      signals: perKey[e.key]?.signals_total ?? 0,
    }));
  const index = RsiProjectIndexSchema.parse({
    schema_version: 1,
    salt_fp: saltFp,
    generation,
    entries,
  });
  return { index, full, newKeys: [...newKeys].sort() };
}

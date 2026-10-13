/**
 * 证据包:别名 e1..eN / P1..Pk(映射只留在进程内)、条数上限、只含设计 §③ 允许的字段。
 * 只有「非外部、非失败结果、摘录非空」的 user_message / tool_call 能成为证据。
 */
import type { Cluster, EvidenceItem, ExistingAtomInfo, LoadedSignal } from './types.js';

export const DEFAULT_MAX_EVIDENCE = 40;
export const HARD_MAX_EVIDENCE = 120;
export const MAX_EXISTING_ATOMS_IN_PROMPT = 200;
export const PER_CLUSTER_EVIDENCE = 5;

export function isEvidenceEligible(s: LoadedSignal): boolean {
  return (
    !s.external_content &&
    s.event_kind !== 'tool_result_failed' &&
    s.excerpt_redacted !== '' &&
    (s.event_kind === 'user_message' || s.event_kind === 'tool_call')
  );
}

export interface EvidencePack {
  /** 按别名顺序 */
  items: EvidenceItem[];
  /** 进入提示的聚类(含各自入选的证据别名) */
  clusters: { cluster: Cluster; aliases: string[] }[];
  /** 因条数上限被丢掉的合格证据数 */
  truncated: number;
  existing: Pick<ExistingAtomInfo, 'id' | 'title' | 'layer' | 'status' | 'signatureType'>[];
}

export function buildEvidencePack(
  clusters: readonly Cluster[],
  existing: readonly ExistingAtomInfo[],
  opts: { maxEvidence?: number } = {},
): EvidencePack {
  const max = Math.min(opts.maxEvidence ?? DEFAULT_MAX_EVIDENCE, HARD_MAX_EVIDENCE);
  const projectAlias = new Map<string, string>();
  const items: EvidenceItem[] = [];
  const picked: { cluster: Cluster; aliases: string[] }[] = [];
  const taken = new Set<string>();
  let truncated = 0;
  for (const c of clusters) {
    const aliases: string[] = [];
    const eligible = c.members.filter(isEvidenceEligible);
    for (const s of eligible) {
      if (taken.has(s.sig_id)) continue;
      if (aliases.length >= PER_CLUSTER_EVIDENCE || items.length >= max) {
        truncated++;
        continue;
      }
      taken.add(s.sig_id);
      if (!projectAlias.has(s.project_key))
        projectAlias.set(s.project_key, `P${projectAlias.size + 1}`);
      const alias = `e${items.length + 1}`;
      items.push({
        alias,
        signal: s,
        clusterId: c.id,
        projectAlias: projectAlias.get(s.project_key) as string,
      });
      aliases.push(alias);
    }
    if (aliases.length > 0) picked.push({ cluster: c, aliases });
  }
  const ex = [...existing]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_EXISTING_ATOMS_IN_PROMPT)
    .map((a) => ({
      id: a.id,
      title: a.title,
      layer: a.layer,
      status: a.status,
      signatureType: a.signatureType,
    }));
  return { items, clusters: picked, truncated, existing: ex };
}

/** 去掉最后一条证据(提示超限时用);返回新包,聚类里没有证据的组一并去掉。 */
export function dropLastEvidence(pack: EvidencePack): EvidencePack {
  const last = pack.items[pack.items.length - 1];
  if (last === undefined) return pack;
  const clusters = pack.clusters
    .map((c) => ({ cluster: c.cluster, aliases: c.aliases.filter((a) => a !== last.alias) }))
    .filter((c) => c.aliases.length > 0);
  return { ...pack, items: pack.items.slice(0, -1), clusters, truncated: pack.truncated + 1 };
}

/** 按 `per` 条证据一批切分(整组聚类尽量不拆);每批都带完整的已有规则索引。 */
export function splitPack(pack: EvidencePack, per: number): EvidencePack[] {
  if (pack.items.length === 0) return [];
  const batches: { cluster: Cluster; aliases: string[] }[][] = [];
  let cur: { cluster: Cluster; aliases: string[] }[] = [];
  let n = 0;
  for (const c of pack.clusters) {
    if (n > 0 && n + c.aliases.length > per) {
      batches.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(c);
    n += c.aliases.length;
  }
  if (cur.length > 0) batches.push(cur);
  return batches.map((clusters) => {
    const keep = new Set(clusters.flatMap((c) => c.aliases));
    return {
      items: pack.items.filter((i) => keep.has(i.alias)),
      clusters,
      truncated: 0,
      existing: pack.existing,
    };
  });
}

/**
 * 聚类(确定性):把分类结果分成「证据组」,并**由本模块计算**会话数/项目数——
 * 支持次数只在合并器侧算,LLM 输出里不允许出现这类数字(ReflectorOutputSchema 是 strict,没有这类字段)。
 */
import { jaccard, tokenSet } from './text.js';
import type { Classification } from './classify.js';
import type { Cluster, LoadedSignal } from './types.js';

export interface ClusterOptions {
  /** 两条显式教训归为一组的 token Jaccard 下限 */
  lessonJaccard?: number;
  /** tool_fail_retry 至少要出现在几个会话才入选 */
  minRetrySessions?: number;
  /** 显式教训至少要出现在几个会话才入选 */
  minLessonSessions?: number;
}

export const DEFAULT_LESSON_JACCARD = 0.5;
export const DEFAULT_MIN_RETRY_SESSIONS = 2;
export const DEFAULT_MIN_LESSON_SESSIONS = 1;

function countDistinct(list: readonly LoadedSignal[], key: (s: LoadedSignal) => string): number {
  return new Set(list.map(key)).size;
}

const bySigId = (a: LoadedSignal, b: LoadedSignal): number =>
  a.sig_id < b.sig_id ? -1 : a.sig_id > b.sig_id ? 1 : 0;

export function buildClusters(cls: Classification, opts: ClusterOptions = {}): Cluster[] {
  const threshold = opts.lessonJaccard ?? DEFAULT_LESSON_JACCARD;
  const minRetry = opts.minRetrySessions ?? DEFAULT_MIN_RETRY_SESSIONS;
  const minLesson = opts.minLessonSessions ?? DEFAULT_MIN_LESSON_SESSIONS;
  const raw: Omit<Cluster, 'id'>[] = [];

  // 1) 显式教训:按 sig_id 排序后贪心,与每组第一个成员比较 → 结果与输入顺序无关
  const groups: { rep: Set<string>; members: LoadedSignal[] }[] = [];
  for (const s of [...cls.lessons].sort(bySigId)) {
    const toks = tokenSet(s.excerpt_redacted);
    const g = groups.find((x) => jaccard(x.rep, toks) >= threshold);
    if (g) g.members.push(s);
    else groups.push({ rep: toks, members: [s] });
  }
  for (const g of groups) {
    const sessions = countDistinct(g.members, (s) => s.session_ref);
    if (sessions < minLesson) continue;
    // 只靠弱标记的组需要跨会话佐证,单次的「务必/一定要」多半是一次性任务指令
    if (g.members.every((m) => cls.weakLessonIds.has(m.sig_id)) && sessions < 2) continue;
    const projects = countDistinct(g.members, (s) => s.project_key);
    raw.push({
      kind: 'explicit_lesson',
      tool: undefined,
      members: g.members,
      allSignals: g.members,
      sessions,
      projects,
      failures: 0,
      teamEligible: sessions >= 2 && projects >= 2,
    });
  }

  // 2) 失败后重试:按工具名;证据只取重试调用(失败结果的摘录永不进提示,只计数)
  const byTool = new Map<string, Classification['retryPairs']>();
  for (const p of cls.retryPairs) {
    const tool = p.failure.tool_name as string;
    byTool.set(tool, [...(byTool.get(tool) ?? []), p]);
  }
  for (const [tool, pairs] of [...byTool.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const all = new Map<string, LoadedSignal>();
    for (const p of pairs) {
      all.set(p.failure.sig_id, p.failure);
      all.set(p.retry.sig_id, p.retry);
    }
    const allSignals = [...all.values()].sort(bySigId);
    const sessions = countDistinct(allSignals, (s) => s.session_ref);
    if (sessions < minRetry) continue;
    const members = [...new Map(pairs.map((p) => [p.retry.sig_id, p.retry])).values()]
      .filter((s) => s.excerpt_redacted !== '')
      .sort(bySigId);
    const projects = countDistinct(allSignals, (s) => s.project_key);
    raw.push({
      kind: 'tool_fail_retry',
      tool,
      members,
      allSignals,
      sessions,
      projects,
      failures: new Set(pairs.map((p) => p.failure.sig_id)).size,
      teamEligible: sessions >= 2 && projects >= 2,
    });
  }

  raw.sort(
    (a, b) =>
      b.projects - a.projects ||
      b.sessions - a.sessions ||
      b.allSignals.length - a.allSignals.length ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
      (a.members[0]?.sig_id ?? '').localeCompare(b.members[0]?.sig_id ?? ''),
  );
  return raw.map((c, i) => ({ ...c, id: `c${i + 1}` }));
}

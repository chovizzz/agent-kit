/**
 * 分层合并器(设计 §3.5,确定性,非 LLM)。
 *
 * 权威顺序 org > team > personal > project(LAYER_RANK,数字越小越权威)。
 * 规则 → 诊断码:
 *  1. must 由上层锁定:下层(含同层)对 must 的 overrides / disables → MERGE_MUST_LOCKED
 *  2. should 可被下层 overrides 替换,或被 personal / project 层 disables 关闭;其余层写 disables → MERGE_DISABLE_NOT_ALLOWED
 *  3. 同一 id 出现多次且没有声明 overrides → MERGE_DUPLICATE_ID(同层重复永远报错,没有「就近」可言)
 *  4. 语义矛盾由裁判出建议性报告,不在这里处理
 *  5. personal 原子留在结果里,但 coreEligible=false(渲染器必须跳过);它的 overrides / disables 在 core 视图里只记录、不剔除(B2)
 *  6. 只采纳 status 为 active / advisory 的声明者发出的 overrides / disables(GD-1 根因):proposed / deprecated / retired
 *     声明者的边照常做全部校验(诊断、环检测不变),但不剔除目标、不记 replaced、不进 overridden。同 id 的替换件若是这类
 *     声明者,它自己也不进结果(否则两份同 id 原子一起幸存,渲染层按 id 索引会被后者盖住);等它转 active / advisory 才接管。
 *     这种被丢弃的同 id 替换给一条 warn 级 MERGE_REPLACEMENT_INERT(不是 error,不改变放行/拒绝)。
 * 其它防御性诊断:MERGE_TARGET_MISSING(目标不存在)、MERGE_OVERRIDE_DIRECTION(上层去覆盖下层)、MERGE_OVERRIDE_CYCLE(overrides / disables 互相成环)。
 *
 * 语义说明:
 *  - 所有声明过的 overrides / disables 都生效,与声明者自己是否又被别人替换无关
 *    (B 替换了 A、C 又替换了 B,则 A、B 都不在结果里,A 不会「复活」)。
 *  - 上层(org/team)没有移除下层原子的通路:disables 只许 personal / project,overrides 只许指向同层或更上层。
 *  - 同层覆盖 must 也拒绝,是对「上层锁定」的有意收紧(设计只写了下层对上层)。
 * 出现 error 时仍返回尽力而为的结果,调用方必须用 hasErrors 判断是否可继续渲染。
 */
import type { Atom, Layer } from '../contracts/atom.js';
import { LAYER_RANK } from '../contracts/atom.js';
import { sortDiagnostics } from '../contracts/diagnostics.js';
import type { Diagnostic } from '../contracts/diagnostics.js';
import type { MergeResult, OverrideRecord, ResolvedAtom } from '../contracts/merge.js';

/** 只有这些层可以写 `disables`(设计 §3.5-2)。 */
export const DISABLE_LAYERS: readonly Layer[] = ['personal', 'project'];

/** P0 决策 a:personal 层不得进入 core 输出。 */
export function isCoreEligible(layer: Layer): boolean {
  return layer !== 'personal';
}

const byteCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const diag = (code: string, path: string, message: string): Diagnostic => ({
  code,
  severity: 'error',
  path,
  message,
});

interface Edge {
  from: Atom;
  to: Atom;
  kind: 'overrides' | 'disables';
}

/** 只有这些 status 的声明者发出的边会被采纳(GD-1)。 */
export const EDGE_ADOPTING_STATUSES: readonly Atom['fm']['status'][] = ['active', 'advisory'];

const adoptsEdges = (a: Atom): boolean => EDGE_ADOPTING_STATUSES.includes(a.fm.status);

const rank = (a: Atom): number => LAYER_RANK[a.fm.layer];
const key = (a: Atom): string => `${a.fm.layer}/${a.fm.id}`;

export interface MergeOptions {
  /**
   * `core`(默认):结果用于渲染 out/,personal 层的 overrides / disables 只记录、不剔除任何原子
   * (core 输出必须与个人无关且确定;docs/contracts.md §4.2)。
   * `preview`:personal 的边也生效,供 P2 本机预览;P0 没有调用方。
   */
  view?: 'core' | 'preview';
}

export function mergeAtoms(input: readonly Atom[], opts: MergeOptions = {}): MergeResult {
  const view = opts.view ?? 'core';
  const diagnostics: Diagnostic[] = [];
  const atoms = [...input].sort(
    (a, b) => rank(a) - rank(b) || byteCmp(a.fm.id, b.fm.id) || byteCmp(a.sourcePath, b.sourcePath),
  );
  const byId = new Map<string, Atom[]>();
  for (const a of atoms) byId.set(a.fm.id, [...(byId.get(a.fm.id) ?? []), a]);

  // 规则 3:同 id 重复
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    group.forEach((a, i) => {
      if (i === 0) return;
      const prev = group[i - 1] as Atom;
      if (rank(a) === rank(prev)) {
        diagnostics.push(
          diag(
            'MERGE_DUPLICATE_ID',
            a.sourcePath,
            `id「${id}」在 ${a.fm.layer} 层重复(另一处:${prev.sourcePath}),同层不允许`,
          ),
        );
      } else if (!(a.fm.overrides ?? []).includes(id)) {
        diagnostics.push(
          diag(
            'MERGE_DUPLICATE_ID',
            a.sourcePath,
            `id「${id}」同时出现在 ${prev.fm.layer} 与 ${a.fm.layer} 层,且 ${a.fm.layer} 层没有声明 overrides: [${id}]`,
          ),
        );
      }
    });
  }

  // 规则 1/2:收集 overrides / disables 边
  const edges: Edge[] = [];
  for (const a of atoms) {
    const requests: { id: string; kind: Edge['kind'] }[] = [
      ...(a.fm.overrides ?? []).map((id) => ({ id, kind: 'overrides' as const })),
      ...(a.fm.disables ?? []).map((id) => ({ id, kind: 'disables' as const })),
    ];
    for (const { id, kind } of requests) {
      const path = `${a.sourcePath}#/${kind}`;
      if (kind === 'disables' && !DISABLE_LAYERS.includes(a.fm.layer)) {
        diagnostics.push(
          diag(
            'MERGE_DISABLE_NOT_ALLOWED',
            path,
            `${a.fm.layer} 层不能 disables(只有 personal / project 层可以):${id}`,
          ),
        );
        continue;
      }
      const others = (byId.get(id) ?? []).filter((t) => t !== a);
      // 同 id 出现在多层时,比自己更下层的同 id 原子不是目标(它们要自己声明去覆盖上层)
      const upper = others.filter((t) => rank(t) <= rank(a));
      const targets = upper.length > 0 ? upper : others;
      if (targets.length === 0) {
        diagnostics.push(diag('MERGE_TARGET_MISSING', path, `${kind} 的目标「${id}」不存在`));
        continue;
      }
      for (const t of targets) {
        if (rank(t) > rank(a)) {
          diagnostics.push(
            diag(
              'MERGE_OVERRIDE_DIRECTION',
              path,
              `${a.fm.layer} 层不能 ${kind} 更下层(${t.fm.layer})的「${id}」`,
            ),
          );
        } else if (t.fm.strength === 'must') {
          diagnostics.push(
            diag(
              'MERGE_MUST_LOCKED',
              path,
              `「${id}」是 ${t.fm.layer} 层的 must 原子,${a.fm.layer} 层不能 ${kind}(只能新增 must 来收紧)`,
            ),
          );
        } else if (rank(t) === rank(a) && t.fm.id === a.fm.id) {
          // 同层同 id 已在规则 3 里报过,不再构成边
        } else {
          edges.push({ from: a, to: t, kind });
        }
      }
    }
  }

  // 环:A overrides B 且 B overrides A,会让两者都被删
  const adj = new Map<Atom, Atom[]>();
  for (const e of edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  const cyclic = new Set<Atom>();
  const state = new Map<Atom, 1 | 2>();
  const stack: Atom[] = [];
  const visit = (n: Atom): void => {
    state.set(n, 1);
    stack.push(n);
    for (const m of adj.get(n) ?? []) {
      if (state.get(m) === 1) {
        for (const x of stack.slice(stack.indexOf(m))) cyclic.add(x);
      } else if (state.get(m) === undefined) visit(m);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of adj.keys()) if (state.get(n) === undefined) visit(n);
  for (const n of [...cyclic].sort((a, b) => byteCmp(key(a), key(b)))) {
    diagnostics.push(
      diag(
        'MERGE_OVERRIDE_CYCLE',
        n.sourcePath,
        `「${n.fm.id}」参与了 overrides 环,无法确定谁替换谁(该原子的所有 overrides / disables 均不生效)`,
      ),
    );
  }
  // 环上原子的一切替换/关闭边都作废(带 error 的原子不得行使替换权),交人工处理
  const live = edges.filter((e) => !cyclic.has(e.from));

  // GD-1:status 不是 active / advisory 的声明者,边只校验不应用(不剔除、不记 replaced、不进 overridden)
  const adopted = live.filter((e) => adoptsEdges(e.from));
  // B2:core 视图里 personal 的边不剔除任何原子(它们仍进 overridden / replaced,诊断照常)
  const removed = new Set<Atom>(
    adopted.filter((e) => view === 'preview' || isCoreEligible(e.from.fm.layer)).map((e) => e.to),
  );
  const replacedBy = new Map<Atom, string[]>();
  const overridden: OverrideRecord[] = [];
  for (const e of adopted) {
    if (e.kind === 'overrides') {
      replacedBy.set(e.from, [...(replacedBy.get(e.from) ?? []), e.to.fm.id]);
    }
    overridden.push({ id: e.to.fm.id, by: e.from.fm.id, kind: e.kind, byLayer: e.from.fm.layer });
  }
  overridden.sort((a, b) => byteCmp(a.id, b.id) || byteCmp(a.by, b.by) || byteCmp(a.kind, b.kind));

  // B2:core 视图下,personal 用同 id 覆盖时两者都活着;渲染层按 id 建索引(后者覆盖前者),personal 会盖住 team 原子并触发
  // OUT_PERSONAL_LEAK。所以 core 视图里与别的幸存原子同 id 的 personal 原子不进 atoms(边仍记在 overridden,preview 视图照旧保留)。
  const survivorsAll = atoms.filter((a) => !removed.has(a));
  // GD-1:同 id 的 overrides 因声明者 status 不合格而没被采纳,且被指向的上层原子仍在 → 声明者不进结果
  const inertEdges = live.filter(
    (e) =>
      e.kind === 'overrides' &&
      e.from.fm.id === e.to.fm.id &&
      !adoptsEdges(e.from) &&
      !removed.has(e.to),
  );
  const inertReplacements = new Set<Atom>(inertEdges.map((e) => e.from));
  // 被丢弃的同 id 替换不能静默:warn 级提示(契约的 severity 只有 error / warn,没有 info),不影响放行/拒绝
  for (const e of inertEdges) {
    diagnostics.push({
      code: 'MERGE_REPLACEMENT_INERT',
      severity: 'warn',
      path: `${e.from.sourcePath}#/overrides`,
      message:
        `原子「${e.from.fm.id}」的同 id 替换因声明者 status 为 ${e.from.fm.status} 未生效` +
        `(${e.to.fm.layer} 层原子保持有效;晋升为 active / advisory 后才接管)`,
    });
  }
  const survivors = survivorsAll.filter((a) => !inertReplacements.has(a));
  const survivingIds = new Set(
    survivors.filter((a) => isCoreEligible(a.fm.layer)).map((a) => a.fm.id),
  );
  const resolved: ResolvedAtom[] = survivors
    .filter((a) => view === 'preview' || isCoreEligible(a.fm.layer) || !survivingIds.has(a.fm.id))
    .map((a) => ({
      atom: a,
      layer: a.fm.layer,
      coreEligible: isCoreEligible(a.fm.layer),
      replaced: [...new Set(replacedBy.get(a) ?? [])].sort(byteCmp),
    }));

  return { atoms: resolved, overridden, diagnostics: sortDiagnostics(diagnostics) };
}

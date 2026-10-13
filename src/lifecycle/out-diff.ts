/**
 * `out/` 进出清单(L4,设计稿 §3.1-7;docs/contracts.md:1782、docs/release-checklist.md:33 要求写进 PR 描述):
 * 对 base / head 两份原子集各跑一次「合并 + 渲染」(纯内存,不写 `out/`),列出进 / 出 `out/` 的原子 id 与输出文件。
 *
 * - 两个渠道(canary / stable)各算一遍:advisory 只在 canary 渲染,active 全渠道,所以 advisory→active 的影响主要在 stable。
 * - 只比原子带来的差异:技能 / 子代理与原子状态无关,两侧都传空集合,不影响差异。
 * - 手写原子带 `overrides` / `disables` 时,声明者转 advisory / active 才让边生效(合并器 GD-1),被压住的原子会从 `out/` 消失 / 复活——
 *   这正是本清单要机械列出的东西。
 * - 任何一步失败(原子解析不了、合并有 error、渲染失败)抛 `OutDiffError`(稳定码),调用方 fail-closed,不写半截清单。
 */
import { createHash } from 'node:crypto';
import { parseAtom } from '../atoms/parse.js';
import { budgetFailed, computeBudget } from '../budget/budget.js';
import type { Atom } from '../contracts/atom.js';
import type { ChannelName, KitConfig } from '../contracts/config.js';
import { hasErrors } from '../contracts/diagnostics.js';
import { mergeAtoms } from '../merge/merge.js';
import { RenderCoreError, renderAll } from '../render/core.js';
import { byteCompare, outKey } from '../render/out-layout.js';
import { createRegistry, defaultRegistry } from '../render/registry.js';

export class OutDiffError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** 一份原子集合的来源:仓库相对路径 + 文本。 */
export interface AtomSource {
  path: string;
  text: string;
}

export const OUT_CHANNELS: readonly ChannelName[] = ['canary', 'stable'];

export interface ChannelDiff {
  channel: ChannelName;
  /** 进入 `out/` 的原子 id(base 没有渲染、head 渲染了) */
  atomsIn: string[];
  /** 离开 `out/` 的原子 id */
  atomsOut: string[];
  /** 新增 / 删除 / 内容变化的输出文件(`<agent>/<target>/<relPath>`) */
  filesAdded: string[];
  filesRemoved: string[];
  filesChanged: string[];
}

export interface OutDiff {
  channels: ChannelDiff[];
  /** head 侧(canary 渠道)预算是否会阻断;base 侧本来就阻断则不算本次引入 */
  budgetBlockedByChange: boolean;
}

interface Side {
  files: Map<string, string>;
  atoms: Set<string>;
  budgetBlocked: boolean;
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function parseAll(sources: readonly AtomSource[]): Atom[] {
  const atoms: Atom[] = [];
  for (const s of sources) {
    const res = parseAtom(s.text, s.path);
    if (res.atom === undefined) throw new OutDiffError('ATOM_UNPARSABLE');
    atoms.push(res.atom);
  }
  return atoms;
}

function renderSide(atoms: readonly Atom[], config: KitConfig, channel: ChannelName): Side {
  const merge = mergeAtoms(atoms);
  if (hasErrors(merge.diagnostics)) throw new OutDiffError('MERGE_FAILED');
  const registry = createRegistry(
    defaultRegistry.list().filter((a) => (config.agents.enabled as string[]).includes(a.agent)),
  );
  let rendered;
  try {
    rendered = renderAll(
      {
        resolved: merge.atoms,
        skills: [],
        agents: [],
        kitVersion: config.kit.version,
        channel,
      },
      registry,
    );
  } catch (e) {
    throw new OutDiffError(e instanceof RenderCoreError ? `RENDER_${e.code}` : 'RENDER_FAILED');
  }
  const files = new Map<string, string>();
  const ids = new Set<string>();
  for (const f of rendered.files) {
    files.set(outKey(f), sha(f.content));
    for (const id of f.atomIds) ids.add(id);
  }
  const budget = computeBudget({ outputs: rendered.files, config: config.budget });
  return { files, atoms: ids, budgetBlocked: budgetFailed(budget) };
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort(byteCompare);

export function computeOutDiff(input: {
  base: readonly AtomSource[];
  head: readonly AtomSource[];
  config: KitConfig;
}): OutDiff {
  const baseAtoms = parseAll(input.base);
  const headAtoms = parseAll(input.head);
  const channels: ChannelDiff[] = [];
  let budgetBlockedByChange = false;
  for (const channel of OUT_CHANNELS) {
    const b = renderSide(baseAtoms, input.config, channel);
    const h = renderSide(headAtoms, input.config, channel);
    channels.push({
      channel,
      atomsIn: sorted([...h.atoms].filter((id) => !b.atoms.has(id))),
      atomsOut: sorted([...b.atoms].filter((id) => !h.atoms.has(id))),
      filesAdded: sorted([...h.files.keys()].filter((k) => !b.files.has(k))),
      filesRemoved: sorted([...b.files.keys()].filter((k) => !h.files.has(k))),
      filesChanged: sorted(
        [...h.files.entries()]
          .filter(([k, v]) => b.files.has(k) && b.files.get(k) !== v)
          .map(([k]) => k),
      ),
    });
    if (h.budgetBlocked && !b.budgetBlocked) budgetBlockedByChange = true;
  }
  return { channels, budgetBlockedByChange };
}

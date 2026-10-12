import { describe, expect, it } from 'vitest';
import { buildManifest, ManifestDuplicateAtomError } from '../../src/build/manifest.js';
import type { ResolvedAtom } from '../../src/contracts/merge.js';
import type { OutFile, RenderReport } from '../../src/contracts/render.js';
import { atom } from '../merge/helpers.js';

/** 清理项 5:resolved 里出现重复原子 id → 报错(不是「后者静默覆盖」)。 */
const report: RenderReport = {
  dropped: [],
  sideEffects: [],
  shadowChecks: [],
  pendingProbes: [],
  skippedLayers: [],
};

const resolved = (id: string, layer: 'org' | 'team' | 'personal'): ResolvedAtom => ({
  atom: atom(id, layer),
  layer,
  coreEligible: layer !== 'personal',
  replaced: [],
});

const file = (ids: string[]): OutFile => ({
  agent: 'claude',
  target: 'home',
  relPath: '.claude/rules/agent-kit/org.md',
  content: 'x\n',
  mode: 'owned',
  atomIds: ids,
  atomBytes: Object.fromEntries(ids.map((i) => [i, 1])),
  confidence: 'documented',
});

const input = (r: ResolvedAtom[], files: OutFile[]) => ({
  files,
  resolved: r,
  report,
  kitVersion: '0.0.0',
  channel: 'canary' as const,
});

describe('buildManifest:重复 id(清理项 5)', () => {
  it('正向对照:id 唯一时正常产出,原子带各自的 layer', () => {
    const m = buildManifest(
      input([resolved('a-one', 'org'), resolved('b-two', 'team')], [file(['a-one'])]),
    );
    expect(m.files[0]?.atoms).toEqual([{ id: 'a-one', layer: 'org' }]);
  });

  it('同 id 出现两次(不同层)→ 抛 ManifestDuplicateAtomError,信息含 id 与两个层', () => {
    const run = () =>
      buildManifest(
        input([resolved('dup-id', 'org'), resolved('dup-id', 'team')], [file(['dup-id'])]),
      );
    expect(run).toThrow(ManifestDuplicateAtomError);
    expect(run).toThrow(/dup-id/);
    expect(run).toThrow(/org.*team/);
  });

  it('后者是 personal(core 渲染会被「后者覆盖」成 personal 泄漏)也是同一个错,而不是 OUT_PERSONAL_LEAK 之类的下游错', () => {
    expect(() =>
      buildManifest(
        input([resolved('dup-id', 'team'), resolved('dup-id', 'personal')], [file(['dup-id'])]),
      ),
    ).toThrow(ManifestDuplicateAtomError);
  });

  it('没有任何文件引用该 id 时同样报错(不变量在 resolved 上,不依赖是否被引用)', () => {
    expect(() =>
      buildManifest(input([resolved('dup-id', 'org'), resolved('dup-id', 'team')], [])),
    ).toThrow(ManifestDuplicateAtomError);
  });
});

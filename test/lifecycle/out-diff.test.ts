/** L4:out/ 进出清单(纯内存的 base/head 两份原子集各合并 + 渲染)。 */
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { KitConfigSchema } from '../../src/contracts/config.js';
import { OutDiffError, computeOutDiff } from '../../src/lifecycle/out-diff.js';
import type { AtomSource } from '../../src/lifecycle/out-diff.js';
import { readTextSync } from '../../src/io/read-fs.js';
import { atomText } from '../guards/criteria-world.js';

const config = KitConfigSchema.parse(
  parseToml(readTextSync(fileURLToPath(new URL('../../kit.toml', import.meta.url)))),
);

const body = (n: string): string =>
  `**做**:做事${n}。\n**为什么**:原因${n}。\n**怎么验**:验证${n}。\n`;
const src = (id: string, o: Parameters<typeof atomText>[0] = {}, edge = ''): AtomSource => ({
  path: `rules/team/${id}.md`,
  text: (() => {
    const t = atomText({ id, body: body(id), ...o });
    return edge === '' ? t : t.replace('origin:', `${edge}\norigin:`);
  })(),
});

describe('computeOutDiff', () => {
  it('advisory 只进 canary;active 进两个渠道;base 与 head 都参与(一直在 out/ 里的原子不出现)', () => {
    const keep = src('keep-active', { status: 'active' });
    const base = [keep, src('x', { status: 'proposed' })];
    const t1 = computeOutDiff({ base, head: [keep, src('x', { status: 'advisory' })], config });
    expect(t1.channels.map((c) => c.channel)).toEqual(['canary', 'stable']);
    expect(t1.channels[0]).toMatchObject({ atomsIn: ['x'], atomsOut: [] });
    expect(t1.channels[1]).toMatchObject({
      atomsIn: [],
      atomsOut: [],
      filesAdded: [],
      filesChanged: [],
    });
    const t2 = computeOutDiff({
      base: [keep, src('x', { status: 'advisory' })],
      head: [keep, src('x', { status: 'active' })],
      config,
    });
    expect(t2.channels[0]).toMatchObject({ atomsIn: [], atomsOut: [] });
    expect(t2.channels[0]!.filesChanged.length).toBeGreaterThan(0); // 试用标记 → 正式
    expect(t2.channels[1]).toMatchObject({ atomsIn: ['x'], atomsOut: [] });
  });

  it('手写原子带边:声明者转 advisory 后,被它 overrides 的原子离开 out/(两个渠道都离开,只有 canary 进来)', () => {
    const victim = src('victim', { status: 'active' });
    const mk = (status: string): AtomSource => src('overrider', { status }, 'overrides: [victim]');
    const d = computeOutDiff({
      base: [victim, mk('proposed')],
      head: [victim, mk('advisory')],
      config,
    });
    expect(d.channels[0]).toMatchObject({ atomsIn: ['overrider'], atomsOut: ['victim'] });
    expect(d.channels[1]).toMatchObject({ atomsIn: [], atomsOut: ['victim'] });
    expect(d.channels[1]!.filesRemoved.length).toBeGreaterThan(0); // 只剩被压住的原子时,整份输出文件随之消失
    // 反过来(退役侧):被压住的原子复活
    const back = computeOutDiff({
      base: [victim, mk('advisory')],
      head: [victim, mk('proposed')],
      config,
    });
    expect(back.channels[1]).toMatchObject({ atomsIn: ['victim'], atomsOut: [] });
  });

  it('输入确定:同输入两次结果完全相等', () => {
    const base = [src('a', { status: 'proposed' })];
    const head = [src('a', { status: 'advisory' })];
    expect(computeOutDiff({ base, head, config })).toEqual(computeOutDiff({ base, head, config }));
  });

  it('原子解析不了 / 合并有 error → OutDiffError(稳定码),不产出半截清单', () => {
    const bad: AtomSource = { path: 'rules/team/bad.md', text: 'not an atom\n' };
    expect(() => computeOutDiff({ base: [bad], head: [bad], config })).toThrow(OutDiffError);
    const dup = [src('d1', {}), { ...src('d1', {}), path: 'rules/team/d1-copy.md' }];
    try {
      computeOutDiff({ base: dup, head: dup, config });
      expect.unreachable();
    } catch (e) {
      expect((e as OutDiffError).code).toBe('MERGE_FAILED');
    }
  });
});

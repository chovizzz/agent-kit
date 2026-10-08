import { describe, expect, it } from 'vitest';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { AdapterMetaSchema, RENDER_AGENT_IDS } from '../../src/contracts/index.js';
import { readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';

describe('adapters 骨架桩(B07/B08 只替换自己目录下的文件)', () => {
  const load = async (a: string) => {
    switch (a) {
      case 'claude':
        return (await import('../../adapters/claude/index.js')).adapter;
      case 'codex':
        return (await import('../../adapters/codex/index.js')).adapter;
      case 'pi':
        return (await import('../../adapters/pi/index.js')).adapter;
      case 'kimi':
        return (await import('../../adapters/kimi/index.js')).adapter;
      default:
        return (await import('../../adapters/opencode/index.js')).adapter;
    }
  };

  for (const agent of RENDER_AGENT_IDS) {
    it(`${agent}:index.ts 导出同名 adapter,managed-targets.json 符合 AdapterMeta`, async () => {
      const adapter = await load(agent);
      expect(adapter.agent).toBe(agent);
      const out = adapter.renderRules({
        resolved: [],
        skills: [],
        agents: [],
        kitVersion: '0.0.0',
        channel: 'canary',
      });
      expect(out.files).toEqual([]);
      const meta = AdapterMetaSchema.parse(
        JSON.parse(await readText(`${REPO_ROOT}/adapters/${agent}/managed-targets.json`)),
      );
      expect(meta.agent).toBe(agent);
    });
  }
});

describe('依赖选型冒烟(zod 4 / yaml / smol-toml 的行为假设)', () => {
  it('yaml:未加引号的日期保持字符串(契约的 IsoDate 依赖这一点)', () => {
    const doc = parseYaml('created: 2026-10-08\nreview_by: 2027-01-08\n') as Record<
      string,
      unknown
    >;
    expect(doc['created']).toBe('2026-10-08');
    expect(typeof doc['review_by']).toBe('string');
  });

  it('yaml:stringify 对同一对象输出确定(幂等)', () => {
    const o = { b: [1, 2], a: { z: 'x', y: '中文' } };
    expect(stringifyYaml(o)).toBe(stringifyYaml(parseYaml(stringifyYaml(o))));
  });

  it('smol-toml:parse → stringify → parse 往返相等,且 stringify 幂等', () => {
    const src = 'name = "a"\n[x]\nlist = [1, 2]\n[x.y]\nk = "v"\n';
    const once = stringifyToml(parseToml(src));
    expect(parseToml(once)).toEqual(parseToml(src));
    expect(stringifyToml(parseToml(once))).toBe(once);
  });

  it('smol-toml:空表 [a.b.members] 解析为 {}', () => {
    expect(parseToml('[a.b.members]\n')).toEqual({ a: { b: { members: {} } } });
  });
});

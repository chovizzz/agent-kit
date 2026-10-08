import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { adapter } from '../../../adapters/claude/index.js';
import { SKILL_FRONTMATTER_KEYS } from '../../../adapters/claude/skills.js';
import { AdapterMetaSchema } from '../../../src/contracts/render.js';
import type { OutFile, RenderOutput } from '../../../src/contracts/render.js';
import { buildManifest, OutLayoutError } from '../../../src/render/out-layout.js';
import { renderAll } from '../../../src/render/core.js';
import { createRegistry, defaultRegistry } from '../../../src/render/registry.js';
import { readDir, readText } from '../../../src/io/read-fs.js';
import { REPO_ROOT } from '../../helpers/tmp.js';
import {
  assertDeterministic,
  assertGolden,
  renderOutputToTree,
} from '../../golden-harness/golden.js';
import { atom, goldenCases, inputOf, overlay } from './fixtures.js';

const registry = createRegistry([adapter]);
const render = (input = inputOf()): RenderOutput => renderAll(input, registry);
const byPath = (o: RenderOutput): Map<string, OutFile> =>
  new Map(o.files.map((f) => [`${f.target}:${f.relPath}`, f]));
const text = (o: RenderOutput, key: string): string => {
  const f = byPath(o).get(key);
  if (!f) throw new Error(`缺文件 ${key};有:${[...byPath(o).keys()].join(', ')}`);
  return f.content;
};

function frontmatterOf(content: string): Record<string, unknown> {
  expect(content.startsWith('---\n')).toBe(true);
  const end = content.indexOf('\n---\n', 4);
  expect(end).toBeGreaterThan(0);
  return parseYaml(content.slice(4, end + 1)) as Record<string, unknown>;
}

describe('claude golden(含 personal 原子被跳过的用例)', () => {
  for (const [name, input] of Object.entries(goldenCases())) {
    it(`golden:${name}`, async () => {
      await assertGolden({
        goldenDir: path.join(REPO_ROOT, 'test/golden/claude', name),
        actual: renderOutputToTree(render(input)),
      });
    });
  }

  it('golden 目录里只有用例目录(没有陈旧的用例)', async () => {
    const dirs = (await readDir(path.join(REPO_ROOT, 'test/golden/claude')))
      .filter((e) => e.isDirectory)
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual(Object.keys(goldenCases()).sort());
  });
});

describe('A1 确定性', () => {
  it('同一输入多次渲染逐字节相同;输入里原子/技能/代理顺序不影响输出', () => {
    assertDeterministic((i) => render(i), inputOf(), 3);
    const base = inputOf();
    const shuffled = inputOf({
      resolved: [...base.resolved].reverse(),
      skills: [...base.skills].reverse(),
      agents: [...base.agents].reverse(),
    });
    expect(JSON.stringify(render(shuffled))).toBe(JSON.stringify(render(base)));
  });

  it('输出里没有绝对路径、用户名、时间戳', () => {
    const all = render()
      .files.map((f) => f.content)
      .join('\n');
    expect(all).not.toMatch(/\/Users\/|\/home\/|\/private\/|20\d\d-\d\d-\d\dT/);
  });
});

describe('状态/渠道过滤写进报告', () => {
  it('被状态排除的原子在 dropped 里有 status 条目;没有 personal 原子时不声称跳过了 personal', () => {
    const o = render();
    const ids = o.report.dropped.filter((d) => d.field === 'status').map((d) => d.reason);
    for (const id of ['still-proposed', 'was-deprecated', 'was-retired']) {
      expect(
        ids.some((r) => r.includes(id)),
        id,
      ).toBe(true);
    }
    expect(ids.some((r) => r.includes('team-trial'))).toBe(false); // canary:advisory 正常渲染
    const stable = render(inputOf({ channel: 'stable' }));
    expect(
      stable.report.dropped.some((d) => d.field === 'status' && d.reason.includes('team-trial')),
    ).toBe(true);
    const none = render(goldenCases()['empty']);
    expect(none.report.skippedLayers).toEqual([]);
  });
});

describe('A15 personal 层不入 core 输出', () => {
  it('personal 原子在输入里,但不在任何文件内容、atomIds、manifest 里;报告写明已跳过', () => {
    const input = inputOf();
    expect(input.resolved.some((r) => r.layer === 'personal' && !r.coreEligible)).toBe(true); // 正向控制
    const direct = adapter.renderRules(structuredClone(input));
    const o = render(input);
    for (const out of [direct, o]) {
      for (const f of out.files) {
        expect(f.atomIds).not.toContain('personal-secret-pref');
        expect(f.content).not.toContain('personal-secret-pref');
        expect(f.relPath).not.toMatch(/personal/);
      }
      expect(out.report.skippedLayers).toContainEqual({
        layer: 'personal',
        reason: 'P2 才在本机渲染',
      });
    }
    const manifest = buildManifest(o.files, input.resolved, {
      kitVersion: input.kitVersion,
      channel: input.channel,
      skippedLayers: o.report.skippedLayers,
    });
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(manifest.files.flatMap((f) => f.atoms).every((a) => a.layer !== 'personal')).toBe(true);
  });

  it('coreEligible=false 的原子(即使 layer 不是 personal)也不渲染:渲染器只信 coreEligible', () => {
    const ineligible = atom({ id: 'ineligible-org-rule', layer: 'org', coreEligible: false });
    expect(ineligible.coreEligible).toBe(false);
    const input = inputOf({
      resolved: [ineligible, atom({ id: 'eligible-org-rule', layer: 'org' })],
    });
    const direct = adapter.renderRules(structuredClone(input));
    expect(direct.files.some((f) => f.atomIds.includes('ineligible-org-rule'))).toBe(false);
    expect(direct.files.some((f) => f.content.includes('ineligible-org-rule'))).toBe(false);
    expect(direct.files.some((f) => f.atomIds.includes('eligible-org-rule'))).toBe(true); // 正向控制
  });

  it('检测器自检:若有文件含 personal 原子,manifest 构建会抛错', () => {
    const input = inputOf();
    const o = render(input);
    const bad: OutFile = {
      ...(o.files[0] as OutFile),
      atomIds: ['personal-secret-pref'],
      atomBytes: { 'personal-secret-pref': 1 },
    };
    expect(() =>
      buildManifest([bad], input.resolved, {
        kitVersion: '0.0.0',
        channel: 'canary',
        skippedLayers: [],
      }),
    ).toThrow(OutLayoutError);
  });

  it('全是 personal 原子:没有任何输出文件(没有 personal.md,也没有空的 AGENTS.md 块),报告写明已跳过', () => {
    const o = render(goldenCases()['personal-only']);
    expect(o.files).toEqual([]);
    expect(o.report.skippedLayers).toContainEqual({ layer: 'personal', reason: 'P2 才在本机渲染' });
  });
});

describe('规则文件', () => {
  const o = render();

  it('只渲染 org/team 到用户级、project 到项目级;不生成 personal.md,不碰 CLAUDE.md', () => {
    const keys = [...byPath(o).keys()].filter(
      (k) => !k.includes('/skills/') && !k.includes('/agents/'),
    );
    expect(keys).toEqual([
      'home:.claude/rules/agent-kit/org.md',
      'home:.claude/rules/agent-kit/paths/org-paths.md',
      'home:.claude/rules/agent-kit/paths/team-paths.md',
      'home:.claude/rules/agent-kit/team.md',
      'project:.claude/rules/agent-kit/paths/project-paths.md',
      'project:.claude/rules/agent-kit/project.md',
      'project:AGENTS.md',
    ]);
    expect(o.files.some((f) => /CLAUDE\.md$/.test(f.relPath))).toBe(false);
  });

  it('状态与 applies_to:advisory 只在 canary 并带〔试行〕;proposed/deprecated/retired 与 codex 专属原子不渲染', () => {
    const team = text(o, 'home:.claude/rules/agent-kit/team.md');
    expect(team).toContain('### [should] 〔试行〕标题 team-trial');
    const org = text(o, 'home:.claude/rules/agent-kit/org.md');
    expect(org).toContain('only-claude');
    for (const gone of ['still-proposed', 'was-deprecated', 'was-retired', 'only-codex']) {
      expect(o.files.some((f) => f.content.includes(gone) || f.atomIds.includes(gone))).toBe(false);
    }
    const stable = render(inputOf({ channel: 'stable' }));
    expect(stable.files.some((f) => f.content.includes('team-trial'))).toBe(false);
    expect(stable.files.some((f) => f.content.includes('team-should-b'))).toBe(true); // 正向控制
  });

  it('must 先于 should,同级按 id 序', () => {
    const org = text(o, 'home:.claude/rules/agent-kit/org.md');
    const i = (s: string): number => org.indexOf(s);
    expect(i('org-must-z')).toBeGreaterThan(-1);
    expect(i('org-must-z')).toBeLessThan(i('org-should-a'));
    expect(i('only-claude')).toBeLessThan(i('org-should-a'));
  });

  it('paths 原子:带 paths frontmatter 的独立规则文件,frontmatter 是第一行且只有 paths 一个键', () => {
    const c = text(o, 'home:.claude/rules/agent-kit/paths/org-paths.md');
    const fm = frontmatterOf(c);
    expect(Object.keys(fm)).toEqual(['paths']);
    expect(fm['paths']).toEqual(['**/*.test.*', 'src/**/*.{ts,tsx}']);
    expect(c).toContain('生成文件,勿手改;源:agent-kit-core@0.0.0'); // 独占头在 frontmatter 之后
    expect(text(o, 'home:.claude/rules/agent-kit/org.md')).not.toContain('org-paths');
  });

  it('paths 原子不进 AGENTS.md 托管块(进了就丢掉路径作用域)', () => {
    const agents = text(o, 'project:AGENTS.md');
    expect(agents).toContain('project-should');
    expect(agents).not.toContain('project-paths');
    const f = byPath(o).get('project:AGENTS.md') as OutFile;
    expect(f.atomIds).toEqual(['project-should']);
    expect(f.mode).toBe('managed-block');
  });

  it('不带 paths 的规则文件没有 frontmatter', () => {
    expect(text(o, 'home:.claude/rules/agent-kit/org.md').startsWith('<!-- 生成文件')).toBe(true);
  });

  it('atomBytes = 该原子段落的实际字节数;AGENTS.md 与 project.md 内容相同故相等(预算按 id 去重)', () => {
    const a = byPath(o).get('project:AGENTS.md') as OutFile;
    const p = byPath(o).get('project:.claude/rules/agent-kit/project.md') as OutFile;
    expect(a.atomBytes).toEqual(p.atomBytes);
    const section =
      '### [should] 标题 project-should\n\n**做**: 做法 project-should\n\n**为什么**: 原因 project-should\n\n**怎么验**: 检查 project-should';
    expect(a.atomBytes['project-should']).toBe(Buffer.byteLength(section, 'utf8'));
    expect(a.content).toContain(section);
    expect(p.content).toContain(section);
  });

  it('项目规则文件标 conditional=P-Q1(不计预算),用户级与 AGENTS.md 没有 conditional', () => {
    for (const f of o.files.filter((x) => x.relPath.startsWith('.claude/rules/'))) {
      expect(f.conditional).toBe(f.target === 'project' ? 'P-Q1' : undefined);
    }
    expect(byPath(o).get('project:AGENTS.md')?.conditional).toBeUndefined();
  });
});

describe('confidence(documented / assumed 的钉子)', () => {
  it('逐文件钉死取值;没有 probed(P0 没跑过探针)', () => {
    const got = Object.fromEntries(
      render().files.map((f) => [`${f.target}:${f.relPath}`, f.confidence]),
    );
    expect(got).toEqual({
      'home:.claude/agents/diff-reviewer.md': 'documented',
      'home:.claude/agents/implementer.md': 'documented',
      'home:.claude/agents/web-scout.md': 'documented',
      'home:.claude/rules/agent-kit/org.md': 'assumed',
      'home:.claude/rules/agent-kit/paths/org-paths.md': 'assumed',
      'home:.claude/rules/agent-kit/paths/team-paths.md': 'assumed',
      'home:.claude/rules/agent-kit/team.md': 'assumed',
      'home:.claude/skills/alpha-full/SKILL.md': 'documented',
      'home:.claude/skills/zeta-plain/SKILL.md': 'documented',
      'project:.claude/rules/agent-kit/paths/project-paths.md': 'documented',
      'project:.claude/rules/agent-kit/project.md': 'documented',
      'project:AGENTS.md': 'documented',
    });
  });
});

describe('技能', () => {
  const o = render();
  const skillFiles = o.files.filter((f) => f.relPath.startsWith('.claude/skills/'));

  it('落点 ~/.claude/skills/<name>/SKILL.md;保留名 synced 不渲染并写 dropped 原因', () => {
    expect(skillFiles.map((f) => f.relPath)).toEqual([
      '.claude/skills/alpha-full/SKILL.md',
      '.claude/skills/zeta-plain/SKILL.md',
    ]);
    const d = o.report.dropped.find((x) => x.field === 'skill');
    expect(d?.reason).toContain('synced');
  });

  it('frontmatter 键只来自共同子集 name/description/license/compatibility/metadata,且顺序固定', () => {
    expect([...SKILL_FRONTMATTER_KEYS]).toEqual([
      'name',
      'description',
      'license',
      'compatibility',
      'metadata',
    ]);
    for (const f of skillFiles) {
      const keys = Object.keys(frontmatterOf(f.content));
      expect(keys.every((k) => (SKILL_FRONTMATTER_KEYS as readonly string[]).includes(k))).toBe(
        true,
      );
    }
    const full = frontmatterOf(text(o, 'home:.claude/skills/alpha-full/SKILL.md'));
    expect(Object.keys(full)).toEqual([
      'name',
      'description',
      'license',
      'compatibility',
      'metadata',
    ]);
    expect(full['metadata']).toEqual({ area: 'review', owner: 'team' });
    expect(Object.keys(frontmatterOf(text(o, 'home:.claude/skills/zeta-plain/SKILL.md')))).toEqual([
      'name',
      'description',
    ]);
  });

  it('SKILL.md 首行仍是 ---(独占头放在 frontmatter 之后)', () => {
    for (const f of skillFiles) {
      expect(f.content.split('\n')[0]).toBe('---');
      expect(f.content).toContain('<!-- 生成文件,勿手改;源:agent-kit-core@0.0.0 -->');
    }
  });

  it('资源文件只有清单没有内容:dropped 列出文件名与原因(待主代理接线)', () => {
    const d = o.report.dropped.find((x) => x.field === 'files');
    expect(d?.file).toBe('claude/home/.claude/skills/alpha-full/SKILL.md');
    expect(d?.reason).toContain('references/guide.md');
    expect(d?.reason).toContain('scripts/run.sh');
  });
});

describe('子代理', () => {
  it('model 由覆盖层档位映射;未映射的档位省略 model 并写 dropped 原因', () => {
    const o = render();
    const rev = frontmatterOf(text(o, 'home:.claude/agents/diff-reviewer.md'));
    expect(rev['model']).toBe(overlay().model_tiers?.claude?.judge);
    expect(frontmatterOf(text(o, 'home:.claude/agents/implementer.md'))['model']).toBe(
      'overlay-claude-impl',
    );
    const scout = frontmatterOf(text(o, 'home:.claude/agents/web-scout.md'));
    expect('model' in scout).toBe(false);
    const d = o.report.dropped.find((x) => x.field === 'model_tier');
    expect(d?.file).toBe('claude/home/.claude/agents/web-scout.md');
    expect(d?.reason).toContain('readonly');
  });

  it('没有覆盖层:所有代理都没有 model 行,每个都有 dropped 原因', () => {
    const o = render(inputOf({ overlay: {} }));
    for (const f of o.files.filter((x) => x.relPath.startsWith('.claude/agents/'))) {
      expect(f.content).not.toMatch(/^model:/m);
    }
    expect(o.report.dropped.filter((x) => x.field === 'model_tier')).toHaveLength(3);
    expect(o.report.dropped.every((x) => x.reason.length > 0)).toBe(true);
  });

  it('工具类别映射为 Claude 工具名(固定序、去重);prompt 在 frontmatter 之后', () => {
    const o = render();
    expect(frontmatterOf(text(o, 'home:.claude/agents/diff-reviewer.md'))['tools']).toBe(
      'Read, Grep, Glob, Bash',
    );
    expect(frontmatterOf(text(o, 'home:.claude/agents/implementer.md'))['tools']).toBe(
      'Read, Grep, Glob, Edit, Write, Bash',
    );
    expect(frontmatterOf(text(o, 'home:.claude/agents/web-scout.md'))['tools']).toBe(
      'WebFetch, WebSearch, Agent',
    );
    expect(text(o, 'home:.claude/agents/diff-reviewer.md')).toContain('\n\n你是只读的代码评审者。');
  });

  it('core 里没有具体模型名:adapters/claude 源码零命中;不给覆盖层时输出里也没有', async () => {
    const dir = path.join(REPO_ROOT, 'adapters/claude');
    const names = (await readDir(dir)).filter((e) => e.name.endsWith('.ts')).map((e) => e.name);
    expect(names.length).toBeGreaterThan(5);
    for (const n of names) {
      const src = await readText(path.join(dir, n));
      expect(src.length, n).toBeGreaterThan(0); // 正向控制:读到了内容
      expect(src, n).not.toMatch(
        /\b(sonnet|opus|haiku|fable|gpt-\d|gemini|kimi-for|deepseek|glm-\d)/i,
      );
    }
    const bare = render(inputOf({ overlay: {} }));
    expect(bare.files.map((f) => f.content).join('\n')).not.toMatch(
      /overlay-claude|sonnet|opus|haiku/i,
    );
  });
});

describe('渲染报告', () => {
  const o = render();
  it('每个输出文件都有 shadowChecks 条目;pendingProbes 含 P-Q1 / P-Q2 / 未跑探针声明', () => {
    for (const f of o.files) {
      const key = `claude/${f.target}/${f.relPath}`;
      expect(
        o.report.shadowChecks.some((s) => s.startsWith(`${key}: `)),
        key,
      ).toBe(true);
    }
    const ids = o.report.pendingProbes.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['P-Q1', 'P-Q2', 'compat-probe-not-run']));
    expect(o.report.sideEffects.length).toBeGreaterThan(0);
  });

  it('dropped 非空时每条都有原因', () => {
    expect(o.report.dropped.length).toBeGreaterThan(0);
    expect(o.report.dropped.every((d) => d.reason.trim().length > 0)).toBe(true);
  });

  it('每个文件的 confidence 都是合法取值', () => {
    expect(o.files.every((f) => ['documented', 'probed', 'assumed'].includes(f.confidence))).toBe(
      true,
    );
  });
});

describe('managed-targets.json 与 tested_versions', () => {
  it('符合 AdapterMetaSchema;tested_versions 与 adapter 一致;每个 home 输出都落在声明的落点内', async () => {
    const meta = AdapterMetaSchema.parse(
      JSON.parse(await readText(path.join(REPO_ROOT, 'adapters/claude/managed-targets.json'))),
    );
    expect(meta.agent).toBe('claude');
    expect(meta.tested_versions).toEqual([...adapter.testedVersions]);
    const covered = (rel: string): boolean =>
      meta.managed_targets.some((t) => {
        const p = t.replace(/^~\//, '');
        return p.endsWith('/') ? rel.startsWith(p) : rel === p;
      });
    const homes = render().files.filter((f) => f.target === 'home');
    expect(homes.length).toBeGreaterThan(0);
    for (const f of homes) expect(covered(f.relPath), f.relPath).toBe(true);
  });

  it('默认注册表里 claude 适配器就是本适配器', () => {
    expect(defaultRegistry.get('claude')).toBe(adapter);
  });
});

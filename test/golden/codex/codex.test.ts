import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { adapter } from '../../../adapters/codex/index.js';
import { adapter as claudeAdapter } from '../../../adapters/claude/index.js';
import { SKILL_FRONTMATTER_KEYS } from '../../../adapters/codex/skills.js';
import { pathsPrefix } from '../../../adapters/codex/atoms.js';
import { CODEX_AGENT_FIELD_ORDER, codexAgentToml } from '../../../adapters/codex/toml.js';
import { AdapterMetaSchema } from '../../../src/contracts/render.js';
import type { OutFile, RenderOutput } from '../../../src/contracts/render.js';
import { buildManifest, OutLayoutError } from '../../../src/render/out-layout.js';
import { renderAll } from '../../../src/render/core.js';
import { parseManagedBlocks } from '../../../src/render/managed-block.js';
import { createRegistry, defaultRegistry } from '../../../src/render/registry.js';
import { readDir, readText } from '../../../src/io/read-fs.js';
import { REPO_ROOT } from '../../helpers/tmp.js';
import {
  assertDeterministic,
  assertGolden,
  renderOutputToTree,
} from '../../golden-harness/golden.js';
import { agents, atom, goldenCases, inputOf, overlay, skills } from '../claude/fixtures.js';

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

/** 去掉独占头(第一行)后解析 TOML。 */
function tomlOf(content: string): Record<string, unknown> {
  expect(content.startsWith('# 生成文件,勿手改;源:agent-kit-core@')).toBe(true);
  return parseToml(content.slice(content.indexOf('\n') + 1));
}

describe('codex golden(含 personal 原子被跳过的用例)', () => {
  for (const [name, input] of Object.entries(goldenCases())) {
    it(`golden:${name}`, async () => {
      await assertGolden({
        goldenDir: path.join(REPO_ROOT, 'test/golden/codex', name),
        actual: renderOutputToTree(render(input)),
      });
    });
  }

  it('golden 目录里只有用例目录(没有陈旧的用例)', async () => {
    const dirs = (await readDir(path.join(REPO_ROOT, 'test/golden/codex')))
      .filter((e) => e.isDirectory)
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual(Object.keys(goldenCases()).sort());
  });
});

describe('A1 确定性', () => {
  it('同一输入多次渲染逐字节相同;输入顺序不影响输出', () => {
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
  it('personal 原子不在任何文件、atomIds、manifest 里;报告写明已跳过', () => {
    const input = inputOf();
    expect(input.resolved.some((r) => r.layer === 'personal' && !r.coreEligible)).toBe(true);
    const direct = adapter.renderRules(structuredClone(input));
    const o = render(input);
    for (const out of [direct, o]) {
      for (const f of out.files) {
        expect(f.atomIds).not.toContain('personal-secret-pref');
        expect(f.content).not.toContain('personal-secret-pref');
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

  it('检测器自检:有文件含 personal 原子时 manifest 构建抛错', () => {
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

  it('全是 personal 原子:没有任何输出文件(没有空的 AGENTS.md 块),报告写明已跳过', () => {
    const o = render(goldenCases()['personal-only']);
    expect(o.files).toEqual([]);
    expect(o.report.skippedLayers).toContainEqual({ layer: 'personal', reason: 'P2 才在本机渲染' });
  });
});

describe('AGENTS.md 托管块', () => {
  const o = render();

  it('落点:全局 ~/.codex/AGENTS.md(按空文件渲染)与项目 AGENTS.md;都是恰好一个 intact 托管块', () => {
    for (const key of ['home:.codex/AGENTS.md', 'project:AGENTS.md']) {
      const f = byPath(o).get(key) as OutFile;
      expect(f.mode).toBe('managed-block');
      const parsed = parseManagedBlocks(f.content);
      expect(parsed.ok && parsed.blocks.length === 1).toBe(true);
      expect(f.confidence).toBe('documented');
      expect(f.conditional).toBeUndefined();
    }
  });

  it('全局块 = org + team(含 paths 降级原子),项目块 = project;状态/applies_to 过滤同 Claude', () => {
    const home = text(o, 'home:.codex/AGENTS.md');
    for (const id of [
      'org-must-z',
      'org-should-a',
      'org-paths',
      'team-should-b',
      'team-paths',
      'only-codex',
    ]) {
      expect(home, id).toContain(id);
    }
    expect(home).toContain('### [should] 〔试行〕标题 team-trial');
    for (const gone of [
      'only-claude',
      'still-proposed',
      'was-deprecated',
      'was-retired',
      'personal-secret-pref',
      'project-should',
    ]) {
      expect(home, gone).not.toContain(gone);
    }
    const proj = text(o, 'project:AGENTS.md');
    expect(proj).toContain('project-should');
    expect(proj).toContain('project-paths');
    expect(proj).not.toContain('org-must-z');
    expect(home.indexOf('## agent-kit 规则(org 层)')).toBeLessThan(
      home.indexOf('## agent-kit 规则(team 层)'),
    );
  });

  it('paths 降级:标题后紧跟前缀「仅在处理 `glob` 时适用。」,没有 frontmatter,不生成独立规则文件', () => {
    expect(pathsPrefix(['docs/**'])).toBe('仅在处理 `docs/**` 时适用。');
    expect(pathsPrefix(['a', 'b/*.ts'])).toBe('仅在处理 `a`、`b/*.ts` 时适用。');
    const home = text(o, 'home:.codex/AGENTS.md');
    expect(home).toContain(
      '### [should] 标题 org-paths\n\n仅在处理 `**/*.test.*`、`src/**/*.{ts,tsx}` 时适用。\n\n**做**: 做法 org-paths',
    );
    expect(home).toContain('### [should] 标题 team-paths\n\n仅在处理 `docs/**` 时适用。\n\n');
    expect(text(o, 'project:AGENTS.md')).toContain(
      '### [should] 标题 project-paths\n\n仅在处理 `api/**` 时适用。',
    );
    expect(o.files.some((f) => f.relPath.includes('rules/'))).toBe(false);
    expect(home).not.toMatch(/^paths:/m);
  });

  it('不带 paths 的原子没有前缀', () => {
    expect(text(o, 'home:.codex/AGENTS.md')).not.toContain('标题 org-should-a\n\n仅在处理');
  });

  it('含反引号的 glob 用更长的围栏,不会截断行内代码', () => {
    expect(pathsPrefix(['a`b'])).toBe('仅在处理 ``a`b`` 时适用。');
  });

  it('paths 降级写进 dropped,每条带文件与原因', () => {
    const d = o.report.dropped.filter((x) => x.field === 'paths');
    expect(d.map((x) => x.file).sort()).toEqual([
      'codex/home/.codex/AGENTS.md',
      'codex/home/.codex/AGENTS.md',
      'codex/project/AGENTS.md',
    ]);
    expect(d.every((x) => x.reason.includes('没有路径作用域') && x.reason.length > 20)).toBe(true);
  });

  it('无 paths 的原子:同输入下 codex 与 claude 渲染出的段落逐字节相同(防两份实现漂移)', () => {
    const input = inputOf({ resolved: [atom({ id: 'project-x', layer: 'project' })] });
    const c = renderAll(input, createRegistry([claudeAdapter]));
    const x = render(input);
    expect(x.files.find((f) => f.relPath === 'AGENTS.md')?.content).toBe(
      c.files.find((f) => f.relPath === 'AGENTS.md')?.content,
    );
  });

  it('atomBytes = 段落实际字节数', () => {
    const f = byPath(o).get('project:AGENTS.md') as OutFile;
    const section =
      '### [should] 标题 project-should\n\n**做**: 做法 project-should\n\n**为什么**: 原因 project-should\n\n**怎么验**: 检查 project-should';
    expect(f.atomBytes['project-should']).toBe(Buffer.byteLength(section, 'utf8'));
  });
});

describe('技能', () => {
  const o = render();
  const skillFiles = o.files.filter((f) => f.relPath.includes('skills/'));

  it('写到 ~/.agents/skills/<name>/SKILL.md,绝不写 .codex/skills;保留名 synced 对 Codex 不是保留名', () => {
    expect(skillFiles.map((f) => f.relPath)).toEqual([
      '.agents/skills/alpha-full/SKILL.md',
      '.agents/skills/synced/SKILL.md',
      '.agents/skills/zeta-plain/SKILL.md',
    ]);
    expect(o.files.some((f) => f.relPath.includes('.codex/skills'))).toBe(false);
    expect(skillFiles.every((f) => f.target === 'home')).toBe(true);
  });

  it('frontmatter 只用共同子集的键;SKILL.md 首行是 ---', () => {
    for (const f of skillFiles) {
      expect(f.content.split('\n')[0]).toBe('---');
      const keys = Object.keys(frontmatterOf(f.content));
      expect(keys.every((k) => (SKILL_FRONTMATTER_KEYS as readonly string[]).includes(k))).toBe(
        true,
      );
    }
  });

  it('同一技能 codex 与 claude 渲染出的 SKILL.md 逐字节相同(防两份实现漂移)', () => {
    const input = inputOf();
    const c = renderAll(input, createRegistry([claudeAdapter]));
    const x = render(input);
    for (const name of ['alpha-full', 'zeta-plain']) {
      expect(x.files.find((f) => f.relPath === `.agents/skills/${name}/SKILL.md`)?.content).toBe(
        c.files.find((f) => f.relPath === `.claude/skills/${name}/SKILL.md`)?.content,
      );
    }
  });

  it('confidence:只有 name+description 的技能 documented;带 license/compatibility/metadata 的 assumed', () => {
    const conf = (n: string): string | undefined =>
      o.files.find((f) => f.relPath === `.agents/skills/${n}/SKILL.md`)?.confidence;
    expect(conf('zeta-plain')).toBe('documented');
    expect(conf('alpha-full')).toBe('assumed');
    expect(o.report.pendingProbes.map((p) => p.id)).toContain('codex-skill-optional-fields');
  });

  it('资源文件只有清单没有内容:dropped 列出文件名与原因', () => {
    const d = o.report.dropped.find((x) => x.field === 'files');
    expect(d?.file).toBe('codex/home/.agents/skills/alpha-full/SKILL.md');
    expect(d?.reason).toContain('references/guide.md');
  });
});

describe('子代理 TOML', () => {
  const o = render();
  const f = (n: string): string => text(o, `home:.codex/agents/${n}.toml`);

  it('字段顺序固定:name, description, model, sandbox_mode, developer_instructions', () => {
    expect([...CODEX_AGENT_FIELD_ORDER]).toEqual([
      'name',
      'description',
      'model',
      'sandbox_mode',
      'developer_instructions',
    ]);
    const keys = (c: string): string[] =>
      c
        .split('\n')
        .slice(1)
        .filter((l) => /^[a-z_]+ = /.test(l))
        .map((l) => l.split(' = ')[0] as string);
    expect(keys(f('diff-reviewer'))).toEqual([
      'name',
      'description',
      'model',
      'sandbox_mode',
      'developer_instructions',
    ]);
    expect(keys(f('implementer'))).toEqual([
      'name',
      'description',
      'model',
      'developer_instructions',
    ]);
    expect(keys(f('web-scout'))).toEqual([
      'name',
      'description',
      'sandbox_mode',
      'developer_instructions',
    ]);
  });

  it('输入对象键序不同、字段缺省不同,输出仍按固定序;TOML 解析往返相等', () => {
    const a = codexAgentToml({
      developer_instructions: 'x\n"引号" \\ 反斜杠',
      sandbox_mode: 'read-only',
      model: 'm',
      description: 'd',
      name: 'n',
    });
    const b = codexAgentToml({
      name: 'n',
      description: 'd',
      model: 'm',
      sandbox_mode: 'read-only',
      developer_instructions: 'x\n"引号" \\ 反斜杠',
    });
    expect(a).toBe(b);
    expect(a.split('\n').map((l) => l.split(' = ')[0])).toEqual([
      'name',
      'description',
      'model',
      'sandbox_mode',
      'developer_instructions',
      '',
    ]);
    expect(parseToml(a)).toEqual({
      name: 'n',
      description: 'd',
      model: 'm',
      sandbox_mode: 'read-only',
      developer_instructions: 'x\n"引号" \\ 反斜杠',
    });
  });

  it('内容正确:developer_instructions = prompt;name = 代理名', () => {
    const t = tomlOf(f('diff-reviewer'));
    expect(t['name']).toBe('diff-reviewer');
    expect(t['description']).toBe('只读评审者');
    expect(t['developer_instructions']).toBe('你是只读的代码评审者。\n只输出问题清单。');
  });

  it('model 由覆盖层档位映射;未映射档位省略 model 并写 dropped;没有覆盖层时一个 model 都没有', () => {
    expect(tomlOf(f('diff-reviewer'))['model']).toBe(overlay().model_tiers?.codex?.judge);
    expect(tomlOf(f('implementer'))['model']).toBe('overlay-codex-impl');
    expect('model' in tomlOf(f('web-scout'))).toBe(false);
    const d = o.report.dropped.find((x) => x.field === 'model_tier');
    expect(d?.file).toBe('codex/home/.codex/agents/web-scout.toml');
    const bare = render(inputOf({ overlay: {} }));
    for (const x of bare.files.filter((y) => y.relPath.endsWith('.toml'))) {
      expect(x.content).not.toMatch(/^model = /m);
    }
    expect(bare.report.dropped.filter((x) => x.field === 'model_tier')).toHaveLength(3);
  });

  it('沙箱映射:没有 edit 类别 ⇒ read-only,有 edit 则省略(继承);Codex 无工具白名单,其它类别写入 dropped', () => {
    expect(tomlOf(f('diff-reviewer'))['sandbox_mode']).toBe('read-only');
    expect('sandbox_mode' in tomlOf(f('implementer'))).toBe(false);
    expect(tomlOf(f('web-scout'))['sandbox_mode']).toBe('read-only');
    const lost = o.report.dropped.filter((x) => x.field === 'tools');
    expect(lost.map((x) => x.file)).toEqual([
      'codex/home/.codex/agents/diff-reviewer.toml',
      'codex/home/.codex/agents/implementer.toml',
      'codex/home/.codex/agents/web-scout.toml',
    ]);
    expect(lost.every((x) => x.reason.includes('没有工具白名单'))).toBe(true);
    expect(o.report.sideEffects.some((s) => s.includes('sandbox_mode="read-only"'))).toBe(true);
  });

  it('confidence=documented(只用文档明文的键);不渲染 model_reasoning_effort', () => {
    for (const n of ['diff-reviewer', 'implementer', 'web-scout']) {
      expect(byPath(o).get(`home:.codex/agents/${n}.toml`)?.confidence).toBe('documented');
      expect(f(n)).not.toContain('model_reasoning_effort');
    }
  });

  it('core 里没有具体模型名:adapters/codex 源码零命中', async () => {
    const dir = path.join(REPO_ROOT, 'adapters/codex');
    const names = (await readDir(dir)).filter((e) => e.name.endsWith('.ts')).map((e) => e.name);
    expect(names.length).toBeGreaterThan(5);
    for (const n of names) {
      const src = await readText(path.join(dir, n));
      expect(src.length, n).toBeGreaterThan(0); // 正向控制:读到了内容
      expect(src, n).not.toMatch(
        /\b(sonnet|opus|haiku|fable|gpt-\d|gemini|kimi-for|deepseek|glm-\d)/i,
      );
    }
  });

  it('代理列表为空时没有 toml 文件', () => {
    expect(render(inputOf({ agents: [] })).files.some((x) => x.relPath.endsWith('.toml'))).toBe(
      false,
    );
    expect(agents().length).toBe(3);
    expect(skills().length).toBe(3);
  });
});

describe('渲染报告与元数据', () => {
  const o = render();

  it('每个输出文件都有 shadowChecks 条目;pendingProbes 含 P-Q3 与未跑探针声明;sideEffects 非空', () => {
    for (const x of o.files) {
      const key = `codex/${x.target}/${x.relPath}`;
      expect(
        o.report.shadowChecks.some((s) => s.startsWith(`${key}: `)),
        key,
      ).toBe(true);
    }
    expect(o.report.pendingProbes.map((p) => p.id)).toEqual(
      expect.arrayContaining(['P-Q3', 'codex-paths-prefix-effect', 'compat-probe-not-run']),
    );
    expect(o.report.sideEffects.length).toBeGreaterThan(0);
    expect(o.report.dropped.every((d) => d.reason.trim().length > 0)).toBe(true);
  });

  it('managed-targets.json 符合 schema,与 adapter 一致,每个 home 输出都落在声明的落点内', async () => {
    const meta = AdapterMetaSchema.parse(
      JSON.parse(await readText(path.join(REPO_ROOT, 'adapters/codex/managed-targets.json'))),
    );
    expect(meta.agent).toBe('codex');
    expect(meta.tested_versions).toEqual([...adapter.testedVersions]);
    const covered = (rel: string): boolean =>
      meta.managed_targets.some((t) => {
        const p = t.replace(/^~\//, '');
        return p.endsWith('/') ? rel.startsWith(p) : rel === p;
      });
    const homes = o.files.filter((x) => x.target === 'home');
    expect(homes.length).toBeGreaterThan(0);
    for (const x of homes) expect(covered(x.relPath), x.relPath).toBe(true);
  });

  it('默认注册表里 codex 适配器就是本适配器;claude 与 codex 同时跑也不冲突', () => {
    expect(defaultRegistry.get('codex')).toBe(adapter);
    const both = renderAll(inputOf(), defaultRegistry);
    // 五家适配器现在都已实装(B08 合入后):默认注册表会渲染出五家的文件。
    // 本用例关心的是 claude 与 codex 同时跑互不冲突(同一份输入得到两家各自的产物),所以只过滤这两家断言。
    const agents = new Set(both.files.map((x) => x.agent));
    expect(agents.has('claude')).toBe(true);
    expect(agents.has('codex')).toBe(true);
    const claudeCodex = both.files.filter((x) => x.agent === 'claude' || x.agent === 'codex');
    expect(new Set(claudeCodex.map((x) => x.agent))).toEqual(new Set(['claude', 'codex']));
  });
});

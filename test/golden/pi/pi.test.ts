import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { adapter } from '../../../adapters/pi/index.js';
import { adapter as codexAdapter } from '../../../adapters/codex/index.js';
import { SKILL_FRONTMATTER_KEYS } from '../../../adapters/pi/skills.js';
import { HOME_SHADOWS, PROJECT_SHADOWS } from '../../../adapters/pi/rules.js';
import { pathsPrefix } from '../../../adapters/pi/atoms.js';
import { AdapterMetaSchema } from '../../../src/contracts/render.js';
import type { OutFile, RenderInput, RenderOutput } from '../../../src/contracts/render.js';
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
import { agents, atom, goldenCases, inputOf } from '../claude/fixtures.js';

const registry = createRegistry([adapter]);
const render = (input = inputOf()): RenderOutput => renderAll(input, registry);
const byPath = (o: RenderOutput): Map<string, OutFile> =>
  new Map(o.files.map((f) => [`${f.target}:${f.relPath}`, f]));
const text = (o: RenderOutput, key: string): string => {
  const f = byPath(o).get(key);
  if (!f) throw new Error(`缺文件 ${key};有:${[...byPath(o).keys()].join(', ')}`);
  return f.content;
};
const keyOfFile = (f: OutFile): string => `${f.agent}/${f.target}/${f.relPath}`;

function frontmatterOf(content: string): Record<string, unknown> {
  expect(content.startsWith('---\n')).toBe(true);
  const end = content.indexOf('\n---\n', 4);
  expect(end).toBeGreaterThan(0);
  return parseYaml(content.slice(4, end)) as Record<string, unknown>;
}

describe('pi golden(含 personal 原子被跳过的用例)', () => {
  for (const [name, input] of Object.entries(goldenCases())) {
    it(`golden:${name}`, async () => {
      await assertGolden({
        goldenDir: path.join(REPO_ROOT, 'test/golden/pi', name),
        actual: renderOutputToTree(render(input)),
      });
    });
  }

  it('golden 目录里只有用例目录(没有陈旧的用例)', async () => {
    const dirs = (await readDir(path.join(REPO_ROOT, 'test/golden/pi')))
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
    const o = render();
    const files = o.files.map((f) => f.content).join('\n');
    expect(files).not.toMatch(/\/Users\/|\/home\/|\/private\/|20\d\d-\d\d-\d\dT/);
    // 报告里的 key 形如 pi/home/...,所以只查不会和 target 名撞的绝对路径与时间戳
    const report = JSON.stringify(o.report);
    expect(report).not.toMatch(/\/Users\/|\/private\/|20\d\d-\d\d-\d\dT/);
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

  it('全是 personal 原子:没有任何输出文件(没有空的 AGENTS.md 块),报告写明已跳过', () => {
    const input = goldenCases()['personal-only'] as RenderInput;
    expect(input.resolved.length).toBeGreaterThan(0); // 正向控制:输入里确实有 personal 原子
    expect(input.resolved.every((r) => r.layer === 'personal')).toBe(true);
    const o = render(input);
    expect(o.files).toEqual([]);
    expect(o.report.skippedLayers).toContainEqual({ layer: 'personal', reason: 'P2 才在本机渲染' });
  });

  it('coreEligible=false 的原子(即使 layer 不是 personal)也不渲染:渲染器只信 coreEligible', () => {
    const ineligible = atom({ id: 'ineligible-org-rule', layer: 'org', coreEligible: false });
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
    expect(ids.some((r) => r.includes('team-trial'))).toBe(false);
    const stable = render(inputOf({ channel: 'stable' }));
    expect(
      stable.report.dropped.some((d) => d.field === 'status' && d.reason.includes('team-trial')),
    ).toBe(true);
    expect(render(goldenCases()['empty']).report.skippedLayers).toEqual([]);
  });
});

describe('AGENTS.md 托管块', () => {
  const o = render();

  it('落点:全局 ~/.pi/agent/AGENTS.md(按不存在渲染)与项目 AGENTS.md;都是恰好一个 intact 托管块;confidence=documented', () => {
    for (const key of ['home:.pi/agent/AGENTS.md', 'project:AGENTS.md']) {
      const f = byPath(o).get(key) as OutFile;
      expect(f.mode).toBe('managed-block');
      const parsed = parseManagedBlocks(f.content);
      expect(parsed.ok && parsed.blocks.length === 1).toBe(true);
      expect(f.confidence).toBe('documented');
      expect(f.conditional).toBeUndefined();
    }
    expect(o.files.map((f) => f.relPath).sort()).toEqual([
      '.agents/skills/alpha-full/SKILL.md',
      '.agents/skills/synced/SKILL.md',
      '.agents/skills/zeta-plain/SKILL.md',
      '.pi/agent/AGENTS.md',
      'AGENTS.md',
    ]);
  });

  it('全局块 = org + team,项目块 = project;状态/applies_to 过滤', () => {
    const home = text(o, 'home:.pi/agent/AGENTS.md');
    for (const id of ['org-must-z', 'org-should-a', 'org-paths', 'team-should-b', 'team-paths']) {
      expect(home, id).toContain(id);
    }
    expect(home).toContain('### [should] 〔试行〕标题 team-trial');
    for (const gone of [
      'only-codex',
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
    expect(proj).not.toContain('org-must-z');
    expect(home.indexOf('## agent-kit 规则(org 层)')).toBeLessThan(
      home.indexOf('## agent-kit 规则(team 层)'),
    );
  });

  it('applies_to 含 pi 的原子被渲染,只含别家的不渲染', () => {
    const input = inputOf({
      resolved: [
        atom({ id: 'only-pi', layer: 'org', applies_to: ['pi'] }),
        atom({ id: 'only-kimi', layer: 'org', applies_to: ['kimi'] }),
      ],
    });
    const home = text(render(input), 'home:.pi/agent/AGENTS.md');
    expect(home).toContain('only-pi');
    expect(home).not.toContain('only-kimi');
  });

  it('paths 降级:标题后紧跟前缀「仅在处理 `glob` 时适用。」,没有 frontmatter,不生成独立规则文件', () => {
    expect(pathsPrefix(['docs/**'])).toBe('仅在处理 `docs/**` 时适用。');
    const home = text(o, 'home:.pi/agent/AGENTS.md');
    expect(home).toContain(
      '### [should] 标题 org-paths\n\n仅在处理 `**/*.test.*`、`src/**/*.{ts,tsx}` 时适用。\n\n**做**: 做法 org-paths',
    );
    expect(o.files.some((f) => f.relPath.includes('rules/'))).toBe(false);
    expect(home).not.toMatch(/^paths:/m);
    const d = o.report.dropped.filter((x) => x.field === 'paths');
    expect(d.map((x) => x.file).sort()).toEqual([
      'pi/home/.pi/agent/AGENTS.md',
      'pi/home/.pi/agent/AGENTS.md',
      'pi/project/AGENTS.md',
    ]);
    expect(d.every((x) => x.reason.includes('没有路径作用域') && x.reason.length > 20)).toBe(true);
  });

  it('无 paths 的原子:同输入下 pi 与 codex 渲染出的段落逐字节相同(防两份实现漂移)', () => {
    const input = inputOf({ resolved: [atom({ id: 'project-x', layer: 'project' })] });
    const c = renderAll(input, createRegistry([codexAdapter]));
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

  it('写到 ~/.agents/skills/<name>/SKILL.md,不写 ~/.pi/agent/skills', () => {
    expect(skillFiles.map((f) => f.relPath)).toEqual([
      '.agents/skills/alpha-full/SKILL.md',
      '.agents/skills/synced/SKILL.md',
      '.agents/skills/zeta-plain/SKILL.md',
    ]);
    expect(o.files.some((f) => f.relPath.includes('.pi/agent/skills'))).toBe(false);
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
    expect([...SKILL_FRONTMATTER_KEYS]).toEqual([
      'name',
      'description',
      'license',
      'compatibility',
      'metadata',
    ]);
  });

  it('同一技能 pi 与 codex 渲染出的 SKILL.md 逐字节相同(共同子集,防漂移)', () => {
    const input = inputOf();
    const c = renderAll(input, createRegistry([codexAdapter]));
    for (const name of ['alpha-full', 'zeta-plain']) {
      expect(o.files.find((f) => f.relPath === `.agents/skills/${name}/SKILL.md`)?.content).toBe(
        c.files.find((f) => f.relPath === `.agents/skills/${name}/SKILL.md`)?.content,
      );
    }
  });

  it('confidence:Pi docs 明列 license/compatibility/metadata,全部 documented', () => {
    expect(skillFiles.every((f) => f.confidence === 'documented')).toBe(true);
    const full = skillFiles.find((f) => f.relPath.includes('alpha-full'));
    expect(Object.keys(frontmatterOf(full?.content ?? ''))).toContain('metadata'); // 正向控制:带了可选键
  });

  it('资源文件只有清单没有内容:dropped 列出文件名与原因', () => {
    const d = o.report.dropped.find((x) => x.field === 'files');
    expect(d?.file).toBe('pi/home/.agents/skills/alpha-full/SKILL.md');
    expect(d?.reason).toContain('references/guide.md');
  });
});

describe('子代理:Pi 不渲染(Q-N17,留 P1)', () => {
  it('renderAgents 对任何输入都返回空输出;报告说明未渲染了哪些', () => {
    expect(agents().length).toBe(3); // 正向控制
    const direct = adapter.renderAgents?.(structuredClone(inputOf()));
    expect(direct?.files).toEqual([]);
    expect(
      direct?.report.dropped.some((d) => d.field === 'agents' && d.reason.includes('web-scout')),
    ).toBe(true);
    const o = render();
    expect(
      o.files.some((f) => f.relPath.includes('agents/') && !f.relPath.includes('skills/')),
    ).toBe(false);
    expect(o.report.pendingProbes.map((p) => p.id)).toContain('pi-subagents-format');
  });
});

describe('渲染报告与元数据', () => {
  const o = render();

  it('每个输出文件都有 sideEffects 与 shadowChecks 条目(以其 key 开头)', () => {
    expect(o.files.length).toBeGreaterThan(0);
    for (const x of o.files) {
      const key = keyOfFile(x);
      expect(
        o.report.sideEffects.some((s) => s.startsWith(`${key}: `)),
        `sideEffects ${key}`,
      ).toBe(true);
      expect(
        o.report.shadowChecks.some((s) => s.startsWith(`${key}: `)),
        `shadowChecks ${key}`,
      ).toBe(true);
    }
  });

  it('sideEffects 写明行为变化、上级目录遍历污染与无机械强制', () => {
    const s = o.report.sideEffects.join('\n');
    expect(s).toContain('Pi 第一次读到全局规则,属行为变化');
    expect(s).toContain('~/AGENTS.md');
    expect(s).toContain('⚠ 本 agent 无机械强制');
  });

  it('遮蔽文件清单:Pi 的 AGENTS.override.md、SYSTEM.md、PI_CODING_AGENT_DIR、--no-context-files 都在', () => {
    const home = o.report.shadowChecks.filter((s) => s.startsWith('pi/home/.pi/agent/AGENTS.md: '));
    const proj = o.report.shadowChecks.filter((s) => s.startsWith('pi/project/AGENTS.md: '));
    expect(home).toHaveLength(HOME_SHADOWS.length);
    expect(proj).toHaveLength(PROJECT_SHADOWS.length);
    // 字面数量:清单被误删一项时,上面两个与清单自身比较的断言不会红
    expect(home).toHaveLength(5);
    expect(proj).toHaveLength(2);
    const h = home.join('\n');
    for (const needle of [
      '~/.pi/agent/AGENTS.override.md',
      'SYSTEM.md',
      'PI_CODING_AGENT_DIR',
      '--no-context-files',
    ]) {
      expect(h, needle).toContain(needle);
    }
    const p = proj.join('\n');
    expect(p).toContain('AGENTS.override.md');
    expect(p).toContain('--no-context-files');
  });

  it('shadowChecks 只列出,不检查真实文件(报告里不出现 exists/found 之类的检查结果)', () => {
    expect(o.report.shadowChecks.every((s) => s.includes('P0 不检查'))).toBe(true);
  });

  it('pendingProbes 含 P-Q4、paths 前缀探针与未跑探针声明;没有任何文件是 probed', () => {
    expect(o.report.pendingProbes.map((p) => p.id)).toEqual(
      expect.arrayContaining(['P-Q4', 'pi-paths-prefix-effect', 'compat-probe-not-run']),
    );
    expect(o.files.some((f) => f.confidence === 'probed')).toBe(false);
    expect(o.report.dropped.every((d) => d.reason.trim().length > 0)).toBe(true);
  });

  it('managed-targets.json 符合 schema,与 adapter 一致,每个 home 输出都落在声明的落点内', async () => {
    const meta = AdapterMetaSchema.parse(
      JSON.parse(await readText(path.join(REPO_ROOT, 'adapters/pi/managed-targets.json'))),
    );
    expect(meta.agent).toBe('pi');
    expect(meta.tested_versions).toEqual([...adapter.testedVersions]);
    expect(meta.tested_versions).toEqual(['0.87.1']);
    const covered = (rel: string): boolean =>
      meta.managed_targets.some((t) => {
        const p = t.replace(/^~\//, '');
        return p.endsWith('/') ? rel.startsWith(p) : rel === p;
      });
    const homes = o.files.filter((x) => x.target === 'home');
    expect(homes.length).toBeGreaterThan(0);
    for (const x of homes) expect(covered(x.relPath), x.relPath).toBe(true);
  });

  it('默认注册表里 pi 适配器就是本适配器', () => {
    expect(defaultRegistry.get('pi')).toBe(adapter);
    const all = renderAll(inputOf(), defaultRegistry);
    expect(new Set(all.files.map((x) => x.agent))).toContain('pi');
  });
});

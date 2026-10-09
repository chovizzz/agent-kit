import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adapter } from '../../../adapters/opencode/index.js';
import { adapter as codexAdapter } from '../../../adapters/codex/index.js';
import { adapter as piAdapter } from '../../../adapters/pi/index.js';
import { adapter as kimiAdapter } from '../../../adapters/kimi/index.js';
import { HOME_SHADOWS, PROJECT_SHADOWS } from '../../../adapters/opencode/rules.js';
import { pathsPrefix } from '../../../adapters/opencode/atoms.js';
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
import { agents, atom, goldenCases, inputOf, skills } from '../claude/fixtures.js';

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

describe('opencode golden(含 personal 原子被跳过的用例;技能与子代理输出为空)', () => {
  for (const [name, input] of Object.entries(goldenCases())) {
    it(`golden:${name}`, async () => {
      await assertGolden({
        goldenDir: path.join(REPO_ROOT, 'test/golden/opencode', name),
        actual: renderOutputToTree(render(input)),
      });
    });
  }

  it('golden 目录里只有用例目录(没有陈旧的用例)', async () => {
    const dirs = (await readDir(path.join(REPO_ROOT, 'test/golden/opencode')))
      .filter((e) => e.isDirectory)
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual(Object.keys(goldenCases()).sort());
  });
});

describe('OpenCode 只渲染规则:技能与子代理输出为空(防以后误开)', () => {
  it('输入里有技能和子代理时,renderSkills / renderAgents 直接调用都返回空文件列表', () => {
    const input = inputOf();
    expect(input.skills.length).toBe(3); // 正向控制:输入确实非空
    expect(input.agents.length).toBe(3);
    const s = adapter.renderSkills?.(structuredClone(input));
    const a = adapter.renderAgents?.(structuredClone(input));
    expect(s).toBeDefined();
    expect(a).toBeDefined();
    expect(s?.files).toEqual([]);
    expect(a?.files).toEqual([]);
  });

  it('经 renderAll 后输出里没有任何技能或子代理路径', () => {
    const o = render();
    expect(o.files.length).toBeGreaterThan(0); // 正向控制:规则文件在
    for (const f of o.files) {
      expect(f.relPath, f.relPath).not.toMatch(/skills?\/|agents?\/|SKILL\.md/);
      expect(f.sourceRefs ?? [], f.relPath).toEqual([]);
    }
    expect(o.files.map((f) => keyOfFile(f)).sort()).toEqual([
      'opencode/home/.config/opencode/AGENTS.md',
      'opencode/project/AGENTS.md',
    ]);
  });

  it('只有技能和子代理、没有规则原子时,整个输出为空', () => {
    const o = render(inputOf({ resolved: [] }));
    expect(o.files).toEqual([]);
  });

  it('报告说明为什么没渲染:列出未渲染的技能与子代理名,登记 P-Q6', () => {
    const o = render();
    const sk = o.report.dropped.find((d) => d.field === 'skills');
    const ag = o.report.dropped.find((d) => d.field === 'agents');
    expect(sk?.reason).toContain('P-Q6');
    for (const n of ['alpha-full', 'synced', 'zeta-plain']) expect(sk?.reason).toContain(n);
    expect(ag?.reason).toContain('留 P1');
    for (const n of ['diff-reviewer', 'implementer', 'web-scout']) expect(ag?.reason).toContain(n);
    expect(o.report.pendingProbes.map((p) => p.id)).toContain('P-Q6');
    // 没有输入时不凭空声称丢了东西
    const none = render(inputOf({ skills: [], agents: [] }));
    expect(none.report.dropped.some((d) => d.field === 'skills' || d.field === 'agents')).toBe(
      false,
    );
    expect(skills().length).toBe(3);
    expect(agents().length).toBe(3);
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

  it('全是 personal 原子:没有任何输出文件,报告写明已跳过', () => {
    const input = goldenCases()['personal-only'] as RenderInput;
    expect(input.resolved.length).toBeGreaterThan(0); // 正向控制
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

  it('落点:全局 ~/.config/opencode/AGENTS.md 与项目 AGENTS.md;恰好一个 intact 托管块', () => {
    for (const key of ['home:.config/opencode/AGENTS.md', 'project:AGENTS.md']) {
      const f = byPath(o).get(key) as OutFile;
      expect(f.mode).toBe('managed-block');
      const parsed = parseManagedBlocks(f.content);
      expect(parsed.ok && parsed.blocks.length === 1).toBe(true);
    }
  });

  it('confidence=assumed(文档无版本号、本机 1.1.19 落后),不设 conditional,没有 probed', () => {
    expect(o.files.length).toBeGreaterThan(0);
    for (const f of o.files) {
      expect(f.confidence, keyOfFile(f)).toBe('assumed');
      expect(f.conditional, keyOfFile(f)).toBeUndefined();
    }
  });

  it('全局块 = org + team,项目块 = project;状态/applies_to 过滤', () => {
    const home = text(o, 'home:.config/opencode/AGENTS.md');
    for (const id of ['org-must-z', 'org-should-a', 'org-paths', 'team-should-b', 'team-paths']) {
      expect(home, id).toContain(id);
    }
    for (const gone of [
      'only-codex',
      'only-claude',
      'still-proposed',
      'personal-secret-pref',
      'project-should',
    ]) {
      expect(home, gone).not.toContain(gone);
    }
    const proj = text(o, 'project:AGENTS.md');
    expect(proj).toContain('project-should');
    expect(proj).not.toContain('org-must-z');
  });

  it('applies_to 含 opencode 的原子被渲染,只含别家的不渲染', () => {
    const input = inputOf({
      resolved: [
        atom({ id: 'only-oc', layer: 'org', applies_to: ['opencode'] }),
        atom({ id: 'only-pi', layer: 'org', applies_to: ['pi'] }),
      ],
    });
    const home = text(render(input), 'home:.config/opencode/AGENTS.md');
    expect(home).toContain('only-oc');
    expect(home).not.toContain('only-pi');
  });

  it('paths 降级为标题后前缀;dropped 每条带文件与原因', () => {
    expect(pathsPrefix(['docs/**'])).toBe('仅在处理 `docs/**` 时适用。');
    const home = text(o, 'home:.config/opencode/AGENTS.md');
    expect(home).toContain('### [should] 标题 team-paths\n\n仅在处理 `docs/**` 时适用。\n\n');
    const d = o.report.dropped.filter((x) => x.field === 'paths');
    expect(d).toHaveLength(3);
    expect(d.every((x) => x.reason.includes('没有路径作用域') && x.file !== undefined)).toBe(true);
  });

  it('无 paths 的原子:同输入下 opencode 与 codex 渲染出的段落逐字节相同(防两份实现漂移)', () => {
    const input = inputOf({ resolved: [atom({ id: 'project-x', layer: 'project' })] });
    const c = renderAll(input, createRegistry([codexAdapter]));
    const x = render(input);
    expect(x.files.find((f) => f.relPath === 'AGENTS.md')?.content).toBe(
      c.files.find((f) => f.relPath === 'AGENTS.md')?.content,
    );
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

  it('sideEffects 写明:一旦存在不再回退读 ~/.claude/CLAUDE.md', () => {
    const s = o.report.sideEffects.find((x) =>
      x.startsWith('opencode/home/.config/opencode/AGENTS.md: '),
    );
    expect(s).toContain('不再回退读 ~/.claude/CLAUDE.md');
  });

  it('遮蔽文件清单:OPENCODE_DISABLE_CLAUDE_CODE*、OPENCODE_CONFIG_DIR、托管配置都在', () => {
    const home = o.report.shadowChecks.filter((s) =>
      s.startsWith('opencode/home/.config/opencode/AGENTS.md: '),
    );
    const proj = o.report.shadowChecks.filter((s) => s.startsWith('opencode/project/AGENTS.md: '));
    expect(home).toHaveLength(HOME_SHADOWS.length);
    expect(proj).toHaveLength(PROJECT_SHADOWS.length);
    // 字面数量:清单被误删一项时,上面两个与清单自身比较的断言不会红
    expect(home).toHaveLength(3);
    expect(proj).toHaveLength(2);
    const h = home.join('\n');
    for (const needle of ['OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_CONFIG_DIR', '托管配置']) {
      expect(h, needle).toContain(needle);
    }
  });

  it('shadowChecks 只列出,不检查真实文件', () => {
    expect(o.report.shadowChecks.every((s) => s.includes('P0 不检查'))).toBe(true);
  });

  it('pendingProbes 含 P-Q6、paths 前缀探针与未跑探针声明(写明版本缺口)', () => {
    expect(o.report.pendingProbes.map((p) => p.id)).toEqual(
      expect.arrayContaining(['P-Q6', 'opencode-paths-prefix-effect', 'compat-probe-not-run']),
    );
    const d = o.report.pendingProbes.find((p) => p.id === 'compat-probe-not-run')?.description;
    expect(d).toContain('1.1.19');
    expect(d).toContain('tested_versions 为空');
    expect(o.report.dropped.every((x) => x.reason.trim().length > 0)).toBe(true);
  });

  it('managed-targets.json 符合 schema:只声明规则落点(不含技能与子代理目录);tested_versions 为空且与 adapter 一致', async () => {
    const meta = AdapterMetaSchema.parse(
      JSON.parse(await readText(path.join(REPO_ROOT, 'adapters/opencode/managed-targets.json'))),
    );
    expect(meta.agent).toBe('opencode');
    expect(meta.tested_versions).toEqual([...adapter.testedVersions]);
    expect(meta.tested_versions).toEqual([]);
    expect(meta.managed_targets).toEqual(['~/.config/opencode/AGENTS.md']);
    const covered = (rel: string): boolean =>
      meta.managed_targets.some((t) => {
        const p = t.replace(/^~\//, '');
        return p.endsWith('/') ? rel.startsWith(p) : rel === p;
      });
    const homes = o.files.filter((x) => x.target === 'home');
    expect(homes.length).toBeGreaterThan(0);
    for (const x of homes) expect(covered(x.relPath), x.relPath).toBe(true);
  });

  it('默认注册表里 opencode 适配器就是本适配器', () => {
    expect(defaultRegistry.get('opencode')).toBe(adapter);
    const all = renderAll(inputOf(), defaultRegistry);
    expect(new Set(all.files.map((x) => x.agent))).toContain('opencode');
  });
});

describe('四家共写仓库根 AGENTS.md(codex / pi / kimi / opencode)', () => {
  it('四个项目托管块各自 intact、内容一致、块 id 相同;输出路径按 agent 分开不冲突', () => {
    const reg = createRegistry([codexAdapter, piAdapter, kimiAdapter, adapter]);
    const all = renderAll(inputOf(), reg);
    const projects = all.files.filter((f) => f.target === 'project' && f.relPath === 'AGENTS.md');
    expect(projects.map((f) => f.agent).sort()).toEqual(['codex', 'kimi', 'opencode', 'pi']);
    const ids = new Set<string>();
    for (const f of projects) {
      const parsed = parseManagedBlocks(f.content);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.blocks).toHaveLength(1);
        ids.add(parsed.blocks[0]?.id ?? '');
      }
    }
    expect(ids.size).toBe(1);
    expect(new Set(projects.map((f) => f.content)).size).toBe(1); // 同输入下四家项目块逐字节相同
  });
});

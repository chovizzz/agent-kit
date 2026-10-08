import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { adapter } from '../../../adapters/kimi/index.js';
import { adapter as codexAdapter } from '../../../adapters/codex/index.js';
import { SKILL_FRONTMATTER_KEYS } from '../../../adapters/kimi/skills.js';
import { HOME_SHADOWS, PROJECT_SHADOWS } from '../../../adapters/kimi/rules.js';
import { pathsPrefix } from '../../../adapters/kimi/atoms.js';
import { kimiTools } from '../../../adapters/kimi/tools.js';
import {
  KIMI_AGENT_FIELDS,
  KIMI_HOOK_FIELDS,
  pickKimiAgentFields,
  pickKimiHookFields,
} from '../../../adapters/kimi/whitelist.js';
import { AdapterMetaSchema } from '../../../src/contracts/render.js';
import type { OutFile, RenderInput, RenderOutput } from '../../../src/contracts/render.js';
import { NeutralAgentSchema } from '../../../src/contracts/agent-def.js';
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
import { SkillSchema } from '../../../src/contracts/skill.js';
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

describe('kimi golden(含 personal 原子被跳过的用例)', () => {
  for (const [name, input] of Object.entries(goldenCases())) {
    it(`golden:${name}`, async () => {
      await assertGolden({
        goldenDir: path.join(REPO_ROOT, 'test/golden/kimi', name),
        actual: renderOutputToTree(render(input)),
      });
    });
  }

  it('golden 目录里只有用例目录(没有陈旧的用例)', async () => {
    const dirs = (await readDir(path.join(REPO_ROOT, 'test/golden/kimi')))
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

  it('全是 personal 原子:没有任何规则输出文件(没有空的 AGENTS.md 块),报告写明已跳过', () => {
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

  it('落点:全局 ~/.kimi-code/AGENTS.md(按空文件渲染)与项目 AGENTS.md;恰好一个 intact 托管块;documented', () => {
    for (const key of ['home:.kimi-code/AGENTS.md', 'project:AGENTS.md']) {
      const f = byPath(o).get(key) as OutFile;
      expect(f.mode).toBe('managed-block');
      const parsed = parseManagedBlocks(f.content);
      expect(parsed.ok && parsed.blocks.length === 1).toBe(true);
      expect(f.confidence).toBe('documented');
      expect(f.conditional).toBeUndefined();
    }
  });

  it('不渲染 ~/.agents/AGENTS.md(Kimi 两处都读,写两处会重复加载)', () => {
    expect(o.files.some((f) => f.relPath === '.agents/AGENTS.md')).toBe(false);
    expect(o.files.map((f) => f.relPath).sort()).toEqual([
      '.agents/skills/alpha-full/SKILL.md',
      '.agents/skills/synced/SKILL.md',
      '.agents/skills/zeta-plain/SKILL.md',
      '.kimi-code/AGENTS.md',
      '.kimi-code/agents/diff-reviewer.md',
      '.kimi-code/agents/implementer.md',
      '.kimi-code/agents/web-scout.md',
      'AGENTS.md',
    ]);
  });

  it('全局块 = org + team,项目块 = project;状态/applies_to 过滤', () => {
    const home = text(o, 'home:.kimi-code/AGENTS.md');
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
  });

  it('applies_to 含 kimi 的原子被渲染,只含别家的不渲染', () => {
    const input = inputOf({
      resolved: [
        atom({ id: 'only-kimi', layer: 'org', applies_to: ['kimi'] }),
        atom({ id: 'only-pi', layer: 'org', applies_to: ['pi'] }),
      ],
    });
    const home = text(render(input), 'home:.kimi-code/AGENTS.md');
    expect(home).toContain('only-kimi');
    expect(home).not.toContain('only-pi');
  });

  it('paths 降级为标题后前缀,不生成独立规则文件;dropped 每条带文件与原因', () => {
    expect(pathsPrefix(['docs/**'])).toBe('仅在处理 `docs/**` 时适用。');
    const home = text(o, 'home:.kimi-code/AGENTS.md');
    expect(home).toContain('### [should] 标题 team-paths\n\n仅在处理 `docs/**` 时适用。\n\n');
    const d = o.report.dropped.filter((x) => x.field === 'paths');
    expect(d.map((x) => x.file).sort()).toEqual([
      'kimi/home/.kimi-code/AGENTS.md',
      'kimi/home/.kimi-code/AGENTS.md',
      'kimi/project/AGENTS.md',
    ]);
    expect(d.every((x) => x.reason.includes('没有路径作用域') && x.reason.length > 20)).toBe(true);
  });

  it('无 paths 的原子:同输入下 kimi 与 codex 渲染出的段落逐字节相同(防两份实现漂移)', () => {
    const input = inputOf({ resolved: [atom({ id: 'project-x', layer: 'project' })] });
    const c = renderAll(input, createRegistry([codexAdapter]));
    const x = render(input);
    expect(x.files.find((f) => f.relPath === 'AGENTS.md')?.content).toBe(
      c.files.find((f) => f.relPath === 'AGENTS.md')?.content,
    );
  });
});

describe('技能', () => {
  const o = render();
  const skillFiles = o.files.filter((f) => f.relPath.includes('skills/'));

  it('写到 ~/.agents/skills/<name>/SKILL.md,不写 ~/.kimi-code/skills', () => {
    expect(skillFiles.map((f) => f.relPath)).toEqual([
      '.agents/skills/alpha-full/SKILL.md',
      '.agents/skills/synced/SKILL.md',
      '.agents/skills/zeta-plain/SKILL.md',
    ]);
    expect(o.files.some((f) => f.relPath.includes('.kimi-code/skills'))).toBe(false);
  });

  it('frontmatter 只用共同子集的键', () => {
    for (const f of skillFiles) {
      expect(f.content.split('\n')[0]).toBe('---');
      const keys = Object.keys(frontmatterOf(f.content));
      expect(keys.every((k) => (SKILL_FRONTMATTER_KEYS as readonly string[]).includes(k))).toBe(
        true,
      );
    }
  });

  it('同一技能 kimi 与 codex 渲染出的 SKILL.md 逐字节相同(共同子集,防漂移)', () => {
    const c = renderAll(inputOf(), createRegistry([codexAdapter]));
    for (const name of ['alpha-full', 'zeta-plain']) {
      expect(o.files.find((f) => f.relPath === `.agents/skills/${name}/SKILL.md`)?.content).toBe(
        c.files.find((f) => f.relPath === `.agents/skills/${name}/SKILL.md`)?.content,
      );
    }
  });

  it('confidence:只有 name+description 的 documented;带 license/compatibility/metadata 的 assumed', () => {
    const conf = (n: string): string | undefined =>
      o.files.find((f) => f.relPath === `.agents/skills/${n}/SKILL.md`)?.confidence;
    expect(conf('zeta-plain')).toBe('documented');
    expect(conf('alpha-full')).toBe('assumed');
    expect(o.report.pendingProbes.map((p) => p.id)).toContain('kimi-skill-optional-fields');
  });

  it('正文含 Kimi 占位符形态时 sideEffects 提示;不含时不提示', () => {
    const mk = (body: string): RenderInput =>
      inputOf({
        skills: [
          SkillSchema.parse({
            fm: { name: 'ph-skill', description: 'd' },
            body,
            sourceDir: 'skills/ph-skill',
            files: [{ relPath: 'SKILL.md', bytes: 1, sha256: 'b'.repeat(64) }],
          }),
        ],
      });
    const hit = render(mk('用 $ARGUMENTS 和 ${KIMI_SKILL_DIR}\n'));
    expect(hit.report.sideEffects.some((s) => s.includes('Kimi 会在送给模型前展开'))).toBe(true);
    const named = render(mk('具名参数 $pr_ref\n'));
    expect(named.report.sideEffects.some((s) => s.includes('不会被展开'))).toBe(true);
    const miss = render(mk('普通正文\n'));
    expect(miss.report.sideEffects.some((s) => s.includes('Kimi 会在送给模型前展开'))).toBe(false);
  });

  it('资源文件只有清单没有内容:dropped 列出文件名与原因', () => {
    const d = o.report.dropped.find((x) => x.field === 'files');
    expect(d?.file).toBe('kimi/home/.agents/skills/alpha-full/SKILL.md');
    expect(d?.reason).toContain('references/guide.md');
  });
});

describe('子代理 md(Kimi:去掉 model,严格字段白名单)', () => {
  const o = render();
  const f = (n: string): string => text(o, `home:.kimi-code/agents/${n}.md`);
  const names = ['diff-reviewer', 'implementer', 'web-scout'];

  it('任何子代理文件都不含 model 字段(即使覆盖层给了档位映射模型)', () => {
    expect(agents().length).toBe(3); // 正向控制
    for (const n of names) {
      expect(f(n), n).not.toMatch(/^\s*model\s*:/im);
      expect(Object.keys(frontmatterOf(f(n))), n).not.toContain('model');
    }
    // 覆盖层真的映射了 kimi 档位也不写(渲染器不读 model_tiers.kimi)
    const withKimiOverlay = render(
      inputOf({ overlay: { model_tiers: { kimi: { judge: 'x-kimi-judge' } } } }),
    );
    for (const n of names) {
      expect(text(withKimiOverlay, `home:.kimi-code/agents/${n}.md`)).not.toContain('x-kimi-judge');
      expect(text(withKimiOverlay, `home:.kimi-code/agents/${n}.md`)).not.toMatch(
        /^\s*model\s*:/im,
      );
    }
  });

  it('frontmatter 键 ⊆ 白名单,且恰为 name / description / tools(顺序固定)', () => {
    for (const n of names) {
      const keys = Object.keys(frontmatterOf(f(n)));
      expect(keys, n).toEqual(['name', 'description', 'tools']);
      expect(keys.every((k) => (KIMI_AGENT_FIELDS as readonly string[]).includes(k))).toBe(true);
    }
  });

  it('每个子代理都显式写了非空 tools 白名单(缺省=全部工具,会让只读代理变全权限)', () => {
    for (const n of names) {
      const tools = frontmatterOf(f(n))['tools'];
      expect(Array.isArray(tools), n).toBe(true);
      expect((tools as string[]).length, n).toBeGreaterThan(0);
    }
  });

  it('工具类别映射:read→Read/Grep/Glob,shell→Bash,edit→Edit/Write,web→WebSearch/FetchURL,agent→Agent', () => {
    expect(frontmatterOf(f('diff-reviewer'))['tools']).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(frontmatterOf(f('implementer'))['tools']).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Edit',
      'Write',
      'Bash',
    ]);
    expect(frontmatterOf(f('web-scout'))['tools']).toEqual(['WebSearch', 'FetchURL', 'Agent']);
    // 只读代理(没有 edit 类别)绝不能拿到写工具
    const ro = frontmatterOf(f('diff-reviewer'))['tools'] as string[];
    expect(ro.some((t) => ['Edit', 'Write'].includes(t))).toBe(false);
    expect(() => kimiTools([])).toThrow();
  });

  it('web 类别用 Kimi 自己的抓取工具名 FetchURL,不是 Claude 的 WebFetch;agent 类别不自动授予 AgentSwarm,写 dropped', () => {
    expect(f('web-scout')).not.toContain('WebFetch');
    expect(f('web-scout')).toContain('FetchURL');
    expect(f('web-scout')).not.toContain('AgentSwarm');
    const d = o.report.dropped.find((x) => x.field === 'tools');
    expect(d?.file).toBe('kimi/home/.kimi-code/agents/web-scout.md');
    expect(d?.reason).toContain('AgentSwarm');
    expect(o.report.dropped.filter((x) => x.field === 'tools')).toHaveLength(1);
  });

  it('model_tier 每个代理记一条 dropped(Kimi 忽略 model)', () => {
    const d = o.report.dropped.filter((x) => x.field === 'model_tier');
    expect(d.map((x) => x.file)).toEqual(names.map((n) => `kimi/home/.kimi-code/agents/${n}.md`));
    expect(d.every((x) => x.reason.includes('忽略'))).toBe(true);
    // 没有覆盖层时同样记录(与覆盖层无关)
    const bare = render(inputOf({ overlay: {} }));
    expect(bare.report.dropped.filter((x) => x.field === 'model_tier')).toHaveLength(3);
  });

  it('confidence:含 edit/web 类别(工具名只有二手出处)的 assumed,只用 read/shell/agent 的 documented', () => {
    const conf = (n: string): string | undefined =>
      byPath(o).get(`home:.kimi-code/agents/${n}.md`)?.confidence;
    expect(conf('diff-reviewer')).toBe('documented');
    expect(conf('implementer')).toBe('assumed');
    expect(conf('web-scout')).toBe('assumed');
    expect(o.report.pendingProbes.map((p) => p.id)).toContain('kimi-tool-names');
  });

  it('正文就是 prompt;正文含 ${...} 时 sideEffects 提示模板展开', () => {
    expect(f('diff-reviewer').endsWith('\n\n你是只读的代码评审者。\n只输出问题清单。\n')).toBe(
      true,
    );
    expect(o.report.sideEffects.some((s) => s.includes('按模板展开'))).toBe(false);
    const withVar = render(
      inputOf({
        agents: [
          NeutralAgentSchema.parse({
            name: 'tpl-agent',
            description: 'd',
            prompt: '在 ${cwd} 下工作',
            tools: ['read'],
            model_tier: 'readonly',
          }),
        ],
      }),
    );
    expect(withVar.report.sideEffects.some((s) => s.includes('按模板展开'))).toBe(true);
  });

  it('与 Kimi 内置子代理同名时写入 shadowChecks(内置不会被目录文件覆盖)', () => {
    const o2 = render(
      inputOf({
        agents: [
          NeutralAgentSchema.parse({
            name: 'explore',
            description: 'd',
            prompt: 'p',
            tools: ['read'],
            model_tier: 'readonly',
          }),
        ],
      }),
    );
    expect(o2.report.shadowChecks.some((s) => s.includes('与 Kimi 内置子代理同名'))).toBe(true);
    expect(o.report.shadowChecks.some((s) => s.includes('与 Kimi 内置子代理同名'))).toBe(false);
  });

  it('白名单函数:钩子只认 event/matcher/command/timeout,多余键被丢弃并返回;agent 白名单同理', () => {
    expect([...KIMI_HOOK_FIELDS]).toEqual(['event', 'matcher', 'command', 'timeout']);
    const r = pickKimiHookFields({
      timeout: 5,
      command: 'x',
      event: 'PreToolUse',
      extra: 1,
      blocking: true,
    });
    expect(r.kept).toEqual({ event: 'PreToolUse', command: 'x', timeout: 5 });
    expect(Object.keys(r.kept)).toEqual(['event', 'command', 'timeout']); // 键序跟白名单一致
    expect(r.dropped).toEqual(['blocking', 'extra']);
    const a = pickKimiAgentFields({ name: 'n', model: 'm', mode: 'subagent', tools: ['Read'] });
    expect(a.kept).toEqual({ name: 'n', tools: ['Read'] });
    expect(a.dropped).toEqual(['mode', 'model']);
  });

  it('代理列表为空时没有子代理文件', () => {
    expect(
      render(inputOf({ agents: [] })).files.some((x) => x.relPath.includes('.kimi-code/agents/')),
    ).toBe(false);
  });

  it('adapters/kimi 源码里没有具体模型名', async () => {
    const dir = path.join(REPO_ROOT, 'adapters/kimi');
    const files = (await readDir(dir)).filter((e) => e.name.endsWith('.ts')).map((e) => e.name);
    expect(files.length).toBeGreaterThan(5);
    for (const n of files) {
      const src = await readText(path.join(dir, n));
      expect(src.length, n).toBeGreaterThan(0);
      expect(src, n).not.toMatch(
        /\b(sonnet|opus|haiku|fable|gpt-\d|gemini|kimi-for|deepseek|glm-\d)/i,
      );
    }
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

  it('sideEffects 写明将替换陈旧拷贝、不渲染 ~/.agents/AGENTS.md', () => {
    const s = o.report.sideEffects.join('\n');
    expect(s).toContain('将替换');
    expect(s).toContain('陈旧');
    expect(s).toContain('不渲染 ~/.agents/AGENTS.md');
  });

  it('遮蔽文件清单:SYSTEM.md、override: true 的 agent 文件、KIMI_CODE_HOME 都在', () => {
    const home = o.report.shadowChecks.filter((s) =>
      s.startsWith('kimi/home/.kimi-code/AGENTS.md: '),
    );
    const proj = o.report.shadowChecks.filter((s) => s.startsWith('kimi/project/AGENTS.md: '));
    expect(home).toHaveLength(HOME_SHADOWS.length);
    expect(proj).toHaveLength(PROJECT_SHADOWS.length);
    // 字面数量:清单被误删一项时,上面两个与清单自身比较的断言不会红
    expect(home).toHaveLength(3);
    expect(proj).toHaveLength(2);
    const h = home.join('\n');
    for (const needle of ['SYSTEM.md', 'override: true', 'KIMI_CODE_HOME']) {
      expect(h, needle).toContain(needle);
    }
  });

  it('shadowChecks 只列出,不检查真实文件', () => {
    expect(o.report.shadowChecks.every((s) => s.includes('P0 不检查'))).toBe(true);
  });

  it('pendingProbes 含 P-Q5、paths 前缀探针与未跑探针声明(写明本机/文档版本差);没有任何 probed', () => {
    expect(o.report.pendingProbes.map((p) => p.id)).toEqual(
      expect.arrayContaining(['P-Q5', 'kimi-paths-prefix-effect', 'compat-probe-not-run']),
    );
    expect(
      o.report.pendingProbes.find((p) => p.id === 'compat-probe-not-run')?.description,
    ).toContain('2.0.0');
    expect(o.files.some((f) => f.confidence === 'probed')).toBe(false);
    expect(o.report.dropped.every((d) => d.reason.trim().length > 0)).toBe(true);
  });

  it('managed-targets.json 符合 schema,与 adapter 一致,每个 home 输出都落在声明的落点内', async () => {
    const meta = AdapterMetaSchema.parse(
      JSON.parse(await readText(path.join(REPO_ROOT, 'adapters/kimi/managed-targets.json'))),
    );
    expect(meta.agent).toBe('kimi');
    expect(meta.tested_versions).toEqual([...adapter.testedVersions]);
    expect(meta.tested_versions).toEqual([]); // 文档版本 2.1.1 ≠ 调研时本机 2.0.0,没有任何已验证版本
    expect(meta.managed_targets).not.toContain('~/.agents/AGENTS.md');
    const covered = (rel: string): boolean =>
      meta.managed_targets.some((t) => {
        const p = t.replace(/^~\//, '');
        return p.endsWith('/') ? rel.startsWith(p) : rel === p;
      });
    const homes = o.files.filter((x) => x.target === 'home');
    expect(homes.length).toBeGreaterThan(0);
    for (const x of homes) expect(covered(x.relPath), x.relPath).toBe(true);
  });

  it('默认注册表里 kimi 适配器就是本适配器', () => {
    expect(defaultRegistry.get('kimi')).toBe(adapter);
    const all = renderAll(inputOf(), defaultRegistry);
    expect(new Set(all.files.map((x) => x.agent))).toContain('kimi');
  });
});

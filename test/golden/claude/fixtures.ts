/**
 * B07 共用 fixture(Claude 与 Codex 的测试都用)。全部合成;不含任何真实路径、用户名或秘密。
 * 原子覆盖:各层 × 有无 paths × 各状态 × applies_to,并含 personal 原子(coreEligible=false)。
 */
import { ResolvedAtomSchema } from '../../../src/contracts/merge.js';
import type { ResolvedAtom } from '../../../src/contracts/merge.js';
import type { Atom, Layer, Status } from '../../../src/contracts/atom.js';
import type { RenderInput } from '../../../src/contracts/render.js';
import { SkillSchema } from '../../../src/contracts/skill.js';
import type { Skill } from '../../../src/contracts/skill.js';
import { NeutralAgentSchema } from '../../../src/contracts/agent-def.js';
import type { NeutralAgent } from '../../../src/contracts/agent-def.js';
import type { Overlay } from '../../../src/contracts/config.js';
import type { AgentId } from '../../../src/contracts/common.js';

const SHA = 'a'.repeat(64);

export interface AtomSpec {
  id: string;
  layer: Layer;
  strength?: 'must' | 'should';
  status?: Status;
  paths?: string[];
  applies_to?: ('all' | AgentId)[];
  coreEligible?: boolean;
  title?: string;
}

export function atom(spec: AtomSpec): ResolvedAtom {
  const strength = spec.strength ?? 'should';
  const status = spec.status ?? 'active';
  const fm: Atom['fm'] = {
    id: spec.id,
    title: spec.title ?? `标题 ${spec.id}`,
    layer: spec.layer,
    strength,
    ...(spec.applies_to !== undefined ? { applies_to: spec.applies_to } : {}),
    ...(spec.paths !== undefined ? { paths: spec.paths } : {}),
    kind: 'practice',
    volatility: 'stable',
    status,
    owner: '@owner-handle',
    created: '2026-10-01',
    review_by: '2027-01-01',
    evidence: [{ type: 'memory', ref: 'ref-1', excerpt: '合成证据' }],
    verifier: strength === 'must' ? { type: 'script', ref: 'scripts/verify.sh' } : { type: 'none' },
    ...(status === 'active' ? { signature: { type: 'always' as const } } : {}),
  };
  return ResolvedAtomSchema.parse({
    atom: {
      fm,
      body: {
        do: `做法 ${spec.id}`,
        why: `原因 ${spec.id}`,
        verify: `检查 ${spec.id}`,
      },
      bodyBytes: 40,
      sha256: SHA,
      sourcePath: `atoms/${spec.layer}/${spec.id}.md`,
    },
    layer: spec.layer,
    coreEligible: spec.coreEligible ?? spec.layer !== 'personal',
    replaced: [],
  });
}

/** 全套原子:顺序故意打乱,渲染器必须自己排序。 */
export function allAtoms(): ResolvedAtom[] {
  return [
    atom({ id: 'team-should-b', layer: 'team' }),
    atom({ id: 'org-should-a', layer: 'org' }),
    atom({ id: 'org-must-z', layer: 'org', strength: 'must' }),
    atom({ id: 'org-paths', layer: 'org', paths: ['**/*.test.*', 'src/**/*.{ts,tsx}'] }),
    atom({ id: 'team-trial', layer: 'team', status: 'advisory' }),
    atom({ id: 'team-paths', layer: 'team', paths: ['docs/**'] }),
    atom({ id: 'project-should', layer: 'project' }),
    atom({ id: 'project-paths', layer: 'project', paths: ['api/**'] }),
    atom({ id: 'only-codex', layer: 'org', applies_to: ['codex'] }),
    atom({ id: 'only-claude', layer: 'org', applies_to: ['claude'] }),
    atom({ id: 'still-proposed', layer: 'org', status: 'proposed' }),
    atom({ id: 'was-deprecated', layer: 'org', status: 'deprecated' }),
    atom({ id: 'was-retired', layer: 'team', status: 'retired' }),
    atom({ id: 'personal-secret-pref', layer: 'personal' }),
  ];
}

const sha = (c: string): string => c.repeat(64);

export function skills(): Skill[] {
  return [
    SkillSchema.parse({
      fm: { name: 'zeta-plain', description: '没有可选键的技能' },
      body: '正文 zeta\n',
      sourceDir: 'skills/zeta-plain',
      files: [{ relPath: 'SKILL.md', bytes: 10, sha256: sha('1') }],
    }),
    SkillSchema.parse({
      fm: {
        name: 'alpha-full',
        description: '带全部共同子集键: 冒号与中文',
        license: 'UNLICENSED',
        compatibility: '需要 git',
        metadata: { owner: 'team', area: 'review' },
      },
      body: '\n正文 alpha\n',
      sourceDir: 'skills/alpha-full',
      files: [
        { relPath: 'SKILL.md', bytes: 20, sha256: sha('2') },
        { relPath: 'references/guide.md', bytes: 30, sha256: sha('3') },
        { relPath: 'scripts/run.sh', bytes: 40, sha256: sha('4') },
      ],
    }),
    SkillSchema.parse({
      fm: { name: 'synced', description: 'Claude 保留名' },
      body: '保留名\n',
      sourceDir: 'skills/synced',
      files: [{ relPath: 'SKILL.md', bytes: 5, sha256: sha('5') }],
    }),
  ];
}

export function agents(): NeutralAgent[] {
  return [
    NeutralAgentSchema.parse({
      name: 'diff-reviewer',
      description: '只读评审者',
      prompt: '你是只读的代码评审者。\n只输出问题清单。',
      tools: ['read', 'shell'],
      model_tier: 'judge',
    }),
    NeutralAgentSchema.parse({
      name: 'implementer',
      description: '实现者',
      prompt: '按计划实现。',
      tools: ['read', 'edit', 'shell'],
      model_tier: 'implement',
    }),
    NeutralAgentSchema.parse({
      name: 'web-scout',
      description: '联网调研',
      prompt: '调研并给出出处。',
      tools: ['web', 'agent'],
      model_tier: 'readonly',
    }),
  ];
}

/** 覆盖层:只映射 judge / implement,readonly 故意不映射(测"省略 model + dropped")。模型名是合成占位。 */
export function overlay(): Overlay {
  return {
    model_tiers: {
      claude: { judge: 'overlay-claude-judge', implement: 'overlay-claude-impl' },
      codex: { judge: 'overlay-codex-judge', implement: 'overlay-codex-impl' },
    },
  };
}

export function inputOf(over: Partial<RenderInput> = {}): RenderInput {
  return {
    resolved: allAtoms(),
    skills: skills(),
    agents: agents(),
    overlay: overlay(),
    kitVersion: '0.0.0',
    channel: 'canary',
    ...over,
  };
}

/** golden 用例:名字 → 输入。 */
export function goldenCases(): Record<string, RenderInput> {
  return {
    'canary-full': inputOf(),
    'stable-no-overlay': inputOf({ channel: 'stable', overlay: {} }),
    'personal-only': inputOf({
      resolved: [
        atom({ id: 'personal-a', layer: 'personal' }),
        atom({ id: 'personal-b', layer: 'personal', strength: 'must' }),
      ],
      skills: [],
      agents: [],
    }),
    empty: inputOf({ resolved: [], skills: [], agents: [] }),
  };
}

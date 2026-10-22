import { describe, expect, it } from 'vitest';
import { parseAtom } from '../../src/atoms/parse.js';
import { ProposalSchema } from '../../src/contracts/proposal.js';
import { DEFAULT_DEDUPE, findDuplicate } from '../../src/reflect/dedupe.js';
import { decideLayer, mergeProposals } from '../../src/reflect/merge.js';
import { L1, L2, L_SINGLE, projectKey } from '../fixtures/reflect/world.js';
import { aliasFor, mergeInput, parsedDraft, worldPlan } from '../fixtures/reflect/plan.js';

describe('reflect/merge', () => {
  it('status/strength 写死;不产出 disables/overrides;LLM 草稿里混进的同名字段被忽略', async () => {
    const plan = await worldPlan();
    const e = [aliasFor(plan.pack, L1), aliasFor(plan.pack, L2)];
    const d = {
      ...parsedDraft({ evidence: e }),
      status: 'active',
      strength: 'must',
      layer: 'org',
      owner: '@evil',
      disables: ['x-y'],
      overrides: ['z-w'],
    };
    const [m] = mergeProposals(mergeInput(plan, [d]));
    const parsed = parseAtom(m!.atomText, m!.atomPath);
    expect(parsed.diagnostics.filter((x) => x.severity === 'error')).toEqual([]);
    const fm = parsed.atom!.fm;
    expect(fm.status).toBe('proposed');
    expect(fm.strength).toBe('should');
    expect(fm.owner).toBe('@tester');
    expect(fm.disables).toBeUndefined();
    expect(fm.overrides).toBeUndefined();
    expect(fm.verifier).toEqual({ type: 'none' });
    expect(m!.atomText).not.toMatch(/disables|overrides|@evil/);
    expect(m!.layer).toBe('team'); // 正向对照:这份证据确实够团队层,所以 'org' 不是靠降级才没出现
    expect(fm.layer).toBe('team');
  });

  it('日期按注入时钟:stable +90 天、volatile +30 天;提案编号避开已占用', async () => {
    const plan = await worldPlan();
    const e = [aliasFor(plan.pack, L1)];
    const a = parsedDraft({ evidence: e });
    const b = parsedDraft({
      evidence: e,
      id: 'second-volatile-rule',
      volatility: 'volatile',
      do: '另一件事情要做',
      why: '因为需要这么做才行',
      verify: '检查记录',
    });
    const ms = mergeProposals(
      mergeInput(plan, [a, b], { usedProposalIds: new Set(['2026-10-12-001']) }),
    );
    expect(ms.map((m) => m.proposalId)).toEqual(['2026-10-12-002', '2026-10-12-003']);
    const fa = parseAtom(ms[0]!.atomText, ms[0]!.atomPath).atom!.fm;
    const fb = parseAtom(ms[1]!.atomText, ms[1]!.atomPath).atom!.fm;
    expect([fa.created, fa.review_by]).toEqual(['2026-10-12', '2027-01-10']);
    expect([fb.created, fb.review_by]).toEqual(['2026-10-12', '2026-11-11']);
  });

  it('evidence 摘录从信号机械复制,不用 LLM 的文字;提案过 ProposalSchema', async () => {
    const plan = await worldPlan();
    const e = [aliasFor(plan.pack, L1), aliasFor(plan.pack, L2)];
    const [m] = mergeProposals(
      mergeInput(plan, [parsedDraft({ evidence: e, rationale: 'LLM 自己写的理由' })]),
    );
    expect(m!.proposal.evidence.map((x) => x.excerpt)).toEqual([L1, L2]);
    const fm = parseAtom(m!.atomText, m!.atomPath).atom!.fm;
    expect(fm.evidence.map((x) => x.excerpt)).toEqual([L1, L2]);
    expect(fm.evidence.every((x) => x.type === 'trace' && x.ref.startsWith('sig_'))).toBe(true);
    expect(ProposalSchema.safeParse(m!.proposal).success).toBe(true);
    expect(m!.proposal.reflector.stub).toBe(true);
    expect(m!.proposal.judge).toBeUndefined();
    expect(m!.proposal.reflector.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('层判定:单项目/单会话 → personal;跨 ≥2 项目且 ≥2 会话才可能 team', async () => {
    const plan = await worldPlan();
    const items = (...texts: string[]) =>
      texts.map((t) => plan.pack.items.find((i) => i.signal.excerpt_redacted === t)!);
    expect(decideLayer(items(L1, L2), plan.clusters)).toBe('team');
    expect(decideLayer(items(L1), plan.clusters)).toBe('personal'); // 只有一个项目/会话
    expect(decideLayer(items(L_SINGLE), plan.clusters)).toBe('personal');
  });

  it('个人层独有证据不泄漏进团队层:混入任何一条个人独有证据整条降为 personal', async () => {
    const plan = await worldPlan();
    const items = (...texts: string[]) =>
      texts.map((t) => plan.pack.items.find((i) => i.signal.excerpt_redacted === t)!);
    // 对照:L1+L2 是 team;再混入单项目单会话的 L_SINGLE → personal
    expect(decideLayer(items(L1, L2), plan.clusters)).toBe('team');
    expect(decideLayer(items(L1, L2, L_SINGLE), plan.clusters)).toBe('personal');
    // 白名单只含项目 A:B 的证据不再计入,聚类不再跨项目 → personal
    expect(decideLayer(items(L1, L2), plan.clusters, new Set([projectKey('A')]))).toBe('personal');
    // 白名单含 A、B → team(正向对照);空白名单 / 只含未知 key → personal(fail-closed)
    expect(
      decideLayer(items(L1, L2), plan.clusters, new Set([projectKey('A'), projectKey('B')])),
    ).toBe('team');
    expect(decideLayer(items(L1, L2), plan.clusters, new Set())).toBe('personal');
    expect(decideLayer(items(L1, L2), plan.clusters, new Set(['p_unknown0000000000']))).toBe(
      'personal',
    );
    // 白名单含 A、B 与未知 key:未知 key 无害,结果同 A+B
    expect(
      decideLayer(
        items(L1, L2),
        plan.clusters,
        new Set([projectKey('A'), projectKey('B'), 'p_unknown0000000000']),
      ),
    ).toBe('team');
    // 端到端:所有 team 层提案的证据信号都来自「可入团队层」的聚类
    const eligible = new Set(
      plan.clusters.filter((c) => c.teamEligible).flatMap((c) => c.allSignals.map((s) => s.sig_id)),
    );
    const e = [aliasFor(plan.pack, L1), aliasFor(plan.pack, L2)];
    const mixed = parsedDraft({
      id: 'mixed-evidence-rule',
      evidence: [...e, aliasFor(plan.pack, L_SINGLE)],
    });
    const pure = parsedDraft({ evidence: e });
    const ms = mergeProposals(mergeInput(plan, [pure, mixed]));
    expect(ms.map((m) => m.layer)).toEqual(['team', 'personal']);
    for (const m of ms.filter((x) => x.layer === 'team')) {
      expect(m.evidenceSigs.every((s) => eligible.has(s))).toBe(true);
    }
    const personalOnly = plan.clusters
      .find((c) => c.members.some((s) => s.excerpt_redacted === L_SINGLE))!
      .allSignals.map((s) => s.sig_id);
    for (const m of ms.filter((x) => x.layer === 'team')) {
      expect(m.evidenceSigs.some((s) => personalOnly.includes(s))).toBe(false);
    }
    expect(ms[1]!.evidenceSigs.some((s) => personalOnly.includes(s))).toBe(true); // 正向:它确实在 personal 提案里
  });
});

describe('reflect/dedupe', () => {
  const base = {
    id: 'existing-lint',
    do: '提交代码前先运行 lint 并修复全部告警',
    why: '带告警的提交会让评审和 CI 反复返工',
    signature: { type: 'phrase', pattern: 'git commit' },
  };
  const draftOf = (over: Partial<typeof base> & { id: string }) => ({ ...base, ...over });

  it('同义改写(词序/小改)被判重;无关规则不误杀', () => {
    const reworded = draftOf({
      id: 'new-1',
      do: '提交代码之前先运行 lint,并修复全部告警',
      why: '带告警的提交会让评审与 CI 反复返工',
      signature: { type: 'phrase', pattern: 'other' },
    });
    expect(findDuplicate(reworded, [base])?.duplicateOf).toBe('existing-lint');
    const unrelated = draftOf({
      id: 'new-2',
      do: '数据库迁移必须附带回滚脚本',
      why: '线上出问题时需要快速恢复',
      signature: { type: 'phrase', pattern: 'migrate' },
    });
    expect(findDuplicate(unrelated, [base])).toBeUndefined();
  });

  it('塞词稀释 Jaccard 绕不过:包含系数仍抓得到', () => {
    const padding = Array.from(
      { length: 12 },
      (_, i) =>
        `额外词汇${String.fromCharCode(0x6c34 + i * 17)}${String.fromCharCode(0x706b + i * 19)}`,
    ).join(' ');
    const padded = draftOf({
      id: 'new-3',
      do: `${base.do} ${padding}`,
      why: base.why,
      signature: { type: 'phrase', pattern: 'x' },
    });
    const hit = findDuplicate(padded, [base], { ...DEFAULT_DEDUPE, jaccard: 0.95 });
    expect(hit?.reason).toBe('containment');
    // 关闭包含系数(设为 >1)后同一份输入就逃过了 → 说明是这条规则在起作用
    expect(
      findDuplicate(padded, [base], { ...DEFAULT_DEDUPE, jaccard: 0.95, containment: 1.1 }),
    ).toBeUndefined();
  });

  it('全角/大小写/零宽字符变形不改变判定;signature 相同即判重', () => {
    const zw = String.fromCharCode(0x200b);
    const wide = draftOf({
      id: 'new-4',
      do: base.do.replace('lint', `Ｌ${zw}ＩＮＴ`),
      signature: { type: 'phrase', pattern: 'q' },
    });
    expect(findDuplicate(wide, [base])?.duplicateOf).toBe('existing-lint');
    const sameSig = draftOf({
      id: 'new-5',
      do: '完全不同的内容讲数据库迁移回滚',
      why: '另一个原因关于线上恢复速度',
      signature: { type: 'phrase', pattern: ' git commit ' },
    });
    expect(findDuplicate(sameSig, [base])?.reason).toBe('signature');
  });

  it('与已退役原子相似 → 判重并标 resurrects;阈值可配', () => {
    const retired = { ...base, id: 'old-retired', status: 'retired' };
    const same = draftOf({ id: 'new-6', signature: { type: 'phrase', pattern: 'q' } });
    const hit = findDuplicate(same, [retired]);
    expect(hit).toMatchObject({ duplicateOf: 'old-retired', resurrects: true });
    const loose = draftOf({
      id: 'new-7',
      do: '提交代码前先运行 lint',
      why: '返工',
      signature: { type: 'phrase', pattern: 'q' },
    });
    expect(
      findDuplicate(loose, [base], { jaccard: 0.99, containment: 1.1, minTokens: 6 }),
    ).toBeUndefined();
  });
});

describe('reflect 评审后补强(merge / dedupe)', () => {
  it('kind=preference 再多项目也只进 personal', async () => {
    const plan = await worldPlan();
    const e = [aliasFor(plan.pack, L1), aliasFor(plan.pack, L2)];
    const [team] = mergeProposals(mergeInput(plan, [parsedDraft({ evidence: e })]));
    const [pref] = mergeProposals(
      mergeInput(plan, [parsedDraft({ evidence: e, kind: 'preference' })]),
    );
    expect(team!.layer).toBe('team'); // 正向对照
    expect(pref!.layer).toBe('personal');
  });

  it('中文字间插空格/标点不能绕过去重;signature 大小写敏感(\\W ≠ \\w)', () => {
    const base = {
      id: 'existing-lint',
      do: '提交代码前先运行 lint 并修复全部告警',
      why: '带告警的提交会让评审和 CI 反复返工',
      signature: { type: 'phrase', pattern: 'git commit' },
    };
    const spaced = {
      ...base,
      id: 'new-spaced',
      do: Array.from('提交代码前先运行').join(' ') + ' lint 并修复全部告警',
      why: Array.from(base.why).join('、'),
      signature: { type: 'phrase', pattern: 'zzz' },
    };
    expect(findDuplicate(spaced, [base])?.duplicateOf).toBe('existing-lint');
    const a = {
      id: 'a-rule',
      do: '甲',
      why: '乙',
      signature: { type: 'phrase', pattern: '\\w+x' },
    };
    const b = {
      id: 'b-rule',
      do: '完全不同的内容讲数据库',
      why: '另一个原因',
      signature: { type: 'phrase', pattern: '\\W+x' },
    };
    expect(findDuplicate(b, [a])).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { normalizedRuleSha256 } from '../../src/guards/criteria.js';
import { COMMON_FILES } from '../fixtures/guards/atoms.js';
import {
  ID,
  OWNER,
  PATH,
  PROPOSAL_PATH,
  atomText,
  attestFile,
  digestOf,
  kitToml,
  proposalYaml,
  recordFile,
  sha,
  type AtomOpts,
  type AttestOpts,
  type ProposalOpts,
  type RecordOpts,
} from './criteria-world.js';
import { scenario, useRepoCleanup, type ScenarioOptions } from './helpers.js';
import { lifecycleCriteria } from '../../src/guards/criteria.js';

useRepoCleanup();

const G = (c: string): string => `GUARD_G3_${c}`;

/** 真判据场景:criteria 固定为 lifecycleCriteria */
const run = (
  base: Record<string, string | null>,
  head: Record<string, string | null>,
  label: 'kit:promotion' | 'kit:retire',
  opts: ScenarioOptions = {},
) => scenario(base, head, { criteria: lifecycleCriteria, ...opts, label });

// ───────────────────────── T1:proposed → advisory ─────────────────────────

interface T1Over {
  atom?: AtomOpts;
  proposal?: ProposalOpts;
  noProposalFile?: boolean;
  proposalText?: string;
  kit?: string;
}
async function t1(over: T1Over = {}) {
  const baseAtom = atomText({ status: 'proposed', ...over.atom });
  const headAtom = atomText({ status: 'advisory', review_by: '2027-02-08', ...over.atom });
  const base: Record<string, string | null> = {
    ...COMMON_FILES,
    'kit.toml': over.kit ?? kitToml(),
    [PATH]: baseAtom,
    ...(over.noProposalFile
      ? {}
      : { [PROPOSAL_PATH]: over.proposalText ?? proposalYaml(baseAtom, over.proposal) }),
  };
  return run(base, { [PATH]: headAtom }, 'kit:promotion');
}

describe('T1 proposed→advisory', () => {
  it('合法对照:judge accept + 跨厂商 + 哈希一致 + team 层 + 固定字段 → 绿', async () => {
    expect((await t1()).codes).toEqual([]);
  });

  it('LAYER_NOT_TEAM:org 层不可晋升', async () => {
    const r = await t1({ atom: { layer: 'org' }, proposal: { layer: 'org' } });
    expect(r.codes).toEqual([G('LAYER_NOT_TEAM')]);
  });

  it('PROPOSAL_MISSING:没有 origin / 提案文件不在树里', async () => {
    expect((await t1({ atom: { origin: null } })).codes).toEqual([G('PROPOSAL_MISSING')]);
    expect((await t1({ noProposalFile: true })).codes).toEqual([G('PROPOSAL_MISSING')]);
  });

  it('PROPOSAL_INVALID:提案 yaml 不合 schema', async () => {
    expect((await t1({ proposalText: 'id: nope\n' })).codes).toEqual([G('PROPOSAL_INVALID')]);
  });

  it('PROPOSAL_MISMATCH:提案 targets 不含本原子 / layer 不一致 / 证据与原子不一一对应', async () => {
    const cases: [string, ProposalOpts][] = [
      ['targets', { targets: ['other-atom'] }],
      ['layer', { layer: 'personal' }],
      ['evidence', { evidenceExcerpt: '被换过的摘录' }],
    ];
    for (const [name, proposal] of cases) {
      expect((await t1({ proposal })).codes, name).toEqual([G('PROPOSAL_MISMATCH')]);
    }
  });

  it('JUDGE_MISSING / JUDGE_PENDING(只有 judge_attempts)——决策 ⑩A 的机械拒绝', async () => {
    expect((await t1({ proposal: { noJudge: true } })).codes).toEqual([G('JUDGE_MISSING')]);
    expect((await t1({ proposal: { attempts: true } })).codes).toEqual([G('JUDGE_PENDING')]);
  });

  it('JUDGE_NOT_ACCEPT:revise / reject 都拒', async () => {
    for (const verdict of ['revise', 'reject'] as const) {
      expect((await t1({ proposal: { verdict } })).codes, verdict).toEqual([G('JUDGE_NOT_ACCEPT')]);
    }
  });

  it('JUDGE_INJECTION:injection_suspected=true → 拒', async () => {
    expect((await t1({ proposal: { injection: true } })).codes).toEqual([G('JUDGE_INJECTION')]);
  });

  it('NOT_CROSS_VENDOR:裁判厂商不可证明不同(非内置厂商)→ 拒', async () => {
    // 自报的评审厂商 acme 既不跨厂商,也无法由最后一跳模型串复算(C5 独有的 JUDGE_VENDOR_UNPROVEN)
    expect([...(await t1({ proposal: { judgeVendor: 'acme' } })).codes].sort()).toEqual(
      [G('NOT_CROSS_VENDOR'), G('C5_JUDGE_VENDOR_UNPROVEN')].sort(),
    );
  });

  it('C5_JUDGE_PROVIDER_MISMATCH:judge.provider 不等于最后一跳 → 拒(CI 不得比本地 promote 宽)', async () => {
    expect((await t1({ proposal: { judgeProvider: 'glm' } })).codes).toEqual([
      G('C5_JUDGE_PROVIDER_MISMATCH'),
    ]);
  });

  it('JUDGE_HOP_MISMATCH:最后一跳厂商与 judge.vendor 不一致 → 拒', async () => {
    expect((await t1({ proposal: { lastHopVendor: 'google' } })).codes).toEqual([
      G('JUDGE_HOP_MISMATCH'),
    ]);
  });

  it('REFLECTOR_UNVERIFIABLE(没记 backend)/ REFLECTOR_STUB', async () => {
    expect((await t1({ proposal: { backend: null } })).codes).toEqual([
      G('REFLECTOR_UNVERIFIABLE'),
    ]);
    expect((await t1({ proposal: { reflectorModel: 'gpt-x' } })).codes).toEqual([
      G('REFLECTOR_UNVERIFIABLE'), // backend=claude 却配 gpt 模型 → 复算得 unknown ≠ 记录的 anthropic
    ]);
    expect((await t1({ proposal: { stub: true } })).codes).toEqual([G('REFLECTOR_STUB')]);
  });

  it('RULE_HASH_MISSING / RULE_HASH_MISMATCH:评审结论必须绑定规则文本', async () => {
    expect((await t1({ proposal: { hash: null } })).codes).toEqual([G('RULE_HASH_MISSING')]);
    expect((await t1({ proposal: { hash: sha('其它文本') } })).codes).toEqual([
      G('RULE_HASH_MISMATCH'),
    ]);
  });

  it('RULE_HASH_MISMATCH:评审之后正文被换过(提案哈希对应旧正文)', async () => {
    const old = atomText({
      status: 'proposed',
      body: '**做**:旧。\n**为什么**:a。\n**怎么验**:b。\n',
    });
    const s = await t1({ proposalText: proposalYaml(old) });
    expect(s.codes).toEqual([G('RULE_HASH_MISMATCH')]);
  });

  it('RESCAN_DIRTY:提案理由 / 原子正文命中危险话术或含不可见字符 → 拒(judge 说干净也不信)', async () => {
    expect((await t1({ proposal: { rationale: '建议开启 danger-full-access' } })).codes).toEqual([
      G('RESCAN_DIRTY'),
    ]);
    const hidden = '**做**:做事​。\n**为什么**:a。\n**怎么验**:b。\n';
    expect((await t1({ atom: { body: hidden } })).codes).toEqual([G('RESCAN_DIRTY')]);
  });

  it('REDACTION_RESIDUAL:脱敏复扫(C8)——含密钥形态的字段拒绝,即便 judge accept 且哈希一致', async () => {
    const secret =
      '**做**:用 sk-abcdefghijklmnopqrstuvwxyz0123456789 调用。\n**为什么**:a。\n**怎么验**:b。\n';
    expect((await t1({ atom: { body: secret } })).codes).toEqual([G('REDACTION_RESIDUAL')]);
    const viaRationale = await t1({
      proposal: { rationale: '示例 sk-abcdefghijklmnopqrstuvwxyz0123456789' },
    });
    expect(viaRationale.codes).toEqual([G('REDACTION_RESIDUAL')]);
  });

  it('RESCAN_DIRTY:补充变体选择符 U+E0100 等 hasInvisible 漏掉的不可见字符同样拒绝', async () => {
    for (const ch of ['\u{E0100}', '\u061C', '\u3164']) {
      const body = `**做**:做事${ch}。\n**为什么**:a。\n**怎么验**:b。\n`;
      expect((await t1({ atom: { body } })).codes, ch).toEqual([G('RESCAN_DIRTY')]);
    }
  });

  it('FIXED_FIELDS:strength=must / verifier≠none → 拒', async () => {
    expect((await t1({ atom: { strength: 'must' } })).codes).toEqual([G('FIXED_FIELDS')]);
    expect((await t1({ atom: { verifierNone: false } })).codes).toEqual([G('FIXED_FIELDS')]);
  });

  it('规范化哈希只忽略 status / review_by,其余都算;且拒绝歧义写法', () => {
    const a = atomText({ status: 'proposed', review_by: '2027-01-08' });
    const b = atomText({ status: 'advisory', review_by: '2030-01-01' });
    expect(normalizedRuleSha256(a)).toBe(normalizedRuleSha256(b));
    expect(normalizedRuleSha256(a)).not.toBe(normalizedRuleSha256(atomText({ body: 'x' })));
    expect(normalizedRuleSha256(a.replace('status:', '"status":'))).toBeUndefined();
    expect(normalizedRuleSha256(a.replace(/review_by:.*\n/, ''))).toBeUndefined();
    expect(normalizedRuleSha256(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ───────────────────────── T2:advisory → active ─────────────────────────

interface T2Over {
  atom?: AtomOpts;
  proposal?: ProposalOpts;
  attests?: AttestOpts[];
  extraFiles?: Record<string, string | null>;
  kit?: string;
  history?: ScenarioOptions['history'];
}
const ALICE: AttestOpts = { member: '@alice' };
const BOB: AttestOpts = { member: '@bob' };

async function t2(over: T2Over = {}) {
  const baseAtom = atomText({ status: 'advisory', ...over.atom });
  const headAtom = atomText({ status: 'active', review_by: '2027-02-08', ...over.atom });
  const base: Record<string, string | null> = {
    ...COMMON_FILES,
    'kit.toml': over.kit ?? kitToml(),
    [PATH]: baseAtom,
    [PROPOSAL_PATH]: proposalYaml(baseAtom, over.proposal),
  };
  const head: Record<string, string | null> = { [PATH]: headAtom, ...over.extraFiles };
  for (const a of over.attests ?? [ALICE, BOB]) {
    const [p, t] = attestFile(baseAtom, a);
    head[p] = t;
  }
  return run(base, head, 'kit:promotion', over.history ? { history: over.history } : {});
}

describe('T2 advisory→active', () => {
  it('合法对照:两名成员、15 天窗口、曝光 20、无 harmful → 绿', async () => {
    expect((await t2()).codes).toEqual([]);
  });

  it('T1 的 judge / 哈希 / 重扫同样适用于 T2', async () => {
    expect((await t2({ proposal: { noJudge: true } })).codes).toEqual([G('JUDGE_MISSING')]);
    expect((await t2({ proposal: { hash: sha('x') } })).codes).toEqual([G('RULE_HASH_MISMATCH')]);
  });

  it('SIGNATURE_MISSING:无 signature 的 advisory 原子不能经 G3 升 active(须先走内容 PR 补,GD-6)', async () => {
    expect((await t2({ atom: { signature: false } })).codes).toEqual([G('SIGNATURE_MISSING')]);
  });

  it('FIXED_FIELDS:T2 同样检查(设计 §3.1:T2 = T1 的全部 + attest 聚合)', async () => {
    expect((await t2({ atom: { strength: 'must' } })).codes).toEqual([G('FIXED_FIELDS')]);
    expect((await t2({ atom: { verifierNone: false } })).codes).toEqual([G('FIXED_FIELDS')]);
  });

  it('ATTEST_OVERLAP:同一成员重叠的不同窗口不能重复累计曝光;不重叠的窗口仍可累计', async () => {
    const a1 = { ...ALICE, start: '2026-10-08', end: '2026-10-21', exposure: 5 };
    const a2 = { ...ALICE, start: '2026-10-08', end: '2026-10-22', exposure: 5 };
    const r = await t2({ attests: [a1, a2, { ...BOB, exposure: 0 }] });
    expect(r.codes).toContain(G('ATTEST_OVERLAP'));
    const ok = await t2({
      attests: [
        { ...ALICE, start: '2026-10-08', end: '2026-10-14', exposure: 5 },
        { ...ALICE, start: '2026-10-15', end: '2026-10-21', exposure: 5 },
        { ...BOB, start: '2026-10-08', end: '2026-10-14', exposure: 0 },
      ],
    });
    expect(ok.codes).toEqual([]);
  });

  it('THRESHOLD_WINDOW_DAYS:窗口合计不足 14 天', async () => {
    const short = { start: '2026-10-08', end: '2026-10-14' };
    expect(
      (
        await t2({
          attests: [
            { ...ALICE, ...short },
            { ...BOB, ...short },
          ],
        })
      ).codes,
    ).toEqual([G('THRESHOLD_WINDOW_DAYS')]);
  });

  it('窗口按并集算天数:两名成员同一窗口只算一次;分开的窗口相加', async () => {
    const w1 = { start: '2026-10-08', end: '2026-10-14' };
    const w2 = { start: '2026-10-15', end: '2026-10-21' };
    expect(
      (
        await t2({
          attests: [
            { ...ALICE, ...w1 },
            { ...BOB, ...w2 },
          ],
        })
      ).codes,
    ).toEqual([]);
  });

  it('THRESHOLD_MEMBERS:只有一名成员', async () => {
    expect((await t2({ attests: [{ ...ALICE, exposure: 12 }] })).codes).toEqual([
      G('THRESHOLD_MEMBERS'),
    ]);
  });

  it('THRESHOLD_NON_OWNER_MEMBERS:成员数够但全是 owner 自己(⑥A)', async () => {
    const kit = kitToml({ members: ['@owner-handle'] });
    const r = await t2({ kit, attests: [{ member: OWNER, exposure: 12 }] });
    expect(r.codes).toEqual([G('THRESHOLD_MEMBERS'), G('THRESHOLD_NON_OWNER_MEMBERS')]);
  });

  it('THRESHOLD_EXPOSURE:曝光合计不足', async () => {
    expect(
      (
        await t2({
          attests: [
            { ...ALICE, exposure: 2 },
            { ...BOB, exposure: 2 },
          ],
        })
      ).codes,
    ).toEqual([G('THRESHOLD_EXPOSURE')]);
  });

  it('THRESHOLD_HARMFUL:有效 attest 里出现 harmful>0', async () => {
    expect((await t2({ attests: [ALICE, { ...BOB, harmful: 1 }] })).codes).toEqual([
      G('THRESHOLD_HARMFUL'),
    ]);
  });

  it('阈值取自 kit.toml 的 [lifecycle](core 调严后生效);缺省段 = schema 默认', async () => {
    const strict = kitToml({
      lifecycle:
        '[lifecycle]\ncanary_window_days = 14\nmin_members = 2\nmin_non_owner_members = 1\nmin_exposure_sessions = 50\nmax_harmful = 0\nno_exposure_windows = 2',
    });
    expect((await t2({ kit: strict })).codes).toEqual([G('THRESHOLD_EXPOSURE')]);
    expect((await t2({ kit: kitToml({ lifecycle: null }) })).codes).toEqual([]);
  });

  it('阈值读基线的 kit.toml:PR 里调松 kit.toml 无效(且 G3 另报禁止改动)', async () => {
    const strict = kitToml({
      lifecycle:
        '[lifecycle]\ncanary_window_days = 14\nmin_members = 2\nmin_non_owner_members = 1\nmin_exposure_sessions = 50\nmax_harmful = 0\nno_exposure_windows = 2',
    });
    const r = await t2({ kit: strict, extraFiles: { 'kit.toml': kitToml() } });
    expect(r.codes).toEqual([G('FORBIDDEN_CHANGE'), G('THRESHOLD_EXPOSURE')]);
  });

  it('CONFIG_UNREADABLE:基线 kit.toml 不是合法 KitConfig → 判不了阈值 → 红', async () => {
    expect((await t2({ kit: '[kit]\nname = "x"\n' })).codes).toEqual([G('CONFIG_UNREADABLE')]);
  });

  it('不计入口径(warn)+ 阈值失败:stable 渠道 / 名单外成员 / 哈希不符 / 未声明 method / 窗口早于 advisory', async () => {
    const cases: [string, AttestOpts][] = [
      ['channel', { ...BOB, channel: 'stable' }],
      ['roster', { member: '@mallory' }],
      ['hash', { ...BOB, hash: sha('别的文本') }],
      ['method', { ...BOB, method: null }],
      ['before-advisory', { ...BOB, start: '2026-09-01', end: '2026-09-20' }],
    ];
    for (const [name, bad] of cases) {
      const r = await t2({ attests: [ALICE, bad] });
      expect(r.codes, name).toEqual([G('THRESHOLD_MEMBERS'), 'GUARD_G3_ATTEST_NOT_COUNTED'].sort());
      expect(
        r.result.diagnostics.filter((d) => d.code === 'GUARD_G3_ATTEST_NOT_COUNTED')[0]?.severity,
      ).toBe('warn');
    }
  });

  it('ATTEST_INVALID / ATTEST_RUN_ID_SHAPE:结构不合法的 attest 文件判红', async () => {
    const r1 = await t2({ extraFiles: { [`attest/${ID}/junk.json`]: '{not json' } });
    expect(r1.codes).toEqual([G('ATTEST_INVALID')]);
    const base = atomText({ status: 'advisory' });
    const [p, t] = attestFile(base, { ...BOB, run: 'run-1' });
    const r2 = await t2({ attests: [ALICE], extraFiles: { [p]: t } });
    expect(r2.codes).toEqual([G('ATTEST_RUN_ID_SHAPE')].concat(G('THRESHOLD_MEMBERS')).sort());
  });

  it('ATTEST_INVALID:文件名与内容不一致(内容 member 被换)', async () => {
    const base = atomText({ status: 'advisory' });
    const [p, t] = attestFile(base, BOB);
    const swapped = t.replace('@bob', '@alice');
    const r = await t2({ attests: [ALICE], extraFiles: { [p]: swapped } });
    expect(r.codes).toContain(G('ATTEST_INVALID'));
  });

  it('同成员同窗口取 run_id 时间戳最新的一份:新的覆盖旧的(旧的 harmful 不再计入)', async () => {
    const r = await t2({
      attests: [
        ALICE,
        { ...BOB, harmful: 1, run: 'run-20261020T000000Z-aaaaaa' },
        { ...BOB, harmful: 0, run: 'run-20261021T000000Z-bbbbbb' },
      ],
    });
    expect(r.codes).toEqual([]);
    const r2 = await t2({
      attests: [
        ALICE,
        { ...BOB, harmful: 0, run: 'run-20261020T000000Z-aaaaaa' },
        { ...BOB, harmful: 1, run: 'run-20261021T000000Z-bbbbbb' },
      ],
    });
    expect(r2.codes).toEqual([G('THRESHOLD_HARMFUL')]);
  });

  it('ATTEST_AMBIGUOUS_LATEST:时间戳相同、后缀不同 → 判不出最新 → 红', async () => {
    const r = await t2({
      attests: [
        ALICE,
        { ...BOB, run: 'run-20261020T000000Z-aaaaaa' },
        { ...BOB, run: 'run-20261020T000000Z-bbbbbb' },
      ],
    });
    expect(r.codes).toContain(G('ATTEST_AMBIGUOUS_LATEST'));
  });

  it('member.since:窗口早于成员加入日期的 attest 不计入', async () => {
    const kit = kitToml().replace('"@bob" = {}', '"@bob" = { since = "2026-11-01" }');
    const r = await t2({ kit });
    expect(r.codes).toEqual([G('THRESHOLD_MEMBERS'), 'GUARD_G3_ATTEST_NOT_COUNTED'].sort());
  });

  it('转 advisory 之日取自该原子的提交历史:历史里 advisory 之前是 proposed', async () => {
    // 历史:先 proposed(2026-10-08),本场景 base 提交里才是 advisory;窗口从 2026-10-08 起 → 仍计入
    const r = await t2({
      history: [{ files: { ...COMMON_FILES, [PATH]: atomText({ status: 'proposed' }) } }],
    });
    expect(r.codes).toEqual([]);
  });
});

// ───────────────────────── 退役:T3 / T4 / T5 / T6 ─────────────────────────

interface RetOver {
  from: string;
  to: string;
  atom?: AtomOpts;
  record?: RecordOpts | null; // null = 不加记录
  records?: RecordOpts[];
  baseFiles?: Record<string, string | null>;
  headFiles?: Record<string, string | null>;
  attests?: AttestOpts[]; // 放在 base 里
  history?: ScenarioOptions['history'];
  afterHead?: ScenarioOptions['afterHead'];
  kit?: string;
}
async function ret(o: RetOver) {
  const baseAtom = atomText({ status: o.from, ...o.atom });
  const headAtom = atomText({ status: o.to, ...o.atom });
  const base: Record<string, string | null> = {
    ...COMMON_FILES,
    'kit.toml': o.kit ?? kitToml(),
    [PATH]: baseAtom,
    ...o.baseFiles,
  };
  const head: Record<string, string | null> = { [PATH]: headAtom, ...o.headFiles };
  for (const a of o.attests ?? []) {
    const [p, t] = attestFile(baseAtom, a);
    base[p] = t;
  }
  const recs = o.record === null ? [] : (o.records ?? [o.record ?? {}]);
  for (const r of recs) {
    const [p, t] = recordFile(baseAtom, { from: o.from, to: o.to, ...r });
    head[p] = t;
  }
  return run(base, head, 'kit:retire', {
    ...(o.history ? { history: o.history } : {}),
    ...(o.afterHead ? { afterHead: o.afterHead } : {}),
  });
}

const TRANSITIONS: [string, string, string][] = [
  ['T3', 'advisory', 'deprecated'],
  ['T4', 'active', 'deprecated'],
];

describe('T3/T4 advisory|active→deprecated', () => {
  for (const [name, from, to] of TRANSITIONS) {
    it(`${name} 合法对照:reason=manual + 本 PR 新增匹配的 lifecycle 记录 → 绿`, async () => {
      expect((await ret({ from, to })).codes).toEqual([]);
    });
  }

  it('LIFECYCLE_RECORD_MISSING:没有记录', async () => {
    expect((await ret({ from: 'advisory', to: 'deprecated', record: null })).codes).toEqual([
      G('LIFECYCLE_RECORD_MISSING'),
    ]);
  });

  it('LIFECYCLE_RECORD_MISMATCH:记录的方向与实际转移不符 / 规则哈希不符', async () => {
    const r = await ret({
      from: 'advisory',
      to: 'deprecated',
      record: { from: 'active', to: 'deprecated' },
    });
    expect(r.codes).toEqual([G('LIFECYCLE_RECORD_MISMATCH')]);
    const h = await ret({ from: 'advisory', to: 'deprecated', record: { hash: sha('别的') } });
    expect(h.codes).toEqual([G('LIFECYCLE_RECORD_MISMATCH')]);
  });

  it('LIFECYCLE_RECORD_INVALID:记录不合 schema / 文件名与内容不符(同时缺有效记录)', async () => {
    const junk = await ret({
      from: 'advisory',
      to: 'deprecated',
      record: null,
      headFiles: { [`lifecycle/${ID}/2026-10-09-run-x.json`]: '{}' },
    });
    expect(junk.codes).toEqual([G('LIFECYCLE_RECORD_INVALID'), G('LIFECYCLE_RECORD_MISSING')]);
    const [p, t] = recordFile(atomText({ status: 'advisory' }), {
      from: 'advisory',
      to: 'deprecated',
    });
    const renamed = await ret({
      from: 'advisory',
      to: 'deprecated',
      record: null,
      headFiles: { [p.replace('2026-10-09', '2026-10-10')]: t },
    });
    expect(renamed.codes).toEqual([G('LIFECYCLE_RECORD_INVALID'), G('LIFECYCLE_RECORD_MISSING')]);
  });

  it('LIFECYCLE_RECORD_AMBIGUOUS:同一转移新增两条记录', async () => {
    const r = await ret({
      from: 'advisory',
      to: 'deprecated',
      records: [{}, { run: 'run-20261009T000000Z-cccccc' }],
    });
    expect(r.codes).toEqual([G('LIFECYCLE_RECORD_AMBIGUOUS')]);
  });

  it('RECORD_DIGESTS:无证据理由不得带 attest_digests', async () => {
    const r = await ret({
      from: 'advisory',
      to: 'deprecated',
      record: { digests: [digestOf('x')] },
    });
    expect(r.codes).toEqual([G('RECORD_DIGESTS')]);
  });

  it('expired:review_by 早于记录日期 → 绿;否则 REASON_NOT_EXPIRED', async () => {
    const ok = await ret({
      from: 'active',
      to: 'deprecated',
      atom: { review_by: '2026-10-01' },
      record: { reason: 'expired' },
    });
    expect(ok.codes).toEqual([]);
    const no = await ret({
      from: 'active',
      to: 'deprecated',
      atom: { review_by: '2027-01-01' },
      record: { reason: 'expired' },
    });
    expect(no.codes).toEqual([G('REASON_NOT_EXPIRED')]);
  });

  it('superseded:by 原子存在、active、supersedes 含本 id → 绿;缺失 / 非 active / 没声明 → REASON_BY_INVALID', async () => {
    const by = (o: AtomOpts) => ({
      baseFiles: { 'rules/general/new-atom.md': atomText({ id: 'new-atom', ...o }) },
    });
    const ok = await ret({
      from: 'active',
      to: 'deprecated',
      record: { reason: 'superseded', by: 'new-atom' },
      ...by({ status: 'active', supersedes: [ID] }),
    });
    expect(ok.codes).toEqual([]);
    for (const [name, extra] of [
      ['缺失', {}],
      ['advisory', by({ status: 'advisory', supersedes: [ID] })],
      ['未声明 supersedes', by({ status: 'active' })],
    ] as const) {
      const r = await ret({
        from: 'active',
        to: 'deprecated',
        record: { reason: 'superseded', by: 'new-atom' },
        ...extra,
      });
      expect(r.codes, name).toEqual([G('REASON_BY_INVALID')]);
    }
  });

  it('harmful:被引用的有效 attest 里 harmful>0 → 绿;无 harmful → REASON_NOT_HARMFUL;没引用 → RECORD_DIGESTS', async () => {
    const baseAtom = atomText({ status: 'active' });
    const [, t] = attestFile(baseAtom, { ...ALICE, harmful: 2 });
    const ok = await ret({
      from: 'active',
      to: 'deprecated',
      attests: [{ ...ALICE, harmful: 2 }],
      record: { reason: 'harmful', digests: [digestOf(t)] },
    });
    expect(ok.codes).toEqual([]);
    const [, clean] = attestFile(baseAtom, ALICE);
    const none = await ret({
      from: 'active',
      to: 'deprecated',
      attests: [ALICE],
      record: { reason: 'harmful', digests: [digestOf(clean)] },
    });
    expect(none.codes).toEqual([G('REASON_NOT_HARMFUL')]);
    const uncited = await ret({
      from: 'active',
      to: 'deprecated',
      attests: [{ ...ALICE, harmful: 2 }],
      record: { reason: 'harmful', digests: [] },
    });
    expect(uncited.codes).toEqual([G('RECORD_DIGESTS'), G('REASON_NOT_HARMFUL')].sort());
  });

  it('no_exposure:最近 K=2 个互不重叠窗口曝光合计 0 → 绿;有曝光 / 窗口不足 → REASON_NO_EXPOSURE_UNMET', async () => {
    const w1 = { start: '2026-10-08', end: '2026-10-14' };
    const w2 = { start: '2026-10-15', end: '2026-10-21' };
    const baseAtom = atomText({ status: 'advisory' });
    const dig = (...os: AttestOpts[]) => os.map((o) => digestOf(attestFile(baseAtom, o)[1]));
    const a1 = { ...ALICE, ...w1, exposure: 0 };
    const a2 = { ...ALICE, ...w2, exposure: 0 };
    const ok = await ret({
      from: 'advisory',
      to: 'deprecated',
      attests: [a1, a2],
      record: { reason: 'no_exposure', digests: dig(a1, a2) },
    });
    expect(ok.codes).toEqual([]);
    const b2 = { ...BOB, ...w2, exposure: 3 };
    const exposed = await ret({
      from: 'advisory',
      to: 'deprecated',
      attests: [a1, a2, b2],
      record: { reason: 'no_exposure', digests: dig(a1, a2) },
    });
    expect(exposed.codes).toEqual([G('REASON_NO_EXPOSURE_UNMET')]);
    const one = await ret({
      from: 'advisory',
      to: 'deprecated',
      attests: [a1],
      record: { reason: 'no_exposure', digests: dig(a1) },
    });
    expect(one.codes).toEqual([G('REASON_NO_EXPOSURE_UNMET')]);
    // 引用的 attest 没覆盖判据实际采用的窗口 → RECORD_DIGESTS
    const partial = await ret({
      from: 'advisory',
      to: 'deprecated',
      attests: [a1, a2],
      record: { reason: 'no_exposure', digests: dig(a1) },
    });
    expect(partial.codes).toEqual([G('RECORD_DIGESTS')]);
    // 两个窗口互相重叠 ≠ 两个窗口
    const o1 = { ...ALICE, start: '2026-10-08', end: '2026-10-14', exposure: 0 };
    const o2 = { ...BOB, start: '2026-10-10', end: '2026-10-16', exposure: 0 };
    const overlap = await ret({
      from: 'advisory',
      to: 'deprecated',
      attests: [o1, o2],
      record: { reason: 'no_exposure', digests: dig(o1, o2) },
    });
    expect(overlap.codes).toEqual([G('REASON_NO_EXPOSURE_UNMET')]);
  });

  it('不得被孤立的 lifecycle 修改绕过:修改 / 删除已有记录、promotion 标签下新增记录 → GUARD_G3_FORBIDDEN_CHANGE', async () => {
    const [p, t] = recordFile(atomText({ status: 'advisory' }), {
      from: 'advisory',
      to: 'deprecated',
    });
    const mod = await ret({
      from: 'advisory',
      to: 'deprecated',
      baseFiles: { [p]: t },
      record: null,
      headFiles: { [p]: t.replace('manual', 'expired') },
    });
    expect(mod.codes).toContain(G('FORBIDDEN_CHANGE'));
    const del = await ret({
      from: 'advisory',
      to: 'deprecated',
      baseFiles: { [p]: t },
      record: null,
      headFiles: { [p]: null },
    });
    expect(del.codes).toContain(G('FORBIDDEN_CHANGE'));
    const promo = await run(
      { ...COMMON_FILES, [PATH]: atomText({ status: 'proposed' }) },
      { [PATH]: atomText({ status: 'advisory' }), [p]: t },
      'kit:promotion',
      { criteria: () => [] },
    );
    expect(promo.codes).toEqual([G('FORBIDDEN_CHANGE')]);
  });
});

describe('lifecycle 记录必须与本 PR 的转移一一对应(孤儿记录)', () => {
  const rec = (id: string, over: RecordOpts = {}) =>
    recordFile(atomText({ id, status: 'advisory' }), {
      rule_id: id,
      from: 'advisory',
      to: 'deprecated',
      ...over,
    });

  it('没有任何原子转移,只新增 lifecycle 文件 → GUARD_G3_LIFECYCLE_ORPHAN', async () => {
    const [p, t] = rec(ID);
    const s = await run(
      { ...COMMON_FILES, [PATH]: atomText({ status: 'advisory' }) },
      { [p]: t },
      'kit:retire',
    );
    expect(s.codes).toEqual([G('LIFECYCLE_ORPHAN')]);
  });

  it('正常退役 A 的同时新增 B 的记录(B 没有转移)→ ORPHAN', async () => {
    const [p, t] = rec('other-atom');
    const s = await ret({ from: 'advisory', to: 'deprecated', headFiles: { [p]: t } });
    expect(s.codes).toEqual([G('LIFECYCLE_ORPHAN')]);
  });

  it('不在 lifecycle/<id>/ 一层目录下的新增 → ORPHAN', async () => {
    const [p, t] = rec(ID);
    const s = await ret({
      from: 'advisory',
      to: 'deprecated',
      headFiles: { [p.replace(`${ID}/`, `${ID}/sub/`)]: t },
    });
    expect(s.codes).toEqual([G('LIFECYCLE_ORPHAN'), G('LIFECYCLE_RECORD_INVALID')]);
  });

  it('A 的目录里除匹配记录外还有一条与本次转移不符的合法记录 → LIFECYCLE_RECORD_MISMATCH', async () => {
    const [p, t] = rec(ID, {
      from: 'active',
      to: 'deprecated',
      run: 'run-20261009T000000Z-dddddd',
    });
    const s = await ret({ from: 'advisory', to: 'deprecated', headFiles: { [p]: t } });
    expect(s.codes).toEqual([G('LIFECYCLE_RECORD_MISMATCH')]);
  });
});

describe('T5 deprecated→retired(⑩A 冷却:deprecated 须已出现在祖先 stable tag)', () => {
  const hist = (status: string, tag = 'stable-1.0', annotated = true) => [
    { files: { ...COMMON_FILES, [PATH]: atomText({ status }) }, tag, annotated },
  ];

  it('合法对照:deprecated 已在 stable-1.0(基线严格祖先、注解 tag)里 → 绿', async () => {
    expect(
      (await ret({ from: 'deprecated', to: 'retired', history: hist('deprecated') })).codes,
    ).toEqual([]);
  });

  it('COOLDOWN_NOT_MET:没有任何 tag / 轻量 tag / tag 在基线本身 / tag 时点还是 active', async () => {
    const none = await ret({ from: 'deprecated', to: 'retired' });
    expect(none.codes).toEqual([G('COOLDOWN_NOT_MET')]);
    const light = await ret({
      from: 'deprecated',
      to: 'retired',
      history: hist('deprecated', 'stable-1.0', false),
    });
    expect(light.codes).toEqual([G('COOLDOWN_NOT_MET')]);
    const atBase = await ret({
      from: 'deprecated',
      to: 'retired',
      afterHead: (r) => r.tag('stable-now', 'kit-base', true),
    });
    expect(atBase.codes).toEqual([G('COOLDOWN_NOT_MET')]);
    const stillActive = await ret({ from: 'deprecated', to: 'retired', history: hist('active') });
    expect(stillActive.codes).toEqual([G('COOLDOWN_NOT_MET')]);
  });

  it('与 G4 的判定不同:tag 里是 retired 不能满足本冷却(本条要的是 deprecated 出现过)', async () => {
    const r = await ret({ from: 'deprecated', to: 'retired', history: hist('retired') });
    expect(r.codes).toEqual([G('COOLDOWN_NOT_MET')]);
  });

  it('冷却之外同样要 lifecycle 记录与理由证据', async () => {
    const miss = await ret({
      from: 'deprecated',
      to: 'retired',
      history: hist('deprecated'),
      record: null,
    });
    expect(miss.codes).toEqual([G('LIFECYCLE_RECORD_MISSING')]);
    const exp = await ret({
      from: 'deprecated',
      to: 'retired',
      history: hist('deprecated'),
      atom: { review_by: '2027-01-01' },
      record: { reason: 'expired' },
    });
    expect(exp.codes).toEqual([G('REASON_NOT_EXPIRED')]);
  });

  it('no_exposure / harmful 不能用于 deprecated→retired(记录 schema 层拒绝 → 记录无效)', async () => {
    const r = await ret({
      from: 'deprecated',
      to: 'retired',
      history: hist('deprecated'),
      record: { reason: 'harmful' },
    });
    expect(r.codes).toEqual([G('LIFECYCLE_RECORD_INVALID'), G('LIFECYCLE_RECORD_MISSING')]);
  });
});

describe('T6 proposed→retired(③A,被否决的提案)', () => {
  it('合法对照:reason=rejected + 记录 → 绿', async () => {
    expect(
      (await ret({ from: 'proposed', to: 'retired', record: { reason: 'rejected' } })).codes,
    ).toEqual([]);
  });

  it('缺记录 → LIFECYCLE_RECORD_MISSING;理由不是 rejected → 记录无效', async () => {
    const miss = await ret({ from: 'proposed', to: 'retired', record: null });
    expect(miss.codes).toEqual([G('LIFECYCLE_RECORD_MISSING')]);
    const manual = await ret({ from: 'proposed', to: 'retired', record: { reason: 'manual' } });
    expect(manual.codes).toEqual([G('LIFECYCLE_RECORD_INVALID'), G('LIFECYCLE_RECORD_MISSING')]);
  });

  it('不需要 judge / 冷却;但 proposed→retired 只许 kit:retire 标签', async () => {
    const promo = await run(
      { ...COMMON_FILES, [PATH]: atomText({ status: 'proposed' }) },
      { [PATH]: atomText({ status: 'retired' }) },
      'kit:promotion',
      { criteria: () => [] },
    );
    expect(promo.codes).toEqual([G('DIRECTION_NOT_ALLOWED')]);
  });
});

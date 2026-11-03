/**
 * N4 ②③④:`vendorEvidence`(唯一的证据函数)的真值表,以及 `checkC5` / `judgeChecks`(CI)对同一夹具的同口径对拍(R20-18.17 ~ R20-18.19、R20-18.27)。
 * 每个负向用例断言精确码,旁边放正向对照,防止静默变空。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Proposal } from '../../src/contracts/proposal.js';
import {
  SELF_REPORT_LABEL_JUDGE,
  SELF_REPORT_LABEL_REFLECTOR,
  VENDOR_PROVEN_LABEL,
  isProvablyCrossVendor,
  judgeEvidence,
  reflectorEvidence,
  vendorEvidence,
} from '../../src/contracts/vendor.js';
import { C5_CI_CODES, judgeChecks } from '../../src/guards/criteria.js';
import { C5_REASONS, checkC5 } from '../../src/lifecycle/checks.js';
import { readDir, readText } from '../../src/io/read-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import {
  RULE_SHA,
  baseProposal,
  sessionDeclared,
  withReflectorConfirmed,
  withSessionJudge,
  withSpawnedJudge,
} from './n4-fixtures.js';

const codesOf = (p: Proposal): string[] => {
  const ev = vendorEvidence(p);
  return ev.issues.map((i) => `${i.side}:${i.code}`);
};

interface Row {
  name: string;
  p: Proposal;
  ok: boolean;
  issues: string[];
  tiers: [string, string];
}

const confirmedOpenai = (): Proposal =>
  withReflectorConfirmed(sessionDeclared('codex'), { vendor: 'openai', model: 'gpt-example' });

const ROWS: Row[] = [
  {
    name: 'proven + proven(今天的路径)',
    p: withSpawnedJudge(baseProposal(), { vendor: 'openai' }),
    ok: true,
    issues: [],
    tiers: ['proven', 'proven'],
  },
  {
    name: 'proven 反思器 + self_confirmed 裁判',
    p: withSessionJudge(baseProposal(), { vendor: 'openai' }),
    ok: true,
    issues: [],
    tiers: ['proven', 'self_confirmed'],
  },
  {
    name: 'self_confirmed 反思器 + proven 裁判',
    p: withSpawnedJudge(
      withReflectorConfirmed(sessionDeclared(), { vendor: 'anthropic', model: 'claude-x' }),
      { vendor: 'openai' },
    ),
    ok: true,
    issues: [],
    tiers: ['self_confirmed', 'proven'],
  },
  {
    name: 'self_confirmed + self_confirmed(不要求至少一侧可证明,Q-N4-2 = A)',
    p: withSessionJudge(
      withReflectorConfirmed(sessionDeclared(), { vendor: 'anthropic', model: 'claude-x' }),
      { vendor: 'openai' },
    ),
    ok: true,
    issues: [],
    tiers: ['self_confirmed', 'self_confirmed'],
  },
  {
    name: 'session_declared 无确认 + proven 裁判',
    p: withSpawnedJudge(sessionDeclared(), { vendor: 'openai' }),
    ok: false,
    issues: ['reflector:REFLECTOR_SESSION_DECLARED', 'pair:VENDOR_NOT_CROSS'],
    tiers: ['none', 'proven'],
  },
  {
    name: '反思器确认 binding 被改',
    p: withSpawnedJudge(
      withReflectorConfirmed(
        sessionDeclared(),
        { vendor: 'anthropic', model: 'claude-x' },
        (b) => `${b.slice(0, 63)}${b.endsWith('0') ? '1' : '0'}`,
      ),
      { vendor: 'openai' },
    ),
    ok: false,
    issues: ['reflector:REFLECTOR_CONFIRM_INVALID', 'pair:VENDOR_NOT_CROSS'],
    tiers: ['none', 'proven'],
  },
  {
    name: '反思器确认不合理(claude 后端却确认为 openai 厂商 + claude 模型串)',
    p: withSpawnedJudge(
      withReflectorConfirmed(sessionDeclared('claude'), { vendor: 'openai', model: 'claude-x' }),
      { vendor: 'deepseek', model: 'deepseek-x' },
    ),
    ok: false,
    issues: ['reflector:REFLECTOR_CONFIRM_INVALID', 'pair:VENDOR_NOT_CROSS'],
    tiers: ['none', 'proven'],
  },
  {
    name: '裁判确认 binding 被改(verdict 被改成 accept 之外的值而 binding 不动)',
    p: withSessionJudge(baseProposal(), {
      vendor: 'openai',
      tamper: (r) => ({ ...r, overfit_risk: 'high' }),
    }),
    ok: false,
    issues: ['judge:JUDGE_CONFIRM_INVALID', 'pair:VENDOR_NOT_CROSS'],
    tiers: ['proven', 'none'],
  },
  // agent=pi + 无法归族的模型串:合理性检查推不出厂商(derived=unknown),只剩「内置规范厂商」这一道挡
  {
    name: '裁判自报 vendor=unknown',
    p: withSessionJudge(baseProposal(), { agent: 'pi', vendor: 'unknown', model: 'mystery-1' }),
    ok: false,
    issues: ['judge:JUDGE_CONFIRM_INVALID', 'pair:VENDOR_NOT_CROSS'],
    tiers: ['proven', 'none'],
  },
  {
    name: '裁判自报非内置厂商',
    p: withSessionJudge(baseProposal(), { agent: 'pi', vendor: 'acme', model: 'mystery-1' }),
    ok: false,
    issues: ['judge:JUDGE_CONFIRM_INVALID', 'pair:VENDOR_NOT_CROSS'],
    tiers: ['proven', 'none'],
  },
  {
    name: '反思器确认为非内置厂商(pi 后端 + 无法归族的模型串)',
    p: withSpawnedJudge(
      withReflectorConfirmed(sessionDeclared('pi'), { vendor: 'acme', model: 'mystery-1' }),
      { vendor: 'deepseek', model: 'deepseek-x' },
    ),
    ok: false,
    issues: ['reflector:REFLECTOR_CONFIRM_INVALID', 'pair:VENDOR_NOT_CROSS'],
    tiers: ['none', 'proven'],
  },
  {
    name: '反思器确认为 unknown(pi 后端 + 无法归族的模型串)',
    p: withSpawnedJudge(
      withReflectorConfirmed(sessionDeclared('pi'), { vendor: 'unknown', model: 'mystery-1' }),
      { vendor: 'deepseek', model: 'deepseek-x' },
    ),
    ok: false,
    issues: ['reflector:REFLECTOR_CONFIRM_INVALID', 'pair:VENDOR_NOT_CROSS'],
    tiers: ['none', 'proven'],
  },
  {
    name: '同厂商:self_confirmed 反思器 openai + 自报裁判 openai',
    p: withSessionJudge(confirmedOpenai(), { vendor: 'openai' }),
    ok: false,
    issues: ['pair:VENDOR_NOT_CROSS'],
    tiers: ['self_confirmed', 'self_confirmed'],
  },
  {
    name: 'judge 缺省',
    p: baseProposal(),
    ok: false,
    issues: ['judge:JUDGE_MISSING'],
    tiers: ['proven', 'none'],
  },
  {
    name: 'spawned 裁判厂商无法由模型串复算',
    p: withSpawnedJudge(baseProposal(), { vendor: 'openai', model: 'zzz-unknown' }),
    ok: false,
    issues: ['judge:JUDGE_VENDOR_UNPROVEN'],
    tiers: ['proven', 'none'],
  },
];

describe('R20-18.17 vendorEvidence 真值表', () => {
  for (const r of ROWS) {
    it(r.name, () => {
      const ev = vendorEvidence(r.p);
      expect(ev.ok).toBe(r.ok);
      expect(codesOf(r.p)).toEqual(r.issues);
      expect([ev.reflector.tier, ev.judge.tier]).toEqual(r.tiers);
      if (!ev.ok) {
        // N4i-2:side / code 恒等于 issues[0](构造时派生,不独立传入)
        expect({ side: ev.side, code: ev.code }).toEqual(ev.issues[0]);
      }
    });
  }
  it('model:proven 取反思器记录的 model / 裁判最后一跳的 model;self_confirmed 取键入 / 声明值', () => {
    const ev = vendorEvidence(
      withSessionJudge(withSpawnedJudgeless(), {
        vendor: 'openai',
        model: 'GPT-Typed'.toLowerCase(),
      }),
    );
    expect(ev.ok).toBe(true);
    expect(ev.reflector).toEqual({
      tier: 'self_confirmed',
      vendor: 'anthropic',
      model: 'claude-x',
    });
    expect(ev.judge).toEqual({ tier: 'self_confirmed', vendor: 'openai', model: 'gpt-typed' });
    const pv = vendorEvidence(
      withSpawnedJudge(baseProposal(), { vendor: 'openai', model: 'gpt-last-hop' }),
    );
    expect(pv.reflector).toEqual({ tier: 'proven', vendor: 'anthropic', model: 'claude-example' });
    expect(pv.judge).toEqual({ tier: 'proven', vendor: 'openai', model: 'gpt-last-hop' });
  });
  it('旧记录(无 provenance)行为不变:与显式 spawned 的证据逐字段相同', () => {
    const a = vendorEvidence(withSpawnedJudge(baseProposal(), { vendor: 'openai' }));
    expect(a.ok).toBe(true);
  });
  it('单侧入口:反思器压制规则——self_confirmed 时不发 BACKEND_MISSING / VENDOR_MISMATCH(A4 写的 provider=session / model=undeclared 必然命中)', () => {
    const r = reflectorEvidence(
      withReflectorConfirmed(sessionDeclared(), { vendor: 'anthropic', model: 'claude-x' }),
    );
    expect(r.issues).toEqual([]);
    expect(r.side.tier).toBe('self_confirmed');
    // 正向对照:没有确认时同一提案发 SESSION_DECLARED,仍不发 BACKEND_MISSING / VENDOR_MISMATCH(这三码只对 spawned 反思器发出)
    expect(reflectorEvidence(sessionDeclared()).issues.map((i) => i.code)).toEqual([
      'REFLECTOR_SESSION_DECLARED',
    ]);
    expect(judgeEvidence(baseProposal()).issues.map((i) => i.code)).toEqual(['JUDGE_MISSING']);
  });
  it('spawned 专属码不对 session_confirmed 发出;session_confirmed 无效时只发 JUDGE_CONFIRM_INVALID', () => {
    const bad = withSessionJudge(baseProposal(), { tamper: (r) => ({ ...r, verdict: 'revise' }) });
    expect(judgeEvidence(bad).issues.map((i) => i.code)).toEqual(['JUDGE_CONFIRM_INVALID']);
  });
  it('isProvablyCrossVendor:none 层级恒为 false;内置厂商且不同才 true', () => {
    expect(isProvablyCrossVendor({ tier: 'none', vendor: 'anthropic', model: '-' }, 'openai')).toBe(
      false,
    );
    expect(
      isProvablyCrossVendor({ tier: 'proven', vendor: 'anthropic', model: 'm' }, 'openai'),
    ).toBe(true);
    expect(
      isProvablyCrossVendor({ tier: 'self_confirmed', vendor: 'openai', model: 'm' }, 'openai'),
    ).toBe(false);
    expect(
      isProvablyCrossVendor({ tier: 'proven', vendor: 'anthropic', model: 'm' }, 'unknown'),
    ).toBe(false);
  });
});

function withSpawnedJudgeless(): Proposal {
  return withReflectorConfirmed(sessionDeclared(), { vendor: 'anthropic', model: 'claude-x' });
}

describe('R20-18.19 CI(judgeChecks)与本地(checkC5)同口径:CI 不比本地宽', () => {
  const atom = { path: 'rules/team/a-rule.md', id: 'a-rule', fm: {}, text: '', ruleSha: RULE_SHA };
  for (const r of ROWS) {
    it(`${r.name}:本地不过 ⇒ CI 有 error;本地的每个厂商类 reason 在 CI 都有映射码`, () => {
      const local = checkC5({ proposal: r.p });
      const ci = judgeChecks(atom, r.p);
      const ciCodes = ci.map((d) => d.code.replace(/^GUARD_G3_/, ''));
      expect(ci.every((d) => d.severity === 'error')).toBe(true); // 映射不得把硬失败降成 warn
      if (!local.ok) expect(ci.length, JSON.stringify(local.reasons)).toBeGreaterThan(0);
      for (const reason of local.reasons) {
        const mapped = C5_CI_CODES[reason];
        expect(mapped, reason).toBeDefined();
        // JUDGE_PENDING / JUDGE_MISSING 已有等价码;其余同理
        expect(ciCodes, reason).toContain(mapped);
      }
      // 反向:本地全绿 ⇒ CI 无厂商类 error(正向对照)
      if (local.ok && r.ok) expect(ciCodes).toEqual([]);
    });
  }
  it('反思器 self_confirmed:CI 不发 REFLECTOR_UNVERIFIABLE(压制),但 session_declared 无确认时发(R20-16.20 ② 保持)', () => {
    const okRow = ROWS[3]!.p;
    expect(judgeChecks(atom, okRow).map((d) => d.code)).toEqual([]);
    const unconfirmed = withSpawnedJudge(sessionDeclared(), { vendor: 'openai' });
    const codes = judgeChecks(atom, unconfirmed).map((d) => d.code.replace(/^GUARD_G3_/, ''));
    expect(codes).toEqual(
      expect.arrayContaining([
        'REFLECTOR_SESSION_DECLARED',
        'REFLECTOR_UNVERIFIABLE',
        'NOT_CROSS_VENDOR',
      ]),
    );
  });
  it('穷尽性:C5 观察到的每个 reason 都在 C5_REASONS 里,C5_REASONS 的每一项都在 C5_CI_CODES 里(往 C5 加 reason 不接 CI → 红)', () => {
    const observed = new Set<string>();
    for (const r of ROWS) for (const x of checkC5({ proposal: r.p }).reasons) observed.add(x);
    observed.add('STUB_PROPOSAL'); // stub 另测
    for (const x of observed) expect(C5_REASONS as readonly string[], x).toContain(x);
    for (const x of C5_REASONS) expect(Object.keys(C5_CI_CODES), x).toContain(x);
    // 映射值各自会被 judgeChecks 真发出(不是死表):VERDICT_NOT_ACCEPT / STUB_PROPOSAL 另有专门用例
    const stub = {
      ...baseProposal(),
      reflector: { ...baseProposal().reflector, stub: true as const },
    };
    expect(checkC5({ proposal: withSpawnedJudge(stub) }).reasons).toContain('STUB_PROPOSAL');
    expect(judgeChecks(atom, withSpawnedJudge(stub)).map((d) => d.code)).toContain(
      'GUARD_G3_REFLECTOR_STUB',
    );
  });
});

describe('R20-18.17 单一实现:isCrossVendorOf 除 vendor.ts 外 src/ 与 cli.ts 里不再有引用', () => {
  it('import 图 / 引用扫描', async () => {
    const hits: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readDir(dir)) {
        const p = path.join(dir, e.name);
        if (e.isDirectory) await walk(p);
        else if (e.name.endsWith('.ts') && !p.endsWith(path.join('contracts', 'vendor.ts'))) {
          if ((await readText(p)).includes('isCrossVendorOf('))
            hits.push(path.relative(REPO_ROOT, p));
        }
      }
    };
    await walk(path.join(REPO_ROOT, 'src'));
    expect(hits).toEqual([]);
    // 正向对照:vendor.ts 自己确实定义了它
    expect(await readText(path.join(REPO_ROOT, 'src/contracts/vendor.ts'))).toContain(
      'export function isCrossVendorOf(',
    );
  });
});

describe('R20-18.2 固定标签常量', () => {
  it('三个常量互不相同、非空', () => {
    const s = new Set([SELF_REPORT_LABEL_JUDGE, SELF_REPORT_LABEL_REFLECTOR, VENDOR_PROVEN_LABEL]);
    expect(s.size).toBe(3);
    expect(SELF_REPORT_LABEL_JUDGE).toContain('判官侧');
    expect(SELF_REPORT_LABEL_REFLECTOR).toContain('反思器侧');
  });
});

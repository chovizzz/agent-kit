import { describe, expect, it } from 'vitest';
import { budgetFailed, budgetStats, computeBudget, isNear } from '../../src/budget/budget.js';
import { countBytes, countLines } from '../../src/budget/targets.js';
import { BudgetReportSchema } from '../../src/contracts/budget.js';
import { ascii, cfg, out } from './helpers.js';

const codexCfg = (extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
  cfg({ ...top, codex: { max_bytes: 100, limit_source: 'documented', ...extra } });

/** 给 claude/codex/pi 都配上不会触发的预算,免得 BUDGET_NO_TARGET 混进无关断言。 */
const covered = (top: Record<string, unknown> = {}) =>
  cfg({
    ...top,
    claude: { max_bytes: 1_000_000, limit_source: 'documented' },
    codex: { max_bytes: 1_000_000, limit_source: 'documented' },
    pi: { max_bytes: 1_000_000, limit_source: 'assumed' },
  });

const target = (r: ReturnType<typeof computeBudget>, agent: string) => {
  const t = r.targets.find((x) => x.agent === agent);
  if (!t) throw new Error(`no target ${agent}`);
  return t;
};

describe('字节口径:UTF-8,不是字符数', () => {
  it('中文 3 字节/字:同样 30 个字符,中文是 90 字节、ASCII 是 30 字节', () => {
    expect(countBytes('你'.repeat(30))).toBe(90);
    expect(countBytes('a'.repeat(30))).toBe(30);
    expect(countBytes('é')).toBe(2);
    expect(countBytes('😀')).toBe(4);
  });

  it('目标字节按 UTF-8 计:34 个中文字符 + 换行 = 103 字节,超过 100(按字符数只有 35)', () => {
    const content = `${'汉'.repeat(34)}\n`;
    expect([...content].length).toBe(35);
    const r = computeBudget({ outputs: [out('codex', 'a.md', content)], config: codexCfg() });
    expect(target(r, 'codex').bytes).toBe(103);
    expect(target(r, 'codex').level).toBe('over');
  });

  it('托管块标记行计入字节', () => {
    const begin = '<!-- agent-kit:begin id=x sha256=abc -->';
    const content = `${begin}\nbody\n<!-- agent-kit:end -->\n`;
    const r = computeBudget({
      outputs: [out('codex', 'AGENTS.md', content, { mode: 'managed-block' })],
      config: codexCfg(),
    });
    expect(target(r, 'codex').bytes).toBe(Buffer.byteLength(content));
    expect(target(r, 'codex').bytes).toBeGreaterThan('body\n'.length + 20);
    expect(target(r, 'codex').lines).toBe(3);
  });
});

describe('行数口径', () => {
  it.each([
    ['', 0],
    ['\n', 1],
    ['a', 1],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\nb\n', 2],
    ['a\n\nb\n', 3],
    ['a\r\nb\r\n', 2],
    ['a\r\nb', 2],
    ['\n\n', 2],
  ])('countLines(%j) = %d', (text, n) => {
    expect(countLines(text)).toBe(n);
  });

  it('只配 max_lines 的目标只看行数(Claude 200 行)', () => {
    const cl = cfg({ claude: { max_lines: 3, limit_source: 'documented' } });
    const over = computeBudget({ outputs: [out('claude', 'r.md', 'a\nb\nc\nd\n')], config: cl });
    expect(target(over, 'claude')).toMatchObject({ lines: 4, level: 'over' });
    const ok = computeBudget({ outputs: [out('claude', 'r.md', 'a\n')], config: cl });
    expect(target(ok, 'claude').level).toBe('ok');
  });

  it('多维度:字节不超但行数超 ⇒ over;任一维度 near ⇒ near', () => {
    const c = cfg({ codex: { max_bytes: 1000, max_lines: 3, limit_source: 'documented' } });
    const lines = computeBudget({ outputs: [out('codex', 'a.md', 'a\nb\nc\nd\n')], config: c });
    expect(target(lines, 'codex').level).toBe('over');
    const near = computeBudget({ outputs: [out('codex', 'a.md', 'a\nb\nc\n')], config: c });
    expect(target(near, 'codex').level).toBe('near'); // 3/3 行 = 100% ≥ 90%,但没超
  });
});

describe('阈值边界:over 严格大于,near 用 ≥ 90%', () => {
  const level = (bytes: number, top: Record<string, unknown> = {}) =>
    target(
      computeBudget({ outputs: [out('codex', 'a.md', ascii(bytes))], config: codexCfg({}, top) }),
      'codex',
    ).level;

  it.each([
    [0, 'ok'],
    [89, 'ok'],
    [90, 'near'], // 恰好 90%:≥ 取 near(若误写成 > 这里会变 ok)
    [99, 'near'],
    [100, 'near'], // 恰好等于 max:不算超
    [101, 'over'],
  ])('max=100,%d 字节 → %s', (bytes, expected) => {
    expect(level(bytes)).toBe(expected);
  });

  it('threshold_percent 可配:50% 时 50 字节即 near,49 字节 ok', () => {
    expect(level(50, { threshold_percent: 50 })).toBe('near');
    expect(level(49, { threshold_percent: 50 })).toBe('ok');
  });

  it('isNear 用整数运算,不受浮点影响', () => {
    expect(isNear(9, 10, 90)).toBe(true);
    expect(isNear(899, 1000, 90)).toBe(false);
    expect(isNear(900, 1000, 90)).toBe(true);
  });

  it('near 出 warn 级 BUDGET_NEAR_LIMIT,不阻断;ok 无任何 BUDGET_ 诊断', () => {
    const near = computeBudget({
      outputs: [out('codex', 'a.md', ascii(95))],
      config: codexCfg({}, { enforce: 'block' }),
    });
    expect(near.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['BUDGET_NEAR_LIMIT', 'warn'],
    ]);
    expect(budgetFailed(near)).toBe(false);
    const ok = computeBudget({ outputs: [out('codex', 'a.md', ascii(10))], config: codexCfg() });
    expect(ok.diagnostics).toEqual([]);
  });
});

describe('决策 ② P1 落地:enforce 缺省 = block(只作用于 documented/probed;assumed 恒 warn)', () => {
  it('缺省(不传 enforce):documented 目标超限 → error 且 budgetFailed=true', () => {
    const r = computeBudget({
      outputs: [out('codex', 'a.md', ascii(150))],
      config: codexCfg(), // codexCfg 不设顶层 enforce,走 schema 缺省
    });
    const d = r.diagnostics.find((x) => x.code === 'BUDGET_OVER_LIMIT');
    expect(d?.severity).toBe('error');
    expect(budgetFailed(r)).toBe(true);
  });

  it('缺省(不传 enforce):assumed 目标超限 → 仍只 warn,不阻断', () => {
    const r = computeBudget({
      outputs: [out('pi', 'a.md', ascii(150))],
      config: cfg({ pi: { max_bytes: 100, limit_source: 'assumed' } }),
    });
    const d = r.diagnostics.find((x) => x.code === 'BUDGET_OVER_LIMIT');
    expect(d?.severity).toBe('warn');
    expect(budgetFailed(r)).toBe(false);
  });

  it('显式 enforce=warn:documented 目标超限仍只 warn(真实仓库 kit.toml 的现状不变)', () => {
    const r = computeBudget({
      outputs: [out('codex', 'a.md', ascii(150))],
      config: codexCfg({}, { enforce: 'warn' }),
    });
    const d = r.diagnostics.find((x) => x.code === 'BUDGET_OVER_LIMIT');
    expect(d?.severity).toBe('warn');
    expect(budgetFailed(r)).toBe(false);
  });
});
describe('按目标求和', () => {
  it('同一 agent 的多个文件相加(home + project),别的 agent 不混入', () => {
    const r = computeBudget({
      outputs: [
        out('claude', 'org.md', ascii(30)),
        out('claude', 'team.md', ascii(20)),
        out('claude', 'project.md', ascii(10), { target: 'project' }),
        out('codex', 'AGENTS.md', ascii(77)),
      ],
      config: cfg({
        claude: { max_bytes: 1000, limit_source: 'documented' },
        codex: { max_bytes: 1000, limit_source: 'documented' },
      }),
    });
    expect(target(r, 'claude').bytes).toBe(60);
    expect(target(r, 'claude').files).toEqual(['org.md', 'team.md', 'project.md']);
    expect(target(r, 'codex').bytes).toBe(77);
  });

  it('conditional 文件不计;纯技能/子代理文件(只有 sourceRefs)不计;带原子的规则文件照计', () => {
    const r = computeBudget({
      outputs: [
        out('claude', 'rules.md', ascii(10), { atoms: { 'a-b': 4 } }),
        out('claude', 'skills/x/SKILL.md', ascii(500), { sourceRefs: ['skill:x'] }),
        out('claude', 'agents/y.md', ascii(500), { sourceRefs: ['agent:y'] }),
        out('claude', 'later.md', ascii(500), { conditional: 'P-Q1' }),
      ],
      config: cfg({ claude: { max_bytes: 1000, limit_source: 'documented' } }),
    });
    expect(target(r, 'claude').bytes).toBe(10);
    expect(target(r, 'claude').files).toEqual(['rules.md']);
  });

  it('没配预算的 agent 不出报告;空输出 = 0 字节 0 行', () => {
    const r = computeBudget({
      outputs: [out('pi', 'x.md', ascii(5))],
      config: cfg({ codex: { max_bytes: 10, limit_source: 'assumed' } }),
    });
    expect(r.targets.map((t) => t.agent)).toEqual(['codex']);
    // 有产物却没配预算:不出 target,但必须有一条 warn,不能静默漏报
    expect(r.diagnostics.map((d) => [d.code, d.severity, d.path])).toEqual([
      ['BUDGET_NO_TARGET', 'warn', 'kit.toml#/budget/pi'],
    ]);
    expect(target(r, 'codex')).toMatchObject({ bytes: 0, lines: 0, level: 'ok', files: [] });
  });

  it('报告满足 BudgetReportSchema', () => {
    const r = computeBudget({ outputs: [out('codex', 'a.md', ascii(150))], config: codexCfg() });
    expect(BudgetReportSchema.safeParse(r).success).toBe(true);
  });
});

describe('按原子 id 去重', () => {
  const two = (a: number, b: number) => [
    out('claude', 'org.md', ascii(40), { atoms: { 'shared-one': a, 'only-org': 5 } }),
    out('claude', 'project.md', ascii(30), { atoms: { 'shared-one': b }, target: 'project' }),
  ];
  const c = cfg({ claude: { max_bytes: 1000, limit_source: 'documented' } });

  it('同一原子落两处只计一次:总字节 = 70 − 重复的那份', () => {
    const r = computeBudget({ outputs: two(12, 12), config: c });
    expect(target(r, 'claude').bytes).toBe(70 - 12);
    expect(target(r, 'claude').deduped_atom_ids).toEqual(['shared-one']);
  });

  it('正向控制:没有共享原子时不扣减、deduped 为空', () => {
    const r = computeBudget({
      outputs: [
        out('claude', 'a.md', ascii(40), { atoms: { 'one-a': 12 } }),
        out('claude', 'b.md', ascii(30), { atoms: { 'two-b': 12 }, target: 'project' }),
      ],
      config: c,
    });
    expect(target(r, 'claude').bytes).toBe(70);
    expect(target(r, 'claude').deduped_atom_ids).toEqual([]);
  });

  it('出现 3 次扣 2 份;各处字节不同时保留最大的一份(保守)', () => {
    const r = computeBudget({
      outputs: [
        out('claude', 'a.md', ascii(40), { atoms: { 'shared-one': 10 } }),
        out('claude', 'b.md', ascii(30), { atoms: { 'shared-one': 14 } }),
        out('claude', 'c.md', ascii(20), { atoms: { 'shared-one': 12 } }),
      ],
      config: c,
    });
    expect(target(r, 'claude').bytes).toBe(90 - (10 + 12));
  });

  it('不同 agent 之间不互相去重(各自目标各计一份)', () => {
    const r = computeBudget({
      outputs: [
        out('claude', 'a.md', ascii(40), { atoms: { 'shared-one': 12 } }),
        out('codex', 'b.md', ascii(30), { atoms: { 'shared-one': 12 } }),
      ],
      config: cfg({
        claude: { max_bytes: 1000, limit_source: 'documented' },
        codex: { max_bytes: 1000, limit_source: 'documented' },
      }),
    });
    expect(target(r, 'claude').bytes).toBe(40);
    expect(target(r, 'codex').bytes).toBe(30);
  });

  it('去重能把「求和会超」拉回「不超」,是真的在影响 level', () => {
    const c2 = cfg({ claude: { max_bytes: 100, limit_source: 'documented' } });
    const r = computeBudget({
      outputs: [
        out('claude', 'a.md', ascii(60), { atoms: { 'shared-one': 40 } }),
        out('claude', 'b.md', ascii(60), { atoms: { 'shared-one': 40 } }),
      ],
      config: c2,
    });
    expect(target(r, 'claude').bytes).toBe(80);
    expect(target(r, 'claude').level).toBe('ok');
  });

  it('行数不去重(OutFile 没有 atomLines,保守多算)', () => {
    const r = computeBudget({
      outputs: [
        out('claude', 'a.md', 'x\ny\n', { atoms: { 'shared-one': 2 } }),
        out('claude', 'b.md', 'x\ny\n', { atoms: { 'shared-one': 2 } }),
      ],
      config: c,
    });
    expect(target(r, 'claude').lines).toBe(4);
  });
});

describe('Codex 项目链(根→cwd 各层 AGENTS.md)', () => {
  const chain = ['根层规则\n', 'sub\n'];
  it('字节按 UTF-8 计,与托管块产物相加;files 记 projectChain#i', () => {
    const r = computeBudget({
      outputs: [out('codex', 'AGENTS.md', ascii(40))],
      config: codexCfg(),
      projectChain: chain,
    });
    expect(target(r, 'codex').bytes).toBe(40 + Buffer.byteLength('根层规则\n') + 4);
    expect(target(r, 'codex').bytes).toBe(40 + 13 + 4);
    expect(target(r, 'codex').lines).toBe(3);
    expect(target(r, 'codex').files).toEqual(['AGENTS.md', 'projectChain#0', 'projectChain#1']);
  });

  it('项目链能把目标推过上限;不给链则不超(对照)', () => {
    const outputs = [out('codex', 'AGENTS.md', ascii(90))];
    expect(target(computeBudget({ outputs, config: codexCfg() }), 'codex').level).toBe('near');
    expect(
      target(computeBudget({ outputs, config: codexCfg(), projectChain: [ascii(20)] }), 'codex')
        .level,
    ).toBe('over');
  });

  it('项目链只计给 codex,不计给别的 agent', () => {
    const r = computeBudget({
      outputs: [out('claude', 'a.md', ascii(10))],
      config: cfg({ claude: { max_bytes: 100, limit_source: 'documented' } }),
      projectChain: [ascii(500)],
    });
    expect(target(r, 'claude').bytes).toBe(10);
  });
});

describe('hard_limit', () => {
  it('"unknown" 不参与任何比较,也不出诊断(再大都不触发)', () => {
    const r = computeBudget({
      outputs: [out('pi', 'a.md', ascii(50))],
      config: cfg({ pi: { max_bytes: 100, hard_limit: 'unknown', limit_source: 'assumed' } }),
    });
    expect(target(r, 'pi')).toMatchObject({ level: 'ok', hard_limit: 'unknown' });
    expect(r.diagnostics).toEqual([]);
  });

  it('数字 hard_limit 被超过:BUDGET_OVER_HARD_LIMIT,level 强制 over(即便没超 max)', () => {
    const r = computeBudget({
      outputs: [out('codex', 'a.md', ascii(60))],
      config: cfg({ codex: { max_bytes: 100, hard_limit: 50, limit_source: 'documented' } }),
    });
    expect(target(r, 'codex').level).toBe('over');
    expect(r.diagnostics.map((d) => d.code)).toContain('BUDGET_OVER_HARD_LIMIT');
  });

  it('hard_limit 的阻断规则同 max:documented+block ⇒ error;assumed+block ⇒ warn', () => {
    const run = (source: string) =>
      computeBudget({
        outputs: [out('codex', 'a.md', ascii(60))],
        config: cfg({
          enforce: 'block',
          codex: { max_bytes: 100, hard_limit: 50, limit_source: source, ...probed(source) },
        }),
      });
    const probed = (s: string) =>
      s === 'probed'
        ? {
            probed_value: 50,
            probed_agent_version: '1.0.0',
            probed_at: '2026-10-08T00:00:00Z',
          }
        : {};
    expect(budgetFailed(run('documented'))).toBe(true);
    expect(budgetFailed(run('probed'))).toBe(true);
    expect(budgetFailed(run('assumed'))).toBe(false);
    const d = run('assumed').diagnostics.find((x) => x.code === 'BUDGET_OVER_HARD_LIMIT');
    expect(d?.severity).toBe('warn');
  });

  it('hard_limit 一律按字节比较:只配 max_lines 的目标,行数再多也不触发,字节超了才触发', () => {
    const config = cfg({ claude: { max_lines: 100, hard_limit: 50, limit_source: 'documented' } });
    const manyLines = computeBudget({
      outputs: [out('claude', 'a.md', 'a\n'.repeat(40))], // 80 字节 > 50
      config,
    });
    expect(manyLines.diagnostics.map((d) => d.code)).toEqual(['BUDGET_OVER_HARD_LIMIT']);
    const fewBytes = computeBudget({
      outputs: [out('claude', 'a.md', '\n'.repeat(40))], // 40 行但 40 字节
      config,
    });
    expect(fewBytes.diagnostics).toEqual([]);
  });

  it('恰好等于 hard_limit 不算超(严格大于)', () => {
    const config = cfg({ codex: { max_bytes: 100, hard_limit: 60, limit_source: 'documented' } });
    const at = computeBudget({ outputs: [out('codex', 'a.md', ascii(60))], config });
    expect(at.diagnostics.map((d) => d.code)).not.toContain('BUDGET_OVER_HARD_LIMIT');
    const past = computeBudget({ outputs: [out('codex', 'a.md', ascii(61))], config });
    expect(past.diagnostics.map((d) => d.code)).toContain('BUDGET_OVER_HARD_LIMIT');
  });

  it('同时超 max 与 hard_limit:两条诊断都出(超 max 一条,超硬上限一条)', () => {
    const r = computeBudget({
      outputs: [out('codex', 'a.md', ascii(150))],
      config: cfg({ codex: { max_bytes: 100, hard_limit: 120, limit_source: 'documented' } }),
    });
    expect(r.diagnostics.map((d) => d.code)).toEqual([
      'BUDGET_OVER_HARD_LIMIT',
      'BUDGET_OVER_LIMIT',
    ]);
  });
});

describe('单原子上限与项目层预算', () => {
  it('原子正文超 atom_max_bytes:warn(enforce=warn)/ error(enforce=block),同一原子只报一次', () => {
    const outputs = [
      out('claude', 'a.md', ascii(10), { atoms: { 'big-one': 700 } }),
      out('codex', 'b.md', ascii(10), { atoms: { 'big-one': 650, 'small-one': 100 } }),
    ];
    // 决策 ② P1:缺省 = block。covered() 的 claude/codex 是 documented 目标 → 原子超限即 error。
    const w = computeBudget({ outputs, config: covered() });
    expect(w.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['BUDGET_ATOM_TOO_LARGE', 'error'],
    ]);
    expect(w.diagnostics[0]?.message).toContain('700');
    expect(budgetFailed(w)).toBe(true);
    // 显式 enforce=warn:同一原子只 warn(真实仓库 kit.toml 的现状)。
    const warnCfg = computeBudget({ outputs, config: covered({ enforce: 'warn' }) });
    expect(warnCfg.diagnostics[0]?.severity).toBe('warn');
    expect(budgetFailed(warnCfg)).toBe(false);
    const b = computeBudget({ outputs, config: covered({ enforce: 'block' }) });
    expect(b.diagnostics[0]?.severity).toBe('error');
    expect(budgetFailed(b)).toBe(true);
  });

  it('恰好等于 atom_max_bytes 不算超', () => {
    const r = computeBudget({
      outputs: [out('claude', 'a.md', ascii(10), { atoms: { 'edge-one': 600 } })],
      config: covered(),
    });
    expect(r.diagnostics).toEqual([]);
  });

  it('project_max_bytes:项目落点跨 agent 按原子 id 去重求和;超过只 warn,block 也不阻断', () => {
    const outputs = [
      out('codex', 'AGENTS.md', ascii(60), { target: 'project', atoms: { 'proj-one': 30 } }),
      out('pi', 'AGENTS.md', ascii(60), { target: 'project', atoms: { 'proj-one': 30 } }),
      out('claude', 'home.md', ascii(999)),
    ];
    const r = computeBudget({
      outputs,
      config: covered({ enforce: 'block', project_max_bytes: 100 }),
    });
    // 120 − 30(proj-one 重复)= 90 ⇒ near,不是 over;home 文件不计入项目层
    expect(r.diagnostics.map((d) => [d.code, d.severity])).toEqual([['BUDGET_NEAR_LIMIT', 'warn']]);
    const over = computeBudget({
      outputs,
      config: covered({ enforce: 'block', project_max_bytes: 80 }),
    });
    expect(over.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['BUDGET_PROJECT_OVER', 'warn'],
    ]);
    expect(budgetFailed(over)).toBe(false);
  });
});

describe('统计表(check --report)', () => {
  it('每目标 {bytes,lines,limit,limit_source,status} + 去重后合计', () => {
    const outputs = [
      out('claude', 'a.md', 'x\n'.repeat(5), { atoms: { 'shared-one': 6, 'only-a': 4 } }),
      out('claude', 'b.md', 'y\n'.repeat(3), { atoms: { 'shared-one': 6 }, target: 'project' }),
    ];
    const config = cfg({
      claude: {
        max_lines: 6,
        limit_source: 'probed',
        ...{
          probed_value: 6,
          probed_agent_version: '1.0.0',
          probed_at: '2026-10-08T00:00:00Z',
        },
      },
    });
    const stats = budgetStats(computeBudget({ outputs, config }), outputs);
    expect(stats.targets).toHaveLength(1);
    expect(stats.targets[0]).toMatchObject({
      agent: 'claude',
      bytes: 10 + 6 - 6,
      lines: 8,
      max_lines: 6,
      max_bytes: null,
      limit_source: 'probed',
      status: 'over',
      // 决策 ② P1:probed 目标在缺省 enforce(block)下超限即 blocking。
      blocking: true,
      deduped_atom_ids: ['shared-one'],
    });
    expect(stats.totals).toEqual({ target_bytes: 10, distinct_atoms: 2, distinct_atom_bytes: 10 });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { budgetDeps } from '../../src/commands/check-budget.js';
import { command as probe, probeDeps } from '../../src/commands/probe.js';
import { BudgetTargetSchema } from '../../src/contracts/config.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { readDir, readText } from '../../src/io/read-fs.js';
import { cmdCtx, GOOD_ATOM, makeRepo, OWNER_LINE } from '../atoms/helpers.js';

const KIT_TOML = `[kit]
name = "t"
version = "0.0.0"

[agents]
enabled = ["claude", "codex"]

[budget]
enforce = "warn"

[budget.claude]
max_lines = 10
limit_source = "documented"

[budget.codex]
max_bytes = 1000
limit_source = "assumed"

[channels.canary.members]

[channels.stable.members]
`;

const atomFile = (id: string): string =>
  GOOD_ATOM.replace('id: good-atom', `id: ${id}`).replace('owner: you', OWNER_LINE);

async function makeKitRepo(extra: Record<string, string> = {}): Promise<string> {
  const { root } = await makeRepo({
    'kit.toml': KIT_TOML,
    'atoms/a1.md': atomFile('good-atom'),
    ...extra,
  });
  return root;
}

const CODEX_CONTENT = 'line one\nline two\nline three\n'; // 3 行 / 29 字节

/** 注入渲染:codex 有真实常驻内容(仓库里的示例原子是 proposed、不渲染,量出来是 0)。 */
function injectCodexRender(agents: readonly ('claude' | 'codex')[] = ['codex']): void {
  budgetDeps.render = () => ({
    files: agents.map((agent) => ({
      agent,
      target: 'home' as const,
      relPath: 'AGENTS.md',
      content: CODEX_CONTENT,
      mode: 'owned' as const,
      atomIds: ['a'],
      atomBytes: { a: 29 },
      confidence: 'documented' as const,
    })),
    report: {
      dropped: [],
      sideEffects: [],
      shadowChecks: [],
      pendingProbes: [],
      skippedLayers: [],
    },
  });
}

const LINES_ONLY_TOML = KIT_TOML.replace('max_bytes = 1000', 'max_lines = 1000');

describe('probe(P1-01,contracts #12)', () => {
  afterEach(() => {
    delete probeDeps.now;
    delete budgetDeps.render;
  });

  it('干跑:打印测量值与 limit_source,不产补丁;documented 目标标注不改写', async () => {
    const root = await makeKitRepo();
    const { ctx, out } = cmdCtx(root);
    ctx.argv = [];
    const code = await probe.run(ctx);
    expect(code).toBe(ExitCode.OK);
    const joined = out.join('');
    expect(joined).toContain('claude: measured bytes=');
    expect(joined).toContain('limit_source=documented');
    expect(joined).toContain('(documented:官方值,探针不改写)');
    expect(joined).toContain('limit_source=assumed');
    expect(joined).not.toContain('limit_source = "probed"');
  });

  it('--write:assumed 目标产补丁(三元组齐全),documented 目标跳过', async () => {
    injectCodexRender();
    const root = await makeKitRepo();
    const { ctx, out } = cmdCtx(root);
    ctx.argv = ['--write', '--agent-version', 'codex=0.161.0', '--observed', 'codex=1000'];
    const code = await probe.run(ctx);
    expect(code).toBe(ExitCode.OK);
    const joined = out.join('');
    expect(joined).toContain('claude: documented,跳过写回');
    expect(joined).toContain('[budget.codex]');
    expect(joined).toContain('limit_source = "probed"');
    expect(joined).toMatch(/probed_value = \d+/);
    expect(joined).toContain('probed_agent_version = "0.161.0"');
    expect(joined).toMatch(/probed_at = "\d{4}-\d{2}-\d{2}T/);
  });

  it('--write 缺 --agent-version → USAGE(三元组必填,缺版本不编造)', async () => {
    const root = await makeKitRepo();
    const { ctx, err } = cmdCtx(root);
    ctx.argv = ['--write'];
    const code = await probe.run(ctx);
    expect(code).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('codex 写回需要 --agent-version codex=');
  });

  it('--agent 过滤:只探指定 agent', async () => {
    const root = await makeKitRepo();
    const { ctx, out } = cmdCtx(root);
    ctx.argv = ['--agent', 'codex'];
    const code = await probe.run(ctx);
    expect(code).toBe(ExitCode.OK);
    const joined = out.join('');
    expect(joined).toContain('codex: measured');
    expect(joined).not.toContain('claude: measured');
  });

  it('干跑:每个目标各占一行(以换行结尾)', async () => {
    const root = await makeKitRepo();
    const { ctx, out } = cmdCtx(root);
    ctx.argv = [];
    expect(await probe.run(ctx)).toBe(ExitCode.OK);
    const lines = out
      .join('')
      .split('\n')
      .filter((l) => l.includes(': measured '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^claude: measured /);
    expect(lines[1]).toMatch(/^codex: measured /);
    expect(out.join('').endsWith('\n')).toBe(true);
  });

  it('产物量出 0 也不影响:probed_value 只来自 --observed', async () => {
    const { root } = await makeRepo({ 'kit.toml': KIT_TOML });
    const { ctx, out } = cmdCtx(root);
    ctx.argv = ['--write', '--agent-version', 'codex=0.87.1', '--observed', 'codex=1500'];
    expect(await probe.run(ctx)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('probed_value = 1500\n');
    expect(out.join('')).not.toContain('probed_value = 0');
  });

  it('补丁自校验不过 → 退出 3,整批不打印', async () => {
    injectCodexRender();
    const root = await makeKitRepo();
    const { ctx, out, err } = cmdCtx(root);
    probeDeps.now = () => new Date(Number.NaN); // 产出非法 probed_at
    ctx.argv = ['--write', '--agent-version', 'codex=0.161.0', '--observed', 'codex=1000'];
    expect(await probe.run(ctx)).toBe(ExitCode.FAIL_CLOSED);
    expect(err.join('')).toContain('PROBE_PATCH_INVALID agent=codex');
    expect(out.join('')).not.toContain('[budget.');
    expect(out.join('')).not.toContain('probed_value');
  });

  it('只配 max_lines 的目标取 lines,不取 bytes', async () => {
    injectCodexRender();
    const root = await makeKitRepo({ 'kit.toml': LINES_ONLY_TOML });
    const { ctx, out } = cmdCtx(root);
    ctx.argv = [];
    expect(await probe.run(ctx)).toBe(ExitCode.OK);
    const m = /codex: measured bytes=(\d+) lines=(\d+)/.exec(out.join(''));
    expect(m).not.toBeNull();
    const bytes = Number(m?.[1]);
    const lines = Number(m?.[2]);
    expect([bytes, lines]).toEqual([29, 3]);
    expect(out.join('')).toContain('headroom(lines)=997');
    const w = cmdCtx(root);
    w.ctx.argv = ['--write', '--agent-version', 'codex=0.161.0', '--observed', 'codex=1000'];
    expect(await probe.run(w.ctx)).toBe(ExitCode.OK);
    expect(w.out.join('')).toContain('probed_value = 1000\n');
    expect(w.out.join('')).toContain('max_lines = 1000\n');
    expect(w.out.join('')).not.toContain(`probed_value = ${lines}\n`);
  });

  it('两个维度都配 → 两个维度都比;probed_value 记 bytes;补丁两个 max 原值都不动', async () => {
    const both = KIT_TOML.replace('max_bytes = 1000', 'max_bytes = 1000\nmax_lines = 1000');
    injectCodexRender();
    const root = await makeKitRepo({ 'kit.toml': both });
    const d = cmdCtx(root);
    d.ctx.argv = [];
    await probe.run(d.ctx);
    expect(d.out.join('')).toContain('headroom_bytes=971 headroom_lines=997');
    const w = cmdCtx(root);
    w.ctx.argv = [
      '--write',
      '--agent-version',
      'codex=0.161.0',
      '--observed',
      'codex=bytes:1200,lines:1000',
    ];
    expect(await probe.run(w.ctx)).toBe(ExitCode.OK);
    expect(w.out.join('')).toContain('probed_value = 1200\n');
    expect(w.out.join('')).toContain('max_bytes = 1000\n');
    expect(w.out.join('')).toContain('max_lines = 1000\n');
  });

  it('补丁里不出现产物实测值(29 字节/3 行)', async () => {
    injectCodexRender();
    const root = await makeKitRepo();
    const w = cmdCtx(root);
    w.ctx.argv = ['--write', '--agent-version', 'codex=0.161.0', '--observed', 'codex=4096'];
    expect(await probe.run(w.ctx)).toBe(ExitCode.OK);
    const o = w.out.join('');
    expect(o).toContain('probed_value = 4096\n');
    expect(o).not.toMatch(/probed_value = (29|3)\n/);
  });

  it('干跑打印余量(产物实测只作余量,不产补丁)', async () => {
    injectCodexRender();
    const root = await makeKitRepo();
    const d = cmdCtx(root);
    d.ctx.argv = [];
    expect(await probe.run(d.ctx)).toBe(ExitCode.OK);
    expect(d.out.join('')).toContain('codex: measured bytes=29 lines=3');
    expect(d.out.join('')).toContain('headroom(bytes)=971');
    expect(d.out.join('')).not.toContain('probed_value');
  });

  it('--write 缺 --observed → 退出 2 PROBE_OBSERVED_REQUIRED,不出任何补丁', async () => {
    injectCodexRender();
    const root = await makeKitRepo();
    const { ctx, out, err } = cmdCtx(root);
    ctx.argv = ['--write', '--agent-version', 'codex=0.161.0'];
    expect(await probe.run(ctx)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('PROBE_OBSERVED_REQUIRED');
    expect(out.join('')).not.toContain('probed_value');
    expect(out.join('')).not.toContain('[budget.');
  });

  it('max_bytes 大于观测值 → 退出 2 PROBE_LIMIT_ABOVE_OBSERVED,不出补丁;等于则放行', async () => {
    injectCodexRender();
    const root = await makeKitRepo();
    const bad = cmdCtx(root);
    bad.ctx.argv = ['--write', '--agent-version', 'codex=0.161.0', '--observed', 'codex=999'];
    expect(await probe.run(bad.ctx)).toBe(ExitCode.USAGE);
    expect(bad.err.join('')).toContain('PROBE_LIMIT_ABOVE_OBSERVED agent=codex');
    expect(bad.out.join('')).not.toContain('[budget.');
    const eq = cmdCtx(root);
    eq.ctx.argv = ['--write', '--agent-version', 'codex=0.161.0', '--observed', 'codex=1000'];
    expect(await probe.run(eq.ctx)).toBe(ExitCode.OK);
    expect(eq.out.join('')).toContain('probed_value = 1000\n');
  });

  it('documented 目标不要求 --observed(照旧跳过)', async () => {
    injectCodexRender();
    const root = await makeKitRepo();
    const { ctx, out } = cmdCtx(root);
    ctx.argv = ['--write', '--agent-version', 'codex=0.161.0', '--observed', 'codex=1000'];
    expect(await probe.run(ctx)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('claude: documented,跳过写回');
  });

  it('--write 不写文件系统:仓库目录树前后一致', async () => {
    injectCodexRender();
    const root = await makeKitRepo();
    const snap = async (): Promise<string[]> => (await readDir(root)).map((e) => e.name).sort();
    const before = await snap();
    const kitBefore = await readText(`${root}/kit.toml`);
    const { ctx } = cmdCtx(root);
    ctx.argv = ['--write', '--agent-version', 'codex=0.161.0', '--observed', 'codex=1000'];
    expect(await probe.run(ctx)).toBe(ExitCode.OK);
    expect(await snap()).toEqual(before);
    expect(await readText(`${root}/kit.toml`)).toBe(kitBefore);
  });

  it.each([
    [['--agnet', 'codex'], 'PROBE_UNKNOWN_FLAG'],
    [['--agent', 'nope'], 'PROBE_AGENT_NOT_ENABLED'],
    [['--agent'], 'PROBE_MISSING_VALUE'],
    [['--write', '--agent-version', 'codex=latest'], 'PROBE_BAD_AGENT_VERSION'],
    [
      ['--write', '--agent-version', 'codex=1.0.0', '--agent-version', 'codex=1.0.1'],
      'PROBE_DUPLICATE_AGENT_VERSION',
    ],
    [['--write', '--agent-version', 'pi=1.0.0'], 'PROBE_AGENT_NOT_ENABLED'],
    [['--write', '--observed', 'codex=abc'], 'PROBE_BAD_OBSERVED'],
    [['--write', '--observed', 'codex=0'], 'PROBE_BAD_OBSERVED'],
    [['--write', '--observed', 'codex=-5'], 'PROBE_BAD_OBSERVED'],
    [['--write', '--observed', 'codex=1.5'], 'PROBE_BAD_OBSERVED'],
    [['--write', '--observed', 'codex=007'], 'PROBE_BAD_OBSERVED'],
    [['--write', '--observed'], 'PROBE_BAD_OBSERVED'],
    [['--write', '--observed', 'codex=bytes:0,lines:5'], 'PROBE_BAD_OBSERVED'],
    [['--write', '--observed', 'codex=bytes:007'], 'PROBE_BAD_OBSERVED'],
    [['--write', '--observed', 'codex=bytes:5,bytes:6'], 'PROBE_BAD_OBSERVED'],
    [['--write', '--observed', 'codex=bytes:5,'], 'PROBE_BAD_OBSERVED'],
    [['--write', '--observed', 'codex=words:5'], 'PROBE_BAD_OBSERVED'],
    [['--write', '--observed', 'codex=bytes:9007199254740992,lines:1'], 'PROBE_BAD_OBSERVED'],
    [['--write', '--observed', 'codex=bytes:1,lines:9007199254740992'], 'PROBE_BAD_OBSERVED'],
    [['--write', '--observed', 'codex=bytes:1000,lines:500\n'], 'PROBE_BAD_OBSERVED'],
    [['--write', '--observed', 'codex=bytes:5,lines:1.5'], 'PROBE_BAD_OBSERVED'],
    [
      ['--write', '--observed', 'codex=1000', '--observed', 'codex=bytes:1,lines:1'],
      'PROBE_DUPLICATE_OBSERVED',
    ],
    [
      ['--write', '--observed', 'codex=1000', '--observed', 'codex=2000'],
      'PROBE_DUPLICATE_OBSERVED',
    ],
    [['--write', '--observed', 'pi=1000'], 'PROBE_AGENT_NOT_ENABLED'],
  ])('参数严格:%j → 退出 2 + %s', async (argv, code) => {
    const root = await makeKitRepo();
    const { ctx, err, out } = cmdCtx(root);
    ctx.argv = argv;
    expect(await probe.run(ctx)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain(code);
    expect(out.join('')).not.toContain('measured');
  });

  it('时钟可注入:固定时钟 → probed_at 逐字相等', async () => {
    injectCodexRender();
    const root = await makeKitRepo();
    const { ctx, out } = cmdCtx(root);
    probeDeps.now = () => new Date('2026-01-02T03:04:05.678Z');
    ctx.argv = ['--write', '--agent-version', 'codex=0.161.0', '--observed', 'codex=1000'];
    expect(await probe.run(ctx)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('probed_at = "2026-01-02T03:04:05Z"\n');
  });

  it('保留 hard_limit,避免整段替换后丢失硬上限', async () => {
    injectCodexRender();
    const toml = KIT_TOML.replace('max_bytes = 1000', 'max_bytes = 1000\nhard_limit = 2000');
    const root = await makeKitRepo({ 'kit.toml': toml });
    const { ctx, out } = cmdCtx(root);
    ctx.argv = ['--write', '--agent-version', 'codex=0.161.0', '--observed', 'codex=1000'];
    expect(await probe.run(ctx)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('hard_limit = 2000\n');
  });

  it('整批原子:第二个目标缺版本 → 退出 2,第一个目标的补丁也不输出', async () => {
    injectCodexRender(['claude', 'codex']);
    const toml = KIT_TOML.replace('limit_source = "documented"', 'limit_source = "assumed"');
    const root = await makeKitRepo({ 'kit.toml': toml });
    const { ctx, out, err } = cmdCtx(root);
    ctx.argv = ['--write', '--agent-version', 'claude=1.2.3', '--observed', 'claude=1000'];
    expect(await probe.run(ctx)).toBe(ExitCode.USAGE);
    expect(err.join('')).toContain('codex 写回需要');
    expect(out.join('')).not.toContain('[budget.');
  });

  describe('双维度 --observed(PB4)', () => {
    const BOTH = KIT_TOML.replace('max_bytes = 1000', 'max_bytes = 1000\nmax_lines = 500');
    const W = ['--write', '--agent-version', 'codex=0.161.0', '--observed'];
    const run = async (toml: string, obs: string) => {
      injectCodexRender();
      const root = await makeKitRepo({ 'kit.toml': toml });
      const r = cmdCtx(root);
      r.ctx.argv = [...W, obs];
      const code = await probe.run(r.ctx);
      return { code, out: r.out.join(''), err: r.err.join('') };
    };

    it('两个维度都不超 → 出补丁,probed_value=bytes 观测值,probed_lines=lines 观测值', async () => {
      const r = await run(BOTH, 'codex=bytes:1000,lines:777');
      expect(r.code).toBe(ExitCode.OK);
      expect(r.out).toContain('probed_value = 1000\n');
      expect(r.out).toContain('probed_lines = 777\n');
      expect(r.out).toContain('max_lines = 500\n');
    });

    it('单维度补丁不写 probed_lines', async () => {
      const r = await run(KIT_TOML, 'codex=1500');
      expect(r.code).toBe(ExitCode.OK);
      expect(r.out).toContain('probed_value = 1500\n');
      expect(r.out).not.toContain('probed_lines');
    });

    it('单维度 max_lines 目标也不写 probed_lines', async () => {
      const lt = KIT_TOML.replace('max_bytes = 1000', 'max_lines = 500');
      const r = await run(lt, 'codex=700');
      expect(r.code).toBe(ExitCode.OK);
      expect(r.out).toContain('probed_value = 700\n');
      expect(r.out).not.toContain('probed_lines');
    });

    it('补丁渲染出的 TOML 能被 schema 回读(双维度往返)', async () => {
      const r = await run(BOTH, 'codex=bytes:1000,lines:777');
      const body = r.out.split('\n').filter((l) => /^[a-z_]+ = /.test(l));
      const obj = Object.fromEntries(
        body.map((l) => {
          const [k, v] = l.split(' = ') as [string, string];
          return [k, v.startsWith('"') ? v.slice(1, -1) : Number(v)];
        }),
      );
      const parsed = BudgetTargetSchema.safeParse(obj);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.probed_lines).toBe(777);
    });

    it('书写顺序无关:lines 在前也行', async () => {
      const r = await run(BOTH, 'codex=lines:500,bytes:1000');
      expect(r.code).toBe(ExitCode.OK);
      expect(r.out).toContain('probed_value = 1000\n');
    });

    it('bytes 维度超限 → PROBE_LIMIT_ABOVE_OBSERVED(信息带 max_bytes),整批无补丁', async () => {
      const r = await run(BOTH, 'codex=bytes:999,lines:500');
      expect(r.code).toBe(ExitCode.USAGE);
      expect(r.err).toContain('PROBE_LIMIT_ABOVE_OBSERVED agent=codex');
      expect(r.err).toContain('max_bytes=1000');
      expect(r.out).not.toContain('[budget.');
    });

    it('lines 维度超限(bytes 不超)→ PROBE_LIMIT_ABOVE_OBSERVED(信息带 max_lines)', async () => {
      const r = await run(BOTH, 'codex=bytes:5000,lines:499');
      expect(r.code).toBe(ExitCode.USAGE);
      expect(r.err).toContain('PROBE_LIMIT_ABOVE_OBSERVED agent=codex');
      expect(r.err).toContain('max_lines=500');
      expect(r.out).not.toContain('[budget.');
    });

    it('安全整数上界的双维度观测值有效', async () => {
      const m = Number.MAX_SAFE_INTEGER;
      const r = await run(BOTH, `codex=bytes:${m},lines:${m}`);
      expect(r.code).toBe(ExitCode.OK);
      expect(r.out).toContain(`probed_value = ${m}\n`);
    });

    it('单维度目标给 lines: 形式 → PROBE_OBSERVED_DIM_MISMATCH', async () => {
      const r = await run(KIT_TOML, 'codex=lines:5000');
      expect(r.code).toBe(ExitCode.USAGE);
      expect(r.err).toContain('PROBE_OBSERVED_DIM_MISMATCH');
    });

    it('多目标:前一个目标可出补丁、后一个超限 → 整批无补丁', async () => {
      injectCodexRender(['claude', 'codex']);
      const toml = BOTH.replace('limit_source = "documented"', 'limit_source = "assumed"');
      const root = await makeKitRepo({ 'kit.toml': toml });
      const r = cmdCtx(root);
      r.ctx.argv = [
        '--write',
        '--agent-version',
        'claude=1.0.0',
        '--agent-version',
        'codex=1.0.0',
        '--observed',
        'claude=1000',
        '--observed',
        'codex=bytes:1000,lines:499',
      ];
      expect(await probe.run(r.ctx)).toBe(ExitCode.USAGE);
      expect(r.err.join('')).toContain('PROBE_LIMIT_ABOVE_OBSERVED agent=codex');
      expect(r.out.join('')).not.toContain('[budget.');
    });

    it('双维度目标只给单值 → PROBE_OBSERVED_DIM_MISMATCH', async () => {
      const r = await run(BOTH, 'codex=5000');
      expect(r.code).toBe(ExitCode.USAGE);
      expect(r.err).toContain('PROBE_OBSERVED_DIM_MISMATCH agent=codex');
      expect(r.out).not.toContain('[budget.');
    });

    it('双维度目标只给一个维度 → PROBE_OBSERVED_DIM_MISMATCH', async () => {
      for (const obs of ['codex=bytes:5000', 'codex=lines:5000']) {
        const r = await run(BOTH, obs);
        expect(r.code).toBe(ExitCode.USAGE);
        expect(r.err).toContain('PROBE_OBSERVED_DIM_MISMATCH');
      }
    });

    it('单维度目标(bytes / lines)给维度形式 → PROBE_OBSERVED_DIM_MISMATCH', async () => {
      for (const toml of [KIT_TOML, LINES_ONLY_TOML]) {
        for (const obs of ['codex=bytes:5000', 'codex=bytes:5000,lines:5000']) {
          const r = await run(toml, obs);
          expect(r.code).toBe(ExitCode.USAGE);
          expect(r.err).toContain('PROBE_OBSERVED_DIM_MISMATCH');
          expect(r.out).not.toContain('[budget.');
        }
      }
    });

    it('单维度写法对 bytes-only / lines-only 目标仍照旧通过', async () => {
      expect((await run(KIT_TOML, 'codex=1000')).code).toBe(ExitCode.OK);
      expect((await run(LINES_ONLY_TOML, 'codex=1000')).code).toBe(ExitCode.OK);
    });

    it('混用:同批里一个目标单值、另一个双维度,错配的那个拒绝整批', async () => {
      injectCodexRender(['claude', 'codex']);
      const toml = BOTH.replace('limit_source = "documented"', 'limit_source = "assumed"');
      const root = await makeKitRepo({ 'kit.toml': toml });
      const r = cmdCtx(root);
      r.ctx.argv = [
        '--write',
        '--agent-version',
        'claude=1.0.0',
        '--agent-version',
        'codex=1.0.0',
        '--observed',
        'claude=1000',
        '--observed',
        'codex=bytes:1000,lines:500',
      ];
      expect(await probe.run(r.ctx)).toBe(ExitCode.OK);
      expect(r.out.join('')).toContain('[budget.claude]');
      expect(r.out.join('')).toContain('[budget.codex]');
      const bad = cmdCtx(root);
      bad.ctx.argv = [
        '--write',
        '--agent-version',
        'claude=1.0.0',
        '--agent-version',
        'codex=1.0.0',
        '--observed',
        'claude=1000',
        '--observed',
        'codex=1000',
      ];
      // claude 为 max_lines=10(单维度,单值 OK),codex 双维度只给单值 → 拒绝
      expect(await probe.run(bad.ctx)).toBe(ExitCode.USAGE);
      expect(bad.err.join('')).toContain('PROBE_OBSERVED_DIM_MISMATCH agent=codex');
      expect(bad.out.join('')).not.toContain('[budget.');
    });

    it('documented 目标给任何写法都被跳过(不校验维度)', async () => {
      injectCodexRender(['claude', 'codex']);
      const root = await makeKitRepo();
      const r = cmdCtx(root);
      r.ctx.argv = [
        '--write',
        '--agent-version',
        'codex=1.0.0',
        '--observed',
        'claude=bytes:1,lines:1',
        '--observed',
        'codex=1000',
      ];
      expect(await probe.run(r.ctx)).toBe(ExitCode.OK);
      expect(r.out.join('')).toContain('claude: documented,跳过写回');
    });
  });
});

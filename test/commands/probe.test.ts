import { afterEach, describe, expect, it } from 'vitest';
import { budgetDeps } from '../../src/commands/check-budget.js';
import { command as probe, probeDeps } from '../../src/commands/probe.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
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
function injectCodexRender(): void {
  budgetDeps.render = () => ({
    files: [
      {
        agent: 'codex',
        target: 'home',
        relPath: 'AGENTS.md',
        content: CODEX_CONTENT,
        mode: 'owned',
        atomIds: ['a'],
        atomBytes: { a: 29 },
        confidence: 'documented',
      },
    ],
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
    ctx.argv = ['--write', '--agent-version', 'codex=0.161.0'];
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
  });

  it('量出 0 → 不出补丁,打 PROBE_NOTHING_MEASURED,不产生 probed_value = 0', async () => {
    const { root } = await makeRepo({ 'kit.toml': KIT_TOML });
    const { ctx, out, err } = cmdCtx(root);
    ctx.argv = ['--write', '--agent-version', 'codex=0.87.1'];
    expect(await probe.run(ctx)).toBe(ExitCode.OK);
    expect(out.join('')).not.toContain('probed_value = 0');
    expect(out.join('')).not.toContain('[budget.codex]');
    expect(err.join('')).toContain('PROBE_NOTHING_MEASURED agent=codex');
  });

  it('补丁自校验不过 → 退出 3,整批不打印', async () => {
    injectCodexRender();
    const root = await makeKitRepo();
    const { ctx, out, err } = cmdCtx(root);
    probeDeps.now = () => new Date(Number.NaN); // 产出非法 probed_at
    ctx.argv = ['--write', '--agent-version', 'codex=0.161.0'];
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
    const w = cmdCtx(root);
    w.ctx.argv = ['--write', '--agent-version', 'codex=0.161.0'];
    expect(await probe.run(w.ctx)).toBe(ExitCode.OK);
    expect(w.out.join('')).toContain(`probed_value = ${lines}\n`);
  });

  it('两个维度都配 → 仍取 bytes(D1 待定)', async () => {
    const both = KIT_TOML.replace('max_bytes = 1000', 'max_bytes = 1000\nmax_lines = 1000');
    injectCodexRender();
    const root = await makeKitRepo({ 'kit.toml': both });
    const d = cmdCtx(root);
    d.ctx.argv = [];
    await probe.run(d.ctx);
    const bytes = Number(/codex: measured bytes=(\d+)/.exec(d.out.join(''))?.[1]);
    const w = cmdCtx(root);
    w.ctx.argv = ['--write', '--agent-version', 'codex=0.161.0'];
    await probe.run(w.ctx);
    expect(w.out.join('')).toContain(`probed_value = ${bytes}\n`);
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
    ctx.argv = ['--write', '--agent-version', 'codex=0.161.0'];
    expect(await probe.run(ctx)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('probed_at = "2026-01-02T03:04:05Z"\n');
  });
});

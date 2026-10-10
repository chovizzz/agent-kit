import { describe, expect, it } from 'vitest';
import { command as probe } from '../../src/commands/probe.js';
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
  GOOD_ATOM.replace('id: good-atom', `id: ${id}`).replace(
    'owner: you',
    OWNER_LINE,
  );

async function makeKitRepo(extra: Record<string, string> = {}): Promise<string> {
  const { root } = await makeRepo({
    'kit.toml': KIT_TOML,
    'atoms/a1.md': atomFile('good-atom'),
    ...extra,
  });
  return root;
}

describe('probe(P1-01,contracts #12)', () => {
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
    const root = await makeKitRepo();
    const { ctx, out } = cmdCtx(root);
    ctx.argv = [
      '--write',
      '--agent-version',
      'codex=0.161.0',
    ];
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
});

import { afterEach, describe, expect, it } from 'vitest';
import { lintDeps, run } from '../../src/commands/lint-cmd.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { cmdCtx, GOOD_ATOM, makeRepo, OWNER_LINE, STUB_MARKER, stubRedactor } from './helpers.js';

const opts = { guards: false, base: undefined, head: undefined, label: undefined, report: false };
const BASE = { CODEOWNERS: OWNER_LINE, 'cases/x/case.yaml': 'name: x\n' };

const KIT_TOML = (enforce: string): string => `[kit]
name = "t"
version = "0.0.0"

[agents]
enabled = ["claude"]

[budget]
enforce = "${enforce}"
atom_max_bytes = 100

[channels.canary.members]

[channels.stable.members]
`;
const BIG = GOOD_ATOM.replace('用某种方式验证。', '验'.repeat(60));

afterEach(() => {
  delete lintDeps.redactor;
});

describe('lint-cmd(check 的 lint 步骤)', () => {
  it('合法仓库 + 注入 Redactor:退出 0,摘要行在 stdout', async () => {
    lintDeps.redactor = stubRedactor;
    const { root } = await makeRepo({ ...BASE, 'rules/team/good-atom.md': GOOD_ATOM });
    const { ctx, out } = cmdCtx(root);
    expect(await run(ctx, opts)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('1 个原子');
    expect(out.join('')).toContain('0 error, 0 warn');
  });

  it('没有 Redactor:只有 warn,仍退出 0,但 warn 可见', async () => {
    const { root } = await makeRepo({ ...BASE, 'rules/team/good-atom.md': GOOD_ATOM });
    const { ctx, out } = cmdCtx(root);
    expect(await run(ctx, opts)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('ATOM_EVIDENCE_NOT_SCANNED');
  });

  it('有 error → 退出 1', async () => {
    lintDeps.redactor = stubRedactor;
    const { root } = await makeRepo({ ...BASE, 'rules/team/wrong-name.md': GOOD_ATOM });
    const { ctx, out } = cmdCtx(root);
    expect(await run(ctx, opts)).toBe(ExitCode.CHECK_FAILED);
    expect(out.join('')).toContain('error ATOM_ID_FILENAME_MISMATCH rules/team/wrong-name.md#/id');
  });

  it('脱敏复扫残留 → 退出 1(内容问题);复扫抛错 → 退出 3(fail-closed)', async () => {
    const { root } = await makeRepo({
      ...BASE,
      'rules/team/good-atom.md': GOOD_ATOM.replace('合成的证据摘录', STUB_MARKER),
    });
    lintDeps.redactor = stubRedactor;
    expect(await run(cmdCtx(root).ctx, opts)).toBe(ExitCode.CHECK_FAILED);
    lintDeps.redactor = {
      pass2() {
        throw new Error('x');
      },
    };
    expect(await run(cmdCtx(root).ctx, opts)).toBe(ExitCode.FAIL_CLOSED);
  });

  it('kit.toml 的 budget.enforce 决定 ATOM_BODY_TOO_LARGE 的严重度(warn → 退出 0;block → 退出 1)', async () => {
    lintDeps.redactor = stubRedactor;
    for (const [enforce, exit, label] of [
      ['warn', ExitCode.OK, 'warn'],
      ['block', ExitCode.CHECK_FAILED, 'error'],
    ] as const) {
      const { root } = await makeRepo({
        ...BASE,
        'kit.toml': KIT_TOML(enforce),
        'rules/team/good-atom.md': BIG,
      });
      const { ctx, out } = cmdCtx(root);
      expect(await run(ctx, opts), enforce).toBe(exit);
      expect(out.join('')).toContain(`${label} ATOM_BODY_TOO_LARGE`);
    }
  });

  it('没有 kit.toml:回退到默认 warn/600(正文 >600 字节 → warn,退出 0)', async () => {
    lintDeps.redactor = stubRedactor;
    const huge = GOOD_ATOM.replace('用某种方式验证。', '验'.repeat(210));
    const { root } = await makeRepo({ ...BASE, 'rules/team/good-atom.md': huge });
    const { ctx, out } = cmdCtx(root);
    expect(await run(ctx, opts)).toBe(ExitCode.OK);
    expect(out.join('')).toContain('warn ATOM_BODY_TOO_LARGE');
    // 正向对照:同一仓库里正文缩到 600 字节以内则没有这条
    const small = await makeRepo({ ...BASE, 'rules/team/good-atom.md': GOOD_ATOM });
    const r2 = cmdCtx(small.root);
    await run(r2.ctx, opts);
    expect(r2.out.join('')).not.toContain('ATOM_BODY_TOO_LARGE');
  });

  it('kit.toml 非法 → 报 error 但仍继续 lint', async () => {
    lintDeps.redactor = stubRedactor;
    const { root } = await makeRepo({
      ...BASE,
      'kit.toml': 'not = [valid',
      'rules/team/good-atom.md': GOOD_ATOM,
    });
    const { ctx, out } = cmdCtx(root);
    expect(await run(ctx, opts)).toBe(ExitCode.CHECK_FAILED);
    expect(out.join('')).toContain('CFG_TOML_SYNTAX');
    expect(out.join('')).toContain('1 个原子');
  });

  it('空仓库(没有 rules/skills/agents):零诊断退出 0', async () => {
    const { root } = await makeRepo({ 'README.md': 'x\n' });
    expect(await run(cmdCtx(root).ctx, opts)).toBe(ExitCode.OK);
  });
});

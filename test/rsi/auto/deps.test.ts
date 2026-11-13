/**
 * 生产组装 `productionAutoPorts` 的输出泄漏闸禁止值与配置信任(W8a 复审):
 *   - 配置无法可信读取(cfg_unreadable / cfg_parse / cfg_schema / repo_invalid / cfg_perm 等)→ 所有读命令在任何输出之前退 3 `RSI_FAIL_CLOSED reason=<同名码>`,stdout 零字节
 *     (此时拿不到仓库根 / 状态目录,禁止集合不完整,不得当作「合法关闭」继续);
 *   - 合法关闭(absent / no_section / disabled)与配置正常:照常组装;显式 `--root` 解析后进入禁止集合;配置正常时含仓库根 / `[rsi] repo` / 状态目录;
 *   - 禁止集合不静默丢项:配置 on 而缺仓库根 / 状态目录 → 抛错。
 * 策略说明:合法关闭时没有仓库与状态目录,完整集合 = HOME + KIT_TMP + 显式根 + 私有仓库目录;`show` 在此情形下照常(受闸保护);
 * 生产 gitPath 未装配,经 `main()` 的 `show` 恒在读记录前退 3,所以 off + 显式根的泄漏闸只能在端口层断言集合(不是端到端输出)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chmod, remove, writeFile } from '../../../src/io/safe-fs.js';
import { runAutoFamily } from '../../../src/rsi/auto/entry.js';
import { forbiddenExtra, productionAutoPorts } from '../../../src/rsi/auto/deps.js';
import { RsiFailClosedError, type RsiEarlyContext } from '../../../src/rsi/types.js';
import { makeRoFx, type RoFx } from '../ro-fixture.js';
import { ID, makeSink } from './auto-fixture.js';

const ctxFor = (
  f: RoFx,
  argv: string[],
  sink = makeSink(),
  over: Partial<RsiEarlyContext> = {},
): RsiEarlyContext =>
  ({
    argv,
    overlayPath: undefined,
    explicitRoot: undefined,
    env: f.env,
    cwd: f.dir,
    stdout: sink.stdout,
    stderr: sink.stderr,
    isTty: true,
    ...over,
  }) as RsiEarlyContext;

const COMMANDS: [string, string[]][] = [
  ['auto', ['status', '--json']],
  ['auto', ['status']],
  ['auto', ['clear']],
  ['report', []],
  ['show', [ID]],
  ['rollback', ['--to', '2026-01-01']],
];

const OUTSIDE_REPO = '/srv/outside-home-repo-w8a';

describe('配置不可信 → 所有读命令在输出之前 fail-closed(退 3,stdout 零字节)', () => {
  const bad: [string, string, (f: RoFx) => Promise<void>][] = [
    ['cfg_parse', 'cfg_parse', (f) => writeFile(f.fx, f.cfgFile, 'x = = y', { mode: 0o600 })],
    [
      'cfg_schema',
      'cfg_schema',
      (f) =>
        writeFile(f.fx, f.cfgFile, '[rsi]\nenabled = true\nagents = ["kimi"]\n', { mode: 0o600 }),
    ],
    [
      'repo_invalid(repo 在 HOME 之外且不存在)',
      'repo_invalid',
      (f) =>
        writeFile(f.fx, f.cfgFile, `[rsi]\nenabled = true\nrepo = "${OUTSIDE_REPO}"\n`, {
          mode: 0o600,
        }),
    ],
    ['cfg_perm', 'cfg_perm', (f) => chmod(f.fx, f.cfgFile, 0o666)],
  ];
  for (const [name, reason, mutate] of bad) {
    it(`${name}:${COMMANDS.length} 个读命令都退 3 RSI_FAIL_CLOSED reason=${reason},stdout 为空`, async () => {
      const f = await makeRoFx('w8a-deps-bad-');
      await mutate(f);
      for (const [family, argv] of COMMANDS) {
        const s = makeSink();
        const code = await runAutoFamily(family as 'auto', ctxFor(f, argv, s), { phase: 2 });
        expect([code, s.text()], `${family} ${argv.join(' ')}`).toEqual([
          3,
          { out: '', err: `RSI_FAIL_CLOSED reason=${reason}\n` },
        ]);
      }
    });
  }

  it('正向对照:配置正常 → status --json 照常输出(退 0)', async () => {
    const f = await makeRoFx('w8a-deps-ok-');
    const s = makeSink();
    expect(await runAutoFamily('auto', ctxFor(f, ['status', '--json'], s), { phase: 2 })).toBe(0);
    expect(JSON.parse(s.text().out)).toHaveProperty('auto.view_state', 'missing');
  });
});

describe('禁止集合(端口 outputForbidden)', () => {
  it('配置正常:含仓库根(= [rsi] repo)、状态目录与私有仓库目录', async () => {
    const f = await makeRoFx('w8a-deps-on-');
    const p = await productionAutoPorts(ctxFor(f, []));
    expect(p.outputForbidden).toEqual(
      expect.arrayContaining([f.repo, f.io.stateDir, expect.stringContaining('/personal/.git')]),
    );
  });

  it('合法关闭(absent / no_section / disabled):照常组装,显式 --root(相对路径按 cwd 解析)进入集合', async () => {
    const offs: [string, string | null][] = [
      ['absent', null],
      ['no_section', '[x]\na = 1\n'],
      ['disabled', '[rsi]\nenabled = false\n'],
    ];
    for (const [name, text] of offs) {
      const f = await makeRoFx(`w8a-deps-off-${name}-`);
      if (text === null) await remove(f.fx, f.cfgFile);
      else await writeFile(f.fx, f.cfgFile, text, { mode: 0o600 });
      const abs = await productionAutoPorts(
        ctxFor(f, [], makeSink(), { explicitRoot: OUTSIDE_REPO }),
      );
      expect(abs.outputForbidden, name).toContain(OUTSIDE_REPO);
      const rel = await productionAutoPorts(
        ctxFor(f, [], makeSink(), { explicitRoot: 'some/root' }),
      );
      expect(rel.outputForbidden, name).toContain(path.join(f.dir, 'some/root'));
      const s = makeSink();
      expect(
        await runAutoFamily('auto', ctxFor(f, ['status', '--json'], s), { phase: 2 }),
        name,
      ).toBe(0);
    }
  });

  it('forbiddenExtra 不静默丢项:配置 on 而没有 io / 缺状态目录 / 缺仓库根 → 抛 fail-closed;explicitRoot 是唯一可选来源', () => {
    const c = { explicitRoot: undefined, cwd: '/w' };
    expect(() => forbiddenExtra(c, null, '/r', '/g')).toThrow(RsiFailClosedError);
    expect(() => forbiddenExtra(c, { stateDir: '', repoRoot: '/r' }, '/r', '/g')).toThrow(
      RsiFailClosedError,
    );
    expect(() => forbiddenExtra(c, { stateDir: '/s', repoRoot: '' }, '/r', '/g')).toThrow(
      RsiFailClosedError,
    );
    expect(forbiddenExtra(c, { stateDir: '/s', repoRoot: '/r' }, '/r', '/g')).toEqual([
      '/g',
      '/s',
      '/r',
      '/r',
    ]);
    expect(forbiddenExtra({ explicitRoot: 'x', cwd: '/w' }, null, null, '/g')).toEqual([
      '/g',
      '/w/x',
    ]);
  });
});

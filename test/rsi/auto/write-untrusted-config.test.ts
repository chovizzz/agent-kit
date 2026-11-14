/**
 * 配置不可信(cfg_* / repo_invalid)时写命令的分流(contracts R21-9.5、§21.24 W0-25「配置不可信时的缩减入口」):
 *   - `auto clear --write`(缩减入口):HOME 侧撤销照常完成,退出码按 W0-22 第 3 条归并;输出只含 id、枚举、计数,不含候选正文与任何路径(禁止集合取不全不构成阻断,因为没有正文输出);
 *   - 其余五个写命令:在任何写入与输出之前 fail-closed,退 3 `RSI_FAIL_CLOSED reason=<同名码>`,stdout 零字节(与读命令一致)。
 * 生产组装里锁与 `ClearDeps` 归装配块(未接线),所以 clear 的端到端用「生产端口(config + 禁止集合)合并内存假锁 / 假 ClearDeps」。
 */
import { describe, expect, it } from 'vitest';
import { chmod, writeFile } from '../../../src/io/safe-fs.js';
import {
  productionClearWritePorts,
  productionWritePorts,
} from '../../../src/rsi/auto/deps-write.js';
import { runAutoFamily } from '../../../src/rsi/auto/entry.js';
import { makeWriteHandlers } from '../../../src/rsi/auto/write/index.js';
import type { RsiEarlyContext } from '../../../src/rsi/types.js';
import { canaryRec, world7 } from '../rollback/w7-fixture.js';
import { makeRoFx, type RoFx } from '../ro-fixture.js';
import { ID, makeSink } from './auto-fixture.js';
import { makeFx } from './write-fixture.js';

const OUTSIDE_REPO = '/srv/outside-home-repo-w8b';

const BAD: [string, string, (f: RoFx) => Promise<void>][] = [
  ['cfg_parse', 'cfg_parse', (f) => writeFile(f.fx, f.cfgFile, 'x = = y', { mode: 0o600 })],
  [
    'cfg_schema',
    'cfg_schema',
    (f) =>
      writeFile(f.fx, f.cfgFile, '[rsi]\nenabled = true\nagents = ["kimi"]\n', { mode: 0o600 }),
  ],
  [
    'repo_invalid',
    'repo_invalid',
    (f) =>
      writeFile(f.fx, f.cfgFile, `[rsi]\nenabled = true\nrepo = "${OUTSIDE_REPO}"\n`, {
        mode: 0o600,
      }),
  ],
  ['cfg_perm', 'cfg_perm', (f) => chmod(f.fx, f.cfgFile, 0o666)],
];

const ctxFor = (f: RoFx, argv: string[], sink = makeSink()): RsiEarlyContext =>
  ({
    argv,
    overlayPath: undefined,
    explicitRoot: undefined,
    env: f.env,
    cwd: f.dir,
    stdout: sink.stdout,
    stderr: sink.stderr,
    isTty: true,
    readLine: async () => 'yes',
  }) as RsiEarlyContext;

describe('配置不可信时 auto clear --write(缩减入口)照常完成 HOME 侧撤销', () => {
  for (const [name, , mutate] of BAD) {
    it(`${name}:撤销完成(退 0),只拿 personal → sync 锁,stdout / stderr 不含候选正文、仓库根 / 状态目录 / [rsi] repo 路径`, async () => {
      const f = await makeRoFx('w8b-untrusted-clear-');
      await mutate(f);
      const w7 = world7({ record: canaryRec() });
      const fx = makeFx(w7);
      const real = await productionClearWritePorts(ctxFor(f, ['clear', '--write']));
      expect(await (real.config as NonNullable<typeof real.config>)()).toEqual({ rsiOn: false });
      const ports = { ...real, locks: fx.ports.locks, clearDeps: fx.ports.clearDeps };
      const write = makeWriteHandlers(
        async () => {
          throw new Error('其它写命令的端口工厂不应被 clear 调用');
        },
        async () => ports,
      );
      const s = makeSink();
      const code = await runAutoFamily('auto', ctxFor(f, ['clear', '--write'], s), {
        phase: 2,
        write,
      });
      const t = s.text();
      expect(code, t.err).toBe(0);
      expect(t.err).toContain('RSI_CLEAR_DONE');
      expect(w7.revs.map((x) => [x.by, x.reason])).toEqual([['clear', 'cleared']]);
      expect(fx.locks.log.filter((l) => l.startsWith('acquire'))).toEqual([
        'acquire:personal',
        'acquire:sync',
      ]);
      for (const bad of [f.dir, f.repo, f.io.stateDir, OUTSIDE_REPO, 'rules/']) {
        expect(t.out.includes(bad), `stdout 含 ${bad}`).toBe(false);
        expect(t.err.includes(bad), `stderr 含 ${bad}`).toBe(false);
      }
    });

    it(`${name}:仓库读不出时退 3 personal_repo_invalid(归并规则不因配置不可信而变),不写凭据`, async () => {
      const f = await makeRoFx('w8b-untrusted-clear-bad-');
      await mutate(f);
      const w7 = world7({ record: canaryRec() });
      w7.store.mode = 'deferred';
      const fx = makeFx(w7);
      const real = await productionClearWritePorts(ctxFor(f, ['clear', '--write']));
      const write = makeWriteHandlers(
        async () => real,
        async () => ({ ...real, locks: fx.ports.locks, clearDeps: fx.ports.clearDeps }),
      );
      const s = makeSink();
      const code = await runAutoFamily('auto', ctxFor(f, ['clear', '--write'], s), {
        phase: 2,
        write,
      });
      expect([code, s.text().err]).toEqual([3, 'RSI_FAIL_CLOSED reason=personal_repo_invalid\n']);
      expect(w7.revs).toEqual([]);
    });
  }
});

describe('配置不可信时其余写命令仍 fail-closed(退 3,stdout 零字节,零写入)', () => {
  const OTHERS: [string, string[]][] = [
    ['auto', ['pause']],
    ['auto', ['resume']],
    ['auto', ['rebase-baseline']],
    ['veto', [ID]],
    ['rollback', ['--to', '2026-01-01', '--write']],
  ];
  for (const [name, reason, mutate] of BAD) {
    it(`${name}:${OTHERS.length} 个写命令都退 3 RSI_FAIL_CLOSED reason=${reason}`, async () => {
      const f = await makeRoFx('w8b-untrusted-other-');
      await mutate(f);
      const write = makeWriteHandlers(
        (ctx) => productionWritePorts(ctx),
        (ctx) => productionClearWritePorts(ctx),
      );
      for (const [family, argv] of OTHERS) {
        const s = makeSink();
        const code = await runAutoFamily(family as 'auto', ctxFor(f, argv, s), {
          phase: 2,
          write,
        });
        expect([code, s.text()], `${family} ${argv.join(' ')}`).toEqual([
          3,
          { out: '', err: `RSI_FAIL_CLOSED reason=${reason}\n` },
        ]);
      }
    });
  }
});

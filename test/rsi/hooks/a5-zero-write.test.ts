/**
 * A5 零写入清单(contracts R20-15.32):`rsi hooks --print --agent claude|codex|pi` 与 `rsi hooks --install --agent claude`(干跑),
 * off / armed 两环境都退 0(`# exit=0`),写审计钩子恰好为 [],前后目录树完全一致,且不建 `.state/rsi/`(R20-15.4:状态无关)。
 * 经真实 `main()` 跑(生产分发路径、生产形状表、生产版本探测):claude / codex 是「假设」,pi 是「实测运行」但要求本机 pi >= 1.5.0;
 * 这里 PATH 固定为 `/usr/bin:/bin`(没有 pi → 版本未知),所以三家的 `--install --write` 都退 4 shape_unverified 且零写入(pi 版本已知时的放行见 a5-pi-version.test.ts)。
 * 范围声明:本文件是进程内两层(审计 + 目录树);零写入清单的第三层(子进程 `KIT_WRITE_ROOTS=:`)沿用 B5e 的 ro-helper,不在此重复。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists } from '../../../src/io/read-fs.js';
import { chmod, mkdirp } from '../../../src/io/safe-fs.js';
import { makeRoFx, runMain, setExtra, type RoFx } from '../ro-fixture.js';
import { treeOf, writeCfg } from '../rsi-fixture.js';

async function world(env: 'off' | 'armed', prefix: string): Promise<RoFx> {
  const f = await makeRoFx(prefix);
  if (env === 'off') await writeCfg(f, '[update]\n');
  else await setExtra(f, '');
  for (const d of ['.claude', '.codex', '.pi', '.pi/agent']) {
    await mkdirp(f.fx, path.join(f.home, d), 0o755);
    await chmod(f.fx, path.join(f.home, d), 0o755);
  }
  return f;
}

const LIST: [string[], number, string?][] = [
  [['rsi', 'hooks', '--print', '--agent', 'claude'], 0],
  [['rsi', 'hooks', '--print', '--agent', 'codex'], 0],
  [['rsi', 'hooks', '--print', '--agent', 'pi'], 0],
  [['rsi', 'hooks', '--install', '--agent', 'claude'], 0],
  [['rsi', 'hooks', '--install', '--agent', 'codex'], 0],
  [['rsi', 'hooks', '--install', '--agent', 'pi'], 0],
  [['rsi', 'hooks', '--uninstall', '--agent', 'claude'], 0],
  [['rsi', 'hooks', '--prune-backups'], 0],
  [['rsi', 'session', '--print'], 0],
  // 生产形状表:claude / codex 未核实、pi 版本未知(PATH 里没有 pi)→ --install --write 退 4,零写入
  [
    ['rsi', 'hooks', '--install', '--agent', 'claude', '--write'],
    4,
    'RSI_HOOKS_NOT_RUN reason=shape_unverified\n',
  ],
  [
    ['rsi', 'hooks', '--install', '--agent', 'codex', '--write'],
    4,
    'RSI_HOOKS_NOT_RUN reason=shape_unverified\n',
  ],
  [
    ['rsi', 'hooks', '--install', '--agent', 'pi', '--write'],
    4,
    'RSI_HOOKS_NOT_RUN reason=shape_unverified\n',
  ],
];

for (const env of ['off', 'armed'] as const) {
  describe(`${env} 环境`, () => {
    for (const [argv, code, err] of LIST) {
      it(`${argv.slice(1).join(' ')} → 退 ${code},写审计 [],树不变`, async () => {
        const f = await world(env, `a5-zw-${env}-`);
        const before = await treeOf(f.dir);
        const r = await runMain(f, argv, { isTty: true });
        expect(r.code, r.err).toBe(code);
        if (err !== undefined) expect(r.err).toBe(err);
        else expect(r.err).toBe('');
        expect(r.audit).toEqual([]);
        expect(await treeOf(f.dir)).toEqual(before);
        expect(await exists(path.join(f.repo, '.state'))).toBe(false);
        if (code === 0) expect(r.out.length).toBeGreaterThan(0);
      });
    }
  });
}

describe('参数错误不得以 0 退出;分发器路由', () => {
  it('rsi hooks 无参数 / 坏参数 → 2;rsi session 无 --print → 2', async () => {
    const f = await world('off', 'a5-zw-bad-');
    for (const argv of [
      ['rsi', 'hooks'],
      ['rsi', 'hooks', '--install'],
      ['rsi', 'hooks', '--print', '--agent', 'kimi'],
      ['rsi', 'session'],
    ]) {
      const r = await runMain(f, argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err.startsWith('RSI_USAGE reason=')).toBe(true);
      expect(r.audit).toEqual([]);
    }
  });
});

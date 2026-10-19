/**
 * W14(K4):promote 的本地预检与 CI 的 `check --guards` 在冻结口径下同判:同一份夹具,promote 预检红 ⇔ 守卫红。
 * promote 走 lifecycleCriteria(同一个函数),这里用真 git 历史对拍两侧的结论,防止有人让 promote 绕开它自算。
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPromoteCommand } from '../../src/commands/promote.js';
import { createIoContext } from '../../src/io/paths.js';
import { buildWorld, twoTiles, type AttestSpec } from '../guards/frozen-world.js';
import type { TestRepo } from '../helpers/make-repo.js';

const repos: TestRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.dispose()));
});

const ID = 'sample-atom';
const RULE = `rules/team/${ID}.md`;

async function promoteCode(attests: AttestSpec[]): Promise<{ code: number; out: string }> {
  const w = await buildWorld({ attests, rulePath: RULE, stopAtBase: true });
  repos.push(w.repo);
  const parent = path.dirname(w.repo.dir);
  const io = createIoContext({
    cwd: w.repo.dir,
    root: w.repo.dir,
    env: { KIT_TMP: parent, KIT_STATE_DIR: path.join(parent, 'state'), PATH: '/usr/bin:/bin' },
  });
  const out: string[] = [];
  const code = await createPromoteCommand({
    now: () => new Date('2026-10-29T08:00:00Z'),
    gitEnv: w.repo.gitEnv,
  }).run({
    argv: ['--rule', ID, '--to', 'active'],
    io,
    overlayPath: undefined,
    stdout: (t) => out.push(t),
    stderr: (t) => out.push(t),
  });
  return { code, out: out.join('') };
}

async function guardsRed(attests: AttestSpec[]): Promise<boolean> {
  const w = await buildWorld({ attests, rulePath: RULE });
  repos.push(w.repo);
  return w.run().diagnostics.some((d) => d.severity === 'error');
}

describe('W14 promote 预检与 check --guards 同口径', () => {
  const cases: [string, AttestSpec[], boolean][] = [
    ['两名成员各交块 0、块 1(对照,绿)', twoTiles(), false],
    [
      '只有一个有效块',
      [
        { member: '@alice', tile: 0 },
        { member: '@bob', tile: 0 },
      ],
      true,
    ],
    [
      'A 只交块 0、B 只交块 1',
      [
        { member: '@alice', tile: 0 },
        { member: '@bob', tile: 1 },
      ],
      true,
    ],
    ['attest 没绑冻结协议', twoTiles({ bind: false }), true],
  ];
  for (const [name, attests, red] of cases) {
    it(`${name}:预检红=${red} 且守卫红=${red}`, async () => {
      const p = await promoteCode(attests);
      expect(p.code === 0, p.out).toBe(!red);
      expect(await guardsRed(attests)).toBe(red);
    });
  }
});

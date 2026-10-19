/**
 * K4:`attest --tile <k> --freeze-date D` 与 G3 的冻结分块同口径(W13),以及 --tile 的用法/失败路径。
 * 世界 = guards/frozen-world.ts 的合成 git 仓库(真提交);信号是合成的,不碰真实信号库。
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAttestCommand } from '../../src/commands/attest.js';
import type { CommandContext } from '../../src/commands/types.js';
import type { Signal } from '../../src/contracts/signal.js';
import { createIoContext } from '../../src/io/paths.js';
import { writeSignals } from '../../src/signals/state-store.js';
import { buildWorld, type WorldOpts } from '../guards/frozen-world.js';
import { PROPOSAL_PATH } from '../guards/criteria-world.js';
import { snapshot } from '../judge/helpers.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import type { TestRepo } from '../helpers/make-repo.js';

const repos: TestRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.dispose()));
});

const hex = (n: number, len: number): string => n.toString(16).padStart(len, '0');
const sig = (n: number, ts: string): Signal => ({
  sig_id: `sig_${hex(n, 16)}`,
  agent: 'claude',
  agent_version: '2.1.280',
  agent_version_source: 'session_meta',
  session_ref: `s_${hex(n, 16)}`,
  project_key: `p_${hex(1, 16)}`,
  ts,
  type: 'event',
  excerpt_redacted: 'hello',
  external_content: false,
  confidence: 1,
  loaded_rule_ids: [],
  event_kind: 'user_message',
  event_index: n,
});

async function setup(o: WorldOpts = {}) {
  const w = await buildWorld(o);
  repos.push(w.repo);
  const parent = path.dirname(w.repo.dir);
  const io = createIoContext({
    cwd: REPO_ROOT,
    root: w.repo.dir,
    env: { KIT_TMP: parent, KIT_STATE_DIR: path.join(parent, 'state'), PATH: '/usr/bin:/bin' },
  });
  // 每个分块窗口里各放一个会话(always 型:每个会话都算曝光)
  const signals: Signal[] = [0, 1, 2, 3].map((k) => sig(k + 1, `${w.tile(k).start}T10:00:00Z`));
  await writeSignals(io, 'claude', signals);
  const freezeDate = w.repo.git(['log', '-1', '--format=%cs', '--', PROPOSAL_PATH]).trim();
  return { w, io, parent, freezeDate };
}

async function run(io: CommandContext['io'], argv: string[], now = '2026-11-20T08:00:00Z') {
  const out: string[] = [];
  const err: string[] = [];
  const cmd = createAttestCommand({ now: () => new Date(now), randomHex: () => 'abc123' });
  const code = await cmd.run({
    argv,
    io,
    overlayPath: undefined,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, out: out.join(''), err: err.join('') };
}

const BASE = ['--rule', 'sample-atom', '--member', '@alice'];
type Json = { window_start: string; window_end: string; acceptance_sha256?: string; tile?: number };

describe('W13 attest --tile 与 G3 同口径', () => {
  it('--tile k 的窗口 = 冻结协议的第 k 块(与 G3 共用 acceptanceD0/tileWindow),并写入 acceptance_sha256;零写入', async () => {
    const { w, io, parent, freezeDate } = await setup();
    expect(freezeDate).toBe('2026-10-05');
    const before = await snapshot(parent);
    for (const k of [0, 1, 2, 3]) {
      const r = await run(io, [
        ...BASE,
        '--tile',
        String(k),
        '--freeze-date',
        freezeDate,
        '--json',
      ]);
      expect(r.code, r.err).toBe(0);
      const j = JSON.parse(r.out) as Json;
      expect(j).toMatchObject({
        window_start: w.tile(k).start,
        window_end: w.tile(k).end,
        acceptance_sha256: w.acc['sha256'],
        tile: k,
      });
    }
    expect(await snapshot(parent)).toEqual(before);
  });

  it('CLI 算出的窗口被 G3 计入:用 CLI 的 window 造 attest,同一冻结下 T2 绿;对照:错一天的 --freeze-date 算出的窗口不被计入', async () => {
    const { w, io, freezeDate } = await setup();
    const windows: { start: string; end: string }[] = [];
    for (const k of [0, 1]) {
      const r = await run(io, [
        ...BASE,
        '--tile',
        String(k),
        '--freeze-date',
        freezeDate,
        '--json',
      ]);
      const j = JSON.parse(r.out) as Json;
      windows.push({ start: j.window_start, end: j.window_end });
    }
    const attests = windows.flatMap((x) => [
      { member: '@alice', ...x },
      { member: '@bob', ...x },
    ]);
    expect((await buildWorld({ attests })).run().codes).toEqual([]);
    repos.push(w.repo);
    // 错的冻结日期(晚 3 天)→ D0 偏移 → 窗口不对齐 → G3 不计入(安全方向,不会放宽判据)
    const wrong = await run(io, [...BASE, '--tile', '0', '--freeze-date', '2026-10-08', '--json']);
    const wj = JSON.parse(wrong.out) as Json;
    expect(wj.window_start).not.toBe(w.tile(0).start);
    const bad = await buildWorld({
      attests: [
        { member: '@alice', start: wj.window_start, end: wj.window_end },
        { member: '@bob', start: wj.window_start, end: wj.window_end },
      ],
    });
    expect(bad.run().codes).toContain('GUARD_G3_ATTEST_NOT_COUNTED');
  });

  it('手填窗口:HEAD 工作树提案有匹配的冻结协议时也绑定 acceptance_sha256(这样对齐的手填窗口能被 G3 计入)', async () => {
    const { w, io } = await setup();
    const r = await run(io, [
      ...BASE,
      '--window-start',
      w.tile(1).start,
      '--window-end',
      w.tile(1).end,
      '--json',
    ]);
    expect(r.code, r.err).toBe(0);
    expect((JSON.parse(r.out) as Json).acceptance_sha256).toBe(w.acc['sha256']);
  });

  it('用法与失败路径:--tile 与 --window-* 互斥、缺 --freeze-date、tile 越界、分块未结束、没有冻结', async () => {
    const { io, freezeDate } = await setup();
    const t = ['--tile', '1', '--freeze-date', freezeDate];
    expect((await run(io, [...BASE, ...t, '--window-start', '2026-10-01'])).code).toBe(2);
    expect((await run(io, [...BASE, '--tile', '1'])).err).toContain('missing:--freeze-date');
    expect((await run(io, [...BASE, '--tile', '4', '--freeze-date', freezeDate])).err).toContain(
      'tile_out_of_range',
    );
    // 块 1 = 10-13…10-19;时钟在 10-19 当天 → 分块还没结束 → 退出 4
    const early = await run(io, [...BASE, ...t], '2026-10-19T08:00:00Z');
    expect(early.code).toBe(4);
    expect(early.err).toContain('tile_not_ended');
    // 对照:结束后的第二天可以出
    expect((await run(io, [...BASE, ...t], '2026-10-20T08:00:00Z')).code).toBe(0);
    const none = await setup({ noFreeze: true });
    const r = await run(none.io, [...BASE, '--tile', '1', '--freeze-date', none.freezeDate]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('acceptance_missing');
  });
});

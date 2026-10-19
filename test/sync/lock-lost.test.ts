/**
 * S7c-B:sync 事务的每个提交点前复核仍持锁(陈旧锁回收竞态里锁被别人夺走时,不得继续写)。
 * 正向对照:同一世界不夺锁则正常写完。
 */
import { describe, expect, it } from 'vitest';
import { SKILL, newWorld, stdFixture } from './world.js';

const LOCK = '.local/state/agent-kit/sync/lock';
const thief = JSON.stringify({
  pid: process.pid,
  started_at: '2026-10-14T12:00:00.000Z',
  nonce: 'ffffffffffffffff',
});

describe('sync:提交点前复核锁所有权', () => {
  it('journal 写完后锁被夺走:不写任何受管文件,退出 4 SYNC_LOCKED,别人的锁不被删;对照:不夺锁则写完', async () => {
    const ok = await newWorld('lock-lost-ok-');
    await ok.setPayload(stdFixture());
    expect((await ok.run(['--write'])).code).toBe(0);
    expect(await ok.has(SKILL)).toBe(true);

    const w = await newWorld('lock-lost-');
    await w.setPayload(stdFixture());
    const r = await w.run(['--write'], {
      deps: {
        inject: async (p) => {
          if (p === 'journal-written') await w.put(LOCK, thief, 0o600);
        },
      },
    });
    expect(r.code).toBe(4);
    expect(r.err).toBe('SYNC_NOT_RUN reason=SYNC_LOCKED\n');
    expect(await w.has(SKILL)).toBe(false);
    expect(await w.read(LOCK)).toBe(thief);
  });

  it('写第一个文件之后锁被夺走:不继续写后面的文件与登记表', async () => {
    const w = await newWorld('lock-lost-mid-');
    await w.setPayload(stdFixture());
    let first = true;
    const r = await w.run(['--write'], {
      deps: {
        inject: async (p) => {
          if (p.startsWith('after-write:') && first) {
            first = false;
            await w.put(LOCK, thief, 0o600);
          }
        },
      },
    });
    expect(r.code).toBe(4);
    expect(await w.has('.local/state/agent-kit/sync/ledger.json')).toBe(false);
  });
});

/**
 * B2 评审第 1 轮 ②:`rebase-baseline` 写后复核(`rebase_post_write_recheck`)。`head.json` 写入之后、清暂停标志之前再判一次情形:
 * 不是 `ok`(HEAD 在写入前后又变了 / 仓库前提不成立)→ 保持暂停(不清标志)、不报 done,退 1 `RSI_CONFIRM_STALE`。
 * 并发边界如实:不遵守项目锁的人工 git 与「复核 → 写入」之间仍有窗口;保证的是写后复核不一致时不清暂停、不报完成。
 */
import { describe, expect, it } from 'vitest';
import { makeFx, runWrite } from '../auto/write-fixture.js';

const HEAD = 'a'.repeat(40);

describe('rebase_post_write_recheck', () => {
  it('baseline:写入之后 HEAD 又变(情形回到分叉)→ 退 1 RSI_CONFIRM_STALE,diverged 标志保持,不报 done;对照:没变 → 退 0 且清标志', async () => {
    const fx = makeFx();
    fx.pause.state = { reasons: [], diverged: true, owner_changed: false };
    fx.rebase.afterRewrite = () => {
      fx.rebase.situation = { kind: 'diverged', head: 'c'.repeat(40) };
    };
    const r = await runWrite('auto', ['rebase-baseline'], fx, { input: ['yes'] });
    expect([r.code, r.err]).toEqual([1, 'RSI_CONFIRM_STALE\n']);
    expect(r.out).not.toContain('rebase-baseline=done');
    expect(fx.rebase.headWrites).toEqual([['baseline', HEAD]]); // 写入发生过(窗口如实存在),但没有清标志
    expect(fx.pause.state.diverged).toBe(true);
    expect(fx.pause.writes).toEqual([]);

    const ok = makeFx();
    ok.pause.state = { reasons: [], diverged: true, owner_changed: false };
    const c = await runWrite('auto', ['rebase-baseline'], ok, { input: ['yes'] });
    expect(c.code, c.err).toBe(0);
    expect(c.out).toContain('rebase-baseline=done kind=baseline');
    expect(ok.pause.state.diverged).toBe(false);
  });

  it('owner(--adopt-owner):写入之后仓库前提不成立(检视 invalid)→ 同样退 1 RSI_CONFIRM_STALE,owner_changed 标志保持', async () => {
    const fx = makeFx();
    fx.rebase.situation = { kind: 'owner_changed', head: HEAD };
    fx.pause.state = { reasons: [], diverged: false, owner_changed: true };
    fx.rebase.afterRewrite = () => {
      fx.rebase.situation = { kind: 'invalid' };
    };
    const r = await runWrite('auto', ['rebase-baseline', '--adopt-owner'], fx, { input: ['yes'] });
    expect([r.code, r.err]).toEqual([1, 'RSI_CONFIRM_STALE\n']);
    expect(r.out).not.toContain('rebase-baseline=done');
    expect(fx.pause.state.owner_changed).toBe(true);
    expect(fx.pause.writes).toEqual([]);
  });
});

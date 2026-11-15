/**
 * B2 评审第 1 轮 ②:`rewritePersonalHead` 的最后一次 HEAD 复核紧贴写入(真 git)。
 *  - `rewrite_head_recheck_after_lock_await`:锁复核(await)期间 HEAD 被人动了 → 复核在锁复核之后,抛 `head_changed`,`head.json` 不动;
 *  - `rewrite_head_no_yield_between_check_and_write`:复核与写入之间不再有让出点(旧实现在二者之间还 await 一次锁复核:那次 await 里 HEAD 变了,照样写入过期的 HEAD)。
 * 契约说法:`personal/lock` 只排除遵守项目锁的写者,本函数不保证「HEAD 已变则零写入」,只保证复核时已变则零写入。
 */
import { describe, expect, it } from 'vitest';
import { readHead } from '../../../src/rsi/personal/home-state.js';
import { rewritePersonalHead, type PersonalLocks } from '../../../src/rsi/personal/commit.js';
import {
  git,
  makeWorld,
  repoDeps,
  setupRepo,
  slowTests,
  type World,
} from '../personal/repo-helpers.js';

slowTests();

/** 模拟不经项目锁的人工 git:给 `refs/heads/rsi` 追加一个同树的子提交,返回新 HEAD */
function humanCommit(w: World, msg: string): string {
  const cur = git(w, ['rev-parse', 'HEAD']);
  const next = git(w, [
    'commit-tree',
    git(w, ['rev-parse', `${cur}^{tree}`]),
    '-p',
    cur,
    '-m',
    msg,
  ]);
  git(w, ['update-ref', 'refs/heads/rsi', next, cur]);
  return next;
}

async function recordHead(w: World): Promise<string> {
  const r = await readHead(w.h);
  if (r.kind !== 'ok') throw new Error(`head.json:${r.kind}`);
  return r.value.head;
}

describe('rewritePersonalHead:复核紧贴写入', () => {
  it('rewrite_head_recheck_after_lock_await:锁复核期间 HEAD 变了 → 抛 head_changed,head.json 不动', async () => {
    const w = await makeWorld('b2-rewrite-1-');
    const first = await setupRepo(w);
    const b = humanCommit(w, 'human-b'); // 现场:记录 = first,HEAD = b(分叉),用户确认的是 b
    let calls = 0;
    const locks: PersonalLocks = {
      personal: {
        assertHeld: async () => {
          calls += 1;
          if (calls === 1) humanCommit(w, 'human-c'); // 锁复核的 await 里 HEAD 又动了
        },
      },
    };
    await expect(rewritePersonalHead(repoDeps(w), locks, 'baseline', b)).rejects.toThrow(
      'head_changed',
    );
    expect(await recordHead(w)).toBe(first);
  });

  it('rewrite_head_no_yield_between_check_and_write:复核通过后不再让出,写入的就是复核时的 HEAD(head.json = 当前 HEAD)', async () => {
    const w = await makeWorld('b2-rewrite-2-');
    const first = await setupRepo(w);
    const b = humanCommit(w, 'human-b');
    let calls = 0;
    const locks: PersonalLocks = {
      personal: {
        assertHeld: async () => {
          calls += 1;
          if (calls >= 2) humanCommit(w, `human-late-${calls}`); // 只有「复核之后还 await 锁复核」的实现才会走到这里
        },
      },
    };
    await rewritePersonalHead(repoDeps(w), locks, 'baseline', b);
    expect(await recordHead(w)).toBe(b);
    expect(git(w, ['rev-parse', 'HEAD'])).toBe(b);
    expect(first).not.toBe(b);
  });
});

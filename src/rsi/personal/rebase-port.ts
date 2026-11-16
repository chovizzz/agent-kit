/**
 * `RebasePort` 的真实现(装配块 B2;`rsi auto rebase-baseline`,R21-3.5 情形 ② / ④):
 *  - `classify` / `changedPaths` / `headRewritten`:**只读、不要求持锁**(命令在取锁前展示清单并要求 `yes`,持锁后再判一次):走 `inspectPersonalRepo`(不建目录、不写 `head.json`、不恢复 journal、
 *    git 全部 `GIT_OPTIONAL_LOCKS=0`)。有未处理的提交 journal / 结构或记录不合规 = `invalid`(命令退 3 `personal_repo_invalid`;先让一次持锁写入跑完恢复);
 *  - `rewriteHead`:**锁绑定**——只在一次持锁期内(`assertInsideLocks`),经 `rewritePersonalHead` 写 `head.json`(复核时 HEAD 已变 = 抛 `head_changed`,零写入;不遵守项目锁的人工 git 与复核→写入之间仍有窗口,写后一致性由命令层写后复核)。
 */
import { assertInsideLocks, type CommandLockContext } from '../auto/write/command-locks.js';
import type { RebasePort, RebaseSituation } from '../auto/write/ports.js';
import {
  changedPathsSinceRecord,
  inspectPersonalRepo,
  personalHeadRewritten,
  rewritePersonalHead,
  type PersonalRepoDeps,
} from './commit.js';

export interface RebaseDeps {
  repo: PersonalRepoDeps;
  locks: Pick<CommandLockContext, 'current'>;
}

export function makeRebasePort(d: RebaseDeps): RebasePort {
  return {
    async classify(): Promise<RebaseSituation> {
      const r = await inspectPersonalRepo(d.repo);
      if (r.kind !== 'ok') return { kind: 'invalid' };
      const s = r.situation;
      if (s.situation === 1) return { kind: 'ok' };
      if (s.situation === 3 || r.head === null) return { kind: 'invalid' };
      return s.situation === 2
        ? { kind: 'diverged', head: r.head }
        : { kind: 'owner_changed', head: r.head };
    },
    changedPaths: () => changedPathsSinceRecord(d.repo),
    async rewriteHead(kind, expectHead): Promise<void> {
      const held = await assertInsideLocks(d.locks, false);
      await rewritePersonalHead(d.repo, { personal: held.personal }, kind, expectHead);
    },
    headRewritten: (kind) => personalHeadRewritten(d.repo, kind),
  };
}

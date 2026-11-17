/**
 * S1 第 1 项「仓库 + journal 续做」的纯编排(C v2 §8.4):**bootstrap 前置守卫**。
 *
 * `openPersonalRepo` 在看 `opts.bootstrap` 之前就会对 bootstrap 类 journal 调 `recoverBootstrap`(`planned` + 空目录会 `git init`,`initialized` 无提交会 `commit-tree` + `update-ref`),
 * 即「`bootstrap:false`」也会**无授权续建仓**。所以 C2 在调它之前先**只读**看 journal:bootstrap 类(任一阶段)→ **不调用 `open`**,报 `incomplete{bootstrap_pending}`;
 * `init` / `update-ref` 零调用。此前生产不可能存在 bootstrap journal(没有建仓调用方),所以不改变现状。
 * **D1b 删除本守卫**(同一 PR 把 `open` 换成 `{mode:'complete_only'}`;端口自己保证 planned / initialized 不续建、committed 先读真实 ref 与树):守卫**不得替代**端口的权威验证。
 *
 * 本文件不 import `commit.ts`:`openPersonalRepo` 只出现在装配层(`assemble-personal.ts`),调用点收敛。
 */
import { isRsiLockLost, PersonalLockLost } from '../stage/errors.js';
import { RsiLockError } from '../../lock-error.js';
import type { RepoRecovery } from '../stage/ports.js';

/** 只读 journal 的分类(`readJournal` 的窄化) */
export type JournalKind = 'none' | 'bootstrap' | 'other' | 'invalid';
export type OpenOutcome =
  | { readonly kind: 'ready' }
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'deferred';
      readonly reason: 'personal_repo_diverged' | 'personal_owner_changed';
    }
  | { readonly kind: 'invalid'; readonly why: string };

export interface RepoRecoveryDeps {
  /** 只读;读失败抛错(进 `classify`) */
  journalKind(): Promise<JournalKind>;
  /** `openPersonalRepo(bootstrap:false)` 的窄化;**只在 journal 非 bootstrap 类时才会被调用** */
  open(): Promise<OpenOutcome>;
}

export function createRepoRecovery(d: RepoRecoveryDeps): () => Promise<RepoRecovery> {
  return async (): Promise<RepoRecovery> => {
    const jk = await d.journalKind();
    if (jk === 'bootstrap') return { kind: 'incomplete', why: 'bootstrap_pending' };
    if (jk === 'invalid') return { kind: 'invalid' };
    let r: OpenOutcome;
    try {
      r = await d.open();
    } catch (e) {
      // 锁丢失 / 锁错误原样上抛(进统一分类器);其余(含 git 读失败)= 仓库不可用(W0-15:git 读失败即 `personal_repo_invalid`)
      if (isRsiLockLost(e) || e instanceof PersonalLockLost || e instanceof RsiLockError) throw e;
      return { kind: 'invalid' };
    }
    switch (r.kind) {
      case 'absent':
        return { kind: 'absent' };
      case 'invalid':
        return { kind: 'invalid' };
      case 'ready':
        return { kind: 'judged', judgement: 'at_record' };
      case 'deferred':
        return {
          kind: 'judged',
          judgement: r.reason === 'personal_repo_diverged' ? 'diverged' : 'owner_changed',
        };
    }
  };
}

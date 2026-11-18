/**
 * S1 第 1 项「仓库 + journal 续做」的纯编排(C v2 §8.4)。D1b-1 起**没有**前置守卫:`open` 由装配层实现为 `openPersonalRepo(…, {mode:'complete_only'})`,
 * bootstrap 类 journal 的处置由端口自己保证——`planned` / `initialized` 不续建(`bootstrap_pending`,零 init / mktree / commit-tree / update-ref),
 * `committed` / `recorded` 先读真实 ref 与树、吻合才收尾,不吻合 = `invalid{bootstrap_inconsistent}`(熔断,journal 保留)。
 * `bootstrap_pending` 在这里映射为 `incomplete`(不熔断,与守卫时代的可观察行为一致);`invalid` 才熔断。
 *
 * 本文件不 import `commit.ts`:`openPersonalRepo` 只出现在装配层(`assemble-personal.ts`),调用点收敛。
 */
import { isRsiLockLost, PersonalLockLost } from '../stage/errors.js';
import { RsiLockError } from '../../lock-error.js';
import type { RepoRecovery } from '../stage/ports.js';

export type OpenOutcome =
  | { readonly kind: 'ready' }
  | { readonly kind: 'absent' }
  /** bootstrap 类 journal 在场且 `complete_only` 不续做(`planned` / `initialized`) */
  | { readonly kind: 'bootstrap_pending' }
  | {
      readonly kind: 'deferred';
      readonly reason: 'personal_repo_diverged' | 'personal_owner_changed';
    }
  | { readonly kind: 'invalid'; readonly why: string };

/** `openPersonalRepo` 结果的结构化窄输入(本文件不 import `commit.ts`;`OpenResult` 结构上可赋给它) */
export type OpenResultLike =
  | { readonly kind: 'ready' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'bootstrap_pending' }
  | { readonly kind: 'bootstrap_denied' }
  | {
      readonly kind: 'deferred';
      readonly reason: 'personal_repo_diverged' | 'personal_owner_changed';
    }
  | { readonly kind: 'invalid'; readonly why: string };

/**
 * `openPersonalRepo({mode:'complete_only'})` 结果 → S1 的 {@link OpenOutcome}。`bootstrap_denied` 在 `complete_only` 下是纵深防御(恒拒授权),
 * 正常走不到;按「bootstrap 未完成」处理(不熔断)。
 */
export function outcomeOfOpen(r: OpenResultLike): OpenOutcome {
  switch (r.kind) {
    case 'ready':
      return { kind: 'ready' };
    case 'absent':
      return { kind: 'absent' };
    case 'bootstrap_pending':
    case 'bootstrap_denied':
      return { kind: 'bootstrap_pending' };
    case 'deferred':
      return { kind: 'deferred', reason: r.reason };
    case 'invalid':
      return { kind: 'invalid', why: r.why };
  }
}

export interface RepoRecoveryDeps {
  /** `openPersonalRepo({mode:'complete_only'})` 的窄化 */
  open(): Promise<OpenOutcome>;
}

export function createRepoRecovery(d: RepoRecoveryDeps): () => Promise<RepoRecovery> {
  return async (): Promise<RepoRecovery> => {
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
      case 'bootstrap_pending':
        return { kind: 'incomplete', why: 'bootstrap_pending' };
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

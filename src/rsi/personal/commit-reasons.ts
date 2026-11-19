/**
 * 提交底座对外给出的、调用方要据以分类的原因码(无依赖:worker 闭包里的 candidate-apply / candidate-step 与 commit.ts 共用同一个字面量,不必为一个常量去 import git 运行时)。
 */

/**
 * `beforeRefUpdate` 钩子拒绝后,清理发现 `refs/heads/rsi` 已被别人推进:提交底座保留现场并返回 `deferred{personal_repo_diverged}`,`why` 为此值。
 * 与普通 `deferred`(只停本步)不同,调用方把它映射为 `commit_failed`(fail-closed,→ stop_step_unsettled)。
 */
export const REF_MOVED_AFTER_DENIED = 'ref_moved_after_denied';

/** 个人锁丢失的错误码(= `PersonalLockLost.code`;`stage/errors.ts` 的类型在 worker 闭包外,这里只共享字面量,`accept-r1.test.ts` 钉住两者相等) */
export const PERSONAL_LOCK_LOST_CODE = 'PERSONAL_LOCK_LOST';

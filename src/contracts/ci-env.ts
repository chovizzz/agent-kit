/**
 * CI 环境判据(单一来源):update 的自动更新闸(§19.5)与自动 RSI 的跳过条件(R20-1.6「与 update 同一张 `CI_ENV_KEYS`」)共用。
 * 零依赖:rsi 自动入口的 import 闭包不得经过 `update/policy.ts`(它 `import type` 了 `io/net.ts`,R20-1.1)。
 */
export const CI_ENV_KEYS: readonly string[] = Object.freeze([
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TF_BUILD',
  'JENKINS_URL',
]);

/** 环境变量「为真」:已设、trim 后非空、不是 `0` / `false`(大小写不敏感) */
export function truthyEnv(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== '' && t !== '0' && t !== 'false';
}

/** 任一 CI 变量为真 */
export function isCiEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  return CI_ENV_KEYS.some((k) => truthyEnv(env[k]));
}

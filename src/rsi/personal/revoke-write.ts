/**
 * 撤销凭据的写入方(docs/contracts.md R21-9.5、§21.24 W0-17)。**调用方必须持 `personal/lock`**,每次写之前经 `assertHeld` 复核。
 *
 * - `by` = **撤销来源**(不是实际写文件的进程):`clear` / `veto` / `rollback_to` 由前台命令发起,即使由 worker 续做(含 journal 崩溃恢复)也保留;
 *   worker 消费 `exec-run` 事件写的记为 `exec_event`;worker 自己的伤害判定 / taint / judge 用 `worker`。
 * - `reason` 按 `by` 约束(`RsiRevocationLineSchema` 运行时校验;正常转移码、G 码、`identity_changed` 一律拒绝,`identity_changed` 不写凭据而用旧身份拒绝标记)。
 * - **`rollback_to` 的专属原因码契约未定**(W0-17 表归 W7 订正后收窄):本块只产出 {@link ROLLBACK_TO_REASONS}(= `cleared`),
 *   理由:`rsi rollback --to` 是用户主动缩减影响(R21-12.7),没有伤害 / 否决 / 污染的事实依据,R21-4.6 里语义最近的终止原因是 `cleared`
 *   (终态理由 `cleared`、目标终态 `rolled_back`);不借用 `vetoed`(会触发指纹永久黑名单,R21-11.3)。契约常量不动,收窄只在本写入方执行。
 * - 幂等键 = `(candidate_id, content_sha256)`:同一份内容已有凭据 → 不重复写(崩溃续做不增行,首个写入者的 `by` / `reason` 保留);内容变了 → 写新凭据。
 * - `revocations.jsonl` 读不了 / 不合规 → 抛错、不写(R21-6.11 第 4a 行:按读取失败处理)。
 */
import { RsiRevocationLineSchema, type RsiRevocationLine } from '../../contracts/rsi-personal.js';
import type { RSI_REVOCATION_BY } from '../../contracts/rsi.js';
import {
  appendRevocations,
  PersonalStateError,
  readRevocations,
  type PersonalHome,
} from './home-state.js';

export type RevocationBy = (typeof RSI_REVOCATION_BY)[number];

/** `rollback_to` 实际使用的原因码(契约允许全部终止原因;这里收窄,见头注) */
export const ROLLBACK_TO_REASONS: readonly string[] = Object.freeze(['cleared']);

export class RevocationWriteError extends Error {
  readonly code = 'RSI_REVOCATION_WRITE';
  constructor(readonly kind: 'reason_not_allowed' | 'identity_changed') {
    super(`revocation write: ${kind}`);
  }
}

/**
 * reason → 撤销来源的粗映射(**只剩单测与工具用途**)。执行器的旧 journal 恢复**不再用它**(它把 `cleared` 一律推成 `clear`、其余一律 `worker`,会猜来源);
 * 旧格式 journal 的来源只由 `rollback-journal.ts` 的 `uniqueBy`(W0-17 表里唯一对应的来源,歧义不推)还原。
 */
export function byFromReason(reason: string): RevocationBy {
  switch (reason) {
    case 'cleared':
      return 'clear';
    case 'vetoed':
      return 'veto';
    case 'exec_post_check_failed':
    case 'exec_timeout_unclean':
      return 'exec_event';
    default:
      return 'worker';
  }
}

export type RevocationWrite = 'written' | 'already_present';

/** 来源与原因是否相符(执行器在写 journal 之前先问,不相符就不开始);`null` = 相符。`identity_changed` 永远不写凭据 */
export function revocationSourceProblem(by: RevocationBy, reason: string): string | null {
  if (reason === 'identity_changed') return 'identity_changed';
  const ok = RsiRevocationLineSchema.safeParse({
    at: '2026-01-01T00:00:00Z',
    candidate_id: 'ra_000000000000',
    content_sha256: '0'.repeat(64),
    identity12: null,
    reason,
    by,
  }).success;
  if (!ok) return 'reason_not_allowed';
  if (by === 'rollback_to' && !ROLLBACK_TO_REASONS.includes(reason)) return 'reason_not_allowed';
  return null;
}

export async function writeRevocation(
  h: PersonalHome,
  assertHeld: () => Promise<void>,
  input: RsiRevocationLine,
): Promise<RevocationWrite> {
  const problem = revocationSourceProblem(input.by, input.reason);
  if (problem === 'identity_changed') throw new RevocationWriteError('identity_changed');
  if (problem !== null) throw new RevocationWriteError('reason_not_allowed');
  const line = RsiRevocationLineSchema.safeParse(input);
  if (!line.success) throw new RevocationWriteError('reason_not_allowed');
  await assertHeld();
  const cur = await readRevocations(h);
  if (cur.kind === 'invalid') throw new PersonalStateError('revocations_invalid', cur.why);
  const existing = cur.kind === 'ok' ? cur.value : [];
  if (
    existing.some(
      (l) =>
        l.candidate_id === line.data.candidate_id && l.content_sha256 === line.data.content_sha256,
    )
  ) {
    return 'already_present';
  }
  await appendRevocations(h, assertHeld, [line.data]);
  return 'written';
}

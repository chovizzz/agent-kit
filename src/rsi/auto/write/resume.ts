/**
 * `rsi auto resume`(contracts R21-12.3、R21-10.4、§21.24 W0-22 第 1、2 条、W0-23 第 1 条):TTY + 三把锁(rsi → personal → sync)。
 * 步骤(任一步失败:已落盘的效果保留、先输出已做的、再退 3,可重跑):
 *   ① 参数 / TTY(2)→ 预检(3,零写入)→ `[rsi]` 关闭(4)→ 取锁(`locked` 4);
 *   ② 一次快照:`state.json` 的 `auto_pause` 得 S;U 的实例指纹 `uTok`(`lstat`;不存在 = `none`;非 ENOENT 失败抛错 → 退 3,**不碰 U**);`holds` 重查四项;
 *   ③ 计算:{@link computeResume}(只清条件已不成立的人工码;自动解除码、diverged / owner_changed 不动);U 存在时历史遗留的 state 码 `user_paused` 无条件一并清;
 *   ④ 有可清码 → 写 `state.json`(只去可清的码,保留其它键);**清到无剩余熔断码的那一次写入同时写解除证据**({@link stampReleaseEvidence},否则残留 B 会把已解除的码补回);
 *   ⑤ `bump` 入口代(先于放行);⑥ `uTok≠none` → 按指纹删 U(`remove(uTok)`:指纹不符保留并报 `changed`;**`uTok=none` 永不删 U**,恢复期间新建的 U' 因此保留);⑦ **不碰 B**(由持锁 worker 删)。
 * 结果:**读回**操作后的 state / U / B(不是用 `stillHolds` 推算)得剩余集合 R = state 里还在的码 ∪ {diverged / owner_changed 成立者} ∪ {U 在则 `user_paused`}:
 *   R 非空 → 退 1,每项一行 `RSI_AUTO_RESUME_BLOCKED reason=<码>`(按 `RSI_AUTO_RESUME_BLOCKED_REASONS` 序;自动解除码带 `auto_release=yes`;diverged / owner_changed 提示 `rebase-baseline`;U 带 `new=yes` / `changed=yes`);
 *   R 空且 B 不在 → 退 0 `RSI_AUTO_RESUMED`(只此一种);R 空且 B 在 → 退 0 `RSI_AUTO_RESUME_PENDING breaker_marker=pending paused=yes`(不得输出 `RSI_AUTO_RESUMED`)。
 * 保证边界:令牌比较与 `unlink` 之间有空窗,不提供 compare-and-unlink 原子性(封闭写者模型内无合法写者;见 W0-22 第 1 条)。
 */
import { ExitCode } from '../../../contracts/exit-codes.js';
import {
  RSI_AUTO_RESUME_BLOCKED_REASONS,
  type RsiAutoResumeBlockedReason,
} from '../../../contracts/rsi.js';
import { canonicalJson } from '../../../io/canonical-json.js';
import { parseFlags } from '../../args.js';
import {
  RSI_AUTO_RELEASE_REASONS,
  resume as computeResume,
  stampReleaseEvidence,
  type AutoPauseState,
} from '../../personal/breaker.js';
import type { RsiEarlyContext } from '../../types.js';
import { isTty, notRun, pauseOrder, precheck, say, usage } from './common.js';
import { REQUIRED_PORTS, type WritePorts, type WritePortsGetter } from './ports.js';

type UserOutcome = 'none' | 'removed' | 'changed' | 'absent';

const orderBlocked = (c: Iterable<RsiAutoResumeBlockedReason>): RsiAutoResumeBlockedReason[] => {
  const set = new Set<string>(c);
  return RSI_AUTO_RESUME_BLOCKED_REASONS.filter((r) => set.has(r));
};

export async function runResume(
  ctx: RsiEarlyContext,
  rest: readonly string[],
  getPorts: WritePortsGetter,
): Promise<number> {
  const f = parseFlags(rest, ['--json']);
  if (!f.ok) return usage(ctx, 'unknown_arg');
  const json = f.flags.has('--json');
  if (!isTty(ctx)) return usage(ctx, 'not_tty');
  const p = await getPorts();
  const bad = precheck(ctx, p, REQUIRED_PORTS['auto resume']);
  if (bad !== null) return bad;
  const ports = {
    locks: p.locks as NonNullable<WritePorts['locks']>,
    userMarker: p.userMarker as NonNullable<WritePorts['userMarker']>,
    breaker: p.breaker as NonNullable<WritePorts['breaker']>,
    pauseState: p.pauseState as NonNullable<WritePorts['pauseState']>,
    holds: p.holds as NonNullable<WritePorts['holds']>,
    marks: p.marks as NonNullable<WritePorts['marks']>,
  };
  if (!(await (p.config as NonNullable<WritePorts['config']>)()).rsiOn) return notRun(ctx, 'off');

  /** 已落盘的效果(失败时先输出它们) */
  const done: string[] = [];
  try {
    return await ports.locks.withLocks('rsi_personal_sync', async (held) => {
      const um = await ports.userMarker();
      // ② 一次快照(`lstat` 非 ENOENT 失败 → 抛错 → 退 3,U 不动)
      const uTok = await um.snapshot();
      const s0 = await ports.pauseState.read();
      const holds = await ports.holds.snapshot();
      // ③ 计算
      const r = computeResume(s0, (c) => holds.has(c));
      const legacyUser = uTok !== 'none' && s0.reasons.includes('user_paused');
      const cleared = pauseOrder([...r.cleared, ...(legacyUser ? (['user_paused'] as const) : [])]);
      // ④ 状态写入(解除证据与清码同一次写入)
      if (cleared.length > 0) {
        let next: AutoPauseState = {
          ...r.state,
          reasons: legacyUser
            ? r.state.reasons.filter((c) => c !== 'user_paused')
            : r.state.reasons,
        };
        if (r.clearMarker) next = await stampReleaseEvidence(ports.breaker, next);
        await held.rsi?.assertHeld();
        await held.personal.assertHeld();
        await ports.pauseState.write(next);
        done.push(`cleared=${cleared.join(',')}`);
      }
      // ⑤ bump(先于放行)
      await ports.marks.bump();
      done.push('reset_gen=bumped');
      // ⑥ 按指纹删 U(`none` 永不删)
      let uOut: UserOutcome = 'none';
      if (uTok !== 'none') {
        uOut = await um.remove(uTok);
        done.push(`user_marker=${uOut}`);
      }
      // ⑦ 读回(不碰 B)
      const s1 = await ports.pauseState.read();
      const u1 = await um.snapshot();
      const b1 = await ports.breaker.read();

      const remaining = new Set<RsiAutoResumeBlockedReason>(s1.reasons);
      if (s1.diverged) remaining.add('personal_repo_diverged');
      if (s1.owner_changed) remaining.add('personal_owner_changed');
      if (u1 !== 'none') remaining.add('user_paused');
      const ordered = orderBlocked(remaining);
      const bPending = b1 !== null;
      const userFlag = uOut === 'changed' ? 'changed=yes' : 'new=yes';
      const lines = ordered.map((code) => {
        const extra: string[] = [];
        if ((RSI_AUTO_RELEASE_REASONS as ReadonlySet<string>).has(code))
          extra.push('auto_release=yes');
        if (code === 'personal_repo_diverged' || code === 'personal_owner_changed') {
          extra.push('hint=rsi_auto_rebase-baseline');
        }
        if (code === 'user_paused' && u1 !== 'none') {
          extra.push(userFlag);
          if (bPending) extra.push('breaker_marker=pending');
        }
        return `RSI_AUTO_RESUME_BLOCKED reason=${code}${extra.length > 0 ? ` ${extra.join(' ')}` : ''}`;
      });
      let exit: number = ExitCode.CHECK_FAILED;
      if (ordered.length === 0) {
        exit = ExitCode.OK;
        lines.push(
          bPending
            ? 'RSI_AUTO_RESUME_PENDING breaker_marker=pending paused=yes'
            : 'RSI_AUTO_RESUMED',
        );
      }
      for (const l of lines) ctx.stderr(`${l}\n`);
      const paused = ordered.length > 0 || bPending;
      const summary = json
        ? [
            ...canonicalJson({
              cleared,
              remaining: ordered,
              user_marker: u1 === 'none' ? 'absent' : 'present',
              breaker_marker: bPending ? 'pending' : 'absent',
              paused,
              request_done: exit === ExitCode.OK,
            })
              .replace(/\n$/, '')
              .split('\n'),
          ]
        : [
            `cleared=${cleared.length > 0 ? cleared.join(',') : 'none'}`,
            `user_marker=${u1 === 'none' ? 'absent' : 'present'}`,
            `breaker_marker=${bPending ? 'pending' : 'absent'}`,
            ...(u1 !== 'none' && ordered.includes('user_paused')
              ? ['U 已变化 / 恢复期间用户又暂停,已保留,未处理']
              : []),
          ];
      const shown = await say(ctx, p, summary);
      return shown !== ExitCode.OK ? shown : exit;
    });
  } catch (e) {
    // 已落盘的效果保留:先输出已做的部分,再由入口映射退出码(未接线 / 写失败 / 锁 → 3 / 4)
    if (done.length > 0) await say(ctx, p, [`已完成:${done.join(' ')}`]).catch(() => 3);
    throw e;
  }
}

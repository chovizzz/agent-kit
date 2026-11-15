/**
 * `rsi status --json` 的 R21-13.1 追加键(contracts R21-13.1、§21.24 W0-22 第 7 条、W0-24;只含 id、枚举、计数,没有路径 / 正文)。**只读**:不拿锁、不建目录、不跑 git;
 * 本文件在 `src/rsi/status.ts` 的零写入 import 闭包里,所以只用只读模块(`read-fs`、`lock-read` 的 `rsiDirReadonly`、纯函数 `view-read`)。
 *   - `auto` = `{enabled, phase, paused, pause_reasons, diverged, profile, profile_effective}`:`enabled` / `profile` 取 `[rsi.auto]`(缺省 `false` / `medium`;配置不合规按未启用);`phase` = 当前相位;
 *     `paused` / `pause_reasons` / `diverged` 与 `rsi auto status` 同一判定(U 存在 ∨ B 存在 ∨ 熔断码非空 ∨ diverged ∨ owner_changed;`user_paused` 按 U 的存在性补);`profile_effective` 在相位低于 V3 时恒 `lite`;
 *   - V1 的键(`pipeline` / `budget` / `cost` / `canary` / `last_rollback`)取自物化视图 `auto-view.json`(fresh / stale 照出,缺失 / 损坏 = `null`,绝不显示成全零);
 *   - V2+ 的键给惰性值:`static_watch=null`(V2)、`isolation={status:'not_available',reason:null}`(V6b)、`extensions={trial:0,adopted:0,pending_auth:0}`(V5)、`contrib=0`(V4)、`exec='not_available'`(V6a)。
 * 任何读失败(标记 `lstat` 非 ENOENT 失败、视图读不出)都按保守方向:标记按存在、视图按损坏(`null`),不抛错、不改变 `rsi status` 既有的退出行为。
 */
import * as path from 'node:path';
import { RSI_AUTO_PHASE, RsiAutoSchema, phaseAtLeast } from '../../../contracts/rsi.js';
import type { AutoView } from '../../../contracts/rsi-personal.js';
import type { IoContext } from '../../../io/paths.js';
import { lstat, readFileSafe } from '../../../io/read-fs.js';
import { CANARY_FILES } from '../../canary/files.js';
import { RSI_FILE_OWNER, rsiDirReadonly } from '../../lock-read.js';
import type { RsiStateDoc } from '../../state.js';
import { interpretView } from './view-read.js';

export interface AutoStatusKeys {
  auto: {
    enabled: boolean;
    phase: number;
    paused: boolean;
    pause_reasons: string[];
    diverged: boolean;
    profile: string;
    profile_effective: string;
  };
  pipeline: AutoView['pipeline'] | null;
  budget: AutoView['budget'] | null;
  cost: AutoView['cost'] | null;
  canary: AutoView['canary'] | null;
  static_watch: null;
  isolation: { status: 'not_available'; reason: null };
  extensions: { trial: 0; adopted: 0; pending_auth: 0 };
  contrib: 0;
  exec: 'not_available';
  last_rollback: AutoView['last_rollback'] | null;
}

/** V2+ 的惰性值 + V1 键在「没有来源」时的 `null`(`[rsi]` 关闭:没有仓库与状态目录,视图缺失) */
export function offAutoKeys(phase: number = RSI_AUTO_PHASE): AutoStatusKeys {
  return {
    auto: {
      enabled: false,
      phase,
      paused: false,
      pause_reasons: [],
      diverged: false,
      profile: 'medium',
      profile_effective: phaseAtLeast('V3', phase) ? 'medium' : 'lite',
    },
    pipeline: null,
    budget: null,
    cost: null,
    canary: null,
    static_watch: null,
    isolation: { status: 'not_available', reason: null },
    extensions: { trial: 0, adopted: 0, pending_auth: 0 },
    contrib: 0,
    exec: 'not_available',
    last_rollback: null,
  };
}

async function markerPresent(dir: string, name: string): Promise<boolean> {
  try {
    await lstat(path.join(dir, name));
    return true;
  } catch (e) {
    // 非 ENOENT 失败也按存在处理(fail-closed,与 hint 一致)
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export async function autoStatusKeys(a: {
  /** `[rsi.auto]` 的原样表(`RsiConfigOn.auto`) */
  autoTable: Record<string, unknown> | undefined;
  stateDoc: RsiStateDoc;
  io: IoContext;
  now: Date;
  phase?: number;
}): Promise<AutoStatusKeys> {
  const phase = a.phase ?? RSI_AUTO_PHASE;
  const parsed = RsiAutoSchema.safeParse(a.autoTable ?? {});
  const enabled = parsed.success && parsed.data.enabled === true;
  const profile = parsed.success ? (parsed.data.profile ?? 'medium') : 'medium';
  const ap = a.stateDoc.kind === 'ok' ? a.stateDoc.state.auto_pause : undefined;

  let user = false;
  let breaker = false;
  let viewRaw: { kind: 'absent' } | { kind: 'ok'; text: string } | { kind: 'unreadable' } = {
    kind: 'absent',
  };
  const d = await rsiDirReadonly(a.io);
  if (d.kind === 'unsafe') {
    user = true;
    breaker = true;
    viewRaw = { kind: 'unreadable' };
  } else if (d.kind === 'ok') {
    user = await markerPresent(d.dir, CANARY_FILES.pause);
    breaker = await markerPresent(d.dir, CANARY_FILES.pauseBreaker);
    try {
      const r = await readFileSafe(path.join(d.dir, 'auto-view.json'), {
        maxBytes: 64 * 1024 * 1024,
        owner: RSI_FILE_OWNER,
      });
      viewRaw =
        r.kind === 'ok'
          ? { kind: 'ok', text: r.bytes.toString('utf8') }
          : r.kind === 'missing'
            ? { kind: 'absent' }
            : { kind: 'unreadable' };
    } catch {
      viewRaw = { kind: 'unreadable' };
    }
  }
  const view = interpretView(viewRaw, a.now);
  const v: AutoView | null = view.state === 'fresh' || view.state === 'stale' ? view.view : null;
  const reasons: string[] = [...(ap?.reasons ?? [])];
  if (user) reasons.push('user_paused');
  const paused =
    user ||
    breaker ||
    (ap?.reasons.length ?? 0) > 0 ||
    ap?.diverged === true ||
    ap?.owner_changed === true;
  return {
    ...offAutoKeys(phase),
    auto: {
      enabled,
      phase,
      paused,
      pause_reasons: reasons,
      diverged: ap?.diverged === true,
      profile,
      profile_effective: phaseAtLeast('V3', phase) ? profile : 'lite',
    },
    pipeline: v?.pipeline ?? null,
    budget: v?.budget ?? null,
    cost: v?.cost ?? null,
    canary: v?.canary ?? null,
    last_rollback: v?.last_rollback ?? null,
  };
}

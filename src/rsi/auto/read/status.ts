/**
 * `rsi auto status [--json]`(contracts R21-12.1 / R21-13.1、§21.24 W0-22 第 7 条;只读命令,零写入、不拿锁、**不跑 git**)。
 *
 * 数据源:物化视图 `auto-view.json`({@link interpretView};缺失 / 损坏 / 陈旧的语义见该文件)、`state.json` 的 `auto_pause`、两个暂停标记的存在性、
 * HOME 侧事务目录与撤销凭据的**存在性**(弱协议 {@link confirmExistence};不解析 journal 内容)。视图**不是实时权威**:`stalled` 文案写「按视图 as_of=… 判为停住」。
 *   - `paused` = U 存在 ∨ B 存在 ∨ 熔断码非空 ∨ diverged ∨ owner_changed;`pause_reasons` 里 `user_paused` 按 U 的存在性补;B 在而无熔断码 → `breaker_marker=pending`;
 *   - 视图缺失 / 损坏 → 派生键(`pipeline` / `budget` / `cost` / `canary` / `last_rollback` / `rollback_stalled` / `protection_marks`)为 `null`,绝不显示成全零 / 正常;
 *   - `state.json` 整份过不了 schema → 退 3 `RSI_FAIL_CLOSED reason=state_invalid`;视图损坏 / 缺失 → 退 0;
 *   - 处置完成证据 = `clear` / `veto` 退 0 且 status 在 `view_state=fresh` 下无 `stalled` / `unconfirmed`;resume 不以「status 不再列出」为依据。
 * `--json` 键集合固定(canonical):顶层 `auto` / `pipeline` / `budget` / `cost` / `canary` / `last_rollback`;`auto` 下追加 `view_state` / `as_of` / `record_oid12` /
 * `rollback_stalled[]` / `protection_marks[]` / `breaker_marker`。
 */
import { ExitCode } from '../../../contracts/exit-codes.js';
import { phaseAtLeast } from '../../../contracts/rsi.js';
import type { AutoView } from '../../../contracts/rsi-personal.js';
import { canonicalJson } from '../../../io/canonical-json.js';
import { emitLines, jsonLines, type OutputSink } from '../../output.js';
import type { OutLine } from '../../sanitize.js';
import type { AutoReadPorts } from './ports.js';
import { confirmExistence } from './snapshot.js';
import { classifyRollingBack, type JournalExistence, type StalledItem } from './stall.js';
import { interpretView, type ViewState } from './view-read.js';

export interface AutoStatusDoc {
  auto: {
    enabled: boolean;
    phase: number;
    paused: boolean;
    pause_reasons: string[];
    diverged: boolean;
    profile: string;
    profile_effective: string;
    view_state: ViewState;
    as_of: string | null;
    record_oid12: string | null;
    rollback_stalled: StalledItem[] | null;
    protection_marks: AutoView['protection_marks'] | null;
    breaker_marker: 'absent' | 'pending';
  };
  pipeline: AutoView['pipeline'] | null;
  budget: AutoView['budget'] | null;
  cost: AutoView['cost'] | null;
  canary: AutoView['canary'];
  last_rollback: AutoView['last_rollback'];
}

export type AutoStatusResult =
  { kind: 'ok'; doc: AutoStatusDoc; truncated: boolean } | { kind: 'state_invalid' };

export async function computeAutoStatus(
  p: AutoReadPorts,
  phase: number,
): Promise<AutoStatusResult> {
  const cfg = await p.config();
  const state = await p.state();
  if (state.kind === 'invalid') return { kind: 'state_invalid' };
  const markers = await p.markers();
  const now = p.now();
  const view = interpretView(await p.view(), now);
  const ap = state.kind === 'ok' ? state.autoPause : null;
  const reasons: string[] = [...(ap?.reasons ?? [])];
  if (markers.user === 'present') reasons.push('user_paused');
  const paused =
    markers.user === 'present' ||
    markers.breaker === 'present' ||
    (ap?.reasons.length ?? 0) > 0 ||
    ap?.diverged === true ||
    ap?.ownerChanged === true;
  const v: AutoView | null = view.state === 'fresh' || view.state === 'stale' ? view.view : null;
  let stalled: StalledItem[] | null = null;
  if (v !== null && (view.state === 'fresh' || view.state === 'stale')) {
    // 存在性弱协议:只在有候选可判时读(不跑 git、不解析 journal 内容)
    let journals: JournalExistence = { kind: 'names', names: new Set() };
    if (v.rolling_back.length > 0 && view.state === 'fresh') {
      journals = await confirmExistence(p.home);
    }
    stalled = classifyRollingBack(v.rolling_back, { viewState: view.state, now, journals });
  }
  const profile = cfg.profile;
  return {
    kind: 'ok',
    truncated: v !== null && (v.rolling_back_truncated || v.protection_marks_truncated),
    doc: {
      auto: {
        enabled: cfg.rsiOn && cfg.enabled,
        phase,
        paused,
        pause_reasons: reasons,
        diverged: ap?.diverged === true,
        profile,
        profile_effective: phaseAtLeast('V3', phase) ? profile : 'lite',
        view_state: view.state,
        as_of: v?.as_of ?? null,
        record_oid12: v === null ? null : v.record_oid.slice(0, 12),
        rollback_stalled: stalled,
        protection_marks: v?.protection_marks ?? null,
        breaker_marker:
          markers.breaker === 'present' && (ap?.reasons.length ?? 0) === 0 ? 'pending' : 'absent',
      },
      pipeline: v?.pipeline ?? null,
      budget: v?.budget ?? null,
      cost: v?.cost ?? null,
      canary: v?.canary ?? null,
      last_rollback: v?.last_rollback ?? null,
    },
  };
}

const b = (x: boolean): string => (x ? 'true' : 'false');

/** 文本渲染:一行一项,只含枚举 / 计数 / id / 时间(不含路径) */
export function renderStatusText(d: AutoStatusDoc, truncated = false): OutLine[] {
  const a = d.auto;
  const lines: string[] = [
    `auto: enabled=${b(a.enabled)} phase=${a.phase} paused=${b(a.paused)} diverged=${b(a.diverged)} profile=${a.profile} profile_effective=${a.profile_effective}`,
    `pause_reasons: ${a.pause_reasons.length === 0 ? 'none' : a.pause_reasons.join(',')}`,
    `breaker_marker=${a.breaker_marker}`,
    `view: state=${a.view_state} as_of=${a.as_of ?? 'none'} record=${a.record_oid12 ?? 'none'}`,
  ];
  if (d.pipeline !== null) {
    const states = Object.entries(d.pipeline.states)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
    const t = d.pipeline.last30d;
    lines.push(
      `pipeline: ${states === '' ? 'empty' : states} last30d: rejected=${t.rejected} rolled_back=${t.rolled_back} expired=${t.expired} retired=${t.retired}`,
    );
  }
  if (d.budget !== null) lines.push(`budget: used_pct=${d.budget.used_pct}`);
  if (d.cost !== null) {
    lines.push(
      `cost: injected_bytes_mean=${d.cost.injected_bytes_mean} s2_count=${d.cost.s2_count}`,
    );
  }
  if (a.view_state === 'fresh' || a.view_state === 'stale') {
    lines.push(
      d.canary === null
        ? 'canary: none'
        : `canary: id=${d.canary.id} treat=${d.canary.treat} control=${d.canary.control}`,
    );
    lines.push(
      d.last_rollback === null
        ? 'last_rollback: none'
        : `last_rollback: id=${d.last_rollback.id} at=${d.last_rollback.at} reason=${d.last_rollback.reason}`,
    );
  }
  if (truncated) {
    lines.push(
      '视图的 rolling_back / protection_marks 清单被截断(不完整):下列列表不构成「没有待处置项」的证据',
    );
  }
  const stalled = a.rollback_stalled;
  if (stalled !== null) {
    lines.push(`rollback_stalled: ${stalled.length}`);
    for (const s of stalled) lines.push(`  id=${s.id} state=${s.state} stall=${s.stall}`);
    if (stalled.some((s) => s.state === 'stalled')) {
      lines.push(
        `停住候选:按视图 as_of=${a.as_of ?? 'none'} 判为停住;rsi show <id> 可经只读 git 现读确认;不会自动恢复,终态原因记为 cleared / vetoed,原保护仍按进入回滚时的原因生效`,
        '处置:撤销凭据尚未写入时先 rsi auto pause;再 rsi auto clear --write(全部非终态候选)或 rsi veto <id>(只此候选;代价:指纹永久黑名单、计入 user_vetoes);完成证据 = 命令退 0 且 status 在 view_state=fresh 下无 stalled / unconfirmed',
      );
    }
  }
  if (a.protection_marks !== null) {
    lines.push(`protection_marks: ${a.protection_marks.length}`);
    for (const m of a.protection_marks) lines.push(`  id=${m.id} mark=${m.mark} at=${m.at}`);
  }
  return lines.map((head) => ({ head }));
}

export interface AutoStatusOpts {
  json: boolean;
  phase: number;
  forbidden: readonly string[];
}

export async function runAutoStatus(
  p: AutoReadPorts,
  o: AutoStatusOpts,
  sink: OutputSink,
): Promise<number> {
  const r = await computeAutoStatus(p, o.phase);
  if (r.kind === 'state_invalid') {
    sink.stderr('RSI_FAIL_CLOSED reason=state_invalid\n');
    return ExitCode.FAIL_CLOSED;
  }
  const lines = o.json ? jsonLines(canonicalJson(r.doc)) : renderStatusText(r.doc, r.truncated);
  return emitLines(sink, lines, o.forbidden);
}

/**
 * UpdateState 的读-改-写纯逻辑与序列化(contracts §19.5)。本文件不碰磁盘:读写经调用方(S7 接 home-fs)。
 * 每个转换返回新对象,不改入参;序列化一律过 schema 再 canonical JSON。
 */
import { canonicalJson } from '../io/canonical-json.js';
import { UpdateStateSchema } from '../contracts/update.js';
import type { UpdateState } from '../contracts/update.js';
import { compareSemver, parseSemver } from './policy.js';

export const MAX_BAD_VERSIONS = 64;

export type StateParse =
  { ok: true; state: UpdateState } | { ok: false; reason: 'not_json' | 'schema' };

export function emptyState(): UpdateState {
  return UpdateStateSchema.parse({ schema_version: 1 });
}

/** 文本 → 状态。损坏时给出原因,由调用方决定 fail-closed(不静默重置:重置会清掉 max_seen_version 与 bad_versions)。 */
export function parseUpdateState(text: string): StateParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const r = UpdateStateSchema.safeParse(raw);
  return r.success ? { ok: true, state: r.data } : { ok: false, reason: 'schema' };
}

/** 状态 → canonical JSON(校验失败会抛,而不是写出坏文件) */
export function serializeUpdateState(state: UpdateState): string {
  return canonicalJson(UpdateStateSchema.parse(state));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function maxVersion(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === undefined) return b;
  if (pb === undefined) return a;
  return compareSemver(pa, pb) >= 0 ? a : b;
}

export interface CheckOutcome {
  nowMs: number;
  /** UpdateResult 取值 */
  result: string;
  /** registry 给出的候选版本及其发布时间(仅作观察记录) */
  latestSeen?: string;
  latestSeenPublishedAt?: string;
}

/**
 * 记录一次检查。⚠️ `max_seen_version` 不随「观察到」增长,只随「校验通过并安装」增长(markInstalled):
 * 否则一个被攻破的 registry 返回 99.0.0 就能把防降级线永久抬高,让真实版本都被当成降级。
 */
export function recordCheck(state: UpdateState, o: CheckOutcome): UpdateState {
  const next: UpdateState = { ...state, last_check_at: iso(o.nowMs), last_result: o.result };
  if (o.latestSeen !== undefined) next.latest_seen = o.latestSeen;
  if (o.latestSeenPublishedAt !== undefined)
    next.latest_seen_published_at = o.latestSeenPublishedAt;
  return next;
}

export function markInstalled(
  state: UpdateState,
  v: { version: string; anchor: string; nowMs: number },
): UpdateState {
  const next: UpdateState = {
    ...state,
    installed: { version: v.version, anchor: v.anchor, installed_at: iso(v.nowMs) },
  };
  if (state.installed !== undefined && state.installed.version !== v.version) {
    next.previous = state.installed;
  }
  const max = maxVersion(maxVersion(state.max_seen_version, state.installed?.version), v.version);
  if (max !== undefined) next.max_seen_version = max;
  return next;
}

/** 加入 bad_versions(去重;超过上限时丢掉最低的版本,最新的坏版本最需要记住) */
export function markBad(state: UpdateState, version: string): UpdateState {
  if (state.bad_versions.includes(version)) return state;
  const all = [...state.bad_versions, version];
  all.sort((a, b) => {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    return pa !== undefined && pb !== undefined ? compareSemver(pa, pb) : 0;
  });
  return { ...state, bad_versions: all.slice(Math.max(0, all.length - MAX_BAD_VERSIONS)) };
}

/** 失败提示每天最多一次 */
export function shouldNotify(state: UpdateState, nowMs: number): boolean {
  if (state.last_notice_at === undefined) return true;
  const last = Date.parse(state.last_notice_at);
  if (Number.isNaN(last) || nowMs < last) return true;
  return nowMs - last >= 24 * 3_600_000;
}

export function markNotified(state: UpdateState, nowMs: number): UpdateState {
  return { ...state, last_notice_at: iso(nowMs) };
}

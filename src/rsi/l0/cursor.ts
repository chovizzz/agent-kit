/**
 * cursor 状态机(R20-6.9、B4 方案 §3.2;B4b)。纯函数,无 I/O。
 *
 *   无 cursor ──首次──▶ epoch=1, done=false, started_at=now
 *   进行中 ──指纹变化──▶ epoch+1, done=false
 *   已完成 ──指纹变化 / 距 last_completed_at ≥ 7 天 / 时钟往回走──▶ epoch+1, done=false
 *   进行中 ──本次提交后满足 done 条件──▶ done=true, last_completed_at=now
 *
 * 「未改动」= size、mtime_ms、dev、ino 全等且条目 epoch 等于当前 epoch。写了条目的文件(含 read_error)都盖当前 epoch。
 * done 条件:列举完整,且本次列举到的每个文件条目都是当前 epoch。剪除只在列举完整时做,只删 root 为 ok 的 agent 的、本次没列举到的条目。
 * 条目超过 `RSI_CURSOR_MAX_FILES` 时淘汰:epoch 升序 → mtime_ms 升序 → session_ref 字节序(D8)。
 */
import {
  RSI_CURSOR_MAX_FILES,
  RSI_FULL_SCAN_INTERVAL_MS,
  type RsiCursor,
} from '../../contracts/rsi.js';
import { sessionRefFor } from '../../signals/ids.js';
import type { Enumeration, FileOutcome, SessionFile } from './types.js';

type Entry = RsiCursor['files'][string];

export interface EpochPlan {
  epoch: number;
  startedAt: string | null;
  done: boolean;
  lastCompletedAt: string | null;
  /** 本次是否开了新 epoch */
  reopened: boolean;
  /** 与旧 cursor 的指纹比较;无旧 cursor = null */
  fingerprintMatch: boolean | null;
}

export function planEpoch(prev: RsiCursor | null, fingerprint: string, nowIso: string): EpochPlan {
  if (prev === null) {
    return {
      epoch: 1,
      startedAt: nowIso,
      done: false,
      lastCompletedAt: null,
      reopened: true,
      fingerprintMatch: null,
    };
  }
  const fs = prev.full_scan;
  const match = prev.fingerprint === fingerprint;
  const nowMs = Date.parse(nowIso);
  let reopen = !match;
  if (!reopen && fs.done) {
    const last = fs.last_completed_at === null ? Number.NaN : Date.parse(fs.last_completed_at);
    // 缺 last_completed_at / 时钟往回走 / 满 7 天 → 新 epoch
    reopen = Number.isNaN(last) || nowMs < last || nowMs - last >= RSI_FULL_SCAN_INTERVAL_MS;
  }
  if (reopen) {
    return {
      epoch: fs.epoch + 1,
      startedAt: nowIso,
      done: false,
      lastCompletedAt: fs.last_completed_at,
      reopened: true,
      fingerprintMatch: match,
    };
  }
  return {
    epoch: fs.epoch,
    startedAt: fs.started_at,
    done: fs.done,
    lastCompletedAt: fs.last_completed_at,
    reopened: false,
    fingerprintMatch: match,
  };
}

export const isUnchanged = (e: Entry | undefined, f: SessionFile, epoch: number): boolean =>
  e !== undefined &&
  e.epoch === epoch &&
  e.agent === f.agent &&
  e.size === f.size &&
  e.mtime_ms === f.mtimeMs &&
  e.dev === f.dev &&
  e.ino === f.ino;

export interface ScanPlan {
  /** 「未改动」为假的文件,保持处理顺序 */
  changed: SessionFile[];
  unchanged: number;
  /** 绝对路径 → session_ref(本次列举到的全部文件) */
  refs: Map<string, string>;
}

export function planFullScan(i: {
  enumeration: Enumeration;
  prev: RsiCursor | null;
  epoch: number;
  salt: string;
}): ScanPlan {
  const out: ScanPlan = { changed: [], unchanged: 0, refs: new Map() };
  for (const f of i.enumeration.files) {
    const ref = sessionRefFor(i.salt, f.path);
    out.refs.set(f.path, ref);
    if (isUnchanged(i.prev?.files[ref], f, i.epoch)) out.unchanged++;
    else out.changed.push(f);
  }
  return out;
}

const bytesCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function buildNextCursor(i: {
  prev: RsiCursor | null;
  epoch: EpochPlan;
  fingerprint: string;
  nowIso: string;
  enumeration: Enumeration;
  /** 本次列举到的全部 session_ref(`ScanPlan.refs` 的值) */
  enumeratedRefs: ReadonlySet<string>;
  /** 读完(或判 too_large)的文件;中止 / time_limit 的文件不在其中 */
  outcomes: readonly FileOutcome[];
  maxEntries?: number;
}): RsiCursor {
  const files: Record<string, Entry> = { ...(i.prev?.files ?? {}) };
  for (const o of i.outcomes) {
    files[o.sessionRef] = {
      agent: o.file.agent,
      size: o.file.size,
      mtime_ms: o.file.mtimeMs,
      dev: o.file.dev,
      ino: o.file.ino,
      project_key: o.projectKey,
      epoch: i.epoch.epoch,
      status: o.status,
    };
  }
  if (i.enumeration.complete) {
    for (const [ref, e] of Object.entries(files)) {
      if (i.enumeration.roots[e.agent].status === 'ok' && !i.enumeratedRefs.has(ref)) {
        delete files[ref];
      }
    }
  }
  let done = i.epoch.done;
  let lastCompletedAt = i.epoch.lastCompletedAt;
  if (!done && i.enumeration.complete) {
    const stamped = [...i.enumeratedRefs].every((r) => files[r]?.epoch === i.epoch.epoch);
    if (stamped) {
      done = true;
      lastCompletedAt = i.nowIso;
    }
  }
  const max = i.maxEntries ?? RSI_CURSOR_MAX_FILES;
  const keys = Object.keys(files);
  if (keys.length > max) {
    keys.sort((a, b) => {
      const ea = files[a] as Entry;
      const eb = files[b] as Entry;
      return ea.epoch - eb.epoch || ea.mtime_ms - eb.mtime_ms || bytesCmp(a, b);
    });
    for (const k of keys.slice(0, keys.length - max)) delete files[k];
  }
  return {
    schema_version: 1,
    fingerprint: i.fingerprint,
    full_scan: {
      epoch: i.epoch.epoch,
      started_at: i.epoch.startedAt,
      done,
      last_completed_at: lastCompletedAt,
    },
    files,
  };
}

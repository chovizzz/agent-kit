/**
 * doctor D18 的只读采集(§21 W0-29 ⑥):把 `peekRsiLock` / `log.jsonl` 末尾 / `state.json` / `canary.json` / B、U 标记的 `lstat` 读成
 * `ResidualFacts`,交给判定内核 `evaluateSafetyResidual`(`personal/stage/residual.ts`,纯函数)。
 * **零写入、不拿任何锁**;只 import 只读模块。输出只含枚举 / 布尔 / 计数。读不了 → `unreadable`,不臆测、不抛。
 */
import * as path from 'node:path';
import { RsiLogLineSchema } from '../contracts/rsi.js';
import { lstat, readFileSafe } from '../io/read-fs.js';
import { loadRsiConfig } from '../rsi/config.js';
import { CANARY_FILES } from '../rsi/canary/files.js';
import { createRsiIoContext } from '../rsi/io.js';
import { RSI_FILE_OWNER, peekRsiLock, rsiDirReadonly } from '../rsi/lock-read.js';
import { evaluateSafetyResidual, type ResidualFacts } from '../rsi/personal/stage/residual.js';
import { parseRsiStateDoc } from '../rsi/state.js';
import type { D18Input } from './checks.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface CollectD18Args {
  home: string;
  env: Env;
  now?: () => Date;
}

const LOG_MAX_BYTES = 1024 * 1024;
const FILE_MAX_BYTES = 1024 * 1024;

type Read = { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'bad' };
async function readText(file: string, maxBytes: number): Promise<Read> {
  try {
    const r = await readFileSafe(file, { maxBytes, owner: RSI_FILE_OWNER });
    if (r.kind === 'ok') return { kind: 'ok', text: r.bytes.toString('utf8') };
    return r.kind === 'missing' ? { kind: 'missing' } : { kind: 'bad' };
  } catch {
    return { kind: 'bad' };
  }
}

async function present(file: string): Promise<boolean | null> {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? false : null;
  }
}

/** 末尾连续的 `skipped_locked` 行(从后往前数;遇到别的行 / 不合规行即停) */
export function skippedLockedTailOf(text: string): ResidualFacts['skippedLockedTail'] {
  const lines = text.split('\n').filter((l) => l !== '');
  let count = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try {
      row = RsiLogLineSchema.safeParse(JSON.parse(lines[i] ?? ''));
    } catch {
      break;
    }
    if (!row.success || row.data.action !== 'skipped' || row.data.code !== 'skipped_locked') break;
    const at = Date.parse(row.data.at);
    if (!Number.isFinite(at)) break;
    count += 1;
    first = at;
    last ??= at;
  }
  return { count, firstAtMs: first, lastAtMs: last };
}

export async function collectD18(a: CollectD18Args): Promise<D18Input> {
  const nowMs = (a.now ?? ((): Date => new Date()))().getTime();
  const na: D18Input = {
    applicable: false,
    unreadable: false,
    signals: [],
    facts: { lock: null, marker_b: null, marker_u: null },
  };
  const bad = (f: D18Input['facts']): D18Input => ({
    ...na,
    applicable: true,
    unreadable: true,
    facts: f,
  });
  const cfg = await loadRsiConfig({ env: a.env, home: a.home });
  if (cfg.status === 'off') {
    // 没配 / 已禁用 = 不适用;配置本身有问题(D17 已按配置原因码 fail)= 监测读不到,warn / unreadable
    if (cfg.reason === 'absent' || cfg.reason === 'no_section' || cfg.reason === 'disabled')
      return na;
    return bad({ lock: null, marker_b: null, marker_u: null });
  }
  try {
    const io = createRsiIoContext({ repo: cfg.repo, env: a.env });
    const lock = await peekRsiLock(io);
    const d = await rsiDirReadonly(io);
    if (d.kind === 'missing') {
      return { ...na, applicable: true, facts: { lock, marker_b: false, marker_u: false } };
    }
    if (d.kind === 'unsafe') return bad({ lock, marker_b: null, marker_u: null });
    const [stateR, canaryR, logR, b, u] = await Promise.all([
      readText(path.join(d.dir, 'state.json'), FILE_MAX_BYTES),
      readText(path.join(d.dir, 'canary.json'), FILE_MAX_BYTES),
      readText(path.join(d.dir, 'log.jsonl'), LOG_MAX_BYTES),
      present(path.join(d.dir, CANARY_FILES.pauseBreaker)),
      present(path.join(d.dir, CANARY_FILES.pause)),
    ]);
    const facts = { lock, marker_b: b, marker_u: u };
    if (
      stateR.kind === 'bad' ||
      canaryR.kind === 'bad' ||
      logR.kind === 'bad' ||
      b === null ||
      u === null
    ) {
      return bad(facts);
    }
    let state: ResidualFacts['state'] = null;
    if (stateR.kind === 'ok') {
      const doc = parseRsiStateDoc(Buffer.from(stateR.text, 'utf8'));
      if (doc.kind === 'ok') {
        const s = doc.state;
        const ap = s.auto_pause;
        state = {
          breakerKind: s.breaker === null ? null : s.breaker.kind === 'safety' ? 'safety' : 'other',
          breakerOpen: s.breaker !== null,
          pauseReasonsNonEmpty: ap !== undefined && ap.reasons.length > 0,
          flagsSet: ap !== undefined && (ap.diverged || ap.owner_changed),
          lastTickCompletedAtMs: s.last_tick === null ? null : Date.parse(s.last_tick.completed_at),
          rsiOn: true,
        };
      }
    }
    let canary: ResidualFacts['canary'] = null;
    if (canaryR.kind === 'ok') {
      try {
        const j = JSON.parse(canaryR.text) as { agents_inject?: unknown };
        if (Array.isArray(j.agents_inject))
          canary = { agentsInjectNonEmpty: j.agents_inject.length > 0 };
      } catch {
        canary = null;
      }
    }
    const signals = evaluateSafetyResidual({
      nowMs,
      lock,
      skippedLockedTail:
        logR.kind === 'ok'
          ? skippedLockedTailOf(logR.text)
          : { count: 0, firstAtMs: null, lastAtMs: null },
      state,
      canary,
      markers: { B: b, U: u },
      hintReadsPauseState: true,
    });
    return { applicable: true, unreadable: false, signals, facts };
  } catch {
    return bad({ lock: null, marker_b: null, marker_u: null });
  }
}

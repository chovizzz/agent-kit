/**
 * 读阶段(R20-6.7 / 6.8 / 6.9、R21-1.7;B4b):**只读、不写任何文件、不拿锁**(规划侧模块,`l0-closure` 守住)。
 * 流程:planEpoch → planFullScan → planBudget → 逐文件 {checkpoint('file') → [pi 头部预判] → processSession(行钩子:字节计量 + checkpoint('lines'))} → 映射 → buildNextCursor。
 *
 * 冻结映射(方案 §3.1):processed → `ok`(`complete` = 无 oversized_lines 且 unknown_event_types 不含 `<malformed>` / `<line-too-deep>` / `<line-too-large>`);
 * excluded:reason=self_state → `self_state`,其余 → `excluded`;unknown_project(含 pi 的 notASession)→ `unknown_project`;read_error → `read_error`;
 * 单文件实际字节超限 → `too_large`;读阶段中止 / time_limit 的当前文件整份丢弃,不写 cursor 条目。excluded 的 `project_key` 记 null(策略不回报被排除项目的根)。
 * 完整性只在内存与日志计数里(`FileOutcome.complete`),cursor 不加状态。
 */
import {
  RSI_ARMED_HEAD_BYTES,
  type RsiAgentId,
  type RsiCounterCode,
  type RsiCursor,
} from '../../contracts/rsi.js';
import type { SessionRef, TraceReader } from '../../contracts/reader.js';
import type { Redactor } from '../../contracts/redact.js';
import { readHeadLines, stat } from '../../io/read-fs.js';
import { LINE_TOO_DEEP_KEY, LINE_TOO_LARGE_KEY, MALFORMED_KEY } from '../../signals/base-reader.js';
import type { ExcludePolicy, ProjectDecision } from '../../signals/exclude.js';
import { processSession, type SessionResult } from '../../signals/pipeline.js';
import { DEFAULT_READERS } from '../../signals/readers.js';
import { fileBytesExceeded, planBudget, resolveLimits, tickBytesExhausted } from './budget.js';
import type { BudgetLimits } from './budget.js';
import { buildNextCursor, planEpoch, planFullScan } from './cursor.js';
import { parseHead } from './head-parsers.js';
import type {
  Checkpoint,
  CheckpointVerdict,
  CollectBatch,
  Enumeration,
  FileOutcome,
  IndexObservation,
  L0Deps,
  L0Summary,
  SessionFile,
} from './types.js';

export interface CollectReadInput {
  enumeration: Enumeration;
  prevCursor: RsiCursor | null;
  /** 当前指纹(`cursorFingerprint`) */
  fingerprint: string;
  salt: string;
  nowIso: string;
  policy: ExcludePolicy;
  redactor: Redactor;
  checkpoint: Checkpoint;
  /** 缺省 = `DEFAULT_READERS` 里的 claude / codex / pi */
  readers?: Partial<Record<RsiAgentId, TraceReader>>;
  fallbackVersion?: string;
  limits?: Partial<BudgetLimits>;
  /** 墙钟(毫秒),只用于 `duration_ms`;缺省 Date.now */
  nowMs?: () => number;
  deps?: L0Deps;
  /** 测试缝:传给 reader 的行钩子触发间隔 */
  lineHookEvery?: { lines?: number; bytes?: number };
}

/** 读阶段把「会话不完整」的判据集中在这里(R21-1.7) */
export function isIncomplete(result: SessionResult): boolean {
  const c = result.counts;
  if (c === undefined) return false;
  const u = c.unknown_event_types;
  return (
    (c.oversized_lines ?? 0) > 0 ||
    u[MALFORMED_KEY] !== undefined ||
    u[LINE_TOO_DEEP_KEY] !== undefined ||
    u[LINE_TOO_LARGE_KEY] !== undefined
  );
}

class ReadStop extends Error {
  constructor(readonly verdict: CheckpointVerdict) {
    super('l0 read stopped');
  }
}
class FileTooBig extends Error {
  constructor() {
    super('l0 file too big');
  }
}

const OUTCOME_OF_STATUS: Record<string, 'excluded' | 'unknown_project' | 'self_state'> = {
  excluded: 'excluded',
  not_allowed: 'excluded',
  unknown_project: 'unknown_project',
  self_state: 'self_state',
};

export async function collectRead(input: CollectReadInput): Promise<CollectBatch> {
  const t0 = (input.nowMs ?? ((): number => Date.now()))();
  const limits = resolveLimits(input.limits);
  const epoch = planEpoch(input.prevCursor, input.fingerprint, input.nowIso);
  const scan = planFullScan({
    enumeration: input.enumeration,
    prev: input.prevCursor,
    epoch: epoch.epoch,
    salt: input.salt,
  });
  const budget = planBudget(scan.changed, limits);
  const limitsHit = new Set<RsiCounterCode>([...input.enumeration.limitsHit, ...budget.limitsHit]);
  const readers = { ...DEFAULT_READERS_BY_AGENT(), ...(input.readers ?? {}) };

  const outcomes: FileOutcome[] = [];
  const results = new Map<RsiAgentId, SessionResult[]>();
  const observations: IndexObservation[] = [];
  const seenObs = new Set<string>();
  let bytesActual = 0;
  let filesRead = 0;
  let verdict: CheckpointVerdict = { kind: 'continue' };
  const skipped = {
    not_regular: input.enumeration.skipped.notRegular,
    too_large: 0,
    unchanged: scan.unchanged,
    excluded: 0,
    self_state: 0,
    unknown_project: 0,
  };

  const refOf = (f: SessionFile): string => scan.refs.get(f.path) as string;
  const push = (f: SessionFile, o: Omit<FileOutcome, 'file' | 'sessionRef'>): void => {
    outcomes.push({ file: f, sessionRef: refOf(f), ...o });
    if (o.status === 'too_large') skipped.too_large++;
    else if (o.status === 'excluded') skipped.excluded++;
    else if (o.status === 'self_state') skipped.self_state++;
    else if (o.status === 'unknown_project') skipped.unknown_project++;
  };

  // lstat 判超限的文件:不读,直接记 too_large
  for (const f of budget.tooLarge) {
    push(f, { status: 'too_large', projectKey: null, projectRoot: null, complete: true });
  }

  for (let idx = 0; idx < budget.toRead.length; idx++) {
    const f = budget.toRead[idx] as SessionFile;
    const v = await input.checkpoint('file');
    if (v.kind !== 'continue') {
      verdict = v;
      break;
    }

    // pi:先用头部判 notASession(不读正文)
    if (f.agent === 'pi') {
      const h = await readHeadLines(f.path, RSI_ARMED_HEAD_BYTES, 1, input.deps?.hooks);
      if (h.kind === 'ok') {
        bytesActual += h.bytesRead;
        if (parseHead('pi', h.lines).notASession) {
          filesRead++;
          push(f, {
            status: 'unknown_project',
            projectKey: null,
            projectRoot: null,
            complete: true,
          });
          if (tickBytesExhausted(bytesActual, limits) && idx + 1 < budget.toRead.length) {
            limitsHit.add('RSI_LIMIT_BYTES');
            break;
          }
          continue;
        }
      }
    }

    let fileBytes = 0;
    const st: { decision?: ProjectDecision; stop?: CheckpointVerdict; tooBig: boolean } = {
      tooBig: false,
    };
    const recording: ExcludePolicy = {
      async decide(cwd) {
        const d = await input.policy.decide(cwd);
        st.decision = d;
        return d;
      },
    };
    const base = readers[f.agent];
    if (base === undefined) throw new Error('l0 reader missing');
    // 钩子抛的哨兵会被 processSession 归为 read_error;是否中止 / 超限只看这里留下的标志,不依赖归类
    const hooked: TraceReader = {
      agent: base.agent,
      discover: (src) => base.discover(src),
      read: (r, o) =>
        base.read(r, {
          ...o,
          onLines: async (_lines, bytes, done): Promise<void> => {
            fileBytes = bytes;
            if (fileBytesExceeded(bytes, limits)) {
              st.tooBig = true;
              throw new FileTooBig();
            }
            if (done) return;
            const cv = await input.checkpoint('lines');
            if (cv.kind !== 'continue') {
              st.stop = cv;
              throw new ReadStop(cv);
            }
          },
          ...(input.lineHookEvery?.lines !== undefined
            ? { onLinesEvery: input.lineHookEvery.lines }
            : {}),
          ...(input.lineHookEvery?.bytes !== undefined
            ? { onLinesEveryBytes: input.lineHookEvery.bytes }
            : {}),
        }),
    };
    const ref: SessionRef = { agent: f.agent, path: f.path, session_ref: refOf(f), bytes: f.size };
    const result = await processSession(hooked, ref, {
      redactor: input.redactor,
      policy: recording,
      salt: input.salt,
      fallbackVersion: input.fallbackVersion,
      maxEventBytes: undefined,
    });
    bytesActual += fileBytes;
    if (st.stop !== undefined) {
      verdict = st.stop; // 当前文件整份丢弃
      break;
    }
    filesRead++;
    if (st.tooBig) {
      push(f, { status: 'too_large', projectKey: null, projectRoot: null, complete: true });
      limitsHit.add('RSI_FILE_TOO_LARGE');
    } else {
      const list = results.get(f.agent) ?? [];
      list.push(result);
      results.set(f.agent, list);
      if (result.status === 'processed') {
        const root = st.decision?.projectRoot ?? null;
        const projKey = result.projectKey ?? null;
        push(f, {
          status: 'ok',
          projectKey: projKey,
          projectRoot: root,
          complete: !isIncomplete(result),
        });
        if (result.counts?.unknown_event_types[LINE_TOO_DEEP_KEY] !== undefined) {
          limitsHit.add('RSI_LIMIT_DEPTH');
        }
        if (root !== null && projKey !== null && !seenObs.has(`${projKey}\0${root}`)) {
          seenObs.add(`${projKey}\0${root}`);
          try {
            const rs = await stat(root);
            observations.push({ key: projKey, path: root, dev: rs.dev, ino: rs.ino });
          } catch {
            // stat 失败 = 不更新这个根(R20-4.2)
          }
        }
      } else if (result.status === 'excluded') {
        const es = OUTCOME_OF_STATUS[result.excludeReason ?? 'excluded'] ?? 'excluded';
        push(f, { status: es, projectKey: null, projectRoot: null, complete: true });
      } else {
        push(f, { status: 'read_error', projectKey: null, projectRoot: null, complete: true });
      }
    }
    if (tickBytesExhausted(bytesActual, limits) && idx + 1 < budget.toRead.length) {
      limitsHit.add('RSI_LIMIT_BYTES');
      break;
    }
  }
  if (verdict.kind === 'time_limit') limitsHit.add('RSI_LIMIT_TIME');

  const cursorNext = buildNextCursor({
    prev: input.prevCursor,
    epoch,
    fingerprint: input.fingerprint,
    nowIso: input.nowIso,
    enumeration: input.enumeration,
    enumeratedRefs: new Set(scan.refs.values()),
    outcomes,
  });
  const limitList = [...limitsHit].sort();
  const partial = limitList.some((c) => c.startsWith('RSI_LIMIT_'));
  const summary: L0Summary = {
    outcome: verdict.kind === 'abort' ? verdict.outcome : partial ? 'ok_partial' : 'ok',
    files_planned: budget.toRead.length,
    files_read: filesRead,
    bytes_read: bytesActual,
    signals_new: null,
    sessions_new: null,
    projects: null,
    unknown_signals: null,
    skipped,
    limits_hit: limitList,
    cursor: {
      fingerprint_match: epoch.fingerprintMatch,
      full_scan: { epoch: cursorNext.full_scan.epoch, done: cursorNext.full_scan.done },
    },
    duration_ms: Math.max(0, (input.nowMs ?? ((): number => Date.now()))() - t0),
  };
  return {
    results,
    outcomes,
    observations,
    summary,
    verdict,
    bytesActual,
    enumerationComplete: input.enumeration.complete,
    cursorNext,
  };
}

function DEFAULT_READERS_BY_AGENT(): Partial<Record<RsiAgentId, TraceReader>> {
  return {
    ...(DEFAULT_READERS.claude ? { claude: DEFAULT_READERS.claude() } : {}),
    ...(DEFAULT_READERS.codex ? { codex: DEFAULT_READERS.codex() } : {}),
    ...(DEFAULT_READERS.pi ? { pi: DEFAULT_READERS.pi() } : {}),
  };
}

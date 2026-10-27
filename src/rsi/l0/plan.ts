/**
 * `tick` 干跑(R20-3.1.1、D14;R20-A2 B4c2):**纯计划,零写入**——不拿锁、不建目录、不调 recover、不建盐、不读会话正文。规划侧模块(`l0-closure` 守住闭包里没有写出口)。
 *
 *  - 固定文件经快照协议(`readRsiState` → `readVerified`):清单与文件不一致 → `RsiSnapshotBusyError`(命令层退出 4)。
 *  - 盐只经 `readSaltFile`:`absent` / `empty` → 临时盐(`salt: 'none'`,依赖真实 key 的计数不输出:`signals_new` / `sessions_new` / `projects` / `unknown_signals` 为 null,
 *    `fingerprint_match` 为 null,cursor 差分不可用 → 全部列举到的文件都算「将读」)。违规盐抛 `SaltError`(命令层映射 `salt_invalid`)。
 *  - `armed`:只列举 + 读头部(`listArmedDetailed`),没有文件被当正文读。`confirmed`:列举 + cursor 差分 + 预算,不读正文,`signals_new` 一律 null(D14)。
 *  - 与采集共用同一份 `planEpoch` / `planFullScan` / `planBudget`,所以「将读几个文件」与真跑一致(4001 文件时第一次只会算 2000)。
 */
import type { RsiCounterCode } from '../../contracts/rsi.js';
import type { IoContext } from '../../io/paths.js';
import { ephemeralSalt, readSaltFile } from '../../signals/salt-read.js';
import { attribute } from '../attribution.js';
import type { RsiConfigOn } from '../config.js';
import { piDirIsSet } from '../services/open.js';
import { readRsiState } from '../read-state.js';
import { listArmedDetailed } from './armed-listing.js';
import { planBudget, resolveLimits, type BudgetLimits } from './budget.js';
import { planEpoch, planFullScan } from './cursor.js';
import { enumerateSessionFiles } from './enumerate.js';
import { currentCursorFingerprint } from './fingerprint.js';
import type { L0Deps, L0Summary } from './types.js';

export interface PlanL0Input {
  /** 由命令边界的 `rsiStateOf` 结果折算:`confirmed` → 'confirmed',其余(首次 / 失效后 armed)→ 'armed' */
  mode: 'armed' | 'confirmed';
  limits?: Partial<BudgetLimits>;
}

export interface L0Plan {
  mode: 'armed' | 'confirmed';
  /** `persisted` = 真实盐;`none` = 盐不存在 / 空,用的是内存临时盐。契约 `--json` 的字面值:`persisted` → `"persisted"`,`none` → `"ephemeral"`(由 B5 映射) */
  salt: 'persisted' | 'none';
  summary: L0Summary;
  /** 将读的 lstat 字节数(`confirmed`);armed 是头部读取实际字节 */
  bytesPlanned: number;
  /** `armed` 的现算清单计数(路径口径,不依赖 key);`confirmed` 为 null */
  armed: { projects: number; excluded: number; unknownSessions: number; complete: boolean } | null;
}

export async function planL0(
  io: IoContext,
  config: RsiConfigOn,
  input: PlanL0Input,
  deps?: L0Deps,
): Promise<L0Plan> {
  const nowMs = (deps?.now ?? ((): Date => new Date()))().getTime();
  const t0 = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const saltRead = await readSaltFile(io.stateDir); // SaltError 原样抛
  const salt = saltRead.kind === 'ok' ? saltRead : null;

  const empty: Pick<L0Summary, 'skipped' | 'limits_hit'> = {
    skipped: {
      not_regular: 0,
      too_large: 0,
      unchanged: 0,
      excluded: 0,
      self_state: 0,
      unknown_project: 0,
    },
    limits_hit: [],
  };

  if (input.mode === 'armed') {
    const a = await listArmedDetailed(io, config, deps);
    return {
      mode: 'armed',
      salt: salt === null ? 'none' : 'persisted',
      bytesPlanned: a.bytesRead,
      armed: {
        projects: a.rows.filter((r) => !r.excluded).length,
        excluded: a.rows.filter((r) => r.excluded).length,
        unknownSessions: a.unknownSessions,
        complete: a.complete,
      },
      summary: {
        outcome: 'ok',
        files_planned: a.filesRead,
        files_read: 0,
        bytes_read: 0,
        signals_new: null,
        sessions_new: null,
        projects: null,
        unknown_signals: null,
        skipped: empty.skipped,
        limits_hit: a.limitsHit,
        cursor: { fingerprint_match: null, full_scan: { epoch: 0, done: false } },
        duration_ms: Math.max(0, Date.now() - t0),
      },
    };
  }

  // confirmed:列举 + cursor 差分 + 预算,不读正文
  const data = await readRsiState(io); // busy → RsiSnapshotBusyError
  const piSet = deps?.piDirSet ?? piDirIsSet(undefined);
  const home = io.hostEnv['HOME'] as string;
  const e = await enumerateSessionFiles(home, config, piSet, deps);
  const limits = resolveLimits(input.limits);
  const fp = salt === null ? null : await currentCursorFingerprint(io, config);
  // 盐不存在 = 没有可用 cursor(session_ref 依赖真实盐):按「无 cursor」差分
  const prev = salt === null ? null : data.cursor.value;
  const epoch = planEpoch(prev, fp ?? '', nowIso);
  const scan = planFullScan({
    enumeration: e,
    prev,
    epoch: epoch.epoch,
    salt: salt?.salt ?? ephemeralSalt(),
  });
  const budget = planBudget(scan.changed, limits);
  const limitsHit = new Set<RsiCounterCode>([...e.limitsHit, ...budget.limitsHit]);

  let projects: L0Summary['projects'] = null;
  let unknownSignals: number | null = null;
  if (salt !== null) {
    const att = await attribute({
      config,
      indexStatus: data.index.status,
      index: data.index.value,
      counts: data.counts,
    });
    let collecting = 0;
    let excluded = 0;
    let fresh = 0;
    const ack = data.stateDoc.kind === 'ok' ? data.stateDoc.state.projects_ack_generation : 0;
    for (const en of data.index.value?.entries ?? []) {
      const c = att.byKey.get(en.key);
      if (c === 'P') {
        collecting++;
        if (en.first_indexed_generation > ack) fresh++;
      } else if (c === 'X') excluded++;
    }
    projects = { collecting, excluded, new: fresh };
    let u = data.counts?.unknown_keys_signals ?? 0;
    for (const [k, v] of Object.entries(data.counts?.per_key ?? {})) {
      if (att.classify(k) === 'U') u += v.signals_total;
    }
    unknownSignals = u;
  }

  return {
    mode: 'confirmed',
    salt: salt === null ? 'none' : 'persisted',
    bytesPlanned: budget.plannedBytes,
    armed: null,
    summary: {
      outcome: [...limitsHit].some((c) => c.startsWith('RSI_LIMIT_')) ? 'ok_partial' : 'ok',
      files_planned: budget.toRead.length,
      files_read: 0,
      bytes_read: 0,
      signals_new: null, // D14:干跑不跑读阶段
      sessions_new: null,
      projects,
      unknown_signals: unknownSignals,
      skipped: {
        ...empty.skipped,
        not_regular: e.skipped.notRegular,
        too_large: budget.tooLarge.length,
        unchanged: scan.unchanged,
      },
      limits_hit: [...limitsHit].sort(),
      cursor: {
        fingerprint_match: salt === null || fp === null ? null : epoch.fingerprintMatch,
        full_scan: { epoch: epoch.epoch, done: epoch.done },
      },
      duration_ms: Math.max(0, Date.now() - t0),
    },
  };
}

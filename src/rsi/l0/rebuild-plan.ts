/**
 * `rsi projects --rebuild-index` 的规划(R20-3.5.5、D11 / D12;B4-0 冻结签名,B4c1 实现)。零写入:盐不存在 → 调用方报 `not_confirmed`;
 * 列举 + 头部读取(按 `parseHead` 的统一口径)至多 `RSI_REBUILD_MAX_FILES` 个文件、mtime 降序,读库计数;旧索引有效时合并(可信旧条目保留,新观测更新,
 * 保留 `first_indexed_generation`);算不出 key 的仍计 U;超出报 `RSI_LIMIT_FILES` 与 `remainingFiles`。
 *
 * 实现要点(B4c1 订正,待并入契约):
 *  - 头部读取整段复用 `listArmedDetailed`(armed 与 rebuild 是同一份 cwd 规则、同一份排除匹配、同一套根身份复核;D12),只把文件数上限换成 `RSI_REBUILD_MAX_FILES`。
 *  - 盐只经 `readSaltFile`(不用 `loadSalt`,不建盐、不用临时盐):`absent` / `empty` → 抛 {@link RebuildNoSaltError}(命令层映射为 `not_confirmed`);非法盐 → `SaltError` 原样抛。
 *  - 「旧索引有效」= `projects.json` 经快照协议读到、过 schema,且 `salt_fp` 与真实盐一致。有效 → `prev = 旧索引`:旧条目(含手动 `--allow-project` 采集留下的、
 *    重算不出来的 key)全部保留,新观测经 `updateIndex` 合并,新 key 的 `first_indexed_generation = 旧 generation + 1`(= 提交后的 generation);返回的 `index.generation` 是旧值。
 *    无效(缺失 / 损坏 / 盐不符)→ 从空索引重建,条目一律 `first_indexed_generation = 0`(不算新增),`index.generation = 0`。
 *  - 被排除的项目根也进索引(purge 与 X 归属要靠索引条目;`RSI_PURGE_NOT_EXCLUDED` 需要它在索引里);反思器自己的会话不是项目,不入。
 *  - 项目根 stat 失败(cwd 已删):不更新这个根;该根的会话计入 `unknownSessions`,除非旧索引里已有这个 key(那是已入索引的项目,条目原样保留,归属由读侧按根路径 / `(dev, ino)` 现算,
 *    不再当作「算不出 key」)。
 *  - 旧条目同 key 同 path 的根,`(dev, ino)` 与观测不同 → 就地改成观测值(重建是用户明确要求的「重新认定」,常规 L0 的 `updateIndex` 则不自愈);见 {@link reacknowledgeRoots}。
 *  - `unknownSessions` = 头部读不到 / 不是会话 / 取不到 cwd / 相对 cwd / 根被换的会话数 + stat 失败且旧索引没有该 key 的根的会话数;**不含**超上限没读的文件(单列 `remainingFiles`)、
 *    也**不含**反思器自己的会话(self_state 不是项目也不是未知)。
 *  - 手动 `--allow-project` 采来的 key(其根是 allow 路径)只靠旧索引有效时的合并保留;重建不认它们:同一批会话按 `canonical(cwd)` 重算出的是另一个 key,会作为独立条目新增。
 *  - `remainingFiles` 需要总文件数:`listArmedDetailed` 只给出「并入 unknownSessions 的总数」,所以触发上限时再列举一次来数(仅信息用途;B4a 若在 `listArmedDetailed` 里多返回候选总数即可去掉这次列举)。
 *  - 返回值比冻结的 `RebuildPlan` 多一个 `complete`(列举 / 头部读取是否完整:根不可评估、目录读不了、触发目录项上限、根被换都是 `false`;与 `listArmed` 同口径),
 *    B5 在 `complete === false` 且旧索引无效时不应 `--write`。
 *  - `sessions` / `signals` 取 `recomputeSignalCounts`(`recomputeCounts` 的前两段)的全量重算结果,不读 `counts.json`;`full`(满 10000)报 `RSI_INDEX_FULL`。
 * 规划侧:不 import 任何写出口(闭包由 `test/rsi/l0-closure.test.ts` 钉住)。
 */
import {
  RSI_REBUILD_MAX_FILES,
  RsiProjectIndexSchema,
  type RsiCounterCode,
  type RsiProjectIndex,
} from '../../contracts/rsi.js';
import { pickProcessEnv, type IoContext } from '../../io/paths.js';
import { stat } from '../../io/read-fs.js';
import { projectKeyFor } from '../../signals/ids.js';
import { readSaltFile } from '../../signals/salt-read.js';
import type { RsiConfigOn } from '../config.js';
import { RsiSnapshotBusyError } from '../exit.js';
import { RsiSnapshotError, readVerified } from '../snapshot-read.js';
import { listArmedDetailed } from './armed-listing.js';
import { recomputeSignalCounts } from './counts-recompute.js';
import { enumerateSessionFiles } from './enumerate.js';
import { updateIndex } from './index-update.js';
import type { IndexObservation, L0Deps, RebuildPlan } from './types.js';

/** 盐不存在(首次 armed / 空盐):没有可重建的东西,命令层报 `not_confirmed`(退 4) */
export class RebuildNoSaltError extends Error {
  readonly code = 'RSI_REBUILD_NO_SALT';
  constructor() {
    super('rebuild-index: 盐不存在');
  }
}

export type RebuildPlanDetailed = RebuildPlan & { complete: boolean };

/** 与 `armed-listing.ts` 同一回退(命令边界没传 `deps.piDirSet` 时读进程环境);两处必须一致,所以这里解析一次、显式传给 armed 与第二次列举 */
function piDirIsSet(): boolean {
  const e = pickProcessEnv(/^(PI_CODING_AGENT_DIR|KIT_RSI_PI_DIR_SET)$/);
  return e['PI_CODING_AGENT_DIR'] !== undefined || e['KIT_RSI_PI_DIR_SET'] === '1';
}

/** 经快照协议读 `projects.json`:缺失 = absent;过不了 schema = invalid(重建的正是这种情形,不阻断) */
async function readOldIndex(
  io: IoContext,
): Promise<{ status: 'ok'; index: RsiProjectIndex } | { status: 'absent' | 'invalid' }> {
  const v = await readVerified(io, ['projects.json']);
  if (v.status === 'busy') throw new RsiSnapshotBusyError();
  if (v.status === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  if (v.status === 'invalid') throw new RsiSnapshotError('snapshot_invalid');
  const bytes = v.status === 'ok' ? (v.files.get('projects.json') ?? null) : null;
  if (bytes === null) return { status: 'absent' };
  try {
    const p = RsiProjectIndexSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    return p.success ? { status: 'ok', index: p.data } : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

/**
 * 重建 = 重新认定:旧条目里同 key 同 path 的根,`(dev, ino)` 与本次观测不同(换卷、删后重建、云同步重建目录)时,就地改成观测值。
 * `updateIndex` 在常规 L0 里不会这样做(目录被换过 → 保持 U,不自愈);只有 `--rebuild-index` 是用户明确要求「按现状重新认定」的入口(R20-4.3)。
 * 只改 `(dev, ino)`,`first_seen` / `first_indexed_generation` 不动;`last_seen` 随后由 `updateIndex` 刷新。
 */
function reacknowledgeRoots(
  prev: RsiProjectIndex | null,
  observations: readonly IndexObservation[],
): RsiProjectIndex | null {
  if (prev === null) return null;
  const seen = new Map(observations.map((o) => [`${o.key}\0${o.path}`, o] as const));
  return {
    ...prev,
    entries: prev.entries.map((e) => ({
      ...e,
      roots: e.roots.map((r) => {
        const o = seen.get(`${e.key}\0${r.path}`);
        return o === undefined ? r : { ...r, dev: o.dev, ino: o.ino };
      }),
    })),
  };
}

export async function planRebuildIndex(
  io: IoContext,
  config: RsiConfigOn,
  deps?: L0Deps,
): Promise<RebuildPlanDetailed> {
  const now = (deps?.now ?? ((): Date => new Date()))();
  const salt = await readSaltFile(io.stateDir); // SaltError 原样抛
  if (salt.kind !== 'ok') throw new RebuildNoSaltError();
  const old = await readOldIndex(io);
  const trusted = old.status === 'ok' && old.index.salt_fp === salt.saltFp ? old.index : null;

  const limit = deps?.limits?.rebuildMaxFiles ?? RSI_REBUILD_MAX_FILES;
  const piSet = deps?.piDirSet ?? piDirIsSet();
  const armed = await listArmedDetailed(io, config, {
    ...deps,
    piDirSet: piSet,
    limits: { ...deps?.limits, armedMaxFiles: limit },
  });
  const limitsHit = new Set<RsiCounterCode>(armed.limitsHit);

  // 超出上限而没读头部的文件数(armed 只把它们并进 unknownSessions,这里要单列):只在触发上限时再列举一次来数
  let remainingFiles = 0;
  if (limitsHit.has('RSI_LIMIT_FILES')) {
    const home = io.hostEnv['HOME'] as string;
    const e = await enumerateSessionFiles(home, config, piSet, deps);
    remainingFiles = Math.max(0, e.files.length - limit);
  }
  let unknownSessions = Math.max(0, armed.unknownSessions - remainingFiles);

  const knownKeys = new Set((trusted?.entries ?? []).map((e) => e.key));
  const observations: IndexObservation[] = [];
  for (const row of armed.rows) {
    const key = projectKeyFor(salt.salt, row.path);
    let st;
    try {
      st = await stat(row.path);
    } catch {
      if (!knownKeys.has(key)) unknownSessions += row.sessions;
      continue;
    }
    observations.push({ key, path: row.path, dev: st.dev, ino: st.ino });
  }

  const counts = await recomputeSignalCounts(io, now); // 不读 counts.json:它损坏时重建索引不应被挡住
  // `updateIndex` 里新 key 的 `first_indexed_generation` = 提交后的 generation;返回的 `index.generation` 仍是旧值(提交侧 +1),两个值分开命名
  const nextGeneration = trusted === null ? 0 : trusted.generation + 1;
  const indexGeneration = trusted === null ? 0 : trusted.generation;
  const merged = updateIndex({
    prev: reacknowledgeRoots(trusted, observations),
    observations,
    perKey: counts.perKey,
    saltFp: salt.saltFp,
    generation: nextGeneration,
    today: now.toISOString().slice(0, 10),
  });
  if (merged.full) limitsHit.add('RSI_INDEX_FULL');
  const index: RsiProjectIndex = {
    ...merged.index,
    generation: indexGeneration,
  };

  const observedKeys = new Set(observations.map((o) => o.key));
  const inIndex = new Set(merged.index.entries.map((e) => e.key));
  return {
    index,
    keptFromOld: [...knownKeys].filter((k) => !observedKeys.has(k)).length,
    observed: [...observedKeys].filter((k) => inIndex.has(k)).length,
    filesRead: armed.filesRead,
    bytesRead: armed.bytesRead,
    remainingFiles,
    unknownSessions,
    limitsHit: [...limitsHit].sort(),
    complete: armed.complete,
  };
}

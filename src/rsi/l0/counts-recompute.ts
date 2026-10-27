/**
 * counts 的磁盘重算(R20-4.5,B4 方案 §3.5;B4-0 冻结签名,B4c1 实现):`per_key` / `unknown_keys_signals` 由流式读 `.state/signals/**` 与 `.state/sessions/**` 得到
 * (自己读,不 import `session-stats` / `state-store`);`signals_by_day` 按信号 `ts` 的 UTC 日、只保留最近 8 日;`staged` 只重算 `tainted`(lstat `TAINTED`)。
 * 每次提交都全量重算,不看本次是否有新增。`clusters` 由提交侧 `commit.ts` 重算(D13-A),不在这里。
 *
 * 口径(B4c1 订正,待并入契约):
 *  - `per_key[k].signals_total` = 信号库里 `project_key === k`(合法 `p_` 键)的行数;`sessions` = 会话计数库里该键的行数(`session_ref` 唯一,重复即库已损坏);
 *    只出现在会话计数库的键也有一条(`signals_total = 0`)。不合法形状的键(手动 collect 的 overlay 明文键等)不进 `per_key`,其信号并入 `unknown_keys_signals`。
 *  - `signals_by_day`:UTC 日窗口 = `now` 所在日及其前 7 日(共 8 日),窗口之外(含未来日)的信号只计入 `signals_total`,不进 by_day。
 *  - `per_key` **不做排除 / 索引过滤**:已排除项目、不在索引里的 key 的信号照常计入 `per_key`(排除与 P / X / U 是读侧现算,R20-4.6;读侧对索引外的 key 一律按 U,见 `rsi status`),
 *    所以 `config` 参数不参与重算。`sum(signals_by_day) ≤ signals_total`:窗口外(含未来日)的差额是预期的。
 *  - 日期一律先归一到 UTC(`new Date(ts).toISOString()`)再取日,带偏移的 ts(`+08:00` / `-11:00`)按 UTC 日归档。
 *  - 信号库 / 会话计数库的月文件经 `openStreamSafe`(句柄级:`O_NOFOLLOW`、普通文件、`nlink == 1`)流式读;链接 / 硬链接 / 非普通文件 / 坏行 / 缺字段 /
 *    非法时间戳 / 重复 `session_ref` → fail-closed `signal_store_corrupt`(与 B3c 的 `loadSigKeys` 同口径,不任选一条、不跳过)。
 *  - `staged`:取 `counts.json` 里**现有**每一项的 `run_id`,逐个核对 `.state/reflect/<run_id>/TAINTED` 是否在场(≤ 5000 次元数据读);**每次**都核对,不看本次新增了多少 taint。
 *    父目录链不是真实目录 → `state_dir_unsafe`;`TAINTED` 对象存在(任何类型)或无法确认 → 当作在场(与 `rsi status` 同口径,宁可当成被污染)。
 * 规划侧 / 只读:不写文件、不拿锁、不 import 写出口。读 `counts.json` 不走快照协议:写入方是临时文件 + rename,读到的总是完整的旧版或新版(只取 `staged[].run_id`,不用其余字段);
 * 无锁的规划方(`rebuild-plan`)只用 `recomputeSignalCounts`,不依赖 `counts.json` 是否完好。
 */
import * as path from 'node:path';
import {
  RSI_AGENT_IDS,
  RSI_SNAPSHOT_DYNAMIC_NAME_RE,
  RsiCountsSchema,
  RsiProjectKeySchema,
} from '../../contracts/rsi.js';
import type { IoContext } from '../../io/paths.js';
import {
  MAX_LINE_BYTES,
  lstat,
  openStreamSafe,
  readDir,
  readFileSafe,
  statDirSafe,
} from '../../io/read-fs.js';
import type { RsiConfigOn } from '../config.js';
import { JsonlStream } from '../jsonl-stream.js';
import { RSI_FILE_OWNER, rsiDirReadonly } from '../lock-read.js';
import { RsiSnapshotError } from '../snapshot-read.js';
import type { PerKeyCounts, RecomputedCounts } from './types.js';

const DAY_MS = 86_400_000;
const BY_DAY_WINDOW = 8;
const COUNTS_MAX_BYTES = 64 * 1024 * 1024;

const corrupt = (): RsiSnapshotError => new RsiSnapshotError('signal_store_corrupt');

async function realDirOrMissing(p: string): Promise<boolean> {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink() || !st.isDirectory()) throw corrupt();
    return true;
  } catch (e) {
    if (e instanceof RsiSnapshotError) throw e;
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw corrupt();
  }
}

/** 流式扫 `<root>/<agent>/*.jsonl` 的每一行;`onRecord` 返回 false = 该行不合规 → 整库按损坏处理 */
async function scanStore(
  kind: 'signals' | 'sessions',
  root: string,
  onRecord: (agent: string, rec: unknown) => boolean,
): Promise<void> {
  if (!(await realDirOrMissing(root))) return;
  for (const agent of RSI_AGENT_IDS) {
    const dir = path.join(root, agent);
    if (!(await realDirOrMissing(dir))) continue;
    let entries;
    try {
      entries = await readDir(dir);
    } catch {
      throw corrupt();
    }
    for (const f of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!RSI_SNAPSHOT_DYNAMIC_NAME_RE.test(`${kind}/${agent}/${f.name}`)) continue; // 月文件名只有契约里这一份判定
      if (!f.isFile || f.isSymbolicLink) throw corrupt();
      const s = await openStreamSafe(path.join(dir, f.name));
      if (s.kind === 'missing') continue;
      if (s.kind === 'unsafe') throw corrupt();
      const lines = new JsonlStream(MAX_LINE_BYTES, (rec) => onRecord(agent, rec));
      try {
        for await (const chunk of s.chunks()) lines.push(chunk);
        lines.end();
      } catch {
        throw corrupt();
      } finally {
        await s.close();
      }
    }
  }
}

interface Acc {
  signals: number;
  sessions: number;
  byDay: Map<string, number>;
}

/** `counts.json` 里现有的暂存 run(只取 run_id);缺失 = 空;不合规 → `counts_invalid`,不安全 → `state_dir_unsafe` */
async function currentStagedRunIds(io: IoContext): Promise<string[]> {
  const d = await rsiDirReadonly(io);
  if (d.kind === 'missing') return [];
  if (d.kind === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  const r = await readFileSafe(path.join(d.dir, 'counts.json'), {
    maxBytes: COUNTS_MAX_BYTES,
    owner: RSI_FILE_OWNER,
  });
  if (r.kind === 'missing') return [];
  if (r.kind === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  let parsed;
  try {
    parsed = RsiCountsSchema.safeParse(JSON.parse(r.bytes.toString('utf8')));
  } catch {
    throw new RsiSnapshotError('counts_invalid');
  }
  if (!parsed.success) throw new RsiSnapshotError('counts_invalid');
  return parsed.data.staged.map((s) => s.run_id); // schema 已限 ≤ RSI_COUNTS_MAX_STAGED,不在这里再截断(截断 = 静默丢 tainted 项)
}

/** `TAINTED` 是否在场:父目录链必须是真实目录(缺失 = 不在场、不安全 = fail-closed);对象本身用 lstat,不读内容 */
async function taintedPresent(stateDir: string, runId: string): Promise<boolean> {
  const reflect = path.join(stateDir, 'reflect');
  for (const dir of [reflect, path.join(reflect, runId)]) {
    const d = await statDirSafe(dir);
    if (d.kind === 'missing') return false;
    if (d.kind === 'unsafe') throw new RsiSnapshotError('state_dir_unsafe');
  }
  try {
    await lstat(path.join(reflect, runId, 'TAINTED'));
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT'; // 无法确认 = 当作在场
  }
}

/** `recomputeCounts` 的前两段(信号库 + 会话计数库),不读 `counts.json`、不看 `reflect/`:`rebuild-plan` 只要这部分,`counts.json` 损坏时索引重建不应被它挡住 */
export async function recomputeSignalCounts(
  io: IoContext,
  now: Date,
): Promise<Pick<RecomputedCounts, 'perKey' | 'unknownKeysSignals'>> {
  const today = now.toISOString().slice(0, 10);
  const oldest = new Date(now.getTime() - (BY_DAY_WINDOW - 1) * DAY_MS).toISOString().slice(0, 10);
  const acc = new Map<string, Acc>();
  const of = (key: string): Acc => {
    let a = acc.get(key);
    if (a === undefined) {
      a = { signals: 0, sessions: 0, byDay: new Map() };
      acc.set(key, a);
    }
    return a;
  };
  let unknownKeysSignals = 0;

  await scanStore('signals', path.join(io.stateDir, 'signals'), (_agent, o) => {
    const rec = o as { sig_id?: unknown; project_key?: unknown; ts?: unknown } | null;
    if (rec === null || typeof rec !== 'object') return false;
    if (typeof rec.sig_id !== 'string' || typeof rec.project_key !== 'string') return false;
    if (rec.project_key === '' || typeof rec.ts !== 'string') return false;
    const t = Date.parse(rec.ts);
    if (Number.isNaN(t)) return false;
    if (!RsiProjectKeySchema.safeParse(rec.project_key).success) {
      unknownKeysSignals++;
      return true;
    }
    const a = of(rec.project_key);
    a.signals++;
    const day = new Date(t).toISOString().slice(0, 10);
    if (day >= oldest && day <= today) a.byDay.set(day, (a.byDay.get(day) ?? 0) + 1);
    return true;
  });

  // 会话计数库按 agent 目录各自唯一(与写入方 `planSessionStats` 的查找范围一致:一个 session_ref 在一个 agent 目录里至多一行)
  const seenSessions = new Set<string>();
  await scanStore('sessions', path.join(io.stateDir, 'sessions'), (agent, o) => {
    const rec = o as { session_ref?: unknown; project_key?: unknown } | null;
    if (rec === null || typeof rec !== 'object') return false;
    if (typeof rec.session_ref !== 'string' || typeof rec.project_key !== 'string') return false;
    const id = `${agent}\0${rec.session_ref}`;
    if (seenSessions.has(id)) return false;
    seenSessions.add(id);
    // 非法形状的 key(手动 collect 的 overlay 明文键)没有「会话未知」计数,会话行按忽略处理;信号侧则并入 unknown_keys_signals
    if (RsiProjectKeySchema.safeParse(rec.project_key).success) of(rec.project_key).sessions++;
    return true;
  });

  const perKey: PerKeyCounts = {};
  for (const key of [...acc.keys()].sort()) {
    const a = acc.get(key) as Acc;
    const byDay: Record<string, number> = {};
    for (const d of [...a.byDay.keys()].sort()) byDay[d] = a.byDay.get(d) as number;
    perKey[key] = { signals_total: a.signals, sessions: a.sessions, signals_by_day: byDay };
  }
  return { perKey, unknownKeysSignals };
}

export async function recomputeCounts(
  io: IoContext,
  config: RsiConfigOn,
  now: Date,
): Promise<RecomputedCounts> {
  void config; // 与冻结签名一致;重算不依赖配置(归属 / 排除是读侧现算,R20-4.6)
  const { perKey, unknownKeysSignals } = await recomputeSignalCounts(io, now);
  const stagedTainted = new Map<string, boolean>();
  for (const runId of await currentStagedRunIds(io)) {
    stagedTainted.set(runId, await taintedPresent(io.stateDir, runId));
  }
  return { perKey, unknownKeysSignals, stagedTainted };
}

/**
 * 「要不要起一个 L0 worker」的共用闸(契约 R20-3.2.2 / R20-3.2.3 / R20-6.1 / R20-6.2;A3)。poke(钩子)与顺带调度(`agent=kit`)共用,
 * 入口闸(跳过条件、参数、TTY、命令白名单)由调用方先判。
 *
 * 判定顺序:配置(off / 停止采集 → 空)→ agent 在 `[rsi] agents` 里(kit 不查)→ 只读读 `state.json`(快照协议;busy / invalid / unsafe → 空)
 * → STOP 只 lstat → `rsiStateOf`(off / stopped / state 不可读 → 空)→ 熔断打开且未到半开 → 空 → L0 未到期 → 空 →
 * 启动预留(`createExclusive(.state/rsi/poke/<agent>-<窗口>)`,`EEXIST` → 空)→ 经零网络桥接 spawn → 无锁追加日志一行。
 *
 * **只有走到启动预留才写**(R20-3.2.3):预留标记 + `log.jsonl` 一行(建 `.state/rsi/poke/` 目录本身也是这一步的一部分);其余分支零写入。
 * 尽力预算:每一步之间查 `overBudget()`,超出即返回空操作;预留之后不再查(已占住窗口就把 spawn 做完,避免占窗不起 worker)。
 */
import * as path from 'node:path';
import {
  RSI_DIR_MODE,
  RSI_FILE_MODE,
  RsiLogLineSchema,
  type RsiAgentId,
} from '../../contracts/rsi.js';
import { canonicalJsonLine } from '../../io/canonical-json.js';
import { getRealHome, type WriteAudit } from '../../io/paths.js';
import { lstat } from '../../io/read-fs.js';
import { appendFile, createExclusive, mkdirp } from '../../io/safe-fs.js';
import { spawnRsiWorker, type RsiWorkerDeps } from '../../update/self-spawn.js';
import { buildRsiPolicy } from '../config.js';
import { rsiDirReadonly } from '../lock-read.js';
import { rsiDir } from '../rsi-dir.js';
import { readVerified } from '../snapshot-read.js';
import { loadRepoIdentity, parseRsiStateDoc, rsiStateOf } from '../state.js';
import { breakerView, l0Due, windowIndex } from './breaker.js';
import { openRsiIo, type OpenRsiIoDeps } from './open.js';

type Env = Readonly<Record<string, string | undefined>>;

export type SpawnGateResult =
  { kind: 'noop'; why: string } | { kind: 'spawned' } | { kind: 'spawn_failed'; why: string };

export interface SpawnGateInput {
  env: Env;
  /** 写审计钩子(测试;经 `openRsiIo` 进 IoContext) */
  writeAudit?: WriteAudit;
  agent: RsiAgentId | 'kit';
  trigger: 'poke' | 'kit';
}

export interface SpawnGateDeps {
  now?: () => Date;
  nowMs?: () => number;
  /** 超出尽力预算(缺省:永不) */
  overBudget?: () => boolean;
  open?: OpenRsiIoDeps;
  spawn?: RsiWorkerDeps;
}

async function stopPresent(io: Parameters<typeof rsiDirReadonly>[0]): Promise<boolean | 'unsafe'> {
  const d = await rsiDirReadonly(io);
  if (d.kind === 'unsafe') return 'unsafe';
  if (d.kind === 'missing') return false;
  try {
    await lstat(path.join(d.dir, 'STOP'));
    return true;
  } catch (e) {
    // 无法确认 = 当作在场(宁可当成已停止)
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? false : true;
  }
}

export async function trySpawnL0(
  input: SpawnGateInput,
  deps: SpawnGateDeps = {},
): Promise<SpawnGateResult> {
  const over = deps.overBudget ?? ((): boolean => false);
  const now = deps.now ?? ((): Date => new Date());
  const nowMs = deps.nowMs ?? ((): number => now().getTime());
  const noop = (why: string): SpawnGateResult => ({ kind: 'noop', why });

  const open = await openRsiIo(
    {
      argv: [],
      overlayPath: undefined,
      explicitRoot: undefined,
      env: input.env,
      ...(input.writeAudit !== undefined ? { writeAudit: input.writeAudit } : {}),
      stdout: () => undefined,
      stderr: () => undefined,
    },
    deps.open,
  );
  if (open.kind !== 'ready') return noop(open.kind);
  const { io, config } = open.ctx;
  if (config.block !== null) return noop('collect_blocked');
  if (input.agent !== 'kit' && !config.agents.includes(input.agent))
    return noop('agent_not_enabled');
  if (over()) return noop('budget');

  const v = await readVerified(io, ['state.json']);
  if (v.status === 'busy' || v.status === 'invalid' || v.status === 'unsafe') return noop(v.status);
  const doc = parseRsiStateDoc(v.status === 'ok' ? (v.files.get('state.json') ?? null) : null);
  if (doc.kind === 'invalid') return noop('state_invalid');
  const stop = await stopPresent(io);
  if (stop === 'unsafe') return noop('unsafe');
  if (over()) return noop('budget');
  const identity = await loadRepoIdentity(config, await buildRsiPolicy(config));
  const st = rsiStateOf({ config, stopPresent: stop, doc, identity });
  if (st.state === 'off' || st.state === 'stopped') return noop(st.state);
  if (st.stateInvalid) return noop('state_invalid');
  if (st.collectBlocked !== null) return noop('collect_blocked');
  const state = doc.kind === 'ok' || doc.kind === 'confirm_schema_invalid' ? doc.state : null;
  const t = nowMs();
  if (breakerView(state, t) === 'open') return noop('breaker_open');
  if (!l0Due(state, t)) return noop('not_due');
  if (over()) return noop('budget');

  // 启动预留(唯一的写入分支开始)
  const dir = await rsiDir(io);
  const pokeDir = path.join(dir, 'poke');
  await mkdirp(io, pokeDir, RSI_DIR_MODE);
  const marker = path.join(pokeDir, `${input.agent}-${windowIndex(t)}`);
  try {
    await createExclusive(
      io,
      marker,
      `${JSON.stringify({ at: now().toISOString() })}\n`,
      RSI_FILE_MODE,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return noop('reserved');
    throw e;
  }
  const r = spawnRsiWorker(
    { home: getRealHome(input.env), repo: config.repo, env: input.env },
    deps.spawn,
  );
  const res: SpawnGateResult = r.spawned
    ? { kind: 'spawned' }
    : { kind: 'spawn_failed', why: r.why };
  const line = canonicalJsonLine(
    RsiLogLineSchema.parse({
      at: now().toISOString(),
      trigger: input.trigger,
      ...(input.agent !== 'kit' ? { agent: input.agent } : {}),
      action: res.kind,
      code: res.kind === 'spawned' ? 'spawned' : `spawn_failed:${res.why}`,
    }),
  );
  try {
    await appendFile(io, path.join(dir, 'log.jsonl'), line, { mode: RSI_FILE_MODE });
  } catch {
    // 日志尽力
  }
  return res;
}

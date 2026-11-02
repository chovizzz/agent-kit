/**
 * ingest 的每日名额(docs/contracts.md R20-16.15 第 4 步;R20-A4;设计稿 §8a.4:尽力护栏,不是安全保证)。
 *
 * 按 UTC 日分文件 `.state/rsi/ingest-quota/<YYYY-MM-DD>.json`(日期取本次调用的 UTC 今天;不存在 = 当日零次):每个声明的 agent ≤ 2、全局 ≤ 4。
 * 读经 `readFileSafe`;写经同目录临时文件 → fsync → rename → fsync 目录,每个写出口之前 `assertHeld()`(调用方持 `rsi/lock`)。
 * 超额 → `limited`(调用方退出 4 `RSI_NOT_RUN reason=rate_limited`,不消费 digest)。**当日文件读不过或过不了 schema → 只封禁当日**(同样 `limited`),**不改写它**;次日自然使用新文件。
 * 每次成功预留后删除早于今天的名额文件(尽力,失败不影响结果)。名额**先于**消费 digest 持久化:两步之间崩溃只会多耗一次名额,不会少计。
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import {
  RSI_DIGEST_FILE_MAX_BYTES,
  RSI_DIR_MODE,
  RSI_FILE_MODE,
  RSI_INGEST_QUOTA_GLOBAL,
  RSI_INGEST_QUOTA_PER_AGENT,
  RsiIngestQuotaSchema,
  type RsiAgentId,
  type RsiIngestQuota,
} from '../contracts/rsi.js';
import { canonicalJson } from '../io/canonical-json.js';
import type { IoContext } from '../io/paths.js';
import { lstat, readDir, readFileSafe } from '../io/read-fs.js';
import { createExclusiveSynced, fsyncDir, mkdirp, remove, rename } from '../io/safe-fs.js';
import { RSI_FILE_OWNER, rsiDirReadonly } from './lock-read.js';
import type { RsiLockHandle } from './lock.js';
import { RsiLockError } from './lock-error.js';
import { assertOwnDirSafe } from './rsi-dir.js';

export interface QuotaDeps {
  hooks?: { point?(name: string): Promise<void> | void };
  randomHex?: (bytes: number) => string;
  /** 测试注入:期望的目录属主 uid(缺省当前进程 uid) */
  uid?: number;
}

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

async function gate(lock: RsiLockHandle, deps: QuotaDeps, name: string): Promise<void> {
  await deps.hooks?.point?.(name);
  await lock.assertHeld();
}

/**
 * `ingest-quota/` 目录(调用方持 `rsi/lock`):**每个写出口前 `assertHeld()`**,不经 `rsiDir()` 那种无复核的 mkdir / chmod。
 *  - 已存在:lstat 校验真实目录、属主 = 当前 uid(测试可注入 `deps.uid`)、无组 / 其他写位;确认不了 → fail-closed `state_dir_unsafe`(不指望 mkdirp 的 mode 修正已有目录);
 *  - 不存在:建 0700 → 重新 lstat 校验 → **fsync 父目录 `rsi/`**(新目录项先持久化)→ fsync 新目录;这一切都先于名额文件的写入,更先于 digest 的消费(unlink)。
 */
async function quotaDir(io: IoContext, lock: RsiLockHandle, deps: QuotaDeps): Promise<string> {
  await lock.assertHeld();
  const rsi = await rsiDirReadonly(io);
  if (rsi.kind !== 'ok') throw new RsiLockError('state_dir_unsafe');
  const dir = path.join(rsi.dir, 'ingest-quota');
  let st = await lstat(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw new RsiLockError('state_dir_unsafe');
  });
  if (st === undefined) {
    await gate(lock, deps, 'quota:mkdir');
    await mkdirp(io, dir, RSI_DIR_MODE);
    st = await lstat(dir).catch(() => {
      throw new RsiLockError('state_dir_unsafe');
    });
    assertOwnDirSafe(st, deps.uid);
    await gate(lock, deps, 'quota:fsync-parent');
    await fsyncDir(io, rsi.dir);
    await gate(lock, deps, 'quota:fsync-dir');
    await fsyncDir(io, dir);
    return dir;
  }
  assertOwnDirSafe(st, deps.uid);
  return dir;
}

export type QuotaOutcome = 'reserved' | 'limited';

export async function reserveIngestQuota(
  io: IoContext,
  lock: RsiLockHandle,
  agent: RsiAgentId,
  today: string,
  deps: QuotaDeps = {},
): Promise<QuotaOutcome> {
  const dir = await quotaDir(io, lock, deps);
  const file = path.join(dir, `${today}.json`);
  let cur: RsiIngestQuota = { schema_version: 1, total: 0, agents: {} };
  const r = await readFileSafe(file, {
    maxBytes: RSI_DIGEST_FILE_MAX_BYTES,
    owner: RSI_FILE_OWNER,
  });
  if (r.kind === 'unsafe') return 'limited';
  if (r.kind === 'ok') {
    let parsed;
    try {
      parsed = RsiIngestQuotaSchema.safeParse(JSON.parse(r.bytes.toString('utf8')));
    } catch {
      return 'limited';
    }
    if (!parsed.success) return 'limited';
    cur = parsed.data;
  }
  const mine = cur.agents[agent] ?? 0;
  if (cur.total + 1 > RSI_INGEST_QUOTA_GLOBAL || mine + 1 > RSI_INGEST_QUOTA_PER_AGENT) {
    return 'limited';
  }
  const next: RsiIngestQuota = {
    schema_version: 1,
    total: cur.total + 1,
    agents: { ...cur.agents, [agent]: mine + 1 },
  };
  const rnd = deps.randomHex ?? ((n: number): string => randomBytes(n).toString('hex'));
  const tmp = path.join(dir, `.tmp-${rnd(8)}`);
  await gate(lock, deps, 'quota:tmp');
  await createExclusiveSynced(io, tmp, canonicalJson(next), RSI_FILE_MODE);
  try {
    await gate(lock, deps, 'quota:rename');
    await rename(io, tmp, file);
  } catch (e) {
    // 异常清理也是写出口:已失锁则保留临时文件,保持原始错误
    try {
      await lock.assertHeld();
      await remove(io, tmp);
    } catch {
      // 尽力
    }
    throw e;
  }
  await fsyncDir(io, dir);
  // 尽力清理早于今天的名额文件;失败不影响结果
  try {
    for (const e of await readDir(dir)) {
      const m = DAY_FILE_RE.exec(e.name);
      if (m === null || (m[1] as string) >= today) continue;
      await gate(lock, deps, `quota:unlink:${e.name}`);
      await remove(io, path.join(dir, e.name));
    }
  } catch {
    // 尽力
  }
  return 'reserved';
}

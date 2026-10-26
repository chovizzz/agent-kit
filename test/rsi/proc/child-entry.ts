/**
 * A1 测试用子进程入口(由 test/rsi/proc/helper.ts 用 vite 打成单文件后以 node 运行)。
 * 参数:argv[2] = JSON `{op, ...}`;所有 IoContext 参数经 JSON 传入,不读 process.env。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { RsiLockError, acquireRsiLock } from '../../../src/rsi/lock.js';
import { createIoContext } from '../../../src/io/paths.js';
import { readText } from '../../../src/io/read-fs.js';
import { writeFile } from '../../../src/io/safe-fs.js';
import { loadSalt } from '../../../src/signals/state-store.js';

interface Job {
  op: 'hold' | 'try' | 'writer' | 'salt';
  cwd: string;
  tmp: string;
  state: string;
  id?: string;
  rounds?: number;
  startAt?: number;
  shared?: string;
}

const job = JSON.parse(process.argv[2] ?? '{}') as Job;
const io = createIoContext({
  cwd: job.cwd,
  env: { KIT_TMP: job.tmp, KIT_STATE_DIR: job.state, PATH: '/usr/bin:/bin' },
});
const out = (o: unknown): void => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
};

async function main(): Promise<void> {
  if (job.op === 'hold') {
    const lock = await acquireRsiLock(io);
    out({ held: true, pid: process.pid, nonce: lock.nonce });
    setInterval(() => undefined, 1000); // 一直持锁,等被外部杀
    return;
  }
  if (job.op === 'try') {
    try {
      const lock = await acquireRsiLock(io);
      out({ got: true });
      await lock.release();
    } catch (e) {
      out({ got: false, kind: e instanceof RsiLockError ? e.kind : 'other' });
    }
    return;
  }
  if (job.op === 'writer') {
    // 无锁就会丢更新的读-改-写:读全文 → 等一会 → 追加一行写回
    const shared = job.shared as string;
    for (let i = 0; i < (job.rounds ?? 1); i++) {
      for (;;) {
        let lock;
        try {
          lock = await acquireRsiLock(io);
        } catch (e) {
          if (e instanceof RsiLockError && (e.kind === 'locked' || e.kind === 'locked_over_ttl')) {
            await sleep(3);
            continue;
          }
          throw e;
        }
        try {
          let cur = '';
          try {
            cur = await readText(shared);
          } catch {
            cur = '';
          }
          await sleep(4);
          await lock.assertHeld();
          await writeFile(io, shared, `${cur}${job.id}:${i}\n`, { mode: 0o600 });
        } finally {
          await lock.release();
        }
        break;
      }
    }
    out({ done: true });
    return;
  }
  if (job.op === 'salt') {
    while (Date.now() < (job.startAt ?? 0)) await sleep(1);
    const r = await loadSalt(io, { create: true });
    out({ salt: r.salt });
  }
}

main().catch((e: unknown) => {
  out({ error: e instanceof Error ? e.message : 'x' });
  process.exitCode = 1;
});

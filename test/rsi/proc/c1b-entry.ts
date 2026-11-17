/**
 * C1b 真子进程入口(由 test/rsi/proc/c1b-helper.ts 用 vite 打成单文件后以 node 运行)。
 * 两个操作:
 *  - `hold_personal`:真取 `personal/lock` 并一直持有(等被外部 SIGKILL);
 *  - `worker`:跑真 `runWorker` + 生产装配 `assembleWorkerStage`(相位 / 能力经测试缝打开),并经 `writeAudit` 记录每一次写入口的调用;
 *    `crashBefore = k` 时,在**第 k 个写审计事件(`writeAudit` 回调)之前**对**自己**发 SIGKILL(真 kill -9:不跑 finally、不释放锁)。
 * 注意:审计事件是写函数的入口事件,不是「写完成」事件(如 rename 连续审计 rename.from / rename;durable 写还有 syncFile / fsyncDir 的入口事件),所以这里验的是「某个审计事件之前崩溃」,不是掉电持久性。
 * 崩溃钩子只存在于本测试入口,不进生产代码(生产 / dist 不带任何环境变量驱动的崩溃点)。
 */
import * as path from 'node:path';
import { RSI_ASSEMBLY_CAPS } from '../../../src/contracts/rsi-phase-caps.js';
import { createRsiIoContext } from '../../../src/rsi/io.js';
import { assembleWorkerStage } from '../../../src/rsi/assemble-worker.js';
import { acquirePersonalLock } from '../../../src/rsi/personal/personal-lock.js';
import { personalHome } from '../../../src/rsi/personal/home-state.js';
import { runWorker, type RsiWorkerRunDeps } from '../../../src/rsi/worker.js';

interface Job {
  op: 'hold_personal' | 'worker';
  repo: string;
  cwd: string;
  home: string;
  env: Record<string, string>;
  nowMs: number;
  /** recover 写点抛 EIO(造「恢复失败 → 兜底」) */
  failRecover?: boolean;
  /** 在第 index 次写入口调用之前自杀 */
  crashBefore?: number;
}

const job = JSON.parse(process.argv[2] ?? '{}') as Job;
const out = (o: unknown): void => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
};

function dieNow(): never {
  process.kill(process.pid, 'SIGKILL');
  // SIGKILL 的投递可能晚于本线程的下几条指令:阻塞住,保证被杀时不再多写任何东西
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  throw new Error('unreachable');
}

async function main(): Promise<void> {
  if (job.op === 'hold_personal') {
    const io = createRsiIoContext({ repo: job.repo, env: job.env, cwd: job.cwd });
    const lock = await acquirePersonalLock(personalHome(io, job.home));
    out({ held: true, pid: process.pid, nonce: lock.nonce });
    setInterval(() => undefined, 1000);
    return;
  }
  const trace: string[] = [];
  const writeAudit = (op: string, p: string): void => {
    if (job.crashBefore !== undefined && trace.length === job.crashBefore) dieNow();
    trace.push(`${op} ${path.basename(p)}`);
  };
  const deps: RsiWorkerRunDeps = {
    env: job.env,
    writeAudit,
    now: () => new Date(job.nowMs),
    nowMs: () => job.nowMs,
    personal: assembleWorkerStage({ phase: 1, wired: new Set<string>(RSI_ASSEMBLY_CAPS) }),
    ...(job.failRecover === true
      ? {
          run: {
            beforeWrite: (op: string) =>
              op === 'recover'
                ? Promise.reject(Object.assign(new Error('eio'), { code: 'EIO' }))
                : Promise.resolve(),
          },
        }
      : {}),
  };
  const result = await runWorker(deps);
  out({ done: true, result, trace });
}

main().catch((e: unknown) => {
  out({ error: e instanceof Error ? e.message : String(e) });
  process.exitCode = 1;
});

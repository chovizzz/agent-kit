/**
 * B5e「被中断」场景的子进程入口:真实进程里经命令函数跑一条干跑命令(`tick` 或 `projects --rebuild-index`),
 * 在读阶段的第一个头部读取 / 目录列举 `beforeStep` 里**打印一行 READY 并永远挂起**,等父进程发 SIGTERM。
 * 由 test/rsi/proc/hang-helper.ts 用 vite 打成单文件后以 node 运行;参数 argv[2] = JSON `{kind, argv, env, cwd}`;不读 process.env。
 */
import { runProjects } from '../../../src/rsi/projects.js';
import { runTick } from '../../../src/rsi/tick.js';
import type { RsiEarlyContext } from '../../../src/rsi/types.js';

interface Job {
  kind: 'tick' | 'rebuild';
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

const job = JSON.parse(process.argv[2] ?? '{}') as Job;
let hung = false;
const beforeStep = async (step: string): Promise<void> => {
  if (hung || (step !== 'head' && step !== 'readdir')) return;
  hung = true;
  // 未决 Promise 不是事件循环的活跃句柄:没有保活的话,READY 写完后 Node 会因「未完成的顶层 await」自行退出(码 13),
  // 父进程发 SIGTERM 之前就退出了——测试只会碰巧通过。用一个被引用的定时器保活,直到被信号终止
  setInterval(() => undefined, 1000);
  process.stdout.write('READY\n');
  await new Promise<never>(() => undefined);
};
const ctx: RsiEarlyContext = {
  argv: job.argv,
  overlayPath: undefined,
  explicitRoot: undefined,
  env: job.env,
  cwd: job.cwd,
  stdout: (t) => process.stdout.write(`OUT ${JSON.stringify(t)}\n`),
  stderr: (t) => process.stdout.write(`ERR ${JSON.stringify(t)}\n`),
};
const code =
  job.kind === 'tick'
    ? await runTick(ctx, { run: { l0: { beforeStep } } })
    : await runProjects(ctx, { l0: { beforeStep } });
process.stdout.write(`DONE ${code}\n`);

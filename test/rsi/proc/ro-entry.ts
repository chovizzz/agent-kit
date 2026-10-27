/**
 * B3a 测试用子进程入口:在真实子进程里经 `main()` 跑一条 `agent-kit` 命令,把 `{code, out, err}` 以 JSON 打到 stdout。
 * 由 test/rsi/proc/ro-helper.ts 用 vite 打成单文件后以 node 运行。参数 argv[2] = JSON `{argv, env, cwd}`;不读 process.env。
 */
import { main } from '../../../src/cli.js';

interface Job {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

const job = JSON.parse(process.argv[2] ?? '{}') as Job;
let out = '';
let err = '';
const code = await main(job.argv, {
  env: job.env,
  cwd: job.cwd,
  stdout: (t) => (out += t),
  stderr: (t) => (err += t),
});
process.stdout.write(`${JSON.stringify({ code, out, err })}\n`);

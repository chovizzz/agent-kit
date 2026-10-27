/**
 * B5b 测试用子进程入口:在真实子进程里经 `main()` 跑 `agent-kit rsi confirm`,注入 `isTty` 与脚本化的 `readLine`(`null` = EOF);
 * 可选 `onPrompt`:在读到输入之前先改一个文件(演练「等待输入期间改配置」,写入走独立的宽写入根上下文,不受 `KIT_WRITE_ROOTS` 影响)。
 * 由 test/rsi/proc/confirm-helper.ts 用 vite 打成单文件后以 node 运行;参数 argv[2] = JSON;不读 process.env。
 */
import { main } from '../../../src/cli.js';
import { createIoContext } from '../../../src/io/paths.js';
import { writeFile } from '../../../src/io/safe-fs.js';

interface Job {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  tty: boolean;
  lines: (string | null)[];
  onPrompt?: { dir: string; file: string; content: string };
}

const job = JSON.parse(process.argv[2] ?? '{}') as Job;
const lines = [...job.lines];
let out = '';
let err = '';
const code = await main(job.argv, {
  env: job.env,
  cwd: job.cwd,
  stdout: (t) => (out += t),
  stderr: (t) => (err += t),
  isTty: job.tty,
  readLine: async () => {
    if (job.onPrompt !== undefined) {
      const ctx = createIoContext({ env: { KIT_TMP: job.onPrompt.dir, PATH: '/usr/bin:/bin' } });
      await writeFile(ctx, job.onPrompt.file, job.onPrompt.content, { mode: 0o600 });
    }
    const l = lines.shift();
    return l === null ? undefined : l;
  },
});
process.stdout.write(`${JSON.stringify({ code, out, err })}\n`);

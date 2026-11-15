/**
 * 装配块 A 段测试用子进程入口:在真实子进程里跑 `runAsmAJob`,把结果以 JSON 打到 stdout。
 * 由 test/rsi/proc/asm-a-helper.ts 用 vite 打成单文件后以 node 运行。参数 argv[2] = JSON 作业;不读 process.env。
 */
import { runAsmAJob, type AsmAJob } from './asm-a-job.js';

const job = JSON.parse(process.argv[2] ?? '{}') as AsmAJob;
const result = await runAsmAJob(job);
process.stdout.write(`${JSON.stringify(result)}\n`);

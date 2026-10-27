/**
 * B4c1 测试用子进程入口:在真实子进程里(`KIT_WRITE_ROOTS` 为空)跑规划侧服务 `planRebuildIndex` 与 `recomputeCounts`,把结果与「写入探针被拒」以 JSON 打到 stdout。
 * 由 test/rsi/proc/l0plan-helper.ts 用 vite 打成单文件后以 node 运行。参数 argv[2] = JSON `{repo, cwd, env, now, probePath}`;不读 process.env。
 */
import * as path from 'node:path';
import { writeFile } from '../../../src/io/safe-fs.js';
import { loadRsiConfig } from '../../../src/rsi/config.js';
import { createRsiIoContext } from '../../../src/rsi/io.js';
import { recomputeCounts } from '../../../src/rsi/l0/counts-recompute.js';
import { planRebuildIndex } from '../../../src/rsi/l0/rebuild-plan.js';

interface Job {
  repo: string;
  cwd: string;
  env: Record<string, string>;
  now: string;
  probePath: string;
}

const job = JSON.parse(process.argv[2] ?? '{}') as Job;
const config = await loadRsiConfig({ env: job.env });
if (config.status !== 'on') throw new Error(`rsi config off: ${config.reason}`);
const io = createRsiIoContext({ repo: job.repo, env: job.env, cwd: job.cwd });
const now = new Date(job.now);
const plan = await planRebuildIndex(io, config, { now: () => now, piDirSet: false });
const counts = await recomputeCounts(io, config, now);
let probeDenied = false;
try {
  await writeFile(io, path.join(job.probePath), 'x');
} catch (e) {
  probeDenied = (e as { code?: string }).code === 'IO_WRITE_DENIED';
}
process.stdout.write(
  `${JSON.stringify({ plan, perKey: counts.perKey, unknown: counts.unknownKeysSignals, probeDenied })}\n`,
);

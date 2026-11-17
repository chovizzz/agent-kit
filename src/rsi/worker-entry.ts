/**
 * 后台 worker 的生产入口装配(C1b):真 `runWorker` + 个人步装配 `assembleWorkerStage`。
 *
 * 为什么单列一个文件而不放在 `hook-entry.ts`:装配带进写出口 `io/home-fs.ts`(个人锁 / 个人状态),而 D-AU 不变量要求钩子入口
 * `hook-entry.ts` 的闭包(含 `import type`、含经动态 import 到 self-spawn 的路径)不含任何写出口。因此 hook-entry 只持有一个可注入的
 * 「worker 运行器」(缺省 = 不带个人步的 `runWorker`),生产运行器由根入口 `cli.ts` / `src/cli.ts`(闭包本来就含写出口)经动态
 * `import()` 本文件后注入——依赖倒置:钩子入口不认识装配,装配在部署组装处接上。
 */
import { assembleWorkerStage, bindWorkerPersonal } from './assemble-worker.js';
import { runWorker } from './worker.js';

type Env = Record<string, string | undefined>;

/** 个人步的生产装配:相位 < V1a 或能力缺项时 `eligible()` 为假,worker 不进 P(与未装配等价) */
export async function runAssembledWorker(env: Env): Promise<void> {
  await runWorker({ env, personal: bindWorkerPersonal(assembleWorkerStage()) });
}

/**
 * 装配块 A 段「空写入根」真子进程支撑:把 asm-a-entry.ts 用 vite 打成单文件(含 zod / smol-toml / yaml,不依赖 .ts 加载器),再用 node 跑。
 * 产物放在调用方给的临时目录(KIT_TMP 之内)。子进程环境只有作业里给的变量(`PATH` 固定为系统目录)。
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { build } from 'vite';
import { REPO_ROOT } from '../../helpers/tmp.js';
import type { AsmAJob, AsmAResult } from './asm-a-job.js';

let built: string | undefined;

export async function buildAsmAChild(outDir: string): Promise<string> {
  if (built !== undefined) return built;
  await build({
    configFile: false,
    logLevel: 'silent',
    root: REPO_ROOT,
    ssr: { noExternal: true },
    build: {
      ssr: path.join(REPO_ROOT, 'test/rsi/proc/asm-a-entry.ts'),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node22',
      rollupOptions: { output: { format: 'es', entryFileNames: 'rsi-asm-a.mjs' } },
    },
  });
  built = path.join(outDir, 'rsi-asm-a.mjs');
  return built;
}

export function runAsmAChild(script: string, job: AsmAJob): AsmAResult {
  const r = spawnSync(process.execPath, [script, JSON.stringify(job)], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`child failed: ${r.status} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop() as string) as AsmAResult;
}

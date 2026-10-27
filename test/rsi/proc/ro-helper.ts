/**
 * B3a 零写入第二层的真子进程支撑:把 ro-entry.ts 用 vite 打成单文件(含 zod / smol-toml,不依赖 .ts 加载器),再用 node 跑。
 * 产物放在调用方给的临时目录(KIT_TMP 之内)。
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { build } from 'vite';
import { REPO_ROOT } from '../../helpers/tmp.js';

let built: string | undefined;

export async function buildRoChild(outDir: string): Promise<string> {
  if (built !== undefined) return built;
  await build({
    configFile: false,
    logLevel: 'silent',
    root: REPO_ROOT,
    ssr: { noExternal: true },
    build: {
      ssr: path.join(REPO_ROOT, 'test/rsi/proc/ro-entry.ts'),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node22',
      rollupOptions: { output: { format: 'es', entryFileNames: 'rsi-ro.mjs' } },
    },
  });
  built = path.join(outDir, 'rsi-ro.mjs');
  return built;
}

export interface ChildOut {
  code: number;
  out: string;
  err: string;
}

/** 子进程环境只有 job 里给的变量(`PATH` 除外也由 job 给) */
export function runRoChild(
  script: string,
  job: { argv: string[]; env: Record<string, string>; cwd: string },
): ChildOut {
  const r = spawnSync(process.execPath, [script, JSON.stringify(job)], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`child failed: ${r.status} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop() as string) as ChildOut;
}

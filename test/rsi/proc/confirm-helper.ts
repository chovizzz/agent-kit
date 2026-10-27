/**
 * B5b 子进程层的支撑:把 confirm-entry.ts 用 vite 打成单文件(含 zod / smol-toml),再用 node 跑。产物放在调用方给的临时目录(KIT_TMP 之内)。
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { build } from 'vite';
import { REPO_ROOT } from '../../helpers/tmp.js';

let built: string | undefined;

export async function buildConfirmChild(outDir: string): Promise<string> {
  if (built !== undefined) return built;
  await build({
    configFile: false,
    logLevel: 'silent',
    root: REPO_ROOT,
    ssr: { noExternal: true },
    build: {
      ssr: path.join(REPO_ROOT, 'test/rsi/proc/confirm-entry.ts'),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node22',
      rollupOptions: { output: { format: 'es', entryFileNames: 'rsi-confirm.mjs' } },
    },
  });
  built = path.join(outDir, 'rsi-confirm.mjs');
  return built;
}

export interface ChildOut {
  code: number;
  out: string;
  err: string;
}

export interface ConfirmJob {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  tty: boolean;
  lines: (string | null)[];
  onPrompt?: { dir: string; file: string; content: string };
}

/** 子进程环境只有 job 里给的变量(`PATH` 除外也由 job 给) */
export function runConfirmChild(script: string, job: ConfirmJob): ChildOut {
  const r = spawnSync(process.execPath, [script, JSON.stringify(job)], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`child failed: ${r.status} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop() as string) as ChildOut;
}

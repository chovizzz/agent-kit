/**
 * A1 测试的真子进程支撑:把 child-entry.ts 用 vite 打成单文件(含 zod、不依赖 .ts 加载器),再用 node 跑。
 * 全部产物放在调用方给的临时目录(KIT_TMP,不在 HOME 内)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { build } from 'vite';
import { REPO_ROOT } from '../../helpers/tmp.js';

export interface ChildJob {
  op: 'hold' | 'try' | 'writer' | 'salt';
  tmp: string;
  state: string;
  id?: string;
  rounds?: number;
  startAt?: number;
  shared?: string;
}

let builtPath: string | undefined;

export async function buildChild(outDir: string): Promise<string> {
  if (builtPath !== undefined) return builtPath;
  await build({
    configFile: false,
    logLevel: 'silent',
    root: REPO_ROOT,
    ssr: { noExternal: true },
    build: {
      ssr: path.join(REPO_ROOT, 'test/rsi/proc/child-entry.ts'),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node22',
      rollupOptions: { output: { format: 'es', entryFileNames: 'rsi-child.mjs' } },
    },
  });
  builtPath = path.join(outDir, 'rsi-child.mjs');
  return builtPath;
}

export interface Running {
  child: ChildProcess;
  lines: Promise<string[]>;
  exited: Promise<number | null>;
  /** 等到 stdout 出现至少一行 */
  firstLine(): Promise<string>;
}

export function startChild(script: string, job: ChildJob): Running {
  const child = spawn(process.execPath, [script, JSON.stringify({ ...job, cwd: REPO_ROOT })], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin' },
  });
  let buf = '';
  const all: string[] = [];
  let firstResolve: (s: string) => void = () => undefined;
  const first = new Promise<string>((r) => (firstResolve = r));
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      all.push(line);
      firstResolve(line);
    }
  });
  const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  return {
    child,
    exited,
    lines: exited.then(() => all),
    firstLine: () => Promise.race([first, exited.then(() => all[0] ?? '')]),
  };
}

export async function runChild(script: string, job: ChildJob): Promise<unknown[]> {
  const r = startChild(script, job);
  const lines = await r.lines;
  return lines.map((l) => JSON.parse(l) as unknown);
}

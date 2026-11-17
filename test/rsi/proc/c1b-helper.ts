/**
 * C1b 真子进程支撑:把 c1b-entry.ts 用 vite 打成单文件(含全部依赖,不依赖 .ts 加载器),再用 node 跑。
 * 子进程环境只有作业给的变量(`PATH` 固定为系统目录)。只杀自己起的子进程(按 pid)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { build } from 'vite';
import { REPO_ROOT } from '../../helpers/tmp.js';

export interface C1bJob {
  op: 'hold_personal' | 'worker';
  repo: string;
  cwd: string;
  home: string;
  env: Record<string, string>;
  nowMs: number;
  failRecover?: boolean;
  crashBefore?: number;
}

export interface C1bDone {
  done: true;
  result: { kind: string; outcome?: string; recorded?: boolean; why?: string };
  trace: string[];
}

let built: string | undefined;

export async function buildC1bChild(outDir: string): Promise<string> {
  if (built !== undefined) return built;
  await build({
    configFile: false,
    logLevel: 'silent',
    root: REPO_ROOT,
    ssr: { noExternal: true },
    build: {
      ssr: path.join(REPO_ROOT, 'test/rsi/proc/c1b-entry.ts'),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node22',
      rollupOptions: { output: { format: 'es', entryFileNames: 'rsi-c1b.mjs' } },
    },
  });
  built = path.join(outDir, 'rsi-c1b.mjs');
  return built;
}

export interface RunningC1b {
  child: ChildProcess;
  /** 等到 stdout 出现至少一行(子进程已退出则返回已有的第一行或空串) */
  firstLine(): Promise<string>;
  /** 等退出:code / signal / 全部 stdout 行 / stderr */
  exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    lines: string[];
    err: string;
  }>;
}

export function startC1b(script: string, job: C1bJob, timeoutMs = 120_000): RunningC1b {
  const child = spawn(process.execPath, [script, JSON.stringify(job)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', ...job.env },
  });
  let buf = '';
  let err = '';
  const lines: string[] = [];
  let firstResolve: (s: string) => void = () => undefined;
  const first = new Promise<string>((r) => (firstResolve = r));
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      firstResolve(line);
    }
  });
  child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')));
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    lines: string[];
    err: string;
  }>((r) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs); // 兜底:只杀自己起的这一个
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      r({ code, signal, lines, err });
    });
  });
  return {
    child,
    exited,
    firstLine: () => Promise.race([first, exited.then(() => lines[0] ?? '')]),
  };
}

/** 跑到退出;返回退出信息与解析出的 `done` 行(被杀则为 undefined) */
export async function runC1b(
  script: string,
  job: C1bJob,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  err: string;
  done: C1bDone | undefined;
}> {
  const r = await startC1b(script, job).exited;
  const doneLine = r.lines.find((l) => l.startsWith('{"done":true'));
  return {
    code: r.code,
    signal: r.signal,
    err: r.err,
    done: doneLine === undefined ? undefined : (JSON.parse(doneLine) as C1bDone),
  };
}

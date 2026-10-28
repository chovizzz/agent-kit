/**
 * B3a 零写入第二层的真子进程支撑:把 ro-entry.ts 用 vite 打成单文件(含 zod / smol-toml,不依赖 .ts 加载器),再用 node 跑。
 * 产物放在调用方给的临时目录(KIT_TMP 之内)。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
  job: {
    argv: string[];
    env: Record<string, string>;
    cwd: string;
    isTty?: boolean;
    line?: string;
  },
): ChildOut {
  const r = spawnSync(process.execPath, [script, JSON.stringify(job)], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`child failed: ${r.status} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop() as string) as ChildOut;
}

// ---- B5e「被中断」场景:hang-entry 在读阶段第一个 beforeStep 里打印 READY 并挂起,等父进程发 SIGTERM(握手靠 READY,不靠 sleep)----
let builtHang: string | undefined;

export async function buildHangChild(outDir: string): Promise<string> {
  if (builtHang !== undefined) return builtHang;
  await build({
    configFile: false,
    logLevel: 'silent',
    root: REPO_ROOT,
    ssr: { noExternal: true },
    build: {
      ssr: path.join(REPO_ROOT, 'test/rsi/proc/hang-entry.ts'),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node22',
      rollupOptions: { output: { format: 'es', entryFileNames: 'rsi-hang.mjs' } },
    },
  });
  builtHang = path.join(outDir, 'rsi-hang.mjs');
  return builtHang;
}

export interface Hung {
  child: ChildProcess;
  /** 子进程的全部 stdout 行(退出后) */
  lines: Promise<string[]>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** 起子进程并等到它停在 beforeStep(打印 READY);子进程在此之前就退出会 reject */
export async function startHang(
  script: string,
  job: { kind: 'tick' | 'rebuild'; argv: string[]; env: Record<string, string>; cwd: string },
): Promise<Hung> {
  const child = spawn(process.execPath, [script, JSON.stringify(job)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin' },
  });
  const all: string[] = [];
  let buf = '';
  let ready: () => void = () => undefined;
  const readyP = new Promise<void>((r) => (ready = r));
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      all.push(line);
      if (line === 'READY') ready();
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
    child.on('close', (code, signal) => r({ code, signal })),
  );
  const early = exited.then((e) => {
    throw new Error(`hang child exited before READY: ${JSON.stringify(e)} ${all.join('|')}`);
  });
  // READY 超时(30s)与任何异常:杀掉自己起的这个子进程(按 pid)再抛,不留孤儿
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error('hang child: READY timeout')), 30_000);
  });
  try {
    await Promise.race([readyP, early, timeout]);
  } catch (e) {
    child.kill('SIGKILL');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return { child, exited, lines: exited.then(() => all) };
}

import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, expect } from 'vitest';
import * as path from 'node:path';
import type { IoContext } from '../../src/io/paths.js';
import * as safe from '../../src/io/safe-fs.js';
import { homeSnapshot } from '../signals/helpers.js';
import { GIT_NO_AUTO_ARGS, GIT_NO_AUTO_CONFIG } from '../helpers/git-quiet.js';
import { makeTempDir, REPO_ROOT, wideCtx } from '../helpers/tmp.js';

export { REPO_ROOT };
export const ACCEPT = path.join(REPO_ROOT, 'ops', 'accept');
export const LIB = path.join(ACCEPT, 'lib');
export const ENTRY = path.join(REPO_ROOT, 'ops', 'accept-p0.sh');
export const REAL_CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

/** 子进程 PATH:当前 node 所在目录 + 常见系统目录。 */
export const SAFE_PATH = `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 跑 ops/accept 下的脚本(经 bash)。env 是完整白名单:没有真实 HOME;KIT_TMP 必填(写入只落在它里面)。
 */
export function runScript(
  script: string,
  args: string[],
  env: Record<string, string>,
  cwd: string = REPO_ROOT,
): Run {
  const r = spawnSync('bash', [path.join(ACCEPT, script), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: SAFE_PATH, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function runEntry(args: string[], env: Record<string, string>): Run {
  const r = spawnSync('bash', [ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: SAFE_PATH, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 在一个子进程里调用 ops/accept/lib/<lib>.mjs 的导出函数:cases 里每项是一组参数,返回结果数组(JSON 往返)。 */
export function callLib(lib: string, fn: string, cases: unknown[][]): unknown[] {
  const code = `
    const m = await import(${JSON.stringify(path.join(LIB, lib))});
    const cases = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify(cases.map((a) => m[${JSON.stringify(fn)}](...a))));
  `;
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code, JSON.stringify(cases)],
    {
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: SAFE_PATH },
    },
  );
  if (r.status !== 0) throw new Error(`callLib ${lib}.${fn} 失败:${r.stderr}`);
  return JSON.parse(r.stdout) as unknown[];
}

/** 在子进程里对 lib 模块求值一个函数表达式(字符串),返回 JSON 化的结果。用于需要 new 类等不能直接 callLib 的场景。 */
export function evalLib(lib: string, fnExpr: string): unknown {
  const code = `
    const m = await import(${JSON.stringify(path.join(LIB, lib))});
    const f = (${fnExpr});
    process.stdout.write(JSON.stringify(await f(m)));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: SAFE_PATH },
  });
  if (r.status !== 0) throw new Error(`evalLib ${lib} 失败:${r.stderr}`);
  return JSON.parse(r.stdout);
}

export interface Fx {
  ctx: IoContext;
  dir: string;
  /** 临时"仓库根" */
  root: string;
  /** KIT_TMP(与 root 同级,不是它的祖先之一以外的东西) */
  kit: string;
  put(rel: string, text: string, mode?: number): Promise<string>;
  env(extra?: Record<string, string>): Record<string, string>;
}

/** 唯一临时目录(realpath)下的 root/ 与 kit/。 */
export async function makeFx(prefix: string): Promise<Fx> {
  const { dir } = await makeTempDir(prefix);
  const ctx = wideCtx(dir);
  const root = path.join(dir, 'root');
  const kit = path.join(dir, 'kit');
  await safe.mkdirp(ctx, root);
  await safe.mkdirp(ctx, kit);
  return {
    ctx,
    dir,
    root,
    kit,
    async put(rel, text, mode) {
      const f = path.join(root, rel);
      await safe.mkdirp(ctx, path.dirname(f));
      await safe.writeFile(ctx, f, text);
      if (mode !== undefined) await safe.chmod(ctx, f, mode);
      return f;
    },
    env: (extra = {}) => ({ KIT_TMP: kit, ...extra }),
  };
}

/** 每个测试文件调用一次:真实 HOME 顶层快照在整个文件前后必须不变。 */
export function guardRealHome(): void {
  let before = '';
  beforeAll(async () => {
    before = await homeSnapshot();
  });
  afterAll(async () => {
    expect(await homeSnapshot()).toBe(before);
  });
}

/** 把 text 作为可执行 node 脚本写进 root/rel(带 shebang)。 */
export async function putNodeScript(fx: Fx, rel: string, body: string): Promise<string> {
  return fx.put(rel, `#!/usr/bin/env node\n${body}\n`, 0o755);
}

/** git 环境卫生(contracts §4.4):测试里起 git 一律这样。 */
export function gitEnv(home: string): Record<string, string> {
  return {
    PATH: SAFE_PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

export function git(cwd: string, home: string, args: string[]): Run {
  const r = spawnSync(
    'git',
    [
      '-c',
      'user.name=kit-test',
      '-c',
      'user.email=kit-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...GIT_NO_AUTO_ARGS,
      ...args,
    ],
    { cwd, encoding: 'utf8', env: gitEnv(home) },
  );
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 在 fx.root 里 git init + 全部提交;返回 HEAD。 */
export async function commitAll(fx: Fx): Promise<string> {
  const home = path.join(fx.dir, 'githome');
  await safe.mkdirp(fx.ctx, home);
  await fx.put('.fixture-keep', 'x\n'); // 保证至少有一个可提交的文件
  git(fx.root, home, ['init', '-q']);
  for (const [k, v] of GIT_NO_AUTO_CONFIG) git(fx.root, home, ['config', k, v]);
  git(fx.root, home, ['add', '-A']);
  const c = git(fx.root, home, ['commit', '-q', '-m', 'fixture']);
  if (c.status !== 0) throw new Error(`git commit 失败:${c.stderr}`);
  return git(fx.root, home, ['rev-parse', 'HEAD']).stdout.trim();
}

/** 在 fx.dir(root 之外)写一个可执行 node 脚本,返回绝对路径。用于假 CLI / 假 pnpm / 假 vitest。 */
export async function putOutside(fx: Fx, name: string, body: string): Promise<string> {
  const f = path.join(fx.dir, name);
  await safe.mkdirp(fx.ctx, path.dirname(f));
  await safe.writeFile(fx.ctx, f, `#!/usr/bin/env node\n${body}\n`);
  await safe.chmod(fx.ctx, f, 0o755);
  return f;
}

/**
 * 假 vitest:把 <同目录>/fake-vitest.json 原样写到 --outputFile=…(若同目录有 no-output 标记文件则什么都不写)。
 * 返回它的绝对路径,给脚本的 --vitest-bin 用。
 */
export async function putFakeVitest(fx: Fx, result: unknown | null, exitCode = 0): Promise<string> {
  const dir = path.join(fx.dir, 'fake-vitest');
  await safe.mkdirp(fx.ctx, dir);
  const jsonFile = path.join(dir, 'fake-vitest.json');
  if (result !== null) await safe.writeFile(fx.ctx, jsonFile, JSON.stringify(result));
  else await safe.remove(fx.ctx, jsonFile).catch(() => undefined);
  return putOutside(
    fx,
    'fake-vitest/vitest',
    `import * as fs from 'node:fs'; import * as path from 'node:path';
const out = process.argv.find((a) => a.startsWith('--outputFile='));
const src = path.join(path.dirname(new URL(import.meta.url).pathname), 'fake-vitest.json');
if (out && fs.existsSync(src)) fs.writeFileSync(out.slice('--outputFile='.length), fs.readFileSync(src));
process.exit(${exitCode});`,
  );
}

/** 一份通过的 vitest JSON;files 给出 {相对 root 的文件名 => 标题数组}。 */
export function vitestJson(
  root: string,
  files: Record<string, string[]>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const results = Object.entries(files).map(([f, titles]) => ({
    name: path.join(root, f),
    status: 'passed',
    assertionResults: titles.map((t) => ({ title: t, fullName: t, status: 'passed' })),
  }));
  const n = results.reduce((a, r) => a + r.assertionResults.length, 0);
  return {
    numTotalTests: n,
    numPassedTests: n,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    success: true,
    testResults: results,
    ...extra,
  };
}

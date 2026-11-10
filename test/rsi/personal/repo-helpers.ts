/**
 * W2 私有仓库测试的共用夹具:**假 HOME**(KIT_TMP 之内;macOS 的 /var → /private/var 软链由 makeTempDir 的 realpath 消化)、真 git、真 home-fs。
 * 所有写都落在临时目录;真实 HOME 不被碰(个别用例用 homeSnapshot 前后断言)。测试里的 git 一律经 runSync(src/io/exec.ts),不用 mock。
 */
import * as path from 'node:path';
import { vi } from 'vitest';
import { SLOW_TEST_TIMEOUT_MS } from '../../../vitest.config.js';
import type { ExecResult } from '../../../src/io/exec.js';
import { runSync } from '../../../src/io/exec.js';
import { createIoContext, type IoContext } from '../../../src/io/paths.js';
import { readDir, readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import type { TreeSpec } from '../../../src/rsi/personal/commit.js';
import { commitPersonal, openPersonalRepo } from '../../../src/rsi/personal/commit.js';
import type { PersonalLocks, StepHook } from '../../../src/rsi/personal/commit.js';
import {
  ownerRepoFingerprint,
  personalHome,
  statePath,
  type PersonalHome,
} from '../../../src/rsi/personal/home-state.js';
import {
  acquirePersonalLock,
  type PersonalLockHandle,
} from '../../../src/rsi/personal/personal-lock.js';
import { baseCtx, makeTempDir, REPO_ROOT } from '../../helpers/tmp.js';

export interface World {
  dir: string;
  io: IoContext;
  /** 假 HOME */
  home: string;
  h: PersonalHome;
  /** 假的 `[rsi] repo`(owner_repo_fp 的来源目录) */
  rsiRepo: string;
  ownerFp: string;
}

export async function makeWorld(prefix: string): Promise<World> {
  const { dir } = await makeTempDir(prefix);
  const io = createIoContext({
    cwd: REPO_ROOT,
    env: { KIT_TMP: dir, KIT_STATE_DIR: path.join(dir, 'state'), PATH: baseCtx().execPath },
  });
  const home = path.join(dir, 'home');
  const rsiRepo = path.join(dir, 'rsi-repo');
  await safe.mkdirp(io, home, 0o700);
  await safe.mkdirp(io, rsiRepo, 0o700);
  const h = personalHome(io, home);
  return { dir, io, home, h, rsiRepo, ownerFp: await ownerRepoFingerprint(rsiRepo) };
}

export const NOW = new Date('2026-11-10T00:00:00.000Z');

export function repoDeps(
  w: World,
  over: { onStep?: StepHook; ownerRepoFp?: string; uid?: number; h?: PersonalHome } = {},
): Parameters<typeof commitPersonal>[0] {
  return {
    h: over.h ?? w.h,
    ownerRepoFp: over.ownerRepoFp ?? w.ownerFp,
    now: () => NOW,
    ...(over.uid !== undefined ? { uid: over.uid } : {}),
    ...(over.onStep !== undefined ? { onStep: over.onStep } : {}),
  };
}

/** 持真的 `personal/lock` 跑一段;一定释放(模拟「进程死亡」时用它的 finally) */
export async function withLock<T>(
  w: World,
  fn: (locks: PersonalLocks, handle: PersonalLockHandle) => Promise<T>,
): Promise<T> {
  const lock = await acquirePersonalLock(w.h);
  try {
    return await fn({ personal: lock }, lock);
  } finally {
    await lock.release();
  }
}

/** 一个什么都不检查的锁(只给「同一进程里模拟另一个提交者」用) */
export const FAKE_LOCKS: PersonalLocks = { personal: { assertHeld: async () => undefined } };

const GIT_ARGS = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
const IDENT_ENV = {
  GIT_AUTHOR_NAME: 'user',
  GIT_AUTHOR_EMAIL: 'user@example.invalid',
  GIT_COMMITTER_NAME: 'user',
  GIT_COMMITTER_EMAIL: 'user@example.invalid',
};

/** 测试自己的 git(**不是**被测的封闭执行):对私有仓库跑一条命令,返回 ExecResult */
export function gitRaw(
  w: World,
  args: readonly string[],
  opts: { input?: string; env?: Record<string, string> } = {},
): ExecResult {
  return runSync(w.io, 'git', ['-C', w.h.repoDir, ...GIT_ARGS, ...args], {
    env: { ...IDENT_ENV, ...opts.env },
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
}

/** 同上,非 0 退出抛错,返回去掉末尾换行的 stdout */
export function git(
  w: World,
  args: readonly string[],
  opts: { input?: string; env?: Record<string, string> } = {},
): string {
  const r = gitRaw(w, args, opts);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败:${r.status} ${r.stderr}`);
  }
  return r.stdout.replace(/\n$/, '');
}

export const ID1 = 'ra_aaaaaaaaaaaa';
export const ID2 = 'ra_bbbbbbbbbbbb';

export const BASE_FILES = [
  { path: 'rules/base.md', content: 'base rule\n' },
  { path: `lifecycle/${ID1}.json`, content: '{"id":"ra_aaaaaaaaaaaa"}\n' },
] as const;

export function spec(
  txn: string,
  files: TreeSpec['files'],
  kind: TreeSpec['kind'] = 'transition',
  ids: readonly string[] = [ID1],
): TreeSpec {
  return { kind, txnId: txn.padEnd(16, '0'), candidateIds: ids, files };
}

/** 建仓并提交第一棵树(BASE_FILES);返回提交结果的 commit */
export async function setupRepo(w: World): Promise<string> {
  const r = await withLock(w, async (locks) => {
    const open = await openPersonalRepo(repoDeps(w), locks, { bootstrap: true });
    if (open.kind !== 'ready') throw new Error(`bootstrap 后应为 ready:${JSON.stringify(open)}`);
    return commitPersonal(repoDeps(w), locks, spec('1', BASE_FILES));
  });
  if (r.status !== 'committed') throw new Error(`首次提交失败:${JSON.stringify(r)}`);
  return r.commit;
}

/** 第二次提交的目标树:改 base、删 lifecycle 之外的旧文件、新增 rules/new.md */
export const NEXT_FILES = [
  { path: 'rules/base.md', content: 'base rule v2\n' },
  { path: 'rules/new.md', content: 'new rule\n' },
  { path: `lifecycle/${ID1}.json`, content: '{"id":"ra_aaaaaaaaaaaa","v":2}\n' },
] as const;

export class InjectedCrash extends Error {
  constructor(readonly step: string) {
    super(`injected crash at ${step}`);
  }
}

/** 在命名步骤点抛 {@link InjectedCrash}(= 该点之后进程死亡) */
export const crashAt =
  (step: string): StepHook =>
  (s) => {
    if (s === step) throw new InjectedCrash(step);
  };

export async function writeUserFile(w: World, rel: string, content: string): Promise<void> {
  const abs = path.join(w.h.repoDir, rel);
  await safe.mkdirp(w.io, path.dirname(abs), 0o700);
  await safe.writeFile(w.io, abs, content);
}

export async function readUserFile(w: World, rel: string): Promise<string> {
  return readText(path.join(w.h.repoDir, rel));
}

async function walk(dir: string, rel: string, out: Record<string, string>): Promise<void> {
  for (const e of await readDir(path.join(dir, rel))) {
    if (rel === '' && e.name === '.git') continue;
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory) await walk(dir, r, out);
    else out[r] = await readText(path.join(dir, r));
  }
}

export interface Snapshot {
  headRef: string;
  refs: string;
  index: string;
  status: string;
  files: Record<string, string>;
  journal: string | null;
}

/** HEAD 符号引用 / 全部引用 / 索引 / status / 工作树文件 / journal 字节:「不改引用、索引与工作树」的比较基准 */
export async function snapshot(w: World): Promise<Snapshot> {
  const files: Record<string, string> = {};
  await walk(w.h.repoDir, '', files);
  let journal: string | null = null;
  try {
    journal = await readText(statePath(w.h, 'commit-journal.json'));
  } catch {
    journal = null;
  }
  return {
    headRef: gitRaw(w, ['symbolic-ref', '-q', 'HEAD']).stdout.trim(),
    refs: git(w, ['for-each-ref', '--format=%(refname) %(objectname)']),
    index: git(w, ['ls-files', '-s']),
    status: git(w, ['--no-optional-locks', 'status', '--porcelain', '--ignored']),
    files,
    journal,
  };
}

/** 本地 `.git/config` 追加(经真 git config,测试夹具用) */
export function addLocalConfig(w: World, key: string, value: string): void {
  git(w, ['config', '--local', key, value]);
}

/** 每个用例要起几十次真 git 子进程(验证机高负载时单次十几秒):本文件内放宽用例超时(仓库的慢用例口径) */
export function slowTests(): void {
  vi.setConfig({ testTimeout: SLOW_TEST_TIMEOUT_MS, hookTimeout: SLOW_TEST_TIMEOUT_MS });
}

import * as path from 'node:path';
import { runSync } from '../../src/io/exec.js';
import { createIoContext, type IoContext } from '../../src/io/paths.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeTempDir, wideCtx } from './tmp.js';

/**
 * 临时 git 仓库 harness(docs/contracts.md §4.4,M-6)。
 * - 仓库建在 KIT_TMP(或 .state/test-tmp)下的独立目录,绝不在 HOME 里;
 * - 每个 git 子进程:GIT_CONFIG_GLOBAL=/dev/null、GIT_CONFIG_NOSYSTEM=1、HOME=<tmp>/githome(空目录),
 *   并逐命令 -c user.name / user.email / commit.gpgsign=false / init.defaultBranch=main;
 * - 一律经 src/io/exec.ts(runSync),文件读写经 safe-fs。
 */

/** 文件内容:字符串 = 普通文件;null = 删除;link = 符号链接;exec = 可执行位 */
export type FileSpec = string | null | { link: string } | { content: string; exec: true };
export type FileMap = Readonly<Record<string, FileSpec>>;

export interface TestRepo {
  /** 仓库根 */
  readonly dir: string;
  /** 以仓库为 cwd 的 IoContext(KIT_TMP = 上级临时目录;repoRoot = 仓库根) */
  readonly io: IoContext;
  /** 起 git 用的环境变量(HOME 指向 githome) */
  readonly gitEnv: Readonly<Record<string, string>>;
  /** 执行 git 并返回 stdout;非 0 退出抛错 */
  git(args: readonly string[]): string;
  /** 应用 files(增量)并提交,返回提交 oid */
  commit(files: FileMap, message?: string): Promise<string>;
  /** 轻量 tag(annotated=true 则建注解 tag) */
  tag(name: string, ref?: string, annotated?: boolean): void;
  /** 在指定提交上建分支并切换 */
  branch(name: string, ref?: string): void;
  dispose(): Promise<void>;
}

const IDENT = [
  '-c',
  'user.name=kit-test',
  '-c',
  'user.email=kit-test@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
] as const;

export async function makeTestRepo(prefix = 'guards-'): Promise<TestRepo> {
  const { ctx: cleanupCtx, dir: tmp } = await makeTempDir(prefix);
  const wctx = wideCtx(tmp);
  const dir = path.join(tmp, 'repo');
  const home = path.join(tmp, 'githome');
  await safe.mkdirp(wctx, dir);
  await safe.mkdirp(wctx, home);
  const gitEnv = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: home,
    // 固定时间戳:提交 oid 在重跑间稳定
    GIT_AUTHOR_DATE: '2026-10-08T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-10-08T00:00:00Z',
  } as const;

  const git = (args: readonly string[]): string => {
    const r = runSync(wctx, 'git', [...IDENT, ...args], { cwd: dir, env: gitEnv });
    if (r.spawnError !== undefined || r.status !== 0) {
      throw new Error(`git ${args.join(' ')} 失败(${r.status}):${r.spawnError ?? r.stderr}`);
    }
    return r.stdout;
  };
  git(['init', '--quiet', '--template=']);

  const commit = async (files: FileMap, message = 'test commit'): Promise<string> => {
    for (const [rel, spec] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      if (spec === null) {
        await safe.remove(wctx, abs);
        continue;
      }
      await safe.mkdirp(wctx, path.dirname(abs));
      if (typeof spec === 'string') {
        await safe.writeFile(wctx, abs, spec);
      } else if ('link' in spec) {
        await safe.remove(wctx, abs); // 原位已有普通文件时,先删再链(类型变更)
        await safe.symlink(wctx, spec.link, abs);
      } else {
        await safe.writeFile(wctx, abs, spec.content);
        await safe.chmod(wctx, abs, 0o755);
      }
    }
    git(['add', '-A']);
    git(['commit', '--quiet', '--allow-empty', '-m', message]);
    return git(['rev-parse', 'HEAD']).trim();
  };

  return {
    dir,
    io: createIoContext({ cwd: dir, root: dir, env: { KIT_TMP: tmp, PATH: '/usr/bin:/bin' } }),
    gitEnv,
    git,
    commit,
    tag(name, ref = 'HEAD', annotated = false) {
      if (annotated) git(['tag', '-a', '-m', 'annotated', name, ref]);
      else git(['tag', name, ref]);
    },
    branch(name, ref = 'HEAD') {
      git(['checkout', '--quiet', '-B', name, ref]);
    },
    async dispose() {
      await safe.remove(cleanupCtx, tmp);
    },
  };
}

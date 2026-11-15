/**
 * `resolveGitPath`:受限只读 git 适配器要的「git 可执行文件的绝对路径」的解析(装配块 A 段;contracts §21.24 W0-22 第 6 条:路径由部署组装传入,**不查 PATH**)。
 *
 * - **只读**:候选清单是固定的绝对路径,逐个只做 `stat` / `realpath`(read-fs),**不 chmod、不修复、不启动子进程**;没有环境变量覆盖(覆盖入口 = 后门)。
 * - 一个候选被接受的条件(全部满足;检查与返回的都是 `realpath` 规范路径,见 {@link canonicalGit}):普通文件、至少一个可执行位、不可被组 / 其他人写、属主是 root 或当前用户、文件名仍是 `git`
 *   (`makeGitReadonly` 对 `gitPath` 的断言)、父目录不可被组 / 其他人写且属主可信。**任何一项不满足 = 跳过该候选**(不是报错),全部不满足 = `null`。
 * - `null` = 解析不到 = **保持未装配**(`unwiredRecordedRead`:`unreadable(not_wired)`,命令退 3),绝不假装成功。
 * - 导入本模块不读盘;只有调用 {@link resolveGitPath} 才探测。
 */
import * as path from 'node:path';
import { realpath, stat } from '../../io/read-fs.js';

/** 固定候选(按序;不含 `PATH` 里的任何位置) */
export const GIT_PATH_CANDIDATES: readonly string[] = Object.freeze([
  '/usr/bin/git',
  '/opt/homebrew/bin/git',
  '/usr/local/bin/git',
]);

export interface GitPathProbe {
  /** 跟随符号链接的元数据;不存在 / 不可读抛错 */
  stat(p: string): Promise<{ isFile: boolean; isDirectory: boolean; mode: number; uid: number }>;
  realpath(p: string): Promise<string>;
  /** 当前用户 uid(没有 = 不支持,只接受 root 属主) */
  uid: number | undefined;
}

const defaultProbe: GitPathProbe = {
  async stat(p) {
    const s = await stat(p);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), mode: s.mode, uid: s.uid };
  },
  realpath: (p) => realpath(p),
  uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
};

/**
 * 单个候选 → **规范路径**(`realpath`)或 `null`。检查对象是规范路径指向的文件(不是候选名这个可被替换的入口),返回的也是规范路径:
 * 普通文件、至少一个可执行位、不可被组 / 其他人写、属主是 root 或当前用户、文件名仍是 `git`;
 * 并且**父目录**(规范路径的 dirname)是目录、不可被组 / 其他人写、属主是 root 或当前用户(父目录可写 = 目录项可被替换,文件自身权限再严也无意义)。
 * 残余(不消除 TOCTOU):本函数只给出「探测那一刻」的结论;返回规范路径只缩小竞态窗口。**执行侧每次调用前仍须自检**(重新核对路径元数据),不得把这次结果当作永久可信。
 */
export async function canonicalGit(candidate: string, probe: GitPathProbe): Promise<string | null> {
  if (!path.isAbsolute(candidate) || path.basename(candidate) !== 'git') return null;
  const trusted = (st: { mode: number; uid: number }): boolean =>
    (st.mode & 0o022) === 0 && (st.uid === 0 || st.uid === probe.uid);
  try {
    const real = await probe.realpath(candidate);
    if (!path.isAbsolute(real) || path.basename(real) !== 'git') return null;
    const st = await probe.stat(real);
    if (!st.isFile) return null;
    if ((st.mode & 0o111) === 0) return null;
    if (!trusted(st)) return null;
    const dir = await probe.stat(path.dirname(real));
    if (!dir.isDirectory || !trusted(dir)) return null;
    return real;
  } catch {
    return null;
  }
}

/** 单个候选的接受判定(= {@link canonicalGit} 非空) */
export async function acceptableGit(candidate: string, probe: GitPathProbe): Promise<boolean> {
  return (await canonicalGit(candidate, probe)) !== null;
}

export interface ResolveGitPathOptions {
  candidates?: readonly string[];
  probe?: GitPathProbe;
}

/** 第一个被接受的候选的**规范路径**;解析不到 = `null`(调用方保持未装配) */
export async function resolveGitPath(opts: ResolveGitPathOptions = {}): Promise<string | null> {
  const probe = opts.probe ?? defaultProbe;
  for (const c of opts.candidates ?? GIT_PATH_CANDIDATES) {
    const real = await canonicalGit(c, probe);
    if (real !== null) return real;
  }
  return null;
}

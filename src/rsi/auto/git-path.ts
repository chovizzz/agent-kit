/**
 * `resolveGitPath`:受限只读 git 适配器要的「git 可执行文件的绝对路径」的解析(装配块 A 段;contracts §21.24 W0-22 第 6 条:路径由部署组装传入,**不查 PATH**)。
 *
 * - **只读**:候选清单是固定的绝对路径,逐个只做 `stat` / `realpath`(read-fs),**不 chmod、不修复、不启动子进程**;没有环境变量覆盖(覆盖入口 = 后门)。
 * - 一个候选被接受的条件(全部满足):普通文件、至少一个可执行位、不可被组 / 其他人写、属主是 root 或当前用户、`realpath` 之后文件名仍是 `git`
 *   (`makeGitReadonly` 对 `gitPath` 的断言)。**任何一项不满足 = 跳过该候选**(不是报错),全部不满足 = `null`。
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
  stat(p: string): Promise<{ isFile: boolean; mode: number; uid: number }>;
  realpath(p: string): Promise<string>;
  /** 当前用户 uid(没有 = 不支持,只接受 root 属主) */
  uid: number | undefined;
}

const defaultProbe: GitPathProbe = {
  async stat(p) {
    const s = await stat(p);
    return { isFile: s.isFile(), mode: s.mode, uid: s.uid };
  },
  realpath: (p) => realpath(p),
  uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
};

/** 单个候选的接受判定(纯逻辑 + 注入探针;每条拒绝原因都有负向用例) */
export async function acceptableGit(candidate: string, probe: GitPathProbe): Promise<boolean> {
  if (!path.isAbsolute(candidate) || path.basename(candidate) !== 'git') return false;
  try {
    const st = await probe.stat(candidate);
    if (!st.isFile) return false;
    if ((st.mode & 0o111) === 0) return false;
    if ((st.mode & 0o022) !== 0) return false;
    if (st.uid !== 0 && st.uid !== probe.uid) return false;
    const real = await probe.realpath(candidate);
    return path.isAbsolute(real) && path.basename(real) === 'git';
  } catch {
    return false;
  }
}

export interface ResolveGitPathOptions {
  candidates?: readonly string[];
  probe?: GitPathProbe;
}

/** 第一个被接受的候选;解析不到 = `null`(调用方保持未装配) */
export async function resolveGitPath(opts: ResolveGitPathOptions = {}): Promise<string | null> {
  const probe = opts.probe ?? defaultProbe;
  for (const c of opts.candidates ?? GIT_PATH_CANDIDATES) {
    if (await acceptableGit(c, probe)) return c;
  }
  return null;
}

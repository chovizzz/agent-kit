/**
 * 项目排除与默认拒绝(决策 ③A,Q-N9)。
 *
 * - `exclude_dirs`(覆盖层):会话 cwd_hint 落在其中任一目录之内 → 整条会话跳过(不产出信号)。
 * - `--allow-project <名字|绝对路径>`:白名单模式,只处理匹配的项目。名字 = cwd_hint 的 basename 精确相等;
 *   绝对路径 = 按路径段边界的前缀(`/x/proj` 匹配 `/x/proj/sub`,不匹配 `/x/proj-evil`)。
 * - exclude 优先于 allow。
 * - 默认拒绝:既没有非空 exclude_dirs,也没有 allow-project → 不处理(命令退出 2)。
 * - cwd_hint 为 null:无法证明不在排除目录里,且无法匹配白名单 → 保守跳过(计入 skipped_excluded)。
 * - 比较前做 realpath(目录不存在则只做 resolve)、去尾斜杠,并**不区分大小写**。
 *   对 exclude 这是更保守的方向(macOS 默认大小写不敏感);对 allow 在大小写敏感的文件系统上是**放宽**
 *   (`--allow-project Foo` 也放行 `foo`),P0 接受(只跑 macOS/Linux,且 allow 只用于受控的真实采样)。
 * - 路径分隔符按 POSIX `/`;不支持 Windows。
 * - cwd_hint 为 null、空串或相对路径:按未知项目跳过。
 */
import * as path from 'node:path';
import { realpath } from '../io/read-fs.js';

export class ExcludeConfigError extends Error {
  readonly code = 'SIGNALS_EXCLUDE_CONFIG';
}

async function canonical(p: string): Promise<string> {
  const abs = path.resolve(p);
  let real = abs;
  try {
    real = await realpath(abs);
  } catch {
    // 目录已不存在:用 resolve 后的路径比较
  }
  return real.length > 1 ? real.replace(/[\\/]+$/, '') : real;
}

function fold(p: string): string {
  return p.toLowerCase();
}

/** child 在 dir 之内(含相等),按路径段边界。入参已 canonical + fold。 */
function within(dir: string, child: string): boolean {
  if (child === dir) return true;
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  return child.startsWith(prefix);
}

export interface ProjectDecision {
  action: 'process' | 'skip';
  /** process 时:project_key 哈希所用的项目根(允许路径命中则为该路径,否则为 cwd 本身) */
  projectRoot?: string;
  reason?: 'excluded' | 'not_allowed' | 'unknown_project';
}

export interface ExcludePolicy {
  /** 会话 cwd_hint → 处理/跳过 */
  decide(cwdHint: string | null): Promise<ProjectDecision>;
}

export interface ExcludeInput {
  excludeDirs: readonly string[];
  allowProjects: readonly string[];
}

export function hasProtection(input: ExcludeInput): boolean {
  return input.excludeDirs.length > 0 || input.allowProjects.length > 0;
}

export async function createExcludePolicy(input: ExcludeInput): Promise<ExcludePolicy> {
  if (!hasProtection(input)) {
    throw new ExcludeConfigError('既没有 exclude_dirs 也没有 --allow-project');
  }
  const excludes: string[] = [];
  for (const d of input.excludeDirs) {
    if (!path.isAbsolute(d)) throw new ExcludeConfigError('exclude_dirs 只接受绝对路径');
    excludes.push(fold(await canonical(d)));
  }
  const allowNames = new Set<string>();
  const allowPaths: { folded: string; real: string }[] = [];
  for (const a of input.allowProjects) {
    if (a === '') throw new ExcludeConfigError('--allow-project 不能为空');
    if (path.isAbsolute(a)) {
      const real = await canonical(a);
      allowPaths.push({ folded: fold(real), real });
    } else {
      if (a.includes('/') || a.includes('\\')) {
        throw new ExcludeConfigError('--allow-project 只接受目录名(无分隔符)或绝对路径');
      }
      allowNames.add(fold(a));
    }
  }
  const restricted = input.allowProjects.length > 0;

  return {
    async decide(cwdHint) {
      // 相对路径是 trace 自报的,不能按 collector 的 cwd 解释:当作未知项目
      if (cwdHint === null || cwdHint === '' || !path.isAbsolute(cwdHint)) {
        return { action: 'skip', reason: 'unknown_project' };
      }
      const cwd = await canonical(cwdHint);
      const folded = fold(cwd);
      if (excludes.some((e) => within(e, folded))) return { action: 'skip', reason: 'excluded' };
      if (!restricted) return { action: 'process', projectRoot: cwd };
      const hit = allowPaths.find((a) => within(a.folded, folded));
      if (hit) return { action: 'process', projectRoot: hit.real };
      if (allowNames.has(fold(path.basename(cwd)))) return { action: 'process', projectRoot: cwd };
      return { action: 'skip', reason: 'not_allowed' };
    },
  };
}

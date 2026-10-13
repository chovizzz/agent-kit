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
  // 解析「最长的已存在前缀」的 realpath,再接回不存在的尾部:
  // 项目目录被删除后(realpath 对整条路径失败),仍能通过符号链接前缀的不同写法被排除清单认出,
  // 避免『同一目录两种写法』导致客户项目的会话漏过排除。
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(head);
      const joined = tail.length > 0 ? path.join(real, ...tail.slice().reverse()) : real;
      return joined.length > 1 ? joined.replace(/[\\/]+$/, '') : joined;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs.length > 1 ? abs.replace(/[\\/]+$/, '') : abs;
      tail.push(path.basename(head));
      head = parent;
    }
  }
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
  reason?: 'excluded' | 'not_allowed' | 'unknown_project' | 'self_state';
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

/**
 * 排除反思器自己的会话(R1):会话 cwd 落在本仓 `.state/` 之内(含相等)→ 跳过,reason=`self_state`。
 * 反思器的 LLM 子进程以 `.state/reflect/cwd/` 为工作目录,它的会话日志若被回采会形成「反思自己」的回路。
 *
 * - 在用户策略**之前**判定(自身会话优先计入 self_state,而不是 not_allowed / excluded);
 * - 与 exclude_dirs 同一套比较:最长已存在前缀的 realpath(穿透符号链接)、`path.resolve` 折叠 `..`、
 *   去尾斜杠、不区分大小写;目录已被删除也能认出;
 * - 另有兜底:路径含 `.state/reflect/cwd` 三段(见 hasReflectorCwdSegments)。
 * - cwd 为 null / 空 / 相对路径不在此判(交给内层策略按 unknown_project 跳过)。
 * - 不区分大小写在大小写敏感文件系统上会多排除一个仅大小写不同的兄弟目录,方向是保守的。
 */
/**
 * 兜底:路径里含 `<.state|state>/reflect/cwd` 这三段(按段边界,前缀不限)也算反思器会话。
 * 采集与反思若用了不同的 KIT_STATE_DIR / 不同 worktree,按 stateDir 判定会认不出旧的反思器会话
 * (`KIT_STATE_DIR=$KIT_TMP/state` 的布局父目录叫 `state`,所以两种名字都认)。
 * 只认完整的三段,所以 `/work/reflect/cwd` 之类的普通项目不受影响;`/x/state/reflect/cwd` 会被多排除,方向保守。
 * 入参已 canonical + fold。
 */
function hasReflectorCwdSegments(foldedCwd: string): boolean {
  const seg = foldedCwd.split('/');
  for (let i = 0; i + 2 < seg.length; i++) {
    if (
      (seg[i] === '.state' || seg[i] === 'state') &&
      seg[i + 1] === 'reflect' &&
      seg[i + 2] === 'cwd'
    )
      return true;
  }
  return false;
}

export function withSelfExclusion(inner: ExcludePolicy, stateDir: string): ExcludePolicy {
  let stateCanon: Promise<string> | undefined;
  const state = (): Promise<string> => (stateCanon ??= canonical(stateDir).then(fold));
  return {
    async decide(cwdHint) {
      if (cwdHint !== null && cwdHint !== '' && path.isAbsolute(cwdHint)) {
        const cwd = fold(await canonical(cwdHint));
        if (within(await state(), cwd) || hasReflectorCwdSegments(cwd))
          return { action: 'skip', reason: 'self_state' };
      }
      return inner.decide(cwdHint);
    },
  };
}

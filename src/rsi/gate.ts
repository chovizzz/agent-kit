/**
 * 双闸(docs/contracts.md §20.4 R20-4.8、§20.5 R20-5.1、§20.9;R20-A2 B2 / a2-plan v2 §1、§2)。
 *
 * 同一个配置结果 `off` 对「要不要拿锁」和「暂存区隐私闸怎么办」含义**不同**,所以是两个互相独立的函数,各自实现、各自测试:
 *
 *  - {@link lockGate}:只回答「要不要拿 `rsi/lock`」→ `off`(不拿锁,现有命令逐字节不变)| `lock` | `refuse`(退出 3 `state_dir_unsafe`)。
 *  - {@link privacyGate}:只给 `judge`(含干跑)/ `promote` 的即时闸用 → `legacyAllowed` | `enforce` | `deny`(退出 3)。
 *
 * | 配置                                       | privacyGate   | lockGate                                  |
 * | ------------------------------------------ | ------------- | ----------------------------------------- |
 * | absent / no_section / disabled             | legacyAllowed | off                                       |
 * | 任何 cfg_* / repo_invalid                  | deny          | off                                       |
 * | on + overlay_invalid / exclude_invalid     | deny          | 按状态目录关系:off / lock / refuse        |
 * | on,无 block                                | enforce       | 按状态目录关系:off / lock / refuse        |
 *
 * `lockGate == off` **绝不**等于放行:隐私闸必须单独判。`legacyAllowed` 只表示允许旧流程。
 *
 * 本块只提供库级函数与单测,**不改任何命令**:真实命令是否按序调用(先算两闸、deny / refuse 之前不构造会写盘的上下文、不建 `rsi/`、
 * 不拿锁、不恢复快照)是 B3b / B3c 的接线与顺序测试的责任。两个闸函数本身**零写入、不建目录**。
 *
 * D1 修订稿(状态目录关系):rsi 状态树固定为 `<[rsi] repo>/.state`;现有写入方用自己 `ctx.io.stateDir`。判定用**不建目录**的路径解析:
 * 取最长已存在前缀的 `realpath` 加上余下片段,并记下该前缀各级的 `(dev, ino)` 身份链。
 *   - 能证明两棵树互不相同且互不为祖先 / 后代 → 独立 → 现有命令不拿锁;
 *   - 相同(路径相同或 `(dev, ino)` 相同)→ 拿锁;
 *   - 无法证明(任一路径含悬空符号链接 / 循环 / 权限不足 / 中间组件不是目录 / 末端不是目录、两次解析结果不一致、父子重叠、
 *     只在忽略大小写后相同或重叠、平台不支持)→ `refuse`。
 * 残余(如实写明,不弱化):解析在 `lockGate` 内一次完成,之后 `acquireRsiLock` 才按字符串路径建目录 / 建锁——解析与使用之间被换成链接,
 * 靠 `rsiDir()` 自己的 realpath / lstat 复核缩小窗口,不是消除。
 */
import * as path from 'node:path';
import { ExitCode, type ExitCodeValue } from '../contracts/exit-codes.js';
import type { RsiFailClosedReason } from '../contracts/rsi.js';
import type { IoContext } from '../io/paths.js';
import { lstat, realpath, safeOpenSupported, stat } from '../io/read-fs.js';
import type { RsiConfig } from './config.js';

// ---------------------------------------------------------------------------
// privacyGate
// ---------------------------------------------------------------------------
export type PrivacyGate =
  | { kind: 'legacyAllowed' }
  | { kind: 'enforce' }
  | {
      kind: 'deny';
      code: 'RSI_FAIL_CLOSED';
      reason: RsiFailClosedReason;
      exit: ExitCodeValue;
    };

const deny = (reason: RsiFailClosedReason): PrivacyGate => ({
  kind: 'deny',
  code: 'RSI_FAIL_CLOSED',
  reason,
  exit: ExitCode.FAIL_CLOSED,
});

/**
 * R20-4.8 的生效条件:`[rsi]` 状态为 `armed` / `confirmed` / `stopped`(= 配置 `on`)时才做;没有 `[rsi]` 或 `enabled` 不为真时**不做**
 * (兼容现有手动流程);`[rsi]` 存在但配置不可用(`cfg_*` / `repo_invalid` / `overlay_invalid` / `exclude_invalid`)时无法判断排除,一律拒绝。
 *
 * 判断取舍(opus 咨询同意,契约订正见 §20.14):文件层失败(`cfg_symlink` / `cfg_owner` / `cfg_perm` / `cfg_not_regular` / `cfg_too_large` /
 * `cfg_unreadable`)与 `cfg_parse` 读不到 `[rsi]` 段,无法证明「没有 `[rsi]`」。这里按 fail-closed(deny)处理:隐私一侧的代价更大。
 * 代价:一份从未用过 rsi、但权限过宽的 `config.toml`(update 读它不报错)会挡住 judge / promote。
 */
export function privacyGate(config: RsiConfig): PrivacyGate {
  if (config.status === 'on')
    return config.block === null ? { kind: 'enforce' } : deny(config.block);
  switch (config.reason) {
    case 'absent':
    case 'no_section':
    case 'disabled':
      return { kind: 'legacyAllowed' };
    default:
      return deny(config.reason);
  }
}

// ---------------------------------------------------------------------------
// lockGate
// ---------------------------------------------------------------------------
export type LockGate =
  | { kind: 'off' }
  | { kind: 'lock' }
  | { kind: 'refuse'; code: 'RSI_FAIL_CLOSED'; reason: 'state_dir_unsafe'; exit: ExitCodeValue };

const REFUSE: LockGate = {
  kind: 'refuse',
  code: 'RSI_FAIL_CLOSED',
  reason: 'state_dir_unsafe',
  exit: ExitCode.FAIL_CLOSED,
};

/** 路径解析结果(导出只给 {@link relateResolved} 的单测造「别名祖先」场景用) */
export interface Resolved {
  /** 最长已存在前缀的 realpath + 余下(尚不存在的)片段 */
  real: string;
  /** 已存在前缀自身及其各级祖先的 `dev:ino`(自身在前) */
  ids: string[];
  /** 路径本身已存在时的 `dev:ino`(尚不存在 = undefined) */
  selfId: string | undefined;
  /** 余下(尚不存在的)片段,自上而下;路径已存在时为空 */
  rest: string[];
}

export interface LockGateHooks {
  /** 测试缝:两次解析之间调用(演练解析完成后路径被换掉) */
  betweenResolves?: () => Promise<void> | void;
}
export interface LockGateOptions {
  /** 覆盖平台能力判定(测试);缺省 `safeOpenSupported()`(D8) */
  platformSupported?: boolean;
  hooks?: LockGateHooks;
}

const idOf = (st: { dev: number; ino: number }): string => `${st.dev}:${st.ino}`;

/**
 * 不建目录的路径解析。区分「真的不存在」(ENOENT,向上回退并把片段接回)与「无法判断」:
 * 悬空符号链接 / 循环 / 权限不足 / 中间组件不是目录 / 已存在但不是目录,一律返回 `undefined`(调用方 fail-closed),不向上回退。
 */
async function resolveNoCreate(input: string): Promise<Resolved | undefined> {
  let cur = path.resolve(input);
  const rest: string[] = [];
  for (;;) {
    try {
      await lstat(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      const parent = path.dirname(cur);
      if (parent === cur) return undefined;
      rest.push(path.basename(cur));
      cur = parent;
      continue;
    }
    // 已存在(含符号链接 / 悬空链接):realpath 失败 = 悬空 / 循环 / 权限
    let real: string;
    try {
      real = await realpath(cur);
      if (!(await stat(real)).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    const ids: string[] = [];
    for (let c = real; ; c = path.dirname(c)) {
      try {
        ids.push(idOf(await stat(c)));
      } catch {
        return undefined;
      }
      if (path.dirname(c) === c) break;
    }
    const below = rest.slice().reverse();
    return {
      real: below.length === 0 ? real : path.join(real, ...below),
      ids,
      selfId: below.length === 0 ? ids[0] : undefined,
      rest: below,
    };
  }
}

const sameResolved = (a: Resolved, b: Resolved): boolean =>
  a.real === b.real &&
  a.selfId === b.selfId &&
  a.ids.join(',') === b.ids.join(',') &&
  a.rest.join('/') === b.rest.join('/');

/** 按路径组件边界判断 `x` 是否是 `y` 的**严格**祖先(不用字符串前缀:`/r/.state` 不是 `/r/.state-old` 的祖先) */
function strictAncestor(x: string, y: string): boolean {
  const rel = path.relative(x, y);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

const fold = (s: string): string => s.normalize('NFC').toLowerCase();

type Relation = 'same' | 'independent' | 'unprovable';

const isPrefix = (x: readonly string[], y: readonly string[]): boolean =>
  x.length <= y.length && x.every((seg, i) => seg === y[i]);

/**
 * 两棵状态树的关系。判据按证据强度排序:
 *  1. 都已存在且 `(dev, ino)` 相同 → 同一棵树;一方已存在、且是另一方已存在前缀链上的一级 → 重叠(无法证明独立);
 *  2. **共同的已存在前缀(同一实体,即使两边的路径字符串写法不同,如 bind mount / 大小写不敏感卷 / firmlink)**:此时只比较余下片段——
 *     逐段相等 → 相同;一方是另一方的前缀(父子)→ 重叠;忽略大小写后相同 / 前缀 → 无法证明;否则独立。尚不存在的目录不能因为路径字符串不同就判独立;
 *  3. 没有共同前缀实体:字符串相同 → 相同;按路径组件边界的祖先关系、忽略大小写后相同 / 重叠 → 无法证明;否则独立。
 *     **已知残余(如实写明,不弱化)**:这一步的「独立」只在「祖先关系会出现在 realpath 路径或 `(dev, ino)` 祖先链上」的前提下成立。
 *     Linux 的 bind mount 可以把一棵树挂到别处、隐藏它的真实祖先(`/data/state` 与挂到 `/alias/repo` 的 `/data/state/repo`):
 *     单靠 `realpath` + `stat` 看不出父子重叠。要消除就得对「两个不同仓库」一律 refuse,会破坏「独立树不拿锁、行为不变」,所以不做;
 *     macOS 没有 bind mount。该残余写进契约 §20.14。
 * 大小写折叠只用来保守拒绝,不用来证明「相同」。
 */
export function relateResolved(a: Resolved, b: Resolved): Relation {
  if (a.selfId !== undefined && a.selfId === b.selfId) return 'same';
  if (a.selfId !== undefined && b.ids.includes(a.selfId)) return 'unprovable';
  if (b.selfId !== undefined && a.ids.includes(b.selfId)) return 'unprovable';
  if (a.ids[0] !== undefined && a.ids[0] === b.ids[0]) {
    if (a.rest.length === b.rest.length && isPrefix(a.rest, b.rest)) return 'same';
    if (isPrefix(a.rest, b.rest) || isPrefix(b.rest, a.rest)) return 'unprovable';
    const fa = a.rest.map(fold);
    const fb = b.rest.map(fold);
    if (isPrefix(fa, fb) || isPrefix(fb, fa)) return 'unprovable';
    return 'independent';
  }
  if (a.real === b.real) return 'same';
  if (strictAncestor(a.real, b.real) || strictAncestor(b.real, a.real)) return 'unprovable';
  const fa = fold(a.real);
  const fb = fold(b.real);
  if (fa === fb || strictAncestor(fa, fb) || strictAncestor(fb, fa)) return 'unprovable';
  return 'independent';
}

/**
 * 要不要拿 `rsi/lock`(不建目录、不写):
 *  - 配置 `off`(含全部 cfg_* / repo_invalid / disabled)→ `off`:现有命令行为逐字节不变。**这不是放行**,隐私闸另判;
 *  - 配置 `on`:平台不支持(D8)→ `refuse`;`ctx.io.stateDir` 与 `<repo>/.state` 的关系按 D1 判:独立 → `off`,相同 → `lock`,其余 → `refuse`。
 *    `block`(overlay / 排除项不合规)不改变这个判断:状态照算,写入方照样拿锁。
 */
export async function lockGate(
  config: RsiConfig,
  io: Pick<IoContext, 'stateDir'>,
  opts: LockGateOptions = {},
): Promise<LockGate> {
  if (config.status === 'off') return { kind: 'off' };
  if (!(opts.platformSupported ?? safeOpenSupported())) return REFUSE;
  const rsiTree = path.join(config.repo, '.state');
  const first = [await resolveNoCreate(io.stateDir), await resolveNoCreate(rsiTree)];
  await opts.hooks?.betweenResolves?.();
  const second = [await resolveNoCreate(io.stateDir), await resolveNoCreate(rsiTree)];
  const [a, b] = first;
  const [a2, b2] = second;
  if (a === undefined || b === undefined || a2 === undefined || b2 === undefined) return REFUSE;
  if (!sameResolved(a, a2) || !sameResolved(b, b2)) return REFUSE; // 两次解析的身份信息不一致:解析不稳定
  switch (relateResolved(a, b)) {
    case 'same':
      return { kind: 'lock' };
    case 'independent':
      return { kind: 'off' };
    default:
      return REFUSE;
  }
}

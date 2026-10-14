import type { DoctorCheckId } from '../contracts/doctor.js';

/**
 * S5:doctor 检查结果的统一形状(docs/contracts.md §19.3)。每个 Dxx 是一个纯函数:输入 = 只读快照 / 状态,输出 = CheckResult。
 *
 * 输出面(stdout / --json)只能出现这里的字段,且值必须是:枚举、计数、版本号、sha 前缀、写死的受管相对路径。
 * 键集合固定:每个检查都带 id / status / result / counts / facts / items 六个键(没有内容时为空对象 / 空数组)。
 */
export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'n_a';

/** facts 的值:枚举字符串 / 数字 / 布尔 / null。字符串必须经 `safeFact` 过滤(版本号、sha 前缀、枚举)。 */
export type Fact = string | number | boolean | null;

export interface CheckResult {
  id: DoctorCheckId;
  status: DoctorStatus;
  /** 该检查自己的结果枚举(见各检查函数的注释) */
  result: string;
  counts: Record<string, number>;
  facts: Record<string, Fact>;
  /** 条目:`<枚举>:~/<受管相对路径>[#块id]` 或稳定码 / 枚举;最多 MAX_ITEMS 条 */
  items: string[];
}

export const MAX_ITEMS = 100;

export const SEMVER_OUT_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ENUM_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** 版本号:不合法 → null(不原样输出用户可控的串) */
export const ver = (v: string | undefined): string | null =>
  v !== undefined && SEMVER_OUT_RE.test(v) ? v : null;
/** sha 前缀:只取前 12 位十六进制 */
export const sha12 = (s: string | undefined): string | null =>
  s !== undefined && /^[0-9a-f]{64}$/.test(s) ? s.slice(0, 12) : null;
/** 枚举:小写蛇形标识,否则 null */
export const en = (s: string | undefined): string | null =>
  s !== undefined && ENUM_RE.test(s) ? s : null;
/** ISO 时间戳(schema 已校验过的 UpdateState 字段) */
export const iso = (s: string | undefined): string | null =>
  s !== undefined && ISO_RE.test(s) ? s : null;

const SAFE_PATH_RE = /^[\x21-\x7e]+$/;
const BLOCK_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 受管相对路径的展示形式:只有通过 HOME 写入表校验、且全是可见 ASCII 的才原样输出,其余一律 `~/<path>`。 */
export function showPath(
  rel: string,
  blockId: string | undefined,
  isManaged: (p: string) => boolean,
): string {
  const p = SAFE_PATH_RE.test(rel) && isManaged(rel) ? `~/${rel}` : '~/<path>';
  return blockId !== undefined && BLOCK_ID_RE.test(blockId) ? `${p}#${blockId}` : p;
}

export function result(
  id: DoctorCheckId,
  status: DoctorStatus,
  res: string,
  extra: {
    counts?: Record<string, number>;
    facts?: Record<string, Fact>;
    items?: readonly string[];
  } = {},
): CheckResult {
  return {
    id,
    status,
    result: res,
    counts: { ...(extra.counts ?? {}) },
    facts: { ...(extra.facts ?? {}) },
    items: (extra.items ?? []).slice(0, MAX_ITEMS),
  };
}

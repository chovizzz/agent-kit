/**
 * digest 的聚类冷却过滤(契约 R21-11.1:「自动回滚 90 天、`expired` 30 天、`rejected` 连续 5 次 7 天;期间该聚类不进 digest」;D4 / 设计稿 §7 第 28 行)。
 *
 * 事实来源是 effects 账里的冷却项(B1a 的 `contracts/rsi-store.ts` + `store/**`,**尚未合并进 main**),所以本文件只有**依赖端口 + 纯逻辑**:
 *  - {@link CooldownSource}:窄端口,只回答「今天(UTC 日)仍生效的冷却聚类 id 集合」。到期口径(`utcDay(at) + days > today`)归账的读取方,**这里不复制第二份判据**;
 *  - {@link CooldownPort}:端口 + 一个 `clusterId` 函数(信号 → 稳定聚类 id,生产里 = `clusterIdOf(deriveClusterSignature(信号))`,在部署组装处注入,
 *    这样 digest 的 import 闭包不会拖进候选源模块);
 *  - 生产适配器(读 effects 账)与接线(`runDigest` 的 `deps.cooldown`)留给装配 C 段;未注入 = 本构建没有冷却账可读 = 不过滤(与改前一致)。
 *
 * **fail-closed**:端口已注入但读不到 / 抛错 / 返回形状不对 → 视为「所有簇都在冷却中」,一个簇也不提,并留下结构化原因({@link CooldownReport})。不得当成不在冷却。
 *
 * 簇 id 对应:digest 的簇 id 是序号 `c1…`(`reflect/cluster.ts`),与冷却账的 `cluster_id`(签名哈希)不是一套;这里对每个簇用 `clusterId(成员)` 重算。
 * 候选的签名来自提案引用的证据信号(只有可作证据的那部分),所以对「全部成员」与「可作证据的成员」各算一个 id,**任一命中即视为冷却**(取保守侧)。
 * 残余(登记,不是缺陷):lesson 类签名是 token 频次的函数,成员集合变了可能算出不同 id → 漏过滤;漏过滤不漏拒——G4 `cooldownActive` 仍会拒绝该候选。
 */
import type { LoadedSignal } from '../reflect/types.js';

/** 端口的读结果。`why` 是稳定短码(`[a-z0-9_]{1,64}`),不得带路径 / 原始异常文本 */
export type CooldownRead =
  { kind: 'ok'; active: ReadonlySet<string> } | { kind: 'unavailable'; why: string };

export interface CooldownSource {
  /** `todayUtc` = `YYYY-MM-DD`;返回今天仍生效的冷却项的 `cluster_id` 集合(过期项不在内) */
  activeClusterIds(todayUtc: string): Promise<CooldownRead>;
}

export interface CooldownPort {
  source: CooldownSource;
  /** 一组信号的稳定聚类 id;签名无法确定(无 token 等)→ `null`(这样的簇不可能被提成过候选,故不在冷却账里) */
  clusterId(signals: readonly LoadedSignal[]): string | null;
}

/** 本次过滤的结构化结果(给调用方 / 测试缝;**不进 digest 输出**——输出的原因枚举与 `truncated` 键集合已冻结) */
export type CooldownReport =
  | { state: 'not_wired' } // 未注入端口:本构建没有冷却账可读,不过滤
  | { state: 'skipped' } // 已注入,但本次没有可提的簇(项目被排除 / 归属不明等),没有读冷却事实
  | { state: 'ok'; dropped: number }
  | { state: 'unavailable'; why: string; dropped: number };

/** 簇过滤器:`members` = 该簇全部成员,`eligible` = 其中可作证据者;返回 `true` = 在冷却中(不提) */
export type ClusterCooldownFilter = (
  members: readonly LoadedSignal[],
  eligible: readonly LoadedSignal[],
) => boolean;

const WHY_RE = /^[a-z0-9_]{1,64}$/;

/**
 * 冷却集合的资源边界(M1):端口返回值跨信任边界,「形状合法」不等于「大小合理」。超限 → `unavailable`(`too_large`),fail-closed。
 * `id` 的上限与 `PersonalLifecycleRecord.cluster_id` 的 `max(128)` 同量级,留一倍余量;条数 / 累计字节按「90 天窗口内的冷却账」放宽后取整。
 */
export const COOLDOWN_MAX_IDS = 10_000;
export const COOLDOWN_MAX_ID_BYTES = 256;
export const COOLDOWN_MAX_TOTAL_BYTES = 1024 * 1024;

/** 原生 `Set` 的内部槽位访问器:不经对象自己的原型链,所以适配器覆盖 `size` / `values` / `Symbol.iterator` 都影响不到它们 */
const SET_SIZE = Object.getOwnPropertyDescriptor(Set.prototype, 'size')?.get as (
  this: Set<unknown>,
) => number;
const SET_VALUES = Set.prototype.values as (this: Set<unknown>) => IterableIterator<unknown>;

/** 受控地读出原生 Set 的元素:非原生 Set(鸭子类型 / Proxy / 跨界对象)→ `null`;超限 → `'too_large'`;元素不合格 → `'invalid'` */
function copyNativeSet(raw: unknown): Set<string> | 'too_large' | 'invalid' | null {
  let size: number;
  try {
    size = SET_SIZE.call(raw as Set<unknown>); // 非原生 Set 在这里抛 TypeError
  } catch {
    return null;
  }
  if (size > COOLDOWN_MAX_IDS) return 'too_large';
  const copy = new Set<string>();
  let bytes = 0;
  // 用内建的 `values()` 取迭代器(不调用适配器可覆盖的 `[Symbol.iterator]`):条数已由 size 封顶,不会不终止
  for (const id of SET_VALUES.call(raw as Set<unknown>)) {
    // 元素必须是非空字符串;id 的具体格式归账侧,这里不复制它的规则
    if (typeof id !== 'string' || id === '') return 'invalid';
    const n = Buffer.byteLength(id, 'utf8');
    bytes += n;
    if (n > COOLDOWN_MAX_ID_BYTES || bytes > COOLDOWN_MAX_TOTAL_BYTES) return 'too_large';
    copy.add(id);
  }
  return copy;
}

/** UTC 日 `YYYY-MM-DD`(与 R20-16.3 的 `utcToday` 同口径,本文件不依赖 session.ts) */
export const utcDayOf = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * 读冷却事实,永不抛错。未注入端口 → `null`(不过滤);注入后任何读失败 → `unavailable`。
 * 边界:返回的集合受 {@link COOLDOWN_MAX_IDS} 等上限约束,且只按原生 `Set` 的内部槽位读取。
 * **不涵盖**:`source.activeClusterIds` 本身长时间不返回——那是调用方的时间预算与取消责任(本函数不设超时),不能把它当成已覆盖的读失败。
 */
export async function readCooldown(
  port: CooldownPort | undefined,
  now: Date,
): Promise<CooldownRead | null> {
  if (port === undefined) return null;
  try {
    // 端口返回值跨信任边界:当 unknown 处理,逐层收窄(适配器可能返回 null / 缺键 / 错误形状)
    const raw: unknown = await port.source.activeClusterIds(utcDayOf(now));
    if (typeof raw !== 'object' || raw === null)
      return { kind: 'unavailable', why: 'invalid_result' };
    const r = raw as { kind?: unknown; active?: unknown; why?: unknown };
    if (r.kind === 'ok') {
      // 校验后复制,不保留适配器可变集合的引用;遍历方式与上限见 copyNativeSet
      const copy = copyNativeSet(r.active);
      if (copy === 'too_large') return { kind: 'unavailable', why: 'too_large' };
      if (copy === null || copy === 'invalid')
        return { kind: 'unavailable', why: 'invalid_result' };
      return { kind: 'ok', active: copy };
    }
    if (r.kind === 'unavailable' && typeof r.why === 'string' && WHY_RE.test(r.why)) {
      return { kind: 'unavailable', why: r.why };
    }
    return { kind: 'unavailable', why: 'invalid_result' };
  } catch {
    return { kind: 'unavailable', why: 'source_threw' };
  }
}

/**
 * 由一次读结果造出簇过滤器。`read = null`(未接线)→ 过滤器永远 `false`;`unavailable` → 永远 `true`;
 * `clusterId` 抛错 → 该簇按在冷却中处理(fail-closed)。丢弃个数由 `selectClustersScreened` 数(口径 = 冷却前具备初始证据的簇,见 `Selection.cooldownDropped`)。
 */
export function makeCooldownFilter(
  port: CooldownPort | undefined,
  read: CooldownRead | null,
): ClusterCooldownFilter {
  if (port === undefined || read === null) return () => false;
  if (read.kind === 'unavailable') return () => true; // fail-closed:读不到 = 全部在冷却中
  const active = read.active;
  return (members, eligible) => {
    try {
      for (const group of [members, eligible]) {
        if (group.length === 0) continue;
        const id = port.clusterId(group);
        if (id !== null && active.has(id)) return true;
      }
      return false;
    } catch {
      return true; // 算不出 id:不能证明不在冷却中
    }
  };
}

export function reportOf(
  port: CooldownPort | undefined,
  read: CooldownRead | null,
  dropped: number,
): CooldownReport {
  if (port === undefined) return { state: 'not_wired' };
  if (read === null) return { state: 'skipped' };
  return read.kind === 'ok'
    ? { state: 'ok', dropped }
    : { state: 'unavailable', why: read.why, dropped };
}

/**
 * A6「待审」不计已成候选的提案(契约 §21.3 R21-3.7 / R21-3.8 段末:「已成候选的提案不再算 A6『待审』」;D4 / 设计稿 verify_r21-asm-d-design.md §7)。
 *
 * 数据源 = 候选**工作副本** `.state/rsi/candidates/<id>.json` 的 `source`(`{run_id, proposal_id}`,R21-3.8;不读私有仓库的权威记录,那要起 git 子进程)。
 * **source 真实性(已核实,origin/main db6332b)**:工作副本只在权威记录提交成功之后才写——创建路径 `personal/candidate-step.ts`:`store.commit` 在 341 行,`status !== 'committed'` 即 halt 在 347 行,
 * 其后 362 行才 `newWorkingCopy`、364 行才 `working.put`;转移路径 `personal/candidate-apply.ts`:`store.commit` 95 行、非 committed 即 halt 104 行、109 行才 `working.put`(文件头注释同序);
 * 缺副本重建路径 `candidate-step.ts` 278–304 行(只从刚读到的权威记录的 `source_proposal` 重建)。全仓只有 `candidate-record.ts` 91 行(newWorkingCopy)与 113 行(rebuildWorkingCopy)两处构造 `source`,
 * 其余 `put` 都是在已有副本上 `{...wc}` 展开补丁,`source` 创建后不改。main 上没有「权威记录未提交就先落盘」的路径,所以这里**不再**核对权威记录(那要起 git 子进程)。
 * 残余:`WorkingStore.put` 的生产实现不在 main(只有端口),装配时必须保持「提交后才写」的顺序;副本在权威记录被清除 / 仓库回退后可能仍在——此时该提案确实曾转为候选,不再算待审;
 * `(run_id, proposal_id)` 在 run 目录被清理后被重用的情形未查到。
 * 工作副本没有删除路径(终态后仍在,至少到 `repo_removal_deferred` 收口);丢失只会让提案重回待审——这是**噪音方向**,不是安全方向。
 * 因此本读取器的读失败一律映射为「转化未知」:**不扣减**(与今天的行为相同),并留下稳定原因,绝不抛错、不返回 `known:false`(那会改变 hint / status / D17 现有输出)。
 *
 * 只读闭包:只 import read-fs 与契约(与 `pending.ts` 同一口径);零写入、不拿锁。
 */
import * as path from 'node:path';
import { RSI_SCAN_MAX_ENTRIES, RSI_SCAN_MAX_TOTAL_BYTES } from '../contracts/rsi.js';
import {
  CandidateWorkingCopySchema,
  type CandidateWorkingCopy,
} from '../contracts/rsi-personal.js';
import { readDir, readFileSafe, statDirSafe } from '../io/read-fs.js';
import { RSI_DIR_OWNER, RSI_FILE_OWNER, rsiDirReadonly } from './lock-read.js';

/** 单个工作副本的读取上限(字节):合法副本远小于此;超出按坏文件处理 */
export const CONVERTED_FILE_MAX_BYTES = 256 * 1024;

const COPY_NAME = /^(ra_[0-9a-f]{12})\.json$/;

/** 为什么「转化未知」(只有 `ok` 才允许扣减) */
export type ConvertedState =
  | 'ok'
  | 'missing' // 没有 candidates/ 目录:还没有任何候选,等价于空集合(可扣减 0)
  | 'unsafe' // 目录不安全 / 读不了
  | 'truncated' // 条目数超过扫描上限
  | 'budget'; // 总读取字节或调用方预算用尽

export interface ConvertedProposals {
  readonly state: ConvertedState;
  /** `run_id` → 已成候选的 `proposal_id` 集合;`state` 不是 `ok` / `missing` 时恒为空 */
  readonly byRun: ReadonlyMap<string, ReadonlySet<string>>;
  /** 坏文件个数(不可读 / 过大 / schema 不过 / 文件名与 id 不符):这些副本不参与扣减 */
  readonly unreadable: number;
}

const unknown = (state: ConvertedState, unreadable = 0): ConvertedProposals => ({
  state,
  byRun: new Map(),
  unreadable,
});

function parseCopy(bytes: Buffer): CandidateWorkingCopy | null {
  try {
    const p = CandidateWorkingCopySchema.safeParse(JSON.parse(bytes.toString('utf8')));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

export interface ConvertedLimits {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
}

/**
 * 读 `<rsiDir>/candidates/` 下全部工作副本的 `source`。`over` 每读完一个文件检查一次(调用方的时间预算):为真 → `budget`(整体放弃,不给部分结果)。
 * 部分结果不可信(少读的那些会被当成「未转化」,而已读的又扣了):预算 / 截断一律整体不扣减,保持与今天一致。
 */
export async function readConvertedProposals(
  rsiDir: string,
  deps: { over?: () => boolean; limits?: ConvertedLimits } = {},
): Promise<ConvertedProposals> {
  const maxEntries = deps.limits?.maxEntries ?? RSI_SCAN_MAX_ENTRIES;
  const maxTotal = deps.limits?.maxTotalBytes ?? RSI_SCAN_MAX_TOTAL_BYTES;
  const maxFile = deps.limits?.maxFileBytes ?? CONVERTED_FILE_MAX_BYTES;
  const dir = path.join(rsiDir, 'candidates');
  let st: Awaited<ReturnType<typeof statDirSafe>>;
  try {
    // 先验 `rsiDir` 自己(不跟随符号链接、属主 / 权限口径同 rsiDirReadonly):`statDirSafe(dir)` 的 O_NOFOLLOW 只保护末级,父目录是链接会被穿透
    const top = await statDirSafe(rsiDir, { owner: RSI_DIR_OWNER });
    if (top.kind === 'missing') return { state: 'missing', byRun: new Map(), unreadable: 0 };
    if (top.kind === 'unsafe') return unknown('unsafe');
    st = await statDirSafe(dir, { owner: RSI_DIR_OWNER });
  } catch {
    return unknown('unsafe');
  }
  if (st.kind === 'missing') return { state: 'missing', byRun: new Map(), unreadable: 0 };
  if (st.kind === 'unsafe') return unknown('unsafe');
  let entries: Awaited<ReturnType<typeof readDir>>;
  try {
    entries = await readDir(dir);
  } catch {
    return unknown('unsafe');
  }
  if (entries.length > maxEntries) return unknown('truncated');
  const byRun = new Map<string, Set<string>>();
  let unreadable = 0;
  let total = 0;
  for (const e of entries) {
    const m = COPY_NAME.exec(e.name);
    // 非副本形状的名字(临时文件、点文件、目录、链接)不是候选,忽略;它们不会让「转化未知」
    if (m === null || !e.isFile || e.isSymbolicLink) continue;
    // 读之前就按剩余总量设上限(不是读完再记账):已用尽时一个字节都不再读
    const cap = Math.min(maxFile, Math.max(0, maxTotal - total));
    const r = await readFileSafe(path.join(dir, e.name), {
      maxBytes: cap,
      owner: RSI_FILE_OWNER,
    });
    // 超限是被「剩余预算」卡住(而不是文件本身超过单文件上限)→ 预算用尽,整体放弃;单文件超限才是坏文件
    if (r.kind === 'unsafe' && r.why === 'too_large' && cap < maxFile) return unknown('budget');
    if (r.kind === 'ok') total += r.bytes.length;
    if (deps.over?.() === true) return unknown('budget');
    if (r.kind !== 'ok') {
      unreadable++;
      continue;
    }
    const copy = parseCopy(r.bytes);
    // 文件名与内容里的 id 不符:不信这份副本(防伪造 / 误放)
    if (copy === null || copy.id !== m[1]) {
      unreadable++;
      continue;
    }
    const set = byRun.get(copy.source.run_id) ?? new Set<string>();
    set.add(copy.source.proposal_id);
    byRun.set(copy.source.run_id, set);
  }
  return { state: 'ok', byRun, unreadable };
}

/**
 * run 里「已成候选」的**真实**提案数(**唯一谓词**):该 run 的 `report.json` 暂存的提案编号 ∩ 工作副本 `source.proposal_id`(同 run)。
 * 只认报告里真实存在的编号:工作副本里指向本 run 却不属于它的 `proposal_id`(误写 / 伪造)不会把真实待审提案扣掉。
 * 待审剩余数 = `counts.staged` 的提案数 − 本函数,**仅当** counts 的提案数 = report 暂存编号去重个数时才扣(由 `scanPending` 判,基数不一致 = 转化未知);
 * 读不了工作副本时 `byRun` 为空 → 0(不扣减)。
 */
export function convertedCount(
  converted: ConvertedProposals,
  runId: string,
  stagedIds: readonly string[],
): number {
  const done = converted.byRun.get(runId);
  if (done === undefined) return 0;
  let n = 0;
  for (const id of new Set(stagedIds)) if (done.has(id)) n++;
  return n;
}

/**
 * 从 `<stateDir>` 出发读已成候选的提案:先用只读 `rsiDirReadonly`(真实路径 + `rsi/` 不是链接 / 属主 / 权限)校验 `rsi/` 目录,再进候选扫描。
 * 生产调用方里 hint / notice 的 `stateDir` 来自已校验的 `rsiDir`,但 status / dismiss 在 `rsiDir` 为 null(缺失或不安全)时回落到 `io.stateDir`,
 * 所以校验必须在这里做,不能依赖调用方。`rsi/` 不存在 → `missing`(扣减 0);不安全 / 校验抛错 → `unsafe`(不扣减)。
 */
export async function readConvertedFromState(
  stateDir: string,
  deps: { over?: () => boolean; limits?: ConvertedLimits } = {},
): Promise<ConvertedProposals> {
  let d: Awaited<ReturnType<typeof rsiDirReadonly>>;
  try {
    d = await rsiDirReadonly({ stateDir });
  } catch {
    return unknown('unsafe');
  }
  if (d.kind === 'missing') return { state: 'missing', byRun: new Map(), unreadable: 0 };
  if (d.kind === 'unsafe') return unknown('unsafe');
  return readConvertedProposals(d.dir, deps);
}

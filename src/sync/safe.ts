import { INSTRUCTION_KINDS, type PayloadFile, type PayloadManifest } from '../contracts/payload.js';
import type { SyncLedger } from '../contracts/sync.js';
import { AUTO_SYNC_MAX_OPS, type AUTO_SYNC_DECLINE_REASONS } from '../contracts/update.js';
import { payloadFileSha } from '../build/payload.js';
import { hasInvisibleExtended } from '../lifecycle/invisible.js';
import { scanDangerousPhrases } from '../reflect/validate.js';
import { CODE } from './classify.js';
import { WRITE_OPS, type SyncPlan } from './types.js';

/**
 * S4:`update.auto_sync = "safe"` 的机器可判条件(契约 §19.6,决策 ②B)。纯函数:不读盘、不写盘、不联网。
 *
 * 只对「一份已经生成好的计划 + 对应 payload」下结论;「先拿锁再读登记表、写入前复核指纹」的执行不变量
 * 由调用方(update worker,S7)负责。不放宽:任一条件不满足 → `{ auto: false, reason }`,调用方退回成
 * `SYNC_PENDING` 提示。判定顺序固定,reason 取第一个不满足的条件。
 */

export type AutoSyncDeclineReason = (typeof AUTO_SYNC_DECLINE_REASONS)[number];

export type SafeVerdict = { auto: true } | { auto: false; reason: AutoSyncDeclineReason };

export interface SafeOptions {
  /**
   * 当前登记表。**必须给**:`null` 或缺省都按 `not_installed` 拒绝(自动同步永远不做首次安装),
   * 缺了它也无法判 `major_changed` / `agent_set_expanded`——不能因为调用方漏传就把这三条跳过。
   */
  ledger?: SyncLedger | null;
  /**
   * 调用方已按 §19.6 核对完整性:`integrity.json` 逐文件通过(`loadPayload` 已做),**且其 sha256 等于安装时记下的外部锚点**
   * (锚点在 `update/state.json`,由 S7 的 worker 比对)。不是 `true` 一律 `integrity_unverified`。
   * 本函数自己只能核对「被扫描的字节 == manifest 声明的 sha」,那是自证,不能代替外部锚点。
   */
  integrityVerified?: boolean;
  /** 缺省 `AUTO_SYNC_MAX_OPS`(20) */
  maxOps?: number;
}

const decline = (reason: AutoSyncDeclineReason): SafeVerdict => ({ auto: false, reason });

const major = (v: string): string => v.split(/[.-]/)[0] ?? '';

/** 拒绝类计划码 → 原因码;其余预检类(链接 / 硬链接 / 非常规 / corrupt 块 / 越界)统一 precheck_refused。 */
function refusalReason(plan: SyncPlan): AutoSyncDeclineReason {
  const codes = new Set(plan.codes);
  if (codes.has(CODE.TXN_INCOMPLETE)) return 'txn_incomplete';
  if (codes.has(CODE.LEDGER_INVALID)) return 'ledger_invalid';
  if (codes.has(CODE.SHARED_PATH_CONFLICT)) return 'shared_path_conflict';
  if (codes.has(CODE.PAYLOAD_INVALID) || codes.has(CODE.NO_PAYLOAD)) return 'integrity_unverified';
  return 'precheck_refused';
}

export function evaluateSafeAutoSync(
  plan: SyncPlan,
  manifest: PayloadManifest,
  fileContents: ReadonlyMap<string, string>,
  opts: SafeOptions = {},
): SafeVerdict {
  if (plan.status !== 'ok') return decline(refusalReason(plan));
  const ledger = opts.ledger;
  if (ledger === undefined || ledger === null) return decline('not_installed');
  if (opts.integrityVerified !== true) return decline('integrity_unverified');
  if (major(ledger.kit_version) !== major(manifest.kit_version)) return decline('major_changed');

  // 漂移:跳过 / 孤儿保留,或这次要覆盖漂移内容
  if (
    plan.ops.some(
      (o) => o.op === 'skip_drifted' || o.op === 'orphan_keep' || o.overwroteDrifted === true,
    )
  ) {
    return decline('drifted');
  }
  // 外来冲突
  if (plan.ops.some((o) => o.op === 'refuse_foreign' || o.op === 'unmanaged_keep')) {
    return decline('foreign_conflict');
  }

  // 只要 payload 里存在一个非 instructions 类条目就拒(不论是否在计划内);未知类别按 executable 归类
  if (manifest.files.some((f) => !INSTRUCTION_KINDS.includes(f.kind))) {
    return decline('executable_in_payload');
  }

  const writes = plan.ops.filter((o) => WRITE_OPS.includes(o.op));
  const applied = plan.ops.filter((o) => WRITE_OPS.includes(o.op) || o.op === 'adopt');
  if (applied.length > (opts.maxOps ?? AUTO_SYNC_MAX_OPS)) return decline('too_many_ops');

  const known = new Set(ledger.entries.flatMap((e) => e.agents));
  if (plan.ops.some((o) => o.agents.some((a) => !known.has(a)))) {
    return decline('agent_set_expanded');
  }

  // 要新建 / 更新的文件:对应的全部 payload 条目(同一路径多个 agent 的条目都算)
  const touched: PayloadFile[] = [];
  for (const o of writes) {
    if (o.op === 'remove' || o.op === 'block_remove') continue;
    const hit = manifest.files.filter(
      (f) => f.target === 'home' && f.path === o.path && f.block_id === o.blockId,
    );
    if (hit.length === 0) return decline('integrity_unverified');
    touched.push(...hit);
  }

  if (touched.some((f) => f.atoms.some((a) => a.strength === 'must'))) return decline('must_atom');

  for (const f of touched) {
    const text = fileContents.get(f.payload_path);
    // 被重扫的必须就是将被写入的那份字节:内容缺失或与 manifest 声明的 sha 不符,按完整性未核实处理
    if (text === undefined) return decline('rescan_dirty');
    if (payloadFileSha(f.mode, text, f.block_id) !== f.sha256)
      return decline('integrity_unverified');
    if (scanDangerousPhrases(text).blocked.length > 0 || hasInvisibleExtended(text)) {
      return decline('rescan_dirty');
    }
  }
  return { auto: true };
}

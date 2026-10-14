import type { PayloadManifest } from '../contracts/payload.js';
import { SyncTxnSchema, type SyncOp, type SyncTxn, type SyncTxnOp } from '../contracts/sync.js';
import {
  ManagedBlockError,
  applyManagedBlock,
  inspectManagedBlock,
  parseManagedBlocks,
} from '../render/managed-block.js';
import { sha256Of } from './snapshot.js';
import { WRITE_OPS, type DiskEntry, type PlanOp, type SyncPlan } from './types.js';

/**
 * S4:事务的纯逻辑(不碰文件系统,不 import home-fs):事务 id、由计划算出每个文件写前 / 写后全文
 * (托管块操作补整文件 sha)、事务文档、回滚 / 续跑要用的文件级视图。写盘全部在 apply.ts。
 */

const BOM = '﻿';

export class TxnError extends Error {
  constructor(
    readonly code:
      'SYNC_PAYLOAD_INVALID' | 'SYNC_BLOCK_CORRUPT' | 'SYNC_WRITE_DENIED' | 'SYNC_TXN_INCOMPLETE',
    readonly detail: string,
  ) {
    super(`${code} ${detail}`);
    this.name = 'TxnError';
  }
}

/** `txn-<UTC 时间戳>-<6 位十六进制>`;`hex6` 由调用方给(测试可注入)。 */
export function newTxnId(now: Date, hex6: string): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
  return `txn-${stamp}-${hex6}`;
}

export interface FileEdit {
  path: string;
  beforeSha: string | null;
  beforeText: string | null;
  beforeMode: number | undefined;
  afterSha: string | null;
  afterText: string | null;
}

export interface EditsInput {
  plan: SyncPlan;
  payload: { manifest: PayloadManifest; contents: ReadonlyMap<string, string> } | null;
  texts: ReadonlyMap<string, string>;
  entries: Readonly<Record<string, DiskEntry>>;
  modes: ReadonlyMap<string, number>;
}

/**
 * 去掉一个托管块。块位于文件尾、且前面是 `append` 时加的空行分隔(`\n\n`)时,拿掉那一个分隔换行
 * (与 applyManagedBlock 的追加规则互逆:原文以单个 `\n` 结尾的文件逐字节还原;
 * 原文无结尾换行或以多个空行结尾的文件会差一个换行 —— 已知残余,精确还原用 `--rollback`)。
 */
export function removeBlockText(text: string, id: string): string {
  const r = inspectManagedBlock(text, id);
  if (r.state !== 'intact' && r.state !== 'drifted') {
    throw new TxnError('SYNC_BLOCK_CORRUPT', 'block_not_removable');
  }
  let before = r.before;
  if (r.after === '' && before.endsWith('\n\n')) before = before.slice(0, -1);
  return `${r.bom ? BOM : ''}${before}${r.after}`;
}

function findPayloadFile(
  manifest: PayloadManifest,
  op: PlanOp,
): PayloadManifest['files'][number] | undefined {
  const same = manifest.files.filter(
    (f) => f.target === 'home' && f.path === op.path && f.block_id === op.blockId,
  );
  return same.find((f) => op.agents.includes(f.agent)) ?? same[0];
}

/** 由计划算出每个文件的写前 / 写后全文,以及逐操作的事务条目(整文件 sha)。 */
export function computeEdits(input: EditsInput): { edits: FileEdit[]; ops: SyncTxnOp[] } {
  const cur = new Map<string, string | null>();
  const curSha = new Map<string, string | null>();
  const first = new Map<string, { sha: string | null; text: string | null }>();
  const ops: SyncTxnOp[] = [];
  const load = (path: string): void => {
    if (cur.has(path)) return;
    const e = input.entries[path];
    const text = e?.kind === 'file' ? (input.texts.get(path) ?? null) : null;
    const sha = e?.kind === 'file' ? (e.sha256 ?? null) : null;
    cur.set(path, text);
    curSha.set(path, sha);
    first.set(path, { sha, text });
  };

  for (const op of input.plan.ops) {
    if (!WRITE_OPS.includes(op.op)) continue;
    load(op.path);
    const beforeText = cur.get(op.path) ?? null;
    const beforeSha = curSha.get(op.path) ?? null;
    let afterText: string | null;
    switch (op.op) {
      case 'create':
      case 'update': {
        const pf = input.payload === null ? undefined : findPayloadFile(input.payload.manifest, op);
        const content = pf === undefined ? undefined : input.payload?.contents.get(pf.payload_path);
        if (content === undefined || sha256Of(content) !== op.shaAfter) {
          throw new TxnError('SYNC_PAYLOAD_INVALID', 'content_sha_mismatch');
        }
        afterText = content;
        break;
      }
      case 'remove':
        afterText = null;
        break;
      case 'block_upsert': {
        const pf = input.payload === null ? undefined : findPayloadFile(input.payload.manifest, op);
        const content = pf === undefined ? undefined : input.payload?.contents.get(pf.payload_path);
        const parsed = content === undefined ? undefined : parseManagedBlocks(content);
        const block =
          parsed?.ok === true ? parsed.blocks.find((b) => b.id === op.blockId) : undefined;
        if (block === undefined || block.actualSha !== op.shaAfter) {
          throw new TxnError('SYNC_PAYLOAD_INVALID', 'block_sha_mismatch');
        }
        try {
          afterText = applyManagedBlock(beforeText ?? undefined, op.blockId as string, block.body, {
            onDrift: op.overwroteDrifted === true ? 'overwrite' : 'refuse',
          }).content;
        } catch (e) {
          if (e instanceof ManagedBlockError) throw new TxnError('SYNC_BLOCK_CORRUPT', e.code);
          throw e;
        }
        const check = inspectManagedBlock(afterText, op.blockId as string);
        if (check.state !== 'intact' || check.block.actualSha !== op.shaAfter) {
          throw new TxnError('SYNC_PAYLOAD_INVALID', 'block_result_mismatch');
        }
        break;
      }
      case 'block_remove': {
        if (beforeText === null) throw new TxnError('SYNC_BLOCK_CORRUPT', 'file_missing');
        const rest = removeBlockText(beforeText, op.blockId as string);
        afterText = op.deleteFileIfBlank === true && rest.trim() === '' ? null : rest;
        break;
      }
      default:
        continue;
    }
    const afterSha = afterText === null ? null : sha256Of(afterText);
    cur.set(op.path, afterText);
    curSha.set(op.path, afterSha);
    ops.push({
      op: op.op as SyncOp,
      path: op.path,
      ...(op.blockId !== undefined ? { block_id: op.blockId } : {}),
      file_sha256_before: beforeSha,
      file_sha256_after: afterSha,
      backup: beforeSha !== null,
      overwrote_drifted: op.overwroteDrifted === true,
      agents: [...op.agents],
    });
  }

  const edits: FileEdit[] = [];
  for (const [path, f] of [...first].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const afterText = cur.get(path) ?? null;
    const afterSha = curSha.get(path) ?? null;
    if (afterSha === f.sha) continue;
    edits.push({
      path,
      beforeSha: f.sha,
      beforeText: f.text,
      beforeMode: input.modes.get(path),
      afterSha,
      afterText,
    });
  }
  return { edits, ops };
}

export interface BuildTxnInput {
  txnId: string;
  action: SyncTxn['action'];
  rollbackOf?: string;
  kitVersion: string;
  payloadSha256?: string;
  ledgerShaBefore: string | null;
  startedAt: string;
  ops: SyncTxnOp[];
}

/** 组装并校验事务文档(phase=planned);不合法抛 TxnError。 */
export function buildTxn(input: BuildTxnInput): SyncTxn {
  const doc = {
    schema_version: 1 as const,
    txn_id: input.txnId,
    action: input.action,
    ...(input.rollbackOf !== undefined ? { rollback_of: input.rollbackOf } : {}),
    kit_version: input.kitVersion,
    ...(input.payloadSha256 !== undefined ? { payload_sha256: input.payloadSha256 } : {}),
    ledger_sha256_before: input.ledgerShaBefore,
    started_at: input.startedAt,
    phase: 'planned' as const,
    ops: input.ops,
  };
  const parsed = SyncTxnSchema.safeParse(doc);
  if (!parsed.success) throw new TxnError('SYNC_PAYLOAD_INVALID', 'txn_schema');
  return parsed.data;
}

/** 文件级视图:每个路径的第一个写前 sha 与最后一个写后 sha(同一路径多个 block 操作合并)。 */
export function fileLevel(
  ops: readonly SyncTxnOp[],
): Map<string, { before: string | null; after: string | null }> {
  const out = new Map<string, { before: string | null; after: string | null }>();
  for (const o of ops) {
    const prev = out.get(o.path);
    out.set(o.path, {
      before: prev === undefined ? o.file_sha256_before : prev.before,
      after: o.file_sha256_after,
    });
  }
  return out;
}

/** 回滚事务里的一条:整文件层面的 create / update / remove。 */
export function wholeFileOp(
  path: string,
  before: string | null,
  after: string | null,
  agents: SyncTxnOp['agents'],
): SyncTxnOp {
  const op: SyncOp = before === null ? 'create' : after === null ? 'remove' : 'update';
  return {
    op,
    path,
    file_sha256_before: before,
    file_sha256_after: after,
    backup: before !== null,
    overwrote_drifted: false,
    agents: [...agents],
  };
}

/** 为展示用的计划统计:某个计划里的写操作数。 */
export function writeOpCount(plan: SyncPlan): number {
  return plan.ops.filter((o) => WRITE_OPS.includes(o.op)).length;
}

/**
 * 存储核的**原始读写后端**(账 / 审计 / 压缩文件):解码 = schema + 不变量,编码 = 规范化 JSON,写 = `tmp → 复核锁 → rename`(账 / 压缩 / 审计重写)或单次 `O_APPEND` + fsync(审计追加)。
 * 这里的写函数**不自带事务**:调用方是事务协调器(`txn.ts`),它在每次调用前绑定 token 并复核锁。因此本文件的导出**只许 `src/rsi/store/**` 与存储核自己的测试 import**
 * (`test/rsi/store/arch.test.ts` 钉住;没有 eslint 规则——后写的 `no-restricted-imports` 会整条覆盖 `restrictions()` 的既有配置)。
 *
 * 失败语义:账 / 压缩文件缺失 = 虚拟值(合法);**不合规 / 链接 / 超限 = fail-closed 抛错,不覆盖**;任何写入前先确认压缩状态受支持(`compaction_unsupported` 拒绝一切写)。
 * 写失败:临时文件清理后抛 `store_io`(`detail` = errno 码),目标文件字节不变;锁丢失(`RsiLockError`)原样上抛。
 */
import { canonicalJson } from '../../io/canonical-json.js';
import {
  EMPTY_EFFECTS_LEDGER,
  RSI_AUDIT_COMPACTION_FILE,
  RSI_AUDIT_FILE,
  RSI_AUDIT_READ_MAX_BYTES,
  RSI_EFFECTS_FILE,
  RSI_EFFECTS_LIMITS,
  RSI_LEDGER_REFINE,
  RsiAuditCompactionSchema,
  parseCompactionBytes,
  RsiEffectsLedgerSchema,
  type RsiAuditCompaction,
  type RsiEffectsLedger,
} from '../../contracts/rsi-store.js';
import { RsiLockError } from '../lock-error.js';
import { StoreError } from './errors.js';
import type { StoreFileRead, StoreFs } from './fs-port.js';
import type { AuditTextRead, Watermark } from './ports.js';

export type AssertHeld = () => Promise<void>;

const LEDGER_READ_MAX = RSI_EFFECTS_LIMITS.bytes + 1024 * 1024;
/** 压缩文件的读取上限(字节);写前检查与读取共用这一个常量——写出的文件下一次读取必被接受 */
export const COMPACTION_READ_MAX = 8 * 1024 * 1024;
const REFINE_TOKENS: readonly string[] = Object.values(RSI_LEDGER_REFINE);

/** 把底层 I/O 错误归一为 `store_io`(`detail` = errno 码 / 错误名);已是 `StoreError` / `RsiLockError` 的原样上抛 */
export function ioError(e: unknown): Error {
  if (e instanceof StoreError || e instanceof RsiLockError) return e;
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return new StoreError('store_io', code ?? (e instanceof Error ? e.name : 'unknown'));
}

/** 严格 UTF-8(非法字节序列 = 抛,不静默替换为 U+FFFD 后被规范化覆盖) */
const strictUtf8 = (bytes: Buffer): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);

export function decodeLedger(bytes: Buffer): RsiEffectsLedger {
  let raw: unknown;
  try {
    raw = JSON.parse(strictUtf8(bytes));
  } catch (e) {
    throw new StoreError('state_invalid', e instanceof TypeError ? 'utf8' : 'json');
  }
  const p = RsiEffectsLedgerSchema.safeParse(raw);
  if (p.success) return p.data;
  const refineCode = p.error.issues.map((i) => i.message).find((m) => REFINE_TOKENS.includes(m));
  throw new StoreError('state_invalid', refineCode ?? 'schema');
}

export function encodeLedger(l: RsiEffectsLedger): string {
  return canonicalJson(l);
}

export function decodeCompaction(bytes: Buffer, today: string): RsiAuditCompaction {
  const r = parseCompactionBytes(bytes, today);
  if (!r.ok) throw new StoreError('compaction_unsupported', r.detail);
  return r.value;
}

export interface StoreBackend {
  readLedger(): Promise<RsiEffectsLedger>;
  commitLedger(next: RsiEffectsLedger, assertHeld: AssertHeld): Promise<void>;
  readAudit(): Promise<AuditTextRead>;
  appendAudit(text: string, assertHeld: AssertHeld): Promise<void>;
  rewriteAudit(text: string, assertHeld: AssertHeld): Promise<void>;
  /** 文件缺失 = `null`;不受支持 → `compaction_unsupported`;读不出 → `compaction_unreadable` */
  readCompaction(): Promise<RsiAuditCompaction | null>;
  readWatermark(): Promise<Watermark>;
  /** B1b `Compactor` 与测试播种用(B1a 不含推进逻辑);要求 `next.gen` = 当前 gen + 1(缺失视为 0) */
  writeCompaction(next: RsiAuditCompaction, assertHeld: AssertHeld): Promise<void>;
}

export function createBackend(fs: StoreFs, clock: () => Date): StoreBackend {
  const today = (): string => clock().toISOString().slice(0, 10);

  const atomicReplace = async (
    name: string,
    text: string,
    assertHeld: AssertHeld,
  ): Promise<void> => {
    await assertHeld();
    try {
      await fs.writeTmp(name, text);
      await assertHeld();
      await fs.commitTmp(name);
    } catch (e) {
      await fs.removeTmp(name).catch(() => undefined);
      throw ioError(e);
    }
  };

  const readLedger = async (): Promise<RsiEffectsLedger> => {
    const r = await fs.read(RSI_EFFECTS_FILE, LEDGER_READ_MAX).catch((e: unknown) => {
      throw ioError(e);
    });
    if (r.kind === 'missing') return EMPTY_EFFECTS_LEDGER;
    if (r.kind === 'unsafe') throw new StoreError('state_invalid', `unsafe:${r.why}`);
    return decodeLedger(r.bytes);
  };

  const readCompaction = async (): Promise<RsiAuditCompaction | null> => {
    let r: StoreFileRead;
    try {
      r = await fs.read(RSI_AUDIT_COMPACTION_FILE, COMPACTION_READ_MAX);
    } catch (e) {
      throw new StoreError('compaction_unreadable', ioError(e).message);
    }
    if (r.kind === 'missing') return null;
    if (r.kind === 'unsafe') throw new StoreError('compaction_unreadable', `unsafe:${r.why}`);
    return decodeCompaction(r.bytes, today());
  };

  /** 任何写之前:压缩状态必须受支持(缺失合法) */
  const guardCompaction = async (): Promise<void> => {
    await readCompaction();
  };

  return {
    readLedger,
    async commitLedger(next, assertHeld) {
      await guardCompaction();
      const p = RsiEffectsLedgerSchema.safeParse(next);
      if (!p.success) throw new StoreError('state_invalid', 'commit_invalid');
      const cur = await readLedger();
      if (next.gen !== cur.gen + 1) throw new StoreError('state_invalid', 'gen_not_sequential');
      const text = encodeLedger(next);
      if (Buffer.byteLength(text, 'utf8') > RSI_EFFECTS_LIMITS.bytes) {
        throw new StoreError('effects_full', 'bytes');
      }
      await atomicReplace(RSI_EFFECTS_FILE, text, assertHeld);
    },
    async readAudit() {
      const r = await fs.read(RSI_AUDIT_FILE, RSI_AUDIT_READ_MAX_BYTES).catch((e: unknown) => {
        throw ioError(e);
      });
      if (r.kind === 'missing') return { kind: 'missing' };
      if (r.kind === 'unsafe') throw new StoreError('audit_bad_line', `unsafe:${r.why}`);
      // 按**字节**找最后一个 LF:其前的完整行严格解码(非法 UTF-8 仍 fail-closed);其后的尾部字节是撕裂尾,不解码
      // (短写可能停在多字节字符中间,整文件解码会让撕裂尾永远修不了)
      const lf = r.bytes.lastIndexOf(0x0a);
      const complete = r.bytes.subarray(0, lf + 1);
      try {
        const text = strictUtf8(complete);
        return lf + 1 < r.bytes.length ? { kind: 'ok', text, torn: true } : { kind: 'ok', text };
      } catch {
        throw new StoreError('audit_bad_line', 'utf8');
      }
    },
    async appendAudit(text, assertHeld) {
      await guardCompaction();
      await assertHeld();
      try {
        await fs.appendSynced(RSI_AUDIT_FILE, text);
      } catch (e) {
        throw ioError(e);
      }
    },
    async rewriteAudit(text, assertHeld) {
      await guardCompaction();
      await atomicReplace(RSI_AUDIT_FILE, text, assertHeld);
    },
    readCompaction,
    async readWatermark() {
      const c = await readCompaction();
      return c === null ? { through: null, gen: 0 } : { through: c.through, gen: c.gen };
    },
    async writeCompaction(next, assertHeld) {
      const p = RsiAuditCompactionSchema.safeParse(next);
      if (!p.success) throw new StoreError('compaction_unsupported', 'commit_invalid');
      const cur = await readCompaction();
      if (next.gen !== (cur?.gen ?? 0) + 1)
        throw new StoreError('compaction_unsupported', 'gen_not_sequential');
      // 与读侧同一份语义校验(I1:through 须早于今日)——不得写出下一次读取就拒绝的文件;I4:水位线不回退
      const text = canonicalJson(next); // 只编码一次:校验与落盘用同一份文本
      const bytes = Buffer.from(text, 'utf8');
      // P2 之前拒绝超过读取上限的文件:提交后读不回来 = 后续所有写事务与续做都被堵死;拒绝时旧压缩文件不动
      if (bytes.length > COMPACTION_READ_MAX)
        throw new StoreError('compaction_unsupported', 'too_large');
      decodeCompaction(bytes, today());
      if (
        cur?.through !== undefined &&
        cur.through !== null &&
        (next.through === null || next.through < cur.through)
      ) {
        throw new StoreError('compaction_unsupported', 'through_regressed');
      }
      await atomicReplace(RSI_AUDIT_COMPACTION_FILE, text, assertHeld);
    },
  };
}

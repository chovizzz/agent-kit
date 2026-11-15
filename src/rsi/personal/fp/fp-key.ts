/**
 * `FpKeyPort` 的真实现(`.state/rsi/fp.key`;R21-11.2):0600、32 字节随机、首建 `createExclusive`(持 `rsi/lock`)。
 *  - `read()`:只读(不建目录、不 chmod);句柄级安全读取(不跟随链接、普通文件、`nlink == 1`、属主与权限 ≤ 0600、上限 33 字节);
 *    缺失 → `absent`;长度 ≠ 32 / 不安全 → `invalid`;返回的 key 是副本;
 *  - `ensure(held)`:**第一行**复核锁(目录准备也是写);已存在有效 → `exists`;已存在但无效 → 抛 {@link FpKeyInvalidError},**不覆盖**;
 *    缺失 → 首建;`EEXIST`(并发首建)→ 重读一次:有效 = `exists`,否则抛 {@link FpKeyInvalidError}。
 * 错误文本固定,不含密钥内容。工厂创建与 import 不读盘。
 * 残余(如实):首建在 `createExclusive` 与写入之间崩溃会留下空文件 = `invalid`,本端口**不自动清理**(重建会使账里的 `fp_hmac` 失效),需人工处置。
 * `ensure` 的并发安全靠调用方持 `rsi/lock`;无锁并发首建不在契约内(败者可能读到胜者尚未写完的空文件而判 `invalid`)。
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { RSI_FILE_MODE } from '../../../contracts/rsi.js';
import type { IoContext } from '../../../io/paths.js';
import { readFileSafe } from '../../../io/read-fs.js';
import { createExclusiveSynced, fsyncDir } from '../../../io/safe-fs.js';
import { RSI_FILE_OWNER, rsiDirReadonly } from '../../lock-read.js';
import { rsiDir } from '../../rsi-dir.js';
import type { FpKeyPort, FpKeyRead } from './fp-ports.js';

export const FP_KEY_FILE = 'fp.key';
export const FP_KEY_BYTES = 32;

export class FpKeyInvalidError extends Error {
  readonly code = 'RSI_FP_KEY_INVALID';
  constructor() {
    super('fp.key exists but is invalid; refusing to overwrite');
  }
}

export interface FpKeyPortDeps {
  io: IoContext;
  /** 测试缝:缺省 32 字节 CSPRNG */
  randomKey?: () => Uint8Array;
  /** 测试缝:`read` 与 `createExclusive` 之间(演练并发首建) */
  beforeCreate?: () => Promise<void> | void;
}

export function makeFpKeyPort(d: FpKeyPortDeps): FpKeyPort {
  async function read(): Promise<FpKeyRead> {
    const dir = await rsiDirReadonly(d.io);
    if (dir.kind === 'missing') return { kind: 'absent' };
    if (dir.kind === 'unsafe') return { kind: 'invalid' };
    const r = await readFileSafe(path.join(dir.dir, FP_KEY_FILE), {
      maxBytes: FP_KEY_BYTES + 1,
      owner: RSI_FILE_OWNER,
    });
    if (r.kind === 'missing') return { kind: 'absent' };
    if (r.kind === 'unsafe') return { kind: 'invalid' };
    if (r.bytes.length !== FP_KEY_BYTES) return { kind: 'invalid' };
    return { kind: 'ok', key: Uint8Array.from(r.bytes) };
  }

  async function ensure(held: {
    rsi: { assertHeld(): Promise<void> };
  }): Promise<'created' | 'exists'> {
    await held.rsi.assertHeld();
    const dir = await rsiDir(d.io);
    const cur = await read();
    if (cur.kind === 'ok') return 'exists';
    if (cur.kind === 'invalid') throw new FpKeyInvalidError();
    const key = (d.randomKey ?? ((): Uint8Array => Uint8Array.from(randomBytes(FP_KEY_BYTES))))();
    if (key.length !== FP_KEY_BYTES) throw new FpKeyInvalidError();
    await d.beforeCreate?.();
    await held.rsi.assertHeld();
    try {
      await createExclusiveSynced(d.io, path.join(dir, FP_KEY_FILE), key, RSI_FILE_MODE);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const again = await read();
      if (again.kind === 'ok') return 'exists';
      throw new FpKeyInvalidError();
    }
    await fsyncDir(d.io, dir);
    return 'created';
  }

  return { read, ensure };
}

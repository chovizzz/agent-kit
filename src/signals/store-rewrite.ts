/**
 * 信号库 / 会话计数月文件的按 key 过滤重写(R20-A2 B5 方案 §6.1;B5c 实装)。提交侧,信号库与会话计数共用。
 *
 * 只重写、**永不删除**月文件(D5):没有命中行 → `'unchanged'`(零写入、字节不变);有命中 → 写 `<file>.tmp` 再 rename,全部删光也留下一个空文件(空文件对快照清单合法)。
 * 两遍:第 1 遍只数命中(同时严格校验每一行);第 2 遍同路径重新打开,核对句柄身份 `(dev, ino, size)` 与第 1 遍相同(中途被换文件 → 当作损坏),
 * 把未命中的原始行字节(逐字节原样,不重新序列化)分块追加进临时文件。rename 之前再用 `lstat` 复核目标仍是同一个 `(dev, ino)` 的普通文件。
 *
 * 每个写点(清旧临时文件 / 建临时文件 / 每次追加 / rename)之前先 `gate(op, path)`(生产传「`assertHeld` + 测试钩子」),钩子抛错 = 该写点之后零写入。
 * 硬链接 / 符号链接 / 非普通文件(打开即拒)、坏行、缺尾换行、中途换文件 → {@link SignalStoreError};safe-fs 的路径守卫拒绝抛 `WriteDeniedError`
 * (调用方映射为 `signal_store_corrupt` / `write_denied`)。
 */
import type { IoContext } from '../io/paths.js';
import { lstat } from '../io/read-fs.js';
import { appendFile, createExclusive, remove, rename } from '../io/safe-fs.js';
import { scanMonthFile } from './store-scan.js';
import { SignalStoreError, type WriteGate } from './state-store.js';

const APPEND_CHUNK_BYTES = 1024 * 1024;
const NEWLINE = Buffer.from('\n');

export async function rewriteMonthFileWithout(
  io: IoContext,
  absPath: string,
  keys: ReadonlySet<string>,
  keyOf: (line: unknown) => string | null,
  gate: WriteGate,
): Promise<'unchanged' | { removed: number }> {
  // 第 1 遍:只数命中
  let hits = 0;
  const id1 = await scanMonthFile(absPath, (_raw, v) => {
    const k = keyOf(v);
    if (k === null) return false;
    if (keys.has(k)) hits++;
    return true;
  });
  if (id1 === null || hits === 0) return 'unchanged';

  const tmp = `${absPath}.tmp`;
  await gate('tmp-remove', tmp); // 上次崩溃留下的临时文件
  await remove(io, tmp);
  await gate('tmp-create', tmp);
  await createExclusive(io, tmp, '', 0o600);

  // 第 2 遍:同路径重开,核对身份,未命中的行原样攒块追加(边读边写,不整份进内存)
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const flush = async (): Promise<void> => {
    if (pendingBytes === 0) return;
    const data = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    await gate('tmp-append', tmp);
    await appendFile(io, tmp, data, { mode: 0o600 });
  };
  let removed = 0;
  const id2 = await scanMonthFile(absPath, async (raw, v) => {
    const k = keyOf(v);
    if (k === null) return false;
    if (keys.has(k)) {
      removed++;
    } else {
      pending.push(raw, NEWLINE);
      pendingBytes += raw.length + 1;
      if (pendingBytes >= APPEND_CHUNK_BYTES) await flush();
    }
    return true;
  });
  if (id2 === null || id2.dev !== id1.dev || id2.ino !== id1.ino || id2.size !== id1.size) {
    throw new SignalStoreError('月文件在重写过程中被替换');
  }
  if (removed !== hits) throw new SignalStoreError('月文件在重写过程中被改动');
  await flush();

  // rename 前复核目标仍是同一个文件(先过写点闸,复核紧贴 rename,中间不再有钩子 / 异步间隙)
  await gate('rename', absPath);
  const st = await lstat(absPath).catch(() => null);
  if (
    st === null ||
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.dev !== id1.dev ||
    st.ino !== id1.ino ||
    st.size !== id1.size ||
    st.nlink !== 1
  ) {
    throw new SignalStoreError('月文件在重写过程中被替换');
  }
  await rename(io, tmp, absPath);
  return { removed };
}

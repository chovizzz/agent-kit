/**
 * purge journal 的读 / 写 / 删(R20-A2 B5 方案 §6.1;B5c 实装)。tmp + rename,0600,每个写点经 `Writer.op`(钩子 → `assertHeld` → 写)。
 * 全仓库**唯一**允许对 `purge-journal.json` 调写出口的文件(B5a 的静态用例 `b5a-journal-unreachable.test.ts` 以此为白名单,方案 §0.5 R7)。
 *
 * journal 不在快照清单的名字白名单里(清单只含 `state / projects / cursor / counts.json` 与月文件),所以它在 `commitUnderLock` 之后写 / 删不违反「提交之后不写受清单管辖的文件」,
 * 删掉它之后 `inspectSnapshot` 仍是 `consistent`。
 *
 * 读:{@link readPurgeJournal} 与 `taint.ts` 里私有的 `readJournal` 同口径(`rsi/` 不存在 = absent;读不出 / 元数据不合规 / 链接 = unreadable;能读但过不了
 * `RsiPurgeJournalSchema`(含超过 8MiB)= invalid)。`taint.ts` 不改,所以这里自带一份。
 */
import * as path from 'node:path';
import { RsiPurgeJournalSchema, type RsiPurgeJournal } from '../../contracts/rsi.js';
import { canonicalJson } from '../../io/canonical-json.js';
import type { IoContext } from '../../io/paths.js';
import { readFileSafe } from '../../io/read-fs.js';
import { createExclusive, remove, rename } from '../../io/safe-fs.js';
import { RSI_FILE_OWNER, rsiDirReadonly, type RsiLockHandle } from '../lock.js';
import type { RsiServiceCtx } from '../types.js';
import { assertLockBelongs } from './lock-scope.js';
import { Writer, type ServiceHooks } from './staging.js';

const JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
const JOURNAL_FILE = 'purge-journal.json';

export type PurgeJournalRead =
  | { state: 'absent' }
  | { state: 'present'; journal: RsiPurgeJournal }
  | { state: 'invalid' }
  | { state: 'unreadable' };

/** 只读;不拿锁、不写、不建目录。「读不出」不得当 absent */
export async function readPurgeJournal(io: IoContext): Promise<PurgeJournalRead> {
  let d;
  try {
    d = await rsiDirReadonly(io);
  } catch {
    return { state: 'unreadable' };
  }
  if (d.kind === 'missing') return { state: 'absent' };
  if (d.kind === 'unsafe') return { state: 'unreadable' };
  let r;
  try {
    r = await readFileSafe(path.join(d.dir, JOURNAL_FILE), {
      maxBytes: JOURNAL_MAX_BYTES,
      owner: RSI_FILE_OWNER,
    });
  } catch {
    return { state: 'unreadable' };
  }
  if (r.kind === 'missing') return { state: 'absent' };
  if (r.kind === 'unsafe') return { state: r.why === 'too_large' ? 'invalid' : 'unreadable' };
  try {
    const p = RsiPurgeJournalSchema.safeParse(JSON.parse(r.bytes.toString('utf8')));
    return p.success ? { state: 'present', journal: p.data } : { state: 'invalid' };
  } catch {
    return { state: 'invalid' };
  }
}

/** 原子写(创建或替换,含把 invalid 文件替换成合法 journal):清旧临时文件 → 建临时文件 → rename(提交点);三个写点各自 `assertHeld` */
export async function writePurgeJournal(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  journal: RsiPurgeJournal,
  hooks: ServiceHooks = {},
): Promise<void> {
  const dir = await assertLockBelongs(ctx, lock);
  const body = canonicalJson(RsiPurgeJournalSchema.parse(journal));
  const dest = path.join(dir, JOURNAL_FILE);
  const tmp = `${dest}.tmp`;
  const w = new Writer(ctx.io, lock, hooks);
  await w.op('tmp-remove:purge-journal', () => remove(ctx.io, tmp));
  await w.op('tmp-write:purge-journal', () => createExclusive(ctx.io, tmp, body, 0o600));
  await w.op('rename:purge-journal', () => rename(ctx.io, tmp, dest));
}

/** 删 journal(及残留临时文件);已不存在也不报错 */
export async function removePurgeJournal(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  hooks: ServiceHooks = {},
): Promise<void> {
  const dir = await assertLockBelongs(ctx, lock);
  const dest = path.join(dir, JOURNAL_FILE);
  const w = new Writer(ctx.io, lock, hooks);
  await w.op('remove:purge-journal', () => remove(ctx.io, dest));
  await w.op('remove:purge-journal-tmp', () => remove(ctx.io, `${dest}.tmp`));
}

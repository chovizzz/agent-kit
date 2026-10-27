/**
 * `.state/rsi/` 里三个固定文件(`projects.json` / `state.json` / `cursor.json`)的持锁写入,以及盐首建崩溃留下的空文件的回收(R20-A2 B4c2;R20-6.9、D10、D15、D16)。
 * `counts.json` 由 `commit.ts` 的 `writeCountsProjectionWith` 写,快照清单由 `commitUnderLock` 写,这里不重复。
 *
 * 每个写点:`hook(before:<名>)` → `lock.assertHeld()` → 单次写(经 {@link Writer.op},与 B3c 的服务同一套)。数据文件一律临时文件 + rename;`rename` 是提交点。
 * 钩子(`ServiceHooks.point`)只给测试;生产由 `run.ts` 把「`beforeWrite` + `assertHeld`」适配成同一个入口(见 {@link hooksFromGate})。
 */
import * as path from 'node:path';
import {
  RSI_SALT_EMPTY_GRACE_MS,
  RsiCursorSchema,
  RsiProjectIndexSchema,
  RsiStateSchema,
  type RsiCursor,
  type RsiProjectIndex,
  type RsiState,
} from '../../contracts/rsi.js';
import { canonicalJson } from '../../io/canonical-json.js';
import type { IoContext } from '../../io/paths.js';
import { lstat } from '../../io/read-fs.js';
import { createExclusive, remove, rename } from '../../io/safe-fs.js';
import { SaltError, readSaltFile } from '../../signals/salt-read.js';
import { saltPath } from '../../signals/state-store.js';
import type { BeforeWrite } from '../l0/types.js';
import type { RsiLockHandle } from '../lock.js';
import { parseRsiStateDoc } from '../state.js';
import { RsiFailClosedError, type RsiServiceCtx } from '../types.js';
import { readRsiFixed } from './attribution.js';
import { assertLockBelongs } from './lock-scope.js';
import { Writer, type ServiceHooks } from './staging.js';

/** 把 `BeforeWrite`(`(op, absPath)`)适配成服务层的 `ServiceHooks.point`(只取 `before:` 前缀的写点;路径在服务层不可得,传空串;`after:` 前缀的写点会被丢弃,要在「某次写之后」注入只能靠写点顺序推断) */
export function hooksFromGate(gate: BeforeWrite | undefined): ServiceHooks {
  if (gate === undefined) return {};
  return {
    point: async (name: string): Promise<void> => {
      if (name.startsWith('before:')) await gate(name.slice('before:'.length), '');
    },
  };
}

export type FixedJsonName = 'projects.json' | 'state.json' | 'cursor.json';

async function writeFixed(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  name: FixedJsonName,
  body: string,
  hooks: ServiceHooks,
): Promise<void> {
  const dir = await assertLockBelongs(ctx, lock);
  const dest = path.join(dir, name);
  const tmp = `${dest}.tmp`;
  const w = new Writer(ctx.io, lock, hooks);
  await w.op(`tmp-remove:${name}`, () => remove(ctx.io, tmp)); // 上次崩溃留下的临时文件
  await w.op(`tmp-write:${name}`, () => createExclusive(ctx.io, tmp, body, 0o600));
  await w.op(`rename:${name}`, () => rename(ctx.io, tmp, dest)); // rename 是提交点
}

export async function writeIndexFile(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  index: RsiProjectIndex,
  hooks: ServiceHooks = {},
): Promise<void> {
  await writeFixed(
    ctx,
    lock,
    'projects.json',
    canonicalJson(RsiProjectIndexSchema.parse(index)),
    hooks,
  );
}

export async function writeCursorFile(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  cursor: RsiCursor,
  hooks: ServiceHooks = {},
): Promise<void> {
  await writeFixed(ctx, lock, 'cursor.json', canonicalJson(RsiCursorSchema.parse(cursor)), hooks);
}

/**
 * 写 `state.json`。`rawConfirm !== undefined` = 磁盘上的 `confirm` 单独不合规(B2 的 `confirm_schema_invalid`):整份其余字段照常校验,
 * 坏 `confirm` **按原始 JSON 值透传**回写(不归一成 null、不改其内容),`state.confirm` 必须是 null。
 */
export async function writeStateFile(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  state: RsiState,
  rawConfirm?: unknown,
  hooks: ServiceHooks = {},
): Promise<void> {
  const parsed = RsiStateSchema.parse(state);
  let body: string;
  if (rawConfirm === undefined) {
    body = canonicalJson(parsed);
  } else {
    if (parsed.confirm !== null) throw new RsiFailClosedError('internal');
    body = canonicalJson({ ...parsed, confirm: rawConfirm });
  }
  await writeFixed(ctx, lock, 'state.json', body, hooks);
}

export interface StateForWrite {
  /** 磁盘上的 `state.json`(合法,或仅 confirm 不合规时 `confirm` 置 null);文件不存在 = null */
  prev: RsiState | null;
  /** 仅当磁盘上的 confirm 不合规时有值:那份坏 confirm 的原始 JSON 值 */
  rawConfirm?: unknown;
}

/** 读 `state.json` 供回写:整份过不了 schema → `state_invalid`(与 `rsiStateOf` 同口径,无处记录结果);仅 confirm 不合规 → 保留原始值 */
export async function readStateForWrite(io: IoContext): Promise<StateForWrite> {
  const r = await readRsiFixed(io, 'state.json');
  if (r.kind === 'missing') return { prev: null };
  const doc = parseRsiStateDoc(r.bytes);
  if (doc.kind === 'invalid' || doc.kind === 'absent')
    throw new RsiFailClosedError('state_invalid');
  if (doc.kind === 'ok') return { prev: doc.state };
  const raw = (JSON.parse(r.bytes.toString('utf8')) as { confirm: unknown }).confirm;
  return { prev: { ...doc.state, confirm: null }, rawConfirm: raw };
}

/**
 * D15:盐首建(`createExclusive` 之后、写入内容之前)崩溃留下的**空普通文件**,持锁且 mtime 已满 `RSI_SALT_EMPTY_GRACE_MS` 才删除(之后由调用方重建)。
 * 返回:`reclaimed`(已删,可重建)/ `young`(不足宽限,可能是另一个进程正在写:调用方按 `salt_invalid` 处理,不删)。
 * 先 `assertHeld()` 再删;不持有锁的调用方到不了这里(类型要求锁句柄,不传编译不过)。非空 / 非普通文件 / 违规都不在这里处理(`readSaltFile` 已抛 `SaltError`)。
 */
export async function reclaimEmptySalt(
  ctx: RsiServiceCtx,
  lock: RsiLockHandle,
  nowMs: number,
  hooks: ServiceHooks = {},
): Promise<'reclaimed' | 'young' | 'not_empty'> {
  await assertLockBelongs(ctx, lock);
  let r;
  try {
    r = await readSaltFile(ctx.io.stateDir);
  } catch (e) {
    if (e instanceof SaltError) throw new RsiFailClosedError('salt_invalid');
    throw e;
  }
  if (r.kind !== 'empty') return 'not_empty';
  if (nowMs - r.mtimeMs < RSI_SALT_EMPTY_GRACE_MS) return 'young';
  const file = saltPath(ctx.io);
  // 删除前复核它仍是空的普通文件(readSaltFile 与删除之间别人可能已写好内容)
  const st = await lstat(file);
  if (!st.isFile() || st.size !== 0) return 'not_empty';
  const w = new Writer(ctx.io, lock, hooks);
  // remove 紧邻一次再确认:Writer.op 的顺序是 钩子 → assertHeld → 回调,再确认在回调里(assertHeld 之后),所以上面的 lstat 与这里之间
  // (钩子 / assertHeld)同锁下并发写入的内容能被看到;剩下的窗口只有这次 lstat 与 remove 两个系统调用之间(同 UID、同锁下并发建盐,已登记为残余)。
  // 返回 not_empty 的三种情形(已有内容 / 非普通文件 / 宽限不足)调用方(ensureSalt)一律重读一遍,按读到的结果处理。
  return w.op('salt-remove', async () => {
    const again = await lstat(file);
    if (!again.isFile() || again.size !== 0 || nowMs - again.mtimeMs < RSI_SALT_EMPTY_GRACE_MS) {
      return 'not_empty' as const;
    }
    await remove(ctx.io, file);
    return 'reclaimed' as const;
  });
}

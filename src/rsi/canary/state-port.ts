/**
 * `PauseStatePort` 与 `EntryMarks` 的真实现(装配块 B2;`write/ports.ts` 的契约):**锁绑定**——端口在取锁之前就装配好,写入时经 `assertInsideLocks`
 * 断言「正处于一次持有 `rsi/lock` + `personal/lock` 的期间」(锁外调用 = 抛 `RsiLockError('internal')`,零写入)。
 *
 * `state.json`(`auto_pause` 键):读改写**保留其它全部键**,整份过 `RsiStateSchema`,临时文件 + `rename`(`writeRsiFileAtomic`,每个写点前复核两把锁)。
 * fail-closed:文件不合规 / `confirm` 记录不合规(`confirm_schema_invalid`)/ 文件缺失 → **读**:缺失 = 无熔断(合法),不合规 = 抛 `state_invalid`;**写**:只在文件整份合法时写,
 * **绝不**凭空创建(缺失时没有 `confirm` 等字段可保留)也**绝不**覆盖不合规文件。
 * 入口代数 `EntryMarks.bump`:`entry-gen.json` = `{schema_version: 1, gen}`,单调 +1(幂等语义由调用方的「先于放行」顺序承担),到 `Number.MAX_SAFE_INTEGER` 拒写(不回绕);文件不合规 = 抛 `state_invalid`。
 */
import * as path from 'node:path';
import { z } from 'zod';
import { RsiStateSchema, type RsiState } from '../../contracts/rsi.js';
import { canonicalJson } from '../../io/canonical-json.js';
import type { IoContext } from '../../io/paths.js';
import { readFileSafe } from '../../io/read-fs.js';
import { assertInsideLocks, type CommandLockContext } from '../auto/write/command-locks.js';
import type { EntryMarks } from '../auto/write/ports.js';
import { RSI_FILE_OWNER } from '../lock-read.js';
import { NO_PAUSE, type AutoPauseState, type PauseStatePort } from '../personal/breaker.js';
import { parseRsiStateDoc } from '../state.js';
import { RsiFailClosedError } from '../types.js';
import { writeRsiFileAtomic } from './atomic-write.js';

const STATE_FILE = 'state.json';
export const ENTRY_GEN_FILE = 'entry-gen.json';
const MAX_BYTES = 1024 * 1024;

/** `.state/rsi` 目录解析:**不建目录**;缺失 = `null`;不安全 = 抛 `state_dir_unsafe`。生产 = `rsiDirReadonly` 的包装 */
export type RsiDirResolver = () => Promise<string | null>;

export interface StatePortDeps {
  io: IoContext;
  rsiDir: RsiDirResolver;
  locks: Pick<CommandLockContext, 'current'>;
}

async function readRaw(dirOf: RsiDirResolver, name: string): Promise<Buffer | null> {
  const dir = await dirOf();
  if (dir === null) return null;
  const r = await readFileSafe(path.join(dir, name), {
    maxBytes: MAX_BYTES,
    owner: RSI_FILE_OWNER,
  });
  if (r.kind === 'ok') return r.bytes;
  if (r.kind === 'missing') return null;
  throw new RsiFailClosedError('state_dir_unsafe');
}

const toAutoPause = (s: RsiState | Omit<RsiState, 'confirm'>): AutoPauseState => {
  const ap = s.auto_pause;
  if (ap === undefined) return NO_PAUSE;
  return {
    reasons: [...ap.reasons],
    diverged: ap.diverged,
    owner_changed: ap.owner_changed,
    ...(ap.released_marker_id !== undefined ? { released_marker_id: ap.released_marker_id } : {}),
  };
};

export function makePauseStatePort(d: StatePortDeps): PauseStatePort {
  return {
    async read(): Promise<AutoPauseState> {
      const doc = parseRsiStateDoc(await readRaw(d.rsiDir, STATE_FILE));
      if (doc.kind === 'absent') return NO_PAUSE;
      if (doc.kind === 'invalid') throw new RsiFailClosedError('state_invalid');
      return toAutoPause(doc.state);
    },
    async write(s: AutoPauseState): Promise<void> {
      const held = await assertInsideLocks(d.locks, true);
      // 持锁后重读整份;只在整份合法时改 `auto_pause`,其它键原样保留
      const dir = await d.rsiDir();
      const doc = parseRsiStateDoc(await readRaw(d.rsiDir, STATE_FILE));
      if (dir === null || doc.kind !== 'ok') throw new RsiFailClosedError('state_invalid');
      const next = RsiStateSchema.parse({
        ...doc.state,
        auto_pause: {
          reasons: [...s.reasons],
          diverged: s.diverged,
          owner_changed: s.owner_changed,
          ...(s.released_marker_id !== undefined
            ? { released_marker_id: s.released_marker_id }
            : {}),
        },
      });
      await writeRsiFileAtomic(d.io, dir, STATE_FILE, canonicalJson(next), [
        held.rsi as NonNullable<typeof held.rsi>,
        held.personal,
      ]);
    },
  };
}

const EntryGenSchema = z.strictObject({
  schema_version: z.literal(1),
  gen: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export function makeEntryMarks(d: StatePortDeps): EntryMarks {
  return {
    async bump(): Promise<number> {
      const held = await assertInsideLocks(d.locks, true);
      const dir = await d.rsiDir();
      if (dir === null) throw new RsiFailClosedError('state_invalid');
      const raw = await readRaw(d.rsiDir, ENTRY_GEN_FILE);
      let cur = 0;
      if (raw !== null) {
        let json: unknown;
        try {
          json = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new RsiFailClosedError('state_invalid');
        }
        const p = EntryGenSchema.safeParse(json);
        if (!p.success) throw new RsiFailClosedError('state_invalid');
        cur = p.data.gen;
      }
      if (cur >= Number.MAX_SAFE_INTEGER) throw new RsiFailClosedError('state_invalid');
      const gen = cur + 1;
      await writeRsiFileAtomic(
        d.io,
        dir,
        ENTRY_GEN_FILE,
        canonicalJson({ schema_version: 1, gen }),
        [held.rsi as NonNullable<typeof held.rsi>, held.personal],
      );
      return gen;
    },
  };
}

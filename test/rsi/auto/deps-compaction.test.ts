/**
 * 生产读端口 `compaction()`(`deps.ts`):压缩文件必须**严格 UTF-8** 解码——非法字节序列 = 读不出(`unreadable`),与存储核 `parseCompactionBytes` 同口径,
 * 不得先宽松替换为 U+FFFD 再放行(否则同一文件读侧接受、写侧拒绝)。经真实文件与真实 `productionAutoPorts` / `runAutoFamily('report')` 端到端。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFile } from '../../../src/io/safe-fs.js';
import { productionAutoPorts } from '../../../src/rsi/auto/deps.js';
import { runAutoFamily } from '../../../src/rsi/auto/entry.js';
import type { RsiEarlyContext } from '../../../src/rsi/types.js';
import { makeRoFx, seed, type RoFx } from '../ro-fixture.js';
import { makeSink } from './auto-fixture.js';

const ctxFor = (f: RoFx, argv: string[], sink = makeSink()): RsiEarlyContext =>
  ({
    argv,
    overlayPath: undefined,
    explicitRoot: undefined,
    env: f.env,
    cwd: f.dir,
    stdout: sink.stdout,
    stderr: sink.stderr,
    isTty: true,
  }) as RsiEarlyContext;

const HEAD =
  '{"schema_version":1,"gen":1,"through":"2026-10-01","months":{"2026-09":{"lines":1,"deleted":1,"derived_missing":0,"by_kind":{"';
const TAIL = '":1},"transition_by_to":{}}}}';
const validBytes = (): Buffer => Buffer.from(`${HEAD}evaluation${TAIL}`, 'utf8');
/** 合法 JSON、所有求和不变量成立,只是 `by_kind` 的键里有一个非法 UTF-8 字节 */
const invalidBytes = (): Buffer =>
  Buffer.concat([Buffer.from(HEAD, 'utf8'), Buffer.from([0xff]), Buffer.from(TAIL, 'utf8')]);

async function world(bytes: Buffer | null): Promise<RoFx> {
  const f = await makeRoFx('b1b-deps-compaction-');
  await seed(f, {});
  if (bytes !== null) {
    await writeFile(f.io, path.join(f.io.stateDir, 'rsi', 'audit-compaction.json'), bytes, {
      mode: 0o600,
    });
  }
  return f;
}

describe('compaction 读端口:严格 UTF-8', () => {
  it('缺失 = absent;合法文件 = ok 且原文不变;非法 UTF-8 = unreadable(正向对照与负向)', async () => {
    const none = await productionAutoPorts(ctxFor(await world(null), []));
    expect(await none.compaction()).toEqual({ kind: 'absent' });
    const good = await productionAutoPorts(ctxFor(await world(validBytes()), []));
    expect(await good.compaction()).toEqual({ kind: 'ok', text: validBytes().toString('utf8') });
    const bad = await productionAutoPorts(ctxFor(await world(invalidBytes()), []));
    expect(await bad.compaction()).toEqual({ kind: 'unreadable' });
  });

  it('端到端 rsi report:非法 UTF-8 的压缩文件 → 退 3 audit_invalid(cause=compaction_unreadable);合法文件 → 退 0', async () => {
    const badSink = makeSink();
    const badCode = await runAutoFamily(
      'report',
      ctxFor(await world(invalidBytes()), ['--json'], badSink),
      { phase: 2 },
    );
    expect(badCode).toBe(3);
    expect(badSink.text().err).toContain('RSI_FAIL_CLOSED reason=audit_invalid');
    expect(badSink.text().out).toContain('cause=compaction_unreadable');
    const okSink = makeSink();
    const okCode = await runAutoFamily(
      'report',
      ctxFor(await world(validBytes()), ['--json'], okSink),
      { phase: 2 },
    );
    expect(okCode).toBe(0);
  });
});

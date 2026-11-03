/**
 * 会话文件打开必须不跟随符号链接、不阻塞在 FIFO 上(openReadonlyLines → read-fs.readLinesSafe)。
 * 被拒的会话在管线里按 read_error 计(errorClass = UnsafeSessionFileError),不能静默当空文件。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hardlink, symlink, writeFile } from '../../src/io/safe-fs.js';
import { UnsafeSessionFileError } from '../../src/io/read-fs.js';
import { createRedactor } from '../../src/redact/index.js';
import { createClaudeReader } from '../../src/readers/claude/index.js';
import { openReadonlyLines } from '../../src/signals/open-readonly.js';
import { processSession } from '../../src/signals/pipeline.js';
import type { ExcludePolicy } from '../../src/signals/exclude.js';
import { genClaude } from '../fixtures/sessions/gen-claude.js';
import { mkfifo } from '../rsi/proc/helper.js';
import { newWork } from './helpers.js';

const policy: ExcludePolicy = {
  decide: async () => ({ action: 'process', projectRoot: '/work/proj-a' }),
} as unknown as ExcludePolicy;

async function collectLines(p: string): Promise<string[]> {
  const out: string[] = [];
  for await (const l of openReadonlyLines(p)) out.push(l);
  return out;
}

/** 超时保护:修复被还原时打开 FIFO 会永远挂住,这里让它以「超时」红,而不是拖死整个套件。 */
async function within<T>(ms: number, p: Promise<T>): Promise<T | 'TIMEOUT'> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<'TIMEOUT'>((res) => {
    t = setTimeout(() => res('TIMEOUT'), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}

describe('openReadonlyLines:安全打开', () => {
  it('正向对照:普通文件、硬链接都能读', async () => {
    const w = await newWork('ro-safe-ok-');
    const f = path.join(w.dir, 'a.jsonl');
    await writeFile(w.io, f, 'x\ny\n');
    expect(await collectLines(f)).toEqual(['x', 'y']);
    const h = path.join(w.dir, 'b.jsonl');
    await hardlink(w.io, f, h);
    expect(await collectLines(h)).toEqual(['x', 'y']);
  });

  it('最终路径是符号链接 → 拒绝(UnsafeSessionFileError why=link),目标内容不被读出', async () => {
    const w = await newWork('ro-safe-link-');
    const real = path.join(w.dir, 'real.jsonl');
    await writeFile(w.io, real, 'SECRET-LINE\n');
    const link = path.join(w.dir, 'link.jsonl');
    await symlink(w.io, real, link);
    const got: string[] = [];
    let err: unknown;
    try {
      for await (const l of openReadonlyLines(link)) got.push(l);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnsafeSessionFileError);
    expect((err as UnsafeSessionFileError).why).toBe('link');
    expect(got).toEqual([]);
  });

  it('FIFO → 不阻塞、拒绝(why=not_regular)', async () => {
    const w = await newWork('ro-safe-fifo-');
    const fifo = path.join(w.dir, 'p.jsonl');
    mkfifo(fifo);
    const r = await within(
      3000,
      collectLines(fifo).then(
        () => 'resolved' as const,
        (e: unknown) => e,
      ),
    );
    expect(r).not.toBe('TIMEOUT');
    expect(r).toBeInstanceOf(UnsafeSessionFileError);
    expect((r as UnsafeSessionFileError).why).toBe('not_regular');
  });

  it('消费者中途 break 后句柄会关:反复 break 远超 fd 上限(macOS 默认 256)次不会 EMFILE;只创建不迭代不打开', async () => {
    const w = await newWork('ro-safe-break-');
    const f = path.join(w.dir, 'big.jsonl');
    await writeFile(w.io, f, 'l\n'.repeat(50_000));
    for (let i = 0; i < 1500; i++) {
      for await (const l of openReadonlyLines(f)) {
        expect(l).toBe('l');
        break;
      }
    }
    for (let i = 0; i < 1500; i++) void openReadonlyLines(f);
    expect(await collectLines(f)).toHaveLength(50_000);
  });

  it('不存在 → 抛 ENOENT 形错误(不当空文件)', async () => {
    const w = await newWork('ro-safe-missing-');
    await expect(collectLines(path.join(w.dir, 'none.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('管线:被拒的会话文件计 read_error', () => {
  const run = async (file: string) =>
    processSession(
      createClaudeReader(),
      { agent: 'claude', path: file, session_ref: 'x', bytes: 0 },
      {
        redactor: createRedactor({ timeout_ms: 5000 }),
        policy,
        salt: 'a'.repeat(32),
        fallbackVersion: undefined,
        maxEventBytes: undefined,
      },
    );

  it('正向对照:普通会话文件 → processed', async () => {
    const w = await newWork('ro-pipe-ok-');
    const g = await genClaude(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 'ok',
      userTexts: ['a'],
      toolCalls: 0,
      failedResults: 0,
      version: '2.1.294',
    });
    expect((await run(g.file)).status).toBe('processed');
  });

  it('符号链接 → read_error / UnsafeSessionFileError,没有信号', async () => {
    const w = await newWork('ro-pipe-link-');
    const g = await genClaude(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 'real',
      userTexts: ['a'],
      toolCalls: 0,
      failedResults: 0,
      version: '2.1.294',
    });
    const link = path.join(w.dir, 'via-link.jsonl');
    await symlink(w.io, g.file, link);
    const r = await run(link);
    expect(r).toMatchObject({
      status: 'read_error',
      errorClass: 'UnsafeSessionFileError',
      signals: [],
    });
  });

  it('FIFO → read_error(不挂)', async () => {
    const w = await newWork('ro-pipe-fifo-');
    const fifo = path.join(w.dir, 'q.jsonl');
    mkfifo(fifo);
    const r = await within(5000, run(fifo));
    expect(r).not.toBe('TIMEOUT');
    expect(r).toMatchObject({ status: 'read_error', errorClass: 'UnsafeSessionFileError' });
  });
});

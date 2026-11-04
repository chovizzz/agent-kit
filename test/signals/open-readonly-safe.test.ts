/**
 * 会话文件打开必须不跟随符号链接、不阻塞在 FIFO 上(openReadonlyLines → read-fs.readLinesSafe)。
 * 被拒的会话在管线里按 read_error 计(errorClass = UnsafeSessionFileError),不能静默当空文件。
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hardlink, mkdirp, symlink, writeFile } from '../../src/io/safe-fs.js';
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

/** home 缺省 = 一个不含任何测试文件的假 HOME(不依赖真实 HOME 在哪) */
async function collectLines(p: string, home = '/nonexistent-fake-home'): Promise<string[]> {
  const out: string[] = [];
  for await (const l of openReadonlyLines(p, home)) out.push(l);
  return out;
}

/** 写文件并按需建父目录 */
async function put(io: Parameters<typeof writeFile>[0], file: string, text: string): Promise<void> {
  await mkdirp(io, path.dirname(file));
  await writeFile(io, file, text);
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
    await mkdirp(w.io, path.join(w.dir, 'fake-home'));
    await symlink(w.io, real, link);
    const got: string[] = [];
    let err: unknown;
    try {
      for await (const l of openReadonlyLines(link, path.join(w.dir, 'fake-home'))) got.push(l);
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

  it('符号链接解析后在 HOME 内 → 放行读取;在 HOME 外 → 拒绝;路径段前缀防冒充(/u2 不在 /u 内)', async () => {
    const w = await newWork('ro-safe-home-');
    const home = path.join(w.dir, 'u');
    const lookalike = path.join(w.dir, 'u2'); // 以 home 为字符串前缀,但不是它的子路径
    await put(w.io, path.join(home, 'real.jsonl'), 'in-home\n');
    await put(w.io, path.join(lookalike, 'real.jsonl'), 'lookalike\n');
    await put(w.io, path.join(w.dir, 'out', 'real.jsonl'), 'outside\n');
    const L = (name: string, target: string, where = w.dir) =>
      symlink(w.io, target, path.join(where, name));
    await L('in.jsonl', path.join(home, 'real.jsonl')); // 链接在 HOME 外、目标在 HOME 内:看目标
    await L('look.jsonl', path.join(lookalike, 'real.jsonl'));
    await L('out.jsonl', path.join(w.dir, 'out', 'real.jsonl'));
    expect(await collectLines(path.join(w.dir, 'in.jsonl'), home)).toEqual(['in-home']);
    for (const n of ['look.jsonl', 'out.jsonl']) {
      await expect(collectLines(path.join(w.dir, n), home), n).rejects.toMatchObject({
        why: 'link',
      });
    }
    // 链接本身也可以在 HOME 内(HOME 外目标仍拒)
    await L('inside-out.jsonl', path.join(w.dir, 'out', 'real.jsonl'), home);
    await expect(collectLines(path.join(home, 'inside-out.jsonl'), home)).rejects.toMatchObject({
      why: 'link',
    });
    // 目标就是 HOME 本身(目录)不算「HOME 内」
    await L('self.jsonl', home);
    await expect(collectLines(path.join(w.dir, 'self.jsonl'), home)).rejects.toMatchObject({
      why: 'link',
    });
  });

  it('二跳链接:整条链解析到最终真实路径后只看最终落点(最终在 HOME 内放行,中间跳在 HOME 外也无妨;最终在外则拒)', async () => {
    const w = await newWork('ro-safe-hop-');
    const home = path.join(w.dir, 'home');
    await put(w.io, path.join(home, 'real.jsonl'), 'final-in\n');
    await put(w.io, path.join(w.dir, 'out.jsonl'), 'final-out\n');
    // hop1(在 HOME 外)→ real(HOME 内);hop2 → hop1
    await symlink(w.io, path.join(home, 'real.jsonl'), path.join(w.dir, 'hop1'));
    await symlink(w.io, path.join(w.dir, 'hop1'), path.join(home, 'hop2'));
    expect(await collectLines(path.join(home, 'hop2'), home)).toEqual(['final-in']);
    // hop1b(HOME 内)→ out(HOME 外);hop2b → hop1b:最终在外 => 拒
    await symlink(w.io, path.join(w.dir, 'out.jsonl'), path.join(home, 'hop1b'));
    await symlink(w.io, path.join(home, 'hop1b'), path.join(home, 'hop2b'));
    await expect(collectLines(path.join(home, 'hop2b'), home)).rejects.toMatchObject({
      why: 'link',
    });
  });

  it('HOME 本身是符号链接路径也能比对(两边都取 realpath)', async () => {
    const w = await newWork('ro-safe-homelink-');
    const realHome = path.join(w.dir, 'real-home');
    await put(w.io, path.join(realHome, 's.jsonl'), 'x\n');
    const homeAlias = path.join(w.dir, 'home-alias');
    await symlink(w.io, realHome, homeAlias);
    await symlink(w.io, path.join(homeAlias, 's.jsonl'), path.join(w.dir, 'l'));
    expect(await collectLines(path.join(w.dir, 'l'), homeAlias)).toEqual(['x']);
    expect(await collectLines(path.join(w.dir, 'l'), realHome)).toEqual(['x']);
  });

  it('HOME 内链接的目标是 FIFO / 目录 → 仍拒(不挂)', async () => {
    const w = await newWork('ro-safe-homefifo-');
    const home = path.join(w.dir, 'home');
    await mkdirp(w.io, path.join(home, 'd'));
    mkfifo(path.join(home, 'p'));
    await symlink(w.io, path.join(home, 'p'), path.join(home, 'lp'));
    await symlink(w.io, path.join(home, 'd'), path.join(home, 'ld'));
    for (const n of ['lp', 'ld']) {
      const r = await within(
        3000,
        collectLines(path.join(home, n), home).then(
          () => 'resolved' as const,
          (e: unknown) => e,
        ),
      );
      expect(r, n).not.toBe('TIMEOUT');
      expect(r, n).toMatchObject({ why: 'not_regular' });
    }
  });

  it('不存在 → 抛 ENOENT 形错误(不当空文件)', async () => {
    const w = await newWork('ro-safe-missing-');
    await expect(collectLines(path.join(w.dir, 'none.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('管线:被拒的会话文件计 read_error', () => {
  const useHome = (home: string): void => {
    vi.stubEnv('KIT_REAL_HOME_OVERRIDE', home);
  };
  afterEach(() => {
    vi.unstubAllEnvs();
  });
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
    await mkdirp(w.io, path.join(w.dir, 'fake-home'));
    useHome(path.join(w.dir, 'fake-home'));
    const r = await run(link);
    expect(r).toMatchObject({
      status: 'read_error',
      errorClass: 'UnsafeSessionFileError',
      signals: [],
    });
  });

  it('会话文件是 HOME 内的符号链接(解析后在 HOME 内)→ processed,计数与直接读一致;HOME 外 → read_error', async () => {
    const w = await newWork('ro-pipe-homelink-');
    const home = path.join(w.dir, 'home');
    const g = await genClaude(w.io, {
      root: path.join(home, 'sessions'),
      cwd: '/work/proj-a',
      id: 'inhome',
      userTexts: ['a', 'b'],
      toolCalls: 1,
      failedResults: 0,
      version: '2.1.294',
    });
    const outside = await genClaude(w.io, {
      root: path.join(w.dir, 'elsewhere'),
      cwd: '/work/proj-a',
      id: 'outhome',
      userTexts: ['a', 'b'],
      toolCalls: 1,
      failedResults: 0,
      version: '2.1.294',
    });
    await mkdirp(w.io, path.join(home, 'links'));
    const inLink = path.join(home, 'links', 'in.jsonl');
    const outLink = path.join(home, 'links', 'out.jsonl');
    await symlink(w.io, g.file, inLink);
    await symlink(w.io, outside.file, outLink);
    useHome(home);
    const direct = await run(g.file);
    const viaLink = await run(inLink);
    expect(direct.status).toBe('processed');
    expect(viaLink.status).toBe('processed');
    expect(viaLink.eventsSeen).toBeGreaterThan(0);
    expect(viaLink.eventsSeen).toBe(direct.eventsSeen);
    expect(viaLink.signals.length).toBe(direct.signals.length);
    expect(await run(outLink)).toMatchObject({
      status: 'read_error',
      errorClass: 'UnsafeSessionFileError',
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

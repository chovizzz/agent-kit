/**
 * 验收 ⑤:reader 只读。fs 层记录会话源目录上的每一次文件操作及其 flags(同 test/signals/readonly.test.ts 的做法);
 * 另外 sha256 / mtime 前后不变,入口垫片只声明 O_RDONLY。单独成文件,因为 vi.mock 对整个测试文件生效。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { stat } from '../../../src/io/read-fs.js';
import { writeFile } from '../../../src/io/safe-fs.js';
import { createClaudeReader } from '../../../src/readers/claude/index.js';
import { setOpenObserver } from '../../../src/signals/open-readonly.js';
import { genClaude } from '../../fixtures/sessions/gen-claude.js';
import { sha256File } from '../../signals/helpers.js';
import { SALT, newWork } from './helpers.js';

interface Call {
  api: string;
  path: string;
  flags: string;
}

const h = vi.hoisted(() => {
  const calls: Call[] = [];
  const READ_OPENERS = ['createReadStream', 'open', 'openSync', 'readFile', 'readFileSync'];
  const OTHER_APIS = [
    'createWriteStream',
    'writeFile',
    'writeFileSync',
    'appendFile',
    'appendFileSync',
    'unlink',
    'unlinkSync',
    'rename',
    'renameSync',
    'rm',
    'rmSync',
    'rmdir',
    'truncate',
    'truncateSync',
    'utimes',
    'utimesSync',
    'futimes',
    'chmod',
    'chmodSync',
    'chown',
    'mkdir',
    'mkdirSync',
    'copyFile',
    'copyFileSync',
    'symlink',
    'symlinkSync',
    'link',
    'linkSync',
    'mkdtemp',
  ];
  function flagsOf(api: string, args: unknown[]): string {
    const a1 = args[1];
    if (api === 'createReadStream' || api === 'readFile' || api === 'readFileSync') {
      const o = a1 as { flags?: string; flag?: string } | string | undefined;
      if (typeof o === 'object' && o !== null) return o.flags ?? o.flag ?? 'r';
      return 'r';
    }
    if (api === 'open' || api === 'openSync') return typeof a1 === 'string' ? a1 : 'r';
    return `WRITE-API:${api}`;
  }
  function wrap(actual: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...actual };
    for (const api of [...READ_OPENERS, ...OTHER_APIS]) {
      const orig = actual[api];
      if (typeof orig !== 'function') continue;
      out[api] = (...args: unknown[]) => {
        const p = args[0];
        if (typeof p === 'string') calls.push({ api, path: p, flags: flagsOf(api, args) });
        return (orig as (...a: unknown[]) => unknown)(...args);
      };
    }
    return out;
  }
  return { calls, READ_OPENERS, OTHER_APIS, wrap };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrapped = h.wrap(actual);
  return { ...wrapped, default: wrapped };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrapped = h.wrap(actual);
  return { ...wrapped, default: wrapped };
});

const READ_FLAGS = new Set(['r', 'rs']);
const under = (dir: string) => (c: Call) =>
  c.path === dir || c.path.startsWith(`${dir}${path.sep}`);

describe('ClaudeReader 只读', () => {
  it('discover + read(含预扫)期间,源目录上的 fs 调用全是只读打开(flags=r),没有任何写类 API;文件 sha256 / mtime 不变', async () => {
    const w = await newWork('cl-ro-');
    const g = await genClaude(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 'ro',
      userTexts: ['a', 'b'],
      toolCalls: 2,
      failedResults: 1,
      version: '2.1.294',
      unknownEvent: true,
      malformedLine: true,
      duplicates: true,
      noTimestamps: true, // 走到 mtime 回退的 stat 分支
    });
    const shaBefore = await sha256File(g.file);
    const mtimeBefore = (await stat(g.file)).mtimeMs;
    h.calls.length = 0;
    const seen: string[] = [];
    const prev = setOpenObserver((e) => seen.push(`${e.flags}:${e.purpose}`));
    try {
      const reader = createClaudeReader();
      const refs = await reader.discover(w.sessions);
      expect(refs).toHaveLength(1);
      const read = reader.read(refs[0]!, { salt: SALT });
      let n = 0;
      for await (const e of read.events) {
        expect(e.ts).toBeTruthy();
        n++;
      }
      expect(n).toBeGreaterThan(0);
      expect(read.counts().user_messages).toBe(2);
    } finally {
      setOpenObserver(prev);
    }
    const onSource = h.calls.filter(under(w.sessions));
    // 正向前提:确实读了会话文件(否则「没有写调用」是空话)
    const reads = onSource.filter((c) => c.path === g.file && c.api === 'createReadStream');
    expect(reads.length).toBeGreaterThanOrEqual(2); // 预扫 + 主读
    for (const c of onSource) {
      expect(
        h.READ_OPENERS.includes(c.api) || c.api === 'createReadStream',
        `${c.api} ${c.path}`,
      ).toBe(true);
      expect(READ_FLAGS.has(c.flags), `${c.api} flags=${c.flags}`).toBe(true);
    }
    expect(onSource.filter((c) => h.OTHER_APIS.includes(c.api))).toEqual([]);
    // 整个过程中(不限源目录)reader 没有发起任何写类 API
    expect(h.calls.filter((c) => h.OTHER_APIS.includes(c.api))).toEqual([]);
    // 入口垫片只声明 O_RDONLY
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.startsWith('O_RDONLY:'))).toBe(true);
    // 文件没动
    expect(await sha256File(g.file)).toBe(shaBefore);
    expect((await stat(g.file)).mtimeMs).toBe(mtimeBefore);
  });

  it('检测器自检:对源目录做一次写,同一套断言能抓到(证明上面不是空断言)', async () => {
    const w = await newWork('cl-ro-self-');
    await genClaude(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 'ro2',
      userTexts: ['a'],
      toolCalls: 0,
      failedResults: 0,
    });
    h.calls.length = 0;
    await writeFile(w.io, path.join(w.sessions, 'planted.txt'), 'x');
    const bad = h.calls.filter(under(w.sessions)).filter((c) => h.OTHER_APIS.includes(c.api));
    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0]?.flags.startsWith('WRITE-API:')).toBe(true);
  });
});

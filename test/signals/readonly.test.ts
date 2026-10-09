/**
 * reader 只读(plan M-5):在 fs 层记录会话源目录上发生的**每一次**文件操作及其 flags。
 * 单独成文件,因为 vi.mock 对整个测试文件生效。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeFile } from '../../src/io/safe-fs.js';
import { setOpenObserver } from '../../src/signals/open-readonly.js';
import { genClaude } from '../fixtures/sessions/gen-claude.js';
import { newWork, runCollect } from './helpers.js';

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
    'chmod',
    'chmodSync',
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
const rec = { calls: h.calls };
const READ_OPENERS = h.READ_OPENERS;
const OTHER_APIS = h.OTHER_APIS;

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

describe('reader 只读(fs 层 flags 记录)', () => {
  it('collect 期间对源目录的所有 fs 调用都是只读打开(flags=r),且没有任何写类 API', async () => {
    const w = await newWork('ro-flags-');
    const g = await genClaude(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 'ro',
      userTexts: ['a', 'b'],
      toolCalls: 1,
      failedResults: 0,
      version: '1.0.0',
    });
    rec.calls.length = 0;
    const seen: string[] = [];
    const prev = setOpenObserver((e) => seen.push(`${e.flags}:${e.purpose}`));
    try {
      const r = await runCollect(w, [
        '--source',
        w.sessions,
        '--agent',
        'claude',
        '--allow-project',
        'proj-a',
      ]);
      expect(r.code, r.err).toBe(0);
    } finally {
      setOpenObserver(prev);
    }
    const onSource = rec.calls.filter(under(w.sessions));
    // 正向前提:确实读了会话文件(否则「没有写调用」是空话)
    const reads = onSource.filter((c) => c.path === g.file && c.api === 'createReadStream');
    expect(reads.length).toBeGreaterThanOrEqual(2); // 预扫 + 主读
    for (const c of onSource) {
      expect(
        READ_OPENERS.includes(c.api) || c.api === 'createReadStream',
        `${c.api} ${c.path}`,
      ).toBe(true);
      expect(READ_FLAGS.has(c.flags), `${c.api} flags=${c.flags}`).toBe(true);
    }
    expect(onSource.filter((c) => OTHER_APIS.includes(c.api))).toEqual([]);
    // 入口垫片也只声明 O_RDONLY
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.startsWith('O_RDONLY:'))).toBe(true);
    // 写操作确实发生了,但只在 state 目录
    const writes = rec.calls.filter((c) => OTHER_APIS.includes(c.api));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every(under(w.state))).toBe(true);
  });

  it('检测器自检:对源目录做一次写,同一套断言能抓到(证明上面不是空断言)', async () => {
    const w = await newWork('ro-selfcheck-');
    await genClaude(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 'ro2',
      userTexts: ['a'],
      toolCalls: 0,
      failedResults: 0,
    });
    rec.calls.length = 0;
    await writeFile(w.io, path.join(w.sessions, 'planted.txt'), 'x');
    const bad = rec.calls.filter(under(w.sessions)).filter((c) => OTHER_APIS.includes(c.api));
    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0]?.flags.startsWith('WRITE-API:')).toBe(true);
  });
});

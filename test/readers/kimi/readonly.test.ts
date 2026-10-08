/**
 * Kimi reader 只读(plan M-5):在 fs 层记录会话目录上每一次文件操作的 flags,
 * 含同级 state.json 的读取。单独成文件,因为 vi.mock 对整个测试文件生效。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createKimiReader } from '../../../src/readers/kimi/index.js';
import { genKimi } from '../../fixtures/sessions/gen-kimi.js';
import { newWork, readAll } from './util.js';

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

const under = (dir: string) => (c: Call) =>
  c.path === dir || c.path.startsWith(`${dir}${path.sep}`);

describe('Kimi reader 只读(fs 层 flags)', () => {
  it('discover + read 期间,会话目录(含 state.json)上只有只读打开,没有任何写类 API', async () => {
    const w = await newWork('kimi-ro-');
    const g = await genKimi(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 'ro',
      userTexts: ['a', 'b'],
      toolCalls: 2,
      failedResults: 1,
      duplicates: true,
    });
    h.calls.length = 0;
    const reader = createKimiReader();
    const refs = await reader.discover(w.sessions);
    const { meta } = await readAll(reader, refs[0]!);
    expect(meta.cwd_hint).toBe('/work/proj-a'); // 正向前提:state.json 确实被读到
    const onSource = h.calls.filter(under(w.sessions));
    const statePath = path.join(path.dirname(path.dirname(path.dirname(g.file))), 'state.json');
    expect(onSource.some((c) => c.path === g.file && c.api === 'createReadStream')).toBe(true);
    expect(onSource.some((c) => c.path === statePath)).toBe(true);
    for (const c of onSource) {
      expect(h.READ_OPENERS.includes(c.api), `${c.api} ${c.path}`).toBe(true);
      expect(['r', 'rs'].includes(c.flags), `${c.api} flags=${c.flags}`).toBe(true);
    }
    expect(onSource.filter((c) => h.OTHER_APIS.includes(c.api))).toEqual([]);
  });
});

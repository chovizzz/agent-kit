/**
 * safe-fs realResolve 的「lstat 之后目标消失」分支(并发释放锁文件)的确定性测试。
 * 并发压力用例(test/rsi/lock-procs.test.ts)只能概率性覆盖它;这里在 realpathSync / lstatSync
 * 里按精确目标同步改动文件系统,每次都走到该分支。单独成文件,因为 vi.mock 对整个测试文件生效。
 */
import * as fsSync from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as safe from '../../src/io/safe-fs.js';
import { WriteDeniedError } from '../../src/io/safe-fs.js';
import { makeTempDir, narrowCtx } from '../helpers/tmp.js';

const h = vi.hoisted(() => ({
  target: '' as string,
  /** 对 target 的 realpathSync 调用:返回路径,或抛错;不设 = 走真实实现 */
  realpath: undefined as undefined | ((actual: () => string) => string),
  /** 对 target 的第 n 次 lstatSync(从 1 起)调用的覆盖;不设 = 走真实实现 */
  lstatAt: undefined as undefined | { n: number; run: (actual: () => unknown) => unknown },
  lstatCalls: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realpathSync = Object.assign(
    (p: string, ...rest: unknown[]) => {
      const real = () => (actual.realpathSync as (...a: unknown[]) => string)(p, ...rest);
      if (h.realpath !== undefined && String(p) === h.target) {
        const run = h.realpath;
        h.realpath = undefined; // 只拦一次
        return run(real);
      }
      return real();
    },
    { native: actual.realpathSync.native },
  );
  const lstatSync = (p: string, ...rest: unknown[]) => {
    const real = () => (actual.lstatSync as (...a: unknown[]) => unknown)(p, ...rest);
    if (h.lstatAt !== undefined && String(p) === h.target) {
      h.lstatCalls += 1;
      if (h.lstatCalls === h.lstatAt.n) return h.lstatAt.run(real);
    }
    return real();
  };
  const wrapped = { ...actual, realpathSync, lstatSync };
  return { ...wrapped, default: wrapped };
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

let dir: string;
let lock: string;
let ctx: ReturnType<typeof narrowCtx>;

beforeEach(async () => {
  ({ dir } = await makeTempDir('safefs-vanish-'));
  ctx = narrowCtx(dir, 'allowed');
  await safe.mkdirp(ctx, path.join(dir, 'allowed'));
  lock = path.join(dir, 'allowed', 'lock');
  await safe.writeFile(ctx, lock, 'x', { mode: 0o600 });
  h.target = lock;
  h.realpath = undefined;
  h.lstatAt = undefined;
  h.lstatCalls = 0;
});

afterEach(() => {
  h.realpath = undefined;
  h.lstatAt = undefined;
  h.target = '';
});

describe('safe-fs:lstat 之后目标消失(并发释放锁)', () => {
  it('realpath 前目标被删除 → 按「不存在」处理,放行,不误报 write_denied', async () => {
    h.realpath = (real) => {
      // 同步删掉目标,再让真实 realpath 自己抛 ENOENT
      fsSync.rmSync(lock);
      return real();
    };
    expect(safe.assertWritable(ctx, lock)).toBe(lock);
  });

  it('realpath 报 ENOENT 且目标已被重新创建成普通文件 → 放行', async () => {
    h.realpath = () => {
      throw errno('ENOENT'); // 目标此刻仍是上面建的普通文件,不是链接
    };
    expect(safe.assertWritable(ctx, lock)).toBe(lock);
  });

  it('realpath 报 ENOENT 但目标此刻是悬空符号链接 → 拒绝', async () => {
    h.realpath = (real) => {
      fsSync.rmSync(lock);
      fsSync.symlinkSync(path.join(dir, 'allowed', 'nowhere'), lock);
      return real();
    };
    expect(() => safe.assertWritable(ctx, lock)).toThrow(WriteDeniedError);
  });

  it.each(['ELOOP', 'EACCES', 'EIO'])('realpath 报 %s → 拒绝', async (code) => {
    h.realpath = () => {
      throw errno(code);
    };
    expect(() => safe.assertWritable(ctx, lock)).toThrow(WriteDeniedError);
  });

  it.each(['EACCES', 'EIO'])(
    'realpath 报 ENOENT 后复核 lstat 报 %s(无法判断是不是链接)→ 拒绝,不是放行',
    async (code) => {
      h.realpath = () => {
        throw errno('ENOENT');
      };
      h.lstatAt = {
        n: 2, // 第 1 次是 realResolve 的 lstat,第 2 次是复核
        run: () => {
          throw errno(code);
        },
      };
      expect(() => safe.assertWritable(ctx, lock)).toThrow(WriteDeniedError);
    },
  );

  it('放行后得到的路径与「目标本来就不存在」时一致', async () => {
    h.realpath = () => {
      throw errno('ENOENT');
    };
    const vanished = safe.assertWritable(ctx, lock);
    await fsp.rm(lock);
    h.realpath = undefined;
    expect(safe.assertWritable(ctx, lock)).toBe(vanished);
  });
});

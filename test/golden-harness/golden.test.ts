import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeTempDir } from '../helpers/tmp.js';
import {
  GoldenMismatchError,
  goldenWriteCtx,
  assertGolden,
  diffGolden,
  isGoldenUpdateRequested,
  renderOutputToTree,
} from './golden.js';
import { out, owned } from '../render-core/fixtures.js';

async function tmpGolden(): Promise<string> {
  const { dir } = await makeTempDir('b06-golden-');
  return path.join(dir, 'golden');
}

const actual = (v = 'one'): Map<string, string> =>
  new Map([
    ['claude/home/a.md', `${v}\n`],
    ['pi/home/b/c.md', 'c\n'],
  ]);

async function seed(dir: string, tree: Map<string, string>): Promise<void> {
  await assertGolden({ goldenDir: dir, actual: tree, update: true });
}

describe('golden 框架', () => {
  it('更新开关来自 vitest 的 -u(布尔值,不读环境变量)', () => {
    expect(typeof isGoldenUpdateRequested()).toBe('boolean');
    const real = expect.getState;
    const fake = (mode: string) => () => ({ snapshotState: { _updateSnapshot: mode } }) as never;
    try {
      expect.getState = fake('all');
      expect(isGoldenUpdateRequested()).toBe(true);
      expect.getState = fake('new');
      expect(isGoldenUpdateRequested()).toBe(false);
      expect.getState = fake('none');
      expect(isGoldenUpdateRequested()).toBe(false);
    } finally {
      expect.getState = real;
    }
  });

  it('缺 golden ⇒ 红,且不会自动创建', async () => {
    const dir = await tmpGolden();
    await expect(
      assertGolden({ goldenDir: dir, actual: actual(), update: false }),
    ).rejects.toBeInstanceOf(GoldenMismatchError);
    expect(await exists(dir)).toBe(false);
  });

  it('显式更新后变绿,且字节与实际一致', async () => {
    const dir = await tmpGolden();
    expect(await assertGolden({ goldenDir: dir, actual: actual(), update: true })).toEqual({
      updated: true,
    });
    expect(await readText(path.join(dir, 'pi/home/b/c.md'))).toBe('c\n');
    expect(await assertGolden({ goldenDir: dir, actual: actual(), update: false })).toEqual({
      updated: false,
    });
  });

  it('内容变而 golden 未更新 ⇒ 红,且 golden 文件未被改', async () => {
    const dir = await tmpGolden();
    await seed(dir, actual());
    const err = await assertGolden({ goldenDir: dir, actual: actual('two'), update: false }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GoldenMismatchError);
    expect((err as GoldenMismatchError).diff.changed).toEqual(['claude/home/a.md']);
    expect(await readText(path.join(dir, 'claude/home/a.md'))).toBe('one\n');
  });

  it('一个字节(行尾空白、CRLF)的差异也红', async () => {
    const dir = await tmpGolden();
    await seed(dir, actual());
    for (const v of ['one \n', 'one\r\n', 'one']) {
      await expect(
        assertGolden({
          goldenDir: dir,
          actual: actual(v).set('claude/home/a.md', v),
          update: false,
        }),
      ).rejects.toBeInstanceOf(GoldenMismatchError);
    }
  });

  it('陈旧 golden(实际已不产出)⇒ 红;更新后被删并清掉空目录', async () => {
    const dir = await tmpGolden();
    await seed(dir, actual());
    const fewer = new Map([['claude/home/a.md', 'one\n']]);
    const d = await diffGolden(dir, fewer);
    expect(d.stale).toEqual(['pi/home/b/c.md']);
    await expect(
      assertGolden({ goldenDir: dir, actual: fewer, update: false }),
    ).rejects.toBeInstanceOf(GoldenMismatchError);
    await assertGolden({ goldenDir: dir, actual: fewer, update: true });
    expect(await exists(path.join(dir, 'pi/home/b/c.md'))).toBe(false);
    expect(await exists(path.join(dir, 'pi'))).toBe(false);
  });

  it('update 开关双向:update=false 绝不写;update=true 才写', async () => {
    const dir = await tmpGolden();
    await seed(dir, actual());
    await assertGolden({ goldenDir: dir, actual: actual('two'), update: false }).catch(
      () => undefined,
    );
    expect(await readText(path.join(dir, 'claude/home/a.md'))).toBe('one\n');
    await assertGolden({ goldenDir: dir, actual: actual('two'), update: true });
    expect(await readText(path.join(dir, 'claude/home/a.md'))).toBe('two\n');
  });

  it('更新模式下 golden 写根只有 goldenDir 本身(兄弟目录、out/、.state/ 都不可写)', async () => {
    const dir = await tmpGolden();
    const parent = path.dirname(dir);
    const ctx = goldenWriteCtx(dir);
    expect(ctx.writeRoots).toEqual([dir]);
    await safe.mkdirp(ctx, dir);
    await safe.writeFile(ctx, path.join(dir, 'ok.txt'), 'x');
    for (const bad of ['sibling.txt', 'out/x.txt', '.state/x.txt', 'golden/../x.txt']) {
      await expect(safe.writeFile(ctx, path.join(parent, bad), 'x')).rejects.toThrow();
      expect(await exists(path.join(parent, bad))).toBe(false);
    }
  });

  it('renderOutputToTree 含 _report.json,报告变化也会让 golden 红', async () => {
    const dir = await tmpGolden();
    const o = out([owned('pi', 'a.md', 'x\n')]);
    await seed(dir, renderOutputToTree(o));
    const o2 = { ...o, report: { ...o.report, sideEffects: ['新副作用'] } };
    await expect(
      assertGolden({ goldenDir: dir, actual: renderOutputToTree(o2), update: false }),
    ).rejects.toBeInstanceOf(GoldenMismatchError);
  });
});

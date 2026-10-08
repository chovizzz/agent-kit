import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exists, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { WriteDeniedError } from '../../src/io/safe-fs.js';
import {
  OutLayoutError,
  assertNoCollisions,
  buildManifest,
  byteCompare,
  listTree,
  outFilePath,
  outFilesToTree,
  readTree,
  sortOutFiles,
  writeOutTree,
} from '../../src/render/out-layout.js';
import { sha256Hex } from '../../src/render/managed-block.js';
import { createIoContext } from '../../src/io/paths.js';
import { makeTempDir } from '../helpers/tmp.js';
import { owned, resolved } from './fixtures.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof OutLayoutError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

describe('out 布局', () => {
  it('路径映射:out/<agent>/<target>/<relPath>,home 不展开成真实 HOME', () => {
    const f = owned('claude', '.claude/rules/agent-kit/org.md', 'x\n');
    expect(outFilePath('/r/out', f)).toBe('/r/out/claude/home/.claude/rules/agent-kit/org.md');
  });

  it('按 UTF-8 字节序排序,与输入顺序无关', () => {
    const names = ['b2.md', 'B1.md', 'a.md', '中.md', 'é.md', 'a/b.md'];
    const files = names.map((n) => owned('codex', n, 'x\n'));
    const expected = [...names].sort(byteCompare);
    expect(sortOutFiles(files).map((f) => f.relPath)).toEqual(expected);
    expect(sortOutFiles([...files].reverse()).map((f) => f.relPath)).toEqual(expected);
    expect(expected.slice(0, 2)).toEqual(['B1.md', 'a.md']);
    expect([...outFilesToTree(files).keys()]).toEqual(expected.map((n) => `codex/home/${n}`));
  });

  it('碰撞:重复 / 仅大小写不同 / 文件与目录冲突', () => {
    const a = owned('pi', 'a.md', 'x\n');
    expect(codeOf(() => assertNoCollisions([a, a]))).toBe('OUT_DUPLICATE');
    expect(codeOf(() => assertNoCollisions([a, owned('pi', 'A.md', 'x\n')]))).toBe(
      'OUT_CASE_COLLISION',
    );
    expect(codeOf(() => assertNoCollisions([a, owned('pi', 'a.md/b.md', 'x\n')]))).toBe(
      'OUT_FILE_DIR_CONFLICT',
    );
    expect(codeOf(() => assertNoCollisions([a, owned('pi', 'b.md', 'x\n')]))).toBeUndefined();
  });

  it('写入 + 读回;重建时清掉陈旧文件;manifest 写在 out 根', async () => {
    const { dir } = await makeTempDir('b06-out-');
    const ctx = createIoContext({ root: dir, cwd: dir, env: { PATH: '/usr/bin:/bin' } });
    const f1 = owned('claude', 'z.md', 'z\n');
    const f2 = owned('claude', 'a/b.md', 'ab\n');
    await writeOutTree(ctx, [f1, f2]);
    expect(await listTree(ctx.outDir)).toEqual(['claude/home/a/b.md', 'claude/home/z.md']);
    await writeOutTree(ctx, [f1]);
    expect(await exists(path.join(ctx.outDir, 'claude/home/a/b.md'))).toBe(false);
    const m = buildManifest([f1], [], { kitVersion: '1', channel: 'canary', skippedLayers: [] });
    await writeOutTree(ctx, [f1], { manifest: m });
    expect(JSON.parse(await readText(path.join(ctx.outDir, 'manifest.json'))).files[0].path).toBe(
      'claude/home/z.md',
    );
    expect((await readTree(ctx.outDir)).get('claude/home/z.md')).toBe('z\n');
  });

  it('写入根之外一律被拒(假 HOME 下无任何产生)', async () => {
    const { dir } = await makeTempDir('b06-out-deny-');
    const fakeHome = path.join(dir, 'fakehome');
    const wide = createIoContext({
      root: dir,
      cwd: dir,
      env: { KIT_TMP: dir, PATH: '/usr/bin:/bin' },
    });
    await safe.mkdirp(wide, fakeHome);
    const narrow = createIoContext({
      root: path.join(dir, 'repo'),
      cwd: dir,
      env: { KIT_TMP: dir, KIT_WRITE_ROOTS: path.join(dir, 'repo/out/x'), PATH: '/usr/bin:/bin' },
    });
    await expect(writeOutTree(narrow, [owned('pi', 'a.md', 'x\n')])).rejects.toBeInstanceOf(
      WriteDeniedError,
    );
    expect(await listTree(fakeHome)).toEqual([]);
  });
});

describe('manifest', () => {
  const meta = { kitVersion: '1.0.0', channel: 'stable', skippedLayers: [] } as const;

  it('sha256 对最终内容的 UTF-8 字节;atoms 带 layer;按路径字节序', () => {
    const a = resolved('rule-a', 'team');
    const fs = [
      owned('pi', 'z.md', '中文\n', ['rule-a']),
      owned('claude', 'a.md', 'x\n', ['rule-a']),
    ];
    const m = buildManifest(fs, [a], meta);
    expect(m.files.map((f) => f.path)).toEqual(['claude/home/a.md', 'pi/home/z.md']);
    expect(m.files[1]?.sha256).toBe(sha256Hex('中文\n'));
    expect(m.files[0]?.atoms).toEqual([{ id: 'rule-a', layer: 'team' }]);
  });

  it('personal 原子进输出 ⇒ 抛错;正向对照:org 原子通过;未知原子抛错', () => {
    const f = owned('pi', 'a.md', 'x\n', ['p1']);
    expect(codeOf(() => buildManifest([f], [resolved('p1', 'personal', false)], meta))).toBe(
      'OUT_PERSONAL_LEAK',
    );
    expect(codeOf(() => buildManifest([f], [resolved('p1', 'org', true)], meta))).toBeUndefined();
    expect(codeOf(() => buildManifest([f], [], meta))).toBe('OUT_UNKNOWN_ATOM');
  });
});

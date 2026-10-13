/** L6:新增文件补丁生成器 `buildAddFilePatch`。补丁一律用真 `git apply --check --whitespace=error` 验证。 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PatchError, buildAddFilePatch, buildModifyPatch } from '../../src/lifecycle/patch.js';
import { readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { gitBlobOid } from '../../src/reflect/stage.js';
import { makeTestRepo } from '../helpers/make-repo.js';
import type { TestRepo } from '../helpers/make-repo.js';

const repos: TestRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.dispose()));
});

const FILE = 'lifecycle/some-rule/2026-10-25-run-20261025T000000Z-abc123.json';

function code(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof PatchError) return e.code;
    throw e;
  }
  return 'NO_THROW';
}

describe('buildAddFilePatch', () => {
  it('git apply --check --whitespace=error 通过,应用后内容逐字节相同,index 行写新 blob 前 12 位', async () => {
    const repo = await makeTestRepo('addpatch-');
    repos.push(repo);
    await repo.commit({ 'README.md': 'x\n' }, 'init');
    for (const content of ['{"a":1}\n', '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n']) {
      const patch = buildAddFilePatch(FILE, content);
      expect(patch).toContain(`index 0000000..${gitBlobOid(content).slice(0, 12)}\n`);
      expect(patch).toContain('new file mode 100644\n');
      const pf = path.join(repo.dir, '..', 'p.patch');
      await safe.writeFile(repo.io, pf, patch);
      repo.git(['apply', '--check', '--whitespace=error', pf]);
      repo.git(['apply', '--whitespace=error', pf]);
      expect(await readText(path.join(repo.dir, FILE))).toBe(content);
      await safe.remove(repo.io, path.join(repo.dir, FILE));
    }
  });

  it('拒绝:空内容 / 缺结尾换行 / CR / 行尾空白 / 不安全路径(稳定码)', () => {
    expect(code(() => buildAddFilePatch(FILE, ''))).toBe('PATCH_NO_FINAL_NEWLINE');
    expect(code(() => buildAddFilePatch(FILE, '{}'))).toBe('PATCH_NO_FINAL_NEWLINE');
    expect(code(() => buildAddFilePatch(FILE, '{}\r\n'))).toBe('PATCH_CR');
    expect(code(() => buildAddFilePatch(FILE, '{} \n'))).toBe('PATCH_TRAILING_WHITESPACE');
    for (const bad of [
      '../x.json',
      '/abs.json',
      'a b.json',
      'a"b.json',
      '-x.json',
      '',
      'a/../../outside.json',
      'lifecycle/../x.json',
      'a//b.json',
      'a/./b.json',
      'a/b/',
    ]) {
      expect(
        code(() => buildAddFilePatch(bad, '{}\n')),
        bad,
      ).toBe('PATCH_PATH_UNSAFE');
    }
    expect(code(() => buildAddFilePatch(FILE, '{}\n'))).toBe('NO_THROW');
  });

  it('buildModifyPatch 同样逐段拒绝 . / .. / 空段', () => {
    for (const bad of ['rules/../x.md', 'rules//x.md', 'rules/./x.md']) {
      expect(
        code(() => buildModifyPatch(bad, 'a\n', 'b\n')),
        bad,
      ).toBe('PATCH_PATH_UNSAFE');
    }
  });
});

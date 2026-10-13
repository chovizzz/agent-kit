/** L4:修改型补丁生成器。补丁一律用真 `git apply --check --whitespace=error` 在合成仓库里验证。 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PatchError, buildModifyPatch, rewriteFrontmatter } from '../../src/lifecycle/patch.js';
import { readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { gitBlobOid } from '../../src/reflect/stage.js';
import { makeTestRepo } from '../helpers/make-repo.js';
import type { TestRepo } from '../helpers/make-repo.js';

const repos: TestRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.dispose()));
});

const FILE = 'rules/team/sample.md';
const fm = (extra: string[] = [], status = 'proposed', review = '2027-01-08'): string =>
  [
    '---',
    'id: sample',
    'title: 示例',
    'layer: team',
    `status: ${status}`,
    'owner: "@o"',
    ...extra,
    `review_by: ${review}`,
    '---',
    '',
    '**做**:a。',
    '**为什么**:b。',
    '**怎么验**:c。',
    '',
  ].join('\n');

function throwsCode(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof PatchError) return e.code;
    throw e;
  }
  return 'NO_THROW';
}

describe('rewriteFrontmatter', () => {
  it('只改 status(与可选的 review_by)两行的值,其余字节不动;行尾注释与引号保留', () => {
    const t = fm();
    expect(rewriteFrontmatter(t, { status: 'advisory' })).toBe(
      t.replace('status: proposed', 'status: advisory'),
    );
    expect(rewriteFrontmatter(t, { status: 'active', reviewBy: '2027-02-02' })).toBe(
      t.replace('status: proposed', 'status: active').replace('2027-01-08', '2027-02-02'),
    );
    const q = t.replace('status: proposed', "status: 'proposed' # 注释");
    expect(rewriteFrontmatter(q, { status: 'advisory' })).toContain("status: 'advisory' # 注释");
  });

  it('正文里长得像 status: 的行不是目标;frontmatter 里重复 / 缺失 / 复杂写法一律拒绝', () => {
    const body = fm().replace('**做**:a。', 'status: proposed\n**做**:a。');
    expect(
      rewriteFrontmatter(body, { status: 'advisory' })
        .split('\n')
        .filter((l) => l === 'status: proposed'),
    ).toHaveLength(1);
    expect(throwsCode(() => rewriteFrontmatter(fm(['status: x']), { status: 'advisory' }))).toBe(
      'PATCH_STATUS_LINE_COUNT',
    );
    expect(
      throwsCode(() =>
        rewriteFrontmatter(fm().replace('status: proposed\n', ''), { status: 'advisory' }),
      ),
    ).toBe('PATCH_STATUS_LINE_COUNT');
    expect(
      throwsCode(() =>
        rewriteFrontmatter(fm().replace('review_by: 2027-01-08\n', ''), { status: 'advisory' }),
      ),
    ).toBe('PATCH_REVIEW_BY_LINE_COUNT');
    expect(
      throwsCode(() =>
        rewriteFrontmatter(fm().replace('status: proposed', 'status: |\n  proposed'), {
          status: 'advisory',
        }),
      ),
    ).toBe('PATCH_STATUS_LINE_COUNT');
  });

  it('CR / BOM / 缺结尾换行 / 缺 frontmatter / 不安全的值 → 拒绝', () => {
    expect(
      throwsCode(() => rewriteFrontmatter(fm().replace(/\n/g, '\r\n'), { status: 'advisory' })),
    ).toBe('PATCH_CR');
    expect(throwsCode(() => rewriteFrontmatter(`﻿${fm()}`, { status: 'advisory' }))).toBe(
      'PATCH_BOM',
    );
    expect(throwsCode(() => rewriteFrontmatter(fm().slice(0, -1), { status: 'advisory' }))).toBe(
      'PATCH_NO_FINAL_NEWLINE',
    );
    expect(throwsCode(() => rewriteFrontmatter('hello\n', { status: 'advisory' }))).toBe(
      'PATCH_NO_FRONTMATTER',
    );
    expect(throwsCode(() => rewriteFrontmatter(fm(), { status: 'a b' }))).toBe(
      'PATCH_VALUE_UNSAFE',
    );
  });
});

describe('buildModifyPatch', () => {
  async function applyOn(
    oldText: string,
    patch: string,
  ): Promise<{ repo: TestRepo; result: string }> {
    const repo = await makeTestRepo('patch-');
    repos.push(repo);
    await repo.commit({ [FILE]: oldText }, 'base');
    const pf = path.join(path.dirname(repo.dir), 'x.patch');
    await safe.writeFile(repo.io, pf, patch);
    repo.git(['apply', '--check', '--whitespace=error', pf]);
    repo.git(['apply', '--whitespace=error', pf]);
    return { repo, result: await readText(path.join(repo.dir, FILE)) };
  }

  it('相邻两行(status + review_by 紧挨)→ 一个 hunk;git apply --check 通过且结果等于新文本', async () => {
    const oldT = fm();
    const newT = rewriteFrontmatter(oldT, { status: 'active', reviewBy: '2027-02-02' });
    const patch = buildModifyPatch(FILE, oldT, newT);
    expect(patch.match(/^@@ /gm)).toHaveLength(1);
    expect(patch).toContain(
      `index ${gitBlobOid(oldT).slice(0, 12)}..${gitBlobOid(newT).slice(0, 12)} 100644\n`,
    );
    const { repo, result } = await applyOn(oldT, patch);
    expect(result).toBe(newT);
    // 与 git 自己对同一变更给出的 diff 逐字一致(除 index 行的缩写长度)
    const d = repo.git(['diff', '--no-color', '--unified=3', '--', FILE]);
    expect(d.slice(d.indexOf('--- a/'))).toBe(patch.slice(patch.indexOf('--- a/')));
  });

  it('相距很远的两处改动 → 两个 hunk,各带 3 行上下文;apply 通过', async () => {
    const oldT = fm(Array.from({ length: 20 }, (_, i) => `k${i}: v${i}`));
    const newT = rewriteFrontmatter(oldT, { status: 'active', reviewBy: '2027-02-02' });
    const patch = buildModifyPatch(FILE, oldT, newT);
    expect(patch.match(/^@@ /gm)).toHaveLength(2);
    expect((await applyOn(oldT, patch)).result).toBe(newT);
  });

  it('index 行的旧 oid 等于 git 对 HEAD blob 的 oid', async () => {
    const oldT = fm();
    const repo = await makeTestRepo('patch-');
    repos.push(repo);
    await repo.commit({ [FILE]: oldT }, 'base');
    const oid = repo.git(['rev-parse', `HEAD:${FILE}`]).trim();
    const patch = buildModifyPatch(FILE, oldT, rewriteFrontmatter(oldT, { status: 'advisory' }));
    expect(patch).toContain(`index ${oid.slice(0, 12)}..`);
  });

  it('拒绝:行数变化 / 无变化 / 路径不安全 / 新行带行尾空白 / CR', () => {
    const oldT = fm();
    expect(throwsCode(() => buildModifyPatch(FILE, oldT, `${oldT}x\n`))).toBe(
      'PATCH_LINE_COUNT_CHANGED',
    );
    expect(throwsCode(() => buildModifyPatch(FILE, oldT, oldT))).toBe('PATCH_EMPTY');
    expect(
      throwsCode(() => buildModifyPatch('../x.md', oldT, oldT.replace('proposed', 'advisory'))),
    ).toBe('PATCH_PATH_UNSAFE');
    expect(
      throwsCode(() =>
        buildModifyPatch(FILE, oldT, oldT.replace('status: proposed', 'status: advisory ')),
      ),
    ).toBe('PATCH_TRAILING_WHITESPACE');
    expect(
      throwsCode(() => buildModifyPatch(FILE, oldT, oldT.replace('proposed\n', 'advisory\r\n'))),
    ).toBe('PATCH_CR');
  });

  it('补丁顺带改正文一行 → 守卫 G3 另报(见 promote.test.ts 的变异);这里确认补丁生成器本身会如实输出多个 hunk', () => {
    const oldT = fm();
    const newT = rewriteFrontmatter(oldT, { status: 'advisory' }).replace(
      '**做**:a。',
      '**做**:被改。',
    );
    const patch = buildModifyPatch(FILE, oldT, newT);
    expect(patch).toContain('-**做**:a。');
    expect(patch).toContain('+**做**:被改。');
  });
});

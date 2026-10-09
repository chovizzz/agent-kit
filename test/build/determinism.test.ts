import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { fullFiles, makeSandbox, outTree, resetBuildDeps, runBuild, writeRepo } from './helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
  resetBuildDeps();
});

const ISO_TS = /20[0-9]{2}-[0-9]{2}-[0-9]{2}T/;

describe('确定性(A1)', () => {
  it('同输入两次 build,out/ 树逐字节相同;第二次覆盖第一次也不变', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const a = await outTree(root);
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const b = await outTree(root);
    expect(a.size).toBeGreaterThan(5);
    expect([...b]).toEqual([...a]);
  });

  it('换仓库位置(路径长度/名字不同)、换 cwd、子目录里用 --root:树都相同', async () => {
    const sb = await makeSandbox();
    const files = await fullFiles();
    const r1 = await writeRepo(sb, 'a', files);
    const r2 = await writeRepo(sb, 'a-much-longer-directory-name/nested/repo', files);
    await runBuild(sb, r1);
    await runBuild(sb, r2, [], { cwd: path.join(r2, 'rules') });
    const sub = path.join(r1, 'rules/team');
    await runBuild(sb, r1, [], { cwd: sub });
    const base = await outTree(r1);
    expect([...(await outTree(r2))]).toEqual([...base]);
    expect(base.size).toBeGreaterThan(5);
  });

  it('换 TZ / LANG / LC_ALL:树相同', async () => {
    const sb = await makeSandbox();
    const files = await fullFiles();
    const r0 = await writeRepo(sb, 'base', files);
    await runBuild(sb, r0);
    const base = await outTree(r0);
    for (const [name, env] of [
      ['tz', { TZ: 'Asia/Shanghai' }],
      ['tz-neg', { TZ: 'America/Los_Angeles' }],
      ['lang', { LANG: 'C', LC_ALL: 'C' }],
      ['lang-zh', { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' }],
    ] as const) {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      const root = await writeRepo(sb, name, files);
      expect((await runBuild(sb, root, [], { env })).code, name).toBe(ExitCode.OK);
      expect([...(await outTree(root))], name).toEqual([...base]);
      vi.unstubAllEnvs();
    }
  });

  it('out/ 内无时间戳 / 绝对路径 / 临时目录名 / 用户名(控制组:扫描器能命中带这些串的文本)', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await runBuild(sb, root, ['--report']);
    const tree = await outTree(root);
    const forbidden = ['/Users/', '/private/', '/var/folders', root, sb.dir, path.basename(sb.dir)];
    const hits = (text: string): string[] => [
      ...forbidden.filter((f) => text.includes(f)),
      ...(ISO_TS.test(text) ? ['iso-ts'] : []),
    ];
    // 控制组
    expect(hits(`x ${root}/y`)).toContain(root);
    expect(hits('at 2026-10-09T03:00:00Z')).toContain('iso-ts');
    expect(hits('/Users/someone/.claude')).toContain('/Users/');
    expect(tree.size).toBeGreaterThan(5);
    for (const [k, v] of tree) {
      expect(hits(k), `路径 ${k}`).toEqual([]);
      expect(hits(v), `内容 ${k}`).toEqual([]);
    }
    expect(hits(await readText(path.join(root, '.state/reports/build.json')))).toEqual([]);
  });

  it('源文件顺序/创建顺序不影响结果(倒序写入同一批文件)', async () => {
    const sb = await makeSandbox();
    const files = await fullFiles();
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    const a = await writeRepo(sb, 'fwd', files);
    const b = await writeRepo(sb, 'rev', reversed);
    expect((await runBuild(sb, a)).code).toBe(ExitCode.OK);
    expect((await runBuild(sb, b)).code).toBe(ExitCode.OK);
    expect((await outTree(a)).size).toBeGreaterThan(5);
    expect([...(await outTree(b))]).toEqual([...(await outTree(a))]);
  });

  it('改一个原子正文 → 恰好相关文件与 manifest 变化,别的文件字节不变(控制组:确定性不是「恒等」)', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await runBuild(sb, root);
    const before = await outTree(root);
    const p = path.join(root, 'rules/org/org-rule.md');
    await safe.writeFile(
      sb.wctx,
      p,
      (await readText(p)).replace('做某件具体的事', '做另一件具体的事'),
    );
    await runBuild(sb, root);
    const after = await outTree(root);
    const changed = [...after.keys()].filter((k) => after.get(k) !== before.get(k));
    expect(changed).toContain('manifest.json');
    expect(changed).toContain('claude/home/.claude/rules/agent-kit/org.md');
    expect(after.get('claude/home/.claude/skills/my-skill/SKILL.md')).toBe(
      before.get('claude/home/.claude/skills/my-skill/SKILL.md'),
    );
  });
});

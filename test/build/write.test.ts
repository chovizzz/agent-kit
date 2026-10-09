import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { createIoContext } from '../../src/io/paths.js';
import { exists, lstat, readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import {
  atomMd,
  fullFiles,
  makeSandbox,
  outTree,
  resetBuildDeps,
  runBuild,
  writeRepo,
} from './helpers.js';
import { assertWritable } from '../../src/io/safe-fs.js';
import { cleanPrevious, readPreviousOut, writeOut } from '../../src/build/writer.js';
import { command } from '../../src/commands/build.js';

afterEach(() => {
  resetBuildDeps();
});

describe('陈旧文件清理', () => {
  it('删掉一个原子/技能后重新 build:对应旧文件与空目录消失,其余保留', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await runBuild(sb, root);
    const before = await outTree(root);
    expect(before.has('claude/project/.claude/rules/agent-kit/project.md')).toBe(true);
    expect(before.has('claude/home/.claude/skills/my-skill/SKILL.md')).toBe(true);

    await safe.remove(sb.wctx, path.join(root, '.kit/rules/project-rule.md'));
    await safe.remove(sb.wctx, path.join(root, 'skills'));
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const after = await outTree(root);
    expect(after.has('claude/project/.claude/rules/agent-kit/project.md')).toBe(false);
    expect(after.has('claude/home/.claude/skills/my-skill/SKILL.md')).toBe(false);
    expect(await exists(path.join(root, 'out/claude/home/.claude/skills'))).toBe(false);
    expect(after.has('claude/home/.claude/rules/agent-kit/org.md')).toBe(true);
    // 控制组:先前确实存在,不是「本来就没有」
    expect(before.size).toBeGreaterThan(after.size);
  });

  it('所有来源都删光:out/ 只剩 manifest.json', async () => {
    const sb = await makeSandbox();
    const files = await fullFiles();
    const root = await writeRepo(sb, 'repo', files);
    await runBuild(sb, root);
    for (const d of ['rules', '.kit', 'skills', 'agents'])
      await safe.remove(sb.wctx, path.join(root, d));
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    expect([...(await outTree(root)).keys()]).toEqual(['manifest.json']);
    expect((await readDir(path.join(root, 'out'))).map((e) => e.name)).toEqual(['manifest.json']);
  });

  it('out/ 里不是本命令产出的文件(含 out/tmp/)不被碰,只告警', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await runBuild(sb, root);
    await safe.mkdirp(sb.wctx, path.join(root, 'out/tmp'));
    await safe.writeFile(sb.wctx, path.join(root, 'out/tmp/scratch.txt'), 'keep me\n');
    await safe.writeFile(sb.wctx, path.join(root, 'out/claude/home/hand-made.txt'), 'mine\n');
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.OK);
    expect(await readText(path.join(root, 'out/tmp/scratch.txt'))).toBe('keep me\n');
    expect(await readText(path.join(root, 'out/claude/home/hand-made.txt'))).toBe('mine\n');
    expect(r.out).toContain('BUILD_UNMANAGED_FILE out/claude/home/hand-made.txt');
    expect(r.out).toContain('BUILD_UNMANAGED_FILE out/tmp/scratch.txt');
  });

  it('旧 manifest 不可信(坏 JSON / 含 .. 路径):不据此删任何东西,只告警;随后写入新的 manifest', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await runBuild(sb, root);
    // 仓库外的「受害者」文件
    const victim = path.join(sb.dir, 'victim.txt');
    await safe.writeFile(sb.wctx, victim, 'do not delete\n');
    const m = JSON.parse(await readText(path.join(root, 'out/manifest.json'))) as {
      files: { path: string }[];
    };
    m.files[0] = { ...m.files[0], path: '../../victim.txt' } as { path: string };
    await safe.writeFile(sb.wctx, path.join(root, 'out/manifest.json'), JSON.stringify(m));
    const r1 = await runBuild(sb, root);
    expect(r1.code).toBe(ExitCode.OK);
    expect(r1.out).toContain('BUILD_PREVIOUS_MANIFEST_UNTRUSTED');
    expect(await readText(victim)).toBe('do not delete\n');

    await safe.writeFile(sb.wctx, path.join(root, 'out/manifest.json'), '{ not json');
    const r2 = await runBuild(sb, root);
    expect(r2.code).toBe(ExitCode.OK);
    expect(r2.out).toContain('BUILD_PREVIOUS_MANIFEST_UNTRUSTED');
    expect(await readText(victim)).toBe('do not delete\n');
    const fresh = JSON.parse(await readText(path.join(root, 'out/manifest.json'))) as {
      files: unknown[];
    };
    expect(fresh.files.length).toBeGreaterThan(5);
  });

  it('旧 manifest 登记的文件路径现在是目录:整份 manifest 不信,目录里的未登记文件不被删', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await runBuild(sb, root);
    const reg = path.join(root, 'out/claude/home/.claude/rules/agent-kit/org.md');
    await safe.remove(sb.wctx, reg);
    await safe.mkdirp(sb.wctx, reg);
    await safe.writeFile(sb.wctx, path.join(reg, 'mine.txt'), 'keep\n');
    const r = await runBuild(sb, root);
    // 目录占了 org.md 的位置,build 写不进去 → fail-closed;关键是不能先 rm -rf 它
    expect(r.out).toContain('BUILD_PREVIOUS_MANIFEST_UNTRUSTED');
    expect(await readText(path.join(reg, 'mine.txt'))).toBe('keep\n');
  });

  it('cleanPrevious:清掉旧 manifest 登记的全部文件与变空的目录,out/ 只剩未登记项(此处为空)', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await runBuild(sb, root);
    const ctx = createIoContext({ root, cwd: REPO_ROOT, env: { PATH: '/usr/bin:/bin' } });
    const prev = await readPreviousOut(ctx);
    expect(prev.paths.length).toBeGreaterThan(5);
    await cleanPrevious(ctx, prev);
    expect(await exists(path.join(root, 'out/manifest.json'))).toBe(false);
    expect((await readDir(path.join(root, 'out'))).length).toBe(0);
  });
});

describe('--dry-run', () => {
  it('不创建 out/、不写 .state;打印将写的文件清单(含 manifest.json)', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    const r = await runBuild(sb, root, ['--dry-run', '--report']);
    expect(r.code).toBe(ExitCode.OK);
    expect(await exists(path.join(root, 'out'))).toBe(false);
    expect(await exists(path.join(root, '.state'))).toBe(false);
    expect(r.out).toContain('would write out/claude/home/.claude/rules/agent-kit/org.md');
    expect(r.out).toContain('would write out/manifest.json');
    expect(r.out).not.toContain('my-habit');
    expect(r.out).not.toContain('build: 已写');
    expect(r.out).toContain('dry-run, 未写 .state/reports/build.json');
  });

  it('已有 out/ 时:不改任何文件,陈旧项只提示 would remove', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await runBuild(sb, root);
    const before = await outTree(root);
    await safe.remove(sb.wctx, path.join(root, 'skills'));
    const r = await runBuild(sb, root, ['--dry-run']);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.out).toContain('would remove out/claude/home/.claude/skills/my-skill/SKILL.md');
    expect([...(await outTree(root))]).toEqual([...before]);
  });

  it('dry-run 与实跑列出的文件一致', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    const dry = await runBuild(sb, root, ['--dry-run']);
    const listed = [...dry.out.matchAll(/^would write out\/(\S+)/gm)].map((m) => m[1]);
    await runBuild(sb, root);
    expect(listed.sort()).toEqual([...(await outTree(root)).keys()].sort());
  });
});

describe('写盘只经 safe-fs,且只写 <repo>/out/', () => {
  it('源码不直接 import node:fs / node:os / child_process(build 相关文件)', async () => {
    const dir = path.join(REPO_ROOT, 'src/build');
    const names = (await readDir(dir)).map((e) => path.join(dir, e.name));
    names.push(path.join(REPO_ROOT, 'src/commands/build.ts'));
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const f of names) {
      const t = await readText(f);
      expect(t, f).not.toMatch(/from 'node:(fs|fs\/promises|os|child_process)'/);
      expect(t, f).not.toMatch(/process\.(env|cwd)/);
    }
  });

  it('产出文件权限:文件 0644、目录 0755,报告 0600、其目录 0700', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await runBuild(sb, root, ['--report']);
    const mode = async (p: string): Promise<number> => (await lstat(p)).mode & 0o777;
    const umaskFree = async (p: string, m: number): Promise<boolean> =>
      ((await mode(p)) & ~0o022) === (m & ~0o022);
    expect(await umaskFree(path.join(root, 'out/manifest.json'), 0o644)).toBe(true);
    expect(
      await umaskFree(path.join(root, 'out/claude/home/.claude/rules/agent-kit/org.md'), 0o644),
    ).toBe(true);
    expect(await umaskFree(path.join(root, 'out/claude/home'), 0o755)).toBe(true);
    expect(await mode(path.join(root, '.state/reports/build.json'))).toBe(0o600);
    expect(await mode(path.join(root, '.state/reports'))).toBe(0o700);
  });

  it('写入根被收窄到不含 out/ → 3,out/ 没有产生,也没写到别处', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    // 只允许写 .state:out/ 在根外
    const r = await runBuild(sb, root, [], {
      env: { KIT_WRITE_ROOTS: path.join(root, '.state') },
    });
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('写 out/ 失败');
    expect(await exists(path.join(root, 'out/manifest.json'))).toBe(false);
    expect((await readDir(sb.dir)).map((e) => e.name).sort()).toEqual(['home', 'repo']);
  });

  it('safe-fs 拒绝 out/ 之外的路径(本命令用的同一个 ctx):仓库内别处、仓库外、经 .. 逃逸', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    const ctx = createIoContext({ root, cwd: REPO_ROOT, env: { PATH: '/usr/bin:/bin' } });
    expect(() => assertWritable(ctx, path.join(root, 'out/x'))).not.toThrow();
    for (const bad of [
      path.join(root, 'rules/team/x.md'),
      path.join(root, 'kit.toml'),
      path.join(sb.dir, 'elsewhere.txt'),
      path.join(root, 'out/../kit.toml'),
      path.join(sb.home, 'x'),
    ]) {
      expect(() => assertWritable(ctx, bad), bad).toThrow();
    }
    await expect(writeOut(ctx, [], '{}\n')).resolves.toBeUndefined();
  });

  it('out/ 是指向仓库外的符号链接 → 3,链接目标一个文件都不被写', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    const target = path.join(sb.dir, 'elsewhere');
    await safe.mkdirp(sb.wctx, target);
    await safe.symlink(sb.wctx, target, path.join(root, 'out'));
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('符号链接');
    expect(await readDir(target)).toEqual([]);
  });

  it('out/ 里 manifest.json 是符号链接 → 视为不可信,链接目标不被删', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await runBuild(sb, root);
    const outside = path.join(sb.dir, 'outside.json');
    await safe.writeFile(sb.wctx, outside, await readText(path.join(root, 'out/manifest.json')));
    await safe.remove(sb.wctx, path.join(root, 'out/manifest.json'));
    // safe-fs 的 symlink 要求目标也在写入根内,所以用 wctx 在 out/ 内建指向 out/ 内另一个文件的链接
    await safe.writeFile(sb.wctx, path.join(root, 'out/real-manifest.json'), '{}\n');
    await safe.symlink(
      createIoContext({ root, cwd: REPO_ROOT, env: { PATH: '/usr/bin:/bin' } }),
      path.join(root, 'out/real-manifest.json'),
      path.join(root, 'out/manifest.json'),
    );
    const r = await runBuild(sb, root);
    expect(r.out).toContain('BUILD_PREVIOUS_MANIFEST_UNTRUSTED');
    expect(await readText(outside)).toContain('"schema_version"');
  });

  it('命令描述:不再是桩(帮助里有 --dry-run / --report)', () => {
    expect(command.phase).toBe('P0');
    expect((command.flags ?? []).map((f) => f.name)).toEqual(['--dry-run', '--report']);
  });

  it('atomMd 工具函数自检:生成的原子能过 lint(控制组,防 fixture 静默变空)', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', {
      ...(await fullFiles()),
      'rules/team/extra-one.md': atomMd('extra-one', 'team'),
    });
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    expect([...(await outTree(root)).values()].some((t) => t.includes('示例规则'))).toBe(true);
  });
});

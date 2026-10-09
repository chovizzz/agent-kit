import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { exists, lstat, readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { cleanPrevious, readPreviousOut } from '../../src/build/writer.js';
import { createIoContext } from '../../src/io/paths.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { atomMd, fullFiles, makeSandbox, resetBuildDeps, runBuild, writeRepo } from './helpers.js';
import type { Sandbox } from './helpers.js';

afterEach(() => {
  resetBuildDeps();
});

const REG = 'claude/home/.claude/rules/agent-kit/org.md';

/** 先正常 build 一次;再把 out/claude/home 换成指向 .state 的符号链接,并在 .state 里埋一个同名「哨兵」文件。 */
async function plantMidLink(sb: Sandbox): Promise<{ root: string; sentinel: string }> {
  const root = await writeRepo(sb, 'repo', await fullFiles());
  expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
  const state = path.join(root, '.state');
  await safe.mkdirp(sb.wctx, path.join(state, '.claude/rules/agent-kit'));
  const sentinel = path.join(state, '.claude/rules/agent-kit/org.md');
  await safe.writeFile(sb.wctx, sentinel, 'SENTINEL-DO-NOT-TOUCH\n');
  await safe.remove(sb.wctx, path.join(root, 'out/claude/home'));
  await safe.symlink(sb.wctx, state, path.join(root, 'out/claude/home'));
  return { root, sentinel };
}

async function snapshotState(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const e of await readDir(dir)) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory && !e.isSymbolicLink) await walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  await walk(path.join(root, '.state'), '');
  return out.sort();
}

describe('B1:out/ 内部的符号链接(中间段)', () => {
  it('out/claude/home -> .state 且 manifest 登记了其下路径:build 退出 3,.state 里一个文件都不被删/写', async () => {
    const sb = await makeSandbox();
    const { root, sentinel } = await plantMidLink(sb);
    const before = await snapshotState(root);
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(await readText(sentinel)).toBe('SENTINEL-DO-NOT-TOUCH\n');
    expect(await snapshotState(root)).toEqual(before);
    expect(r.err).toContain('符号链接');
  });

  it('readPreviousOut:登记路径的中间段是链接 → 视为不可信,paths 为空;cleanPrevious 因此什么都不删', async () => {
    const sb = await makeSandbox();
    const { root, sentinel } = await plantMidLink(sb);
    const ctx = createIoContext({ root, cwd: REPO_ROOT, env: { PATH: '/usr/bin:/bin' } });
    const prev = await readPreviousOut(ctx);
    expect(prev.paths).toEqual([]);
    expect(prev.untrusted).toContain('符号链接');
    await cleanPrevious(ctx, prev);
    expect(await readText(sentinel)).toBe('SENTINEL-DO-NOT-TOUCH\n');
  });

  it('cleanPrevious 直接收到含链接中段的路径(绕过 readPreviousOut)→ 抛错,不删', async () => {
    const sb = await makeSandbox();
    const { root, sentinel } = await plantMidLink(sb);
    const ctx = createIoContext({ root, cwd: REPO_ROOT, env: { PATH: '/usr/bin:/bin' } });
    await expect(cleanPrevious(ctx, { paths: [REG] })).rejects.toThrow(/符号链接/);
    expect(await readText(sentinel)).toBe('SENTINEL-DO-NOT-TOUCH\n');
  });

  it('manifest 为空的首次 build:out/ 内预置中间段链接 → 写入被拒(3),.state 不被写', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await safe.mkdirp(sb.wctx, path.join(root, '.state'));
    await safe.mkdirp(sb.wctx, path.join(root, 'out/claude'));
    await safe.symlink(sb.wctx, path.join(root, '.state'), path.join(root, 'out/claude/home'));
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(await snapshotState(root)).toEqual([]);
  });

  it('叶子是指向 .state 内文件的链接(登记文件被换成链接):写入被拒(3),链接目标内容不变', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const target = path.join(root, '.state/victim.txt');
    await safe.mkdirp(sb.wctx, path.join(root, '.state'));
    await safe.writeFile(sb.wctx, target, 'VICTIM\n');
    // 换一个文件:先删再建链接(登记在案的叶子 → 链接)。manifest 不变 ⇒ 新 build 会重写同一路径。
    const leaf = path.join(root, 'out', ...REG.split('/'));
    await safe.remove(sb.wctx, leaf);
    await safe.symlink(sb.wctx, target, leaf);
    // 让 build 无法先清掉它:把 manifest 弄成不可信(清理被跳过,写入阶段必须自己拦)
    await safe.writeFile(sb.wctx, path.join(root, 'out/manifest.json'), '{bad');
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(await readText(target)).toBe('VICTIM\n');
    expect((await lstat(leaf)).isSymbolicLink()).toBe(true);
  });

  it('写入根被收窄为只含 .state 之外的 out/:build 使用的 io 的写入根不含 .state(.state 里不会有 build 的非 reports 产物)', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    expect(await exists(path.join(root, '.state'))).toBe(false);
  });
});

describe('B4:--report 与 .state 符号链接', () => {
  it('.state 是符号链接 → 报告不写到链接目标(仓库外),退出 3', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    const outside = path.join(sb.dir, 'outside-state');
    await safe.mkdirp(sb.wctx, outside);
    await safe.symlink(sb.wctx, outside, path.join(root, '.state'));
    const r = await runBuild(sb, root, ['--report']);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(await readDir(outside)).toEqual([]);
  });

  it('.state/reports 是符号链接 → 同样拒绝', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    const outside = path.join(sb.dir, 'outside-reports');
    await safe.mkdirp(sb.wctx, outside);
    await safe.mkdirp(sb.wctx, path.join(root, '.state'));
    await safe.symlink(sb.wctx, outside, path.join(root, '.state/reports'));
    const r = await runBuild(sb, root, ['--report']);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(await readDir(outside)).toEqual([]);
  });
});

describe('manifest 登记形状 / 悬空链接', () => {
  it('manifest 登记 out/tmp/a.txt(不是本命令的产出形状):整份不信,该文件不被删', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const mf = path.join(root, 'out/manifest.json');
    const m = JSON.parse(await readText(mf)) as { files: { path: string }[] };
    (m.files[0] as { path: string }).path = 'tmp/a.txt';
    await safe.writeFile(sb.wctx, mf, JSON.stringify(m));
    await safe.mkdirp(sb.wctx, path.join(root, 'out/tmp'));
    await safe.writeFile(sb.wctx, path.join(root, 'out/tmp/a.txt'), '');
    const r = await runBuild(sb, root);
    expect(r.out).toContain('BUILD_PREVIOUS_MANIFEST_UNTRUSTED');
    expect(await exists(path.join(root, 'out/tmp/a.txt'))).toBe(true);
  });

  it('out/manifest.json 是悬空符号链接:视为不可信(不当成「没有旧 manifest」)', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await safe.mkdirp(sb.wctx, path.join(root, 'out'));
    await safe.symlink(
      sb.wctx,
      path.join(root, 'out/nowhere.json'),
      path.join(root, 'out/manifest.json'),
    );
    const ctx = createIoContext({ root, cwd: REPO_ROOT, env: { PATH: '/usr/bin:/bin' } });
    const prev = await readPreviousOut(ctx);
    expect(prev.untrusted).toContain('符号链接');
  });
});

describe('B3:manifest.json 是目录 / 手改文件', () => {
  it('out/manifest.json 是目录:不递归删里面的内容,build 退出 3', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await safe.mkdirp(sb.wctx, path.join(root, 'out/manifest.json'));
    await safe.writeFile(sb.wctx, path.join(root, 'out/manifest.json/keep.txt'), 'KEEP\n');
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(await readText(path.join(root, 'out/manifest.json/keep.txt'))).toBe('KEEP\n');
  });

  it('登记文件被手改(sha256 与 manifest 不符),且新一轮不再产出它:不删,只告警', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const hand = path.join(root, 'out/claude/project/.claude/rules/agent-kit/project.md');
    await safe.writeFile(sb.wctx, hand, 'HAND EDITED\n');
    await safe.remove(sb.wctx, path.join(root, '.kit/rules/project-rule.md'));
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.out).toContain('BUILD_MODIFIED_MANAGED_FILE');
    expect(await readText(hand)).toBe('HAND EDITED\n');
  });

  it('控制组:登记文件未被改动、不再产出 → 照常被清掉', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    await safe.remove(sb.wctx, path.join(root, '.kit/rules/project-rule.md'));
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    expect(
      await exists(path.join(root, 'out/claude/project/.claude/rules/agent-kit/project.md')),
    ).toBe(false);
  });

  it('旧文件权限 0755 + 同路径被重写:build 后文件为 0644', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const f = path.join(root, 'out', ...REG.split('/'));
    await safe.chmod(sb.wctx, f, 0o755);
    // manifest 不可信 ⇒ 不清理 ⇒ 旧文件原地被覆盖
    await safe.writeFile(sb.wctx, path.join(root, 'out/manifest.json'), '{bad');
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    expect((await lstat(f)).mode & 0o777 & ~0o022).toBe(0o644 & ~0o022);
  });
});

describe('B2:personal 同 id overrides', () => {
  it('经 build 到不了合并层:lint 先以 ATOM_REF_SELF 拒绝(退出 1),out/ 未写;合并层另有防护(见 merge 测试)', async () => {
    const sb = await makeSandbox();
    const files = await fullFiles();
    files['rules/personal/team-rule.md'] = atomMd(
      'team-rule',
      'personal',
      'overrides: [team-rule]\n',
    );
    const root = await writeRepo(sb, 'repo', files);
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.out).toContain('ATOM_REF_SELF');
    expect(await exists(path.join(root, 'out'))).toBe(false);
  });
});

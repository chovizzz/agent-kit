import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lintRepo } from '../../src/atoms/lint.js';
import { buildDeps } from '../../src/build/pipeline.js';
import { lintDeps } from '../../src/commands/lint-cmd.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { ManifestSchema } from '../../src/contracts/render.js';
import type { Manifest } from '../../src/contracts/render.js';
import { exists, readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { mergeAtoms } from '../../src/merge/merge.js';
import { renderAll } from '../../src/render/core.js';
import { createRegistry, defaultRegistry } from '../../src/render/registry.js';
import { assertGolden } from '../golden-harness/golden.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import {
  atomMd,
  fullFiles,
  makeSandbox,
  outTree,
  realKitToml,
  resetBuildDeps,
  runBuild,
  treeSnapshot,
  writeRepo,
} from './helpers.js';

afterEach(() => {
  resetBuildDeps();
  delete lintDeps.redactor;
});

const sha = (s: string): string =>
  createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

async function manifestOf(root: string): Promise<Manifest> {
  return ManifestSchema.parse(JSON.parse(await readText(path.join(root, 'out/manifest.json'))));
}

describe('golden(含 personal 原子被跳过的 fixture)', () => {
  it('完整仓库:out/ 树(含 manifest.json)与 golden 逐字节一致', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.OK);
    await assertGolden({
      goldenDir: path.join(REPO_ROOT, 'test/build/golden/full'),
      actual: treeSnapshot(await outTree(root)),
    });
  });

  it('只有 personal 原子:渲染出的规则文件为空,manifest 无任何 personal 来源', async () => {
    const sb = await makeSandbox();
    const files = {
      'kit.toml': await realKitToml(),
      CODEOWNERS: '* @owner-handle\n',
      'rules/personal/only-mine.md': atomMd('only-mine', 'personal'),
    };
    const root = await writeRepo(sb, 'repo', files);
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.OK);
    await assertGolden({
      goldenDir: path.join(REPO_ROOT, 'test/build/golden/personal-only'),
      actual: treeSnapshot(await outTree(root)),
    });
  });
});

describe('personal 层:出现在合并结果里(正向控制),但不出现在 out/', () => {
  it('合并结果里有 my-habit(coreEligible=false);out/ 里既没有它的 id 也没有它的正文', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());

    // 正向控制:同一仓库的合并结果里确实有这个 personal 原子,并被标成不可入 core
    const lint = await lintRepo(root);
    const merged = mergeAtoms(lint.atoms);
    const mine = merged.atoms.find((a) => a.atom.fm.id === 'my-habit');
    expect(mine?.layer).toBe('personal');
    expect(mine?.coreEligible).toBe(false);
    // 渲染核心确实会在它被塞进输出时拒绝(控制组:检测手段本身有效)
    const registry = createRegistry(defaultRegistry.list());
    const rendered = renderAll(
      {
        resolved: merged.atoms,
        skills: lint.skills,
        agents: lint.agents,
        kitVersion: '0.0.0',
        channel: 'canary',
      },
      registry,
    );
    expect(rendered.files.every((f) => !f.atomIds.includes('my-habit'))).toBe(true);

    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const tree = await outTree(root);
    expect(tree.size).toBeGreaterThan(5);
    // 控制组:非 personal 原子的 id 在 out/ 里能被找到,所以下面的「找不到」不是空扫
    expect([...tree.values()].some((t) => t.includes('org-rule'))).toBe(true);
    for (const [k, v] of tree) {
      expect(v, k).not.toContain('my-habit');
    }
    const m = await manifestOf(root);
    expect(m.files.flatMap((f) => f.atoms).some((a) => a.layer === 'personal')).toBe(false);
    expect(m.files.flatMap((f) => f.atoms).map((a) => a.id)).toContain('org-rule');
    expect(m.skippedLayers).toEqual([{ layer: 'personal', reason: 'P2 才在本机渲染' }]);
  });
});

describe('manifest', () => {
  it('过 ManifestSchema;文件集合与 out/ 一一对应;sha256 对得上落盘内容;按 path 字节序', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const m = await manifestOf(root);
    const tree = await outTree(root);
    expect(m.files.length).toBeGreaterThan(5);
    expect(new Set(m.files.map((f) => f.path))).toEqual(
      new Set([...tree.keys()].filter((k) => k !== 'manifest.json')),
    );
    for (const f of m.files) expect(f.sha256, f.path).toBe(sha(tree.get(f.path) as string));
    const paths = m.files.map((f) => f.path);
    expect(paths).toEqual(
      [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    );
    expect((await runBuild(sb, root)).out).not.toContain('BUILD_UNMANAGED_FILE');
    expect(m.kit_version).toBe('0.0.0');
    expect(m.channel).toBe('canary');
    // 技能 / 子代理文件没有规则来源:atoms 为空、sourceRefs 非空
    const skill = m.files.find((f) => f.path === 'claude/home/.claude/skills/my-skill/SKILL.md');
    expect(skill?.atoms).toEqual([]);
    expect(skill?.sourceRefs).toEqual(['skill:my-skill']);
    // 规则文件的来源原子带层
    const org = m.files.find((f) => f.path === 'claude/home/.claude/rules/agent-kit/org.md');
    expect(org?.atoms).toEqual([{ id: 'org-rule', layer: 'org' }]);
  });

  it('manifest.json 自身是规范 JSON:键序固定、末尾恰一个换行', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await runBuild(sb, root);
    const text = await readText(path.join(root, 'out/manifest.json'));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    const keys = Object.keys(JSON.parse(text) as object);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('只含 kit.toml 里 enabled 的 agent', () => {
  it('enabled = [claude] 时 out/ 里只有 claude', async () => {
    const sb = await makeSandbox();
    const files = await fullFiles();
    files['kit.toml'] = (files['kit.toml'] as string).replace(
      /enabled = \[[^\]]*\]/,
      'enabled = ["claude"]',
    );
    const root = await writeRepo(sb, 'repo', files);
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const tops = new Set([...(await outTree(root)).keys()].map((k) => k.split('/')[0]));
    expect([...tops].sort()).toEqual(['claude', 'manifest.json']);
  });
});

describe('退出码', () => {
  it('未知参数 → 2,且不写任何东西', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    const r = await runBuild(sb, root, ['--bogus']);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.err).toContain('agent-kit build');
    expect(await exists(path.join(root, 'out'))).toBe(false);
  });

  it('位置参数 → 2', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    expect((await runBuild(sb, root, ['stray'])).code).toBe(ExitCode.USAGE);
  });

  it('缺 kit.toml → 1;kit.toml 非法 → 1', async () => {
    const sb = await makeSandbox();
    const a = await writeRepo(sb, 'a', { CODEOWNERS: '* @o\n' });
    const ra = await runBuild(sb, a);
    expect(ra.code).toBe(ExitCode.CHECK_FAILED);
    expect(ra.out).toContain('CFG_KIT_TOML_MISSING');
    const b = await writeRepo(sb, 'b', { 'kit.toml': 'not = [valid' });
    const rb = await runBuild(sb, b);
    expect(rb.code).toBe(ExitCode.CHECK_FAILED);
    expect(rb.out).toContain('CFG_TOML_SYNTAX');
    expect(await exists(path.join(a, 'out'))).toBe(false);
  });

  it('lint 有 error → 1,不渲染不写盘,已有 out/ 原封不动', async () => {
    const sb = await makeSandbox();
    const files = await fullFiles();
    const root = await writeRepo(sb, 'repo', files);
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const before = await outTree(root);
    // 打坏一个原子:id 与文件名不符
    await safe.writeFile(
      sb.wctx,
      path.join(root, 'rules/team/team-rule.md'),
      atomMd('other-id', 'team'),
    );
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.out).toContain('error ');
    expect(await outTree(root)).toEqual(before);
  });

  it('脱敏复扫自身抛错 → 3(fail-closed),out/ 不动;未抛错时同一仓库正常 → 0(控制组)', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    lintDeps.redactor = { pass2: () => ({ clean: true, hits: [] }) };
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const before = await outTree(root);
    lintDeps.redactor = {
      pass2: () => {
        throw new Error('scanner down');
      },
    };
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('fail-closed');
    expect(await outTree(root)).toEqual(before);
  });

  it('合并出错(同层 disables)→ 1,out/ 不动', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const before = await outTree(root);
    await safe.writeFile(
      sb.wctx,
      path.join(root, 'rules/team/off-one.md'),
      atomMd('off-one', 'team', 'disables:\n  - team-rule\n'),
    );
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.out).toContain('MERGE_DISABLE_NOT_ALLOWED');
    expect(await outTree(root)).toEqual(before);
  });

  it('渲染抛错 → 3,out/ 不动', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    expect((await runBuild(sb, root)).code).toBe(ExitCode.OK);
    const before = await outTree(root);
    buildDeps.render = () => {
      throw new Error('boom');
    };
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('渲染失败');
    expect(await outTree(root)).toEqual(before);
  });

  it('预算 enforce=block 且超限 → 1,不写 out/;enforce=warn 同样超限 → 0 并写 out/(控制组)', async () => {
    const sb = await makeSandbox();
    const toml = (enforce: string): string => `[kit]
name = "t"
version = "0.0.0"

[agents]
enabled = ["claude"]

[budget]
enforce = "${enforce}"

[budget.claude]
max_lines = 1
limit_source = "documented"

[channels.canary.members]

[channels.stable.members]
`;
    const base = await fullFiles();
    const blockRoot = await writeRepo(sb, 'block', { ...base, 'kit.toml': toml('block') });
    const r = await runBuild(sb, blockRoot);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.out).toContain('BUDGET_OVER_LIMIT');
    expect(await exists(path.join(blockRoot, 'out'))).toBe(false);

    const warnRoot = await writeRepo(sb, 'warn', { ...base, 'kit.toml': toml('warn') });
    const w = await runBuild(sb, warnRoot);
    expect(w.code).toBe(ExitCode.OK);
    expect(w.out).toContain('[over]');
    expect(await exists(path.join(warnRoot, 'out/manifest.json'))).toBe(true);
  });

  it('没有任何规则/技能/子代理:退出 0,告警 BUILD_EMPTY_OUTPUT,manifest.files 为空但带 personal 跳过说明', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', { 'kit.toml': await realKitToml() });
    const r = await runBuild(sb, root);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.out).toContain('BUILD_EMPTY_OUTPUT');
    const m = await manifestOf(root);
    expect(m.files).toEqual([]);
    expect(m.skippedLayers).toEqual([{ layer: 'personal', reason: 'P2 才在本机渲染' }]);
    expect([...(await outTree(root)).keys()]).toEqual(['manifest.json']);
  });
});

describe('--overlay', () => {
  it('channel 与 enabled_agents 生效(只会收窄);坏覆盖层 → 1', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', {
      ...(await fullFiles()),
      'ov.toml': 'channel = "stable"\nenabled_agents = ["codex"]\n',
      'bad.toml': 'channel = "nightly"\n',
    });
    const r = await runBuild(sb, root, [], { globals: ['--overlay', path.join(root, 'ov.toml')] });
    expect(r.code).toBe(ExitCode.OK);
    const m = await manifestOf(root);
    expect(m.channel).toBe('stable');
    expect([...new Set(m.files.map((f) => f.agent))]).toEqual(['codex']);

    const bad = await runBuild(sb, root, [], {
      globals: ['--overlay', path.join(root, 'bad.toml')],
    });
    expect(bad.code).toBe(ExitCode.CHECK_FAILED);
    const missing = await runBuild(sb, root, [], {
      globals: ['--overlay', path.join(root, 'nope.toml')],
    });
    expect(missing.code).toBe(ExitCode.CHECK_FAILED);
    expect(missing.out).toContain('CFG_OVERLAY_UNREADABLE');
  });
});

describe('--report', () => {
  it('写 .state/reports/build.json:带 sideEffects / pendingProbes / 预算,无绝对路径', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    const r = await runBuild(sb, root, ['--report']);
    expect(r.code).toBe(ExitCode.OK);
    const file = path.join(root, '.state/reports/build.json');
    const text = await readText(file);
    expect(r.out).toContain(text);
    const j = JSON.parse(text) as {
      files: { path: string; bytes: number; sha256: string }[];
      render: { sideEffects: string[]; pendingProbes: unknown[] };
      budget: { targets: unknown[] };
      skipped_layers: unknown[];
    };
    expect(j.files.length).toBeGreaterThan(5);
    const tree = await outTree(root);
    for (const f of j.files) {
      expect(f.bytes, f.path).toBe(Buffer.byteLength(tree.get(f.path) as string, 'utf8'));
      expect(f.sha256).toBe(sha(tree.get(f.path) as string));
    }
    expect(j.render.sideEffects.length).toBeGreaterThan(0);
    expect(j.render.pendingProbes.length).toBeGreaterThan(0);
    expect(j.budget.targets.length).toBe(5);
    expect(text).not.toContain(root);
    expect(text).not.toContain(sb.dir);
    // report 不在 out/ 里
    expect(tree.has('build.json')).toBe(false);
  });
});

describe('假 HOME 卫生', () => {
  it('build 之后假 HOME 仍为空(build 不写 HOME)', async () => {
    const sb = await makeSandbox();
    const root = await writeRepo(sb, 'repo', await fullFiles());
    await runBuild(sb, root, ['--report']);
    expect(await readDir(sb.home)).toEqual([]);
  });
});

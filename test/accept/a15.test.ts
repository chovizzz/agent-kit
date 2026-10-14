import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as safe from '../../src/io/safe-fs.js';
import { guardRealHome, makeFx, putOutside, REPO_ROOT, runScript } from './helpers.js';
import type { Fx } from './helpers.js';

guardRealHome();

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const FILE_PATH = 'claude/home/CLAUDE.md';
const CONTENT = 'rule\n';

interface ManifestOpts {
  layer?: string;
  skipped?: boolean;
  badSha?: boolean;
  extraOnDisk?: boolean;
  files?: boolean;
  dupe?: boolean;
  escape?: boolean;
}
function manifest(o: ManifestOpts): unknown {
  const entry = {
    path: o.escape ? 'claude/../x' : FILE_PATH,
    agent: 'claude',
    target: 'home',
    mode: 'owned',
    confidence: 'documented',
    sha256: o.badSha ? sha('other') : sha(CONTENT),
    atoms: [{ id: 'be-kind', layer: o.layer ?? 'org' }],
    sourceRefs: [],
  };
  return {
    schema_version: 1,
    kit_version: '0.0.0',
    channel: 'stable',
    files: o.files === false ? [] : o.dupe ? [entry, entry] : [entry],
    skippedLayers: o.skipped === false ? [] : [{ layer: 'personal', reason: 'P2 才渲染' }],
  };
}

/** 构造一个 out/ 目录并返回它的路径(供 checkManifest 纯函数用)。 */
async function outDir(fx: Fx, o: ManifestOpts, name = 'out'): Promise<string> {
  const dir = path.join(fx.dir, name);
  await safe.mkdirp(fx.ctx, path.join(dir, 'claude/home'));
  await safe.writeFile(fx.ctx, path.join(dir, FILE_PATH), CONTENT);
  if (o.extraOnDisk) await safe.writeFile(fx.ctx, path.join(dir, 'claude/home/EXTRA.md'), 'x');
  await safe.writeFile(fx.ctx, path.join(dir, 'manifest.json'), JSON.stringify(manifest(o)));
  return dir;
}

/** 在子进程里用真实 ManifestSchema 校验 out 目录。 */
function check(dir: string): string[] {
  const code = `
    import { pathToFileURL } from 'node:url';
    const lib = await import(${JSON.stringify(path.join(REPO_ROOT, 'ops/accept/lib/a15.mjs'))});
    const { ManifestSchema } = await import(pathToFileURL(${JSON.stringify(SCHEMA_SRC + '/contracts/render.js')}).href);
    process.stdout.write(JSON.stringify(lib.checkManifest(${JSON.stringify(dir)}, ManifestSchema)));
  `;
  return JSON.parse(callLibRaw(code)) as string[];
}
import { spawnSync } from 'node:child_process'; // eslint-disable-line no-restricted-imports -- 子进程里用真实 schema 校验
function callLibRaw(code: string): string {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

describe('A15 manifest 核对(真实 ManifestSchema)', () => {
  it('合法 manifest + 一一对应的文件 + personal 跳过说明 => 无问题(正向控制)', async () => {
    const fx = await makeFx('a15-');
    expect(check(await outDir(fx, {}))).toEqual([]);
  });
  it.each<[string, ManifestOpts, string]>([
    ['来源原子是 personal', { layer: 'personal' }, 'layer=personal'],
    ['sha256 与落盘不一致', { badSha: true }, 'sha256'],
    ['out/ 多出 manifest 没登记的文件', { extraOnDisk: true }, '没登记'],
    ['缺 personal 跳过说明', { skipped: false }, 'skippedLayers'],
    ['files 为空', { files: false }, '为空'],
    ['路径重复', { dupe: true }, '重复'],
    ['路径含 ..', { escape: true }, 'manifest'],
  ])('故意破坏:%s => 报问题', async (_n, o, msg) => {
    const fx = await makeFx('a15-');
    expect(check(await outDir(fx, o)).join('\n')).toContain(msg);
  });
  it('manifest 缺失 => 报问题', async () => {
    const fx = await makeFx('a15-');
    const d = await outDir(fx, {});
    await safe.remove(fx.ctx, path.join(d, 'manifest.json'));
    expect(check(d).join()).toContain('缺 out/manifest.json');
  });
});

/** 假 CLI:在 --root 的 out/ 下写入 manifest 与文件;模式见 stub-mode.txt。 */
const STUB = `
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
const argv = process.argv.slice(2);
const root = argv[argv.indexOf('--root') + 1];
const mode = fs.readFileSync(path.join(root, 'stub-mode.txt'), 'utf8').trim();
if (mode === 'stub') process.exit(64);
if (mode === 'fail') process.exit(1);
const out = path.join(root, 'out');
fs.mkdirSync(path.join(out, 'claude/home'), { recursive: true });
const content = 'rule\\n';
fs.writeFileSync(path.join(out, 'claude/home/CLAUDE.md'), content);
if (mode === 'no-manifest') process.exit(0);
const layer = mode === 'personal' ? 'personal' : 'org';
const m = { schema_version: 1, kit_version: '0.0.0', channel: 'stable',
  files: [{ path: 'claude/home/CLAUDE.md', agent: 'claude', target: 'home', mode: 'owned', confidence: 'documented',
    sha256: createHash('sha256').update(content).digest('hex'), atoms: [{ id: 'be-kind', layer }], sourceRefs: [] }],
  skippedLayers: [{ layer: 'personal', reason: 'P2 才渲染' }] };
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(m));
`;

async function setup(mode: string): Promise<{ fx: Fx; cli: string }> {
  const fx = await makeFx('a15-');
  await fx.put('kit.toml', '[kit]\nname = "x"\n');
  await fx.put('stub-mode.txt', mode + '\n');
  return { fx, cli: await putOutside(fx, 'stub-cli.mjs', STUB) };
}
// S7b 起 dist/ 是打包产物(没有 src/);契约 schema 取自 tsc 的构建期产物
const SCHEMA_SRC = path.join(REPO_ROOT, 'node_modules', '.cache', 'agent-kit-tsc', 'src');
const a15 = (s: { fx: Fx; cli: string }, extra: string[] = []) =>
  runScript(
    'a15-no-personal-in-out.sh',
    ['--root', s.fx.root, '--cli', s.cli, '--schema-src', SCHEMA_SRC, '--no-vitest', ...extra],
    s.fx.env(),
  );

describe('A15 脚本(隔离副本里重新构建 + 核对)', () => {
  it('合法产物且已提交的 out/ 与重新构建一致 => 0(正向控制)', async () => {
    const s = await setup('ok');
    await s.fx.put('out/claude/home/CLAUDE.md', 'rule\n');
    await s.fx.put('out/manifest.json', JSON.stringify(manifest({})));
    const r = a15(s);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('新构建的 out/');
    expect(r.stdout).toContain('逐字节一致');
  });
  it('新构建没问题但仓库根没有 out/(out/ 入 git)=> 1', async () => {
    const r = a15(await setup('ok'));
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('仓库根没有 out/');
  });
  it('产物里有 personal 来源原子 => 1', async () => {
    const r = a15(await setup('personal'));
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('layer=personal');
  });
  it('build 成功但没有 manifest => 1;build 失败 => 1', async () => {
    expect(a15(await setup('no-manifest')).status).toBe(1);
    expect(a15(await setup('fail')).status).toBe(1);
  });
  it('build 是命令桩 => 4(旧 out/ 不能掩盖)', async () => {
    const s = await setup('stub');
    // 即使仓库里躺着一份合法的旧 out/,也不能因此判通过
    await s.fx.put('out/claude/home/CLAUDE.md', 'rule\n');
    await s.fx.put('out/manifest.json', JSON.stringify(manifest({})));
    const r = a15(s);
    expect(r.status, r.stdout).toBe(4);
  });
  it('仓库里已提交的 out/ 与重新构建不一致(陈旧)=> 1', async () => {
    const s = await setup('ok');
    await s.fx.put('out/claude/home/CLAUDE.md', 'stale\n');
    await s.fx.put('out/manifest.json', JSON.stringify(manifest({ badSha: false })));
    const r = a15(s);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toMatch(/sha256|不一致/);
  });
  it('取不到 ManifestSchema => 4', async () => {
    const s = await setup('ok');
    const r = runScript(
      'a15-no-personal-in-out.sh',
      ['--root', s.fx.root, '--cli', s.cli, '--no-vitest'],
      s.fx.env(),
    );
    expect(r.status).toBe(4);
  });
});

import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { buildSeeds } from '../../src/redact/index.js';
import {
  callLib,
  commitAll,
  guardRealHome,
  makeFx,
  putFakeVitest,
  putOutside,
  REAL_CLI,
  REPO_ROOT,
  runScript,
  vitestJson,
} from './helpers.js';
import type { Fx } from './helpers.js';

guardRealHome();

const GOOD_SAMPLES = [
  '# 合成',
  'claude\t0123456789abcdef\t120',
  'codex\tfedcba9876543210\t50',
  '',
].join('\n');

async function setup(
  extra: Record<string, string> = {},
  opts: { commit?: boolean } = {},
): Promise<Fx> {
  const fx = await makeFx('a10-');
  await fx.put('kit.toml', await readText(path.join(REPO_ROOT, 'kit.toml')));
  await fx.put('README.md', 'hello\n');
  await fx.put('inventory/reader-samples.txt', GOOD_SAMPLES);
  for (const [f, t] of Object.entries(extra)) await fx.put(f, t);
  if (opts.commit) await commitAll(fx);
  return fx;
}
const a10 = (fx: Fx, extra: string[] = [], cli = REAL_CLI) =>
  runScript(
    'a10-privacy.sh',
    ['--root', fx.root, '--cli', cli, '--no-vitest', '--pins', 'none', ...extra],
    fx.env(),
  );

describe('A10 隐私卫生', () => {
  it('干净仓库 => 0:主动探针、git 清单、样本清单、脱敏扫描都有效(正向控制)', async () => {
    const fx = await setup({}, { commit: true });
    const r = a10(fx);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('探针:产品建的 state');
    expect(r.stdout).toContain('植入正向对照已检出');
  }, 60_000);

  it('仓库里有 .jsonl(疑似会话原文)=> 1', async () => {
    const fx = await setup({ 'test/fixtures/x.jsonl': '{"a":1}\n' });
    const r = a10(fx);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('.jsonl');
  }, 60_000);

  it('git 清单含 .state/ => 1', async () => {
    const fx = await setup({ '.state/signals/x.txt': 'x\n' }, { commit: true });
    const r = a10(fx);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('git 清单含 .state/');
  }, 60_000);

  it('.state 里有 0644 文件 => 1;0700/0600 => 权限那一条通过', async () => {
    const bad = await setup();
    await safe.mkdirp(bad.ctx, path.join(bad.root, '.state'));
    await safe.chmod(bad.ctx, path.join(bad.root, '.state'), 0o700);
    await bad.put('.state/salt', 'x\n', 0o644);
    const r1 = a10(bad);
    expect(r1.stdout).toContain('文件权限 644');
    expect(r1.status).toBe(1);
    const good = await setup();
    await safe.mkdirp(good.ctx, path.join(good.root, '.state'));
    await safe.chmod(good.ctx, path.join(good.root, '.state'), 0o700);
    await good.put('.state/salt', 'x\n', 0o600);
    const r2 = a10(good);
    expect(r2.stdout).toContain('现有 2 项权限均为 0700/0600');
  }, 120_000);

  it('reader-samples.txt 含真实路径 / 无数据行 => 1', async () => {
    const abs = await setup({ 'inventory/reader-samples.txt': 'claude\t/Users/x/y.jsonl\t10\n' });
    const r1 = a10(abs);
    expect(r1.status, r1.stdout).toBe(1);
    expect(r1.stdout).toContain('reader-samples.txt');
    const empty = await setup({ 'inventory/reader-samples.txt': '# 只有注释\n' });
    expect(a10(empty).stdout).toContain('没有任何数据行');
  }, 120_000);

  it('仓库里放了一个运行时拼出来的假密钥 => 脱敏扫描命中 => 1(无 fixture 豁免)', async () => {
    const seed = buildSeeds().find((s) => s.category === 'plain' && s.tier === 'recognized');
    expect(seed).toBeDefined();
    const fx = await setup({ 'test/fixtures/notes.txt': `token = ${seed?.input ?? ''}\n` });
    const r = a10(fx);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('脱敏扫描命中 1 个文件');
    expect(r.stdout).toContain('test/fixtures/notes.txt');
  }, 60_000);

  it('--allow-host 是显式放宽:同一个 URL 默认命中,允许其主机后才通过', async () => {
    const url = ['https:', '', 'docs.vendorsite.net', 'page'].join('/');
    const fx = await setup({ 'docs/links.md': `see ${url}\n` });
    expect(a10(fx).status).toBe(1);
    expect(a10(fx, ['--allow-host', 'docs.vendorsite.net']).status).toBe(0);
  }, 120_000);

  it('CLI 是命令桩 / 脱敏模块不可用 => 4(不是通过)', async () => {
    const fx = await setup({}, { commit: true });
    const stub = await putOutside(fx, 'stub-cli.mjs', 'process.exit(64);');
    const r = a10(fx, [], stub);
    expect(r.status, r.stdout).toBe(4);
    expect(r.stdout).toContain('NOT-RUN');
  }, 60_000);

  it('落盘权限的关键用例缺失(假 vitest 没有 0600 标题)=> 1', async () => {
    const fx = await setup({}, { commit: true });
    await fx.put('test/signals/state-store.test.ts', '// x\n');
    const bin = await putFakeVitest(
      fx,
      vitestJson(fx.root, { 'test/signals/state-store.test.ts': ['a', 'b', 'c'] }),
    );
    const r = runScript(
      'a10-privacy.sh',
      ['--root', fx.root, '--cli', REAL_CLI, '--no-scan', '--vitest-bin', bin],
      fx.env(),
    );
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('0600');
  }, 60_000);
});

describe('A10 公开信任材料:路径 + sha256 精确钉死', () => {
  const PIN_PATH = 'test/fixtures/trust/root.json';
  const sha = (t: string): string => crypto.createHash('sha256').update(t).digest('hex');
  // 运行时生成的高熵内容(模拟公钥 / 签名),不入库
  const entropy = (): string => crypto.randomBytes(96).toString('base64');
  const body = (e: string): string => `{"keys":"${e}"}\n`;
  async function putPins(fx: Fx, map: Record<string, string>): Promise<string> {
    const f = path.join(fx.dir, 'pins.json');
    await safe.writeFile(fx.ctx, f, JSON.stringify(map));
    return f;
  }
  async function pinned(content: string, pinSha?: string) {
    const fx = await setup({ [PIN_PATH]: content });
    const pins = await putPins(fx, { [PIN_PATH]: pinSha ?? sha(content) });
    return { fx, pins };
  }
  const withPins = (fx: Fx, pins: string) => a10(fx, ['--pins', pins]);

  it('正向对照:同一份高熵内容,没钉死 => 1;路径与 sha256 都匹配 => 0', async () => {
    const e = entropy();
    const { fx, pins } = await pinned(body(e));
    const r0 = a10(fx); // 默认 --pins none:同一份内容没有钉死
    expect(r0.status, r0.stdout).toBe(1);
    expect(r0.stdout).toContain(PIN_PATH);
    const r = withPins(fx, pins);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('1 个路径+sha256 钉死');
  }, 120_000);

  it('钉死文件改 1 个字节 => 1(不是退回普通扫描碰巧通过)', async () => {
    const e = entropy();
    const { fx, pins } = await pinned(body(e));
    await fx.put(PIN_PATH, body(`${e.slice(0, -2)}${e.endsWith('A') ? 'B' : 'A'}=`));
    const r = withPins(fx, pins);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('钉死校验失败');
    expect(r.stdout).toContain('sha256 与钉死值不符');
  }, 120_000);

  it('清单里的文件不存在 => 1(报错,不静默)', async () => {
    const fx = await setup();
    const pins = await putPins(fx, { [PIN_PATH]: 'a'.repeat(64) });
    const r = withPins(fx, pins);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('钉死清单里的文件不存在');
  }, 120_000);

  it('同目录新增一个清单外的高熵文件 => 1(只放过清单里的路径)', async () => {
    const { fx, pins } = await pinned(body(entropy()));
    await fx.put('test/fixtures/trust/extra.json', body(entropy()));
    const r = withPins(fx, pins);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('test/fixtures/trust/extra.json');
    expect(r.stdout).not.toContain(`${PIN_PATH}(`);
  }, 120_000);

  it('清单里的 sha256 写错 => 1', async () => {
    const { fx, pins } = await pinned(body(entropy()), 'f'.repeat(64));
    const r = withPins(fx, pins);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('sha256 与钉死值不符');
  }, 120_000);

  it('边界:钉死文件里的熵命中被忽略,但密钥形态等其他命中照旧 => 1', async () => {
    const seed = buildSeeds().find((s) => s.category === 'plain' && s.tier === 'recognized');
    const { fx, pins } = await pinned(`${body(entropy())}token = ${seed?.input ?? ''}\n`);
    const r = withPins(fx, pins);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain(PIN_PATH);
  }, 120_000);
});

describe('A10 纯函数', () => {
  it('modeProblems / checkSamplesFile', async () => {
    const fx = await makeFx('a10p-');
    const d = path.join(fx.dir, 'st');
    await safe.mkdirp(fx.ctx, d);
    await safe.chmod(fx.ctx, d, 0o700);
    await safe.writeFile(fx.ctx, path.join(d, 'a'), 'x');
    await safe.chmod(fx.ctx, path.join(d, 'a'), 0o600);
    const ok = callLib('a10.mjs', 'modeProblems', [[d]])[0] as {
      problems: string[];
      checked: number;
    };
    expect(ok).toEqual({ problems: [], checked: 2 });
    await safe.chmod(fx.ctx, path.join(d, 'a'), 0o640);
    const bad = callLib('a10.mjs', 'modeProblems', [[d]])[0] as { problems: string[] };
    expect(bad.problems.join()).toContain('640');
    const s = callLib('a10.mjs', 'checkSamplesFile', [
      [GOOD_SAMPLES],
      ['claude\t/abs/path\t3\n'],
      ['claude\tZZZZ\t3\n'],
    ]) as {
      problems: string[];
    }[];
    expect(s[0]?.problems).toEqual([]);
    expect(s[1]?.problems.length).toBeGreaterThan(0);
    expect(s[2]?.problems.length).toBeGreaterThan(0);
  });
});

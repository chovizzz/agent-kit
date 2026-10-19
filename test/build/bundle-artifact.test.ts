/* eslint-disable no-restricted-imports -- S7b:打包产物的冒烟 / 隔离 / 确定性验证必须起子进程(vite build、node dist/cli.js);
   test/ 下的 child_process 限制属 eslint.config.js 的共享热点(同 test/accept/helpers.ts),待主代理加 override 后可去掉本行。 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkBundle, parseLicenses, readDist } from '../../scripts/lib/bundle-gate.mjs';
import { readBytes, readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { makeSandbox } from './helpers.js';
import type { Sandbox } from './helpers.js';

/**
 * 对「真实打包产物」的验证:在 KIT_TMP 里用 vite 构建两份(A/B),
 *  - 静态闸对 A 零违规;A/B 逐字节相同(确定性);
 *  - 把 A 拷到**没有任何 node_modules 的祖先目录**里跑 CLI,输出与 tsc 产物逐字一致;
 *  - 完整 sigstore 依赖树在产物里离线验签 rc.0 真实夹具通过,篡改签名则被拒。
 * 不依赖仓库里已有的 dist/(自己构建),所以与 `pnpm run build` 的先后无关。
 */

const SAFE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
const VITE_BIN = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const TSC_BIN = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const TSC_OUT = path.join(REPO_ROOT, 'node_modules', '.cache', 'agent-kit-tsc');
const FIXTURES = path.join(REPO_ROOT, 'test', 'update', 'fixtures');

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

function node(args: string[], opts: { cwd: string; env: Record<string, string> }): Ran {
  const r = spawnSync(process.execPath, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: SAFE_PATH, ...opts.env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function listFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readDir(path.join(dir, rel))) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory) out.push(...(await listFiles(dir, r)));
    else out.push(r);
  }
  return out.sort();
}

async function copyTree(sb: Sandbox, from: string, to: string): Promise<void> {
  await safe.mkdirp(sb.wctx, to);
  for (const rel of await listFiles(from)) {
    await safe.mkdirp(sb.wctx, path.dirname(path.join(to, rel)));
    await safe.copyFile(sb.wctx, path.join(from, rel), path.join(to, rel));
  }
}

async function hashTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await listFiles(dir))
    out[rel] = createHash('sha256')
      .update(await readBytes(path.join(dir, rel)))
      .digest('hex');
  return out;
}

/** 从 dir 往上,是否有任何祖先目录含 node_modules(有就不算「隔离」) */
async function ancestorWithNodeModules(dir: string): Promise<string | undefined> {
  let cur = dir;
  for (;;) {
    for (const e of await readDir(cur).catch(() => [])) if (e.name === 'node_modules') return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

let sb: Sandbox;
let distA: string;
let distB: string;
let childEnv: Record<string, string>;

function buildInto(out: string): void {
  const v = node([VITE_BIN, 'build', '--outDir', out, '--emptyOutDir'], {
    cwd: REPO_ROOT,
    env: { HOME: sb.home, KIT_TMP: sb.dir },
  });
  expect(v.stderr).not.toMatch(/error/i);
  expect(v.status).toBe(0);
  const g = node([path.join(REPO_ROOT, 'scripts', 'gen-third-party-licenses.mjs'), '--dist', out], {
    cwd: REPO_ROOT,
    env: { HOME: sb.home },
  });
  expect(g.stderr).toBe('');
  expect(g.status).toBe(0);
}

beforeAll(async () => {
  sb = await makeSandbox('bundle-');
  childEnv = { HOME: sb.home, KIT_TMP: sb.dir, KIT_AUTO_UPDATE: '0' };
  distA = path.join(sb.dir, 'build-a', 'dist');
  distB = path.join(sb.dir, 'build-b', 'dist');
  buildInto(distA);
  buildInto(distB);
  // tsc 产物(对照基线):输出到仓库的构建期缓存目录,依赖仍从仓库 node_modules 解析
  const t = node([TSC_BIN, '-p', 'tsconfig.build.json'], {
    cwd: REPO_ROOT,
    env: { HOME: sb.home },
  });
  expect(t.status, t.stdout + t.stderr).toBe(0);
}, 240_000);

describe('打包产物:静态闸与结构', () => {
  it('静态闸对真实产物零违规;入口是薄入口;sigstore 被拆成动态 chunk 且已打进产物', async () => {
    const pkg = JSON.parse(await readText(path.join(REPO_ROOT, 'package.json'))) as {
      bin: Record<string, string>;
    };
    // dist 在 KIT_TMP/build-a/dist;gate 以「包根相对路径 dist/…」为键
    const { files, symlinks } = readDist(path.dirname(distA), 'dist');
    const v = checkBundle({
      pkg,
      files,
      symlinks,
      integrityPaths: [...files.keys()],
      homeDir: sb.home,
    });
    expect(v).toEqual([]);

    const cli = Buffer.from(files.get('dist/cli.js') as Uint8Array).toString('utf8');
    expect(cli).toMatch(/^#!\/usr\/bin\/env node\n/);
    expect(cli.length).toBeLessThan(2048);
    // 主程序在另一个 chunk,由入口静态加载(不惰性)
    expect(cli).toMatch(/^import .* from "\.\/chunks\/[^"]+";$/m);
    expect(files.has('dist/main.js')).toBe(true);

    // provenance 里的 import('sigstore') 变成指向 chunk 的相对动态 import
    // S7c-A 起安装器静态引用 provenance,其实现被拆进共享 chunk(chunks/provenance-*.js),入口 dist/provenance.js 只做再导出
    const prov = [...files.entries()]
      .filter(([k]) => k === 'dist/provenance.js' || k.startsWith('dist/chunks/provenance-'))
      .map(([, v]) => Buffer.from(v).toString('utf8'))
      .join('\n');
    expect(prov).toMatch(/await import\("\.\/(?:chunks\/)?dist-[^"]+\.js"\)/);
    expect(prov).not.toMatch(/import\(["']sigstore["']\)/);
    const lic = parseLicenses(
      Buffer.from(files.get('dist/THIRD_PARTY_LICENSES') as Uint8Array).toString('utf8'),
    );
    const names = lic.map((e) => e.id.slice(0, e.id.lastIndexOf('@')));
    for (const n of [
      'zod',
      'yaml',
      'smol-toml',
      'sigstore',
      '@sigstore/verify',
      'tuf-js',
      'make-fetch-happen',
      'cacache',
    ])
      expect(names).toContain(n);
    expect(lic.length).toBeGreaterThan(45);
    expect(lic.every((e) => e.body !== '' && e.license !== '')).toBe(true);
  });
});

describe('打包产物:确定性', () => {
  it('同输入两次打包(不同输出目录),dist 全部文件逐字节相同', async () => {
    const a = await hashTree(distA);
    const b = await hashTree(distB);
    expect(Object.keys(a).length).toBeGreaterThan(8);
    expect(b).toEqual(a);
  });
});

describe('打包产物:零 node_modules 隔离目录里的冒烟', () => {
  let iso: string;
  beforeAll(async () => {
    iso = path.join(sb.dir, 'iso', 'pkg');
    await copyTree(sb, distA, path.join(iso, 'dist'));
    // 隔离判据:iso 的所有祖先都没有 node_modules;KIT_TMP 缺失时落在仓库内会被这里拦下
    expect(
      await ancestorWithNodeModules(iso),
      '隔离目录的祖先里有 node_modules:先设 KIT_TMP',
    ).toBeUndefined();
  });

  const CASES: string[][] = [
    ['--version'],
    ['--help'],
    ['update'],
    ['doctor'],
    ['sync'],
    ['no-such-command'],
  ];

  it('`--version` 退出 0 并输出 package.json 的版本', async () => {
    const pkg = JSON.parse(await readText(path.join(REPO_ROOT, 'package.json'))) as {
      version: string;
    };
    const r = node([path.join(iso, 'dist', 'cli.js'), '--version'], { cwd: iso, env: childEnv });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it.each(CASES)(
    '`%s`:退出码与 stdout / stderr 和 tsc 产物逐字一致(入口与 chunk 都生效)',
    (...argv) => {
      const bundled = node([path.join(iso, 'dist', 'cli.js'), ...argv], {
        cwd: iso,
        env: childEnv,
      });
      const tsc = node([path.join(TSC_OUT, 'cli.js'), ...argv], { cwd: iso, env: childEnv });
      expect({ ...bundled }).toEqual({ ...tsc });
      if (argv[0] === '--help') expect(bundled.stdout.length).toBeGreaterThan(100);
    },
  );

  it('隔离目录不会因解析不到依赖而退化:掏空主程序 chunk 后 CLI 必须失败(证明 chunk 真的被加载)', async () => {
    const broken = path.join(sb.dir, 'iso', 'broken');
    await copyTree(sb, distA, path.join(broken, 'dist'));
    const chunks = (await listFiles(path.join(broken, 'dist'))).filter((f) =>
      f.startsWith('chunks/cli-'),
    );
    expect(chunks).toHaveLength(1);
    await safe.writeFile(sb.wctx, path.join(broken, 'dist', chunks[0] as string), 'export {};\n');
    const r = node([path.join(broken, 'dist', 'cli.js'), '--version'], {
      cwd: broken,
      env: childEnv,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not provide an export named/);
  });
});

const DRIVER = `
import { readFileSync } from 'node:fs';
const FIXED = Date.parse('2026-10-14T12:00:00Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(FIXED); }
  static now() { return FIXED; }
};
let fetched = 0;
globalThis.fetch = async () => { fetched++; throw new Error('network is forbidden in tests'); };
const here = new URL('.', import.meta.url).pathname;
const { verifyProvenance } = await import('./dist/provenance.js');
const att = JSON.parse(readFileSync(here + 'att-rc0.json', 'utf8'));
const SHA = process.argv[2];
const input = (doc) => ({ attestationsDoc: doc, tarballSha512Hex: SHA, version: '0.1.0-rc.0', tuf: { cachePath: here + 'tuf', forceCache: true } });
const good = await verifyProvenance(input(att));
const bad = JSON.parse(JSON.stringify(att));
const slsa = bad.attestations.find((a) => a.predicateType === 'https://slsa.dev/provenance/v1');
const sig = slsa.bundle.dsseEnvelope.signatures[0].sig;
slsa.bundle.dsseEnvelope.signatures[0].sig = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
const tampered = await verifyProvenance(input(bad));
console.log(JSON.stringify({ good, tampered, fetched }));
`;

describe('打包产物:完整 sigstore 在零 node_modules 目录里离线验签', () => {
  it('rc.0 真实夹具(att + TUF 缓存)验签通过、不联网;篡改 DSSE 签名被拒', async () => {
    const iso = path.join(sb.dir, 'iso', 'sigstore');
    await copyTree(sb, distA, path.join(iso, 'dist'));
    await copyTree(sb, path.join(FIXTURES, 'tuf-cache'), path.join(iso, 'tuf'));
    await safe.copyFile(
      sb.wctx,
      path.join(FIXTURES, 'att-rc0.json'),
      path.join(iso, 'att-rc0.json'),
    );
    await safe.writeFile(sb.wctx, path.join(iso, 'driver.mjs'), DRIVER);
    expect(
      await ancestorWithNodeModules(iso),
      '隔离目录的祖先里有 node_modules:先设 KIT_TMP',
    ).toBeUndefined();

    const sha =
      '73ea5504f65b040622ce0d3e31a3e67b23e1c5a48766b0a3edda60abf521d98d9d1c83e4f5e103cbcca5be58e91a189152ef100b9c60ec8243fbb5d3b0e4d7df';
    const tmp = path.join(iso, 'tmp');
    await safe.mkdirp(sb.wctx, tmp);
    const r = node([path.join(iso, 'driver.mjs'), sha], {
      cwd: iso,
      env: { ...childEnv, TMPDIR: tmp },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      good: { ok: boolean; subjectAlternativeName?: string; integratedTimeMs?: number };
      tampered: { ok: boolean; reason?: string };
      fetched: number;
    };
    expect(out.good).toMatchObject({
      ok: true,
      subjectAlternativeName:
        'https://github.com/chovizzz/agent-kit/.github/workflows/release.yml@refs/tags/v0.1.0-rc.0',
      integratedTimeMs: 1791947005000,
    });
    // 正向控制:同一条路径上篡改后必须失败,证明上面的 ok 不是「验签被跳过」
    expect(out.tampered.ok).toBe(false);
    expect(out.tampered.reason).toBe('bundle');
    expect(out.fetched).toBe(0);
    // forceCache 离线路径零临时文件
    expect(await listFiles(tmp)).toEqual([]);
  });
});

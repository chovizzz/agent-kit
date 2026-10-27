import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FREEZE_FILE,
  freezeViolations,
  frozenVersionViolations,
} from '../../scripts/lib/freeze-gate.mjs';
import { readText } from '../../src/io/read-fs.js';
import { mkdirp, symlink, writeFile } from '../../src/io/safe-fs.js';
import { makeTempDir, REPO_ROOT } from '../helpers/tmp.js';

/**
 * R20-A2 B5-0:发布冻结五处(RELEASE_FREEZE / check-publish PUBLISH_FROZEN / release.yml 再查一次 / prepublishOnly / ci.yml 版本锁)。
 * 行为用子进程在**只含必要文件的沙箱 cwd** 里跑真脚本(沙箱里没有 package.json 与 dist:证明冻结检查先于读 package.json / 先于要求 dist / 先于 npm pack);
 * 接线用对真实仓库文件的文本断言。每条负例旁边都有同形态的正向对照。
 */

const SAFE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
const CHECK_PUBLISH = path.join(REPO_ROOT, 'scripts', 'check-publish.mjs');
const CHECK_VERSION = path.join(REPO_ROOT, 'scripts', 'check-freeze-version.mjs');

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}
function node(script: string, args: string[], cwd: string): Ran {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: SAFE_PATH },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function sandbox(
  prefix: string,
  freeze: 'none' | 'file' | 'dir' | 'broken-link',
): Promise<string> {
  const { ctx, dir } = await makeTempDir(prefix);
  const target = path.join(dir, FREEZE_FILE);
  if (freeze === 'file') await writeFile(ctx, target, 'frozen\n');
  if (freeze === 'dir') await mkdirp(ctx, target, 0o755);
  if (freeze === 'broken-link') await symlink(ctx, path.join(dir, 'does-not-exist'), target);
  return dir;
}

describe('check-publish.mjs:PUBLISH_FROZEN', () => {
  it('正向对照:没有 RELEASE_FREEZE 时 --freeze-only 退 0', async () => {
    const dir = await sandbox('freeze-none-', 'none');
    const r = node(CHECK_PUBLISH, ['--freeze-only'], dir);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('PUBLISH_FROZEN');
  });

  for (const kind of ['file', 'dir', 'broken-link'] as const) {
    it(`有 RELEASE_FREEZE(${kind})→ 退 1,stderr 以 PUBLISH_FROZEN: 开头;沙箱无 package.json / dist 也是 1 而非 4(先于一切)`, async () => {
      const dir = await sandbox(`freeze-${kind}-`, kind);
      for (const args of [['--freeze-only'], [], ['--tag', 'v0.1.0']]) {
        const r = node(CHECK_PUBLISH, args, dir);
        expect(r.status, `${kind} ${args.join(' ')}`).toBe(1);
        expect(r.stderr.startsWith('PUBLISH_FROZEN: ')).toBe(true);
        expect(r.stdout).toBe('');
      }
    });
  }

  it('反向对照:完整模式无冻结时不报 PUBLISH_FROZEN(沙箱里缺 package.json,脚本在后面的步骤失败)', async () => {
    const dir = await sandbox('freeze-none-full-', 'none');
    const r = node(CHECK_PUBLISH, [], dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain('PUBLISH_FROZEN');
  });

  it('用法:未知参数退 2(--freeze-only 是新增的合法参数)', async () => {
    const dir = await sandbox('freeze-usage-', 'none');
    expect(node(CHECK_PUBLISH, ['--bogus'], dir).status).toBe(2);
    expect(node(CHECK_PUBLISH, ['--freeze-only', '--tag', 'v0.1.0'], dir).status).toBe(2); // 互斥:不能让 --tag 被静默忽略
    expect(node(CHECK_PUBLISH, ['--freeze-only'], dir).status).toBe(0);
  });

  it('真实仓库根现在就是冻结的:--freeze-only 退 1', () => {
    const r = node(CHECK_PUBLISH, ['--freeze-only'], REPO_ROOT);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PUBLISH_FROZEN');
  });
});

describe('freeze-gate 纯函数', () => {
  it('freezeViolations:无 → 空;文件 / 目录 / 断链符号链接 → 各一条 PUBLISH_FROZEN', async () => {
    expect(freezeViolations(await sandbox('fg-none-', 'none'))).toEqual([]);
    for (const kind of ['file', 'dir', 'broken-link'] as const) {
      const v = freezeViolations(await sandbox(`fg-${kind}-`, kind));
      expect(v, kind).toHaveLength(1);
      expect(v[0]).toMatch(/^PUBLISH_FROZEN: /);
    }
  });
});

describe('check-freeze-version.mjs(ci.yml 的版本锁)', () => {
  async function withVersions(
    prefix: string,
    v: { pkg: string; meta: string; toml: string },
    freeze: 'none' | 'file',
  ): Promise<string> {
    const { ctx, dir } = await makeTempDir(prefix);
    if (freeze === 'file') await writeFile(ctx, path.join(dir, FREEZE_FILE), 'frozen\n');
    await writeFile(ctx, path.join(dir, 'package.json'), JSON.stringify({ version: v.pkg }));
    await mkdirp(ctx, path.join(dir, 'src', 'contracts'), 0o755);
    await writeFile(
      ctx,
      path.join(dir, 'src', 'contracts', 'meta.ts'),
      `export const KIT_VERSION = '${v.meta}';\n`,
    );
    await writeFile(ctx, path.join(dir, 'kit.toml'), `version = "${v.toml}"\n`);
    return dir;
  }
  const good = { pkg: '0.1.0', meta: '0.1.0', toml: '0.1.0' };

  it('冻结 + 三处都是 0.1.0 → 退 0(正向对照)', async () => {
    const dir = await withVersions('fv-ok-', good, 'file');
    expect(node(CHECK_VERSION, [], dir).status).toBe(0);
    expect(frozenVersionViolations(dir)).toEqual([]);
  });

  for (const which of ['pkg', 'meta', 'toml'] as const) {
    it(`冻结 + ${which} 改成 0.1.1 → 退 1,stderr 含 PUBLISH_FROZEN_VERSION`, async () => {
      const dir = await withVersions(`fv-bad-${which}-`, { ...good, [which]: '0.1.1' }, 'file');
      const r = node(CHECK_VERSION, [], dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('PUBLISH_FROZEN_VERSION');
    });
  }

  it('未冻结 → 不检查版本(同样的 0.1.1 退 0);冻结但读不出版本源 → 退 1(fail-closed)', async () => {
    const dir = await withVersions(
      'fv-nofreeze-',
      { pkg: '0.1.1', meta: '0.1.1', toml: '0.1.1' },
      'none',
    );
    expect(node(CHECK_VERSION, [], dir).status).toBe(0);
    const empty = await sandbox('fv-nosrc-', 'file');
    expect(node(CHECK_VERSION, [], empty).status).toBe(1);
  });

  it('真实仓库当前通过(冻结 + 版本 0.1.0)', () => {
    expect(node(CHECK_VERSION, [], REPO_ROOT).status).toBe(0);
  });
});

describe('接线(对真实仓库文件的文本断言)', () => {
  it('RELEASE_FREEZE 在仓库根、写明原因与解除条件、没有被 .gitignore 忽略', async () => {
    const text = await readText(path.join(REPO_ROOT, FREEZE_FILE));
    expect(text).toContain('Reason:');
    expect(text).toContain('Lift:');
    const ignore = await readText(path.join(REPO_ROOT, '.gitignore'));
    expect(ignore.split('\n').filter((l) => /RELEASE_FREEZE/.test(l))).toEqual([]);
    expect(ignore.split('\n').map((l) => l.trim())).not.toContain('*');
  });

  it('package.json 的 files 白名单不含 RELEASE_FREEZE(冻结文件不进 npm 包;解除冻结时别顺手加进去)', async () => {
    const pkg = JSON.parse(await readText(path.join(REPO_ROOT, 'package.json'))) as {
      files: string[];
    };
    expect(pkg.files.length).toBeGreaterThan(0); // 正向前提:白名单存在且非空,断言才有意义
    expect(pkg.files.filter((f) => f.includes(FREEZE_FILE))).toEqual([]);
  });

  it('package.json:prepublishOnly 调 check-publish --freeze-only;version 仍是 0.1.0', async () => {
    const pkg = JSON.parse(await readText(path.join(REPO_ROOT, 'package.json'))) as {
      version: string;
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['prepublishOnly']).toBe('node scripts/check-publish.mjs --freeze-only');
    expect(pkg.version).toBe('0.1.0');
  });

  it('release.yml:发布前有独立的冻结步骤(含 -L,晚于 check-publish、早于 npm publish),且 npm publish 仍带 --ignore-scripts', async () => {
    const y = await readText(path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'));
    const preflight = y.indexOf('node scripts/check-publish.mjs --tag');
    const gate = y.indexOf('- name: Release freeze must be lifted');
    const publish = y.indexOf('- name: Publish to npm');
    expect(preflight).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(preflight);
    expect(publish).toBeGreaterThan(gate);
    const step = y.slice(gate, publish);
    expect(step).toContain('[ -e RELEASE_FREEZE ]');
    expect(step).toContain('[ -L RELEASE_FREEZE ]');
    expect(step).toContain('exit 1');
    expect(y.slice(publish)).toContain('--ignore-scripts');
  });

  it('ci.yml:有版本锁步骤并调用 check-freeze-version.mjs', async () => {
    const y = await readText(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'));
    expect(y).toContain('- name: Release freeze keeps version at 0.1.0');
    expect(y).toContain('run: node scripts/check-freeze-version.mjs');
  });
});

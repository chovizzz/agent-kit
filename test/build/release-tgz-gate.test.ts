/**
 * D-AU3 发布前门禁脚本 scripts/check-release-tgz.mjs(docs/contracts.md §19.9.1):对**真实 npm pack 产物**,
 * 好包通过;每一类坏包被拒且只触发对应的稳定码。release.yml 在 `npm publish` 之前对实际待发布的 tgz 调用它。
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import {
  buildRealPack,
  ensureTscOut,
  repackReal,
  type EditableFile,
  type RealPack,
} from './real-pack-helper.js';

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-release-tgz.mjs');
const SAFE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

let real: RealPack;

beforeAll(async () => {
  real = await buildRealPack('reltgz-');
  ensureTscOut(real.sb);
}, 300_000);

interface Gate {
  code: number | null;
  out: string;
  err: string;
}

function gate(tgzPath: string, tag: string): Gate {
  const r = spawnSync(process.execPath, [SCRIPT, tgzPath, '--tag', tag], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { PATH: SAFE_PATH, HOME: real.sb.home, KIT_TMP: real.sb.dir },
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

let n = 0;
async function gateEdited(edit: (f: EditableFile[]) => void, tag = `v${real.version}`): Promise<Gate> {
  const pkg = repackReal(real, edit);
  const p = path.join(real.sb.dir, `edited-${++n}.tgz`);
  await safe.writeFile(real.sb.wctx, p, pkg.tgz);
  return gate(p, tag);
}

const codes = (g: Gate): string[] => [...g.err.matchAll(/^(REL_[A-Z_]+):/gm)].map((m) => m[1] as string);
const setBin = (f: EditableFile[], fn: (b: EditableFile) => void): void => {
  const b = f.find((x) => x.path === 'dist/cli.js');
  expect(b).toBeDefined();
  if (b !== undefined) fn(b);
};

describe('发布前门禁 check-release-tgz.mjs(真实 npm pack 产物)', () => {
  it('好包:真实产物(bin 0755、checkPackage / staticSmoke 通过、--version 等于 tag)→ 退出 0', () => {
    const g = gate(real.tgzPath, `v${real.version}`);
    expect(g.err).toBe('');
    expect(g.code).toBe(0);
    expect(g.out).toContain('通过');
  });

  it('好包对照:同一内容重打包、bin 仍是 0755 → 通过(证明下面的拒绝来自被改的那一处)', async () => {
    const g = await gateEdited(() => undefined);
    expect(g.err).toBe('');
    expect(g.code).toBe(0);
  });

  it('坏包:tar header 里 bin 是 0644(0.3.0–0.3.3 的形态)→ REL_BIN_MODE,只此一项', async () => {
    const g = await gateEdited((f) => setBin(f, (b) => (b.mode = 0o644)));
    expect(g.code).toBe(1);
    expect(codes(g)).toEqual(['REL_BIN_MODE']);
  });

  it('坏包:bin 带特殊位(04755 / 02755)也不合格 → REL_BIN_MODE', async () => {
    for (const mode of [0o4755, 0o2755]) {
      const g = await gateEdited((f) => setBin(f, (b) => (b.mode = mode)));
      expect(g.code, mode.toString(8)).toBe(1);
      expect(codes(g), mode.toString(8)).toEqual(['REL_BIN_MODE']);
    }
  });

  it('坏包:tag 与包内版本不一致 → REL_PACKAGE(checkPackage 拒绝)', async () => {
    const g = await gateEdited(() => undefined, 'v9.9.9');
    expect(g.code).toBe(1);
    expect(codes(g)).toContain('REL_PACKAGE');
  });

  it('坏包:bin 首两字节不是 #!(integrity 已重算)→ REL_SMOKE', async () => {
    const g = await gateEdited((f) =>
      setBin(f, (b) => (b.bytes = Buffer.concat([Buffer.from('//'), b.bytes.subarray(2)]))),
    );
    expect(g.code).toBe(1);
    expect(codes(g)).toEqual(['REL_SMOKE']);
  });

  it('坏包:解包后 --version 输出不等于 tag 版本(integrity 已重算)→ REL_VERSION_RUN,只此一项', async () => {
    const g = await gateEdited((f) =>
      setBin(f, (b) => (b.bytes = Buffer.from("#!/usr/bin/env node\nconsole.log('9.9.9');\n"))),
    );
    expect(g.code).toBe(1);
    expect(codes(g)).toEqual(['REL_VERSION_RUN']);
  });

  it('用法错:缺 --tag / tag 形态不对 → 退出 2', () => {
    expect(gate(real.tgzPath, 'latest').code).toBe(2);
    const r = spawnSync(process.execPath, [SCRIPT, real.tgzPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { PATH: SAFE_PATH },
    });
    expect(r.status).toBe(2);
  });

  it('接线:release.yml 先 pack、再跑门禁脚本、最后 npm publish 的恰是同一个 tgz,且都晚于冻结步骤', async () => {
    const y = await readText(path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'));
    const freeze = y.indexOf('- name: Release freeze must be lifted');
    const packStep = y.indexOf('- name: Pack and gate the release tarball');
    const publish = y.indexOf('- name: Publish to npm');
    expect(freeze).toBeGreaterThan(0);
    expect(packStep).toBeGreaterThan(freeze);
    expect(publish).toBeGreaterThan(packStep);
    const step = y.slice(packStep, publish);
    expect(step).toContain('npm pack --ignore-scripts');
    expect(step).toContain('node scripts/check-release-tgz.mjs "$TGZ" --tag "${GITHUB_REF_NAME}"');
    expect(step).toContain('RELEASE_TGZ=$TGZ');
    const pub = y.slice(publish);
    expect(pub).toContain('npm publish "$RELEASE_TGZ"');
    expect(pub).toContain('--ignore-scripts');
  });
});

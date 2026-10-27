/**
 * R20-A2 B2:`[rsi]` 配置分层解析(docs/contracts.md §20.2 R20-2.2 ~ R20-2.7)。每个原因码都对着真实文件造一遍。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RSI_MAX_EXCLUDE_ITEMS } from '../../src/contracts/rsi.js';
import {
  RSI_CONFIG_MAX_BYTES,
  buildRsiPolicy,
  kitMajor,
  loadRsiConfig,
  policyFingerprint,
  type RsiConfig,
  type RsiConfigOn,
} from '../../src/rsi/config.js';
import { chmod, hardlink, mkdirp, remove, symlink, writeFile } from '../../src/io/safe-fs.js';
import { privacyGate } from '../../src/rsi/gate.js';
import { makeRsiFx, rsiToml, writeCfg, type RsiFx } from './rsi-fixture.js';

const myUid = (): number => process.getuid?.() ?? 0;
const load = (f: RsiFx, uid?: number): Promise<RsiConfig> =>
  loadRsiConfig({ home: f.home, ...(uid !== undefined ? { uid } : {}) });

function expectOn(c: RsiConfig): RsiConfigOn {
  if (c.status !== 'on') throw new Error(`expected on, got off(${c.reason})`);
  return c;
}

describe('R20-2.2 / 2.7 文件层:不存在 = absent,其余失败各有原因码(都是 off)', () => {
  it('HOME 里没有 .config、没有 agent-kit 目录、没有 config.toml → off/absent', async () => {
    const f = await makeRsiFx('cfg-absent-');
    expect(await load(f)).toEqual({ status: 'off', reason: 'absent' });
    await remove(f.fx, f.cfgFile);
    expect(await load(f)).toEqual({ status: 'off', reason: 'absent' }); // 目录在、文件不在
    await remove(f.fx, f.cfgDir);
    expect(await load(f)).toEqual({ status: 'off', reason: 'absent' });
    await remove(f.fx, path.join(f.home, '.config'));
    expect(await load(f)).toEqual({ status: 'off', reason: 'absent' });
  });

  it('config.toml 是符号链接 → cfg_symlink;.config 或 .config/agent-kit 是符号链接 → cfg_symlink', async () => {
    const f = await makeRsiFx('cfg-symlink-');
    const real = path.join(f.dir, 'real.toml');
    await writeFile(f.fx, real, rsiToml(f), { mode: 0o600 });
    await symlink(f.fx, real, f.cfgFile);
    expect(await load(f)).toEqual({ status: 'off', reason: 'cfg_symlink' });
    await remove(f.fx, f.cfgFile);
    // agent-kit 目录换成链接
    const g = await makeRsiFx('cfg-symlink-dir-');
    const realDir = path.join(g.dir, 'realdir');
    await mkdirp(g.fx, realDir, 0o755);
    await writeFile(g.fx, path.join(realDir, 'config.toml'), rsiToml(g), { mode: 0o600 });
    await remove(g.fx, g.cfgDir);
    await symlink(g.fx, realDir, g.cfgDir);
    expect(await load(g)).toEqual({ status: 'off', reason: 'cfg_symlink' });
    // .config 换成链接
    const h = await makeRsiFx('cfg-symlink-dotconfig-');
    const realDot = path.join(h.dir, 'realdot');
    await mkdirp(h.fx, path.join(realDot, 'agent-kit'), 0o755);
    await writeFile(h.fx, path.join(realDot, 'agent-kit', 'config.toml'), rsiToml(h), {
      mode: 0o600,
    });
    await remove(h.fx, path.join(h.home, '.config'));
    await symlink(h.fx, realDot, path.join(h.home, '.config'));
    expect(await load(h)).toEqual({ status: 'off', reason: 'cfg_symlink' });
  });

  it('属主不是当前 uid → cfg_owner(文件与两级目录各一遍)', async () => {
    const f = await makeRsiFx('cfg-owner-');
    await writeCfg(f, rsiToml(f));
    expect(expectOn(await load(f)).repo).toBe(f.repo); // 对照:属主正确 → on
    expect(await load(f, myUid() + 1)).toEqual({ status: 'off', reason: 'cfg_owner' });
  });

  it('组 / 其他人可写 → cfg_perm(文件 0664 / 0622;目录 .config 0775、agent-kit 0757);0644 / 0755 过', async () => {
    const f = await makeRsiFx('cfg-perm-');
    for (const m of [0o664, 0o622, 0o666, 0o646]) {
      await writeCfg(f, rsiToml(f), m);
      expect(await load(f), m.toString(8)).toEqual({ status: 'off', reason: 'cfg_perm' });
    }
    await writeCfg(f, rsiToml(f), 0o644);
    expect(expectOn(await load(f)).repo).toBe(f.repo);
    await chmod(f.fx, f.cfgDir, 0o757);
    expect(await load(f)).toEqual({ status: 'off', reason: 'cfg_perm' });
    await chmod(f.fx, f.cfgDir, 0o755);
    await chmod(f.fx, path.join(f.home, '.config'), 0o775);
    expect(await load(f)).toEqual({ status: 'off', reason: 'cfg_perm' });
    await chmod(f.fx, path.join(f.home, '.config'), 0o755);
    expect(expectOn(await load(f)).repo).toBe(f.repo);
  });

  it('硬链接 / 目录冒充 config.toml → cfg_not_regular', async () => {
    const f = await makeRsiFx('cfg-notreg-');
    await writeCfg(f, rsiToml(f));
    await hardlink(f.fx, f.cfgFile, path.join(f.dir, 'alias.toml'));
    expect(await load(f)).toEqual({ status: 'off', reason: 'cfg_not_regular' });
    const g = await makeRsiFx('cfg-notreg-dir-');
    await mkdirp(g.fx, g.cfgFile, 0o755);
    expect(await load(g)).toEqual({ status: 'off', reason: 'cfg_not_regular' });
  });

  it('超过 64KiB → cfg_too_large(恰 64KiB 过文件层,再多一字节拒)', async () => {
    const f = await makeRsiFx('cfg-big-');
    const body = rsiToml(f);
    const pad = (n: number): string => `# ${'x'.repeat(n - 3)}\n`;
    await writeCfg(f, body + pad(RSI_CONFIG_MAX_BYTES - Buffer.byteLength(body)));
    expect(expectOn(await load(f)).repo).toBe(f.repo);
    await writeCfg(f, body + pad(RSI_CONFIG_MAX_BYTES - Buffer.byteLength(body) + 1));
    expect(await load(f)).toEqual({ status: 'off', reason: 'cfg_too_large' });
  });

  it('读取权限错误(0000)→ cfg_unreadable', async () => {
    const f = await makeRsiFx('cfg-unreadable-');
    await writeCfg(f, rsiToml(f));
    await chmod(f.fx, f.cfgFile, 0o000);
    if (myUid() === 0) return; // root 读得了 0000,该前提不成立
    expect(await load(f)).toEqual({ status: 'off', reason: 'cfg_unreadable' });
  });
});

describe('R20-2.6 分层:L-toml / L-base / L-enabled / L-repo,先命中先报', () => {
  it('TOML 解析失败 → cfg_parse;没有 [rsi] 段 → no_section', async () => {
    const f = await makeRsiFx('cfg-parse-');
    await writeCfg(f, 'this is = = not toml');
    expect(await load(f)).toEqual({ status: 'off', reason: 'cfg_parse' });
    await writeCfg(f, '[update]\nauto_install = true\n');
    expect(await load(f)).toEqual({ status: 'off', reason: 'no_section' });
  });

  const schemaBad: [string, string][] = [
    ['enabled 是字符串 "true"(不是 disabled)', 'enabled = "true"\n'],
    ['agents 含 kimi(变异:接受 kimi → 红)', 'enabled = true\nagents = ["kimi"]\n'],
    ['agents 为空数组', 'enabled = true\nagents = []\n'],
    ['未知键', 'enabled = true\nmystery = 1\n'],
    ['v3.1 的 auto 表在 R20 不被接受', 'enabled = true\n[rsi.auto]\nenabled = true\n'],
    ['session 不是表', 'enabled = true\nsession = 5\n'],
    ['exclude_dirs 不是数组', 'enabled = true\nexclude_dirs = "x"\n'],
    ['exclude_names 含非字符串', 'enabled = true\nexclude_names = [1]\n'],
    [
      `exclude_dirs 超过 ${RSI_MAX_EXCLUDE_ITEMS} 项`,
      `enabled = true\nexclude_dirs = [${Array.from({ length: RSI_MAX_EXCLUDE_ITEMS + 1 }, (_, i) => `"/x${i}"`).join(',')}]\n`,
    ],
  ];
  for (const [name, body] of schemaBad) {
    it(`L-base 失败 → cfg_schema:${name}`, async () => {
      const f = await makeRsiFx('cfg-schema-');
      await writeCfg(f, `[rsi]\n${body}`);
      expect(await load(f)).toEqual({ status: 'off', reason: 'cfg_schema' });
    });
  }

  it('R20-1.2 缺省 enabled=false:没有 enabled / enabled=false → off/disabled(变异:缺省改成开启 → 红)', async () => {
    const f = await makeRsiFx('cfg-disabled-');
    await writeCfg(f, `[rsi]\nrepo = ${JSON.stringify(f.repo)}\n`);
    expect(await load(f)).toEqual({ status: 'off', reason: 'disabled' });
    await writeCfg(f, `[rsi]\nenabled = false\nrepo = ${JSON.stringify(f.repo)}\n`);
    expect(await load(f)).toEqual({ status: 'off', reason: 'disabled' });
    await writeCfg(f, '[rsi]\n');
    expect(await load(f)).toEqual({ status: 'off', reason: 'disabled' });
  });

  it('优先级:L-base 先于 L-enabled(enabled=false 但 agents 非法 → cfg_schema);L-enabled 先于 L-repo(disabled + 坏 repo → disabled)', async () => {
    const f = await makeRsiFx('cfg-prio-');
    await writeCfg(f, '[rsi]\nenabled = false\nagents = ["kimi"]\n');
    expect(await load(f)).toEqual({ status: 'off', reason: 'cfg_schema' });
    await writeCfg(f, '[rsi]\nenabled = false\nrepo = "relative"\n');
    expect(await load(f)).toEqual({ status: 'off', reason: 'disabled' });
  });

  it('L-repo:缺失 / 相对路径 / 不存在 / 不是目录 / 无 kit.toml / 经符号链接(realpath 不等)/ 组可写 → repo_invalid(off)', async () => {
    const f = await makeRsiFx('cfg-repo-');
    await writeCfg(f, rsiToml(f, '', { repo: null }));
    expect(await load(f)).toEqual({ status: 'off', reason: 'repo_invalid' });
    for (const repo of ['relative/path', path.join(f.dir, 'nope'), f.cfgFile]) {
      await writeCfg(f, rsiToml(f, '', { repo }));
      expect(await load(f), repo).toEqual({ status: 'off', reason: 'repo_invalid' });
    }
    const noKit = path.join(f.dir, 'nokit');
    await mkdirp(f.fx, noKit, 0o755);
    await writeCfg(f, rsiToml(f, '', { repo: noKit }));
    expect(await load(f)).toEqual({ status: 'off', reason: 'repo_invalid' });
    // kit.toml 是符号链接不算「普通文件」
    const linkKit = path.join(f.dir, 'linkkit');
    await mkdirp(f.fx, linkKit, 0o755);
    await symlink(f.fx, path.join(f.repo, 'kit.toml'), path.join(linkKit, 'kit.toml'));
    await writeCfg(f, rsiToml(f, '', { repo: linkKit }));
    expect(await load(f)).toEqual({ status: 'off', reason: 'repo_invalid' });
    // realpath(repo) !== repo
    const viaLink = path.join(f.dir, 'repolink');
    await symlink(f.fx, f.repo, viaLink);
    await writeCfg(f, rsiToml(f, '', { repo: viaLink }));
    expect(await load(f)).toEqual({ status: 'off', reason: 'repo_invalid' });
    // 组可写
    await chmod(f.fx, f.repo, 0o775);
    await writeCfg(f, rsiToml(f));
    expect(await load(f)).toEqual({ status: 'off', reason: 'repo_invalid' });
    await chmod(f.fx, f.repo, 0o755);
    expect(expectOn(await load(f)).repo).toBe(f.repo);
  });
});

describe('on:缺省值、去重、overlay_absent', () => {
  it('最小合法配置:agents 缺省三家(升序)、无排除、block=null、warnings=overlay_absent', async () => {
    const f = await makeRsiFx('cfg-on-');
    await writeCfg(f, rsiToml(f));
    expect(await load(f)).toEqual({
      status: 'on',
      repo: f.repo,
      overlayPath: null,
      overlaySha256: null,
      agents: ['claude', 'codex', 'pi'],
      excludeDirs: [],
      excludeNames: [],
      block: null,
      warnings: ['overlay_absent'],
    });
  });

  it('agents 去重并升序;重复排除项去重,不报错', async () => {
    const f = await makeRsiFx('cfg-dedupe-');
    await writeCfg(
      f,
      rsiToml(
        f,
        'agents = ["pi","claude","pi"]\nexclude_dirs = ["/a","/a","/b"]\nexclude_names = ["x","x"]\n',
      ),
    );
    const c = expectOn(await load(f));
    expect(c.agents).toEqual(['claude', 'pi']);
    expect(c.excludeDirs).toEqual(['/a', '/b']);
    expect(c.excludeNames).toEqual(['x']);
    expect(c.block).toBeNull();
  });

  it('exclude_dirs 某项不存在 → 照常生效(不报错、不 block)', async () => {
    const f = await makeRsiFx('cfg-nonexist-');
    await writeCfg(f, rsiToml(f, `exclude_dirs = [${JSON.stringify(path.join(f.dir, 'gone'))}]\n`));
    const c = expectOn(await load(f));
    expect(c.block).toBeNull();
    expect(c.excludeDirs).toHaveLength(1);
  });
});

describe('L-overlay / L-policy:停止采集(状态照算,不是 off)', () => {
  async function overlay(f: RsiFx, toml: string, mode = 0o600): Promise<string> {
    const p = path.join(f.dir, 'overlay.toml');
    await writeFile(f.fx, p, toml, { mode });
    await chmod(f.fx, p, mode);
    return p;
  }

  it('合法 overlay:给出内容 sha256,exclude_dirs 与 [rsi] 取并集;没有 overlay_absent 提示', async () => {
    const f = await makeRsiFx('cfg-overlay-ok-');
    const ov = await overlay(f, 'exclude_dirs = ["/from-overlay"]\nsensitive_words = ["acme"]\n');
    await writeCfg(f, rsiToml(f, `overlay = ${JSON.stringify(ov)}\nexclude_dirs = ["/own"]\n`));
    const c = expectOn(await load(f));
    expect(c.block).toBeNull();
    expect(c.overlayPath).toBe(ov);
    expect(c.overlaySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.excludeDirs).toEqual(['/own', '/from-overlay']);
    expect(c.warnings).toEqual([]);
  });

  it('overlay 不合规 → on + block=overlay_invalid(变异:当成 off → 红):相对路径 / 不存在 / 过不了 OverlaySchema / 组可写 / 经符号链接', async () => {
    const f = await makeRsiFx('cfg-overlay-bad-');
    const good = await overlay(f, 'exclude_dirs = ["/x"]\n');
    const cases: [string, string][] = [
      ['相对路径', 'overlay.toml'],
      ['不存在', path.join(f.dir, 'none.toml')],
      ['目录', f.repo],
    ];
    for (const [name, p] of cases) {
      await writeCfg(f, rsiToml(f, `overlay = ${JSON.stringify(p)}\n`));
      const c = expectOn(await load(f));
      expect(c.block, name).toBe('overlay_invalid');
      expect(c.overlaySha256, name).toBeNull();
    }
    // 过不了 schema
    const badSchema = path.join(f.dir, 'bad-schema.toml');
    await writeFile(f.fx, badSchema, 'unknown_key = 1\n', { mode: 0o600 });
    await writeCfg(f, rsiToml(f, `overlay = ${JSON.stringify(badSchema)}\n`));
    expect(expectOn(await load(f)).block).toBe('overlay_invalid');
    // 组可写
    await chmod(f.fx, good, 0o664);
    await writeCfg(f, rsiToml(f, `overlay = ${JSON.stringify(good)}\n`));
    expect(expectOn(await load(f)).block).toBe('overlay_invalid');
    await chmod(f.fx, good, 0o600);
    expect(expectOn(await load(f)).block).toBeNull(); // 对照
    // 经符号链接
    const lnk = path.join(f.dir, 'overlay-link.toml');
    await symlink(f.fx, good, lnk);
    await writeCfg(f, rsiToml(f, `overlay = ${JSON.stringify(lnk)}\n`));
    expect(expectOn(await load(f)).block).toBe('overlay_invalid');
  });

  const badPolicy: [string, string][] = [
    ['exclude_dirs 含相对路径', 'exclude_dirs = ["clients"]\n'],
    ['exclude_dirs 含控制字符', 'exclude_dirs = ["/a\\u0007b"]\n'],
    ['exclude_dirs 含 NUL', 'exclude_dirs = ["/a\\u0000b"]\n'],
    [`exclude_dirs 超过 4096 字节`, `exclude_dirs = ["/${'x'.repeat(4096)}"]\n`],
    ['exclude_names 含 /', 'exclude_names = ["a/b"]\n'],
    ['exclude_names 是 ..', 'exclude_names = [".."]\n'],
    ['exclude_names 是 .', 'exclude_names = ["."]\n'],
    ['exclude_names 为空串', 'exclude_names = [""]\n'],
    ['exclude_names 超过 255 字节', `exclude_names = ["${'x'.repeat(256)}"]\n`],
    ['exclude_names 含 C1 控制字符', 'exclude_names = ["a\\u0085b"]\n'],
  ];
  for (const [name, body] of badPolicy) {
    it(`L-policy 失败 → on + block=exclude_invalid(不是「少排除一项继续采」,也不是 off):${name}`, async () => {
      const f = await makeRsiFx('cfg-policy-');
      await writeCfg(f, rsiToml(f, body));
      const c = expectOn(await load(f));
      expect(c.block).toBe('exclude_invalid');
    });
  }

  const badOverlayDirs: [string, string][] = [
    ['相对路径', 'exclude_dirs = ["clients"]\n'],
    ['控制字符', 'exclude_dirs = ["/a\\u0007b"]\n'],
    ['超过 4096 字节', `exclude_dirs = ["/${'x'.repeat(4096)}"]\n`],
  ];
  for (const [name, body] of badOverlayDirs) {
    it(`overlay 的 exclude_dirs 同样过 L-policy:${name} → on + block=exclude_invalid(不是静默 enforce / 丢弃)`, async () => {
      const f = await makeRsiFx('cfg-overlay-dirs-');
      const ov = await overlay(f, body);
      await writeCfg(f, rsiToml(f, `overlay = ${JSON.stringify(ov)}\n`));
      const c = expectOn(await load(f));
      expect(c.block).toBe('exclude_invalid');
      expect(c.overlaySha256).toMatch(/^[0-9a-f]{64}$/); // overlay 本身合规,问题在排除项内容
      expect(privacyGate(c)).toMatchObject({ kind: 'deny', reason: 'exclude_invalid' });
    });
  }

  it('overlay 里合法但不存在的绝对目录照常生效(不 block、privacyGate=enforce)', async () => {
    const f = await makeRsiFx('cfg-overlay-dirs-ok-');
    const ov = await overlay(f, `exclude_dirs = [${JSON.stringify(path.join(f.dir, 'gone'))}]\n`);
    await writeCfg(f, rsiToml(f, `overlay = ${JSON.stringify(ov)}\n`));
    const c = expectOn(await load(f));
    expect(c.block).toBeNull();
    expect(privacyGate(c)).toEqual({ kind: 'enforce' });
  });

  it('策略不会静默丢弃不合规的排除项:相对路径项仍参与哈希(条数与配置一致)', async () => {
    const f = await makeRsiFx('cfg-policy-nodrop-');
    await writeCfg(f, rsiToml(f, 'exclude_dirs = ["relative","/abs"]\nexclude_names = ["n"]\n'));
    const c = expectOn(await load(f));
    expect(c.block).toBe('exclude_invalid');
    expect((await buildRsiPolicy(c, 0)).exclude_hashes).toHaveLength(3);
  });

  it('overlay_invalid 先于 exclude_invalid 报(R20-2.6 层序)', async () => {
    const f = await makeRsiFx('cfg-both-');
    await writeCfg(f, rsiToml(f, `overlay = "relative.toml"\nexclude_dirs = ["relative"]\n`));
    expect(expectOn(await load(f)).block).toBe('overlay_invalid');
  });

  it('合法边界:exclude_dirs 恰 4096 字节、exclude_names 恰 255 字节 → 不 block', async () => {
    const f = await makeRsiFx('cfg-bound-');
    await writeCfg(
      f,
      rsiToml(
        f,
        `exclude_dirs = ["/${'x'.repeat(4095)}"]\nexclude_names = ["${'y'.repeat(255)}"]\n`,
      ),
    );
    expect(expectOn(await load(f)).block).toBeNull();
  });
});

describe('归一化策略与指纹(R20-1.5 / R20-6.9 的比较对象)', () => {
  it('排除项经 canonical + 折叠大小写后取哈希:大小写 / 尾斜杠 / 重复写法同一个哈希;换一项就变;目录与名字互不冲突', async () => {
    const f = await makeRsiFx('pol-');
    await writeCfg(f, rsiToml(f, 'exclude_dirs = ["/Some/Dir"]\nexclude_names = ["Some"]\n'));
    const a = await buildRsiPolicy(expectOn(await load(f)), 0);
    await writeCfg(f, rsiToml(f, 'exclude_dirs = ["/some/dir/"]\nexclude_names = ["some"]\n'));
    const b = await buildRsiPolicy(expectOn(await load(f)), 0);
    expect(b.exclude_hashes).toEqual(a.exclude_hashes);
    expect(policyFingerprint(b)).toBe(policyFingerprint(a));
    await writeCfg(f, rsiToml(f, 'exclude_dirs = ["/other"]\nexclude_names = ["Some"]\n'));
    const c = await buildRsiPolicy(expectOn(await load(f)), 0);
    expect(c.exclude_hashes).not.toEqual(a.exclude_hashes);
    expect(policyFingerprint(c)).not.toBe(policyFingerprint(a));
    // 目录 "x" 与名字 "x" 的哈希不同(前缀不同)
    await writeCfg(f, rsiToml(f, 'exclude_dirs = ["/x"]\n'));
    const d = await buildRsiPolicy(expectOn(await load(f)), 0);
    await writeCfg(f, rsiToml(f, 'exclude_names = ["/x"]\n'.replace('/x', 'x')));
    const n = await buildRsiPolicy(expectOn(await load(f)), 0);
    expect(d.exclude_hashes).not.toEqual(n.exclude_hashes);
  });

  it('agents / overlay sha / kit 主版本进指纹;kitMajor 取版本号第一段', async () => {
    const f = await makeRsiFx('pol2-');
    await writeCfg(f, rsiToml(f));
    const base = await buildRsiPolicy(expectOn(await load(f)), 0);
    await writeCfg(f, rsiToml(f, 'agents = ["claude"]\n'));
    const fewer = await buildRsiPolicy(expectOn(await load(f)), 0);
    expect(policyFingerprint(fewer)).not.toBe(policyFingerprint(base));
    await writeCfg(f, rsiToml(f));
    const major1 = await buildRsiPolicy(expectOn(await load(f)), 1);
    expect(policyFingerprint(major1)).not.toBe(policyFingerprint(base));
    expect(kitMajor('3.4.5')).toBe(3);
    expect(kitMajor('0.1.0')).toBe(0);
  });
});

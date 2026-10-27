/**
 * R20-A2 B4b:cursor 指纹(R20-6.9、D9)。输入每一项都进指纹;`currentCursorFingerprint` 只读、不建盐,盐 / overlay 不可用时返回 null。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KIT_VERSION } from '../../src/contracts/meta.js';
import { loadRsiConfig, buildRsiPolicy, type RsiConfigOn } from '../../src/rsi/config.js';
import {
  currentCursorFingerprint,
  cursorFingerprint,
  overlayRedactionSha256Of,
} from '../../src/rsi/l0/fingerprint.js';
import { exists } from '../../src/io/read-fs.js';
import { mkdirp, writeFile } from '../../src/io/safe-fs.js';
import { withWriteAudit } from '../helpers/write-audit.js';
import { makeL0Fx, type L0Fx } from './l0-fixture.js';
import { setExtra } from './ro-fixture.js';

const SALT_A = 'a1'.repeat(32);
const SALT_B = 'b2'.repeat(32);

async function putSalt(f: L0Fx, salt: string): Promise<void> {
  await mkdirp(f.io, f.io.stateDir, 0o700);
  await writeFile(f.io, path.join(f.io.stateDir, 'salt'), `${salt}\n`, { mode: 0o600 });
}
async function reload(f: L0Fx): Promise<RsiConfigOn> {
  const c = await loadRsiConfig({ env: f.env });
  if (c.status !== 'on') throw new Error('config off');
  return c;
}
async function putOverlay(f: L0Fx, toml: string): Promise<string> {
  const p = path.join(f.dir, 'overlay.toml');
  await writeFile(f.fx, p, toml, { mode: 0o600 });
  await setExtra(f, `overlay = ${JSON.stringify(p)}\n`);
  return p;
}

describe('cursorFingerprint(纯函数)', () => {
  it('每个输入都进指纹:改任一项指纹都变,同输入同指纹', async () => {
    const f = await makeL0Fx('fp-pure-');
    const policy = await buildRsiPolicy(f.config);
    const base = {
      kitVersion: KIT_VERSION,
      policy,
      overlayRedactionSha256: null,
      saltFp: 'a'.repeat(12),
    };
    const fp = cursorFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(cursorFingerprint({ ...base })).toBe(fp); // 正向前提
    expect(cursorFingerprint({ ...base, kitVersion: '9.9.9' })).not.toBe(fp);
    expect(cursorFingerprint({ ...base, overlayRedactionSha256: 'c'.repeat(64) })).not.toBe(fp);
    expect(cursorFingerprint({ ...base, saltFp: 'b'.repeat(12) })).not.toBe(fp);
    expect(
      cursorFingerprint({ ...base, policy: { ...policy, kit_major: policy.kit_major + 1 } }),
    ).not.toBe(fp);
    expect(
      cursorFingerprint({ ...base, policy: { ...policy, exclude_hashes: ['d'.repeat(64)] } }),
    ).not.toBe(fp);
  });
  it('完整 KIT_VERSION 进指纹:只差补丁号也不同(D9-A)', async () => {
    const f = await makeL0Fx('fp-ver-');
    const policy = await buildRsiPolicy(f.config);
    const mk = (v: string): string =>
      cursorFingerprint({
        kitVersion: v,
        policy,
        overlayRedactionSha256: null,
        saltFp: 'a'.repeat(12),
      });
    expect(mk('0.1.0')).not.toBe(mk('0.1.1'));
  });
});

describe('currentCursorFingerprint', () => {
  it('盐不存在 → null,且不建盐、不写任何东西', async () => {
    const f = await makeL0Fx('fp-nosalt-');
    const a = withWriteAudit();
    expect(await currentCursorFingerprint(f.io, f.config)).toBeNull();
    expect(a.calls).toEqual([]);
    expect(await exists(path.join(f.io.stateDir, 'salt'))).toBe(false);
  });
  it('空盐 / 非法盐 → null', async () => {
    const f = await makeL0Fx('fp-badsalt-');
    await mkdirp(f.io, f.io.stateDir, 0o700);
    await writeFile(f.io, path.join(f.io.stateDir, 'salt'), '', { mode: 0o600 });
    expect(await currentCursorFingerprint(f.io, f.config)).toBeNull();
    await writeFile(f.io, path.join(f.io.stateDir, 'salt'), 'not-hex\n', { mode: 0o600 });
    expect(await currentCursorFingerprint(f.io, f.config)).toBeNull();
  });
  it('盐、排除、agents 变化都改变指纹;同配置稳定', async () => {
    const f = await makeL0Fx('fp-cur-');
    await putSalt(f, SALT_A);
    const fp1 = await currentCursorFingerprint(f.io, f.config);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    expect(await currentCursorFingerprint(f.io, f.config)).toBe(fp1);
    await putSalt(f, SALT_B);
    const fp2 = await currentCursorFingerprint(f.io, f.config);
    expect(fp2).not.toBe(fp1);
    await setExtra(f, `exclude_dirs = [${JSON.stringify(path.join(f.dir, 'work', 'x'))}]\n`);
    const fp3 = await currentCursorFingerprint(f.io, await reload(f));
    expect(fp3).not.toBe(fp2);
    await setExtra(f, 'agents = ["claude"]\n');
    const fp4 = await currentCursorFingerprint(f.io, await reload(f));
    expect(fp4).not.toBe(fp2);
  });
  it('overlay:脱敏词表变化改变指纹(整份 overlay 变化也经 policy.overlay_sha256 改变)', async () => {
    const f = await makeL0Fx('fp-ov-');
    await putSalt(f, SALT_A);
    await putOverlay(f, 'sensitive_words = ["acme"]\n');
    const fpA = await currentCursorFingerprint(f.io, await reload(f));
    expect(fpA).not.toBeNull();
    expect(await currentCursorFingerprint(f.io, await reload(f))).toBe(fpA);
    await putOverlay(f, 'sensitive_words = ["acme", "globex"]\n');
    expect(await currentCursorFingerprint(f.io, await reload(f))).not.toBe(fpA);
  });
  it('overlayRedactionSha256Of:只取脱敏相关字段;顺序 / 重复 / 无关字段不影响,词表或域名变化才变', async () => {
    const f = await makeL0Fx('fp-ovsha-');
    const at = async (toml: string): Promise<string | null | undefined> =>
      overlayRedactionSha256Of(await putOverlay(f, toml));
    const base = await at('sensitive_words = ["acme", "globex"]\n');
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await at('sensitive_words = ["globex", "acme", "acme"]\ninternal_domains = []\n')).toBe(
      base,
    );
    expect(await at('sensitive_words = ["acme", "globex"]\nchannel = "stable"\n')).toBe(base);
    expect(await at('sensitive_words = ["acme"]\n')).not.toBe(base);
    expect(
      await at('sensitive_words = ["acme", "globex"]\ninternal_domains = ["corp.example"]\n'),
    ).not.toBe(base);
    expect(await overlayRedactionSha256Of(null)).toBeNull();
    expect(await at('not = = toml')).toBeUndefined();
  });
  it('overlay 不合规(config.overlaySha256 为 null)→ null', async () => {
    const f = await makeL0Fx('fp-ovbad-');
    await putSalt(f, SALT_A);
    await putOverlay(f, 'this = is = not toml');
    const cfg = await reload(f);
    expect(cfg.overlaySha256).toBeNull();
    expect(await currentCursorFingerprint(f.io, cfg)).toBeNull();
  });
});

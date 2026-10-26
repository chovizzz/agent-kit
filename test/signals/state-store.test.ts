import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Signal } from '../../src/contracts/signal.js';
import { runSync } from '../../src/io/exec.js';
import { createIoContext } from '../../src/io/paths.js';
import { exists, lstat, readDir, readText } from '../../src/io/read-fs.js';
import { chmod, remove, symlink, writeFile } from '../../src/io/safe-fs.js';
import { SALT_RE } from '../../src/signals/ids.js';
import {
  loadSalt,
  saltPath,
  SaltError,
  signalLine,
  signalMonth,
  signalsDir,
  writeSignals,
} from '../../src/signals/state-store.js';
import { REPO_ROOT, newWork } from './helpers.js';

function mode(st: { mode: number }): number {
  return st.mode & 0o777;
}

function sig(id: string, ts: string): Signal {
  return {
    sig_id: `sig_${id.padStart(16, '0')}`,
    agent: 'claude',
    agent_version: '1.0.0',
    agent_version_source: 'session_meta',
    session_ref: 's_0123456789abcdef',
    project_key: 'p_0123456789abcdef',
    ts,
    type: 'event',
    excerpt_redacted: 'hello',
    external_content: false,
    confidence: 1,
    loaded_rule_ids: [],
  };
}

describe('盐(Q-N7)', () => {
  it('非 dry 创建:64 位十六进制、文件 0600、.state 0700;再次加载同值', async () => {
    const w = await newWork('ss-salt-');
    const a = await loadSalt(w.io, { create: true });
    expect(a.persisted).toBe(true);
    expect(SALT_RE.test(a.salt)).toBe(true);
    expect(mode(await lstat(saltPath(w.io)))).toBe(0o600);
    expect(mode(await lstat(w.state))).toBe(0o700);
    expect((await loadSalt(w.io, { create: true })).salt).toBe(a.salt);
    expect((await loadSalt(w.io, { create: false })).salt).toBe(a.salt);
  });

  it('dry 且文件不存在:内存临时盐,不落盘;两次不同(正向对照:非 dry 才落盘)', async () => {
    const w = await newWork('ss-dry-');
    const a = await loadSalt(w.io, { create: false });
    const b = await loadSalt(w.io, { create: false });
    expect(a.persisted).toBe(false);
    expect(a.salt).not.toBe(b.salt);
    expect(await exists(saltPath(w.io))).toBe(false);
    await loadSalt(w.io, { create: true });
    expect(await exists(saltPath(w.io))).toBe(true);
  });

  it('R20 §20.9#8 盐首建是原子的:确认不存在之后、创建之前别人先建好 → 返回并保留别人的盐,不覆盖(变异:换回 writeFile → 红)', async () => {
    const w = await newWork('ss-salt-race-');
    const theirs = 'ab'.repeat(32);
    const r = await loadSalt(w.io, {
      create: true,
      beforeCreate: async () => {
        await writeFile(w.io, saltPath(w.io), `${theirs}\n`, { mode: 0o600 });
      },
    });
    expect(r).toEqual({ salt: theirs, persisted: true });
    expect(await readText(saltPath(w.io))).toBe(`${theirs}\n`);
  });

  it('别的进程刚 O_EXCL 创建、尚未写入的空盐文件:首次读取也等它写完(不是直接 SaltError)(变异:去掉初始等待 → 红)', async () => {
    const w = await newWork('ss-salt-empty-');
    const theirs = 'cd'.repeat(32);
    await loadSalt(w.io, { create: true }); // 建 state 目录
    await remove(w.io, saltPath(w.io));
    await writeFile(w.io, saltPath(w.io), '', { mode: 0o600 });
    const filler = new Promise<void>((resolve) =>
      setTimeout(() => {
        void writeFile(w.io, saltPath(w.io), `${theirs}\n`, { mode: 0o600 }).then(resolve);
      }, 150),
    );
    const r = await loadSalt(w.io, { create: true });
    await filler;
    expect(r).toEqual({ salt: theirs, persisted: true });
  });

  it('已存在但格式非法 / 权限宽于 0600 / 是符号链接 → SaltError,不静默重生成', async () => {
    const w = await newWork('ss-bad-');
    const good = (await loadSalt(w.io, { create: true })).salt;
    await writeFile(w.io, saltPath(w.io), 'not-hex\n', { mode: 0o600 });
    await expect(loadSalt(w.io, { create: true })).rejects.toBeInstanceOf(SaltError);
    expect(await readText(saltPath(w.io))).toBe('not-hex\n'); // 没被覆盖

    await writeFile(w.io, saltPath(w.io), `${good}\n`, { mode: 0o600 });
    await chmod(w.io, saltPath(w.io), 0o644);
    await expect(loadSalt(w.io, { create: true })).rejects.toBeInstanceOf(SaltError);
    await chmod(w.io, saltPath(w.io), 0o600);
    expect((await loadSalt(w.io, { create: true })).salt).toBe(good); // 对照:修好后可用

    const w2 = await newWork('ss-link-');
    await writeFile(w2.io, path.join(w2.dir, 'real-salt'), `${good}\n`, { mode: 0o600 });
    await loadSalt(w2.io, { create: true }); // 先建 state 目录
    await writeFile(w2.io, path.join(w2.dir, 'x'), '');
    await remove(w2.io, saltPath(w2.io));
    await symlink(w2.io, path.join(w2.dir, 'real-salt'), saltPath(w2.io));
    await expect(loadSalt(w2.io, { create: true })).rejects.toBeInstanceOf(SaltError);
  });

  it('盐不入仓:.state/salt 被 gitignore 忽略,git ls-files 不含 .state/(正向对照:源文件未被忽略)', () => {
    const ctx = createIoContext({ cwd: REPO_ROOT, env: { PATH: '/usr/bin:/bin' } });
    const ignored = runSync(ctx, 'git', ['check-ignore', '-q', '.state/salt']);
    expect(ignored.status).toBe(0);
    const control = runSync(ctx, 'git', ['check-ignore', '-q', 'src/signals/ids.ts']);
    expect(control.status).toBe(1);
    const tracked = runSync(ctx, 'git', ['ls-files', '.state']);
    expect(tracked.status).toBe(0);
    expect(tracked.stdout).toBe('');
  });
});

describe('信号库', () => {
  it('按 UTC 月份分文件;文件 0600、目录 0700;无残留 .tmp', async () => {
    const w = await newWork('ss-write-');
    const r = await writeSignals(w.io, 'claude', [
      sig('1', '2026-09-30T23:59:59.000Z'),
      sig('2', '2026-10-01T00:00:00.000Z'),
      sig('3', '2026-10-05T00:00:00.000Z'),
    ]);
    expect(r.written).toBe(3);
    const dir = signalsDir(w.io, 'claude');
    const names = (await readDir(dir)).map((e) => e.name);
    expect(names).toEqual(['202609.jsonl', '202610.jsonl']);
    for (const n of names) expect(mode(await lstat(path.join(dir, n)))).toBe(0o600);
    for (const d of [w.state, path.join(w.state, 'signals'), dir]) {
      expect(mode(await lstat(d))).toBe(0o700);
    }
    const lines = (await readText(path.join(dir, '202610.jsonl'))).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).sig_id).toBe('sig_0000000000000002');
  });

  it('重跑幂等:同 sig_id 不重复写入(正向对照:新 id 会写入)', async () => {
    const w = await newWork('ss-dedupe-');
    const s1 = sig('1', '2026-10-01T00:00:00.000Z');
    expect((await writeSignals(w.io, 'claude', [s1])).written).toBe(1);
    const again = await writeSignals(w.io, 'claude', [s1]);
    expect(again).toMatchObject({ written: 0, deduplicated: 1 });
    expect(
      (await writeSignals(w.io, 'claude', [s1, sig('2', '2026-10-01T00:00:00.000Z')])).written,
    ).toBe(1);
    const text = await readText(path.join(signalsDir(w.io, 'claude'), '202610.jsonl'));
    expect(text.trim().split('\n')).toHaveLength(2);
  });

  it('落盘前校验 Signal 结构:非法信号抛错且不写入', async () => {
    const w = await newWork('ss-schema-');
    const bad = { ...sig('1', '2026-10-01T00:00:00.000Z'), sig_id: 'oops' };
    await expect(writeSignals(w.io, 'claude', [bad])).rejects.toThrow();
    expect(await exists(signalsDir(w.io, 'claude'))).toBe(false);
  });

  it('写出口守卫:KIT_WRITE_ROOTS 之外的 state 目录写入被拒', async () => {
    const w = await newWork('ss-guard-');
    const io = createIoContext({
      cwd: REPO_ROOT,
      env: {
        KIT_TMP: w.dir,
        KIT_STATE_DIR: w.state,
        KIT_WRITE_ROOTS: path.join(w.dir, 'elsewhere'),
        PATH: '/usr/bin:/bin',
      },
    });
    await expect(
      writeSignals(io, 'claude', [sig('1', '2026-10-01T00:00:00.000Z')]),
    ).rejects.toThrow(/写入被拒绝/);
  });

  it('signalLine 键序固定;signalMonth 取 UTC', () => {
    const line = signalLine(sig('1', '2026-10-01T00:00:00.000Z'));
    const keys = Object.keys(JSON.parse(line) as object);
    expect(keys).toEqual([...keys].sort());
    expect(signalMonth('2026-12-31T23:59:59.000Z')).toBe('202612');
  });
});

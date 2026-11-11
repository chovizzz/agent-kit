/**
 * R21-3.2 / W0-9 HOME 侧个人层状态(经 home-fs,假 HOME):读写与 schema 校验、不安全文件、revocations.jsonl 整文件原子重写(只增不删、有上限)、
 * 写出口只认假 HOME(KIT_TMP 严格之内)、owner_repo_fp、封闭 git 配置用的空目录。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RSI_REVOCATIONS_MAX_BYTES,
  RSI_TARGET_TERMINALS,
  RSI_TRANSITION_REASONS_NORMAL,
} from '../../../src/contracts/rsi.js';
import type { RsiRevocationLine } from '../../../src/contracts/rsi-personal.js';
import { exists, lstat, readDir, readText } from '../../../src/io/read-fs.js';
import * as safe from '../../../src/io/safe-fs.js';
import {
  appendRevocations,
  ensureEmptyDir,
  ownerRepoFingerprint,
  personalHome,
  PersonalStateError,
  readHead,
  readJournal,
  readRevocations,
  readTxn,
  removeTxn,
  writeHead,
  writeTxn,
} from '../../../src/rsi/personal/home-state.js';
import { ID1, makeWorld, slowTests, type World } from './repo-helpers.js';

slowTests();

const SHA40 = 'a'.repeat(40);
const head = (w: World) => ({ schema_version: 1 as const, head: SHA40, owner_repo_fp: w.ownerFp });
const ok = async (): Promise<void> => undefined;

function rev(n: number): RsiRevocationLine {
  return {
    at: '2026-11-10T00:00:00.000Z',
    candidate_id: ID1,
    content_sha256: String(n % 10).repeat(64),
    identity12: null,
    reason: RSI_TRANSITION_REASONS_NORMAL[0],
    by: 'worker',
  };
}

describe('head.json / commit-journal.json / txn', () => {
  it('head.json 往返;文件 0600、目录 0700', async () => {
    const w = await makeWorld('hs-head-');
    expect(await readHead(w.h)).toEqual({ kind: 'absent' });
    await writeHead(w.h, head(w));
    expect(await readHead(w.h)).toEqual({ kind: 'ok', value: head(w) });
    expect((await lstat(path.join(w.h.stateDir, 'head.json'))).mode & 0o777).toBe(0o600);
    expect((await lstat(w.h.stateDir)).mode & 0o777).toBe(0o700);
  });

  it('读侧运行时校验:乱码 / 未知键 / 权限过宽 / 符号链接 → invalid(不当成合法记录)', async () => {
    const w = await makeWorld('hs-bad-');
    const file = path.join(w.h.stateDir, 'head.json');
    await safe.mkdirp(w.io, w.h.stateDir, 0o700);
    await safe.writeFile(w.io, file, '{nope', { mode: 0o600 });
    expect(await readHead(w.h)).toEqual({ kind: 'invalid', why: 'parse' });
    await safe.writeFile(w.io, file, JSON.stringify({ ...head(w), extra: 1 }), { mode: 0o600 });
    expect(await readHead(w.h)).toEqual({ kind: 'invalid', why: 'schema' });
    await safe.writeFile(w.io, file, JSON.stringify(head(w)), { mode: 0o600 });
    expect(await readHead(w.h)).toMatchObject({ kind: 'ok' }); // 对照
    await safe.chmod(w.io, file, 0o644);
    expect(await readHead(w.h)).toEqual({ kind: 'invalid', why: 'unsafe' });
    await safe.remove(w.io, file);
    await safe.symlink(w.io, path.join(w.dir, 'elsewhere'), file);
    expect(await readHead(w.h)).toEqual({ kind: 'invalid', why: 'unsafe' });
    expect(await readJournal(w.h)).toEqual({ kind: 'absent' });
  });

  it('txn/<id>.json 往返与删除', async () => {
    const w = await makeWorld('hs-txn-');
    const t = {
      schema_version: 1 as const,
      txn_id: 'abcdef0123456789',
      candidate_id: ID1,
      kind: 'rollback' as const,
      reason: RSI_TRANSITION_REASONS_NORMAL[0],
      target_terminal: RSI_TARGET_TERMINALS[0],
      phase: 'rollback_requested' as const,
      identity12: null,
      at: '2026-11-10T00:00:00.000Z',
    };
    await writeTxn(w.h, t);
    expect(await readTxn(w.h, t.txn_id)).toEqual({ kind: 'ok', value: t });
    await removeTxn(w.h, t.txn_id);
    expect(await readTxn(w.h, t.txn_id)).toEqual({ kind: 'absent' });
  });
});

describe('写出口只认假 HOME', () => {
  it('home 不在 KIT_TMP 严格之内 → home-fs 拒绝,什么也没写', async () => {
    const w = await makeWorld('hs-outside-');
    const outside = path.dirname(w.dir); // KIT_TMP 的上级:不是「严格之内」
    const h = personalHome(w.io, outside);
    await expect(writeHead(h, head(w))).rejects.toMatchObject({
      name: 'HomeWriteDeniedError',
      code: 'HOME_BAD_HOME',
    });
    expect(await exists(path.join(outside, '.local', 'state', 'agent-kit', 'rsi-personal'))).toBe(
      false,
    );
  });

  it('home 必须是绝对路径', async () => {
    const w = await makeWorld('hs-rel-');
    expect(() => personalHome(w.io, 'relative/home')).toThrow();
  });
});

describe('W0-9 revocations.jsonl:整文件原子重写,只增不删', () => {
  const lines = async (w: World): Promise<RsiRevocationLine[]> => {
    const r = await readRevocations(w.h);
    if (r.kind !== 'ok') throw new Error(JSON.stringify(r));
    return r.value;
  };
  const file = (w: World): string => path.join(w.h.stateDir, 'revocations.jsonl');

  it('追加:旧行原样保留为新文件的前缀,顺序保持', async () => {
    const w = await makeWorld('hs-rev-');
    expect(await readRevocations(w.h)).toEqual({ kind: 'absent' });
    await appendRevocations(w.h, ok, [rev(1)]);
    const first = await readText(file(w));
    await appendRevocations(w.h, ok, [rev(2), rev(3)]);
    const second = await readText(file(w));
    expect(second.startsWith(first)).toBe(true);
    expect((await lines(w)).map((l) => l.content_sha256[0])).toEqual(['1', '2', '3']);
    expect((await lstat(file(w))).mode & 0o777).toBe(0o600);
  });

  it('重写中途失败(任一 home-fs 阶段):旧版原样可读,没有残留临时文件;随后正常追加成功', async () => {
    for (const stage of ['temp-created', 'temp-written', 'temp-synced', 'pre-rename'] as const) {
      const w = await makeWorld('hs-rev-crash-');
      await appendRevocations(w.h, ok, [rev(1)]);
      const before = await readText(file(w));
      const crashy = personalHome(w.io, w.home, {
        onStage: (s) => {
          if (s === stage) throw new Error(`crash@${s}`);
        },
      });
      await expect(appendRevocations(crashy, ok, [rev(2)])).rejects.toThrow(`crash@${stage}`);
      expect(await readText(file(w)), stage).toBe(before);
      expect(
        (await readDir(w.h.stateDir)).filter((e) => e.name.includes('.tmp-')),
        stage,
      ).toEqual([]);
      await appendRevocations(w.h, ok, [rev(2)]);
      expect((await lines(w)).length).toBe(2);
    }
  });

  it('锁已丢失(assertHeld 抛错)→ 不写', async () => {
    const w = await makeWorld('hs-rev-lost-');
    await appendRevocations(w.h, ok, [rev(1)]);
    const before = await readText(file(w));
    await expect(
      appendRevocations(
        w.h,
        async () => {
          throw new Error('lock_lost');
        },
        [rev(2)],
      ),
    ).rejects.toThrow('lock_lost');
    expect(await readText(file(w))).toBe(before);
  });

  it('现有文件损坏 → 追加抛 revocations_invalid,不覆盖(不丢凭据)', async () => {
    const w = await makeWorld('hs-rev-corrupt-');
    await appendRevocations(w.h, ok, [rev(1)]);
    const bad = `${await readText(file(w))}{broken\n`;
    await safe.writeFile(w.io, file(w), bad, { mode: 0o600 });
    const err = await appendRevocations(w.h, ok, [rev(2)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PersonalStateError);
    expect((err as PersonalStateError).kind).toBe('revocations_invalid');
    expect(await readText(file(w))).toBe(bad);
  });

  it('超过 1 MiB:追加抛 revocations_too_large 且不写;文件本身 > 1 MiB 读取失败', async () => {
    const w = await makeWorld('hs-rev-cap-');
    await appendRevocations(w.h, ok, [rev(1)]);
    const one = JSON.stringify(rev(1)).length + 1;
    // 填到离上限不足一行(再加一行就超)
    const fill = Math.floor(RSI_REVOCATIONS_MAX_BYTES / one);
    const body = Array.from({ length: fill }, () => JSON.stringify(rev(1))).join('\n') + '\n';
    await safe.writeFile(w.io, file(w), body, { mode: 0o600 });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(RSI_REVOCATIONS_MAX_BYTES);
    expect(Buffer.byteLength(body) + one).toBeGreaterThan(RSI_REVOCATIONS_MAX_BYTES);
    const err = await appendRevocations(w.h, ok, [rev(2)]).catch((e: unknown) => e);
    expect((err as PersonalStateError).kind).toBe('revocations_too_large');
    expect(await readText(file(w))).toBe(body);
    await safe.writeFile(w.io, file(w), body + body, { mode: 0o600 });
    expect(await readRevocations(w.h)).toEqual({ kind: 'invalid', why: 'unsafe' });
  });
});

describe('owner_repo_fp 与封闭配置的空目录', () => {
  it('owner_repo_fp:16 位十六进制;同目录稳定,不同目录不同,目录被换掉(inode 变)也不同', async () => {
    const w = await makeWorld('hs-fp-');
    const a = await ownerRepoFingerprint(w.rsiRepo);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await ownerRepoFingerprint(w.rsiRepo)).toBe(a);
    const other = path.join(w.dir, 'rsi-repo-2');
    await safe.mkdirp(w.io, other, 0o700);
    expect(await ownerRepoFingerprint(other)).not.toBe(a);
    await safe.rename(w.io, w.rsiRepo, path.join(w.dir, 'moved-away'));
    await safe.mkdirp(w.io, w.rsiRepo, 0o700); // 同一路径、另一个目录
    expect(await ownerRepoFingerprint(w.rsiRepo)).not.toBe(a);
  });

  it('ensureEmptyDir:建 0700 空目录;里面有东西 → 抛 empty_dir_not_empty(钩子目录不能被塞内容)', async () => {
    const w = await makeWorld('hs-empty-');
    const dir = await ensureEmptyDir(w.h);
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    expect(await readDir(dir)).toEqual([]);
    await safe.writeFile(w.io, path.join(dir, 'reference-transaction'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    const err = await ensureEmptyDir(w.h).catch((e: unknown) => e);
    expect((err as PersonalStateError).kind).toBe('empty_dir_not_empty');
  });
});

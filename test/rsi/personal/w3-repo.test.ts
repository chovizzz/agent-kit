/**
 * 权威副本真实适配器(私有仓库,真 git、假 HOME):经 W2 提交 → 读回;坏记录整体 invalid;git 出口仍只在 W2 授权文件内。
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/io/canonical-json.js';
import { personalRepoStore } from '../../../src/rsi/personal/candidate-repo.js';
import { creationFiles, newRecord } from '../../../src/rsi/personal/candidate-record.js';
import { openPersonalRepo, readPersonalFiles } from '../../../src/rsi/personal/commit.js';
import { draftOf } from './w3-fixture.js';
import { makeWorld, repoDeps, slowTests, spec, withLock } from './repo-helpers.js';

slowTests();

describe('personalRepoStore', () => {
  it('提交创建文件后读回同一记录;不存在的 id → missing;无仓库 → absent', async () => {
    const w = await makeWorld('w3-repo-');
    const d = draftOf();
    const rec = newRecord(d, '2026-11-10T12:00:00.000Z', false);
    await withLock(w, async (locks) => {
      const store = personalRepoStore(repoDeps(w), locks);
      expect(await store.readAll()).toEqual({ kind: 'absent' });
      const open = await openPersonalRepo(repoDeps(w), locks, { bootstrap: true });
      expect(open.kind).toBe('ready');
      const c = await store.commit(spec('3', creationFiles(d, rec), 'transition', [d.id]));
      expect(c.status).toBe('committed');
      const all = await store.readAll();
      expect(all.kind).toBe('ok');
      if (all.kind === 'ok') expect(all.value).toEqual([rec]);
      const one = await store.read(d.id);
      expect(one).toMatchObject({ kind: 'ok', record: rec });
      expect(await store.read('ra_000000000000')).toMatchObject({ kind: 'missing' });
      const files = await readPersonalFiles(repoDeps(w), locks, ['rules']);
      expect(files.status === 'ok' && files.files.map((f) => f.path)).toEqual([d.targetPath]);
    });
  });
  it('lifecycle 下有坏记录(JSON 损坏 / 文件名与 id 不符)→ 整体 invalid(candidate_invalid),不跳过', async () => {
    const w = await makeWorld('w3-repo-bad-');
    const d = draftOf();
    const rec = newRecord(d, '2026-11-10T12:00:00.000Z', false);
    await withLock(w, async (locks) => {
      const store = personalRepoStore(repoDeps(w), locks);
      await openPersonalRepo(repoDeps(w), locks, { bootstrap: true });
      await store.commit(
        spec('4', [{ path: `lifecycle/ra_bbbbbbbbbbbb.json`, content: canonicalJson(rec) }]),
      );
      expect(await store.readAll()).toEqual({ kind: 'invalid', why: 'candidate_invalid' });
      await store.commit(
        spec('5', [{ path: `lifecycle/ra_bbbbbbbbbbbb.json`, content: '{not json' }]),
      );
      expect(await store.readAll()).toEqual({ kind: 'invalid', why: 'candidate_invalid' });
    });
  });
});

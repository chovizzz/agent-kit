/**
 * R20-A2 B5c:`resolvePurgeKeys` / `planPurgeTargets` / `countPurge`(purge 的只读规划)。覆盖 R20-3.8.1 / 3.8.2 与「purge 不检查已排除」变异的判据。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { remove } from '../../src/io/safe-fs.js';
import {
  countPurge,
  planPurgeTargets,
  resolvePurgeKeys,
} from '../../src/rsi/services/purge-plan.js';
import { RsiFailClosedError } from '../../src/rsi/types.js';
import { KEY_A, KEY_B, KEY_C, put, writeIndex } from './services-fixture.js';
import { KEY_D, makeSc } from './b5c-fixture.js';

describe('resolvePurgeKeys', () => {
  it('--excluded:K = 当前判为 X 的全部 key(A、D 在排除目录 ex 内);B、C 不在', async () => {
    const { s } = await makeSc('pp-excl-');
    const r = await resolvePurgeKeys(s.io, s.cfg, { kind: 'excluded' });
    expect(r).toEqual({ keys: [KEY_A, KEY_D].sort(), notExcluded: false });
  });

  it('--excluded:没有任何排除项 → K 为空', async () => {
    const { s } = await makeSc('pp-none-');
    const cfg = { ...s.cfg, excludeDirs: [], excludeNames: [] };
    expect(await resolvePurgeKeys(s.io, cfg, { kind: 'excluded' })).toEqual({
      keys: [],
      notExcluded: false,
    });
  });

  it('--project <ex>:命中 ex 与 ex/sub 下的 key,全部已排除 → notExcluded=false', async () => {
    const { s, roots } = await makeSc('pp-proj-');
    const r = await resolvePurgeKeys(s.io, s.cfg, { kind: 'project', path: roots.ex });
    expect(r).toEqual({ keys: [KEY_A, KEY_D].sort(), notExcluded: false });
  });

  it('--project <ex/sub>:只命中 sub 的 key;路径大小写折叠与尾斜杠不影响(R20-4.4)', async () => {
    const { s, roots } = await makeSc('pp-proj-sub-');
    const r = await resolvePurgeKeys(s.io, s.cfg, {
      kind: 'project',
      path: `${roots.sub.toUpperCase()}/`,
    });
    expect(r.keys).toEqual([KEY_D]);
    expect(r.notExcluded).toBe(false);
  });

  it('--project 命中一个未排除的 key → notExcluded=true(变异「purge 不检查已排除」会让它变 false)', async () => {
    const { s, roots } = await makeSc('pp-notx-');
    const r = await resolvePurgeKeys(s.io, s.cfg, { kind: 'project', path: roots.ok });
    expect(r.keys).toEqual([KEY_B]);
    expect(r.notExcluded).toBe(true);
    // 部分命中:父目录同时含已排除与未排除 → 整体 notExcluded
    const parent = path.dirname(roots.ex);
    const both = await resolvePurgeKeys(s.io, s.cfg, { kind: 'project', path: parent });
    expect(both.keys).toEqual([KEY_A, KEY_B, KEY_C, KEY_D].sort());
    expect(both.notExcluded).toBe(true);
  });

  it('--project 没有命中任何索引根 → 空 K、notExcluded=false', async () => {
    const { s, roots } = await makeSc('pp-nomatch-');
    const r = await resolvePurgeKeys(s.io, s.cfg, {
      kind: 'project',
      path: path.join(roots.ok, 'nested-not-indexed'),
    });
    expect(r).toEqual({ keys: [], notExcluded: false });
  });

  it('索引缺失 / 损坏 / 与盐不符 → fail-closed index_invalid;resume 模式不由它解析 → internal', async () => {
    const reasonOf = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
      } catch (e) {
        return (e as RsiFailClosedError).reason;
      }
      return 'no-throw';
    };
    const a = await makeSc('pp-idx-absent-');
    await remove(a.s.f.fx, path.join(a.s.rsi, 'projects.json'));
    expect(await reasonOf(resolvePurgeKeys(a.s.io, a.s.cfg, { kind: 'excluded' }))).toBe(
      'index_invalid',
    );
    const b = await makeSc('pp-idx-bad-');
    await put(b.s, path.join(b.s.rsi, 'projects.json'), '{"nope":1}');
    expect(await reasonOf(resolvePurgeKeys(b.s.io, b.s.cfg, { kind: 'excluded' }))).toBe(
      'index_invalid',
    );
    const c = await makeSc('pp-idx-salt-');
    await writeIndex(c.s, [{ key: KEY_A, root: c.roots.ex }], 'bbbbbbbbbbbb');
    expect(await reasonOf(resolvePurgeKeys(c.s.io, c.s.cfg, { kind: 'excluded' }))).toBe(
      'index_invalid',
    );
    expect(await reasonOf(resolvePurgeKeys(c.s.io, c.s.cfg, { kind: 'resume' }))).toBe('internal');
  });
});

describe('planPurgeTargets', () => {
  it('run:证据 sig 映射到 K 的;promote:report.run_id 指向命中 run 的;升序', async () => {
    const { s } = await makeSc('pp-targets-');
    const t = await planPurgeTargets(s.io, [KEY_A, KEY_D]);
    expect(t).toEqual({ keys: [KEY_A, KEY_D].sort(), runs: ['run-ex'], promotes: ['promo-ex'] });
    const none = await planPurgeTargets(s.io, [KEY_C]); // C 的信号 6 没有 run 引用
    expect(none.runs).toEqual([]);
    expect(none.promotes).toEqual([]);
    const b = await planPurgeTargets(s.io, [KEY_B]);
    expect(b.runs).toEqual(['run-ok']);
    expect(b.promotes).toEqual(['promo-ok']);
  });
});

describe('countPurge', () => {
  it('信号 / 会话计数行 / cursor 条目 / 索引条目 / 待 taint 的 run 与 promote 的计数与夹具手算一致', async () => {
    const { s } = await makeSc('pp-count-');
    // 信号:A×3(202609 两条 + 202610 一条)、D×1;会话计数行:A×2;cursor:A×2;索引:A、D
    const c = await countPurge(s.io, [KEY_A, KEY_D]);
    expect(c).toEqual({
      signals: 4,
      sessionRows: 2,
      cursorEntries: 2,
      indexEntries: 2,
      runs: 1,
      promotes: 1,
    });
    const z = await countPurge(s.io, []);
    expect(z).toEqual({
      signals: 0,
      sessionRows: 0,
      cursorEntries: 0,
      indexEntries: 0,
      runs: 0,
      promotes: 0,
    });
  });
});

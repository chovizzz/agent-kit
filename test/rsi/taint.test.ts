/**
 * R20-A2 B3c:taint(R20-4.7)与 purge journal 探测(R20-3.8.5)。对着真实目录、真实锁、真实暂存区。
 *  - 崩溃注入:每个写边界(标记创建、每个临时文件写 / rename / 删除的前后)各崩一次,重跑幂等;
 *  - 丢锁注入:每个 `before:` 写点各让锁失效一次,断言该点及其后没有任何写发生。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { exists, lstat, readBytes, readText } from '../../src/io/read-fs.js';
import {
  chmod,
  hardlink,
  mkdirp,
  remove,
  rename,
  symlink,
  writeFile,
} from '../../src/io/safe-fs.js';
import { RsiLockError } from '../../src/rsi/lock.js';
import { RsiStagingBlockedError } from '../../src/rsi/services/staging.js';
import { RsiFailClosedError } from '../../src/rsi/types.js';
import {
  assertNoPurgeInProgress,
  detectPurgeJournal,
  resumeTaint,
  resumeTaintWith,
  taintNewlyExcluded,
  taintNewlyExcludedWith,
} from '../../src/rsi/services/taint.js';
import {
  CrashError,
  KEY_A,
  KEY_B,
  EXCERPT_MARK,
  addSignals,
  allText,
  countsDoc,
  ensureRsiDir,
  listFiles,
  makeRoot,
  makeSvc,
  projPath,
  promoteDirOf,
  put,
  rm,
  runDirOf,
  setRsiToml,
  stagePromote,
  stageRun,
  withLock,
  writeCountsRaw,
  writeIndex,
  type Svc,
} from './services-fixture.js';

const SIG_A = '1111111111111111';
const SIG_B = '2222222222222222';

/** run-x 的证据一半属于被排除的 A、一半属于 B;run-ok 只有 B;各有一个 promote(promo-x 关联 run-x) */
async function world(prefix: string): Promise<Svc> {
  const s = await makeSvc(prefix, {
    extraToml: (f) => `exclude_dirs = [${JSON.stringify(projPath(f, 'projA'))}]\n`,
  });
  const rootA = await makeRoot(s, 'projA');
  const rootB = await makeRoot(s, 'projB');
  await addSignals(s, [
    { id: SIG_A, key: KEY_A },
    { id: SIG_B, key: KEY_B },
  ]);
  await writeIndex(s, [
    { key: KEY_A, root: rootA },
    { key: KEY_B, root: rootB },
  ]);
  await writeCountsRaw(s, countsDoc());
  await stageRun(s, 'run-x', [SIG_A, SIG_B], { proposals: 2 });
  await stageRun(s, 'run-ok', [SIG_B]);
  await stagePromote(s, 'promo-x', 'run-x');
  await stagePromote(s, 'promo-ok', 'run-ok');
  return s;
}

/** 去掉拿锁 / 释放锁带来的写(锁文件与 .state、.state/rsi 的建目录) */
const lockOnly = (a: readonly string[]): string[] =>
  a.filter((x) => !x.endsWith('/lock') && !/^mkdirp .*\/\.state(\/rsi)?$/.test(x));

const markOf = async (dir: string): Promise<{ reason: string } | null> => {
  try {
    return JSON.parse(await readText(path.join(dir, 'TAINTED'))) as { reason: string };
  } catch {
    return null;
  }
};

/** 不变量:带标记的目录里没有任何摘录、没有 apply.patch / promote.patch / pr-body.md */
async function expectTaintedClean(s: Svc, kind: 'reflect' | 'promote', id: string): Promise<void> {
  const dir = path.join(s.state, kind, id);
  expect(await exists(path.join(dir, 'TAINTED')), `${kind}/${id} 有标记`).toBe(true);
  expect(await allText(dir), `${kind}/${id} 无摘录`).not.toContain(EXCERPT_MARK);
  const files = await listFiles(dir);
  expect(files.filter((x) => /apply\.patch|promote\.patch|pr-body\.md/.test(x))).toEqual([]);
  expect(await exists(path.join(dir, 'report.json'))).toBe(true);
}

describe('taintNewlyExcluded(exclude)', () => {
  it('统一口径:盐不符 / counts 缺失时 X 仍然 taint(X 与盐无关);不命中的 run 不被 taint(U 不是 X)', async () => {
    for (const how of ['salt-mismatch', 'counts-missing'] as const) {
      const s = await world(`taint-salt-${how}-`);
      if (how === 'salt-mismatch') await writeCountsRaw(s, countsDoc('ffffffffffff'));
      else await rm(s, path.join(s.rsi, 'counts.json'));
      const okBefore = await allText(runDirOf(s, 'run-ok'));
      const out = await withLock(s, (l) => taintNewlyExcluded(s.ctx, l, { source: 'exclude' }));
      expect(out, how).toEqual({ runsMarked: 1, promotesMarked: 1 });
      await expectTaintedClean(s, 'reflect', 'run-x');
      expect(await allText(runDirOf(s, 'run-ok')), how).toBe(okBefore);
    }
  });

  it('命中 X 的 run:先标记、清空全部摘录(含非命中证据与原子正文无关部分)、删 apply.patch;promote 随之;未命中的 run 原样(正向 + 对照)', async () => {
    const s = await world('taint-basic-');
    const okBefore = await allText(runDirOf(s, 'run-ok'));
    const out = await withLock(s, (lock) => taintNewlyExcluded(s.ctx, lock, { source: 'exclude' }));
    expect(out).toEqual({ runsMarked: 1, promotesMarked: 1 });
    await expectTaintedClean(s, 'reflect', 'run-x');
    await expectTaintedClean(s, 'promote', 'promo-x');
    expect((await markOf(runDirOf(s, 'run-x')))?.reason).toBe('exclude');
    // 提案文件名保留(编号不会被重发),内容摘录为空、其余字段还在
    expect(await listFiles(path.join(runDirOf(s, 'run-x'), 'proposals'))).toEqual([
      '2026-10-26-001.yaml',
      '2026-10-26-002.yaml',
    ]);
    const y = await readText(path.join(runDirOf(s, 'run-x'), 'proposals', '2026-10-26-001.yaml'));
    expect(y).toContain('run_id: run-x');
    expect(y).toContain('excerpt: ""');
    // 原子正文逐字保留,只清了 frontmatter 的摘录
    const md = await readText(path.join(runDirOf(s, 'run-x'), 'rules', 'team', 'atom-run-x-1.md'));
    expect(md).toContain('**做**:do BODY-KEEP');
    expect(md).toContain('excerpt: ""');
    // 对照:未命中的 run / promote 一个字节没动
    expect(await allText(runDirOf(s, 'run-ok'))).toBe(okBefore);
    expect(await exists(path.join(runDirOf(s, 'run-ok'), 'TAINTED'))).toBe(false);
    expect(await exists(path.join(promoteDirOf(s, 'promo-ok'), 'promote.patch'))).toBe(true);
    // 幂等:再跑一遍没有新标记
    const again = await withLock(s, (lock) =>
      taintNewlyExcluded(s.ctx, lock, { source: 'exclude' }),
    );
    expect(again).toEqual({ runsMarked: 0, promotesMarked: 0 });
  });

  it('没有排除时零 taint(对照);配置每次重读:写下排除后下一次调用即命中', async () => {
    const s = await makeSvc('taint-reread-');
    const rootA = await makeRoot(s, 'projA');
    await addSignals(s, [{ id: SIG_A, key: KEY_A }]);
    await writeIndex(s, [{ key: KEY_A, root: rootA }]);
    await writeCountsRaw(s, countsDoc());
    await stageRun(s, 'run-x', [SIG_A]);
    expect(await withLock(s, (l) => taintNewlyExcluded(s.ctx, l, { source: 'exclude' }))).toEqual({
      runsMarked: 0,
      promotesMarked: 0,
    });
    expect(await allText(runDirOf(s, 'run-x'))).toContain(EXCERPT_MARK);
    await setRsiToml(s, `exclude_dirs = [${JSON.stringify(rootA)}]\n`);
    expect(await withLock(s, (l) => taintNewlyExcluded(s.ctx, l, { source: 'exclude' }))).toEqual({
      runsMarked: 1,
      promotesMarked: 0,
    });
    await expectTaintedClean(s, 'reflect', 'run-x');
  });

  it('按目录名排除(exclude_names)、折叠大小写也命中', async () => {
    const s = await makeSvc('taint-names-', { extraToml: 'exclude_names = ["PROJA"]\n' });
    const rootA = await makeRoot(s, 'projA');
    await addSignals(s, [{ id: SIG_A, key: KEY_A }]);
    await writeIndex(s, [{ key: KEY_A, root: rootA }]);
    await writeCountsRaw(s, countsDoc());
    await stageRun(s, 'run-x', [SIG_A]);
    const out = await withLock(s, (l) => taintNewlyExcluded(s.ctx, l, { source: 'exclude' }));
    expect(out.runsMarked).toBe(1);
  });

  it('索引缺失 / 损坏 → 算不出 X,零结果(不崩);映射不到的证据不触发 taint', async () => {
    const s = await makeSvc('taint-noindex-', {
      extraToml: (f) => `exclude_dirs = [${JSON.stringify(projPath(f, 'projA'))}]\n`,
    });
    await makeRoot(s, 'projA');
    await addSignals(s, [{ id: SIG_A, key: KEY_A }]);
    await ensureRsiDir(s);
    await stageRun(s, 'run-x', [SIG_A]);
    expect(await withLock(s, (l) => taintNewlyExcluded(s.ctx, l, { source: 'exclude' }))).toEqual({
      runsMarked: 0,
      promotesMarked: 0,
    });
    await put(s, path.join(s.rsi, 'projects.json'), '{not json');
    expect(
      (await withLock(s, (l) => taintNewlyExcluded(s.ctx, l, { source: 'exclude' }))).runsMarked,
    ).toBe(0);
    expect(await allText(runDirOf(s, 'run-x'))).toContain(EXCERPT_MARK);
  });

  it('配置不可用:exclude_invalid 抛 fail-closed;配置被关(disabled)= 零结果', async () => {
    const s = await world('taint-cfg-');
    await setRsiToml(s, 'exclude_dirs = ["relative/path"]\n');
    await expect(
      withLock(s, (l) => taintNewlyExcluded(s.ctx, l, { source: 'exclude' })),
    ).rejects.toMatchObject({ reason: 'exclude_invalid' });
    expect(await allText(runDirOf(s, 'run-x'))).toContain(EXCERPT_MARK);
    await writeFile(s.f.fx, s.f.cfgFile, '[rsi]\nenabled = false\n', { mode: 0o600 });
    expect(await withLock(s, (l) => taintNewlyExcluded(s.ctx, l, { source: 'exclude' }))).toEqual({
      runsMarked: 0,
      promotesMarked: 0,
    });
  });

  it('信号库里同一 sig_id 映射到不同 key → fail-closed signal_store_corrupt,不任选一条', async () => {
    const s = await world('taint-conflict-');
    await addSignals(s, [{ id: SIG_A, key: KEY_B }], '202609');
    await expect(
      withLock(s, (l) => taintNewlyExcluded(s.ctx, l, { source: 'exclude' })),
    ).rejects.toMatchObject({ reason: 'signal_store_corrupt' });
  });
});

describe('动作顺序固定(R20-4.7):标记先落盘,再清摘录,最后删 apply.patch', () => {
  it('每个清理写点之前 TAINTED 已在盘上;apply.patch 的删除在全部摘录清空之后', async () => {
    const s = await world('taint-order-');
    const seen: string[] = [];
    let patchRemovedAt = -1;
    let lastExcerptWriteAt = -1;
    await withLock(s, (l) =>
      taintNewlyExcludedWith(
        s.ctx,
        l,
        { source: 'exclude' },
        {
          point: async (name) => {
            seen.push(name);
            const m = /^before:(?:tmp-write|rename|remove):(run-x|promote\/promo-x)\//.exec(name);
            if (m?.[1] !== undefined) {
              const dir = m[1] === 'run-x' ? runDirOf(s, 'run-x') : promoteDirOf(s, 'promo-x');
              expect(await exists(path.join(dir, 'TAINTED')), `${name} 之前标记必须已落盘`).toBe(
                true,
              );
            }
            if (name === 'before:remove:run-x/apply.patch') patchRemovedAt = seen.length;
            if (/^after:rename:run-x\/(proposals|rules)\//.test(name))
              lastExcerptWriteAt = seen.length;
          },
        },
      ),
    );
    expect(patchRemovedAt).toBeGreaterThan(lastExcerptWriteAt);
    expect(lastExcerptWriteAt).toBeGreaterThan(0);
  });
});

describe('崩溃注入:每个写边界崩一次,重跑幂等(R20-4.7 续做)', () => {
  it('taintNewlyExcluded 在第 k 个写点崩溃 → resumeTaint 后带标记的目录全清;再跑 taintNewlyExcluded 终态与不崩溃的基线逐文件一致;再 resume 无事可做', async () => {
    // 基线:不崩溃的终态,同时记录全部写点名
    const base = await world('taint-base-');
    const hits: string[] = [];
    await withLock(base, (l) =>
      taintNewlyExcludedWith(
        base.ctx,
        l,
        { source: 'exclude' },
        { point: (n) => void hits.push(n) },
      ),
    );
    expect(hits.length).toBeGreaterThan(20);
    for (const name of [
      'mark:run:run-x',
      'mark:promote:promo-x',
      'tmp-write:run-x/proposals/2026-10-26-001.yaml',
      'rename:run-x/proposals/2026-10-26-001.yaml',
      'remove:run-x/apply.patch',
      'remove:promote/promo-x/promote.patch',
    ]) {
      expect(hits, name).toContain(`before:${name}`);
      expect(hits, name).toContain(`after:${name}`);
    }
    const baseRun = (await listFiles(runDirOf(base, 'run-x'))).join('\n');
    const baseText = await allText(runDirOf(base, 'run-x'));

    for (let k = 1; k <= hits.length; k++) {
      const s = await world(`taint-crash-${k}-`);
      let n = 0;
      await expect(
        withLock(s, (l) =>
          taintNewlyExcludedWith(
            s.ctx,
            l,
            { source: 'exclude' },
            {
              point: (name) => {
                if (++n === k) throw new CrashError(name);
              },
            },
          ),
        ),
        `crash #${k} ${hits[k - 1]}`,
      ).rejects.toBeInstanceOf(CrashError);
      // 新锁句柄、新 ctx 重跑:续做
      await withLock(s, (l) => resumeTaint(s.ctx, l));
      for (const [kind, id] of [
        ['reflect', 'run-x'],
        ['promote', 'promo-x'],
      ] as const) {
        const dir = path.join(s.state, kind, id);
        if (await exists(path.join(dir, 'TAINTED'))) {
          expect(await allText(dir), `crash #${k} ${hits[k - 1]}:${kind}/${id}`).not.toContain(
            EXCERPT_MARK,
          );
          expect((await listFiles(dir)).filter((x) => /patch|pr-body/.test(x))).toEqual([]);
        }
      }
      // 重新发现并完成
      await withLock(s, (l) => taintNewlyExcluded(s.ctx, l, { source: 'exclude' }));
      await expectTaintedClean(s, 'reflect', 'run-x');
      await expectTaintedClean(s, 'promote', 'promo-x');
      expect((await listFiles(runDirOf(s, 'run-x'))).join('\n'), `#${k}`).toBe(baseRun);
      expect(await allText(runDirOf(s, 'run-x')).then((t) => t.replace(/"at": "[^"]+"/g, ''))).toBe(
        baseText.replace(/"at": "[^"]+"/g, ''),
      );
      const again = await withLock(s, (l) => resumeTaint(s.ctx, l));
      expect(again.runsCompleted + again.promotesCompleted, `#${k} 幂等`).toBe(0);
      // 对照:未命中的 run 永远没被碰
      expect(await allText(runDirOf(s, 'run-ok'))).toContain(EXCERPT_MARK);
    }
  }, 120_000);

  it('丢锁注入:每个 before: 写点让锁失效 → 抛 lock_lost,且该点及其后零写入(写审计条数不再增加)', async () => {
    const base = await world('taint-lock-base-');
    const marks: { name: string; writes: number }[] = [];
    await withLock(base, (l) =>
      taintNewlyExcludedWith(
        base.ctx,
        l,
        { source: 'exclude' },
        {
          point: (n) =>
            void (n.startsWith('before:') && marks.push({ name: n, writes: base.audit.length })),
        },
      ),
    );
    expect(marks.length).toBeGreaterThan(10);
    for (const [i, m] of marks.entries()) {
      const s = await world(`taint-lost-${i}-`);
      const lockFile = path.join(s.rsi, 'lock');
      let n = 0;
      let at = -1;
      await expect(
        withLock(s, (l) =>
          taintNewlyExcludedWith(
            s.ctx,
            l,
            { source: 'exclude' },
            {
              point: async (name) => {
                if (!name.startsWith('before:') || ++n !== i + 1) return;
                at = s.audit.length;
                await (await import('../../src/io/safe-fs.js')).remove(s.f.fx, lockFile);
              },
            },
          ),
        ),
        `丢锁于 ${m.name}`,
      ).rejects.toMatchObject({ kind: 'lock_lost' });
      // 钩子触发时与基线同一写入进度;抛出之后审计条数不得再增长(没有任何写点越过 assertHeld)
      expect(at, m.name).toBe(m.writes);
      expect(s.audit.length, `${m.name} 之后不得再写`).toBe(at);
    }
  }, 120_000);
});

describe('resumeTaint', () => {
  it('已有标记不被跳过:标记在、摘录与 patch 都还在 → 补完;再跑无事可做', async () => {
    const s = await world('resume-existing-');
    await put(
      s,
      path.join(runDirOf(s, 'run-x'), 'TAINTED'),
      canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
    );
    const out = await withLock(s, (l) => resumeTaint(s.ctx, l));
    expect(out.runsCompleted).toBe(1);
    await expectTaintedClean(s, 'reflect', 'run-x');
    // 闭包:指向已 taint 的 run 的 promote 一并标记并清理,原因随该 run
    await expectTaintedClean(s, 'promote', 'promo-x');
    expect((await markOf(promoteDirOf(s, 'promo-x')))?.reason).toBe('exclude');
    expect(out.promotesCompleted).toBe(1);
    expect(await exists(path.join(runDirOf(s, 'run-ok'), 'TAINTED'))).toBe(false);
    const again = await withLock(s, (l) => resumeTaint(s.ctx, l));
    expect(again).toEqual({ runsCompleted: 0, promotesCompleted: 0, journalResumedFrom: null });
  });

  it('不依赖信号库映射、不依赖当前排除配置:撤销排除、清空信号库后续做仍完成', async () => {
    const s = await world('resume-nosignals-');
    await put(
      s,
      path.join(runDirOf(s, 'run-x'), 'TAINTED'),
      canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
    );
    await setRsiToml(s, '');
    await put(s, path.join(s.state, 'signals', 'claude', '202610.jsonl'), '');
    await withLock(s, (l) => resumeTaint(s.ctx, l));
    await expectTaintedClean(s, 'reflect', 'run-x');
    await expectTaintedClean(s, 'promote', 'promo-x');
  });

  it('run 已标记、关联 promote 尚未标记就崩溃:撤销排除后 resume 仍封禁并清理 promote;无法关联的 promote 在有已 taint 的 run 时保守 taint,没有时不动', async () => {
    const s = await world('resume-promote-closure-');
    await stagePromote(s, 'promo-unlinked', null);
    await put(
      s,
      path.join(runDirOf(s, 'run-x'), 'TAINTED'),
      canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
    );
    await withLock(s, (l) => resumeTaint(s.ctx, l));
    await expectTaintedClean(s, 'promote', 'promo-x');
    await expectTaintedClean(s, 'promote', 'promo-unlinked');
    expect(await exists(path.join(promoteDirOf(s, 'promo-ok'), 'TAINTED'))).toBe(false);
    // 对照:没有任何已 taint 的 run 时,无法关联的 promote 不动
    const t = await world('resume-promote-nolink-');
    await stagePromote(t, 'promo-unlinked', null);
    await withLock(t, (l) => resumeTaint(t.ctx, l));
    expect(await exists(path.join(promoteDirOf(t, 'promo-unlinked'), 'TAINTED'))).toBe(false);
    expect(await allText(promoteDirOf(t, 'promo-unlinked'))).toContain(EXCERPT_MARK);
  });

  it('损坏的标记(空文件 / 半个 JSON / 是目录)也算已标记,照样清理', async () => {
    for (const [i, body] of ['', '{"reason":', null].entries()) {
      const s = await world(`resume-badmark-${i}-`);
      const mark = path.join(runDirOf(s, 'run-x'), 'TAINTED');
      if (body === null) await mkdirp(s.f.fx, mark, 0o700);
      else await put(s, mark, body);
      await withLock(s, (l) => resumeTaint(s.ctx, l));
      expect(await allText(runDirOf(s, 'run-x'))).not.toContain(EXCERPT_MARK);
      expect(await exists(path.join(runDirOf(s, 'run-x'), 'apply.patch'))).toBe(false);
    }
  });

  it('白名单清理:无法解析的提案换成同名空文件(编号保留),无法解析的原子 / 杂项 / .tmp / .yml / 子目录 / 符号链接被删,链接目标不动', async () => {
    const s = await world('resume-sweep-');
    const run = runDirOf(s, 'run-x');
    const sentinel = path.join(s.f.repo, 'sentinel.txt');
    await put(s, sentinel, `${EXCERPT_MARK}-sentinel`);
    await put(s, path.join(run, 'proposals', '2026-10-26-001.yaml'), '{{{ not yaml');
    await put(s, path.join(run, 'proposals', 'stray.yml'), EXCERPT_MARK);
    await put(s, path.join(run, 'proposals', 'x.yaml.abcd.tmp'), EXCERPT_MARK);
    await mkdirp(s.f.fx, path.join(run, 'proposals', 'sub'), 0o700);
    await put(s, path.join(run, 'proposals', 'sub', 'y.yaml'), EXCERPT_MARK);
    await put(s, path.join(run, 'rules', 'team', 'broken.md'), `no frontmatter ${EXCERPT_MARK}`);
    await symlink(s.f.fx, sentinel, path.join(run, 'rules', 'team', 'link.md'));
    await put(s, path.join(run, 'notes.txt'), EXCERPT_MARK);
    await put(
      s,
      path.join(run, 'TAINTED'),
      canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
    );
    await withLock(s, (l) => resumeTaint(s.ctx, l));
    expect(await allText(run)).not.toContain(EXCERPT_MARK);
    const files = await listFiles(run);
    expect(files).toContain('proposals/2026-10-26-001.yaml');
    expect((await readBytes(path.join(run, 'proposals', '2026-10-26-001.yaml'))).length).toBe(0);
    for (const gone of [
      'proposals/stray.yml',
      'proposals/x.yaml.abcd.tmp',
      'proposals/sub/y.yaml',
      'rules/team/broken.md',
      'rules/team/link.md',
      'notes.txt',
      'apply.patch',
    ]) {
      expect(files, gone).not.toContain(gone);
    }
    // 链接 / 硬链接指向的目标一个字节没动
    expect(await readText(sentinel)).toBe(`${EXCERPT_MARK}-sentinel`);
  });

  it('report.json 只有真实普通文件才被保留:目录 / 符号链接冒名的连同里面的东西一起清掉(run 与 promote)', async () => {
    const s = await world('resume-report-');
    const sentinel = path.join(s.f.repo, 'sentinel.txt');
    await put(s, sentinel, `${EXCERPT_MARK}-sentinel`);
    const run = runDirOf(s, 'run-x');
    await remove(s.f.fx, path.join(run, 'report.json'));
    await put(s, path.join(run, 'report.json', 'apply.patch'), EXCERPT_MARK);
    await put(
      s,
      path.join(run, 'TAINTED'),
      canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
    );
    const promo = promoteDirOf(s, 'promo-x');
    await remove(s.f.fx, path.join(promo, 'report.json'));
    await symlink(s.f.fx, sentinel, path.join(promo, 'report.json'));
    await put(
      s,
      path.join(promo, 'TAINTED'),
      canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
    );
    await withLock(s, (l) => resumeTaint(s.ctx, l));
    expect(await allText(run)).not.toContain(EXCERPT_MARK);
    expect(await listFiles(run)).not.toContain('report.json/apply.patch');
    expect(await exists(path.join(promo, 'report.json'))).toBe(false);
    expect(await readText(sentinel)).toBe(`${EXCERPT_MARK}-sentinel`);
  });

  it('暂存根 reflect/ 是符号链接 → resumeTaint / taintNewlyExcluded 都 fail-closed state_dir_unsafe,不碰链接目标', async () => {
    const s = await world('resume-rootlink-');
    const reflect = path.join(s.state, 'reflect');
    await rename(s.f.fx, reflect, `${reflect}-real`);
    await symlink(s.f.fx, `${reflect}-real`, reflect);
    await expect(withLock(s, (l) => resumeTaint(s.ctx, l))).rejects.toMatchObject({
      reason: 'state_dir_unsafe',
    });
    await expect(
      withLock(s, (l) => taintNewlyExcluded(s.ctx, l, { source: 'exclude' })),
    ).rejects.toMatchObject({ reason: 'state_dir_unsafe' });
    expect(await allText(`${reflect}-real`)).toContain(EXCERPT_MARK);
  });

  it('异常的 proposals/<id>.yaml(符号链接 / 同名目录)用占位保住编号:每个写点各崩一次,重跑后原名仍在、为空、无摘录', async () => {
    const setup = async (prefix: string): Promise<Svc> => {
      const s = await world(prefix);
      const run = runDirOf(s, 'run-x');
      const sentinel = path.join(s.f.repo, 'sentinel.txt');
      await put(s, sentinel, `${EXCERPT_MARK}-sentinel`);
      await remove(s.f.fx, path.join(run, 'proposals', '2026-10-26-001.yaml'));
      await symlink(s.f.fx, sentinel, path.join(run, 'proposals', '2026-10-26-001.yaml'));
      await remove(s.f.fx, path.join(run, 'proposals', '2026-10-26-002.yaml'));
      await put(s, path.join(run, 'proposals', '2026-10-26-002.yaml', 'inner.txt'), EXCERPT_MARK);
      await put(
        s,
        path.join(run, 'TAINTED'),
        canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
      );
      return s;
    };
    const base = await setup('resume-placeholder-base-');
    const hits: string[] = [];
    await withLock(base, (l) => resumeTaintWith(base.ctx, l, { point: (n) => void hits.push(n) }));
    expect(hits.length).toBeGreaterThan(8);
    for (let k = 1; k <= hits.length; k++) {
      const s = await setup(`resume-placeholder-${k}-`);
      let n = 0;
      await expect(
        withLock(s, (l) =>
          resumeTaintWith(s.ctx, l, {
            point: () => {
              if (++n === k) throw new CrashError('x');
            },
          }),
        ),
      ).rejects.toBeInstanceOf(CrashError);
      await withLock(s, (l) => resumeTaint(s.ctx, l));
      const dir = path.join(runDirOf(s, 'run-x'), 'proposals');
      for (const name of ['2026-10-26-001.yaml', '2026-10-26-002.yaml']) {
        const st = await lstat(path.join(dir, name));
        expect(st.isFile() && !st.isSymbolicLink(), `#${k} ${name} 是普通文件(编号保住)`).toBe(
          true,
        );
        expect(st.size, `#${k} ${name} 为空`).toBe(0);
      }
      expect(await listFiles(dir), `#${k}`).toEqual(['2026-10-26-001.yaml', '2026-10-26-002.yaml']);
      expect(await allText(runDirOf(s, 'run-x')), `#${k}`).not.toContain(EXCERPT_MARK);
      expect(await readText(path.join(s.f.repo, 'sentinel.txt'))).toBe(`${EXCERPT_MARK}-sentinel`);
    }
  }, 120_000);

  it('阻断状态:硬链接 / 根外符号链接 / 悬空符号链接 → staging_unsafe_entry;标记保留,预检先于任何清理(整棵树与其它已标记目录都原封不动),外部目标不动', async () => {
    const kinds = {
      hardlink: async (s: Svc, run: string): Promise<void> => {
        const sentinel = path.join(s.f.repo, 'sentinel.txt');
        await put(s, sentinel, `${EXCERPT_MARK}-sentinel`);
        await hardlink(s.f.fx, sentinel, path.join(run, 'proposals', 'linked.yaml'));
      },
      outside: async (s: Svc, run: string): Promise<void> => {
        const outside = path.join(s.f.dir, 'outside.txt'); // 在 fx 的写入根内、在服务 io 的写入根(repo)外
        await put(s, outside, `${EXCERPT_MARK}-outside`);
        await symlink(s.f.fx, outside, path.join(run, 'rules', 'team', 'out.md'));
      },
      dangling: async (s: Svc, run: string): Promise<void> => {
        await symlink(
          s.f.fx,
          path.join(s.f.repo, 'nonexistent'),
          path.join(run, 'proposals', 'dangle.yaml'),
        );
      },
    };
    for (const [name, plant] of Object.entries(kinds)) {
      const s = await world(`resume-blocked-${name}-`);
      const run = runDirOf(s, 'run-x');
      await plant(s, run);
      await put(
        s,
        path.join(run, 'TAINTED'),
        canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
      );
      // 另一个可清理的已标记 run:全局预检,所以它也不能被清到
      await stageRun(s, 'run-y', [SIG_B]);
      await put(
        s,
        path.join(runDirOf(s, 'run-y'), 'TAINTED'),
        canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
      );
      const snap = async (): Promise<string> =>
        JSON.stringify([
          await listFiles(run),
          await allText(run),
          await listFiles(runDirOf(s, 'run-y')),
          await allText(runDirOf(s, 'run-y')),
          (await listFiles(promoteDirOf(s, 'promo-x'))).filter((x) => x !== 'TAINTED'),
        ]);
      const before = await snap();
      const writesBefore = s.audit.length;
      const err = await withLock(s, (l) => resumeTaint(s.ctx, l)).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(RsiStagingBlockedError);
      expect((err as RsiStagingBlockedError).toStable()).toEqual({
        code: 'RSI_FAIL_CLOSED',
        reason: 'staging_unsafe_entry',
        exit: 3,
      });
      expect(await snap(), `${name}:无半清理`).toBe(before);
      expect(await exists(path.join(run, 'TAINTED'))).toBe(true);
      // 拿锁 / 释放锁之外,唯一的写是给关联 promote 补落 TAINTED(只落标记,不清理)
      expect(lockOnly(s.audit.slice(writesBefore))).toEqual([
        `createExclusive ${path.join(promoteDirOf(s, 'promo-x'), 'TAINTED')}`,
      ]);
      expect(await exists(path.join(promoteDirOf(s, 'promo-x'), 'TAINTED'))).toBe(true);
      if (name === 'outside')
        expect(await readText(path.join(s.f.dir, 'outside.txt'))).toBe(`${EXCERPT_MARK}-outside`);
    }
  });

  it('阻断状态下 taintNewlyExcluded(exclude):命中的 run 先补落 TAINTED(读路径随即拒绝),再抛 staging_unsafe_entry;内容一个字节不清', async () => {
    const s = await world('exclude-blocked-');
    const run = runDirOf(s, 'run-x');
    const sentinel = path.join(s.f.repo, 'sentinel.txt');
    await put(s, sentinel, 'x');
    await hardlink(s.f.fx, sentinel, path.join(run, 'proposals', 'linked.yaml'));
    const filesBefore = await listFiles(run);
    const textBefore = await allText(run);
    await expect(
      withLock(s, (l) => taintNewlyExcluded(s.ctx, l, { source: 'exclude' })),
    ).rejects.toBeInstanceOf(RsiStagingBlockedError);
    expect(await exists(path.join(run, 'TAINTED'))).toBe(true);
    expect((await markOf(run))?.reason).toBe('exclude');
    expect((await listFiles(run)).sort()).toEqual([...filesBefore, 'TAINTED'].sort());
    expect((await allText(run)).replace(/\{[^{}]*"reason"[^{}]*\}\s*/, '')).toBe(textBefore);
    expect(await allText(run)).toContain(EXCERPT_MARK); // 没清
    expect(await exists(path.join(run, 'apply.patch'))).toBe(true);
  });

  it('R20-6.7 目录数上限:5001 个 promote / 5001 个 run 目录 → staging_too_large,且发生在任何标记 / 清理之前(已标记的 run 仍带摘录)', async () => {
    for (const which of ['promote', 'run'] as const) {
      const s = await world(`count-${which}-`);
      await put(
        s,
        path.join(runDirOf(s, 'run-x'), 'TAINTED'),
        canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
      );
      const root = path.join(s.state, which === 'run' ? 'reflect' : 'promote');
      for (let i = 0; i < 4999; i++)
        await mkdirp(s.f.fx, path.join(root, `d${String(i).padStart(5, '0')}`), 0o700);
      const writesBefore = s.audit.length;
      await expect(
        withLock(s, (l) => resumeTaint(s.ctx, l)),
        which,
      ).rejects.toMatchObject({ reason: 'staging_too_large' });
      await expect(
        withLock(s, (l) => taintNewlyExcluded(s.ctx, l, { source: 'exclude' })),
        which,
      ).rejects.toMatchObject({ reason: 'staging_too_large' });
      expect(await allText(runDirOf(s, 'run-x')), `${which}:没清理`).toContain(EXCERPT_MARK);
      expect(lockOnly(s.audit.slice(writesBefore))).toEqual([]);
    }
  }, 180_000);

  it('R20-6.7 边界:恰好 5000 个 promote 目录放行(上限是严格的 > 5000)', async () => {
    const s = await world('count-boundary-');
    await put(
      s,
      path.join(runDirOf(s, 'run-x'), 'TAINTED'),
      canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
    );
    for (let i = 0; i < 4998; i++)
      await mkdirp(s.f.fx, path.join(s.state, 'promote', `d${String(i).padStart(5, '0')}`), 0o700);
    // world 里已有 promo-x、promo-ok:共 5000
    await withLock(s, (l) => resumeTaint(s.ctx, l));
    expect(await allText(runDirOf(s, 'run-x'))).not.toContain(EXCERPT_MARK);
  }, 120_000);

  it('purge journal:对 taint_targets 补标记(reason=purge)并清理,不改 journal;journalResumedFrom = 阶段', async () => {
    const s = await world('resume-journal-');
    const journal = {
      schema_version: 1,
      created_at: '2026-10-26T00:00:00.000Z',
      phase: 'planned',
      keys: [KEY_A],
      taint_targets: { runs: ['run-gone', 'run-x'], promotes: ['promo-x'] },
    } as const;
    await put(s, path.join(s.rsi, 'purge-journal.json'), canonicalJson(journal));
    const before = await readText(path.join(s.rsi, 'purge-journal.json'));
    const out = await withLock(s, (l) => resumeTaint(s.ctx, l));
    expect(out.journalResumedFrom).toBe('planned');
    expect(out.runsCompleted).toBe(1);
    await expectTaintedClean(s, 'reflect', 'run-x');
    await expectTaintedClean(s, 'promote', 'promo-x');
    expect((await markOf(runDirOf(s, 'run-x')))?.reason).toBe('purge');
    expect(await readText(path.join(s.rsi, 'purge-journal.json'))).toBe(before);
    expect(await exists(runDirOf(s, 'run-gone'))).toBe(false);
  });

  it('journal 不合规 → journal_invalid;读不出(权限宽于 0600)→ purge_incomplete;都不继续写', async () => {
    const s = await world('resume-journal-bad-');
    const file = path.join(s.rsi, 'purge-journal.json');
    await put(s, file, '{"schema_version":1}');
    const writes = s.audit.length;
    await expect(withLock(s, (l) => resumeTaint(s.ctx, l))).rejects.toMatchObject({
      reason: 'journal_invalid',
    });
    await chmod(s.f.fx, file, 0o644);
    await expect(withLock(s, (l) => resumeTaint(s.ctx, l))).rejects.toMatchObject({
      reason: 'purge_incomplete',
    });
    expect(await allText(runDirOf(s, 'run-x'))).toContain(EXCERPT_MARK);
    // 只有拿锁 / 建 rsi 目录的写(审计里没有任何 taint 写点)
    expect(s.audit.slice(writes).filter((x) => /reflect|promote/.test(x))).toEqual([]);
  });

  it('assertHeld:锁已丢时 resumeTaint 一个写点都不进(入口即抛)', async () => {
    const s = await world('resume-lost-');
    await put(
      s,
      path.join(runDirOf(s, 'run-x'), 'TAINTED'),
      canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
    );
    await expect(
      withLock(s, async (l) => {
        await (await import('../../src/io/safe-fs.js')).remove(s.f.fx, path.join(s.rsi, 'lock'));
        return resumeTaintWith(s.ctx, l);
      }),
    ).rejects.toBeInstanceOf(RsiLockError);
    expect(await allText(runDirOf(s, 'run-x'))).toContain(EXCERPT_MARK);
  });

  it('句柄必须属于 ctx.io 的 rsi 状态目录:持 A 的锁写 B 的状态 → internal', async () => {
    const a = await world('resume-a-');
    const b = await world('resume-b-');
    await put(
      b,
      path.join(runDirOf(b, 'run-x'), 'TAINTED'),
      canonicalJson({ reason: 'exclude', at: '2026-10-26T00:00:00.000Z' }),
    );
    await expect(withLock(a, (lockA) => resumeTaint(b.ctx, lockA))).rejects.toBeInstanceOf(
      RsiFailClosedError,
    );
    expect(await allText(runDirOf(b, 'run-x'))).toContain(EXCERPT_MARK);
  });
});

describe('taintNewlyExcluded(purge)', () => {
  it('按 journal 已记下的集合(不重新推导):即使信号库已空、没有排除配置,目标也被 taint;其它 run 不动', async () => {
    const s = await world('purge-source-');
    await setRsiToml(s, '');
    await put(s, path.join(s.state, 'signals', 'claude', '202610.jsonl'), '');
    const journal = {
      schema_version: 1 as const,
      created_at: '2026-10-26T00:00:00.000Z',
      phase: 'planned' as const,
      keys: [KEY_A],
      taint_targets: { runs: ['run-x'], promotes: ['promo-x'] },
    };
    const out = await withLock(s, (l) =>
      taintNewlyExcluded(s.ctx, l, { source: 'purge', journal }),
    );
    expect(out).toEqual({ runsMarked: 1, promotesMarked: 1 });
    expect((await markOf(runDirOf(s, 'run-x')))?.reason).toBe('purge');
    await expectTaintedClean(s, 'reflect', 'run-x');
    await expectTaintedClean(s, 'promote', 'promo-x');
    expect(await exists(path.join(runDirOf(s, 'run-ok'), 'TAINTED'))).toBe(false);
  });

  it('journal 里的 id 不合法(路径穿越)→ 拒绝,不碰暂存区外', async () => {
    const s = await world('purge-evil-');
    const journal = {
      schema_version: 1 as const,
      created_at: '2026-10-26T00:00:00.000Z',
      phase: 'planned' as const,
      keys: [KEY_A],
      taint_targets: { runs: ['../../etc'], promotes: [] },
    };
    await expect(
      withLock(s, (l) => taintNewlyExcluded(s.ctx, l, { source: 'purge', journal })),
    ).rejects.toBeInstanceOf(RsiFailClosedError);
  });
});

describe('detectPurgeJournal / assertNoPurgeInProgress(R20-3.8.5)', () => {
  it('absent / present / invalid / unreadable 四态;读不出不当不存在;只读不建目录', async () => {
    const s = await makeSvc('journal-probe-');
    const before = s.audit.length;
    expect(await detectPurgeJournal(s.ctx)).toEqual({ state: 'absent' }); // rsi/ 不存在
    expect(s.audit.length).toBe(before);
    expect(await exists(s.rsi)).toBe(false);
    await ensureRsiDir(s);
    expect(await detectPurgeJournal(s.ctx)).toEqual({ state: 'absent' });
    const file = path.join(s.rsi, 'purge-journal.json');
    const ok = {
      schema_version: 1,
      created_at: '2026-10-26T00:00:00.000Z',
      phase: 'signals_rewritten',
      keys: [KEY_A],
      taint_targets: { runs: [], promotes: [] },
    };
    await put(s, file, canonicalJson(ok));
    expect(await detectPurgeJournal(s.ctx)).toEqual({
      state: 'present',
      phase: 'signals_rewritten',
    });
    await put(s, file, 'garbage');
    expect(await detectPurgeJournal(s.ctx)).toEqual({ state: 'invalid' });
    await put(s, file, canonicalJson({ ...ok, phase: 'nope' }));
    expect(await detectPurgeJournal(s.ctx)).toEqual({ state: 'invalid' });
    await put(s, file, canonicalJson(ok));
    await chmod(s.f.fx, file, 0o644);
    expect(await detectPurgeJournal(s.ctx)).toEqual({ state: 'unreadable' });
    await chmod(s.f.fx, file, 0o600);
    await chmod(s.f.fx, s.rsi, 0o755);
    expect(await detectPurgeJournal(s.ctx)).toEqual({ state: 'unreadable' }); // rsi/ 本身不合规
    await chmod(s.f.fx, s.rsi, 0o700);
    expect(s.audit.length).toBe(before);
    // journal 是目录:读不出
    await (await import('../../src/io/safe-fs.js')).remove(s.f.fx, file);
    await mkdirp(s.f.fx, file, 0o700);
    expect(await detectPurgeJournal(s.ctx)).toEqual({ state: 'unreadable' });
  });

  it('assertNoPurgeInProgress:absent 放行;present / unreadable → purge_incomplete;invalid → journal_invalid', async () => {
    const s = await makeSvc('journal-assert-');
    await ensureRsiDir(s);
    await assertNoPurgeInProgress(s.ctx);
    const file = path.join(s.rsi, 'purge-journal.json');
    await put(s, file, 'x');
    await expect(assertNoPurgeInProgress(s.ctx)).rejects.toMatchObject({
      reason: 'journal_invalid',
    });
    await put(
      s,
      file,
      canonicalJson({
        schema_version: 1,
        created_at: '2026-10-26T00:00:00.000Z',
        phase: 'done',
        keys: [KEY_A],
        taint_targets: { runs: [], promotes: [] },
      }),
    );
    await expect(assertNoPurgeInProgress(s.ctx)).rejects.toMatchObject({
      reason: 'purge_incomplete',
    });
    await chmod(s.f.fx, file, 0o644);
    await expect(assertNoPurgeInProgress(s.ctx)).rejects.toMatchObject({
      reason: 'purge_incomplete',
    });
  });
});

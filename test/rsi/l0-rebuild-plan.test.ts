/**
 * R20-A2 B4c1:`planRebuildIndex`(R20-3.5.5、D11 / D12)。判据:
 *  - 盐只经只读原语;缺失 / 空盐 → `RebuildNoSaltError`,不建盐;
 *  - 旧索引有效(过 schema 且 salt_fp 相符)→ 合并:可信旧条目(含手动 allow 路径采来的、重算不出的 key)保留、`first_indexed_generation` 保留、新 key = 旧 generation + 1;
 *    无效 → 从空建,一律 `first_indexed_generation = 0`、`generation = 0`;
 *  - 头部读取上限 `RSI_REBUILD_MAX_FILES`、mtime 降序,如实报 `RSI_LIMIT_FILES` 与 `remainingFiles`;
 *  - 规划侧零写入(写审计、目录树、子进程空写入根;静态闭包见 l0-closure)。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  RSI_INDEX_MAX_ENTRIES,
  RSI_REBUILD_MAX_FILES,
  RsiProjectIndexSchema,
} from '../../src/contracts/rsi.js';
import type { Signal } from '../../src/contracts/signal.js';
import { exists, stat } from '../../src/io/read-fs.js';
import { chmod, mkdirp, remove, writeFile } from '../../src/io/safe-fs.js';
import { createRsiIoContext } from '../../src/rsi/io.js';
import { RsiSnapshotBusyError } from '../../src/rsi/exit.js';
import { RebuildNoSaltError, planRebuildIndex } from '../../src/rsi/l0/rebuild-plan.js';
import { projectKeyFor } from '../../src/signals/ids.js';
import { canonical } from '../../src/signals/exclude.js';
import { SaltError } from '../../src/signals/salt-read.js';
import { writeSignals } from '../../src/signals/state-store.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { withWriteAudit } from '../helpers/write-audit.js';
import { treeOf } from './rsi-fixture.js';
import { runRoChild } from './proc/ro-helper.js';
import { touchAt } from './proc/helper.js';
import { claudeLine, jl, makeL0Fx, put, uuid, type L0Fx } from './l0-fixture.js';
import { indexOf, key as rkey, mkProject, seed } from './ro-fixture.js';
import { signalObj } from './services-fixture.js';

const SALT = 'cd'.repeat(32);
const SALT_FP = createHash('sha256').update(SALT).digest('hex').slice(0, 12);
const NOW = new Date('2026-10-26T12:00:00.000Z');
const TODAY = '2026-10-26';
const deps = { now: () => NOW, piDirSet: false };

/** 零写入第二层的真子进程:把 proc/l0plan-entry.ts 用 vite 打成单文件(同 ro-helper.ts 的做法),再用 ro-helper 的通用 runRoChild 以 node 跑 */
async function buildL0PlanChild(outDir: string): Promise<string> {
  await build({
    configFile: false,
    logLevel: 'silent',
    root: REPO_ROOT,
    ssr: { noExternal: true },
    build: {
      ssr: path.join(REPO_ROOT, 'test/rsi/proc/l0plan-entry.ts'),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node22',
      rollupOptions: { output: { format: 'es', entryFileNames: 'rsi-l0plan.mjs' } },
    },
  });
  return path.join(outDir, 'rsi-l0plan.mjs');
}
interface PlanChildOut {
  plan: unknown;
  perKey: unknown;
  unknown: number;
  probeDenied: boolean;
}

const piHead = (cwd: string): string => jl({ type: 'session', cwd }, { type: 'message', id: 'm' });
const codexHead = (cwd: string): string =>
  jl({ type: 'session_meta', payload: { cwd } }, { type: 'event_msg' });

async function writeSalt(f: L0Fx, body = `${SALT}\n`): Promise<void> {
  await mkdirp(f.io, f.io.stateDir, 0o700);
  await chmod(f.io, f.io.stateDir, 0o700);
  const p = path.join(f.io.stateDir, 'salt');
  await writeFile(f.io, p, body, { mode: 0o600 });
  await chmod(f.io, p, 0o600);
}
const keyOf = async (p: string): Promise<string> => projectKeyFor(SALT, await canonical(p));
const sig = (n: number, k: string): Signal =>
  ({ ...signalObj(n.toString(16).padStart(16, '0'), k) }) as unknown as Signal;

async function setup(prefix: string): Promise<L0Fx> {
  const f = await makeL0Fx(prefix);
  await writeSalt(f);
  return f;
}

describe('planRebuildIndex:盐只经只读原语', () => {
  it('盐不存在 → RebuildNoSaltError,不建盐、不写任何东西', async () => {
    const f = await makeL0Fx('rb-nosalt-');
    const p = await mkProject(f, 'a');
    await put(f, 'pi', '--a--/s.jsonl', piHead(p.path));
    const before = await treeOf(f.dir);
    await expect(planRebuildIndex(f.io, f.config, deps)).rejects.toBeInstanceOf(RebuildNoSaltError);
    expect(await exists(path.join(f.io.stateDir, 'salt'))).toBe(false);
    expect(await treeOf(f.dir)).toEqual(before);
  });

  it('空盐文件 → RebuildNoSaltError(等待 / 回收归持锁方);非法盐 → SaltError 原样抛', async () => {
    const f = await makeL0Fx('rb-emptysalt-');
    await writeSalt(f, '');
    await expect(planRebuildIndex(f.io, f.config, deps)).rejects.toBeInstanceOf(RebuildNoSaltError);
    await writeSalt(f, 'zz\n');
    await expect(planRebuildIndex(f.io, f.config, deps)).rejects.toBeInstanceOf(SaltError);
  });
});

describe('planRebuildIndex:旧索引缺失 / 无效 → 从空重建(first_indexed_generation = 0)', () => {
  it('三家会话汇总成项目;key = projectKeyFor(盐, canonical(cwd));sessions / signals 取库内计数;无法归属的会话计入 unknownSessions', async () => {
    const f = await setup('rb-fresh-');
    const a = await mkProject(f, 'alpha');
    const b = await mkProject(f, 'beta');
    await put(f, 'claude', `p/${uuid(1)}.jsonl`, jl({ type: 'mode' }, claudeLine(a.path)));
    await put(f, 'pi', '--a--/s.jsonl', piHead(a.path));
    await put(f, 'codex', '2026/10/24/rollout-1.jsonl', codexHead(b.path));
    await put(f, 'pi', '--rel--/s.jsonl', piHead('relative/dir'));
    const ka = await keyOf(a.path);
    const kb = await keyOf(b.path);
    await writeSignals(f.io, 'claude', [sig(1, ka), sig(2, ka), sig(3, ka)]);
    const r = await planRebuildIndex(f.io, f.config, deps);
    expect(RsiProjectIndexSchema.safeParse(r.index).success).toBe(true);
    expect(r.index.salt_fp).toBe(SALT_FP);
    expect(r.index.generation).toBe(0);
    expect(r.index.entries.map((e) => e.key)).toEqual([ka, kb].sort());
    const ea = r.index.entries.find((e) => e.key === ka);
    const eb = r.index.entries.find((e) => e.key === kb);
    expect([ea?.signals, eb?.signals]).toEqual([3, 0]);
    expect(r.index.entries.every((e) => e.first_indexed_generation === 0)).toBe(true);
    const st = await stat(a.path);
    expect(ea?.roots).toEqual([
      {
        path: await canonical(a.path),
        dev: st.dev,
        ino: st.ino,
        first_seen: TODAY,
        last_seen: TODAY,
      },
    ]);
    expect([r.observed, r.keptFromOld, r.unknownSessions, r.remainingFiles]).toEqual([2, 0, 1, 0]);
    expect([r.filesRead, r.limitsHit, r.complete]).toEqual([4, [], true]);
  });

  it('旧索引盐不符 / 损坏 → 旧条目不可信、不保留;条目一律 first_indexed_generation = 0', async () => {
    for (const mode of ['salt_mismatch', 'corrupt', 'not_json'] as const) {
      const f = await setup(`rb-bad-${mode}-`);
      const a = await mkProject(f, 'alpha');
      await put(f, 'pi', '--a--/s.jsonl', piHead(a.path));
      const stale = {
        key: rkey(77),
        path: '/some/old/root',
        dev: 1,
        ino: 2,
        firstGen: 5,
      };
      await seed(
        f,
        mode === 'salt_mismatch'
          ? { index: indexOf([stale], 9, 'ffffffffffff') }
          : {
              raw: {
                'projects.json': mode === 'corrupt' ? '{"not":"an index"}' : 'not json at all',
              },
            },
      );
      const r = await planRebuildIndex(f.io, f.config, deps);
      expect(
        r.index.entries.map((e) => e.key),
        mode,
      ).toEqual([await keyOf(a.path)]);
      expect(r.index.entries[0]?.first_indexed_generation, mode).toBe(0);
      expect(r.index.generation, mode).toBe(0);
      expect([r.keptFromOld, r.observed], mode).toEqual([0, 1]);
    }
  });
});

describe('planRebuildIndex:旧索引有效 → 合并(D11)', () => {
  it('可信旧条目保留(含重算不出的手动 allow 路径 key)、first_indexed_generation 保留、新 key = 旧 generation + 1、index.generation 是旧值', async () => {
    const f = await setup('rb-merge-');
    const a = await mkProject(f, 'alpha');
    const b = await mkProject(f, 'beta');
    await put(f, 'pi', '--a--/s.jsonl', piHead(a.path));
    await put(f, 'pi', '--b--/s.jsonl', piHead(b.path));
    const ka = await keyOf(a.path);
    const kb = await keyOf(b.path);
    const manual = rkey(77); // 手动 `--allow-project <父目录>` 采的:key 是 allow 路径的哈希,按 rsi 口径重算不出
    await writeSignals(f.io, 'claude', [sig(1, manual), sig(2, manual)]);
    await seed(f, {
      index: indexOf(
        [
          {
            key: ka,
            path: await canonical(a.path),
            dev: a.dev,
            ino: a.ino,
            firstGen: 3,
            sessions: 9,
            signals: 9,
          },
          {
            key: manual,
            path: '/allow/parent',
            dev: 7,
            ino: 8,
            firstGen: 2,
            lastSeen: '2026-09-01',
          },
        ],
        7,
        SALT_FP,
      ),
    });
    const r = await planRebuildIndex(f.io, f.config, deps);
    expect(r.index.entries.map((e) => e.key)).toEqual([ka, kb, manual].sort());
    const by = (k: string) => r.index.entries.find((e) => e.key === k);
    expect(by(ka)?.first_indexed_generation).toBe(3);
    expect(by(ka)?.roots[0]?.last_seen).toBe(TODAY);
    expect(by(kb)?.first_indexed_generation).toBe(8);
    // 手动 key:条目与根原样保留,计数取库内重算(这里 2 条信号)
    expect(by(manual)?.roots).toEqual([
      { path: '/allow/parent', dev: 7, ino: 8, first_seen: '2026-10-01', last_seen: '2026-09-01' },
    ]);
    expect(by(manual)?.first_indexed_generation).toBe(2);
    expect(by(manual)?.signals).toBe(2);
    expect(by(ka)?.signals).toBe(0); // 陈旧的 9 被重算覆盖
    expect(r.index.generation).toBe(7);
    expect([r.keptFromOld, r.observed]).toEqual([1, 2]);
    expect(r.index.entries.some((e) => e.key === kb && e.roots.length === 1)).toBe(true);
  });

  it('重建 = 重新认定:旧条目同路径的根 (dev, ino) 漂移(换卷 / 删后重建)→ 就地改成现状,first_seen / first_indexed_generation 保留;常规 updateIndex 不自愈', async () => {
    const f = await setup('rb-heal-');
    const a = await mkProject(f, 'alpha');
    await put(f, 'pi', '--a--/s.jsonl', piHead(a.path));
    const ka = await keyOf(a.path);
    const cp = await canonical(a.path);
    await seed(f, {
      index: indexOf(
        [{ key: ka, path: cp, dev: a.dev, ino: a.ino + 12345, firstGen: 2 }],
        4,
        SALT_FP,
      ),
    });
    const r = await planRebuildIndex(f.io, f.config, deps);
    const e = r.index.entries[0];
    expect([e?.key, e?.first_indexed_generation]).toEqual([ka, 2]);
    expect(e?.roots).toEqual([
      { path: cp, dev: a.dev, ino: a.ino, first_seen: '2026-10-01', last_seen: TODAY },
    ]);
    expect(r.index.entries).toHaveLength(1);
  });

  it('counts.json 损坏也不挡重建:索引重建只读信号库 / 会话计数库,不读 counts.json', async () => {
    const f = await setup('rb-badcounts-');
    const a = await mkProject(f, 'alpha');
    await put(f, 'pi', '--a--/s.jsonl', piHead(a.path));
    await seed(f, { raw: { 'counts.json': '{"not":"counts"}' } });
    const r = await planRebuildIndex(f.io, f.config, deps);
    expect(r.index.entries.map((e) => e.key)).toEqual([await keyOf(a.path)]);
  });

  it('不能用新算出的 key 冒充手动 key:旧索引里的手动 key 与同路径新算 key 是两个条目', async () => {
    const f = await setup('rb-nospoof-');
    const a = await mkProject(f, 'alpha');
    await put(f, 'pi', '--a--/s.jsonl', piHead(a.path));
    const manual = rkey(55);
    await seed(f, {
      index: indexOf(
        [{ key: manual, path: await canonical(a.path), dev: a.dev, ino: a.ino }],
        4,
        SALT_FP,
      ),
    });
    const r = await planRebuildIndex(f.io, f.config, deps);
    expect(r.index.entries.map((e) => e.key)).toEqual([await keyOf(a.path), manual].sort());
    expect(manual).not.toBe(await keyOf(a.path)); // 前提:两个 key 确实不同
  });

  it('满 RSI_INDEX_MAX_ENTRIES:新项目不入索引,报 RSI_INDEX_FULL;旧条目全在', async () => {
    const f = await setup('rb-full-');
    const a = await mkProject(f, 'alpha');
    await put(f, 'pi', '--a--/s.jsonl', piHead(a.path));
    const specs = Array.from({ length: RSI_INDEX_MAX_ENTRIES }, (_, i) => ({
      key: `p_${(i + 1).toString(16).padStart(16, '0')}`,
      path: `/w/${i}`,
      dev: 1,
      ino: i + 1,
    }));
    await seed(f, { index: indexOf(specs, 3, SALT_FP) });
    const r = await planRebuildIndex(f.io, f.config, deps);
    expect(r.index.entries).toHaveLength(RSI_INDEX_MAX_ENTRIES);
    expect(r.limitsHit).toEqual(['RSI_INDEX_FULL']);
    expect(r.index.entries.some((e) => e.key === specs[0]?.key)).toBe(true);
    expect(r.keptFromOld).toBe(RSI_INDEX_MAX_ENTRIES);
    expect(r.observed).toBe(0);
  }, 60_000);

  it('旧索引的快照与清单对不上(提交进行中)→ RsiSnapshotBusyError(命令层退 4),不当成无效重建', async () => {
    const f = await setup('rb-busy-');
    const a = await mkProject(f, 'alpha');
    await put(f, 'pi', '--a--/s.jsonl', piHead(a.path));
    await seed(f, { index: indexOf([{ key: rkey(1), path: '/w/x', dev: 1, ino: 1 }], 3, SALT_FP) });
    await writeFile(f.io, path.join(f.io.stateDir, 'rsi', 'projects.json'), '{"changed":true}', {
      mode: 0o600,
    });
    await expect(planRebuildIndex(f.io, f.config, deps)).rejects.toBeInstanceOf(
      RsiSnapshotBusyError,
    );
  });
});

describe('planRebuildIndex:cwd 一律按 B4a 的头部规则(D12)', () => {
  it('被排除的项目根也进索引(purge / X 归属要靠索引条目);反思器自己的会话不入;相对 cwd 计 unknown', async () => {
    const f = await setup('rb-excl-');
    const ex = await mkProject(f, 'customer');
    const ok = await mkProject(f, 'free');
    await put(f, 'pi', '--e--/s.jsonl', piHead(ex.path));
    await put(f, 'pi', '--f--/s.jsonl', piHead(ok.path));
    await put(f, 'pi', '--self--/s.jsonl', piHead(path.join(f.io.stateDir, 'reflect', 'cwd')));
    await put(f, 'pi', '--rel--/s.jsonl', piHead('rel/dir'));
    const r = await planRebuildIndex(f.io, { ...f.config, excludeDirs: [ex.path] }, deps);
    expect(r.index.entries.map((e) => e.key)).toEqual(
      [await keyOf(ex.path), await keyOf(ok.path)].sort(),
    );
    expect(r.unknownSessions).toBe(1);
    // 对照:同一份数据不排除时索引相同(排除不改变「进索引」)
    const r2 = await planRebuildIndex(f.io, f.config, deps);
    expect(r2.index.entries.map((e) => e.key)).toEqual(r.index.entries.map((e) => e.key));
  });

  it('claude:cwd 不在首行(第 3 行)也能算出;第 33 行才有 → unknown', async () => {
    const f = await setup('rb-claude-');
    const a = await mkProject(f, 'alpha');
    const b = await mkProject(f, 'beta');
    const filler = (n: number): object[] => Array.from({ length: n }, () => ({ type: 'mode' }));
    await put(f, 'claude', `p1/${uuid(1)}.jsonl`, jl(...filler(2), claudeLine(a.path)));
    await put(f, 'claude', `p2/${uuid(2)}.jsonl`, jl(...filler(32), claudeLine(b.path)));
    const r = await planRebuildIndex(f.io, f.config, deps);
    expect(r.index.entries.map((e) => e.key)).toEqual([await keyOf(a.path)]);
    expect(r.unknownSessions).toBe(1);
  });

  it('项目根已不存在(stat 失败):不入索引、会话计 unknown;旧索引里已有该 key 时保留旧条目且不计 unknown', async () => {
    const f = await setup('rb-gone-');
    const gone = await mkProject(f, 'gone');
    await put(f, 'pi', '--g--/s.jsonl', piHead(gone.path));
    const kg = await keyOf(gone.path);
    await remove(f.fx, gone.path);
    const r = await planRebuildIndex(f.io, f.config, deps);
    expect(r.index.entries).toEqual([]);
    expect(r.unknownSessions).toBe(1);

    await seed(f, {
      index: indexOf(
        [{ key: kg, path: await canonical(gone.path), dev: gone.dev, ino: gone.ino }],
        4,
        SALT_FP,
      ),
    });
    const r2 = await planRebuildIndex(f.io, f.config, deps);
    expect(r2.index.entries.map((e) => e.key)).toEqual([kg]);
    expect(r2.unknownSessions).toBe(0);
    expect(r2.keptFromOld).toBe(1);
  });

  it('会话根不可评估(pi 目录被覆盖)→ complete = false;旧索引里 pi 项目的条目仍保留', async () => {
    const f = await setup('rb-incomplete-');
    const a = await mkProject(f, 'alpha');
    await put(f, 'pi', '--a--/s.jsonl', piHead(a.path));
    const ka = await keyOf(a.path);
    await seed(f, {
      index: indexOf(
        [{ key: ka, path: await canonical(a.path), dev: a.dev, ino: a.ino, firstGen: 2 }],
        4,
        SALT_FP,
      ),
    });
    const r = await planRebuildIndex(f.io, f.config, { ...deps, piDirSet: true });
    expect(r.complete).toBe(false);
    expect(r.index.entries.map((e) => [e.key, e.first_indexed_generation])).toEqual([[ka, 2]]);
    // 对照:没有覆盖时 complete = true
    expect((await planRebuildIndex(f.io, f.config, deps)).complete).toBe(true);
  });
});

describe('planRebuildIndex:头部读取上限(D11:mtime 降序,如实报告覆盖范围)', () => {
  it('默认上限是 RSI_REBUILD_MAX_FILES;少于上限时 remainingFiles = 0、不报 RSI_LIMIT_FILES', async () => {
    expect(RSI_REBUILD_MAX_FILES).toBe(10000);
    const f = await setup('rb-default-');
    for (let i = 0; i < 5; i++) {
      const p = await mkProject(f, `p${i}`);
      await put(f, 'pi', `--${i}--/s.jsonl`, piHead(p.path));
    }
    const r = await planRebuildIndex(f.io, f.config, deps);
    expect(r.index.entries).toHaveLength(5);
    expect([r.remainingFiles, r.filesRead, r.limitsHit]).toEqual([0, 5, []]);
  });

  it('超过上限:只读最近的 N 个文件对应的项目,其余报 RSI_LIMIT_FILES 与 remainingFiles(不计入 unknownSessions),每个文件至多一次头部读取', async () => {
    const f = await setup('rb-limit-');
    const paths: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await mkProject(f, `p${i}`);
      paths.push(p.path);
      const file = await put(f, 'pi', `--${i}--/s.jsonl`, piHead(p.path));
      touchAt(file, new Date(Date.UTC(2026, 9, 20 + i, 0, 0, 0))); // i 越大越新
    }
    const reads: string[] = [];
    const r = await planRebuildIndex(f.io, f.config, {
      ...deps,
      limits: { rebuildMaxFiles: 2 },
      hooks: { onRead: (i) => reads.push(i.path) },
    });
    expect(reads).toHaveLength(2);
    expect(new Set(reads).size).toBe(2);
    expect(r.index.entries.map((e) => e.key)).toEqual(
      [await keyOf(paths[2] as string), await keyOf(paths[3] as string)].sort(),
    );
    expect([r.remainingFiles, r.unknownSessions, r.filesRead]).toEqual([2, 0, 2]);
    expect(r.limitsHit).toEqual(['RSI_LIMIT_FILES']);
  });

  it('上限之外的老项目:旧索引有效时条目保留(与「整体替换丢掉可信旧条目」区分);无效时不在新索引里', async () => {
    const f = await setup('rb-limit-merge-');
    const paths: { path: string; dev: number; ino: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await mkProject(f, `p${i}`);
      paths.push(p);
      const file = await put(f, 'pi', `--${i}--/s.jsonl`, piHead(p.path));
      touchAt(file, new Date(Date.UTC(2026, 9, 20 + i, 0, 0, 0)));
    }
    const oldest = paths[0] as (typeof paths)[number];
    const k0 = await keyOf(oldest.path);
    const lim = { ...deps, limits: { rebuildMaxFiles: 2 } };
    const without = await planRebuildIndex(f.io, f.config, lim);
    expect(without.index.entries.some((e) => e.key === k0)).toBe(false);
    await seed(f, {
      index: indexOf(
        [
          {
            key: k0,
            path: await canonical(oldest.path),
            dev: oldest.dev,
            ino: oldest.ino,
            firstGen: 2,
          },
        ],
        6,
        SALT_FP,
      ),
    });
    const merged = await planRebuildIndex(f.io, f.config, lim);
    expect(merged.index.entries.find((e) => e.key === k0)?.first_indexed_generation).toBe(2);
    expect(merged.index.entries).toHaveLength(3);
    expect([merged.keptFromOld, merged.observed, merged.remainingFiles]).toEqual([1, 2, 1]);
  });
});

describe('planRebuildIndex:规划侧零写入(三层之二、之三;之一见 l0-closure)', () => {
  it('写审计 0 次;目录树前后一致;每个会话文件至多一次偏移 0、≤64KiB 的读;正向对照:读了真实数据且审计钩子下的写入会被记到', async () => {
    const f = await setup('rb-zw-');
    const a = await mkProject(f, 'alpha');
    const files = [
      await put(f, 'claude', `p/${uuid(1)}.jsonl`, jl(claudeLine(a.path))),
      await put(f, 'pi', '--a--/s.jsonl', piHead(a.path)),
    ];
    await seed(f, {
      index: indexOf([{ key: rkey(5), path: '/w/old', dev: 1, ino: 1 }], 4, SALT_FP),
    });
    const audit = withWriteAudit();
    const io = createRsiIoContext({ repo: f.repo, env: f.env, cwd: f.dir, writeAudit: audit.hook });
    const reads: { path: string; offset: number; length: number }[] = [];
    const before = await treeOf(f.dir);
    const r = await planRebuildIndex(io, f.config, {
      ...deps,
      hooks: { onRead: (i) => reads.push(i) },
    });
    expect(r.index.entries).toHaveLength(2); // 正向前提:确实读了并合并了
    expect(audit.calls).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
    expect(reads.map((x) => x.path).sort()).toEqual([...files].sort());
    for (const x of reads) expect([x.offset, x.length]).toEqual([0, 64 * 1024]);
    await writeFile(io, path.join(f.dir, 'tmp', 'probe'), 'x');
    expect(audit.calls.map((c) => c.op)).toEqual(['writeFile']);
  });

  it('子进程 KIT_WRITE_ROOTS=空:规划结果与进程内一致,写入探针被拒(正向对照:写入根确实是空的)', async () => {
    const f = await setup('rb-proc-');
    const a = await mkProject(f, 'alpha');
    await put(f, 'pi', '--a--/s.jsonl', piHead(a.path));
    await writeSignals(f.io, 'claude', [sig(1, await keyOf(a.path))]);
    const script = await buildL0PlanChild(f.tmp);
    const inproc = await planRebuildIndex(f.io, f.config, deps);
    const child = runRoChild(script, {
      repo: f.repo,
      cwd: f.dir,
      env: { ...f.env, PATH: '/usr/bin:/bin', KIT_WRITE_ROOTS: ':' },
      now: NOW.toISOString(),
      probePath: path.join(f.tmp, 'probe'),
    } as never) as unknown as PlanChildOut;
    expect(child.probeDenied).toBe(true);
    expect(child.plan).toEqual(JSON.parse(JSON.stringify(inproc)));
    expect(inproc.index.entries[0]?.signals).toBe(1);
    expect(child.unknown).toBe(0);
  }, 120_000);
});

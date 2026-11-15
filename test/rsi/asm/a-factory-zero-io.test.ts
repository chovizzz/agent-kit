/**
 * 装配块 A 段:工厂创建与 import 本身不读盘、不起子进程、不解析 git 路径;读 / 子进程只在端口方法被调用时才发生。
 * 做法:vi.mock 包住 read-fs 的全部函数导出,按调用累计;创建后计数必须仍为 0,第一次调用端口后必须 > 0(正向对照:计数器确实接在读上)。
 * 同时钉住 `recorded` 的装配语义:`gitPath()` 解析不到 → 与未装配实现同一行为(`unreadable(not_wired)`),spawn 间谍一次都不被调用,解析只做一次。
 */
import { describe, expect, it, vi } from 'vitest';
import { makeCanaryWorld } from '../canary/w5-fixture.js';

const counter = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../../src/io/read-fs.js', async (orig) => {
  const m = await orig<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(m).map(([k, v]) =>
      typeof v === 'function' && /^[a-z]/.test(k)
        ? [
            k,
            (...a: unknown[]) => {
              counter.n++;
              return (v as (...x: unknown[]) => unknown)(...a);
            },
          ]
        : [k, v],
    ),
  );
});

const OID = 'a'.repeat(40);

async function deps(over: { gitPath?: () => Promise<string | null> } = {}) {
  const w = await makeCanaryWorld('asm-a-zero-io-');
  const calls = { gitPath: 0, spawn: 0, payload: 0 };
  return {
    w,
    calls,
    d: {
      io: w.io,
      home: w.home,
      rsiDir: w.rsi,
      gitDir: `${w.home}/.local/share/agent-kit/personal/.git`,
      cfg: { excludeDirs: [], excludeNames: [] },
      redactor: { pass2: () => Promise.reject(new Error('unused')) } as never,
      gitPath:
        over.gitPath ??
        (async () => {
          calls.gitPath++;
          return null;
        }),
      gitSpawn: () => {
        calls.spawn++;
        throw new Error('spawn must not be called');
      },
      payload: async () => {
        calls.payload++;
        return { manifest: { files: [] }, contents: new Map() };
      },
    },
  };
}

describe('工厂创建与 import 不读盘、不起子进程', () => {
  it('import 组合根与全部适配器模块:零读盘', async () => {
    counter.n = 0;
    await import('../../../src/rsi/assemble-read.js');
    await import('../../../src/rsi/auto/git-path.js');
    await import('../../../src/rsi/auto/read/peek.js');
    await import('../../../src/rsi/personal/read/credentials.js');
    await import('../../../src/rsi/personal/read/step-sources.js');
    await import('../../../src/rsi/analysis/source-ports.js');
    expect(counter.n).toBe(0);
  });

  it('assembleReadAdapters 创建:零读盘、不解析 git 路径、不调 payload / spawn;第一次调用端口才读(正向对照)', async () => {
    const { assembleReadAdapters } = await import('../../../src/rsi/assemble-read.js');
    const { calls, d } = await deps();
    counter.n = 0;
    const a = assembleReadAdapters(d);
    expect(counter.n).toBe(0);
    expect(calls).toEqual({ gitPath: 0, spawn: 0, payload: 0 });
    expect(Object.keys(a).sort()).toEqual(
      [
        'analysis',
        'breaker',
        'home',
        'peekRecord',
        'peekRecords',
        'presets',
        'readySince',
        'recorded',
        'recordedSha',
        'revocations',
        'signals',
        'staged',
      ].sort(),
    );

    await a.revocations.read();
    expect(counter.n).toBeGreaterThan(0);
  });

  it('recorded:gitPath() 解析不到 = 未装配(unreadable not_wired),解析只做一次,spawn 一次都不调;解析到但仓库目录不存在 = 在预检就拒绝,同样不 spawn', async () => {
    const { assembleReadAdapters } = await import('../../../src/rsi/assemble-read.js');
    const { calls, d } = await deps();
    const a = assembleReadAdapters(d);
    expect(await a.recorded.readCommit(OID)).toEqual({ kind: 'unreadable', why: 'not_wired' });
    expect(await a.recorded.listTree(OID)).toEqual({ kind: 'unreadable', why: 'not_wired' });
    expect(await a.recorded.readBlob(OID)).toEqual({ kind: 'unreadable', why: 'not_wired' });
    expect(calls.gitPath).toBe(1);
    expect(calls.spawn).toBe(0);

    const wired = await deps({ gitPath: async () => '/usr/bin/git' });
    const b = assembleReadAdapters(wired.d);
    const r = await b.recorded.readCommit(OID);
    expect(r.kind).toBe('unreadable');
    expect(r.kind === 'unreadable' && r.why).not.toBe('not_wired');
    expect(wired.calls.spawn).toBe(0);
  });
});

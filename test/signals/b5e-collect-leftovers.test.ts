/**
 * R20-A2 B5e:B5d 评审遗留的四条补测(signals collect × rsi 持锁路径)。第五条(judge 的 TAINTED × live 清理后目录树)在 test/commands/judge-rsi-gate.test.ts。
 *  ① `stat` 失败的根不更新索引(R20-4.2);
 *  ② `createExcludeMatcher` 失败发生在 taint 续做**之后**:失败时 `exclude_invalid` 退 3,但上一次中断的 taint 清理已经补完(顺序:resumeTaint → 排除叠加);
 *  ③ `signals-collect.ts` 里 `projectKeyFor(salt, root)` 重算的 key 必须与 pipeline 返回的 `r.projectKey` 对得上——
 *     processed 且带 projectKey 的结果一定在 roots 里命中,否则观测被静默丢弃(索引里没有该项目);
 *  ④ `commitUnderLockWith` 没有 `log` 时 `trigger` 不会被写盘。
 * 全部用假 HOME 与临时仓库(makeSvc);每条负向断言旁边都有正向对照。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createSignalsCollectCommand,
  type SignalsCollectDeps,
} from '../../src/commands/signals-collect.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { createRedactor } from '../../src/redact/redactor.js';
import { exists, readText } from '../../src/io/read-fs.js';
import {
  commitCollectUnderLock,
  type CommitCollectInput,
} from '../../src/rsi/l0/commit-collect.js';
import { commitUnderLockWith } from '../../src/rsi/services/commit.js';
import { projectKeyFor } from '../../src/signals/ids.js';
import type { SessionResult } from '../../src/signals/pipeline.js';
import { genClaude } from '../fixtures/sessions/gen-claude.js';
import { ReferenceClaudeReader } from '../fixtures/sessions/reference-reader.js';
import {
  EXCERPT_MARK,
  SALT,
  SALT_FP,
  listFiles,
  makeRoot,
  makeSvc,
  put,
  runDirOf,
  stageRun,
  withLock,
} from '../rsi/services-fixture.js';
import type { Svc } from '../rsi/services-fixture.js';

// ②:只在本文件里把 createExcludeMatcher 包一层「可开关地失败」;关着时就是真实现
const matcherFault = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock('../../src/rsi/exclude-match.js', async (orig) => {
  const m = await orig<typeof import('../../src/rsi/exclude-match.js')>();
  return {
    ...m,
    createExcludeMatcher: ((...a: Parameters<typeof m.createExcludeMatcher>) => {
      matcherFault.calls++;
      if (matcherFault.fail) return Promise.reject(new Error('boom'));
      return m.createExcludeMatcher(...a);
    }) as typeof m.createExcludeMatcher,
  };
});

// ③:捕获 commitCollectUnderLock 的入参后原样转发
const captured = vi.hoisted(() => ({ inputs: [] as unknown[] }));
vi.mock('../../src/rsi/l0/commit-collect.js', async (orig) => {
  const m = await orig<typeof import('../../src/rsi/l0/commit-collect.js')>();
  return {
    ...m,
    commitCollectUnderLock: ((...a: Parameters<typeof m.commitCollectUnderLock>) => {
      captured.inputs.push(a[2]);
      return m.commitCollectUnderLock(...a);
    }) as typeof m.commitCollectUnderLock,
  };
});

interface CW {
  s: Svc;
  projA: string;
  env: Record<string, string>;
  argv: string[];
}

async function world(): Promise<CW> {
  const s = await makeSvc('b5e-col-');
  const projA = await makeRoot(s, 'A');
  const sessions = path.join(s.f.dir, 'sessions');
  await genClaude(s.f.fx, {
    root: sessions,
    cwd: projA,
    id: 's1',
    userTexts: ['你好,帮我看看这个'],
    toolCalls: 2,
    failedResults: 1,
    version: '2.1.294',
  });
  const env = { KIT_TMP: s.f.repo, KIT_REAL_HOME_OVERRIDE: s.f.home, PATH: '/usr/bin:/bin' };
  const argv = [
    '--source',
    sessions,
    '--agent',
    'claude',
    '--timeout-ms',
    '5000',
    '--allow-project',
    projA,
  ];
  return { s, projA, env, argv };
}

async function runIn(
  c: CW,
  deps: Partial<SignalsCollectDeps> = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const cmd = createSignalsCollectCommand({
    readers: { claude: () => new ReferenceClaudeReader() },
    now: () => new Date(c.s.clock.t),
    ...deps,
  });
  const code = await cmd.run({
    argv: c.argv,
    io: c.s.io,
    env: c.env,
    overlayPath: undefined,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err };
}

const processed = (key: string, ref = 's_0000000000000001'): SessionResult => ({
  status: 'processed',
  sessionRef: ref,
  eventsSeen: 1,
  projectKey: key,
  signals: [],
  dropped: 0,
  dropReasons: {},
});

describe('B5d 遗留 ①:stat 失败的根不更新索引', () => {
  it('同一次提交里,存在的根被写进索引,已消失的根(stat ENOENT)不被写;正向前提:两个都是 processed 且都有根', async () => {
    const s = await makeSvc('b5e-stat-');
    const okRoot = await makeRoot(s, 'ok');
    const goneRoot = path.join(s.f.dir, 'proj', 'gone-root'); // 从未创建:stat 必然失败
    const kOk = projectKeyFor(SALT, okRoot);
    const kGone = projectKeyFor(SALT, goneRoot);
    const input: CommitCollectInput = {
      results: [processed(kOk, 's_0000000000000001'), processed(kGone, 's_0000000000000002')],
      roots: new Map([
        [kOk, okRoot],
        [kGone, goneRoot],
      ]),
      saltFp: SALT_FP,
      redactor: createRedactor({ timeout_ms: 5000 }),
      gate: async () => undefined,
    };
    expect(input.roots.size, '前提:两个项目都有根').toBe(2);
    expect(await exists(goneRoot), '前提:已消失的根确实不存在').toBe(false);
    const r = await withLock(s, (lock) => commitCollectUnderLock(s.ctx, lock, input));
    expect(r.indexWritten, '前提:索引可写(索引与 cursor 都缺失,D7)').toBe(true);
    const idx = JSON.parse(await readText(path.join(s.rsi, 'projects.json'))) as {
      entries: { key: string; roots: { path: string }[] }[];
    };
    expect(idx.entries.map((e) => e.key)).toEqual([kOk]);
    expect(idx.entries[0]?.roots.map((x) => x.path)).toEqual([okRoot]);
    // 对照:把消失的根建出来,同样的输入下它就进索引(证明上面的缺席来自 stat 失败而不是别的过滤)
    const s2 = await makeSvc('b5e-stat2-');
    const ok2 = await makeRoot(s2, 'ok');
    const gone2 = await makeRoot(s2, 'gone-root');
    const k1 = projectKeyFor(SALT, ok2);
    const k2 = projectKeyFor(SALT, gone2);
    await withLock(s2, (lock) =>
      commitCollectUnderLock(s2.ctx, lock, {
        ...input,
        results: [processed(k1), processed(k2, 's_0000000000000002')],
        roots: new Map([
          [k1, ok2],
          [k2, gone2],
        ]),
      }),
    );
    const idx2 = JSON.parse(await readText(path.join(s2.rsi, 'projects.json'))) as {
      entries: { key: string }[];
    };
    expect(idx2.entries.map((e) => e.key).sort()).toEqual([k1, k2].sort());
  });
});

describe('B5d 遗留 ②:createExcludeMatcher 失败发生在 taint 续做之后', () => {
  async function pendingTaint(c: CW): Promise<string> {
    await stageRun(c.s, 'run-p', ['0123456789abcdef']);
    const dir = runDirOf(c.s, 'run-p');
    await put(c.s, path.join(dir, 'TAINTED'), '{"at":"2026-10-26T00:00:00.000Z","reason":"purge"}');
    return dir;
  }
  const excerptsLeft = async (dir: string): Promise<boolean> => {
    const files = await listFiles(dir);
    for (const f of files) {
      if (!/\.(yaml|md)$/.test(f)) continue;
      if ((await readText(path.join(dir, f))).includes(EXCERPT_MARK)) return true;
    }
    return false;
  };

  it('matcher 失败 → 退 3 exclude_invalid,但上一次中断的 taint 清理已补完(摘录清空、TAINTED 仍在),信号库未写', async () => {
    const c = await world();
    const dir = await pendingTaint(c);
    expect(await excerptsLeft(dir), '前提:有 TAINTED 标记但摘录还没清').toBe(true);
    matcherFault.fail = true;
    const before = matcherFault.calls;
    try {
      const r = await runIn(c);
      expect(r.code).toBe(ExitCode.FAIL_CLOSED);
      expect(r.err).toBe('RSI_FAIL_CLOSED reason=exclude_invalid\n');
      expect(matcherFault.calls, '前提:确实走到了 createExcludeMatcher').toBeGreaterThan(before);
    } finally {
      matcherFault.fail = false;
    }
    expect(await excerptsLeft(dir), 'taint 续做先于 matcher:摘录已清空').toBe(false);
    expect(await exists(path.join(dir, 'TAINTED'))).toBe(true);
    expect(await exists(path.join(c.s.state, 'signals'))).toBe(false); // matcher 失败发生在采集之前
  });

  it('对照:matcher 不失败时同一夹具成功退 0,同样清空摘录(清理不是 matcher 失败的副产品)', async () => {
    const c = await world();
    const dir = await pendingTaint(c);
    expect(await excerptsLeft(dir)).toBe(true);
    const r = await runIn(c);
    expect(r.code, r.err).toBe(ExitCode.OK);
    expect(await excerptsLeft(dir)).toBe(false);
  });
});

describe('B5d 遗留 ③:roots 里的 key 与 pipeline 返回的 projectKey 对得上', () => {
  it('processed 且带 projectKey 的结果,其 key 全部在 roots 里命中;并且索引里确实有该项目(否则观测静默丢失)', async () => {
    const c = await world();
    captured.inputs.length = 0;
    const r = await runIn(c);
    expect(r.code, r.err).toBe(ExitCode.OK);
    expect(captured.inputs, '前提:提交入口被调用一次').toHaveLength(1);
    const input = captured.inputs[0] as CommitCollectInput;
    const procd = input.results.filter(
      (x) => x.status === 'processed' && x.projectKey !== undefined,
    );
    expect(procd.length, '前提:有 processed 且带 projectKey 的结果').toBeGreaterThan(0);
    for (const x of procd) {
      expect(input.roots.has(x.projectKey as string), `roots 缺 ${x.projectKey}`).toBe(true);
    }
    // key 口径:盐 + 根路径的哈希;与 allow 路径原样保留的根一致
    const salt = (await readText(path.join(c.s.state, 'salt'))).trim();
    expect(input.roots.get(projectKeyFor(salt, c.projA))).toBe(c.projA);
    const idx = JSON.parse(await readText(path.join(c.s.rsi, 'projects.json'))) as {
      entries: { key: string }[];
    };
    expect(idx.entries.map((e) => e.key)).toContain(projectKeyFor(salt, c.projA));
  });

  it('对照:roots 缺 key(用错盐算出来的 key)时索引里没有该项目——这就是「静默丢失」的症状,上面的断言能抓到', async () => {
    const s = await makeSvc('b5e-keys-');
    const root = await makeRoot(s, 'A');
    const real = projectKeyFor(SALT, root);
    const wrong = projectKeyFor('cd'.repeat(32), root);
    expect(wrong).not.toBe(real);
    await withLock(s, (lock) =>
      commitCollectUnderLock(s.ctx, lock, {
        results: [processed(real)],
        roots: new Map([[wrong, root]]),
        saltFp: SALT_FP,
        redactor: createRedactor({ timeout_ms: 5000 }),
        gate: async () => undefined,
      }),
    );
    const idx = JSON.parse(await readText(path.join(s.rsi, 'projects.json'))) as {
      entries: unknown[];
    };
    expect(idx.entries).toEqual([]);
  });
});

describe('B5d 遗留 ④:commitUnderLockWith 没有 log 时 trigger 不落盘', () => {
  it('不给 log:没有 log.jsonl,rsi 目录里任何文件都不含 trigger 字段;对照:给 log 后日志行带 trigger', async () => {
    const s = await makeSvc('b5e-trig-');
    await withLock(s, async (lock) => {
      await commitUnderLockWith(s.ctx, lock, { trigger: 'kit' });
    });
    expect(await exists(path.join(s.rsi, 'log.jsonl'))).toBe(false);
    for (const f of await listFiles(s.rsi)) {
      expect(await readText(path.join(s.rsi, f)), f).not.toContain('"trigger"');
    }
    // 对照
    await withLock(s, async (lock) => {
      await commitUnderLockWith(s.ctx, lock, {
        trigger: 'kit',
        log: { action: 'purged', code: 'ok' },
      });
    });
    expect(await readText(path.join(s.rsi, 'log.jsonl'))).toContain('"trigger":"kit"');
  });

  it('commitCollectUnderLock 的提交调用没有 log(静态):源码里 commitUnderLockWith 的第三个参数是不含 log 的字面量', async () => {
    const src = await readText(
      path.join(import.meta.dirname, '../../src/rsi/l0/commit-collect.ts'),
    );
    const m = /commitUnderLockWith\(ctx, lock, (\{[^}]*\}), hooks\)/.exec(src);
    expect(m, '找到提交调用').not.toBeNull();
    expect(m?.[1]).toBe("{ trigger: 'kit' }");
    expect(m?.[1]).not.toContain('log');
  });
});

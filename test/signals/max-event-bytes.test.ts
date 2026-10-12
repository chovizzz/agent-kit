import { describe, expect, it } from 'vitest';
import type { SessionRead, TraceReader } from '../../src/contracts/reader.js';
import { createSignalsCollectCommand } from '../../src/commands/signals-collect.js';
import { MAX_LINE_BYTES } from '../../src/io/read-fs.js';
import { createRedactor } from '../../src/redact/index.js';
import { processSession } from '../../src/signals/pipeline.js';
import type { ExcludePolicy } from '../../src/signals/exclude.js';
import { genClaude } from '../fixtures/sessions/gen-claude.js';
import { newWork, runCollect } from './helpers.js';
import type { Work } from './helpers.js';

const allow = ['--allow-project', 'proj-a'];
const ARGS = (w: Work, extra: string[]): string[] => [
  '--source',
  w.sessions,
  '--agent',
  'claude',
  '--timeout-ms',
  '5000',
  ...extra,
];

describe('--max-event-bytes 上限(清理项 1)', () => {
  it('超过读行硬上限:参数解析阶段 USAGE(2),stderr 说明上限,不读不写', async () => {
    const w = await newWork('mx-over-');
    await genClaude(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 's1',
      userTexts: ['你好'],
      toolCalls: 1,
      failedResults: 0,
      version: '2.1.294',
    });
    for (const v of [String(MAX_LINE_BYTES + 1), '99999999999999']) {
      const r = await runCollect(w, ARGS(w, [...allow, '--max-event-bytes', v]));
      expect(r.code, v).toBe(2);
      expect(r.err, v).toContain('--max-event-bytes');
      expect(r.err, v).toContain(String(MAX_LINE_BYTES));
      expect(r.out, v).toBe('');
    }
    // 等号形式同样拒绝
    const eq = await runCollect(w, ARGS(w, [...allow, `--max-event-bytes=${MAX_LINE_BYTES + 1}`]));
    expect(eq.code).toBe(2);
    // 正向对照:恰好等于上限仍合法
    const ok = await runCollect(
      w,
      ARGS(w, [...allow, '--max-event-bytes', String(MAX_LINE_BYTES)]),
    );
    expect(ok.code).toBe(0);
  });
});

const policy: ExcludePolicy = {
  decide: async () => ({ action: 'process', projectRoot: '/work/proj-a' }),
} as unknown as ExcludePolicy;

describe('collect() 库入口校验 maxEventBytes', () => {
  it('越界直接抛 RangeError,而不是把每个会话变成 read_error', async () => {
    const { collect } = await import('../../src/signals/collect.js');
    const w = await newWork('mx-lib-');
    const base = {
      reader: {
        agent: 'claude',
        discover: async () => [],
        read: () => ({}) as never,
      } as TraceReader,
      source: w.sessions,
      io: w.io,
      dry: true,
      redactor: createRedactor({ timeout_ms: 5000 }),
      policy,
      salt: 'a'.repeat(32),
      fallbackVersion: undefined,
    };
    await expect(collect({ ...base, maxEventBytes: MAX_LINE_BYTES + 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(collect({ ...base, maxEventBytes: 0 })).rejects.toThrow(RangeError);
    await expect(collect({ ...base, maxEventBytes: MAX_LINE_BYTES })).resolves.toBeDefined();
  });
});

describe('pipeline:reader.read 同步抛错(清理项 1)', () => {
  const thrower: TraceReader = {
    agent: 'claude',
    discover: async () => [],
    read: (): SessionRead => {
      throw new Error('boom-read');
    },
  };
  it('processSession 返回 read_error,而不是抛出', async () => {
    const res = await processSession(
      thrower,
      { agent: 'claude', path: '/nonexistent/x.jsonl', session_ref: 'x', bytes: 0 },
      {
        redactor: createRedactor({ timeout_ms: 5000 }),
        policy,
        salt: 'a'.repeat(32),
        fallbackVersion: undefined,
        maxEventBytes: undefined,
      },
    );
    expect(res.status).toBe('read_error');
    expect(res.signals).toEqual([]);
  });

  it('命令层:read 抛错 → 结构化失败(退出 1 + SESSION_READ_FAILED),不是进程崩溃', async () => {
    const w = await newWork('mx-throw-');
    const reader: TraceReader = {
      ...thrower,
      discover: async () => [
        { agent: 'claude', path: `${w.sessions}/a.jsonl`, session_ref: 'a', bytes: 0 },
      ],
    };
    let out = '';
    let err = '';
    const cmd = createSignalsCollectCommand({ readers: { claude: () => reader } });
    const code = await cmd.run({
      argv: ARGS(w, [...allow, '--dry']),
      io: w.io,
      overlayPath: undefined,
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
    });
    expect(code).toBe(1);
    expect(err).toContain('SESSION_READ_FAILED count=1');
    expect(out).not.toContain('boom-read');
    expect(err).not.toContain('boom-read');
  });
});

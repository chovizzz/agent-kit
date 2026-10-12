import { describe, expect, it } from 'vitest';
import type {
  Counts,
  NormEvent,
  SessionMeta,
  SessionRead,
  TraceReader,
} from '../../src/contracts/reader.js';
import type { Redactor } from '../../src/contracts/redact.js';
import { createRedactor } from '../../src/redact/index.js';
import type { ExcludePolicy } from '../../src/signals/exclude.js';
import { PipelineFailClosedError, processSession } from '../../src/signals/pipeline.js';
import type { PipelineDeps } from '../../src/signals/pipeline.js';

/** 清理项 5:管线各阶段的抛错各自归类——reader 侧 = read_error(带类名),policy / 脱敏侧 = fail-closed(带阶段与类名)。 */
class ReaderBoom extends Error {}
class PolicyBoom extends Error {}
class RedactorBoom extends Error {}
const SECRET = 'sk-SECRET-IN-MESSAGE';

const COUNTS: Counts = {
  user_messages: 1,
  tool_calls: 0,
  tool_failures: 0,
  unknown_event_types: { weird_type: 2 },
};
const META: SessionMeta = {
  agent_version: '1.0.0',
  cwd_hint: '/work/proj-a',
  started_at: null,
  external_content: false,
  loaded_rule_paths: [],
};
const EVENT: NormEvent = {
  agent: 'claude',
  session_ref: 'a'.repeat(16),
  ts: '2026-10-01T00:00:00Z',
  kind: 'user_message',
  raw_type: 'user',
  text: '你好 世界',
} as NormEvent;

interface Inject {
  events?: () => AsyncIterable<NormEvent>;
  meta?: () => SessionMeta;
  counts?: () => Counts;
  noEvents?: boolean;
}

const readerOf = (inj: Inject): TraceReader => ({
  agent: 'claude',
  discover: async () => [],
  read: (): SessionRead => ({
    events:
      inj.events?.() ??
      (async function* () {
        if (!inj.noEvents) yield EVENT;
      })(),
    meta: inj.meta ?? (() => META),
    counts: inj.counts ?? (() => COUNTS),
  }),
});

const okPolicy: ExcludePolicy = {
  decide: async () => ({ action: 'process', projectRoot: '/work/proj-a' }),
};
const throwingPolicy: ExcludePolicy = {
  decide: async () => {
    throw new PolicyBoom(SECRET);
  },
};

const realRedactor = createRedactor({ timeout_ms: 5000 });
const depsOf = (over: Partial<PipelineDeps> = {}): PipelineDeps => ({
  redactor: realRedactor,
  policy: okPolicy,
  salt: 'a'.repeat(32),
  fallbackVersion: undefined,
  maxEventBytes: undefined,
  ...over,
});
const REF = { agent: 'claude', path: '/nonexistent/x.jsonl', session_ref: 'x', bytes: 0 } as const;

async function failure(p: Promise<unknown>): Promise<PipelineFailClosedError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PipelineFailClosedError);
    return e as PipelineFailClosedError;
  }
  throw new Error('期望 fail-closed 抛错,但管线正常返回了');
}

describe('正向对照:正常会话', () => {
  it('同样的合成 reader 无注入时 processed 且产出信号', async () => {
    const r = await processSession(readerOf({}), REF, depsOf());
    expect(r.status).toBe('processed');
    expect(r.signals).toHaveLength(1);
  });
});

describe('reader 侧抛错 → read_error,带错误类名,不带 message', () => {
  it('reader.read 同步抛错', async () => {
    const r = await processSession(
      {
        agent: 'claude',
        discover: async () => [],
        read: () => {
          throw new ReaderBoom(SECRET);
        },
      },
      REF,
      depsOf(),
    );
    expect(r).toMatchObject({ status: 'read_error', errorClass: 'ReaderBoom', signals: [] });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('事件迭代中途抛错', async () => {
    const r = await processSession(
      readerOf({
        events: () =>
          (async function* () {
            yield EVENT;
            throw new ReaderBoom(SECRET);
          })(),
      }),
      REF,
      depsOf(),
    );
    expect(r).toMatchObject({ status: 'read_error', errorClass: 'ReaderBoom', signals: [] });
  });

  it('循环后 read.meta() 抛错(无事件,meta 只在循环后调用)', async () => {
    const r = await processSession(
      readerOf({
        noEvents: true,
        meta: () => {
          throw new ReaderBoom(SECRET);
        },
      }),
      REF,
      depsOf(),
    );
    expect(r).toMatchObject({ status: 'read_error', errorClass: 'ReaderBoom', signals: [] });
  });

  it('循环后 read.counts() 抛错', async () => {
    const r = await processSession(
      readerOf({
        counts: () => {
          throw new ReaderBoom(SECRET);
        },
      }),
      REF,
      depsOf(),
    );
    expect(r).toMatchObject({ status: 'read_error', errorClass: 'ReaderBoom', signals: [] });
  });
});

describe('policy 抛错 → fail-closed(阶段 policy),不再被报成 read_error', () => {
  it('循环内首个带 cwd 的事件触发 policy.decide 抛错', async () => {
    const e = await failure(processSession(readerOf({}), REF, depsOf({ policy: throwingPolicy })));
    expect(e).toMatchObject({ stage: 'policy', errorClass: 'PolicyBoom' });
    expect(e.message).not.toContain(SECRET);
    expect(e.cause).toBeUndefined();
  });

  it('循环后(无事件)policy.decide 抛错', async () => {
    const e = await failure(
      processSession(readerOf({ noEvents: true }), REF, depsOf({ policy: throwingPolicy })),
    );
    expect(e).toMatchObject({ stage: 'policy', errorClass: 'PolicyBoom' });
  });
});

describe('脱敏器抛错 → fail-closed(阶段 redact)', () => {
  const boomApply: Redactor = {
    ...realRedactor,
    apply: () => {
      throw new RedactorBoom(SECRET);
    },
  };

  it('逐条摘录脱敏(循环内 settle)抛错', async () => {
    const e = await failure(processSession(readerOf({}), REF, depsOf({ redactor: boomApply })));
    expect(e).toMatchObject({ stage: 'redact', errorClass: 'RedactorBoom' });
    expect(e.message).not.toContain(SECRET);
  });

  it('循环后 sanitizeCounts(计数键脱敏)抛错', async () => {
    // 无事件 ⇒ 不走摘录脱敏,只有 sanitizeCounts 会碰 redactor
    const e = await failure(
      processSession(readerOf({ noEvents: true }), REF, depsOf({ redactor: boomApply })),
    );
    expect(e).toMatchObject({ stage: 'redact', errorClass: 'RedactorBoom' });
  });
});

describe('归类本身不能逃逸', () => {
  it('异常类的 name 取值会抛错:仍是 fail-closed(类名退回 Error),而不是被降级成 read_error', async () => {
    class Hostile extends Error {
      static override get name(): string {
        throw new Error('hostile name getter');
      }
    }
    const policy: ExcludePolicy = {
      decide: async () => {
        throw new Hostile(SECRET);
      },
    };
    const e = await failure(processSession(readerOf({}), REF, depsOf({ policy })));
    expect(e).toMatchObject({ stage: 'policy', errorClass: 'Error' });
  });
});

/**
 * cleanup3:cutExcerpt 的中性化标记半截、redact --timeout-ms 严格数字、read_error 类名汇总。
 */
import { describe, expect, it } from 'vitest';
import { parseDecimalUint as sharedParse } from '../../src/commands/args.js';
import { parseDecimalUint } from '../../src/commands/signals-collect.js';
import { createRedactCommand } from '../../src/commands/redact-cmd.js';
import { createSignalsCollectCommand } from '../../src/commands/signals-collect.js';
import type { TraceReader } from '../../src/contracts/reader.js';
import { PLACEHOLDER_NEUTRALIZED, PLACEHOLDER_OPEN } from '../../src/redact/placeholder.js';
import { cutExcerpt } from '../../src/signals/pipeline.js';
import { baseCtx } from '../helpers/tmp.js';
import { newWork } from './helpers.js';

describe('cutExcerpt:两种前缀的半截都退掉', () => {
  const END = 'api_key]]';
  it.each([
    ['合法标记', PLACEHOLDER_OPEN],
    ['中性化标记', PLACEHOLDER_NEUTRALIZED],
  ])('%s:切点落在前缀中间 / 类型名中间 / 完整落在窗内', (_n, open) => {
    // 切点在前缀中间(窗内只剩前缀的一截)
    for (let k = 1; k < open.length; k++) {
      const t = 'a'.repeat(300 - k) + open + END;
      const cut = cutExcerpt(t);
      expect(cut, `prefix k=${k}`).toBe('a'.repeat(300 - k));
    }
    // 切点在类型名中间
    const mid = 'a'.repeat(300 - open.length - 3) + open + END;
    expect(cutExcerpt(mid)).toBe('a'.repeat(300 - open.length - 3));
    // 正向对照:标记完整落在窗内则保留
    const whole = 'a'.repeat(100) + open + END + 'b'.repeat(300);
    const kept = cutExcerpt(whole);
    expect(kept.includes(open + END)).toBe(true);
    expect(Array.from(kept).length).toBe(300);
  });
});

describe('数字参数共享解析', () => {
  it('args.ts 与 signals-collect 引用同一实现', () => {
    expect(parseDecimalUint).toBe(sharedParse);
  });
});

describe('redact --timeout-ms 严格数字', () => {
  const run = async (argv: string[]): Promise<{ code: number; err: string }> => {
    let err = '';
    const cmd = createRedactCommand({ readStdin: async () => 'hello' });
    const code = await cmd.run({
      argv,
      io: baseCtx(),
      overlayPath: undefined,
      stdout: () => undefined,
      stderr: (t) => (err += t),
    });
    return { code, err };
  };
  it('0x10 / 1e3 / +5 / 空串 / 空白 / 小数 / 0 / 超大 → USAGE(2)', async () => {
    for (const bad of ['0x10', '1e3', '+5', '', ' 5', '5 ', '1.5', '0', '9'.repeat(30)]) {
      const sep = await run(['--stdin', '--timeout-ms', bad]);
      expect(sep.code, JSON.stringify(bad)).toBe(2);
      expect(sep.err).toContain('--timeout-ms');
      const eq = await run(['--stdin', `--timeout-ms=${bad}`]);
      expect(eq.code, `eq ${JSON.stringify(bad)}`).toBe(2);
    }
  });
  it('正向对照:5000 与 0010 接受', async () => {
    expect((await run(['--stdin', '--timeout-ms', '5000'])).code).toBe(0);
    expect((await run(['--stdin', '--timeout-ms=0010'])).code).toBe(0);
  });
});

describe('read_error 的类名汇总', () => {
  class ReaderBoomA extends Error {}
  class ReaderBoomB extends Error {}
  it('stderr 带按类名计数的汇总,不含 message / 路径', async () => {
    const w = await newWork('cl3-rerr-');
    const msgs = ['msg-' + 'leak1', 'msg-' + 'leak2', 'msg-' + 'leak3'];
    const classes = [ReaderBoomA, ReaderBoomA, ReaderBoomB];
    let i = 0;
    const reader: TraceReader = {
      agent: 'claude',
      discover: async () =>
        [0, 1, 2].map((n) => ({
          agent: 'claude' as const,
          path: `${w.sessions}/sess-${n}.jsonl`,
          session_ref: `s${n}`,
          bytes: 0,
        })),
      read: () => {
        const C = classes[i] as typeof ReaderBoomA;
        const m = msgs[i] as string;
        i++;
        throw new C(m);
      },
    };
    let out = '';
    let err = '';
    const cmd = createSignalsCollectCommand({ readers: { claude: () => reader } });
    const code = await cmd.run({
      argv: [
        '--source',
        w.sessions,
        '--agent',
        'claude',
        '--timeout-ms',
        '5000',
        '--allow-project',
        'proj-a',
        '--dry',
      ],
      io: w.io,
      overlayPath: undefined,
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
    });
    expect(code).toBe(1);
    expect(err).toContain('SESSION_READ_FAILED count=3');
    expect(err).toContain('"ReaderBoomA":2');
    expect(err).toContain('"ReaderBoomB":1');
    for (const m of msgs) {
      expect(err).not.toContain(m);
      expect(out).not.toContain(m);
    }
    expect(err).not.toContain('sess-');
  });
});

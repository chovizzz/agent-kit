import { describe, expect, it, vi } from 'vitest';
import { createSignalsCollectCommand } from '../../src/commands/signals-collect.js';
import type { SessionRead, TraceReader } from '../../src/contracts/reader.js';
import { newWork } from './helpers.js';

/** 清理项 5(命令层):policy 抛错 → fail-closed 退出 3;stderr 只有阶段与类名,不含异常 message。 */
class PolicyBoom extends Error {}
const SECRET = 'sk-SECRET-IN-POLICY-MESSAGE';

vi.mock('../../src/signals/exclude.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/signals/exclude.js')>();
  return {
    ...real,
    createExcludePolicy: async () => ({
      decide: async () => {
        throw new PolicyBoom(SECRET);
      },
    }),
  };
});

describe('signals collect:policy 抛错', () => {
  it('退出 3,REDACT_FAIL_CLOSED reason=pipeline_policy class=PolicyBoom,不泄漏 message,不写 .state', async () => {
    const w = await newWork('pfc-');
    const reader: TraceReader = {
      agent: 'claude',
      discover: async () => [
        { agent: 'claude', path: `${w.sessions}/a.jsonl`, session_ref: 'a', bytes: 0 },
      ],
      read: (): SessionRead => ({
        events: (async function* () {})(),
        meta: () => ({
          agent_version: '1.0.0',
          cwd_hint: '/work/proj-a',
          started_at: null,
          external_content: false,
          loaded_rule_paths: [],
        }),
        counts: () => ({
          user_messages: 0,
          tool_calls: 0,
          tool_failures: 0,
          unknown_event_types: {},
        }),
      }),
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
      ],
      io: w.io,
      overlayPath: undefined,
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
    });
    expect(code).toBe(3);
    expect(err).toContain('REDACT_FAIL_CLOSED reason=pipeline_policy class=PolicyBoom');
    expect(err + out).not.toContain(SECRET);
  });
});

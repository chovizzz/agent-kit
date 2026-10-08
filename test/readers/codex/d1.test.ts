/**
 * D1(spec §2.2.5/§8.1):Codex 的 tool_failures 只数结构化 status=="failed",是下界口径、版本受限。
 * 这里用三类合成样本钉住下界行为,并带正向控制(防「全是 0 所以相等」的空比对)。
 */
import { describe, expect, it } from 'vitest';
import { newWork } from '../../signals/helpers.js';
import { LineBuilder, writeRollout } from './build.js';
import { readFile, triple } from './helpers.js';

async function sample(prefix: string, b: LineBuilder, id = 's') {
  const w = await newWork(prefix);
  return readFile(await writeRollout(w.io, w.sessions, b, { id }));
}

/** 样本 A:0.149+ 风格,CommandExecution 有失败也有成功 */
function sampleA(): LineBuilder {
  const b = new LineBuilder().meta({ cli_version: '0.149.0-alpha.4.3' }).userItem('go');
  b.fn('exec_command');
  b.toolItem('CommandExecution', 'failed');
  b.fn('exec_command');
  b.toolItem('CommandExecution', 'completed');
  b.fn('exec_command');
  b.toolItem('CommandExecution', 'failed');
  return b;
}

/** 样本 B:0.142 风格,没有任何 shell 事件(无 CommandExecution),输出文本里有失败字样 */
function sampleB(): LineBuilder {
  const b = new LineBuilder().meta({ cli_version: '0.142.5' }).userItem('go');
  b.fn('exec_command');
  b.call('function_call_output', {
    call_id: 'k',
    output: 'Process exited with code 1\nOutput: error: failed',
  });
  b.call('custom_tool_call', { name: 'exec', input: 'run' });
  b.call('custom_tool_call_output', {
    output: [{ type: 'input_text', text: 'exit code: 2, status: failed' }],
  });
  return b;
}

/** 样本 C:只有 McpToolCall 的失败(0.142.5 起可见) */
function sampleC(): LineBuilder {
  const b = new LineBuilder().meta({ cli_version: '0.142.5' }).userItem('go');
  b.call('function_call', { name: 'mcp__srv__tool', namespace: 'mcp__srv' });
  b.toolItem('McpToolCall', 'failed');
  b.toolItem('McpToolCall', 'completed');
  return b;
}

describe('D1:tool_failures 是结构化下界口径', () => {
  it('正向控制:样本 A 的失败全部来自 CommandExecution,计数 = failed 条数', async () => {
    const a = await sample('d1-a-', sampleA());
    expect(triple(a.counts)).toEqual([1, 3, 2]);
    const failedKinds = a.events.filter((e) => e.tool_failed === true).map((e) => e.raw_type);
    expect(failedKinds).toEqual([
      'event_msg.item_completed.CommandExecution',
      'event_msg.item_completed.CommandExecution',
    ]);
  });

  it('下界:样本 B 有工具调用、输出文本里满是失败字样,但没有结构化状态位 → tool_failures 恒为 0,不做文本启发式', async () => {
    const b = await sample('d1-b-', sampleB());
    expect(b.counts.tool_calls).toBe(2); // 正向前提:调用确实被读到了
    expect(b.counts.user_messages).toBe(1);
    expect(b.counts.tool_failures).toBe(0);
    expect(b.events.filter((e) => e.tool_failed !== undefined)).toEqual([]);
    expect(b.counts.unknown_event_types).toEqual({});
  });

  it('同一批「调用 + 输出文本」之后追加一条结构化 failed → 恰好 +1(证明 B 的 0 是口径所致,不是读不到)', async () => {
    const b = sampleB();
    b.toolItem('CommandExecution', 'failed');
    const r = await sample('d1-b2-', b);
    expect(r.counts.tool_failures).toBe(1);
  });

  it('样本 C:McpToolCall 的 failed 计入,completed 不计', async () => {
    const c = await sample('d1-c-', sampleC());
    expect(triple(c.counts)).toEqual([1, 1, 1]);
    expect(c.events.find((e) => e.tool_failed === true)?.raw_type).toBe(
      'event_msg.item_completed.McpToolCall',
    );
  });
});

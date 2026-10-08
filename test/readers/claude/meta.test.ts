/** 验收 ④:agent_version / ts / session_ref 非空;C3 三级回退;cwd_hint。 */
import { describe, expect, it } from 'vitest';
import { stat } from '../../../src/io/read-fs.js';
import { assistantLine, newWork, readLines, stamp, toolUse, userLine } from './helpers.js';

describe('agent_version(§2.1.5)', () => {
  it('按行序第一个非空字符串 version;首批元数据行没有该字段;后来版本变化不上报', async () => {
    const w = await newWork('cl-ver-');
    const r = await readLines(w, [
      { type: 'permission-mode', permissionMode: 'default' },
      { type: 'mode', version: '' },
      { type: 'mode', version: 2 },
      { type: 'mode', version: null },
      userLine('a', { version: '2.1.250' }),
      userLine('b', { version: '2.1.293' }),
    ]);
    expect(r.meta.agent_version).toBe('2.1.250');
  });

  it('没有任何 version:null(由 collector 用 CLI 版本兜底,不在 reader 里编造)', async () => {
    const w = await newWork('cl-ver-none-');
    const r = await readLines(w, [userLine('a')]);
    expect(r.meta.agent_version).toBeNull();
  });

  it('version 在 <no-type> 行或未知类型行上也取(它们是会话的一部分,只有侧链行被整体跳过)', async () => {
    const w = await newWork('cl-ver-odd-');
    const a = await readLines(w, [{ version: '2.1.1' }, userLine('a', { version: '2.1.9' })]);
    expect(a.meta.agent_version).toBe('2.1.1');
    const b = await readLines(w, [{ type: 'weird', version: '2.1.2' }, userLine('a')]);
    expect(b.meta.agent_version).toBe('2.1.2');
  });
});

describe('cwd_hint', () => {
  it('第一个有 cwd 的行;同一文件里会变,取第一个', async () => {
    const w = await newWork('cl-cwd-');
    const r = await readLines(w, [
      { type: 'mode' },
      userLine('a', { cwd: '/work/one' }),
      userLine('b', { cwd: '/work/two' }),
    ]);
    expect(r.meta.cwd_hint).toBe('/work/one');
  });
  it('没有 cwd:null', async () => {
    const w = await newWork('cl-cwd-none-');
    expect((await readLines(w, [userLine('a')])).meta.cwd_hint).toBeNull();
  });
});

describe('ts(C3)', () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  it('一级:行自带时间戳,规范成 ISO 毫秒 UTC(无毫秒补 .000,带偏移换算)', async () => {
    const w = await newWork('cl-ts1-');
    const r = await readLines(w, [
      { type: 'mode', timestamp: '2026-01-01T00:00:01Z' },
      { type: 'mode', timestamp: '2026-01-01T08:00:02+08:00' },
      { type: 'mode', timestamp: '2026-01-01T00:00:03.5Z' },
    ]);
    expect(r.events.map((e) => e.ts)).toEqual([
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:03.500Z',
    ]);
  });

  it('二级:缺失或无效的时间戳用会话起始(文件里按行序第一个有效时间戳)', async () => {
    const w = await newWork('cl-ts2-');
    const r = await readLines(w, [
      { type: 'permission-mode' }, // 无时间戳
      { type: 'mode', timestamp: 'garbage' }, // 前缀不匹配
      { type: 'mode', timestamp: '2026-13-45T00:00:00Z' }, // 前缀匹配但 Date.parse 失败
      { type: 'mode', timestamp: 1767225600000 }, // Claude 不接受数字毫秒
      userLine('a', { timestamp: '2026-02-03T04:05:06.007Z' }),
      { type: 'mode' },
    ]);
    const want = '2026-02-03T04:05:06.007Z';
    expect(r.events.map((e) => e.ts)).toEqual([want, want, want, want, want, want]);
    expect(r.meta.started_at).toBe(want);
  });

  it('三级:整个文件没有任何有效时间戳 → 文件 mtime,started_at 为 null', async () => {
    const w = await newWork('cl-ts3-');
    const r = await readLines(w, [
      { type: 'permission-mode' },
      { type: 'user', message: { role: 'user', content: 'x' } },
      { type: 'assistant', message: { role: 'assistant', content: [toolUse('a')] } },
    ]);
    const mtime = (await stat(r.file)).mtime.toISOString();
    expect(r.events.length).toBeGreaterThan(0);
    for (const e of r.events) expect(e.ts).toBe(mtime);
    expect(r.meta.started_at).toBeNull();
  });

  it('非空率 100%:混合有/无/坏时间戳的文件里每个事件的 ts 都是合法 ISO', async () => {
    const w = await newWork('cl-ts-all-');
    const r = await readLines(w, [
      { type: 'mode' },
      userLine('a'),
      { ...stamp(), type: 'x-unknown' },
      assistantLine([toolUse('a')], { timestamp: 'nope' }),
      { type: 'last-prompt', timestamp: null },
    ]);
    expect(r.events.length).toBe(5);
    for (const e of r.events) expect(e.ts).toMatch(ISO);
  });
});

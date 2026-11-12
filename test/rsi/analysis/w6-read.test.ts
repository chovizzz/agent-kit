/**
 * W6 读取层适配器(`makeAnalysisSource`):账 / 会话计数行 / 信号的只读取回,任一行不合规整体失败;C4 字节数口径。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RSI_AUTO_LABEL, RSI_MARK_PREFIX } from '../../../src/contracts/rsi.js';
import * as safe from '../../../src/io/safe-fs.js';
import { appendLedgerLine } from '../../../src/rsi/canary/ledger.js';
import { c4BytesOfDoc, makeAnalysisSource } from '../../../src/rsi/analysis/read.js';
import { BODY, canaryDoc, makeCanaryWorld } from '../canary/w5-fixture.js';
import { assign, iso, sessRef, T_BASE } from './w6-fixture.js';

const sessionLine = (n: number, ts: string): string =>
  JSON.stringify({
    session_ref: sessRef(n),
    project_key: 'p1',
    ts,
    external_content: false,
    counts: { user_messages: 1, tool_calls: 2, tool_failures: 1, unknown_event_types: {} },
    rsi_markers: [],
    injection_excluded: 0,
  });
const signalLine = (n: number, ts: string): string =>
  JSON.stringify({
    sig_id: `sig_${n.toString(16).padStart(16, '0')}`,
    agent: 'claude',
    agent_version: '2.1.0',
    agent_version_source: 'session_meta',
    session_ref: sessRef(n),
    project_key: 'p1',
    ts,
    type: 'event',
    excerpt_redacted: '',
    external_content: false,
    confidence: 1,
    loaded_rule_ids: [],
    event_kind: 'tool_result_failed',
    event_index: 0,
  });

async function setup(prefix: string, sessions: string[], signals: string[]) {
  const w = await makeCanaryWorld(prefix);
  for (const [dir, lines, agent] of [
    ['sessions', sessions, 'claude'],
    ['signals', signals, 'claude'],
  ] as const) {
    await safe.mkdirp(w.io, path.join(w.io.stateDir, dir, agent), 0o700);
    await safe.writeFile(
      w.io,
      path.join(w.io.stateDir, dir, agent, '202611.jsonl'),
      lines.length === 0 ? '' : `${lines.join('\n')}\n`,
      { mode: 0o600 },
    );
  }
  const src = makeAnalysisSource({
    io: w.io,
    rsiDir: w.rsi,
    classify: async () => 'P',
    payloadDrift: async () => 'clean',
    collectedThrough: async () => null,
    c4Bytes: async () => null,
  });
  return { w, src };
}

describe('读取层:会话计数行与信号', () => {
  it('只取 ts ≥ since 的行;计数行带所在 agent', async () => {
    const { src } = await setup(
      'w6-read-',
      [sessionLine(1, '2026-11-01T10:00:00Z'), sessionLine(2, '2026-11-05T10:00:00Z')],
      [signalLine(1, '2026-11-01T10:00:00Z'), signalLine(2, '2026-11-05T10:00:00Z')],
    );
    const stats = await src.stats('2026-11-03T00:00:00Z');
    expect(stats.map((s) => [s.agent, s.stat.session_ref])).toEqual([['claude', sessRef(2)]]);
    const sigs = await src.signals('2026-11-03T00:00:00Z');
    expect(sigs.map((s) => s.session_ref)).toEqual([sessRef(2)]);
  });
  it('任一行不合 schema → 整体失败(不跳过坏行、不静默少计)', async () => {
    const bad = await setup('w6-read-bad1-', ['{"session_ref":"x"}'], []);
    await expect(bad.src.stats('2026-11-01T00:00:00Z')).rejects.toThrow();
    const badSig = await setup('w6-read-bad2-', [], ['{"sig_id":"bad"}']);
    await expect(badSig.src.signals('2026-11-01T00:00:00Z')).rejects.toThrow();
  });
});

describe('读取层:分组账', () => {
  it('账不存在 = [];追加的行读回;坏账 → 抛错(不退化成空账)', async () => {
    const { w, src } = await setup('w6-read-ledger-', [], []);
    expect(await src.ledger()).toEqual([]);
    const line = assign(1, 'treat');
    await appendLedgerLine(w.io, w.rsi, line);
    expect((await src.ledger()).length).toBe(1);
    await safe.writeFile(w.io, path.join(w.rsi, 'canary-ledger.jsonl'), 'not json\n', {
      mode: 0o600,
    });
    await expect(src.ledger()).rejects.toThrow('analysis read: ledger_invalid');
  });
});

describe('C4 字节数口径', () => {
  it('= treat 输出(标记行 + 标签行 + 哈希前 12 位 + 正文,各以换行结尾)的 UTF-8 字节数,与标记取值无关', () => {
    const doc = canaryDoc();
    const expected = Buffer.byteLength(
      `${RSI_MARK_PREFIX} rsm_${'0'.repeat(16)}\n${RSI_AUTO_LABEL}\n${doc.content_sha12}\n${BODY}\n`,
      'utf8',
    );
    expect(c4BytesOfDoc(doc)).toBe(expected);
    expect(c4BytesOfDoc(doc)).toBeLessThanOrEqual(1536);
    expect(iso(T_BASE).length).toBeGreaterThan(0);
  });
});

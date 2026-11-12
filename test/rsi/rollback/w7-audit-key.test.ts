/**
 * M6 审计键 = 转移条目的 idem_key(事件身份):即时落地与恢复共用 {@link auditItemsOf};缺事件身份的审计一律 fail-closed(不回落到行内容哈希)。
 * 端到端的「同毫秒、同 from/to/reason、不同 evidence → 两行审计」在 w7-journal.test.ts。
 */
import { describe, expect, it } from 'vitest';
import type { RsiAuditLine } from '../../../src/contracts/rsi-personal.js';
import {
  auditItemsOf,
  auditKeyOf,
  keyedAuditSink,
} from '../../../src/rsi/personal/effects-recover.js';
import { entry, rec } from '../personal/transition-fixture.js';
import { ID } from './w7-fixture.js';

const LINE: RsiAuditLine = {
  at: '2026-11-10T12:00:00.000Z',
  kind: 'transition',
  id: ID,
  dim: 'lifecycle',
  from: 'rolling_back',
  to: 'rolling_back',
  reason: 'harm_c1',
};

describe('audit key', () => {
  it('auditKeyOf = audit:<候选>:<idem_key>', () => {
    expect(auditKeyOf(ID, 'abcdef0123456789')).toBe(`audit:${ID}:abcdef0123456789`);
  });

  it('auditItemsOf:键取自条目的 idem_key,不同条目键不同(即使审计行内容相同)', () => {
    const e1 = { ...entry(2, 'rolling_back'), idem_key: '1111111111111111' };
    const e2 = { ...entry(3, 'rolling_back'), idem_key: '2222222222222222' };
    const items = auditItemsOf(rec('rolling_back', { transitions: [entry(1), e1, e2] }));
    expect(items.map((i) => i.key)).toEqual([
      `audit:${ID}:1111111111111111`,
      `audit:${ID}:2222222222222222`,
    ]);
  });

  it('keyedAuditSink:带键的行经 applyOnce(键 = 事件身份),同一行内容、两个事件身份 → 两次 applyOnce', async () => {
    const keys: string[] = [];
    const sink = keyedAuditSink({
      applyOnce: async (k) => {
        keys.push(k);
        return 'applied';
      },
    });
    await sink.appendKeyed?.([
      { line: LINE, idem_key: 'aaaaaaaaaaaaaaaa' },
      { line: LINE, idem_key: 'bbbbbbbbbbbbbbbb' },
    ]);
    expect(keys).toEqual([`audit:${ID}:aaaaaaaaaaaaaaaa`, `audit:${ID}:bbbbbbbbbbbbbbbb`]);
  });

  it('缺事件身份(没有转移条目的审计)→ 抛错,不调用 applyOnce(fail-closed,不回落到行内容哈希)', async () => {
    let calls = 0;
    const sink = keyedAuditSink({
      applyOnce: async () => {
        calls += 1;
        return 'applied';
      },
    });
    await expect(sink.appendKeyed?.([{ line: LINE }])).rejects.toThrow('audit_key_missing');
    await expect(sink.append([LINE])).rejects.toThrow('audit_key_missing');
    expect(calls).toBe(0);
  });
});

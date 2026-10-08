import { describe, expect, it } from 'vitest';
import { createRedactor } from '../../src/redact/index.js';
import {
  cutExcerpt,
  makeExcerpt,
  safeKey,
  sanitizeCounts,
  TEXT_WINDOW,
  UNPRINTABLE_KEY,
} from '../../src/signals/pipeline.js';
import { recognizedSeeds } from './helpers.js';
import { fakeSk } from '../redact/helpers.js';

const PH = '[[REDACTED:api_key]]';

describe('cutExcerpt', () => {
  it('不超长原样返回;超长按码点截到 300', () => {
    expect(cutExcerpt('短')).toBe('短');
    const cjk = '汉'.repeat(400);
    expect(Array.from(cutExcerpt(cjk)).length).toBe(300);
  });

  it('切点落在占位符中间时退到占位符开头;占位符完整落在窗内则保留(正向对照)', () => {
    const inside = 'a'.repeat(295) + PH; // 占位符跨越第 300 个码点
    expect(cutExcerpt(inside)).toBe('a'.repeat(295));
    const midName = 'a'.repeat(285) + PH; // 切点落在类型名中间:`[[REDACTED:api_k`
    expect(cutExcerpt(midName)).toBe('a'.repeat(285));
    const whole = 'a'.repeat(270) + PH + 'b'.repeat(100); // 占位符完整在窗内
    const cut = cutExcerpt(whole);
    expect(cut.includes(PH)).toBe(true);
    expect(Array.from(cut).length).toBeLessThanOrEqual(300);
  });

  it('不把代理对切成两半', () => {
    const emoji = '😀'.repeat(400);
    expect(Array.from(cutExcerpt(emoji)).length).toBe(300);
    expect(cutExcerpt(emoji).endsWith('😀')).toBe(true);
  });
});

describe('makeExcerpt', () => {
  const redactor = createRedactor({ timeout_ms: 5000 });

  it('被截断的文本收在最后一个空白处;找不到空白则置空(防半截秘密)', () => {
    const withSpace = `${'x'.repeat(10)} ${'y'.repeat(10)}`;
    expect(makeExcerpt(redactor, withSpace, true)).toEqual({ ok: true, excerpt: 'x'.repeat(10) });
    expect(makeExcerpt(redactor, 'z'.repeat(50), true)).toEqual({ ok: true, excerpt: '' });
    // 对照:没被截断时整段保留
    expect(makeExcerpt(redactor, 'z'.repeat(50), false)).toEqual({
      ok: true,
      excerpt: 'z'.repeat(50),
    });
    expect(TEXT_WINDOW).toBe(4096);
  });

  it('原文里的伪占位符不能当作「已脱敏」:藏在类型名里的敏感词照样被替换(正向对照:不拆标记时会漏)', () => {
    const r = createRedactor({ timeout_ms: 5000, sensitive_words: ['acme'] });
    const out = makeExcerpt(r, '见 [[REDACTED:acme]] 的合同', false);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.excerpt.includes('acme')).toBe(false);
    // 对照:直接喂给脱敏器(不拆标记)确实会漏,说明上面的断言有牙
    const raw = r.apply('见 [[REDACTED:acme]] 的合同');
    expect(raw.ok && raw.text.includes('acme')).toBe(true);
  });

  it('空文本 → 空摘录;识别到的秘密被占位符取代(正向对照)', () => {
    expect(makeExcerpt(redactor, undefined, false)).toEqual({ ok: true, excerpt: '' });
    const seed = recognizedSeeds()[0];
    const r = makeExcerpt(createRedactor({ timeout_ms: 5000 }), seed?.input, false);
    expect(r.ok).toBe(true);
    if (r.ok) for (const n of seed?.needles ?? []) expect(r.excerpt.includes(n)).toBe(false);
  });
});

describe('键清洗(unknown_event_types 的键来自 trace 原文)', () => {
  const redactor = createRedactor({ timeout_ms: 5000 });

  it('合规键原样;含非法字符/过长/被脱敏改写的键归并到 <unprintable>', () => {
    for (const ok of [
      '<malformed>',
      '<no-type>',
      'assistant.(none)',
      'event_msg.item_completed.FutureThing',
      'weird-new-type',
    ]) {
      expect(safeKey(redactor, ok), ok).toBe(ok);
    }
    expect(safeKey(redactor, 'has space')).toBe(UNPRINTABLE_KEY);
    expect(safeKey(redactor, 'x'.repeat(97))).toBe(UNPRINTABLE_KEY);
    const key = fakeSk(); // 合规字符集、长度 <96,但会被脱敏器改写
    expect(/^[A-Za-z0-9_.:()<>+-]{1,96}$/.test(key)).toBe(true);
    expect(safeKey(redactor, key)).toBe(UNPRINTABLE_KEY);
  });

  it('sanitizeCounts:归并时计数求和,不丢', () => {
    const c = sanitizeCounts(redactor, {
      user_messages: 1,
      tool_calls: 0,
      tool_failures: 0,
      unknown_event_types: { 'a b': 2, 'c d': 3, ok: 1 },
    });
    expect(c.unknown_event_types).toEqual({ [UNPRINTABLE_KEY]: 5, ok: 1 });
  });
});

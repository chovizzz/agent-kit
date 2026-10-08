import { describe, expect, it } from 'vitest';
import { findModelNames } from '../../src/atoms/model-names.js';

describe('findModelNames', () => {
  it.each([
    ['claude-sonnet-5', ['claude-sonnet-5']],
    ['Claude-Opus-5.5', ['claude-opus-5.5']],
    ['gpt-6.1-sol', ['gpt-6.1-sol']],
    ['gpt-4o', ['gpt-4o']],
    ['gemini-2.5-pro', ['gemini-2.5-pro']],
    ['deepseek-v4-flash', ['deepseek-v4-flash']],
    ['kimi-for-coding', ['kimi-for-coding']],
    ['glm-5.3-flash', ['glm-5.3-flash']],
    ['qwen3-coder', ['qwen3-coder']],
    ['o4-mini', ['o4-mini']],
    ['用 Opus 评审', ['opus']],
  ])('命中 %s', (text, names) => {
    expect(findModelNames(text)).toEqual(names);
  });

  it('长名里被覆盖的裸词不重复计:claude-sonnet-5 只算一个', () => {
    expect(findModelNames('让 claude-sonnet-5 做,再让 haiku 做')).toEqual([
      'claude-sonnet-5',
      'haiku',
    ]);
  });

  it('已知取舍:裸词 opus/sonnet/haiku/fable 在散文里也算命中(宁可误报让作者换措辞)', () => {
    expect(findModelNames('as the fable tells')).toEqual(['fable']);
  });

  it.each([
    'judge 档位负责评审',
    'implement 与 readonly 档位',
    'o1 复杂度的循环',
    '一份 gpt 相关的说明(无版本号)',
    'the model tier mapping lives in the overlay',
  ])('不误伤 %s', (text) => {
    expect(findModelNames(text)).toEqual([]);
  });
});

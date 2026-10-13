import { describe, expect, it } from 'vitest';
import {
  BUILTIN_FAMILIES,
  VendorOverrideDeniedError,
  assertVendorOverrides,
  deriveVendor,
  isCrossVendor,
} from '../../src/contracts/index.js';

describe('R0-4 deriveVendor 全表', () => {
  const rows: [string, { backend: string; provider?: string; model?: string }, string][] = [
    ['claude CLI', { backend: 'claude' }, 'anthropic'],
    ['claude CLI 带同族 model', { backend: 'claude', model: 'claude-opus-5-5' }, 'anthropic'],
    ['claude CLI 带别家 model → 配置与后端矛盾', { backend: 'claude', model: 'gpt-6' }, 'unknown'],
    ['claude CLI 带未识别 model 仍是 anthropic', { backend: 'claude', model: 'opus' }, 'anthropic'],
    [
      'codex 默认 provider 却配了别家 model',
      { backend: 'codex', model: 'deepseek-chat' },
      'unknown',
    ],
    ['codex 默认 provider + gpt model', { backend: 'codex', model: 'gpt-6.1-sol' }, 'openai'],
    ['codex 默认 provider', { backend: 'codex' }, 'openai'],
    [
      'codex provider=openai',
      { backend: 'codex', provider: 'openai', model: 'whatever' },
      'openai',
    ],
    [
      'codex 其它 provider 按模型族',
      { backend: 'codex', provider: 'azure', model: 'gpt-6.1-sol' },
      'openai',
    ],
    [
      'codex 其它 provider 推导不出',
      { backend: 'codex', provider: 'azure', model: 'mystery' },
      'unknown',
    ],
    ['codex 其它 provider 无模型', { backend: 'codex', provider: 'azure' }, 'unknown'],
    ['pi deepseek', { backend: 'pi', model: 'deepseek-v4-flash' }, 'deepseek'],
    ['pi DeepSeek 大小写', { backend: 'pi', model: 'DeepSeek-V4.1-Flash' }, 'deepseek'],
    ['pi glm', { backend: 'pi', model: 'glm-5.3-flash' }, 'zhipu'],
    ['pi kimi', { backend: 'pi', model: 'kimi-for-coding' }, 'moonshot'],
    ['pi moonshot', { backend: 'pi', model: 'moonshot-v1-8k' }, 'moonshot'],
    ['pi gpt', { backend: 'pi', model: 'gpt-6-sol' }, 'openai'],
    ['pi o1', { backend: 'pi', model: 'o1' }, 'openai'],
    ['pi o3-mini', { backend: 'pi', model: 'o3-mini' }, 'openai'],
    ['pi claude', { backend: 'pi', model: 'claude-opus-5-5' }, 'anthropic'],
    ['pi gemini', { backend: 'pi', model: 'gemini-3-pro' }, 'google'],
    ['pi 带组织前缀', { backend: 'pi', model: 'deepseek/deepseek-v4-flash' }, 'deepseek'],
    [
      'pi 路径段里只有一段命中',
      { backend: 'pi', model: 'openrouter/anthropic/claude-opus' },
      'anthropic',
    ],
    ['pi 无模型', { backend: 'pi' }, 'unknown'],
    ['pi 未知模型', { backend: 'pi', model: 'mystery-1' }, 'unknown'],
    ['未知后端', { backend: 'other', model: 'gpt-6' }, 'unknown'],
  ];
  for (const [name, input, want] of rows) {
    it(name, () => expect(deriveVendor(input)).toBe(want));
  }

  it('前缀伪造:族 token 必须整词相等(deepseekfoo / gptx / glmfoo / o / oz / o-1 都是 unknown)', () => {
    for (const model of [
      'deepseekfoo',
      'gptx-1',
      'glmfoo',
      'o',
      'oz1',
      'o-1',
      'claudefoo',
      'kimix',
    ]) {
      expect(deriveVendor({ backend: 'pi', model }), model).toBe('unknown');
    }
  });

  it('各路径段命中的厂商互相矛盾 → unknown(不能靠拼接 deepseek/claude-x 取一个顺眼的)', () => {
    expect(deriveVendor({ backend: 'pi', model: 'deepseek/claude-x' })).toBe('unknown');
    expect(deriveVendor({ backend: 'pi', model: 'gpt-5/gemini-3' })).toBe('unknown');
  });

  it('非法字符一律 unknown:空白、控制字符、全角/同形字符、反斜杠、空串', () => {
    for (const model of [
      ' deepseek-v4',
      'deepseek-v4 ',
      'deepseek v4',
      'deepseek-v4\n',
      'ｄeepseek-v4',
      'dеepseek-v4', // 西里尔 е
      'deepseek\\v4',
      '',
    ]) {
      expect(deriveVendor({ backend: 'pi', model }), JSON.stringify(model)).toBe('unknown');
    }
  });

  it('pi 的第一方 provider 只做一致性校验:矛盾 → unknown;聚合渠道只看模型', () => {
    expect(deriveVendor({ backend: 'pi', provider: 'deepseek', model: 'deepseek-v4' })).toBe(
      'deepseek',
    );
    expect(deriveVendor({ backend: 'pi', provider: 'zai', model: 'glm-5.3-flash' })).toBe('zhipu');
    expect(deriveVendor({ backend: 'pi', provider: 'kimi-coding', model: 'kimi-for-coding' })).toBe(
      'moonshot',
    );
    expect(deriveVendor({ backend: 'pi', provider: 'anthropic', model: 'gpt-6' })).toBe('unknown');
    expect(deriveVendor({ backend: 'pi', provider: 'deepseek', model: 'mystery' })).toBe('unknown');
    expect(deriveVendor({ backend: 'pi', provider: 'some-aggregator', model: 'glm-5' })).toBe(
      'zhipu',
    );
  });

  it('用户不能声明厂商:provider/vendor 字样的输入不改变推导', () => {
    expect(
      deriveVendor({
        backend: 'pi',
        provider: 'agg',
        vendor: 'anthropic',
        model: 'deepseek-v4',
      } as never),
    ).toBe('deepseek');
    expect(deriveVendor({ backend: 'claude', vendor: 'openai' } as never)).toBe('anthropic');
  });

  it('内置族表是冻结的', () => {
    expect(Object.isFrozen(BUILTIN_FAMILIES)).toBe(true);
    expect(() => {
      (BUILTIN_FAMILIES as Record<string, string>)['claude'] = 'openai';
    }).toThrow();
  });
});

describe('R0-4 isCrossVendor', () => {
  it('不同厂商 true;相同 false', () => {
    expect(isCrossVendor('anthropic', 'openai')).toBe(true);
    expect(isCrossVendor('openai', 'openai')).toBe(false);
  });
  it('任一方 unknown 或空 → false(无法证明就不放行),两侧对称', () => {
    expect(isCrossVendor('unknown', 'openai')).toBe(false);
    expect(isCrossVendor('openai', 'unknown')).toBe(false);
    expect(isCrossVendor('unknown', 'unknown')).toBe(false);
    expect(isCrossVendor('', 'openai')).toBe(false);
    expect(isCrossVendor('openai', '  ')).toBe(false);
  });
  it('覆盖层追加的厂商不能当「不同厂商」的证据(真实厂商的模型可能被标成新厂商)', () => {
    expect(isCrossVendor('openai', 'mistral-ai')).toBe(false);
    expect(isCrossVendor('mistral-ai', 'anthropic')).toBe(false);
    expect(isCrossVendor('openai', 'anthropic')).toBe(true);
  });
  it('非规范形(大小写/空白/符号)一律不放行:不归一化,"看起来不同"不是证明', () => {
    expect(isCrossVendor('OpenAI', 'openai')).toBe(false);
    expect(isCrossVendor(' openai ', 'openai')).toBe(false);
    expect(isCrossVendor(' openai ', 'anthropic')).toBe(false);
    expect(isCrossVendor('OpenAI', 'anthropic')).toBe(false);
    expect(isCrossVendor('UNKNOWN', 'openai')).toBe(false);
    expect(isCrossVendor('open ai', 'anthropic')).toBe(false);
    expect(isCrossVendor('anthropic', 'openai\n')).toBe(false);
  });
});

describe('R0-4 覆盖层 vendor_overrides:只能追加新模型族', () => {
  it('追加新族(新厂商)可用,且对 pi 与 codex(非默认 provider)生效', () => {
    const ov = { mistral: 'mistral-ai' };
    expect(deriveVendor({ backend: 'pi', model: 'mistral-large' }, ov)).toBe('mistral-ai');
    expect(deriveVendor({ backend: 'codex', provider: 'x', model: 'mistral-large' }, ov)).toBe(
      'mistral-ai',
    );
    expect(deriveVendor({ backend: 'pi', model: 'mistral-large' })).toBe('unknown');
  });
  it('覆盖内置族(即使映射到同一厂商)→ CFG_VENDOR_OVERRIDE_DENIED', () => {
    for (const ov of <Record<string, string>[]>[
      { claude: 'openai' },
      { claude: 'anthropic' },
      { gpt: 'zhipu' },
      { o: 'x' },
    ]) {
      expect(() => assertVendorOverrides(ov)).toThrow(VendorOverrideDeniedError);
      expect(() => deriveVendor({ backend: 'pi', model: 'claude-x' }, ov)).toThrow(
        /CFG_VENDOR_OVERRIDE_DENIED/,
      );
    }
  });
  it('新家族不得映射到内置厂商或 unknown(防"制造不同厂商"与洗白 unknown)', () => {
    for (const ov of <Record<string, string>[]>[
      { foo: 'anthropic' },
      { foo: 'openai' },
      { foo: 'deepseek' },
      { foo: 'unknown' },
    ]) {
      expect(() => assertVendorOverrides(ov), JSON.stringify(ov)).toThrow(
        VendorOverrideDeniedError,
      );
    }
  });
  it('token/厂商 id 的格式被卡:大写、数字、空串、超长', () => {
    for (const ov of <Record<string, string>[]>[
      { Foo: 'x' },
      { f: 'x' },
      { 'foo-bar': 'x' },
      { foo1: 'x' },
      { foo: 'X' },
      { foo: '' },
    ]) {
      expect(() => assertVendorOverrides(ov), JSON.stringify(ov)).toThrow(
        VendorOverrideDeniedError,
      );
    }
    expect(() => assertVendorOverrides({ [`a${'b'.repeat(40)}`]: 'x' })).toThrow();
  });
  it('原型键不能借道(__proto__/constructor 不是内置族但也不是合法 token 以外的漏洞)', () => {
    const ov = JSON.parse('{"__proto__": "evilvendor"}') as Record<string, string>;
    expect(() => assertVendorOverrides(ov)).toThrow(VendorOverrideDeniedError);
    expect(deriveVendor({ backend: 'pi', model: 'constructor-1' })).toBe('unknown');
    expect(deriveVendor({ backend: 'pi', model: 'toString-1' })).toBe('unknown');
  });
});

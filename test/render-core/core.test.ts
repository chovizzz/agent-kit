import { describe, expect, it } from 'vitest';
import { RenderCoreError, renderAll } from '../../src/render/core.js';
import { createRegistry, defaultRegistry, RegistryError } from '../../src/render/registry.js';
import { emptyReport, mergeReports, reportToJson, reportToText } from '../../src/render/report.js';
import { applyOwnedHeader } from '../../src/render/owned-header.js';
import { renderManagedBlock } from '../../src/render/managed-block.js';
import { assertDeterministic, DeterminismError } from '../golden-harness/golden.js';
import { block, fakeAdapter, inputOf, out, owned, resolved } from './fixtures.js';
import type { Adapter } from '../../src/contracts/render.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof RenderCoreError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

const input = inputOf(resolved('rule-a'), resolved('rule-b', 'team'));

describe('renderAll', () => {
  const reg = createRegistry([
    fakeAdapter('pi', () => [owned('pi', 'b.md', 'B', ['rule-b'])]),
    fakeAdapter('claude', () => [
      owned('claude', 'z.md', 'Z\r\n\r\n', ['rule-a']),
      block('claude', 'AGENTS.md', 'org', 'rule a', ['rule-a']),
    ]),
  ]);

  it('默认注册表五个桩:空输出、可跑通', () => {
    expect(defaultRegistry.list().map((a) => a.agent)).toEqual([
      'claude',
      'codex',
      'pi',
      'kimi',
      'opencode',
    ]);
    expect(renderAll(input).files).toEqual([]);
  });

  it('规范化 + 独占头 + 字节序排序;managed-block 不加头', () => {
    const r = renderAll(input, reg);
    expect(r.files.map((f) => `${f.agent}/${f.relPath}`)).toEqual([
      'claude/z.md',
      'claude/AGENTS.md',
      'pi/b.md',
    ]);
    const z = r.files.find((f) => f.relPath === 'z.md');
    expect(z?.content).toBe('<!-- 生成文件,勿手改;源:agent-kit-core@1.2.3 -->\nZ\n');
    const agents = r.files.find((f) => f.relPath === 'AGENTS.md');
    expect(agents?.content).toBe(renderManagedBlock('org', 'rule a'));
    const pi = r.files.find((f) => f.relPath === 'b.md');
    expect(pi?.content.startsWith('<!-- 生成文件')).toBe(true);
  });

  it('注册顺序不影响结果;两次输出逐字节相同', () => {
    const a = renderAll(input, reg);
    const rev = createRegistry([...reg.list()].reverse());
    expect(JSON.stringify(renderAll(input, rev))).toBe(JSON.stringify(a));
    expect(rev.list().map((x) => x.agent)).toEqual(['claude', 'pi']);
    expect(() => assertDeterministic((i) => renderAll(i, reg), input)).not.toThrow();
  });

  it('personal / 未知原子进输出 ⇒ 抛错(正向对照:org 原子通过)', () => {
    const leak = createRegistry([fakeAdapter('pi', () => [owned('pi', 'a.md', 'x', ['pp'])])]);
    expect(codeOf(() => renderAll(inputOf(resolved('pp', 'personal', false)), leak))).toBe(
      'CORE_PERSONAL_LEAK',
    );
    expect(codeOf(() => renderAll(inputOf(resolved('pp', 'org', true)), leak))).toBeUndefined();
    expect(codeOf(() => renderAll(inputOf(), leak))).toBe('CORE_UNKNOWN_ATOM');
  });

  it('适配器产出别家文件 ⇒ 抛错;输出不符 schema ⇒ 抛错', () => {
    const wrong = createRegistry([fakeAdapter('pi', () => [owned('claude', 'a.md', 'x')])]);
    expect(codeOf(() => renderAll(input, wrong))).toBe('CORE_AGENT_MISMATCH');
    const bad: Adapter = {
      agent: 'pi',
      testedVersions: [],
      renderRules: () => ({ files: [{ nope: 1 }], report: emptyReport() }) as never,
    };
    expect(codeOf(() => renderAll(input, createRegistry([bad])))).toBe('CORE_BAD_OUTPUT');
  });

  it('managed-block 文件必须恰是一个 intact 块', () => {
    const mk = (content: string) =>
      createRegistry([fakeAdapter('pi', () => [{ ...block('pi', 'A.md', 'org', 'x'), content }])]);
    const good = renderManagedBlock('org', 'x');
    expect(codeOf(() => renderAll(input, mk(good)))).toBeUndefined();
    expect(codeOf(() => renderAll(input, mk(`前缀\n${good}`)))).toBe('CORE_BAD_MANAGED_BLOCK');
    expect(codeOf(() => renderAll(input, mk('没有块\n')))).toBe('CORE_BAD_MANAGED_BLOCK');
    expect(codeOf(() => renderAll(input, mk(good.replace('x\n', 'y\n'))))).toBe(
      'CORE_BAD_MANAGED_BLOCK',
    );
    expect(codeOf(() => renderAll(input, mk(`${good}${good}`)))).toBe('CORE_BAD_MANAGED_BLOCK');
    expect(codeOf(() => renderAll(input, mk(`\uFEFF${good}`)))).toBe('CORE_BAD_MANAGED_BLOCK');
  });

  it('managed-block 不能落在没有注释语法的文件(.json)上', () => {
    const reg2 = createRegistry([
      fakeAdapter('pi', () => [{ ...block('pi', 'x.json', 'org', 'x') }]),
    ]);
    expect(codeOf(() => renderAll(input, reg2))).toBe('CORE_BAD_MANAGED_BLOCK');
  });

  it('.json 不加头并记入 sideEffects;重复输出路径 ⇒ 抛错', () => {
    const r = renderAll(
      input,
      createRegistry([fakeAdapter('pi', () => [owned('pi', 'x.json', '{}')])]),
    );
    expect(r.files[0]?.content).toBe('{}\n');
    expect(r.report.sideEffects.some((s) => s.includes('x.json'))).toBe(true);
    const dup = createRegistry([
      fakeAdapter('pi', () => [owned('pi', 'a.md', 'x'), owned('pi', 'a.md', 'y')]),
    ]);
    expect(() => renderAll(input, dup)).toThrow();
  });

  it('适配器改动输入不影响后面的适配器', () => {
    const evil: Adapter = {
      agent: 'claude',
      testedVersions: [],
      renderRules: (i) => {
        (i.resolved as unknown[]).length = 0;
        return out([]);
      },
    };
    const after = createRegistry([
      evil,
      fakeAdapter('pi', (i) => [owned('pi', 'n.md', String(i.resolved.length))]),
    ]);
    expect(renderAll(input, after).files[0]?.content).toContain('\n2\n');
  });
});

describe('独占头', () => {
  it('幂等;旧版本头原位更新;frontmatter 之后;TOML 用 #;BOM 保留', () => {
    const once = applyOwnedHeader('# t\n', 'a.md', '1.0.0').content;
    expect(applyOwnedHeader(once, 'a.md', '1.0.0').content).toBe(once);
    expect(applyOwnedHeader(once, 'a.md', '2.0.0').content).toBe(
      '<!-- 生成文件,勿手改;源:agent-kit-core@2.0.0 -->\n# t\n',
    );
    const fm = applyOwnedHeader('---\npaths: x\n---\n正文\n', 'r.md', '1').content;
    expect(fm).toBe('---\npaths: x\n---\n<!-- 生成文件,勿手改;源:agent-kit-core@1 -->\n正文\n');
    expect(applyOwnedHeader(fm, 'r.md', '1').content).toBe(fm);
    expect(applyOwnedHeader('---\n没闭合\n', 'r.md', '1').content.startsWith('<!--')).toBe(true);
    expect(applyOwnedHeader('a = 1\n', 'x.toml', '1').content.startsWith('# 生成文件')).toBe(true);
    expect(applyOwnedHeader('\uFEFFa\n', 'x.md', '1').content.startsWith('\uFEFF<!--')).toBe(true);
    expect(applyOwnedHeader('{}\n', 'x.json', '1').applied).toBe(false);
    const user = '<!-- 生成文件,勿手改;源:agent-kit-core@1 --> 我自己写的\n';
    expect(applyOwnedHeader(user, 'a.md', '1').content.endsWith(`\n${user}`)).toBe(true);
    expect(() => applyOwnedHeader('a\n', 'a.md', '1 -->')).toThrow();
  });
});

describe('注册表与报告', () => {
  it('重复注册 / 未知 agent 抛错', () => {
    const a = fakeAdapter('pi', () => []);
    expect(() => createRegistry([a, a])).toThrow(RegistryError);
    expect(() => createRegistry([{ ...a, agent: 'nope' as never }])).toThrow(RegistryError);
  });

  it('mergeReports:去重、排序、与输入顺序无关;文本/JSON 可重复', () => {
    const r1 = { ...emptyReport(), sideEffects: ['b', 'a'], shadowChecks: ['s'] };
    const r2 = { ...emptyReport(), sideEffects: ['a', 'c'], shadowChecks: ['s'] };
    const m = mergeReports([r1, r2]);
    expect(m.sideEffects).toEqual(['a', 'b', 'c']);
    expect(m.shadowChecks).toEqual(['s']);
    expect(reportToJson(mergeReports([r2, r1]))).toBe(reportToJson(m));
    expect(reportToText(m)).toBe(reportToText(mergeReports([r2, r1])));
    expect(reportToText(emptyReport())).toContain('- 无');
  });
});

describe('确定性断言能抓住不确定的渲染', () => {
  it('计数器式不确定 ⇒ DeterminismError;确定的通过', () => {
    let n = 0;
    const flaky = () => out([owned('pi', 'a.md', `n=${(n += 1)}`)]);
    expect(() => assertDeterministic(flaky, input)).toThrow(DeterminismError);
    expect(() => assertDeterministic(() => out([owned('pi', 'a.md', 'k')]), input)).not.toThrow();
  });
});

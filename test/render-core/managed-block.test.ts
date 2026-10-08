import { describe, expect, it } from 'vitest';
import {
  ManagedBlockError,
  applyManagedBlock,
  inspectManagedBlock,
  outsideContent,
  renderManagedBlock,
  sha256Hex,
} from '../../src/render/managed-block.js';

const refuse = { onDrift: 'refuse' } as const;
const overwrite = { onDrift: 'overwrite' } as const;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ManagedBlockError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

describe('托管块:三态', () => {
  it('文件不存在 ⇒ 只含块', () => {
    const r = applyManagedBlock(undefined, 'org', '规则一', refuse);
    expect(r.action).toBe('created');
    expect(r.content).toBe(renderManagedBlock('org', '规则一'));
    expect(r.content.startsWith('<!-- agent-kit:begin id=org sha256=')).toBe(true);
    expect(r.content.endsWith('<!-- agent-kit:end -->\n')).toBe(true);
  });

  it('文件存在但无标记 ⇒ 原文逐字节保留,末尾追加', () => {
    const orig = '# 我的笔记\n\n手写内容  \n';
    const r = applyManagedBlock(orig, 'org', '规则一', refuse);
    expect(r.action).toBe('appended');
    expect(r.content.startsWith(orig)).toBe(true);
    expect(outsideContent(r.content)).toBe(`${orig}\n`);
  });

  it('空文件(如 Codex 的 0 字节 AGENTS.md)⇒ 只含块', () => {
    expect(applyManagedBlock('', 'org', 'x', refuse).content).toBe(renderManagedBlock('org', 'x'));
  });

  it('原文末尾无换行 / 已有空行都能正确隔开', () => {
    expect(applyManagedBlock('abc', 'org', 'x', refuse).content.startsWith('abc\n\n<!--')).toBe(
      true,
    );
    expect(applyManagedBlock('abc\n\n', 'org', 'x', refuse).content.startsWith('abc\n\n<!--')).toBe(
      true,
    );
  });

  it('intact:只替换块,块前后字节不变', () => {
    const before = '前言\r\n  缩进\n';
    const after = '\n后记没有换行';
    const v1 = `${before}${renderManagedBlock('org', '旧')}${after}`;
    const r = applyManagedBlock(v1, 'org', '新', refuse);
    expect(r.action).toBe('replaced');
    expect(r.content).toBe(`${before}${renderManagedBlock('org', '新')}${after}`);
  });

  it('幂等:同内容再 apply 不变且 changed=false', () => {
    const once = applyManagedBlock('hello\n', 'org', 'x', refuse);
    const twice = applyManagedBlock(once.content, 'org', 'x', refuse);
    expect(twice.content).toBe(once.content);
    expect(twice.changed).toBe(false);
    expect(twice.action).toBe('unchanged');
  });

  it('内容变化 ⇒ sha256 随之更新', () => {
    const b = applyManagedBlock(renderManagedBlock('org', 'A'), 'org', 'B', refuse).content;
    expect(b).toContain(`sha256=${sha256Hex('B\n')}`);
    expect(b).not.toContain(sha256Hex('A\n'));
  });

  it('空体合法,sha 为空串的 sha256', () => {
    const e = renderManagedBlock('org', '');
    expect(e).toBe(
      `<!-- agent-kit:begin id=org sha256=${sha256Hex('')} -->\n<!-- agent-kit:end -->\n`,
    );
    expect(inspectManagedBlock(e, 'org').state).toBe('intact');
  });

  it('BOM 在块外保留', () => {
    const v = `\uFEFF头\n${renderManagedBlock('org', 'a')}`;
    expect(applyManagedBlock(v, 'org', 'b', refuse).content.startsWith('\uFEFF头\n')).toBe(true);
    const only = `\uFEFF${renderManagedBlock('org', 'a')}`;
    expect(inspectManagedBlock(only, 'org').state).toBe('intact');
    expect(applyManagedBlock(only, 'org', 'b', refuse).content.startsWith('\uFEFF<!--')).toBe(true);
  });

  it('end 行后无换行:替换后补上换行', () => {
    const v = renderManagedBlock('org', 'a').replace(/\n$/, '');
    expect(applyManagedBlock(v, 'org', 'b', refuse).content).toBe(renderManagedBlock('org', 'b'));
  });
});

describe('托管块:块外内容不被覆盖(往返)', () => {
  it('其它 id 的块视为块外内容,原样保留', () => {
    const both = applyManagedBlock(
      applyManagedBlock(undefined, 'org', 'O', refuse).content,
      'team',
      'T',
      refuse,
    ).content;
    expect(inspectManagedBlock(both, 'team').state).toBe('intact');
    const upd = applyManagedBlock(both, 'org', 'O2', refuse).content;
    expect(upd).toContain(renderManagedBlock('team', 'T'));
    expect(upd).toContain(renderManagedBlock('org', 'O2'));
    expect(inspectManagedBlock(`x\n${renderManagedBlock('team', 'T')}`, 'org')).toEqual({
      state: 'block-missing',
      foreignIds: ['team'],
    });
  });

  it('固定种子的随机块外内容:apply 后块外内容恒等', () => {
    let seed = 20261008;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pieces = ['plain', '\n', '  ', '\r\n', '# h', '中文', '<!-- other -->', '\t'];
    const rand = (): string =>
      Array.from({ length: rnd(12) }, () => pieces[rnd(pieces.length)]).join('');
    for (let i = 0; i < 200; i += 1) {
      const pre = rand();
      const post = rand();
      const v1 = `${pre}\n${renderManagedBlock('org', `body${i}`)}${post}`;
      const v2 = applyManagedBlock(v1, 'org', `new${i}`, refuse).content;
      expect(outsideContent(v2)).toBe(outsideContent(v1));
      expect(v2.startsWith(`${pre}\n`)).toBe(true);
      expect(v2.endsWith(post)).toBe(true);
      expect(applyManagedBlock(v2, 'org', `new${i}`, refuse).changed).toBe(false);
    }
  });
});

describe('托管块:漂移(块体被手改)', () => {
  const good = renderManagedBlock('org', '原文');
  const edited = good.replace('原文', '原文被人改了');

  it('可检测:状态为 drifted,sha 不符;未改时为 intact', () => {
    const r = inspectManagedBlock(edited, 'org');
    expect(r.state).toBe('drifted');
    if (r.state === 'drifted') expect(r.block.storedSha).not.toBe(r.block.actualSha);
    expect(inspectManagedBlock(good, 'org').state).toBe('intact');
  });

  it('refuse 抛 DRIFTED;overwrite 覆盖并标记', () => {
    expect(codeOf(() => applyManagedBlock(edited, 'org', '原文', refuse))).toBe('DRIFTED');
    const r = applyManagedBlock(edited, 'org', '原文', overwrite);
    expect(r.content).toBe(good);
    expect(r.overwroteDrift).toBe(true);
  });

  it('块外被手改不算漂移,且不被覆盖', () => {
    const v = `手改在前\n${good}手改在后\n`;
    expect(inspectManagedBlock(v, 'org').state).toBe('intact');
    const r = applyManagedBlock(v, 'org', '新', refuse);
    expect(r.content.startsWith('手改在前\n')).toBe(true);
    expect(r.content.endsWith('手改在后\n')).toBe(true);
  });
});

describe('托管块:标记损坏 ⇒ 拒绝,绝不追加', () => {
  const b = renderManagedBlock('org', 'x');
  const cases: [string, string, string][] = [
    ['只有 begin', b.replace('<!-- agent-kit:end -->\n', ''), 'BEGIN_WITHOUT_END'],
    ['只有 end', b.split('\n').slice(1).join('\n'), 'END_WITHOUT_BEGIN'],
    ['end 在 begin 之前', `<!-- agent-kit:end -->\n${b}`, 'END_WITHOUT_BEGIN'],
    ['嵌套 begin', b.replace('x\n', `x\n${b.split('\n')[0]}\n`), 'BEGIN_NESTED'],
    ['同 id 重复', `${b}${b}`, 'DUPLICATE_ID'],
    ['sha 非 64 位', b.replace(/sha256=[0-9a-f]{64}/, 'sha256=abc'), 'MARKER_MALFORMED'],
    ['标记缩进', ` ${b}`, 'MARKER_MALFORMED'],
    ['CRLF 标记行', b.replace(/\n/g, '\r\n'), 'MARKER_MALFORMED'],
    ['end 被改写', b.replace('agent-kit:end', 'agent-kit:end  x'), 'MARKER_MALFORMED'],
  ];
  for (const [name, text, code] of cases) {
    it(name, () => {
      expect(inspectManagedBlock(text, 'org').state).toBe('corrupt');
      expect(codeOf(() => applyManagedBlock(text, 'org', 'y', overwrite))).toBe(code);
    });
  }

  it('块体含标记行 / id 非法 ⇒ 渲染时拒绝', () => {
    expect(codeOf(() => renderManagedBlock('org', `a\n${b}`))).toBe('BODY_CONTAINS_MARKER');
    expect(codeOf(() => renderManagedBlock('Bad_Id', 'a'))).toBe('INVALID_ID');
  });
});

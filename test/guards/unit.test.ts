import { describe, expect, it } from 'vitest';
import { unsafePathDiagnostics } from '../../src/guards/diff.js';
import {
  ALLOWED_TRANSITIONS,
  GUARD_LABELS,
  parseLabel,
  pendingCriteria,
} from '../../src/guards/labels.js';
import { isAtomPath, isRegularMode, isUnsafePath } from '../../src/guards/paths.js';
import { changedKeys, deepEqual } from '../../src/guards/view.js';
import type { Change } from '../../src/guards/types.js';

describe('labels', () => {
  it('四个已知标签精确匹配;未知、大小写不同、带空白都拒绝;缺省 = 无标签', () => {
    for (const l of GUARD_LABELS) expect(parseLabel(l)).toEqual({ ok: true, label: l });
    expect(parseLabel(undefined)).toEqual({ ok: true, label: undefined });
    for (const bad of [
      '',
      'Kit:Promotion',
      ' kit:retire',
      'kit:promotion ',
      'promotion',
      'kit:other',
    ]) {
      const r = parseLabel(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.diagnostic.code).toBe('GUARD_LABEL_UNKNOWN');
    }
  });

  it('转移白名单与设计 §5.2 逐条一致', () => {
    expect(ALLOWED_TRANSITIONS['kit:promotion']).toEqual([
      ['proposed', 'advisory'],
      ['advisory', 'active'],
    ]);
    expect(ALLOWED_TRANSITIONS['kit:retire']).toEqual([
      ['advisory', 'deprecated'],
      ['active', 'deprecated'],
      ['deprecated', 'retired'],
    ]);
  });

  it('判据桩一律不通过(不是静默放行)', () => {
    const d = pendingCriteria({
      label: 'kit:promotion',
      path: 'rules/a/b.md',
      from: 'proposed',
      to: 'advisory',
    });
    expect(d).toHaveLength(1);
    expect(d[0]?.severity).toBe('error');
    expect(d[0]?.code).toBe('GUARD_G3_CRITERIA_NOT_IMPLEMENTED');
  });
});

describe('paths', () => {
  it('原子路径谓词:宽于 lint(任意深度、大小写不敏感),但只认 .md', () => {
    for (const p of [
      'rules/a/b.md',
      'rules/b.md',
      'rules/a/b/c.md',
      '.kit/rules/x/y.md',
      'Rules/a/b.MD',
      '.KIT/RULES/a.md',
    ]) {
      expect(isAtomPath(p), p).toBe(true);
    }
    for (const p of [
      'rules/a/b.txt',
      'docs/rules/a.md',
      'skills/x/SKILL.md',
      'rulesets/a.md',
      'attest/a.md',
    ]) {
      expect(isAtomPath(p), p).toBe(false);
    }
  });

  it('不安全路径 / 普通文件 mode', () => {
    for (const p of ['', 'a//b', './a', 'a/../b', 'a\\b', 'a/./b', 'a/'])
      expect(isUnsafePath(p), p).toBe(true);
    for (const p of ['a', 'a/b', '.github/x', 'rules/a b.md'])
      expect(isUnsafePath(p), p).toBe(false);
    expect(isRegularMode('100644')).toBe(true);
    expect(isRegularMode('100755')).toBe(true);
    for (const m of ['120000', '160000', '040000', '000000'])
      expect(isRegularMode(m), m).toBe(false);
  });

  it('unsafePathDiagnostics 对手工构造的树逐条报错', () => {
    const mk = (path: string): Change => ({
      kind: 'A',
      path,
      baseMode: '000000',
      headMode: '100644',
      baseOid: '0'.repeat(40),
      headOid: 'a'.repeat(40),
    });
    expect(
      unsafePathDiagnostics([mk('rules/a/b.md'), mk('rules/../hooks/x'), mk('a\\b')]).map(
        (d) => d.path,
      ),
    ).toEqual(['rules/../hooks/x', 'a\\b']);
  });
});

describe('view', () => {
  it('deepEqual / changedKeys:嵌套、顺序、NaN、缺失键', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(deepEqual(0, -0)).toBe(false);
    expect(deepEqual({ a: undefined }, {})).toBe(false);
    expect(changedKeys({ a: 1, b: [1], c: 3 }, { a: 1, b: [2], d: 4 })).toEqual(['b', 'c', 'd']);
    expect(changedKeys({ a: null }, { a: null })).toEqual([]);
  });
});

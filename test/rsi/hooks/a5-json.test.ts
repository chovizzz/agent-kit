/**
 * A5:严格 JSON、格式保真闸与计划 / 重新生成(contracts R20-15.15–15.17)的纯函数单测。
 * 核心不变量:`renderAfter(形状, 计划.ops, 写前字节)` 必须逐字节等于计划里算出的写后字节——hooksApply 不收调用方的全文,靠它重新生成。
 */
import { describe, expect, it } from 'vitest';
import { PRODUCTION_SHAPES, type JsonMergeShape } from '../../../src/contracts/rsi-hooks.js';
import { allJsonSpecs, sha256Hex } from '../../../src/rsi/hooks/entries.js';
import {
  canonicalFormat,
  hasDuplicateKeys,
  parseStrictJson,
  serializeJson,
} from '../../../src/rsi/hooks/json-strict.js';
import { computePlan, renderAfter } from '../../../src/rsi/hooks/plan.js';
import { SENTINEL, canon, userSettings } from './a5-fixture.js';

describe('重复键检测', () => {
  const dup: [string, boolean][] = [
    ['{"a":1,"a":2}', true],
    ['{"a":1,"b":{"c":1,"c":2}}', true],
    ['{"a":{"a":1},"b":[{"a":1},{"a":2}]}', false],
    ['{"a":"x\\",\\"a\\":1"}', false], // 字符串值里的引号与键样子的片段
    ['{"a\\"b":1,"a\\"b":2}', true], // 带转义的键
    ['{"\\u0061":1,"a":2}', true], // 转义后相同的键
    ['[{"a":1},{"a":1}]', false],
    ['{"a":[1,{"b":1,"b":2}]}', true],
    ['{"__proto__":1,"__proto__":2}', true],
    ['{}', false],
  ];
  for (const [text, expected] of dup) {
    it(`${text} → ${expected}`, () => {
      JSON.parse(text); // 前提:语法合法
      expect(hasDuplicateKeys(text)).toBe(expected);
    });
  }
});

describe('parseStrictJson / canonicalFormat', () => {
  it('拒绝 非 UTF-8 / BOM / 注释 / 尾逗号 / 重复键', () => {
    expect(parseStrictJson(Buffer.from([0x7b, 0xff, 0x7d]))).toEqual({
      ok: false,
      reason: 'not_utf8',
    });
    expect(parseStrictJson(Buffer.from('﻿{}'))).toEqual({ ok: false, reason: 'syntax' });
    expect(parseStrictJson(Buffer.from('{ /* c */ }'))).toEqual({ ok: false, reason: 'syntax' });
    expect(parseStrictJson(Buffer.from('{"a":1,}'))).toEqual({ ok: false, reason: 'syntax' });
    expect(parseStrictJson(Buffer.from('{"a":1,"a":2}'))).toEqual({
      ok: false,
      reason: 'duplicate_key',
    });
    expect(parseStrictJson(Buffer.from('{"a":1}'))).toMatchObject({ ok: true });
  });

  it('格式保真闸:去掉一个末尾换行后逐字等于 JSON.stringify(parse, null, 2)', () => {
    const v = { a: [1, 2], b: { c: 'x' } };
    const t = JSON.stringify(v, null, 2);
    expect(canonicalFormat(t, v)).toEqual({ ok: true, trailingNewline: false });
    expect(canonicalFormat(`${t}\n`, v)).toEqual({ ok: true, trailingNewline: true });
    expect(canonicalFormat(`${t}\n\n`, v)).toEqual({ ok: false });
    expect(canonicalFormat(JSON.stringify(v), v)).toEqual({ ok: false });
    expect(canonicalFormat(t.replace(/\n/g, '\r\n'), v)).toEqual({ ok: false });
    expect(canonicalFormat('{"n":1e3}', { n: 1000 })).toEqual({ ok: false }); // 数字写法也要保真
    // 序列化保留有无末尾换行
    expect(serializeJson(v, false).toString()).toBe(t);
    expect(serializeJson(v, true).toString()).toBe(`${t}\n`);
  });
});

describe('计划 ⇄ renderAfter(hooksApply 的重新生成)', () => {
  const claude = PRODUCTION_SHAPES.claude as JsonMergeShape;
  const base = {
    shape: claude,
    variant: 'plain' as const,
    owned: [],
    pathDisplay: '~/.claude/settings.json',
    local: 'none' as const,
  };

  for (const [name, before] of [
    ['文件不存在', null],
    ['{}', Buffer.from('{}\n')],
    ['用户配置', Buffer.from(userSettings())],
    ['无末尾换行', Buffer.from(canon({ model: 'x' }, false))],
  ] as const) {
    it(`安装:${name} —— 计划的写后字节 == renderAfter(ops, 写前字节);写后哈希 == 字节哈希`, () => {
      const c = computePlan({ ...base, kind: 'install', before });
      expect(c.ok).toBe(true);
      if (!c.ok) return;
      expect(c.plan.ops).toHaveLength(2);
      const r = renderAfter(claude, c.plan.ops, before);
      expect(r).not.toBeNull();
      expect(r?.bytes?.equals(c.after.bytes as Buffer)).toBe(true);
      expect(c.after.sha256).toBe(sha256Hex(c.after.bytes as Buffer));
      expect(r?.sha256).toBe(c.after.sha256);
      // 计划自带的写前哈希
      expect(c.plan.before_sha256).toBe(before === null ? null : sha256Hex(before));
      expect(c.plan.before_exists).toBe(before !== null);
    });
  }

  it('卸载:renderAfter 与计划一致;ops 对不上(指纹被换)→ null,不写', () => {
    const inst = computePlan({ ...base, kind: 'install', before: Buffer.from(userSettings()) });
    if (!inst.ok) throw new Error('install plan');
    const entries = inst.added.map((a) => ({ ...a, txn_id: '20261102T120000Z-0000000000000001' }));
    const un = computePlan({
      ...base,
      kind: 'uninstall',
      before: inst.after.bytes,
      owned: entries,
    });
    expect(un.ok).toBe(true);
    if (!un.ok) return;
    const r = renderAfter(claude, un.plan.ops, inst.after.bytes);
    expect(r?.bytes?.equals(un.after.bytes as Buffer)).toBe(true);
    const bogus = un.plan.ops.map((o) => ({ ...o, entry_fingerprint: 'f'.repeat(64) }));
    expect(renderAfter(claude, bogus, inst.after.bytes)).toBeNull();
    // 写前字节变了(不再规范)→ null
    expect(renderAfter(claude, un.plan.ops, Buffer.from('{"a":1}'))).toBeNull();
  });

  it('指纹:完整条目(事件 + 包装对象的全部字段),不同事件的同一包装指纹不同;全表无冲突', () => {
    const specs = allJsonSpecs(claude);
    const key = (s: (typeof specs)[number]): string => `${s.event}|${s.fingerprint}`;
    expect(new Set(specs.map(key)).size).toBe(3); // 普通 hint、canary hint、poke(两个变体共用)
    const poke = specs.filter((s) => s.event === 'SessionEnd');
    // poke 在 plain / canary 两个变体里是同一个条目:同指纹
    expect(new Set(poke.map((s) => s.fingerprint)).size).toBe(1);
    const hints = specs.filter((s) => s.event === 'SessionStart');
    expect(new Set(hints.map((s) => s.fingerprint)).size).toBe(2);
  });

  it('隐私:计划与错误里不带配置内容(哨兵)', () => {
    const c = computePlan({
      ...base,
      kind: 'install',
      before: Buffer.from(canon({ k: SENTINEL, hooks: { SessionStart: [1] } })),
    });
    expect(c).toEqual({ ok: false, reason: 'config_shape_unsupported' });
  });
});

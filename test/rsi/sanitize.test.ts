/**
 * R20-A2 B3a:输出清洗与泄漏闸(R20-3.5.2 / 3.5.3 / 3.5.6)。
 */
import { describe, expect, it, vi } from 'vitest';
import { forbiddenPaths } from '../../src/rsi/output.js';
import { cleanName, cleanPath, guardOutput, renderLine } from '../../src/rsi/sanitize.js';

describe('R20-3.5.2 cleanName / cleanPath', () => {
  it('C0 / C1 控制字符、格式字符(bidi 覆盖与隔离、零宽)、私用区、未分配码点、行 / 段分隔符 → ?', () => {
    const bad = [
      '\u0000',
      '\u001f',
      '\u007f',
      '\u0085',
      '‮', // RLO
      '⁦', // LRI
      '​', // ZWSP
      '‍', // ZWJ
      '﻿', // BOM
      '', // 私用区
      '͸', // 未分配
      ' ',
      ' ',
    ];
    for (const ch of bad) {
      expect(cleanName(`a${ch}b`), JSON.stringify(ch)).toBe('a?b');
      expect(cleanPath(`/a${ch}b`)).toBe('/a?b');
    }
    expect(cleanName('a\ud800b')).toBe('a?b'); // 孤立代理
    expect(cleanName('正常 name-1_2.x')).toBe('正常 name-1_2.x');
  });

  it('按码点边界截到 64 字节(不切断多字节字符 / 代理对);空串 → ?;cleanPath 不截断', () => {
    expect(cleanName('a'.repeat(100))).toBe('a'.repeat(64));
    expect(cleanName('中'.repeat(30))).toBe('中'.repeat(21)); // 63 字节
    expect(cleanName('😀'.repeat(30))).toBe('😀'.repeat(16)); // 64 字节
    expect(Buffer.byteLength(cleanName('é'.repeat(100)))).toBeLessThanOrEqual(64);
    expect(cleanName('')).toBe('?');
    expect(cleanPath(`/${'a'.repeat(5000)}`).length).toBe(5001);
  });
});

describe('R20-3.5.6 guardOutput', () => {
  const FORBID = ['/home/u', '/tmp/kit', '/repo/.state', '/repo'];

  it('head 含任一禁止值 → 不 ok;不含 → ok;长度 ≤ 1 的禁止值(如 /)被忽略', () => {
    expect(guardOutput([{ head: 'state=armed' }], FORBID).ok).toBe(true);
    for (const f of FORBID) expect(guardOutput([{ head: `x ${f}/y` }], FORBID).ok, f).toBe(false);
    expect(guardOutput([{ head: 'a/b/c' }], ['/']).ok).toBe(true);
    expect(guardOutput([{ head: 'a' }], ['']).ok).toBe(true);
  });

  it('豁免只限 pathValue:同样的文本放进 head → 不 ok;放进 pathValue → ok;pathValue 含换行 → 不 ok', () => {
    expect(guardOutput([{ head: 'key=1 name=a', pathValue: '/repo/sub' }], FORBID).ok).toBe(true);
    expect(guardOutput([{ head: 'key=1 name=a path=/repo/sub' }], FORBID).ok).toBe(false);
    // 「伪造 path=」:head 里自带 path=,后面真的有 pathValue,head 部分仍然要过闸
    expect(guardOutput([{ head: 'name=x path=/repo', pathValue: '/repo/ok' }], FORBID).ok).toBe(
      false,
    );
    expect(guardOutput([{ head: 'k', pathValue: '/repo/a\n/home/u' }], FORBID).ok).toBe(false);
  });

  it('清洗后与 JSON 转义后的表示同样命中', () => {
    const odd = '/tmp/we"ird\\dir‮/x';
    expect(guardOutput([{ head: `"p": ${JSON.stringify(odd)}` }], [odd]).ok).toBe(false); // JSON 转义
    expect(guardOutput([{ head: cleanPath(odd) }], [odd]).ok).toBe(false); // 清洗后
    expect(guardOutput([{ head: odd }], [odd]).ok).toBe(false); // 原样
  });

  it('组合变换:先清洗再 JSON 转义、先转义再清洗的最终文本同样命中', () => {
    const forbidden = '/tmp/a"b\u202e/c';
    const cleanThenJson = JSON.stringify({ x: cleanPath(forbidden) }); // 引号已转义、bidi 已变 ?
    expect(cleanThenJson).not.toContain(forbidden);
    expect(guardOutput([{ head: cleanThenJson }], [forbidden]).ok).toBe(false);
    const jsonThenClean = cleanPath(JSON.stringify({ x: forbidden }));
    expect(guardOutput([{ head: jsonThenClean }], [forbidden]).ok).toBe(false);
    // 对照:无关内容不误报
    expect(guardOutput([{ head: JSON.stringify({ x: '/tmp/other' }) }], [forbidden]).ok).toBe(true);
  });

  it('控制字符(换行、ESC、其它 C0 / C1)与 U+2028 / U+2029 出现在 head 或 pathValue 里 → 不 ok;普通文本照常', () => {
    for (const ch of ['\n', '\r', '\u001b', '\u0000', '\u0085', '\u2028', '\u2029', '\t']) {
      expect(guardOutput([{ head: `a${ch}b` }], []).ok, JSON.stringify(ch)).toBe(false);
      expect(guardOutput([{ head: 'k', pathValue: `/x${ch}y` }], []).ok).toBe(false);
    }
    expect(guardOutput([{ head: 'state=armed 中文 name-1' }], []).ok).toBe(true);
  });

  it('renderLine:有 pathValue 时整行 = head + " path=" + pathValue', () => {
    expect(renderLine({ head: 'a b' })).toBe('a b');
    expect(renderLine({ head: 'a b', pathValue: '/x' })).toBe('a b path=/x');
  });
});

describe('forbiddenPaths:没注入 env 时取真实进程环境里的 KIT_TMP(与配置 / 上下文一致)', () => {
  it('注入 env → 用注入的 KIT_TMP;不注入 → 用 process 的;两者都含 HOME 与额外路径', async () => {
    const injected = await forbiddenPaths(
      { KIT_TMP: '/inj/tmp', KIT_REAL_HOME_OVERRIDE: '/inj/home' },
      ['/extra/state'],
    );
    expect(injected).toEqual(expect.arrayContaining(['/inj/tmp', '/inj/home', '/extra/state']));
    vi.stubEnv('KIT_TMP', '/proc/env/tmp');
    try {
      const real = await forbiddenPaths(undefined, []);
      expect(real).toContain('/proc/env/tmp');
    } finally {
      vi.unstubAllEnvs();
    }
    // 对照:注入了 env 就不再看真实环境
    vi.stubEnv('KIT_TMP', '/proc/env/tmp');
    try {
      expect(await forbiddenPaths({ KIT_REAL_HOME_OVERRIDE: '/inj/home' }, [])).not.toContain(
        '/proc/env/tmp',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

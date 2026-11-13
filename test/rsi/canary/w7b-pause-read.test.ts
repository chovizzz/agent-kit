/**
 * W7b / W0-21:hint 读集合 = `AUTO_PAUSE`(U,用户)+ `AUTO_PAUSE_BREAKER`(B,worker 熔断)。
 * 任一 present → present;否则任一非 ENOENT 失败 → unreadable;都 ENOENT → absent(确证原因优先于 unknown)。
 * 3×3 矩阵用纯函数钉住(同目录下让一个兄弟 lstat 失败、另一个成功在真文件系统里做不到);真文件只测 present / absent / 整个目录不可读。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as safe from '../../../src/io/safe-fs.js';
import {
  combinePauseReads,
  makePermitPort,
  readPauseAny,
  type PauseRead,
} from '../../../src/rsi/canary/permit-read.js';
import { makeCanaryWorld } from './w5-fixture.js';

const ALL: readonly PauseRead[] = ['absent', 'present', 'unreadable'];

describe('combinePauseReads:3×3 矩阵', () => {
  const expected = (u: PauseRead, b: PauseRead): PauseRead =>
    u === 'present' || b === 'present'
      ? 'present'
      : u === 'unreadable' || b === 'unreadable'
        ? 'unreadable'
        : 'absent';
  for (const u of ALL) {
    for (const b of ALL) {
      it(`U=${u} B=${b} → ${expected(u, b)}`, () => {
        expect(combinePauseReads(u, b)).toBe(expected(u, b));
      });
    }
  }
  it('负向:U 读失败而 B 在 → present(不是 unreadable);B 读失败而 U 在 → present;只一个读失败而另一个不在 → unreadable(不是 absent)', () => {
    expect(combinePauseReads('unreadable', 'present')).toBe('present');
    expect(combinePauseReads('present', 'unreadable')).toBe('present');
    expect(combinePauseReads('unreadable', 'absent')).toBe('unreadable');
    expect(combinePauseReads('absent', 'unreadable')).toBe('unreadable');
  });
});

describe('真文件读集合', () => {
  it('只有 B → present;只有 U → present;都没有 → absent;两个都在 → present', async () => {
    const w = await makeCanaryWorld('w7b-read-a-');
    expect(await readPauseAny(w.rsi)).toBe('absent');
    await safe.writeFile(w.io, path.join(w.rsi, 'AUTO_PAUSE_BREAKER'), '', { mode: 0o600 });
    expect(await readPauseAny(w.rsi)).toBe('present');
    await safe.writeFile(w.io, path.join(w.rsi, 'AUTO_PAUSE'), '', { mode: 0o600 });
    expect(await readPauseAny(w.rsi)).toBe('present');
    await safe.remove(w.io, path.join(w.rsi, 'AUTO_PAUSE_BREAKER'));
    expect(await makePermitPort(w.rsi, w.home).pause()).toBe('present'); // 只剩 U
  });

  it('rsi 目录本身读不了(路径下面是普通文件 → ENOTDIR,非 ENOENT)→ unreadable,不冒充 absent', async () => {
    const w = await makeCanaryWorld('w7b-read-b-');
    const bogus = path.join(w.rsi, 'canary.json');
    await safe.writeFile(w.io, bogus, '{}', { mode: 0o600 });
    expect(await readPauseAny(bogus)).toBe('unreadable');
  });
});

/**
 * D4 静态闭包:读侧(pending / pending-converted)只读;view 构造是纯函数;冷却纯逻辑不拖进候选源与写出口。
 * 判据与 `readonly-zero-write.test.ts` ③ 同源(闭包 + AST 标识符),每条都带正向对照(同一断言能报出真实的写依赖)。
 */
import { describe, expect, it } from 'vitest';
import { closureOf, externalSpecs, identHits, importersOf } from '../closure-util.js';

const WRITE_FILES = [
  'src/io/safe-fs.ts',
  'src/io/home-fs.ts',
  'src/io/exec.ts',
  'src/io/llm-exec.ts',
  'src/io/net.ts',
  'src/rsi/lock.ts',
  'src/rsi/snapshot.ts',
  'src/rsi/with-lock.ts',
  'src/rsi/rsi-dir.ts',
  'src/rsi/services/commit.ts',
  'src/rsi/services/taint.ts',
  'src/rsi/services/immediate-gate.ts',
  'src/signals/state-store.ts',
];
const WRITE_IDENTS = [
  'acquireRsiLock',
  'withRsiLock',
  'createExclusive',
  'appendFile',
  'mkdirp',
  'runSync',
  'runSelf',
  'writeRsiFileAtomic',
];
const ALLOWED_EXTERNALS = [
  'node:crypto',
  'node:fs',
  'node:fs/promises',
  'node:os',
  'node:path',
  'smol-toml',
  'zod',
];

describe('D4 静态:A6 读侧只读(pending.ts 闭包含新的 pending-converted.ts)', () => {
  for (const includeTypes of [false, true]) {
    it(`pending.ts / pending-converted.ts(${includeTypes ? '含类型依赖' : '运行时依赖'}):不含写出口 / 锁 / 子进程,无写标识符,无动态 import,node:fs 只由 read-fs.ts 引入`, () => {
      for (const entry of ['src/rsi/pending.ts', 'src/rsi/pending-converted.ts']) {
        const c = closureOf([entry], { includeTypes });
        expect(
          [...c.files].filter((f) => WRITE_FILES.includes(f)),
          entry,
        ).toEqual([]);
        expect(identHits(c, WRITE_IDENTS), entry).toEqual([]);
        expect(c.dynamic, entry).toEqual([]);
        expect(c.unresolved, entry).toEqual([]);
        expect(
          externalSpecs(c).filter((e) => !ALLOWED_EXTERNALS.includes(e)),
          entry,
        ).toEqual([]);
        expect(importersOf(c, 'node:fs'), entry).toEqual(['src/io/read-fs.ts']);
      }
      expect(
        closureOf(['src/rsi/pending.ts'], { includeTypes }).files.has(
          'src/rsi/pending-converted.ts',
        ),
      ).toBe(true);
    });
  }

  it('对照:写端口 view-write.ts 的闭包含 safe-fs 与写标识符(上面的断言确实能报出写依赖)', () => {
    const c = closureOf(['src/rsi/personal/view-write.ts']);
    expect(c.files.has('src/io/safe-fs.ts')).toBe(true);
    expect(identHits(c, WRITE_IDENTS).length).toBeGreaterThan(0);
  });
});

describe('D4 静态:view 构造是纯函数;冷却纯逻辑不依赖候选源', () => {
  it('view-build.ts 的闭包(含类型)没有写出口 / 锁 / 子进程,无写标识符,外部依赖只有 zod / crypto / path', () => {
    for (const includeTypes of [false, true]) {
      const c = closureOf(['src/rsi/personal/view-build.ts'], { includeTypes });
      expect([...c.files].filter((f) => WRITE_FILES.includes(f))).toEqual([]);
      expect(identHits(c, WRITE_IDENTS)).toEqual([]);
      expect(
        externalSpecs(c).filter((e) => !['zod', 'node:crypto', 'node:path'].includes(e)),
      ).toEqual([]);
      expect(c.dynamic).toEqual([]);
      expect(c.unresolved).toEqual([]);
    }
  });

  it('digest-cooldown.ts 与 digest.ts 的闭包不含候选源(clusterId 由装配处注入)与写出口之外的新依赖', () => {
    const cool = closureOf(['src/rsi/digest-cooldown.ts'], { includeTypes: true });
    expect([...cool.files].filter((f) => WRITE_FILES.includes(f))).toEqual([]);
    expect(cool.files.has('src/rsi/personal/candidate-source.ts')).toBe(false);
    const dg = closureOf(['src/rsi/digest.ts'], { includeTypes: true });
    expect(dg.files.has('src/rsi/digest-cooldown.ts')).toBe(true);
    expect(dg.files.has('src/rsi/personal/candidate-source.ts')).toBe(false);
  });
});

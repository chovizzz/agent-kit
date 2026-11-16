/**
 * B1a:**生产惰性**的证明(设计稿 v3 §D.8 / §F ⑧)——B1a 合并后,没有任何生产入口首次写账 / 写审计 / 写压缩文件:
 *  ① 生产入口的运行时 import 闭包不含 `src/rsi/store/**`(没有装配,就没有写者);
 *  ② `older_build_has_no_writer`:`src/rsi/store/**` 与契约文件之外,没有对三个文件名的写调用(读者 deps.ts / report.ts / ports.ts 只读);
 *  ③ 相位常量仍为 0,W8 写命令全被相位闸挡在桩之前。
 * 每条都有正向对照(虚拟入口 import 存储核时同一检查必须变红)。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RSI_AUTO_PHASE } from '../../../src/contracts/rsi.js';
import { existsSync, readDir, readTextSync } from '../../../src/io/read-fs.js';
import { ROOT, closureOf } from '../closure-util.js';

vi.setConfig({ testTimeout: 120_000 });

/**
 * B2 改动(依据:设计稿 v3 §D.8「B 合并时在 B2 PR 内由 `inert_at_phase0_<entry>` 逐项重证」):写命令装配(`deps-write.ts` → `src/rsi/assemble-write.ts`)现在接入存储核,
 * 所以写侧入口不再「闭包不含存储核」,而是「**只经** `assemble-write.ts` 到达存储核」+ 相位 0 下全部是桩(`test/rsi/asm/b-inert.test.ts` 逐入口证明)。
 * 读侧 / worker / 个人步入口(C / D 才接线)仍断言**闭包不含存储核**,断言本身一字未改。
 */
const READ_SIDE_ENTRIES = [
  'src/rsi/poke.ts',
  'src/rsi/hint.ts',
  'src/rsi/worker.ts',
  'src/rsi/auto/entry.ts',
  'src/rsi/personal/candidate-step.ts',
].filter((f) => existsSync(path.join(ROOT, f)));
const WRITE_SIDE_ENTRIES = [
  'cli.ts',
  'src/cli.ts',
  'src/commands/rsi.ts',
  'src/rsi/auto/commands.ts',
  'src/rsi/auto/deps-write.ts',
].filter((f) => existsSync(path.join(ROOT, f)));
const ENTRIES = [...READ_SIDE_ENTRIES, ...WRITE_SIDE_ENTRIES];
/** 写侧入口里唯一允许把存储核带进闭包的组合根 */
const WRITE_ROOT = 'src/rsi/assemble-write.ts';

const storeFiles = (files: Iterable<string>): string[] =>
  [...files].filter((f) => f.startsWith('src/rsi/store/') || f === 'src/contracts/rsi-store.ts');

describe('生产惰性(B1a)', () => {
  it('入口闭包非空(自检:确实扫了东西)', () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(8);
    expect(closureOf(ENTRIES).files.size).toBeGreaterThan(50);
  });

  it('读侧 / worker / 个人步入口的运行时 import 闭包不含存储核的任何模块', () => {
    const c = closureOf(READ_SIDE_ENTRIES, { includeTypes: false });
    expect(storeFiles(c.files)).toEqual([]);
    expect(c.unresolved).toEqual([]);
  });

  it('写侧入口只经 assemble-write.ts 到达存储核(把组合根换成空模块后闭包不含存储核);组合根确实带进存储核', () => {
    const virtual = { [WRITE_ROOT]: 'export {};' };
    const cut = closureOf(WRITE_SIDE_ENTRIES, { includeTypes: false, virtual });
    expect(storeFiles(cut.files)).toEqual([]);
    expect(cut.unresolved).toEqual([]);
    const real = closureOf(WRITE_SIDE_ENTRIES, { includeTypes: false });
    expect(real.files.has(WRITE_ROOT)).toBe(true);
    expect(storeFiles(real.files)).toContain('src/rsi/store/store.ts');
  });

  it('正向对照:虚拟入口 import 装配函数时,闭包含存储核(检查有效)', () => {
    const c = closureOf(['src/rsi/inert-probe.ts'], {
      virtual: {
        'src/rsi/inert-probe.ts':
          "import { assembleRsiStore } from './store/store.js';\nexport const x = assembleRsiStore;",
      },
    });
    expect(storeFiles(c.files)).toContain('src/rsi/store/store.ts');
    expect(storeFiles(c.files)).toContain('src/rsi/store/backend.js'.replace('.js', '.ts'));
  });

  it('older_build_has_no_writer:存储核之外没有对 effects.json / audit.jsonl / audit-compaction.json 的写调用', async () => {
    const NAMES =
      /effects\.json|audit\.jsonl|audit-compaction\.json|RSI_EFFECTS_FILE|RSI_AUDIT_FILE|RSI_AUDIT_COMPACTION_FILE/;
    const WRITE =
      /\b(appendFileSynced|appendFile|writeFile|createExclusive\w*|rename|remove|copyFile|writeRsiFileAtomic|removeRsiFile)\b/;
    const walk = async (dir: string, out: string[] = []): Promise<string[]> => {
      for (const e of await readDir(dir)) {
        const p = path.join(dir, e.name);
        if (e.isDirectory) await walk(p, out);
        else if (e.isFile && p.endsWith('.ts')) out.push(p);
      }
      return out;
    };
    const offenders = (files: Record<string, string>): string[] =>
      Object.entries(files)
        .filter(
          ([rel]) => !rel.startsWith('src/rsi/store/') && rel !== 'src/contracts/rsi-store.ts',
        )
        .filter(([, src]) => NAMES.test(src) && WRITE.test(src))
        .map(([rel]) => rel);
    const files: Record<string, string> = {};
    for (const f of [...(await walk(path.join(ROOT, 'src'))), path.join(ROOT, 'cli.ts')]) {
      files[path.relative(ROOT, f).split(path.sep).join('/')] = readTextSync(f);
    }
    // 自检:读者确实提到这些文件名(扫描器不是空转),且它们不含写调用
    const readers = Object.entries(files)
      .filter(([rel, s]) => !rel.startsWith('src/rsi/store/') && NAMES.test(s))
      .map(([rel]) => rel);
    expect(readers).toEqual(
      expect.arrayContaining(['src/rsi/auto/deps.ts', 'src/rsi/auto/read/report.ts']),
    );
    expect(offenders(files)).toEqual([]);
    // 正向对照
    expect(
      offenders({
        'src/rsi/personal/evil.ts':
          "import { appendFileSynced } from '../../io/safe-fs.js';\nawait appendFileSynced(io, 'audit.jsonl', 'x', 0o600);",
      }),
    ).toEqual(['src/rsi/personal/evil.ts']);
  });

  it('相位常量保持 0:W8 写命令(V1a / V1b)在相位 0 全被闸挡在桩之前,首次生产写入 = 提相位 PR', () => {
    expect(RSI_AUTO_PHASE).toBe(0);
    const entry = readTextSync(path.join(ROOT, 'src/rsi/auto/entry.ts'));
    expect(entry).toContain(
      'capabilityAvailable(RSI_AUTO_SUBCOMMAND_CAPS[route.canonical], phase)',
    );
    const commands = readTextSync(path.join(ROOT, 'src/rsi/auto/commands.ts'));
    expect(commands).not.toMatch(/\bphase\s*:/); // 生产不传 phase,取 RSI_AUTO_PHASE
  });
});

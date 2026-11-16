/**
 * B1b:能力门禁(`RSI_PHASE_REQUIRES`)、`near_fp` 空数组合法、以及合并后的**生产惰性**:
 *  - 相位常量保持 0;生产装配没有注入任何能力(`RSI_PRODUCTION_WIRED_CAPS` 为空)——提相位的 PR 在能力齐全之前必红;
 *  - 读命令(`rsi report` 经 `auto/entry.ts`)的运行时闭包含 `contracts/rsi-compaction.ts`(读压缩文件的 schema),但**不含**存储核任何模块与 `contracts/rsi-store.ts`;
 *  - `contracts/rsi-compaction.ts` 只 import `zod` 与同目录 `common.js`(无 I/O)——这是闭包放行它的前提。
 * 每条带正向对照。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RSI_AUTO_PHASE, RSI_AUTO_PHASE_ORDER, phaseIndex } from '../../../src/contracts/rsi.js';
import {
  PhaseCapsMissingError,
  RSI_ASSEMBLY_CAPS,
  RSI_PHASE_REQUIRES,
  RSI_PRODUCTION_WIRED_CAPS,
  assertPhaseCaps,
  missingPhaseCaps,
} from '../../../src/contracts/rsi-phase-caps.js';
import { RsiBlacklistItemSchema } from '../../../src/contracts/rsi-store.js';
import { readTextSync } from '../../../src/io/read-fs.js';
import { planLedgerBatch } from '../../../src/rsi/store/ledger-plan.js';
import { ROOT, closureOf } from '../closure-util.js';
import { emptyLedger } from './b1b-fixture.js';
import { ID, SHA, meta, veto } from './store-fixture.js';

vi.setConfig({ testTimeout: 120_000 });

const V1A = phaseIndex('V1a');

describe('RSI_PHASE_REQUIRES(相位 → 必备能力)', () => {
  it('表覆盖每个相位名;V0 无要求、V1a 起要求全部能力;能力名都在 RSI_ASSEMBLY_CAPS', () => {
    expect(Object.keys(RSI_PHASE_REQUIRES).sort()).toEqual([...RSI_AUTO_PHASE_ORDER].sort());
    expect(RSI_PHASE_REQUIRES.V0).toEqual([]);
    expect([...RSI_PHASE_REQUIRES.V1a].sort()).toEqual([...RSI_ASSEMBLY_CAPS].sort());
    for (const caps of Object.values(RSI_PHASE_REQUIRES)) {
      for (const c of caps) expect(RSI_ASSEMBLY_CAPS).toContain(c);
    }
  });

  it('生产惰性:相位常量 0、生产装配没有注入任何能力;当前相位无缺口(提相位前恒成立)', () => {
    expect(RSI_AUTO_PHASE).toBe(0);
    expect(RSI_PRODUCTION_WIRED_CAPS.size).toBe(0);
    expect(missingPhaseCaps(RSI_AUTO_PHASE)).toEqual([]);
    expect(() => assertPhaseCaps(RSI_AUTO_PHASE)).not.toThrow();
    // 提相位的 PR 必须同时让生产装配带齐能力:相位 ≥ V1a 时缺口必须为空(现在为 0,不触发)
    if (RSI_AUTO_PHASE >= V1A) expect(missingPhaseCaps(RSI_AUTO_PHASE)).toEqual([]);
  });

  it('phase_raise_blocked_without_near_fp_producer:相位提到 V1a 而生产装配未注入能力 → 缺 near_fp_producer 等,assertPhaseCaps 抛 PhaseCapsMissingError', () => {
    const missing = missingPhaseCaps(V1A);
    expect(missing).toContain('near_fp_producer');
    expect(missing).toContain('effects_ledger_write');
    expect(missing).toEqual([...RSI_ASSEMBLY_CAPS]);
    try {
      assertPhaseCaps(V1A);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PhaseCapsMissingError);
      expect((e as PhaseCapsMissingError).code).toBe('RSI_PHASE_CAPS_MISSING');
      expect((e as PhaseCapsMissingError).missing).toContain('near_fp_producer');
    }
  });

  it('能力齐全才放行;只缺 near_fp_producer 时缺口恰为它(正向对照);更高相位累计同一要求', () => {
    const all = new Set<string>(RSI_ASSEMBLY_CAPS);
    expect(missingPhaseCaps(V1A, all)).toEqual([]);
    expect(() => assertPhaseCaps(V1A, all)).not.toThrow();
    const almost = new Set(all);
    almost.delete('near_fp_producer');
    expect(missingPhaseCaps(V1A, almost)).toEqual(['near_fp_producer']);
    expect(missingPhaseCaps(phaseIndex('V2'), almost)).toEqual(['near_fp_producer']);
  });

  it('非整数 / 越界相位 = 默认拒绝(要求全部能力)', () => {
    for (const bad of [-1, 1.5, 99, Number.NaN]) {
      expect(missingPhaseCaps(bad)).toEqual([...RSI_ASSEMBLY_CAPS]);
    }
  });
});

describe('near_fp_empty_valid_until_producer_wired', () => {
  it('黑名单项 near_fp = [] 合法(schema ≤ 64 项);B 的写入一律写 [](没有 meta.near_fp 时)', () => {
    const item = {
      candidate_id: ID,
      content_sha256: SHA,
      fp_hmac: '0123456789abcdef',
      near_fp: [],
      at: '2026-10-02T08:00:00.000Z',
      vetoed_gen: 1,
    };
    expect(RsiBlacklistItemSchema.safeParse(item).success).toBe(true);
    expect(
      RsiBlacklistItemSchema.safeParse({ ...item, near_fp: Array(65).fill('0123abcd') }).success,
    ).toBe(false);
    const plan = planLedgerBatch(
      emptyLedger(),
      'k',
      [veto(ID, SHA)],
      meta('2026-10-02T08:00:00.000Z'),
    );
    expect(plan.kind === 'commit' ? plan.next.blacklist[0]?.near_fp : null).toEqual([]);
  });
});

describe('B1b 合并后的生产惰性', () => {
  const READ_ENTRY = 'src/rsi/auto/entry.ts';
  const storeFiles = (files: Iterable<string>): string[] =>
    [...files].filter((f) => f.startsWith('src/rsi/store/') || f === 'src/contracts/rsi-store.ts');

  it('读命令入口的运行时闭包含读压缩文件的 schema(rsi-compaction.ts)与双读模块,不含存储核任何模块', () => {
    const c = closureOf([READ_ENTRY], { includeTypes: false });
    expect(c.files.has('src/rsi/auto/read/compaction-snapshot.ts')).toBe(true);
    expect(c.files.has('src/contracts/rsi-compaction.ts')).toBe(true);
    expect(storeFiles(c.files)).toEqual([]);
    expect(c.unresolved).toEqual([]);
  });

  it('正向对照:读入口若 import 存储核(或 rsi-store.ts)闭包检查必须变红', () => {
    const c = closureOf(['src/rsi/inert-probe.ts'], {
      virtual: {
        'src/rsi/inert-probe.ts':
          "import { assembleRsiStore } from './store/store.js';\nimport { compactorOf } from './store/compactor.js';\nimport '../contracts/rsi-store.js';\nexport const x = [assembleRsiStore, compactorOf];",
      },
    });
    expect(storeFiles(c.files)).toEqual(
      expect.arrayContaining([
        'src/rsi/store/store.ts',
        'src/contracts/rsi-store.ts',
        'src/rsi/store/compactor.ts',
        'src/rsi/store/compaction-port.ts',
      ]),
    );
  });

  it('rsi-compaction.ts 只 import zod 与 ./common.js(无 I/O);扫描器对 node:fs 的虚拟文件会报出', () => {
    const specs = (src: string): string[] =>
      [...src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]/g)].map(
        (m) => m[1] as string,
      );
    const src = readTextSync(path.join(ROOT, 'src/contracts/rsi-compaction.ts'));
    expect(specs(src).sort()).toEqual(['./common.js', 'zod']);
    expect(specs("import * as fs from 'node:fs';\nimport { z } from 'zod';")).toEqual([
      'node:fs',
      'zod',
    ]);
  });
});

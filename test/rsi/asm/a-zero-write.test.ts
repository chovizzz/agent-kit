/**
 * 装配块 A 段:读侧组合根与只读适配器的静态零写入证据(import 闭包;现有 zero-write / import-closure 断言一个字未动,这里只**新增**入口)。
 *  - 每个新入口(运行时依赖与含类型依赖两种口径):闭包不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,没有写类标识符、动态 import / require,外部依赖只在白名单内,`node:fs` 只经 read-fs;
 *  - 对照:被拆的原模块(ledger / pause-marker / judge store / state-store)闭包**确实**含 safe-fs(审计工具不是空转);含写出口的虚拟入口被报出;
 *  - 拆分后的再导出兼容性:原模块再导出的函数与读侧模块里的是同一个对象(**只证明既有 import 路径仍指向同一实现,不证明搬迁行为不变**——行为不变由基线 diff 核对与既有 W5 / W7 / judge 行为用例承担);
 *  - eslint:读根文件 import 写模块即红(真实 eslint 夹具),同一代码放在未登记文件里不红(负对照)。
 * 读 / 写组合入口互不穿越:读根的闭包里没有 `commands.ts` / `deps-write.ts` / `write/**`。
 */
import { ESLint } from 'eslint';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../helpers/tmp.js';
import { closureOf, externalSpecs, identHits, importersOf } from '../closure-util.js';

const READ_ENTRIES = [
  'src/rsi/assemble-read.ts',
  'src/rsi/auto/git-path.ts',
  'src/rsi/auto/read/peek.ts',
  'src/rsi/personal/read/credentials.ts',
  'src/rsi/personal/read/step-sources.ts',
  'src/rsi/analysis/source-ports.ts',
  'src/rsi/canary/pause-marker-read.ts',
  'src/rsi/canary/ledger-read.ts',
  'src/judge/store-read.ts',
];

const FORBIDDEN_FILES = [
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
  'src/rsi/personal/home-state.ts',
  'src/rsi/personal/rollback.ts',
  'src/rsi/personal/rollback-ports.ts',
  'src/rsi/personal/rollback-journal.ts',
  'src/rsi/personal/rollback-repo.ts',
  'src/rsi/personal/revoke-write.ts',
  'src/rsi/personal/clear.ts',
  'src/rsi/personal/commit.ts',
  'src/rsi/personal/commit-journal.ts',
  'src/rsi/personal/repo-check.ts',
  'src/rsi/personal/personal-lock.ts',
  'src/rsi/personal/candidate-repo.ts',
  'src/rsi/personal/candidate-ports.ts',
  'src/rsi/canary/pause-marker.ts',
  'src/rsi/canary/ledger.ts',
  'src/rsi/canary/canary-writer.ts',
  'src/rsi/canary/admission-write.ts',
  'src/judge/store.ts',
  'src/signals/state-store.ts',
  'src/rsi/auto/deps.ts',
  'src/rsi/auto/deps-write.ts',
  'src/rsi/auto/entry.ts',
  'src/rsi/auto/commands.ts',
];
const WRITE_IDENTS = [
  'acquireRsiLock',
  'acquirePersonalLock',
  'withRsiLock',
  'withRsiLockIfGated',
  'recoverSnapshot',
  'commitSnapshot',
  'commitUnderLock',
  'createExclusive',
  'appendFile',
  'mkdirp',
  'runSync',
  'runSelf',
  'runGitClosed',
  'spawnSync',
  'writeTxn',
  'removeTxn',
];
/** 既有读侧白名单 + `yaml`(提案 / 原子 frontmatter 的纯解析器,经 `atoms/frontmatter.ts`;只在新的暂存提案读入口里出现) */
const ALLOWED_EXTERNALS = [
  'node:crypto',
  'node:fs',
  'node:fs/promises',
  'node:os',
  'node:path',
  'smol-toml',
  'yaml',
  'zod',
];

describe('读侧组合根与只读适配器:import 闭包(运行时依赖与含类型依赖两种口径)', () => {
  for (const entry of READ_ENTRIES) {
    for (const includeTypes of [false, true]) {
      it(`${entry}(${includeTypes ? '含类型依赖' : '运行时依赖'}):不含写出口 / 锁 / 子进程出口 / 含写出口的原模块,无写类标识符,无动态 import,外部依赖在白名单内`, () => {
        const c = closureOf([entry], { includeTypes });
        expect(
          [...c.files].filter((f) => FORBIDDEN_FILES.includes(f) || f.startsWith('src/update/')),
        ).toEqual([]);
        expect(
          [...c.files].filter(
            (f) =>
              f.startsWith('src/rsi/auto/write/') ||
              f.startsWith('src/reflect/backends/') ||
              f.startsWith('src/judge/ingest/'),
          ),
        ).toEqual([]);
        expect(identHits(c, WRITE_IDENTS)).toEqual([]);
        expect(c.dynamic).toEqual([]);
        expect(c.unresolved).toEqual([]);
        expect(externalSpecs(c).filter((e) => !ALLOWED_EXTERNALS.includes(e))).toEqual([]);
        expect(externalSpecs(c)).not.toContain('node:child_process');
        for (const spec of ['node:fs', 'node:fs/promises']) {
          expect(importersOf(c, spec).filter((f) => f !== 'src/io/read-fs.ts')).toEqual([]);
        }
      });
    }
  }

  it('对照:被拆的原模块闭包确实含 safe-fs(禁止表不是空转);含写出口的虚拟入口被报出', () => {
    for (const orig of [
      'src/rsi/canary/ledger.ts',
      'src/rsi/canary/pause-marker.ts',
      'src/judge/store.ts',
      'src/signals/state-store.ts',
    ]) {
      expect(closureOf([orig]).files.has('src/io/safe-fs.ts'), orig).toBe(true);
    }
    const v = closureOf(['src/rsi/__asm_a_probe.ts'], {
      virtual: {
        'src/rsi/__asm_a_probe.ts':
          "import { writeFile } from '../io/safe-fs.js';\nimport { assembleReadAdapters } from './assemble-read.js';\nexport const x = [writeFile, assembleReadAdapters];\n",
      },
    });
    expect([...v.files].filter((f) => FORBIDDEN_FILES.includes(f))).toContain('src/io/safe-fs.ts');
    expect(v.files.has('src/rsi/assemble-read.ts')).toBe(true);
  });

  it('读 / 写组合入口分离:读根闭包里没有写命令装配(commands.ts / deps-write.ts / write/**);写侧入口 commands.ts 的闭包不含读根(读根不被写侧穿越,也不穿越写侧)', () => {
    const c = closureOf(['src/rsi/assemble-read.ts'], { includeTypes: true });
    expect(
      [...c.files].filter(
        (f) =>
          f === 'src/rsi/auto/commands.ts' ||
          f === 'src/rsi/auto/deps-write.ts' ||
          f.startsWith('src/rsi/auto/write/'),
      ),
    ).toEqual([]);
    expect(closureOf(['src/rsi/auto/commands.ts']).files.has('src/rsi/assemble-read.ts')).toBe(
      false,
    );
  });
});

describe('拆分后的再导出兼容性:原模块再导出的就是读侧模块里的同一个对象', () => {
  it('readLedger / parseLedger / parsePauseMarker / loadRunEntries / loadRun / SignalStoreError / 候选读端口类型文件的再导出', async () => {
    const ledger = await import('../../../src/rsi/canary/ledger.js');
    const ledgerRead = await import('../../../src/rsi/canary/ledger-read.js');
    expect(ledger.readLedger).toBe(ledgerRead.readLedger);
    expect(ledger.parseLedger).toBe(ledgerRead.parseLedger);
    expect(ledger.LEDGER_READ_MAX_BYTES).toBe(ledgerRead.LEDGER_READ_MAX_BYTES);

    const marker = await import('../../../src/rsi/canary/pause-marker.js');
    const markerRead = await import('../../../src/rsi/canary/pause-marker-read.js');
    expect(marker.parsePauseMarker).toBe(markerRead.parsePauseMarker);

    const store = await import('../../../src/judge/store.js');
    const storeRead = await import('../../../src/judge/store-read.js');
    expect(store.loadRunEntries).toBe(storeRead.loadRunEntries);
    expect(store.loadRun).toBe(storeRead.loadRun);
    expect(store.runDir).toBe(storeRead.runDir);
    expect(store.JudgeRunNotFoundError).toBe(storeRead.JudgeRunNotFoundError);

    const stateStore = await import('../../../src/signals/state-store.js');
    const storeError = await import('../../../src/signals/store-error.js');
    expect(stateStore.SignalStoreError).toBe(storeError.SignalStoreError);
  });
});

describe('eslint:读侧组合根 / 只读适配器 import 写出口即红;未登记文件同样代码不红(负对照)', () => {
  it('safe-fs / exec / 锁 / 含写出口的原模块:读根文件红,放行文件(原写侧模块、测试)不红', async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const lintAs = async (code: string, rel: string) => {
      const [res] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, rel) });
      return (res?.messages ?? []).filter((m) => m.ruleId?.startsWith('no-restricted'));
    };
    const bad = [
      "import { writeFile } from '../io/safe-fs.js';\nexport const w = writeFile;\n",
      "import { runSync } from '../io/exec.js';\nexport const w = runSync;\n",
      "import { acquireRsiLock } from './lock.js';\nexport const w = acquireRsiLock;\n",
      "import { appendLedgerLine } from './canary/ledger.js';\nexport const w = appendLedgerLine;\n",
      "import { writeProposal } from '../judge/store.js';\nexport const w = writeProposal;\n",
    ];
    for (const code of bad) {
      expect((await lintAs(code, 'src/rsi/assemble-read.ts')).length, code).toBeGreaterThan(0);
      expect((await lintAs(code, 'src/rsi/analysis/source-ports.ts')).length, code).toBeGreaterThan(
        0,
      );
    }
    // 对照:合规的读侧 import 不红
    const good =
      "import { readLedger } from './canary/ledger-read.js';\nexport const r = readLedger;\n";
    expect(await lintAs(good, 'src/rsi/assemble-read.ts')).toEqual([]);
    // 负对照:同一段写出口 import 放在未登记的写侧文件里不被这条新规则拦(它们本来就是授权的写出口使用方)
    const safeFs = bad[0] as string;
    expect(
      (await lintAs(safeFs, 'src/rsi/canary/ledger.ts')).filter((m) =>
        m.message.includes('装配块 A 段'),
      ),
    ).toEqual([]);
  }, 120_000);
});

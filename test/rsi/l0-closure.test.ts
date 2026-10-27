/**
 * B4-0:L0 规划侧模块的 import 闭包闸(B4 方案 §1.4 / §6 第一层;R20-3.1.1 零写入的静态证明)。
 *
 * 规划侧 = `src/rsi/l0/*.ts`(排除提交侧 `commit.ts` / `run.ts`)、`src/rsi/exclude-match.ts`、`src/signals/salt-read.ts`。它们的 import 传递闭包
 * (`import type` 与 `export … from` 也算)不得含:safe-fs、`lock.ts`、`with-lock.ts`、`snapshot.ts`、`state-store.ts`、`session-stats.ts`,
 * 也不得含 llm-exec / reflect 后端 / net.ts / home-fs(R20-1.1)。模块清单用目录 glob 取,B4a–B4c2 新增规划侧文件自动纳入,不用再改本文件。
 * 每个模块都要:相对说明符全部解析成功、没有动态 import / require。
 * 变异对照:对每个规划侧模块,在其真实源码里加一行引入禁用文件(直接 / `import type` / `export *` / 经中间文件间接)的语句,闭包检查必须红;
 * 另用提交侧的真实模块证明检查器看得见这些禁用文件(正向对照,防止「干净」是检查器漏看)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDir, readTextSync } from '../../src/io/read-fs.js';
import {
  ROOT,
  closureOf,
  externalSpecs,
  fsWriteUses,
  importersOf,
  type Closure,
} from './closure-util.js';

const FORBIDDEN_FILES: readonly string[] = [
  'src/io/safe-fs.ts',
  'src/rsi/lock.ts',
  'src/rsi/with-lock.ts',
  'src/rsi/snapshot.ts',
  'src/signals/state-store.ts',
  'src/signals/session-stats.ts',
  'src/io/llm-exec.ts',
  'src/io/net.ts',
  'src/io/home-fs.ts',
];
const FORBIDDEN_PREFIXES: readonly string[] = ['src/reflect/backends/'];
/** 提交侧模块:不受本闸约束(它们本来就写) */
const COMMIT_SIDE = new Set(['commit.ts', 'run.ts']);
const EXTRA_PLANNING: readonly string[] = ['src/rsi/exclude-match.ts', 'src/signals/salt-read.ts'];

const l0Dir = path.join(ROOT, 'src/rsi/l0');
const l0Names = (await readDir(l0Dir))
  .filter((e) => e.isFile && e.name.endsWith('.ts') && !COMMIT_SIDE.has(e.name))
  .map((e) => e.name)
  .sort();
const PLANNING: readonly string[] = [
  ...l0Names.map((n) => `src/rsi/l0/${n}`),
  ...EXTRA_PLANNING,
].sort();

/** 网络 / 子进程 / 沙箱类外部模块:闭包里一个都不许有 */
const BANNED_EXTERNAL_HEADS = [
  'net',
  'tls',
  'http',
  'https',
  'http2',
  'dgram',
  'dns',
  'child_process',
  'worker_threads',
  'cluster',
  'vm',
  'inspector',
  'undici',
  'ws',
  'sigstore',
];
/** `node:fs` 只许 read-fs.ts(读出口)引入;规划侧任何别的文件引入都算写出口风险 */
const FS_ALLOWED_IMPORTERS = ['src/io/read-fs.ts'];

function bad(c: Closure): string[] {
  const out: string[] = [];
  for (const f of c.files) {
    if (FORBIDDEN_FILES.includes(f) || FORBIDDEN_PREFIXES.some((p) => f.startsWith(p))) {
      out.push(f);
    }
  }
  for (const spec of externalSpecs(c)) {
    const bare = spec.replace(/^node:/, '');
    const head = bare.split('/')[0] as string;
    if (BANNED_EXTERNAL_HEADS.includes(head) || spec.startsWith('@sigstore/')) {
      out.push(`external:${spec}`);
    }
    if (head === 'fs') {
      for (const imp of importersOf(c, spec)) {
        if (!FS_ALLOWED_IMPORTERS.includes(imp)) out.push(`external:${spec}<-${imp}`);
      }
    }
  }
  return out.sort();
}
const closure = (entry: string, virtual: Record<string, string> = {}): Closure =>
  closureOf([entry], { includeTypes: true, virtual });

describe('B4-0 规划侧模块清单(glob 不会静默变空)', () => {
  it('至少包含已冻结的模块', () => {
    for (const must of [
      'src/rsi/l0/types.ts',
      'src/rsi/l0/roots.ts',
      'src/rsi/l0/enumerate.ts',
      'src/rsi/l0/head-parsers.ts',
      'src/rsi/l0/collect-policy.ts',
      'src/rsi/l0/armed-listing.ts',
      'src/rsi/l0/fingerprint.ts',
      'src/rsi/l0/counts-recompute.ts',
      'src/rsi/l0/index-update.ts',
      'src/rsi/l0/rebuild-plan.ts',
      'src/rsi/exclude-match.ts',
      'src/signals/salt-read.ts',
    ]) {
      expect(PLANNING, must).toContain(must);
    }
  });
});

describe('B4-0 规划侧闭包:无写出口、无网络 / LLM 出口', () => {
  for (const f of PLANNING) {
    it(f, () => {
      const c = closure(f);
      expect(c.unresolved).toEqual([]);
      expect(c.dynamic).toEqual([]);
      expect(bad(c)).toEqual([]);
      expect(c.files.has(f)).toBe(true);
    });
  }

  it('RecoverOutcome / InspectOutcome 来自只读的 snapshot-read.ts,snapshot.ts 仍 re-export 它们', () => {
    const types = readTextSync(path.join(ROOT, 'src/rsi/l0/types.ts'));
    expect(types).toContain("from '../snapshot-read.js'");
    expect(types).not.toMatch(/from '\.\.\/snapshot\.js'/);
    const snap = readTextSync(path.join(ROOT, 'src/rsi/snapshot.ts'));
    expect(snap).toMatch(/type RecoverOutcome,?\s/);
    expect(snap).toMatch(/type InspectOutcome,?\s/);
    const read = readTextSync(path.join(ROOT, 'src/rsi/snapshot-read.ts'));
    expect(read).toMatch(/export type RecoverOutcome =/);
    expect(read).toMatch(/export type InspectOutcome =/);
  });
});

describe('B4-0 变异对照:在规划侧模块里加一行禁用 import,闭包检查必须红', () => {
  const MUTANTS: Record<string, { line: string; expect: string }> = {
    '直接 import snapshot.ts': {
      line: `import { commitSnapshot } from '${'__REL__'}rsi/snapshot.js';\nvoid commitSnapshot;`,
      expect: 'src/rsi/snapshot.ts',
    },
    'import type snapshot.ts': {
      line: `import type { RecoverOutcome as R_ } from '${'__REL__'}rsi/snapshot.js';\nexport type X_ = R_;`,
      expect: 'src/rsi/snapshot.ts',
    },
    'export * from snapshot.ts': {
      line: `export * from '${'__REL__'}rsi/snapshot.js';`,
      expect: 'src/rsi/snapshot.ts',
    },
    '直接 import safe-fs': {
      line: `import { writeFile as w_ } from '${'__REL__'}io/safe-fs.js';\nvoid w_;`,
      expect: 'src/io/safe-fs.ts',
    },
    '直接 import lock.ts': {
      line: `import { acquireRsiLock as a_ } from '${'__REL__'}rsi/lock.js';\nvoid a_;`,
      expect: 'src/rsi/lock.ts',
    },
    '直接 import state-store': {
      line: `import { loadSalt as l_ } from '${'__REL__'}signals/state-store.js';\nvoid l_;`,
      expect: 'src/signals/state-store.ts',
    },
    '直接 import session-stats': {
      line: `import { buildSessionStat as b_ } from '${'__REL__'}signals/session-stats.js';\nvoid b_;`,
      expect: 'src/signals/session-stats.ts',
    },
    '字面量动态 import()': {
      line: `export const dyn_ = () => import('${'__REL__'}rsi/snapshot.js');`,
      expect: 'src/rsi/snapshot.ts',
    },
    '引入 llm-exec': {
      line: `import { runLlm as r_ } from '${'__REL__'}io/llm-exec.js';\nvoid r_;`,
      expect: 'src/io/llm-exec.ts',
    },
    '类型位置 import() 引入 snapshot.ts': {
      line: `export type T_ = import('${'__REL__'}rsi/snapshot.js').RecoverOutcome;`,
      expect: 'src/rsi/snapshot.ts',
    },
    '引入 node:fs/promises(写函数)': {
      line: `import { writeFile as w2_ } from 'node:fs/promises';\nvoid w2_;`,
      expect: 'external:node:fs/promises<-__SELF__',
    },
    '引入 node:fs': {
      line: `import * as fs_ from 'node:fs';\nvoid fs_;`,
      expect: 'external:node:fs<-__SELF__',
    },
    '引入 node:https': {
      line: `import { request as rq_ } from 'node:https';\nvoid rq_;`,
      expect: 'external:node:https',
    },
    '引入 node:child_process': {
      line: `import { spawn as sp_ } from 'node:child_process';\nvoid sp_;`,
      expect: 'external:node:child_process',
    },
    '引入 net.ts': {
      line: `import * as n_ from '${'__REL__'}io/net.js';\nvoid n_;`,
      expect: 'src/io/net.ts',
    },
  };

  /** `__REL__` = 从该模块所在目录回到 `src/` 的相对前缀 */
  const relPrefix = (file: string): string => {
    const dir = path.posix.dirname(file);
    const up = path.posix.relative(dir, 'src');
    return up === '' ? './' : `${up}/`;
  };

  for (const f of PLANNING) {
    for (const [name, m] of Object.entries(MUTANTS)) {
      it(`${f} + ${name}`, () => {
        // 正向前提:未变异时是干净的(否则下面的「红」可能来自别处)
        expect(bad(closure(f))).toEqual([]);
        const src = `${readTextSync(path.join(ROOT, f))}\n${m.line.replace(/__REL__/g, relPrefix(f))}\n`;
        const c = closure(f, { [f]: src });
        expect(bad(c)).toContain(m.expect.replace('__SELF__', f));
      });
    }
    it(`${f} + 直接 fs 写调用被 fsWriteUses 抓到(正向前提:未变异为空)`, () => {
      const src = readTextSync(path.join(ROOT, f));
      expect(fsWriteUses(f, src)).toEqual([]);
      expect(
        fsWriteUses(f, `${src}\nexport const w3_ = (o: { writeFile(): void }) => o.writeFile();\n`),
      ).not.toEqual([]);
    });
    it(`${f} + 经中间文件间接引入 snapshot.ts`, () => {
      const dir = path.posix.dirname(f);
      const mid = `${dir}/__sim_mid.ts`;
      const midSrc = `export * from '${relPrefix(mid)}rsi/snapshot.js';\n`;
      const src = `${readTextSync(path.join(ROOT, f))}\nimport * as mid_ from './__sim_mid.js';\nvoid mid_;\n`;
      const c = closure(f, { [f]: src, [mid]: midSrc });
      expect(bad(c)).toContain('src/rsi/snapshot.ts');
    });
  }

  it('反例保持:注释与字符串里提到 snapshot.ts 不算引入(不误报)', () => {
    const f = 'src/rsi/l0/types.ts';
    const src = `${readTextSync(path.join(ROOT, f))}\n// import '../snapshot.js'\nexport const s_ = "import x from '../snapshot.js'";\n`;
    expect(bad(closure(f, { [f]: src }))).toEqual([]);
  });
});

describe('B4-0 正向对照:检查器确实看得见这些禁用文件', () => {
  it('提交侧 services/commit.ts 的闭包含 safe-fs 与 snapshot.ts', () => {
    const b = bad(closure('src/rsi/services/commit.ts'));
    expect(b).toContain('src/io/safe-fs.ts');
    expect(b).toContain('src/rsi/snapshot.ts');
  });
  it('state-store.ts 的闭包含 safe-fs', () => {
    expect(bad(closure('src/signals/state-store.ts'))).toContain('src/io/safe-fs.ts');
  });
  it('cli.ts 的闭包含 llm-exec', () => {
    expect(bad(closure('src/cli.ts'))).toContain('src/io/llm-exec.ts');
  });
});

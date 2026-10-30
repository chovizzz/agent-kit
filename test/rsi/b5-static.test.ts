/**
 * R20-A2 B5e:静态与闭包核对(契约 §20.1 R20-1.1、§20.8.1 ③;方案 §10.3)。
 *  ① B5 两个新写入口进了 `REAL_ENTRY_CANDIDATES`(零网络闭包闸),且八个前台入口文件真实存在并被遍历(不会因「文件不存在被过滤」而空过);
 *  ② `tick.ts → l0/run.ts → l0/commit.ts → reflect/load.ts …` 这条链的闭包被真实覆盖:链上的文件确实在闭包里(正向前提),并且没有 llm-exec / reflect 后端 / net / 启动器 / 网络外部模块;
 *  ③ `status.ts` / `projects.ts` 仍在只读闭包(不含两个写入口、锁、快照写侧);变异对照:往 `projects.ts` 加一行引入 `projects-rebuild.ts`,闭包立刻含锁与 safe-fs;
 *  ④ `src/rsi/exit.ts` 的 `stableOf`:`RsiStagingBlockedError` → 3 `staging_unsafe_entry`;`WriteDeniedError` → 3 `write_denied`;
 *     tick 对 `write_denied` 透传(命令级):空写入根下 `tick --write` 退 3 `write_denied`,同一世界默认写入根下退 0(正向对照)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { exists, readText, readTextSync } from '../../src/io/read-fs.js';
import { WriteDeniedError } from '../../src/io/safe-fs.js';
import { stableOf } from '../../src/rsi/exit.js';
import { RsiStagingBlockedError } from '../../src/rsi/services/staging.js';
import { withWriteAudit } from '../helpers/write-audit.js';
import { ROOT, closureOf, externalSpecs } from './closure-util.js';
import { makeTickFx } from './b5a-fixture.js';
import { treeOf } from './rsi-fixture.js';

const FOREGROUND = [
  'src/rsi/tick.ts',
  'src/rsi/status.ts',
  'src/rsi/status-ack.ts',
  'src/rsi/projects.ts',
  'src/rsi/projects-rebuild.ts',
  'src/rsi/confirm.ts',
  'src/rsi/stop.ts',
  'src/rsi/purge.ts',
] as const;

const FORBIDDEN_FILES = [
  'src/io/net.ts',
  'src/io/llm-exec.ts',
  'src/update/launcher.ts',
  'src/update/install.ts',
  'src/update/registry.ts',
  'src/update/provenance.ts',
];
const FORBIDDEN_PREFIX = ['src/reflect/backends/'];
const NET_HEADS = [
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'undici',
  'ws',
  'sigstore',
];

function violations(files: ReadonlySet<string>, specs: readonly string[]): string[] {
  const bad: string[] = [];
  for (const f of files) {
    if (FORBIDDEN_FILES.includes(f) || FORBIDDEN_PREFIX.some((p) => f.startsWith(p))) bad.push(f);
  }
  for (const s of specs) {
    const head = s.replace(/^node:/, '').split('/')[0] as string;
    if (NET_HEADS.includes(head) || s.startsWith('@sigstore/')) bad.push(`external:${s}`);
  }
  return bad;
}

describe('① 两个新入口在零网络闭包闸里', () => {
  it('REAL_ENTRY_CANDIDATES 含 status-ack.ts 与 projects-rebuild.ts;八个前台入口文件真实存在(闸不是对空集合成立)', async () => {
    const src = await readText(path.join(ROOT, 'test/rsi/import-closure.test.ts'));
    const block = /const REAL_ENTRY_CANDIDATES[^=]*=\s*\[([\s\S]*?)\];/.exec(src)?.[1] ?? '';
    for (const f of FOREGROUND) {
      expect(block, `候选表缺 ${f}`).toContain(`'${f}'`);
      expect(await exists(path.join(ROOT, f)), `${f} 存在`).toBe(true);
    }
    // 对照:候选表里的不存在的文件(poke / hint 在 A3 之前)确实会被过滤,所以上面「存在」断言才有意义
    expect(block).toContain("'src/rsi/worker.ts'");
  });

  it('八个前台入口各自的闭包:解析无遗漏、无动态 import、没有 llm-exec / reflect 后端 / net / 启动器 / 网络外部模块', () => {
    for (const f of FOREGROUND) {
      const c = closureOf([f]);
      expect(c.unresolved, f).toEqual([]);
      expect(c.dynamic, f).toEqual([]);
      expect(c.files.size, `${f} 闭包非空`).toBeGreaterThan(10);
      expect(violations(c.files, externalSpecs(c)), f).toEqual([]);
      // 含类型依赖的保守口径同样干净
      const t = closureOf([f], { includeTypes: true });
      expect(violations(t.files, externalSpecs(t)), `${f}(含类型)`).toEqual([]);
    }
  });
});

describe('② tick → run → commit → reflect/load 链的闭包被真实覆盖', () => {
  const CHAIN = [
    'src/rsi/l0/run.ts',
    'src/rsi/l0/commit.ts',
    'src/reflect/load.ts',
    'src/rsi/services/purge-engine.ts',
    'src/rsi/services/taint.ts',
    'src/rsi/lock.ts',
    'src/io/safe-fs.ts',
  ];
  it('正向前提:链上的文件都在 tick.ts 的闭包里;并且闭包无禁用文件(链接上了 reflect/load.ts 但没有拖进 reflect 后端)', () => {
    const c = closureOf(['src/rsi/tick.ts']);
    for (const f of CHAIN) expect(c.files.has(f), `tick 闭包缺 ${f}`).toBe(true);
    expect(violations(c.files, externalSpecs(c))).toEqual([]);
    expect([...c.files].filter((f) => f.startsWith('src/reflect/'))).toContain(
      'src/reflect/load.ts',
    );
    expect([...c.files].some((f) => f.startsWith('src/reflect/backends/'))).toBe(false);
  });

  it('变异对照:往 reflect/load.ts 加一行引入 llm-exec / net,tick 的闭包立刻被抓到', () => {
    const real = readTextSync(path.join(ROOT, 'src/reflect/load.ts'));
    for (const [line, expected] of [
      ["import '../io/llm-exec.js';", 'src/io/llm-exec.ts'],
      ["import '../io/net.js';", 'src/io/net.ts'],
    ] as const) {
      const c = closureOf(['src/rsi/tick.ts'], {
        virtual: { 'src/reflect/load.ts': `${line}\n${real}` },
      });
      expect(violations(c.files, externalSpecs(c))).toContain(expected);
    }
  });
});

describe('③ status.ts / projects.ts 仍在只读闭包', () => {
  const WRITE_SIDE = [
    'src/rsi/status-ack.ts',
    'src/rsi/projects-rebuild.ts',
    'src/rsi/tick.ts',
    'src/rsi/confirm.ts',
    'src/rsi/purge.ts',
    'src/rsi/lock.ts',
    'src/rsi/with-lock.ts',
    'src/rsi/snapshot.ts',
    'src/io/safe-fs.ts',
    'src/rsi/services/commit.ts',
  ];
  it('两个只读入口仍在 readonly-zero-write 的 READONLY_ENTRIES 里;闭包里一个写侧文件都没有', async () => {
    const ro = await readText(path.join(ROOT, 'test/rsi/readonly-zero-write.test.ts'));
    const block = /const READONLY_ENTRIES[^=]*=\s*\[([^\]]*)\]/.exec(ro)?.[1] ?? '';
    expect(block).toContain("'src/rsi/status.ts'");
    expect(block).toContain("'src/rsi/projects.ts'");
    for (const e of ['src/rsi/status.ts', 'src/rsi/projects.ts']) {
      for (const types of [false, true]) {
        const c = closureOf([e], { includeTypes: types });
        expect(
          [...c.files].filter((f) => WRITE_SIDE.includes(f)),
          `${e} types=${types}`,
        ).toEqual([]);
      }
    }
  });

  it('正向对照:两个写入口自己的闭包确实含锁与 safe-fs(检查器看得见写侧);变异:projects.ts 引入 projects-rebuild.ts 后闭包含锁', () => {
    for (const e of ['src/rsi/status-ack.ts', 'src/rsi/projects-rebuild.ts']) {
      const c = closureOf([e]);
      expect(c.files.has('src/rsi/lock.ts'), e).toBe(true);
      expect(c.files.has('src/io/safe-fs.ts'), e).toBe(true);
    }
    const real = readTextSync(path.join(ROOT, 'src/rsi/projects.ts'));
    const mut = closureOf(['src/rsi/projects.ts'], {
      virtual: { 'src/rsi/projects.ts': `import './projects-rebuild.js';\n${real}` },
    });
    expect(mut.files.has('src/rsi/lock.ts')).toBe(true);
    expect(closureOf(['src/rsi/projects.ts']).files.has('src/rsi/lock.ts')).toBe(false);
  });
});

describe('④ stableOf 与 tick 的 write_denied 透传', () => {
  it('stableOf:RsiStagingBlockedError → RSI_FAIL_CLOSED reason=staging_unsafe_entry(3);WriteDeniedError → write_denied(3);其它异常 → internal(3,不回显消息)', () => {
    expect(stableOf(new RsiStagingBlockedError())).toEqual({
      line: 'RSI_FAIL_CLOSED reason=staging_unsafe_entry',
      exit: 3,
    });
    expect(stableOf(new WriteDeniedError('/secret/path'))).toEqual({
      line: 'RSI_FAIL_CLOSED reason=write_denied',
      exit: 3,
    });
    const other = stableOf(new Error('/secret/path leaked'));
    expect(other).toEqual({ line: 'RSI_FAIL_CLOSED reason=internal', exit: 3 });
    // 对照:稳定码里不含异常消息 / 路径
    expect(JSON.stringify([stableOf(new RsiStagingBlockedError()), other])).not.toContain('secret');
  });

  it('命令级:空写入根(KIT_WRITE_ROOTS=:)下 tick --write 退 3 write_denied、目录树不变;同一世界默认写入根下退 0(正向对照)', async () => {
    const f = await makeTickFx('b5e-wd-', {});
    const before = await treeOf(f.dir);
    const a = withWriteAudit();
    let err = '';
    const code = await main(['rsi', 'tick', '--write'], {
      env: { ...f.env, KIT_WRITE_ROOTS: ':' },
      cwd: f.dir,
      writeAudit: a.hook,
      stdout: () => undefined,
      stderr: (t) => (err += t),
    });
    expect([code, err]).toEqual([3, 'RSI_FAIL_CLOSED reason=write_denied\n']);
    expect(await treeOf(f.dir)).toEqual(before);
    const ok = await makeTickFx('b5e-wd-ok-', {});
    const code2 = await main(['rsi', 'tick', '--write'], {
      env: ok.env,
      cwd: ok.dir,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(code2).toBe(0);
  });
});

/**
 * R20-A2 B3a:只读命令(`rsi status` 无 `--ack`、`rsi projects` 非 `--rebuild-index --write`)的零写入审计(契约 §20.8.1;v2 §2)。
 *
 * 四层证据,**组合**成立,任何一层单独都不是保证;每层都带正向对照(同一机制下故意写一次,判据必须报出):
 *  ① 写调用审计:`withWriteAudit` 钩子累计到外部数组,最后断言为空(命令内部吞异常也不影响);对照 = `rsi stop` 在同一钩子下记到 createExclusive。
 *  ② 子进程:KIT_TMP + `KIT_WRITE_ROOTS=:`(写入根集合为空,safe-fs 一律拒写),退出码与输出和进程内一致、没有 write_denied;对照 = `rsi stop` 退 3 write_denied,且同样的子进程在默认写入根下 stop 成功。
 *  ③ 静态:入口的 import 传递闭包(运行时依赖与含类型依赖两种口径)不含 safe-fs / home-fs / exec / lock.ts / snapshot.ts / with-lock.ts 等文件,
 *     闭包里的 AST 标识符不含 acquireRsiLock / withRsiLock / recoverSnapshot / commitSnapshot / runSync / runSelf,没有动态 import / require;
 *     对照 = `stop` 的闭包含 safe-fs 与 createExclusive,虚拟入口(含 re-export 链、动态 import)被报出。
 *  ④ 子进程出口:vi.mock 包住 exec.ts 的 runSync / runSelf,只读命令调用次数为 0;对照 = 直接调用计 1。
 * 另有前后目录树比较(假 HOME、KIT_TMP、仓库 .state),它只证明最终状态,不证明「没有发生过写」,所以①不能省。
 */
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runSync } from '../../src/io/exec.js';
import { writeFile } from '../../src/io/safe-fs.js';
import { treeOf } from './rsi-fixture.js';
import { buildRoChild, runRoChild } from './proc/ro-helper.js';
import { put as putSession } from './l0-fixture.js';
import {
  ROOT,
  closureOf,
  externalSpecs,
  fsWriteUses,
  identHits,
  importersOf,
} from './closure-util.js';
import { readTextSync } from '../../src/io/read-fs.js';
import {
  NOW,
  baseState,
  countsOf,
  indexOf,
  key,
  makeRoFx,
  mkProject,
  runMain,
  seed,
  setExtra,
  validConfirm,
  type RoFx,
} from './ro-fixture.js';

const execCalls = vi.hoisted(() => ({ runSync: 0, runSelf: 0 }));
vi.mock('../../src/io/exec.js', async (orig) => {
  const m = await orig<typeof import('../../src/io/exec.js')>();
  return {
    ...m,
    runSync: ((...a: Parameters<typeof m.runSync>) => {
      execCalls.runSync++;
      return m.runSync(...a);
    }) as typeof m.runSync,
    runSelf: ((...a: Parameters<typeof m.runSelf>) => {
      execCalls.runSelf++;
      return m.runSelf(...a);
    }) as typeof m.runSelf,
  };
});

/** 覆盖 P / X / U / 暂存 / tainted 的数据场景 */
async function populated(prefix: string): Promise<RoFx> {
  const f = await makeRoFx(prefix);
  const a = await mkProject(f, 'a');
  const b = await mkProject(f, 'b');
  await setExtra(f, `exclude_dirs = [${JSON.stringify(b.path)}]\n`);
  await seed(f, {
    state: baseState({ confirm: await validConfirm(f), projects_ack_generation: 0 }),
    index: indexOf([
      { key: key(1), path: a.path, dev: a.dev, ino: a.ino },
      { key: key(2), path: b.path, dev: b.dev, ino: b.ino },
      { key: key(3), path: path.join(f.dir, 'work', 'gone'), dev: 1, ino: 1 },
    ]),
    counts: countsOf(
      { [key(1)]: { total: 3 }, [key(2)]: { total: 2 }, [key(3)]: { total: 1 } },
      {
        staged: [{ run_id: 'r1', proposals: 1, evidence_keys: [key(1), key(2)], tainted: false }],
      },
    ),
    cursor: {
      schema_version: 1,
      fingerprint: 'd'.repeat(64),
      full_scan: { epoch: 1, started_at: NOW, done: true, last_completed_at: NOW },
      files: {},
    },
  });
  return f;
}

/** 每个场景:[名字, 夹具构造] */
const SCENARIOS: [string, (p: string) => Promise<RoFx>][] = [
  [
    'off(disabled)',
    async (p) => {
      const f = await makeRoFx(p);
      await writeFile(f.fx, f.cfgFile, '[rsi]\nenabled = false\n', { mode: 0o600 });
      return f;
    },
  ],
  ['首次 armed(无任何状态文件)', (p) => makeRoFx(p)],
  ['confirmed + 数据', populated],
];

const READONLY_ARGVS: string[][] = [
  ['rsi', 'status'],
  ['rsi', 'status', '--json'],
  ['rsi', 'projects'],
  ['rsi', 'projects', '--json'],
  ['rsi', 'projects', '--paths'], // 非 TTY → 退 2,同样零写入
  ['rsi', 'status', '--bogus'],
  ['rsi', 'projects', '--write'],
];

describe('① 写调用审计(外部累计)+ 前后目录树', () => {
  for (const [name, mk] of SCENARIOS) {
    it(`${name}:只读命令全部入口零写调用,目录树前后一致(含假 HOME、KIT_TMP、仓库 .state)`, async () => {
      const f = await mk('zw-hook-');
      const before = await treeOf(f.dir);
      const all: string[] = []; // 外部累计:不靠命令内部抛错
      for (const argv of READONLY_ARGVS) {
        const r = await runMain(f, argv);
        all.push(...r.audit.map((a) => `${argv.join(' ')} => ${a.op} ${a.path}`));
      }
      expect(all).toEqual([]);
      expect(await treeOf(f.dir)).toEqual(before);
    });
  }

  it('首次 armed 的 projects 走真实 armed 列举(B4a):有会话文件时写审计为 0、目录树前后一致;正向前提:清单里确实列出了项目', async () => {
    const f = await makeRoFx('zw-armed-real-');
    const proj = await mkProject(f, 'armed-proj');
    await putSession(
      f,
      'pi',
      '--a--/s.jsonl',
      `${JSON.stringify({ type: 'session', cwd: proj.path })}\n{"type":"message"}\n`,
    );
    const before = await treeOf(f.dir);
    const r = await runMain(f, ['rsi', 'projects']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('name=armed-proj sessions=1 status=pending');
    expect(r.audit).toEqual([]);
    expect(await treeOf(f.dir)).toEqual(before);
  });
  it('对照:同一钩子 / 同一 main() 路径下 rsi stop 会被记到 createExclusive(钩子确实接在命令上,不是空转)', async () => {
    const f = await makeRoFx('zw-hook-ctl-');
    const r = await runMain(f, ['rsi', 'stop']);
    expect(r.code).toBe(0);
    expect(r.audit.some((a) => a.op === 'createExclusive' && a.path.endsWith('/rsi/STOP'))).toBe(
      true,
    );
    expect((await treeOf(f.dir)).some((l) => l.includes('rsi/STOP'))).toBe(true);
  });
});

describe('② 子进程:KIT_TMP + 空写入根(KIT_WRITE_ROOTS=:)', () => {
  it('只读命令退出码 / 输出与进程内一致且没有 write_denied;对照:stop 在同一子进程模式下退 3 write_denied,默认写入根下成功', async () => {
    const f = await populated('zw-proc-');
    const script = await buildRoChild(f.tmp);
    const base = { ...f.env, PATH: '/usr/bin:/bin' };
    const denied = { ...base, KIT_WRITE_ROOTS: ':' };
    const before = await treeOf(f.dir);
    for (const argv of [
      ['rsi', 'status', '--json'],
      ['rsi', 'status'],
      ['rsi', 'projects'],
      ['rsi', 'projects', '--json'],
    ]) {
      const inproc = await runMain(f, argv);
      const child = runRoChild(script, { argv, env: denied, cwd: f.dir });
      expect(child.code, argv.join(' ')).toBe(inproc.code);
      expect(child.out).toBe(inproc.out);
      expect(child.err).toBe(inproc.err);
      expect(child.err).not.toContain('write_denied');
    }
    expect(await treeOf(f.dir)).toEqual(before);
    // 对照
    const stopDenied = runRoChild(script, { argv: ['rsi', 'stop'], env: denied, cwd: f.dir });
    expect(stopDenied.code).toBe(3);
    expect(stopDenied.err).toBe('RSI_FAIL_CLOSED reason=write_denied\n');
    expect(await treeOf(f.dir)).toEqual(before);
    const stopOk = runRoChild(script, { argv: ['rsi', 'stop'], env: base, cwd: f.dir });
    expect(stopOk.code).toBe(0);
  }, 120_000);
});

const READONLY_ENTRIES = ['src/rsi/status.ts', 'src/rsi/projects.ts', 'src/rsi/services/open.ts'];
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
  'withRsiLockIfGated',
  'recoverSnapshot',
  'commitSnapshot',
  'commitUnderLock',
  'writeCountsProjection',
  'createExclusive',
  'appendFile',
  'mkdirp',
  'runSync',
  'runSelf',
  'loadSalt',
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

describe('③ 静态:只读入口的 import 闭包(按闭包,不只查入口文件)', () => {
  for (const entry of READONLY_ENTRIES) {
    for (const includeTypes of [false, true]) {
      it(`${entry}(${includeTypes ? '含类型依赖' : '运行时依赖'}):不含写出口 / 锁 / 快照写侧 / 子进程出口文件,无写相关标识符,无动态 import`, () => {
        const c = closureOf([entry], { includeTypes });
        expect(
          [...c.files].filter((f) => WRITE_FILES.includes(f) || f.startsWith('src/update/')),
        ).toEqual([]);
        expect(identHits(c, WRITE_IDENTS)).toEqual([]);
        expect(c.dynamic).toEqual([]);
        expect(c.unresolved).toEqual([]);
        // 外部依赖只有白名单;node:fs 只由 read-fs.ts 引入(其它文件不得直接碰文件系统)
        expect(externalSpecs(c).filter((e) => !ALLOWED_EXTERNALS.includes(e))).toEqual([]);
        expect(importersOf(c, 'node:fs')).toEqual(['src/io/read-fs.ts']);
        expect(importersOf(c, 'node:fs/promises')).toEqual(['src/io/read-fs.ts']);
      });
    }
  }

  it('对照:stop 的闭包含 safe-fs 与 rsi-dir,出现 createExclusive;但不含 lock.ts / snapshot.ts / with-lock.ts,也没有拿锁 / 恢复快照的标识符', () => {
    const c = closureOf(['src/rsi/stop.ts']);
    expect(c.files.has('src/io/safe-fs.ts')).toBe(true);
    expect(c.files.has('src/rsi/rsi-dir.ts')).toBe(true);
    expect(identHits(c, ['createExclusive']).length).toBeGreaterThan(0);
    for (const f of [
      'src/rsi/lock.ts',
      'src/rsi/snapshot.ts',
      'src/rsi/with-lock.ts',
      'src/io/exec.ts',
    ]) {
      expect(c.files.has(f), f).toBe(false);
    }
    expect(
      identHits(c, [
        'acquireRsiLock',
        'withRsiLock',
        'withRsiLockIfGated',
        'recoverSnapshot',
        'commitSnapshot',
        'runSync',
        'runSelf',
      ]),
    ).toEqual([]);
  });

  it('对照:审计工具自己能报出——re-export 链带进 safe-fs、动态 import、require、含类型依赖的 lock.ts', () => {
    const virtual = {
      'src/rsi/__sim_a.ts': "export { x } from './__sim_b.js';\n",
      'src/rsi/__sim_b.ts':
        "import { writeFile } from '../io/safe-fs.js';\nexport const x = writeFile;\n",
      'src/rsi/__sim_c.ts': "export async function f() { return import('../io/safe-fs.js'); }\n",
      'src/rsi/__sim_d.ts': "const m = require('node:fs'); void m;\n",
      'src/rsi/__sim_e.ts':
        "import type { RsiLockHandle } from './lock.js';\nexport type T = RsiLockHandle;\n",
      'src/rsi/__sim_f.ts':
        "import { acquireRsiLock } from './lock-read.js';\nexport const y = acquireRsiLock;\n",
    };
    const a = closureOf(['src/rsi/__sim_a.ts'], { virtual });
    expect(a.files.has('src/io/safe-fs.ts')).toBe(true);
    expect(identHits(a, ['writeFile'])).toContain('src/rsi/__sim_b.ts:writeFile');
    const c = closureOf(['src/rsi/__sim_c.ts'], { virtual });
    expect(c.files.has('src/io/safe-fs.ts')).toBe(true); // 字面量动态 import 也算进闭包
    expect(closureOf(['src/rsi/__sim_d.ts'], { virtual }).dynamic).toEqual([
      'src/rsi/__sim_d.ts:require()',
    ]);
    expect(closureOf(['src/rsi/__sim_e.ts'], { virtual }).files.has('src/rsi/lock.ts')).toBe(false); // 运行时口径
    expect(
      closureOf(['src/rsi/__sim_e.ts'], { virtual, includeTypes: true }).files.has(
        'src/rsi/lock.ts',
      ),
    ).toBe(true);
    expect(identHits(closureOf(['src/rsi/__sim_f.ts'], { virtual }), WRITE_IDENTS)).toEqual([
      'src/rsi/__sim_f.ts:acquireRsiLock',
    ]);
  });
});

describe('③b 唯一碰 node:fs 的闭包文件 read-fs.ts 里没有直接写类调用(AST)', () => {
  it('src/io/read-fs.ts:无写类 fs 成员、open 的 flags 只有 O_RDONLY 组合', () => {
    expect(fsWriteUses('src/io/read-fs.ts', readTextSync(`${ROOT}/src/io/read-fs.ts`))).toEqual([]);
  });

  it('对照:审计能报出 fs.writeFileSync / fsp.writeFile、带 O_CREAT 的 open、字符串模式的 open、缺 O_RDONLY 的 open、句柄上的 write / chmod', () => {
    const bad = [
      "import * as fs from 'node:fs';",
      "fs.writeFileSync('/x', 'y');",
      "await fsp.writeFile('/x', 'y');",
      "await fsp.open('/x', fs.constants.O_RDONLY | fs.constants.O_CREAT);",
      "fs.openSync('/x', 'w');",
      "await fsp.open('/x', NOFOLLOW);",
      'await h.write(buf);',
      'await h.chmod(0o600);',
      "await fsp.rename('/a', '/b');",
    ].join('\n');
    expect(fsWriteUses('x.ts', bad).map((u) => u.split(':')[1])).toEqual([
      '.writeFileSync',
      '.writeFile',
      'open(fs.constants.O_RDONLY | fs.constants.O_CREAT)',
      "open('w')",
      'open(NOFOLLOW)',
      '.write',
      '.chmod',
      '.rename',
    ]);
    // 对照:合规写法不报
    expect(
      fsWriteUses('ok.ts', 'await fsp.open(p, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);'),
    ).toEqual([]);
  });
});

describe('④ 子进程出口调用次数为 0(vi.mock 包住 exec.ts)', () => {
  it('只读命令跑完 runSync / runSelf 调用次数仍为 0;对照:直接调用 runSync 计 1', async () => {
    const f = await populated('zw-exec-');
    execCalls.runSync = 0;
    execCalls.runSelf = 0;
    for (const argv of READONLY_ARGVS) await runMain(f, argv);
    expect(execCalls).toEqual({ runSync: 0, runSelf: 0 });
    // 对照:被 mock 包住的 runSync 与产品代码用的是同一个模块实例(直接调一次,计数 +1)
    runSync(f.io, 'git', ['--version']);
    expect(execCalls.runSync).toBe(1);
  });
});

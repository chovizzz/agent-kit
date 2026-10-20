/**
 * A21–A24 验收脚本自身的测试(脚本的纯函数部分;脚本对 dist 的实跑由 ops/accept-p1.sh 负责):
 *  - A21 脚本的"逐条核对原因码"逻辑真的会报错(正向控制);原因码抽取可用;
 *  - A22 的 import 图分析器对真实源码给出预期结论,对反例(reflect 命令、合成坏例)能报出;白名单被放宽会报;
 *  - A24 的变异表:核心 9 处,每处的替换文本在当前源码里恰好匹配 1 次(防漂移),标记状态机;
 *  - A5 的包装脚本会在合成仓库被写入时退出 97。
 * 这些脚本是 .mjs,按本目录惯例在子进程里求值(callLib / evalLib),不直接 import。
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exists, readTextSync } from '../../src/io/read-fs.js';
import {
  callLib,
  commitAll,
  evalLib,
  guardRealHome,
  makeFx,
  LIB,
  REPO_ROOT,
  SAFE_PATH,
} from './helpers.js';

guardRealHome();

describe('A21 矩阵脚本', () => {
  it('A21 的原因码核对会真的报错:给错原因码 / 该拒却通过 / 字段不符 / 抛异常 / 回显文本,各产生问题(正向控制)', () => {
    const r = evalLib(
      'a21.mjs',
      `(m) => {
        const mk = (run, expect) => m.evalInvalid({ id: 't', run, expect });
        return {
          wrong: mk(() => ({ ok: false, reasons: ['A'], fields: [] }), { reasons: ['B'] }).length,
          right: mk(() => ({ ok: false, reasons: ['B'], fields: [] }), { reasons: ['B'] }).length,
          passed: mk(() => ({ ok: true, reasons: [], fields: [] }), { reasons: ['B'] }).length,
          fieldWrong: mk(() => ({ ok: false, reasons: ['B'], fields: ['x'] }), { reasons: ['B'], fields: ['y'] }).length,
          threw: mk(() => { throw new Error('boom'); }, { reasons: ['B'] }).length,
          leak: mk(() => ({ ok: false, reasons: ['B'], fields: [], note: 'SECRET' }), { reasons: ['B'], noLeak: ['SECRET'] }).length,
        };
      }`,
    ) as Record<string, number>;
    expect(r).toEqual({ wrong: 1, right: 0, passed: 1, fieldWrong: 1, threw: 1, leak: 1 });
  });

  it('合法夹具的核对:被拒 → 问题;通过 → 无问题', () => {
    const r = evalLib(
      'a21.mjs',
      `(m) => ({
        rejected: m.evalValid({ id: 'v', run: () => ({ ok: false, reasons: ['X'], fields: [] }), expect: { ok: true } }).length,
        passed: m.evalValid({ id: 'v', run: () => ({ ok: true, reason: 'OK', reasons: [], fields: [] }), expect: { ok: true } }).length,
      })`,
    ) as Record<string, number>;
    expect(r).toEqual({ rejected: 1, passed: 0 });
  });

  it('reasonsInSource 能从编译产物里抽出原因码(抽取失效会让 A21 的反向核对变空)', () => {
    const r = evalLib(
      'a21.mjs',
      `(m) => m.reasonsInSource("mk('C1', [{ reason: 'HIDDEN_CHARS', field: 'x' }]);\\nreason: dup ? 'AAA_BBB' : 'CCC_DDD',\\n")`,
    );
    expect(r).toEqual(['AAA_BBB', 'CCC_DDD', 'HIDDEN_CHARS']);
  });
});

describe('A22 import 图与白名单', () => {
  it('真实源码:三条命令的闭包不含 llm-exec / reflect/backends,child_process 只在 exec.ts,源码白名单恰为 [git]', () => {
    const r = evalLib(
      'a22.mjs',
      `(m) => m.staticChecks(${JSON.stringify(REPO_ROOT)}, undefined)`,
    ) as { problems: string[]; notes: string[] };
    expect(r.problems).toEqual([]);
    expect(r.notes).toHaveLength(3);
  });

  it('分析器自身的对照:reflect 命令报出 llm-exec / backends;合成坏例逐种被发现;注释里的 import 不误报', () => {
    const r = evalLib(
      'a22.mjs',
      `async (m) => {
        const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
        const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'a22ctl-'));
        try { return m.analyzerControls(${JSON.stringify(REPO_ROOT)}, tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
      }`,
    );
    expect(r).toEqual([]);
  });

  it('白名单被放宽 → 报问题:源码里多了 curl 抽得出来;运行时白名单不是 [git] 时 staticChecks 报错', () => {
    const r = evalLib(
      'a22.mjs',
      `(m) => ({
        real: m.execAllowlistFromSource(${JSON.stringify(readTextSync(path.join(REPO_ROOT, 'src/io/exec.ts')))}),
        wide: m.execAllowlistFromSource("export const EXEC_ALLOWLIST: readonly string[] = ['git', 'curl'];"),
        runtime: m.staticChecks(${JSON.stringify(REPO_ROOT)}, { EXEC_ALLOWLIST: ['git', 'curl'] }).problems,
      })`,
    ) as { real: string[]; wide: string[]; runtime: string[] };
    expect(r.real).toEqual(['git']);
    expect(r.wide).toEqual(['git', 'curl']);
    expect(r.runtime.join('|')).toContain('运行时 EXEC_ALLOWLIST');
  });
});

describe('A24 变异表与标记', () => {
  it('核心九处 L1–L9;每处的 find 在当前源码里恰好匹配 1 次(防漂移),且测试文件存在', async () => {
    const m = evalLib('a24.mjs', '(m) => ({ ids: m.A24_IDS, muts: m.MUTATIONS })') as {
      ids: string[];
      muts: {
        id: string;
        core?: boolean;
        edits: { file: string; find: string; replace: string }[];
        tests: string[];
        redTitles: string[];
      }[];
    };
    expect(m.muts.filter((x) => x.core).map((x) => x.id)).toEqual(m.ids);
    expect(m.ids).toHaveLength(9);
    for (const x of m.muts) {
      expect(x.edits.length, x.id).toBeGreaterThan(0);
      expect(x.redTitles.length, `${x.id} redTitles`).toBeGreaterThan(0);
      for (const t of x.tests)
        expect(await exists(path.join(REPO_ROOT, t)), `${x.id} ${t}`).toBe(true);
      for (const e of x.edits) {
        const text = readTextSync(path.join(REPO_ROOT, e.file));
        expect(text.split(e.find).length - 1, `${x.id} ${e.file}`).toBe(1);
        expect(e.replace, `${x.id} replace 必须与 find 不同`).not.toBe(e.find);
      }
    }
  });

  const marker = (head: string, over: string[] = []): string =>
    [
      `head: ${head}`,
      'result: 9/9 red',
      ...['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'].map((i) => `${i}: red`),
      ...over,
      '',
    ].join('\n');

  it('标记状态机:todo / done / stale / invalid(缺行、多余内容、result 不对,A20 的 6/6 标记不能冒充)', async () => {
    const fx = await makeFx('a24-');
    const head = await commitAll(fx);
    const st = (): { state: string } =>
      callLib('a24.mjs', 'a24Status', [[fx.root]])[0] as { state: string };
    expect(st().state).toBe('todo');
    await fx.put('.state/accept/a24.done', marker(head));
    expect(st().state).toBe('done');
    await fx.put('.state/accept/a24.done', marker('0'.repeat(40)));
    expect(st().state).toBe('stale');
    await fx.put('.state/accept/a24.done', marker(head, ['extra: 1']));
    expect(st().state).toBe('invalid');
    await fx.put('.state/accept/a24.done', marker(head).replace('L4: red\n', ''));
    expect(st().state).toBe('invalid');
    await fx.put('.state/accept/a24.done', marker(head).replace('9/9 red', '8/9 red'));
    expect(st().state).toBe('invalid');
    await fx.put('.state/accept/a24.done', marker(head).replace('L2: red', 'L2: green'));
    expect(st().state).toBe('invalid');
    await fx.put('.state/accept/a24.done', marker(head).replace('9/9 red', '6/6 red'));
    expect(st().state).toBe('invalid');
    // 前缀匹配会放过的多余内容:整行必须精确匹配
    await fx.put(
      '.state/accept/a24.done',
      marker(head).replace('result: 9/9 red', 'result: 9/9 red 假的'),
    );
    expect(st().state).toBe('invalid');
    await fx.put('.state/accept/a24.done', marker(head, [`head: ${head}`]));
    expect(st().state).toBe('invalid');
    await fx.put('.state/accept/a24.done', marker(head).replace('L3: red', 'L3: red 假的'));
    expect(st().state).toBe('invalid');
    // 正向对照:同一份标记原样仍是 done
    await fx.put('.state/accept/a24.done', marker(head));
    expect(st().state).toBe('done');
  });

  it('--write-marker 在工作树不干净时拒绝(退出 4,不跑任何变异、不写标记)', async () => {
    const fx = await makeFx('a24dirty-');
    await commitAll(fx);
    await fx.put('untracked.txt', 'dirty\n');
    const r = spawnSync(
      process.execPath,
      [path.join(LIB, 'a24.mjs'), '--run', '--write-marker', '--root', fx.root],
      { encoding: 'utf8', timeout: 60_000, env: { PATH: SAFE_PATH, KIT_TMP: fx.kit } },
    );
    expect(r.status).toBe(4);
    expect(r.stdout).toContain('工作树不干净');
    expect(await exists(path.join(fx.root, '.state', 'accept', 'a24.done'))).toBe(false);
  });
});

describe('A5 包装脚本(attest/promote/retire 干跑)', () => {
  it('命令前后合成仓库的树哈希不同 → 退出 97;不变 → 透传子进程退出码(正向控制)', async () => {
    const fx = await makeFx('a5wrap-');
    const source = evalLib('a5.mjs', '(m) => m.WRAPPER_SOURCE') as string;
    const wrapper = await fx.put('wrapper.mjs', source);
    await fx.put('synth/a.txt', 'x\n');
    const writer = await fx.put(
      'writer-cli.mjs',
      "import * as fs from 'node:fs'; import * as path from 'node:path'; const root = process.argv[process.argv.indexOf('--root') + 1]; fs.writeFileSync(path.join(root, 'new.txt'), 'y'); process.exit(0);",
    );
    const quiet = await fx.put('quiet-cli.mjs', 'process.exit(0);');
    const failing = await fx.put('failing-cli.mjs', 'process.exit(3);');
    const synth = path.join(fx.root, 'synth');
    const go = (cli: string) =>
      spawnSync(process.execPath, [wrapper, cli, synth, 'promote'], {
        encoding: 'utf8',
        env: { PATH: SAFE_PATH },
      });
    expect(go(quiet).status).toBe(0);
    expect(go(failing).status).toBe(3);
    const w = go(writer);
    expect(w.status).toBe(97);
    expect(w.stderr).toContain('合成仓库在干跑后发生了变化');
  });
});

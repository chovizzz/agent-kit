/**
 * A25–A28 验收脚本自身的测试(脚本的纯函数部分;脚本对 dist 的实跑由 ops/accept-p1.sh 负责):
 *  - A25 的往返比较函数:对改动、缺失、非空新增目录、mtime 变化都报,对状态目录豁免(正向控制,防止比较静默变空);
 *  - A26 的命令清单检查:A5 清单含 doctor 与 sync 的干跑形态;坏清单被报;zero-write 的命令环境固定 KIT_AUTO_UPDATE=0;
 *  - A28 的变异表:每处的替换文本在当前源码里恰好匹配 1 次(防漂移)、靶子测试文件存在;标记状态机;脏树拒写标记。
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

describe('A25 往返比较函数', () => {
  const T = `
    const tree = (files, dirs = []) => ({
      files: new Map(Object.entries(files)),
      dirs: new Set(dirs),
      mtimes: new Map([...Object.keys(files), ...dirs].map((k) => [k, 1])),
    });
  `;
  const run = (body: string): unknown =>
    evalLib(
      'sk-world.mjs',
      `(m) => { ${T} const { compareRoundtrip, compareExact } = m; ${body} }`,
    );

  it('一致 => 无问题;改内容 / 改权限 / 缺失 / 多出 / 原有目录消失 / 新增目录含文件 => 各报出(正向控制)', () => {
    const r = run(`
      const base = tree({ 'a.txt': '644 x', 'd/b.txt': '600 y' }, ['d']);
      return {
        same: compareRoundtrip(base, tree({ 'a.txt': '644 x', 'd/b.txt': '600 y' }, ['d'])),
        content: compareRoundtrip(base, tree({ 'a.txt': '644 z', 'd/b.txt': '600 y' }, ['d'])),
        mode: compareRoundtrip(base, tree({ 'a.txt': '600 x', 'd/b.txt': '600 y' }, ['d'])),
        missing: compareRoundtrip(base, tree({ 'a.txt': '644 x' }, ['d'])),
        extra: compareRoundtrip(base, tree({ 'a.txt': '644 x', 'd/b.txt': '600 y', 'n.txt': '644 q' }, ['d'])),
        dirGone: compareRoundtrip(base, tree({ 'a.txt': '644 x', 'd/b.txt': '600 y' }, [])),
        newDirEmpty: compareRoundtrip(base, tree({ 'a.txt': '644 x', 'd/b.txt': '600 y' }, ['d', 'n', 'n/m'])),
        newDirFile: compareRoundtrip(base, tree({ 'a.txt': '644 x', 'd/b.txt': '600 y', 'n/f.txt': '644 q' }, ['d', 'n'])),
      };
    `) as Record<string, string[]>;
    expect(r['same']).toEqual([]);
    expect(r['newDirEmpty']).toEqual([]); // 新增的空目录(含嵌套)是允许的
    for (const k of ['content', 'mode', 'missing', 'extra', 'dirGone', 'newDirFile'])
      expect(r[k]?.length, k).toBeGreaterThan(0);
    expect(r['newDirFile']?.join()).toContain('不为空');
  });

  it('compareExact:mtime 变化 / 内容变化 / 新增 / 消失 各报出;完全相同 => 无问题', () => {
    const r = run(`
      const a = tree({ 'f': '644 x' }, ['d']);
      const withMtime = (t, k, v) => { const c = { ...t, mtimes: new Map(t.mtimes) }; c.mtimes.set(k, v); return c; };
      return {
        same: compareExact(a, tree({ 'f': '644 x' }, ['d'])),
        mtime: compareExact(a, withMtime(a, 'f', 2)),
        dirMtime: compareExact(a, withMtime(a, 'd', 2)),
        content: compareExact(a, tree({ 'f': '644 y' }, ['d'])),
        added: compareExact(a, tree({ 'f': '644 x', 'g': '644 x' }, ['d'])),
        gone: compareExact(a, tree({}, ['d'])),
      };
    `) as Record<string, string[]>;
    expect(r['same']).toEqual([]);
    for (const k of ['mtime', 'dirMtime', 'content', 'added', 'gone'])
      expect(r[k]?.length, k).toBeGreaterThan(0);
    expect(r['mtime']?.[0]).toContain('mtime 变化');
  });
});

describe('A26 命令清单与环境', () => {
  it('A5 命令清单含 doctor 与 sync 的干跑形态,且通过 A26 的清单检查', () => {
    const text = callLib('a5.mjs', 'commandsText', [['proj', '{REPO}/dist/cli.js']])[0] as string;
    const lines = text.split('\n');
    expect(lines.some((l) => /--root \{REPO\} doctor$/.test(l))).toBe(true);
    expect(lines.some((l) => /--root \{REPO\} sync$/.test(l))).toBe(true);
    expect(callLib('a26.mjs', 'checkCommandList', [[text]])[0]).toEqual([]);
  });

  it('清单检查对坏清单报出:缺 doctor / 缺 sync / 带 --write / --uninstall / 含 update(正向控制)', () => {
    const [noDoctor, noSync, write, uninstall, upd] = callLib('a26.mjs', 'checkCommandList', [
      ['{NODE} c --root {REPO} sync\n'],
      ['{NODE} c --root {REPO} doctor\n'],
      ['{NODE} c --root {REPO} doctor\n{NODE} c --root {REPO} sync --write\n'],
      ['{NODE} c --root {REPO} doctor\n{NODE} c --root {REPO} sync --uninstall\n'],
      [
        '{NODE} c --root {REPO} doctor\n{NODE} c --root {REPO} sync\n{NODE} c --root {REPO} update\n',
      ],
    ]) as string[][];
    expect(noDoctor?.join()).toContain('缺 doctor');
    expect(noSync?.join()).toContain('缺 sync');
    expect(write?.join()).toContain('非干跑形态');
    expect(uninstall?.join()).toContain('非干跑形态');
    expect(upd?.join()).toContain('非干跑形态');
  });

  it('zero-write 的命令环境固定 KIT_AUTO_UPDATE=0', () => {
    const env = evalLib(
      '../../lib/zero-write.mjs',
      `(m) => m.buildEnv({ node: '/usr/bin/node', repo: '/r', noNet: false }, { fakeHome: '/h', tmpdir: '/t', kitTmp: '/k', nonce: 'n' })`,
    ) as Record<string, string>;
    expect(env['KIT_AUTO_UPDATE']).toBe('0');
  });
});

describe('A28 变异表与标记', () => {
  interface Mut {
    id: string;
    edits: { file: string; find: string; replace: string }[];
    tests: string[];
    redTitles: string[];
  }
  const table = (): { ids: string[]; muts: Mut[] } =>
    evalLib('a28.mjs', '(m) => ({ ids: m.A28_IDS, muts: m.MUTATIONS })') as {
      ids: string[];
      muts: Mut[];
    };

  it('至少 6 处(现为 8 处);每处 find 在当前源码里恰好匹配 1 次(防漂移),靶子测试文件存在', async () => {
    const { ids, muts } = table();
    expect(muts.map((x) => x.id)).toEqual(ids);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    for (const x of muts) {
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
      'result: 8/8 red',
      ...['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'].map((i) => `${i}: red`),
      ...over,
      '',
    ].join('\n');

  it('标记状态机:todo / done / stale / invalid(缺行、多余内容、result 不对、A24 的 9/9 标记不能冒充)', async () => {
    const fx = await makeFx('a28-');
    const head = await commitAll(fx);
    const st = (): { state: string } =>
      callLib('a28.mjs', 'a28Status', [[fx.root]])[0] as { state: string };
    expect(st().state).toBe('todo');
    await fx.put('.state/accept/a28.done', marker(head));
    expect(st().state).toBe('done');
    await fx.put('.state/accept/a28.done', marker('0'.repeat(40)));
    expect(st().state).toBe('stale');
    await fx.put('.state/accept/a28.done', marker(head, ['extra: 1']));
    expect(st().state).toBe('invalid');
    await fx.put('.state/accept/a28.done', marker(head).replace('S4: red\n', ''));
    expect(st().state).toBe('invalid');
    await fx.put('.state/accept/a28.done', marker(head).replace('8/8 red', '7/8 red'));
    expect(st().state).toBe('invalid');
    await fx.put('.state/accept/a28.done', marker(head).replace('S2: red', 'S2: green'));
    expect(st().state).toBe('invalid');
    await fx.put('.state/accept/a28.done', marker(head).replace('8/8 red', '9/9 red'));
    expect(st().state).toBe('invalid');
    await fx.put(
      '.state/accept/a28.done',
      marker(head).replace('result: 8/8 red', 'result: 8/8 red 假的'),
    );
    expect(st().state).toBe('invalid');
    await fx.put('.state/accept/a28.done', marker(head, [`head: ${head}`]));
    expect(st().state).toBe('invalid');
    // 正向对照:同一份标记原样仍是 done
    await fx.put('.state/accept/a28.done', marker(head));
    expect(st().state).toBe('done');
  });

  it('--run --write-marker 在工作树不干净时拒绝(退出 4,不跑任何变异、不写标记)', async () => {
    const fx = await makeFx('a28dirty-');
    await commitAll(fx);
    await fx.put('untracked.txt', 'dirty\n');
    const r = spawnSync(
      process.execPath,
      [path.join(LIB, 'a28.mjs'), '--run', '--write-marker', '--root', fx.root],
      { encoding: 'utf8', timeout: 60_000, env: { PATH: SAFE_PATH, KIT_TMP: fx.kit } },
    );
    expect(r.status).toBe(4);
    expect(r.stdout).toContain('工作树不干净');
    expect(await exists(path.join(fx.root, '.state', 'accept', 'a28.done'))).toBe(false);
  });
});

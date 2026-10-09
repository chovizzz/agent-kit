import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { exists } from '../../src/io/read-fs.js';
import { callLib, commitAll, guardRealHome, makeFx, REPO_ROOT, runEntry } from './helpers.js';
import type { Fx } from './helpers.js';

guardRealHome();

const IDS = [
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
  'A7',
  'A8',
  'A9',
  'A10',
  'A11',
  'A12',
  'A13',
  'A14',
  'A15',
];

describe('ops/accept-p0.sh --list', () => {
  it('列 15 项,编号与 §1.2 一致,A13 是人工完成项并显示状态', async () => {
    const fx = await makeFx('entry-');
    const r = runEntry(['--list', '--root', fx.root], fx.env());
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(15);
    expect(lines.map((l) => l.split(/\s+/)[0])).toEqual(IDS);
    const a13 = lines[12] ?? '';
    expect(a13).toContain('【人工完成项】');
    expect(a13).toContain('状态:未做');
    expect(lines.filter((l) => l.includes('人工完成项'))).toHaveLength(1);
  });
  it('每个项(含 A13 的清单文档)都指向一个真实存在的文件', async () => {
    const items = callLib('accept-p0.mjs', 'listLines', [['/nonexistent-root']])[0] as string[];
    expect(items).toHaveLength(15);
    for (const l of items) {
      const m = /ops\/accept\/(\S+)$/.exec(l);
      expect(m, l).not.toBeNull();
      expect(await exists(path.join(REPO_ROOT, 'ops', 'accept', m?.[1] ?? 'missing')), l).toBe(
        true,
      );
    }
    // 反例:不存在的路径探测会失败
    expect(await exists(path.join(REPO_ROOT, 'ops', 'accept', 'a99-nope.sh'))).toBe(false);
  });
});

async function marker(fx: Fx, text: string): Promise<void> {
  await fx.put('.state/accept/a13.done', text);
}
const status = (root: string) =>
  callLib('accept-p0.mjs', 'a13Status', [[root]])[0] as { state: string; detail: string };
const good = (head: string) =>
  `head: ${head}\nresult: 5/5 red\n${[1, 2, 3, 4, 5].map((i) => `M${i}: red`).join('\n')}\n`;

describe('A13 状态标记', () => {
  it('无标记 => todo;有效标记且 HEAD 相符 => done(正向控制)', async () => {
    const fx = await makeFx('a13-');
    const head = await commitAll(fx);
    expect(status(fx.root).state).toBe('todo');
    await marker(fx, good(head));
    expect(status(fx.root).state).toBe('done');
    const r = runEntry(['--list', '--root', fx.root], fx.env());
    expect(r.stdout).toContain('状态:已做');
  });
  it.each<[string, (h: string) => string]>([
    ['result 不是 5/5', (h) => good(h).replace('5/5 red', '4/5 red')],
    ['result 后带后缀', (h) => good(h).replace('result: 5/5 red', 'result: 5/5 red but flaky')],
    ['少一个 M', (h) => good(h).replace('M3: red\n', '')],
    ['M 不是 red', (h) => good(h).replace('M2: red', 'M2: green')],
    ['缺 head', () => good('').replace('head: \n', '')],
    ['head 不是 40 位', () => good('abc')],
    ['多余内容', (h) => good(h) + 'note: trust me\n'],
  ])('无效标记:%s => invalid', async (_n, mk) => {
    const fx = await makeFx('a13-');
    const head = await commitAll(fx);
    await marker(fx, mk(head));
    expect(status(fx.root).state).toBe('invalid');
  });
  it('提交之后标记过期 => stale,且 --list 显示未做', async () => {
    const fx = await makeFx('a13-');
    const head = await commitAll(fx);
    await marker(fx, good(head));
    await fx.put('later.txt', 'x\n');
    commitMore(fx);
    expect(status(fx.root).state).toBe('stale');
    expect(runEntry(['--list', '--root', fx.root], fx.env()).stdout).toContain('状态:未做');
  });
});
import { git } from './helpers.js';
function commitMore(fx: Fx): void {
  const home = path.join(fx.dir, 'githome');
  git(fx.root, home, ['add', '-A']);
  git(fx.root, home, ['commit', '-q', '-m', 'more']);
}

describe('ops/accept-p0.sh 汇总', () => {
  it('--only A13 没有标记 => 4(人工项未完成按失败汇总);有效标记 => 0', async () => {
    const fx = await makeFx('entry-');
    const head = await commitAll(fx);
    const r1 = runEntry(['--only', 'A13', '--root', fx.root], fx.env());
    expect(r1.status).toBe(4);
    expect(r1.stdout).toContain('4=未执行,按失败汇总');
    await marker(fx, good(head));
    const r2 = runEntry(['--only', 'a13', '--root', fx.root], fx.env());
    expect(r2.status, r2.stdout).toBe(0);
  });
  it('--only 未知编号 / 缺值 => 2', async () => {
    const fx = await makeFx('entry-');
    expect(runEntry(['--only', 'A99', '--root', fx.root], fx.env()).status).toBe(2);
    expect(runEntry(['--only'], fx.env()).status).toBe(2);
    expect(runEntry(['--bogus'], fx.env()).status).toBe(2);
  });
  it('多项汇总:A3 用不存在的 CLI(4)+ A13 未做(4)=> 4;出现违规 => 1 压过 4', async () => {
    const fx = await makeFx('entry-');
    const r = runEntry(
      ['--only', 'A3,A13', '--root', fx.root, '--cli', path.join(fx.dir, 'nope.js')],
      fx.env(),
    );
    expect(r.status, r.stdout).toBe(4);
    expect(r.stdout).toMatch(/A3\s+NOT-RUN\s+exit=4/);
    expect(r.stdout).toMatch(/A13\s+NOT-RUN\s+exit=4/);
    // A11 在没有 package.json 的根上 => 3(清单被拒);3 压过 4
    const r2 = runEntry(
      ['--only', 'A3,A11', '--root', fx.root, '--cli', path.join(fx.dir, 'nope.js')],
      fx.env(),
    );
    expect(r2.status, r2.stdout).toBe(3);
  });
  it('mergeExit 优先级由 common 测试覆盖;--help 退出 0', async () => {
    const fx = await makeFx('entry-');
    expect(runEntry(['--help'], fx.env()).status).toBe(0);
  });
});

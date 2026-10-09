import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { exists } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { callLib, guardRealHome, makeFx, runScript } from './helpers.js';
import type { Fx } from './helpers.js';

guardRealHome();

const lint = (cmds: string[]): string[][] =>
  callLib(
    'a7.mjs',
    'lintCommand',
    cmds.map((c) => [c]),
  ) as string[][];

describe('A7 只读 lint(allowlist + 引号感知;不是沙箱)', () => {
  it('B15 里常见的只读写法全部通过(正向控制)', () => {
    const ok = [
      "wc -c < ~/.claude/CLAUDE.md | tr -d ' '",
      "LC_ALL=C awk 'BEGIN{f=0} /^```/{f=!f;next} END{print NR>1?1:0}' f",
      "ls -1 ~/.claude/skills | wc -l | tr -d ' '",
      'comm -12 <(ls -1 a | sort) <(ls -1 b | sort) | wc -l',
      "find ~/x -mindepth 1 -maxdepth 1 ! -name '.*' -type l | wc -l",
      'cd ~/x && for n in *; do [ -L "$n" ] && [ ! -e "$n" ] && echo x; done | wc -l',
      'find . -type f -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256',
      'jq -r \'.hooks|keys|join(",")\' ~/.claude/settings.json 2>/dev/null',
      'if diff -rq a b >/dev/null 2>&1; then echo same; else echo drift; fi',
      'n=0; for x in a b; do n=$((n+1)); done; echo $n',
    ];
    for (const [i, p] of lint(ok).entries()) expect(p, ok[i]).toEqual([]);
  });

  it.each([
    ['rm -rf x', '白名单'],
    ['echo hi > f', '重定向'],
    ['cat a >> b', '重定向'],
    ['cat a 2>&1 >out', '重定向'],
    ['echo a &> out', '重定向'],
    ['awk \'{print > "x"}\' f', '禁用构造'],
    ['awk \'BEGIN{system("rm x")}\'', '禁用构造'],
    ['awk \'{ "date" | getline d }\' f', '禁用构造'],
    ['sed -i s/a/b/ f', 'sed -i'],
    ['find . -delete', '删除'],
    ['find . -exec rm {} +', 'find -exec'],
    ['echo "$(rm x)"', '白名单'],
    ['echo `id`', '反引号'],
    ['curl x', '白名单'],
    ['ls | xargs rm', '白名单'],
    ['x=1; python3 -c 1', '白名单'],
    ['tee f', '白名单'],
    ['/usr/local/bin/evil', '路径'],
    ['bash -c "rm x"', '白名单'],
    ['eval ls', '白名单'],
    ['sort a -o out.txt', 'sort'],
    ["sed 'w out.txt' f", 'w/e'],
    ["sed 's/a/b/w out.txt' f", 'w/e'],
    ['sed -n "w out.txt" f', 'w/e'],
    ['awk "BEGIN{system(\\"id\\")}"', '禁用构造'],
    ['cat <<EOF\nx\nEOF', '单行'],
    ["echo 'unclosed", '未闭合'],
  ])('故意写坏:%s => 被拒(%s)', (cmd, why) => {
    const [p] = lint([cmd]) as string[][];
    expect(p?.length, cmd).toBeGreaterThan(0);
    expect(p?.join(' '), cmd).toContain(why);
  });
});

describe('A7 比较规则', () => {
  const cmp = (e: string, a: string) =>
    callLib('a7.mjs', 'compare', [[e, a]])[0] as { ok: boolean; note: string };
  it('精确比对;">=N" 是唯一的显式放宽', () => {
    expect(cmp('5', '5').ok).toBe(true);
    expect(cmp('5', '6').ok).toBe(false);
    expect(cmp('>=5', '7').ok).toBe(true);
    expect(cmp('>=5', '7').note).toContain('+2');
    expect(cmp('>=5', '4').ok).toBe(false);
    expect(cmp('>=5', 'abc').ok).toBe(false);
    expect(cmp('L1=1 L2=5', 'L1=1 L2=5').ok).toBe(true);
    expect(cmp('L1=1 L2=5', 'L1=1 L2=6').ok).toBe(false);
  });
});

const TAB = '\t';
async function setup(rows: [string, string, string][], md: string): Promise<Fx> {
  const fx = await makeFx('a7-');
  const lines = rows.map(([id, cmd, exp]) => [id, cmd, exp, '2026-10-09T01:47:53Z'].join(TAB));
  await fx.put('inventory/commands.sh', '# 说明\n' + lines.join('\n') + '\n');
  await fx.put('inventory/report.md', md);
  await fx.put('data/a.txt', 'one\ntwo\nthree\n');
  return fx;
}
const home = (fx: Fx): string => path.join(fx.dir, 'home');
const a7 = async (fx: Fx, extra: string[] = []) => {
  await safe.mkdirp(fx.ctx, home(fx));
  return runScript(
    'a7-inventory-recount.sh',
    ['--root', fx.root, '--home', home(fx), ...extra],
    fx.env(),
  );
};

describe('A7 复算', () => {
  const OK_ROWS: [string, string, string][] = [
    ['T-001', "wc -l < data/a.txt | tr -d ' '", '3'],
    ['T-002', 'cat data/a.txt | wc -l | tr -d " "', '>=2'],
    ['T-003', 'printf "%s\\n" x y | paste -sd" " -', 'x y'],
  ];
  const MD = '总行数 3 [#T-001];下限 [#T-002];拼接 [#T-003]\n';

  it('全部一致 => 0(正向控制)', async () => {
    const fx = await setup(OK_ROWS, MD);
    const r = await a7(fx);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('复算一致 3/3');
    expect(r.stdout).toContain('+1'); // >= 的差值被列出
  });

  it('期望值被改错(3 -> 4)=> 1', async () => {
    const fx = await setup([['T-001', "wc -l < data/a.txt | tr -d ' '", '4']], '[#T-001]\n');
    const r = await a7(fx);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('T-001');
  });

  it('">=" 不够 => 1', async () => {
    const fx = await setup([['T-002', 'cat data/a.txt | wc -l | tr -d " "', '>=9']], '[#T-002]\n');
    expect((await a7(fx)).status).toBe(1);
  });

  it('报告引用了不存在的编号 / 完全没有引用 => 1', async () => {
    const fx = await setup(OK_ROWS, MD + '多出来的 [#T-999]\n');
    const r = await a7(fx);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('T-999');
    const none = await setup(OK_ROWS, '没有任何引用\n');
    expect((await a7(none)).status).toBe(1);
  });

  it('不安全的命令 => 3,且根本没有被执行(哨兵文件还在)', async () => {
    const fx = await setup([['T-001', 'rm data/a.txt', '']], '[#T-001]\n');
    const r = await a7(fx);
    expect(r.status, r.stdout).toBe(3);
    expect(r.stdout).toContain('只读检查');
    expect(await exists(path.join(fx.root, 'data/a.txt'))).toBe(true);
  });

  it.each([
    ['不是 4 列', 'T-001\techo 1\t1\n'],
    [
      '编号重复',
      'T-001\techo 1\t1\t2026-10-09T01:47:53Z\nT-001\techo 1\t1\t2026-10-09T01:47:53Z\n',
    ],
    ['时点不是 UTC ISO', 'T-001\techo 1\t1\tyesterday\n'],
    ['>= 格式错', 'T-001\techo 1\t>=x\t2026-10-09T01:47:53Z\n'],
    ['没有任何命令', '# 只有注释\n'],
  ])('commands.sh 格式坏:%s => 3', async (_n, text) => {
    const fx = await makeFx('a7-');
    await fx.put('inventory/commands.sh', text);
    await fx.put('inventory/report.md', '[#T-001]\n');
    const r = await a7(fx);
    expect(r.status, r.stdout).toBe(3);
  });

  it('commands.sh 缺失 => 3', async () => {
    const fx = await makeFx('a7-');
    expect((await a7(fx)).status).toBe(3);
  });

  it('命令引用的 HOME 下输入不存在 => 4(未执行),不是"不一致"也不是通过', async () => {
    const fx = await setup(
      [['T-001', "wc -c < ~/.nothing-here/file | tr -d ' '", '0']],
      '[#T-001]\n',
    );
    const r = await a7(fx);
    expect(r.status, r.stdout).toBe(4);
    expect(r.stdout).toContain('输入不存在');
  });

  it('stderr 被吞掉的管道失败(2>/dev/null)也 => 4,输出恰好等于期望也不行', async () => {
    const fx = await setup(
      [['T-001', 'cat data/missing.txt 2>/dev/null | wc -l | tr -d " "', '0']],
      '[#T-001]\n',
    );
    const r = await a7(fx);
    expect(r.status, r.stdout).toBe(4);
    expect(r.stdout).toContain('不能当作复算一致');
  });

  it('命令自己报错(pipefail + stderr)=> 4,即使输出恰好等于期望(管道失败不能假绿)', async () => {
    const fx = await setup(
      [['T-001', 'cat data/missing.txt | wc -l | tr -d " "', '0']],
      '[#T-001]\n',
    );
    const r = await a7(fx);
    expect(r.status, r.stdout).toBe(4);
    expect(r.stdout).toContain('不能当作复算一致');
  });
});

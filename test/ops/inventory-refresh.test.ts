// A7 基线刷新工具(ops/inventory-refresh.mjs)的黑盒测试。
// 全部在仓库外的合成 HOME / 合成仓库根里跑;值在运行时拼装;真实 HOME 只做元数据(lstat)前后比对。
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRealHome } from '../../src/io/paths.js';
import { exists, lstat, readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { makeTempDir, REPO_ROOT } from '../helpers/tmp.js';
import { runNode } from './helpers.js';
import type { Run } from './helpers.js';
import type { IoContext } from '../../src/io/paths.js';

const TOOL = path.join(REPO_ROOT, 'ops', 'inventory-refresh.mjs');
const A7 = path.join(REPO_ROOT, 'ops', 'accept', 'lib', 'a7.mjs');
const NOW = '2030-01-02T03:04:05Z';

interface World {
  ctx: IoContext;
  dir: string;
  home: string;
  root: string;
  backup: string;
  put(rel: string, text: string): Promise<void>;
  inv(rel: string, text: string): Promise<void>;
  readInv(rel: string): Promise<string>;
  snapshot(): Promise<Record<string, string>>;
}

async function world(): Promise<World> {
  const { ctx, dir } = await makeTempDir('inv-refresh-');
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'repo');
  const backup = path.join(dir, 'backup');
  await safe.mkdirp(ctx, home);
  await safe.mkdirp(ctx, path.join(root, 'inventory'));
  const put = async (rel: string, text: string): Promise<void> => {
    const f = path.join(home, rel);
    await safe.mkdirp(ctx, path.dirname(f));
    await safe.writeFile(ctx, f, text);
  };
  const inv = async (rel: string, text: string): Promise<void> => {
    await safe.writeFile(ctx, path.join(root, 'inventory', rel), text);
  };
  const readInv = (rel: string): Promise<string> => readText(path.join(root, 'inventory', rel));
  const snapshot = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const e of await readDir(path.join(root, 'inventory')))
      out[e.name] = await readText(path.join(root, 'inventory', e.name));
    return out;
  };
  return { ctx, dir, home, root, backup, put, inv, readInv, snapshot };
}

function tool(w: World, args: string[] = [], env: Record<string, string> = {}): Run {
  return runNode([TOOL, '--root', w.root, '--home', w.home, '--now', NOW, ...args], env);
}

function a7(w: World): Run {
  return runNode([A7, '--root', w.root, '--home', w.home]);
}

const tsv = (...cols: string[]): string => cols.join('\t');

// ---------------------------------------------------------------- 合成的 CLAUDE.md(10 节,首行即标题)

function claudeMd(extra: number): string {
  const levels = [1, 2, 3, 3, 2, 3, 3, 2, 2, 2];
  const lines: string[] = [];
  levels.forEach((lv, i) => {
    lines.push(`${'#'.repeat(lv)} h${i}`);
    const body = (i % 3) + 1 + (i === 2 ? extra : 0);
    for (let k = 0; k < body; k++) lines.push(`line ${i}-${k} ${'x'.repeat(i * 3 + k)}`);
  });
  return lines.join('\n') + '\n';
}

async function fakeHome(w: World, extra: number): Promise<void> {
  await w.put('.claude/CLAUDE.md', claudeMd(extra));
  const hooks = ['guard-bash.sh', 'guard-write.sh', 'guard-agent-model.sh'];
  for (const [i, h] of hooks.entries())
    await w.put(`.claude/hooks/${h}`, '#!/bin/sh\n' + 'x'.repeat(10 + i * 7 + extra) + '\n');
  const entries = ['Bash', 'Write', 'Agent'].map((m, i) => ({
    matcher: m,
    hooks: [{ type: 'command', command: `$HOME/.claude/hooks/${hooks[i]}` }],
  }));
  await w.put('.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: entries } }));
  for (const n of ['s1', 's2', 'd1', 'd2', 'x1'])
    await w.put(`.agents/skills/${n}/f.txt`, `agents-${n}\n`);
  await w.put('.agents/skills/d2/g.txt', 'only-agents\n');
  await w.put(
    '.agents/skills/.social-hub-skills.json',
    JSON.stringify({ skills: [{ id: 's1' }, { id: 's2' }] }),
  );
  await w.put(
    '.agents/skills/.geoly/ledger.json',
    JSON.stringify({ entries: [{ artifact: 'a/zz' }] }),
  );
  await w.put('.claude/skills/d1/f.txt', 'agents-d1\n');
  await w.put('.claude/skills/d2/f.txt', 'agents-d2\n');
  await w.put('.claude/skills/c-only/f.txt', 'c\n');
  for (const n of ['s1', 's2']) {
    if (await exists(path.join(w.home, '.claude/skills', n))) continue;
    // 要相对链接(B15-021/022 比较 readlink 原文);safe.symlink 会把目标展开成绝对路径,所以走 ln
    const ln = runNode([
      '-e',
      'require("node:fs").symlinkSync(process.argv[1], process.argv[2])',
      `../../.agents/skills/${n}`,
      path.join(w.home, '.claude/skills', n),
    ]);
    expect(ln.status, ln.stderr).toBe(0);
  }
  await w.put('.kimi-code/skills/d1/f.txt', 'agents-d1\n');
  await w.put('.kimi-code/skills/k-only/f.txt', 'k\n');
  for (const [p, n] of [
    ['pA', 3],
    ['pB', 1],
    ['pC', 2],
  ] as const) {
    await w.put(`.claude/projects/${p}/memory/MEMORY.md`, 'idx\n');
    for (let i = 1; i < n; i++) await w.put(`.claude/projects/${p}/memory/m${i}.md`, 'm\n');
  }
  await w.put('AGENTS.md', 'a'.repeat(30 + extra) + '\n');
  await w.put('workspace/AGENTS.md', 'b'.repeat(20) + '\n');
}

async function copyRealInventory(w: World): Promise<void> {
  const src = path.join(REPO_ROOT, 'inventory');
  for (const e of await readDir(src)) {
    if (e.name === 'commands.sh' || e.name.endsWith('.md'))
      await w.inv(e.name, await readText(path.join(src, e.name)));
  }
}

async function realHomeMeta(): Promise<string> {
  const h = getRealHome();
  const parts: string[] = [];
  for (const rel of ['.claude', '.claude/CLAUDE.md', '.claude/settings.json', '.claude/hooks']) {
    const p = path.join(h, rel);
    if (!(await exists(p))) {
      parts.push(`${rel}:absent`);
      continue;
    }
    const st = await lstat(p);
    parts.push(`${rel}:${st.ino}:${st.size}:${st.mtimeMs}`);
  }
  return parts.join('|');
}

// ---------------------------------------------------------------- 真实 inventory 格式的集成

// 每个用例要起十几次子进程(每次重跑 61 条命令),单独放宽超时
describe('inventory-refresh:真实 inventory 格式 + 合成 HOME', { timeout: 120_000 }, () => {
  it('dry-run 不写任何文件;--apply 后 md 与 commands.sh 一致、A7 通过、再 dry-run 无差异', async () => {
    const meta0 = await realHomeMeta();
    const w = await world();
    await copyRealInventory(w);
    await fakeHome(w, 2);
    const before = await w.snapshot();
    const filesBefore = (await readDir(w.dir)).map((e) => e.name).sort();

    // A7 现状必红(合成 HOME 与 10-09 的期望值全不同)
    expect(a7(w).status).toBe(1);

    const dry = tool(w, ['--backup-dir', w.backup]);
    expect(dry.status, dry.stdout + dry.stderr).toBe(1);
    expect(dry.stdout).toContain('CHANGED B15-001');
    expect(dry.stdout).toContain('dry-run:未写任何文件');
    expect(await w.snapshot()).toEqual(before);
    expect(await exists(w.backup)).toBe(false);
    expect((await readDir(w.dir)).map((e) => e.name).sort()).toEqual(filesBefore);
    expect((await readDir(path.join(w.root, 'inventory'))).map((e) => e.name).sort()).toEqual(
      Object.keys(before).sort(),
    );

    const ap = tool(w, ['--apply', '--backup-dir', w.backup]);
    expect(ap.stdout).toContain(`A7 重跑 exit=0`);
    expect([0, 5], ap.stdout + ap.stderr).toContain(ap.status);

    // 备份 = 原文件
    const saved = (await readDir(w.backup)).map((e) => e.name);
    expect(saved).toEqual(expect.arrayContaining(['commands.sh', 'claude-md-sections.md']));
    for (const name of saved) expect(await readText(path.join(w.backup, name))).toBe(before[name]);
    // 目录里没有残留的临时文件
    for (const e of await readDir(path.join(w.root, 'inventory')))
      expect(e.name).not.toMatch(/\.tmp$/);

    // A7 回绿
    const r7 = a7(w);
    expect(r7.status, r7.stdout).toBe(0);

    // 语义核对:md 里的总字节 / 哈希 / 行数是合成 CLAUDE.md 的真实值
    const claude = await readText(path.join(w.home, '.claude/CLAUDE.md'));
    const bytes = Buffer.byteLength(claude);
    const lines = claude.split('\n').length - 1;
    const sha = createHash('sha256').update(claude).digest('hex');
    const secMd = await w.readInv('claude-md-sections.md');
    expect(secMd).toContain(`${bytes} [#B15-001]`);
    expect(secMd).toContain(`${lines} [#B15-003]`);
    expect(secMd).toContain(`\`${sha}\` [#B15-005]`);
    // 起止行由行数累计重算:最后一节止于总行数
    expect(secMd).toMatch(new RegExp(`\\| \\d+-${lines} +\\|`));
    // 旧哈希 / 旧字节不再残留(正向对照:拷贝来的 before 里确实有它)
    expect(before['claude-md-sections.md']).toContain(
      '92f83c3107d6590619c7dd2790434f76165e145e4f4f20b44d7bf516e7d5cfdf',
    );
    expect(secMd).not.toContain('92f83c3107d6590619c7dd2790434f76165e145e4f4f20b44d7bf516e7d5cfdf');

    // 再 dry-run:无差异
    const again = tool(w);
    expect(again.status, again.stdout).toBe(0);
    expect(again.stdout).toContain('没有需要刷新');

    // 第二阶段(贴近真实场景):只改 CLAUDE.md 与一个 hook 脚本,再刷新一次
    await fakeHome(w, 6);
    const dry2 = tool(w);
    expect(dry2.status, dry2.stdout).toBe(1);
    const ids2 = [...dry2.stdout.matchAll(/CHANGED (B15-\d+):/g)].map((m) => m[1]).sort();
    expect(ids2).toEqual(
      ['001', '002', '003', '004', '005', '009', '010', '011', '012', '049', '050', '051']
        .map((n) => `B15-${n}`)
        .sort(),
    );
    const ap2 = tool(w, ['--apply']);
    expect([0, 5], ap2.stdout).toContain(ap2.status);
    expect(a7(w).status).toBe(0);
    const claude2 = await readText(path.join(w.home, '.claude/CLAUDE.md'));
    const lines2 = claude2.split('\n').length - 1;
    const secMd2 = await w.readInv('claude-md-sections.md');
    expect(secMd2).toContain(`${Buffer.byteLength(claude2)} [#B15-001]`);
    expect(secMd2).toMatch(new RegExp(`\\| \\d+-${lines2} +\\|`));
    expect(secMd2).not.toContain(`\`${sha}\``);
    const hooksMd = await w.readInv('hooks-and-agents-md.md');
    const sizes = await Promise.all(
      ['guard-bash.sh', 'guard-write.sh', 'guard-agent-model.sh'].map(async (h) =>
        Buffer.byteLength(await readText(path.join(w.home, '.claude/hooks', h))),
      ),
    );
    for (const n of sizes) expect(hooksMd).toMatch(new RegExp(`\\| ${n} +\\|`));
    expect((await w.snapshot())['claude-md-sections.md']).toBe(secMd2);
    // 表格列宽保持:改完的 md 仍满足仓库的 prettier 口径
    const pc = runNode([
      path.join(REPO_ROOT, 'node_modules', 'prettier', 'bin', 'prettier.cjs'),
      '--config',
      path.join(REPO_ROOT, '.prettierrc'),
      '--check',
      ...(await readDir(path.join(w.root, 'inventory')))
        .filter((e) => e.name.endsWith('.md'))
        .map((e) => path.join(w.root, 'inventory', e.name)),
    ]);
    expect(pc.status, pc.stdout + pc.stderr).toBe(0);
    const again2 = tool(w);
    expect(again2.status, again2.stdout).toBe(0);

    // 第三阶段:hook 换序(Write 挪到 Bash 前面)——按行配对的字节数不得被自动写错行
    const hooksBefore = await w.readInv('hooks-and-agents-md.md');
    const settings = JSON.parse(await readText(path.join(w.home, '.claude/settings.json')));
    const pre = settings.hooks.PreToolUse as unknown[];
    settings.hooks.PreToolUse = [pre[1], pre[0], pre[2]];
    await w.put('.claude/settings.json', JSON.stringify(settings));
    const swap = tool(w, ['--apply']);
    expect(swap.stdout).toContain('也变了(可能换序)');
    expect(swap.status, swap.stdout).not.toBe(0);
    expect(await w.readInv('hooks-and-agents-md.md')).toBe(hooksBefore);

    // 真实 HOME 没被碰(元数据级)
    expect(await realHomeMeta()).toBe(meta0);
  });

  it('需人工核对的位置只来自「值不可绑定」的引用,md 行本身保持原样', async () => {
    const w = await world();
    await copyRealInventory(w);
    await fakeHome(w, 2);
    const before = await w.snapshot();
    const ap = tool(w, ['--apply']);
    const after = await w.snapshot();
    // 无论是否有人工项,未被报告的行不得被改动:逐行比较,改动行必须落在 [#编号] 标注行或时点行或起止行表格内
    for (const name of Object.keys(before)) {
      if (name === 'commands.sh') continue;
      const a = (before[name] ?? '').split('\n');
      const b = (after[name] ?? '').split('\n');
      expect(b.length).toBe(a.length);
      a.forEach((l, i) => {
        if (l !== b[i]) expect(l, `${name}:${i + 1}`).toMatch(/\[#B15-\d+\]|^- 时点|\| 第 \d+ 节/);
      });
    }
    if (ap.status === 5) expect(ap.stdout).toContain('需人工核对');
  });
});

// ---------------------------------------------------------------- 小型合成 inventory:语义细节

const MD_HEAD = '# mini\n\n';

async function mini(
  w: World,
  opts: { geExpected?: string; mdTotal?: string; textMd?: boolean } = {},
): Promise<void> {
  await w.put('.claude/CLAUDE.md', 'abc\ndef\n');
  await w.put('.claude/projects/p/memory/a.md', 'x\n');
  await w.put('.claude/projects/p/memory/b.md', 'x\n');
  await w.put('.claude/projects/p/memory/c.md', 'x\n');
  const at = '2020-01-01T00:00:00Z';
  const rows = [
    tsv('M-001', "wc -c < ~/.claude/CLAUDE.md | tr -d ' '", '8', at),
    tsv('M-002', "wc -l < ~/.claude/CLAUDE.md | tr -d ' '", '2', at),
    tsv(
      'M-003',
      "ls -1 ~/.claude/projects/p/memory | wc -l | tr -d ' '",
      opts.geExpected ?? '>=3',
      at,
    ),
    tsv('M-004', 'head -c 3 ~/.claude/CLAUDE.md', 'abc', at),
  ];
  await w.inv('commands.sh', '# mini\n' + rows.join('\n') + '\n');
  const md = [
    MD_HEAD + '- 时点:2020-01-01T00:00:00Z(UTC)',
    '',
    `| 项 | 值 |`,
    `| --- | --- |`,
    `| 字节 | ${opts.mdTotal ?? '8'} [#M-001]  |`,
    `| 行数 | 2 [#M-002] |`,
    opts.textMd ? 'text `abc` [#M-004]' : '',
    '',
  ].join('\n');
  await w.inv('mini.md', md);
  await w.inv(
    'mini2.md',
    `${MD_HEAD}- 时点:2020-01-01T00:00:00Z(UTC)\n\n| 项 | 值 |\n| --- | --- |\n| 记忆数 | ${(opts.geExpected ?? '>=3').slice(2)} [#M-003] |\n`,
  );
}

describe('inventory-refresh:语义细节', () => {
  it('一致时:dry-run 与 apply 都退出 0,不写;A7 与本工具判断一致(运行器对拍)', async () => {
    const w = await world();
    await mini(w);
    const before = await w.snapshot();
    expect(a7(w).status).toBe(0);
    const d = tool(w);
    expect(d.status, d.stdout).toBe(0);
    const ap = tool(w, ['--apply', '--backup-dir', w.backup]);
    expect(ap.status).toBe(0);
    expect(await w.snapshot()).toEqual(before);
    expect(await exists(w.backup)).toBe(false);
  });

  it('值变了:commands.sh 的值与时点一起改,md 同步,其它行不动', async () => {
    const w = await world();
    await mini(w);
    await w.put('.claude/CLAUDE.md', 'abcdef\nghi\njkl\n');
    const before = await w.snapshot();
    expect(a7(w).status).toBe(1);
    const ap = tool(w, ['--apply', '--backup-dir', w.backup]);
    expect(ap.status, ap.stdout + ap.stderr).toBe(0);
    const cmds = (await w.readInv('commands.sh')).split('\n');
    const row = (id: string): string[] =>
      (cmds.find((l) => l.startsWith(id + '\t')) ?? '').split('\t');
    expect(row('M-001')[2]).toBe('15');
    expect(row('M-001')[3]).toBe(NOW);
    expect(row('M-002')[2]).toBe('3');
    expect(row('M-002')[3]).toBe(NOW);
    expect(row('M-003')[2]).toBe('>=3'); // 只增项没低于阈值:不动
    expect(row('M-003')[3]).toBe('2020-01-01T00:00:00Z'); // 只增项的时点也不动
    expect(row('M-004')[2]).toBe('abc');
    const md = await w.readInv('mini.md');
    expect(md).toContain('| 字节 | 15 [#M-001] |'); // 列宽保持:变长吃掉一个尾部空格
    expect(md).toContain('| 行数 | 3 [#M-002] |');
    expect(await w.readInv('mini2.md')).toContain('| 记忆数 | 3 [#M-003] |');
    expect(md).toContain(`- 时点:${NOW}(UTC)`);
    expect(before['mini.md']).not.toBe(md);
    expect(a7(w).status).toBe(0);
  });

  it('只增项:新值 >= 阈值不改;新值 < 阈值才下调,并标为需人工(退出 5)', async () => {
    const w = await world();
    await mini(w, { geExpected: '>=2' });
    await w.put('.claude/projects/p/memory/d.md', 'x\n'); // 4 >= 2
    const same = tool(w);
    expect(same.status, same.stdout).toBe(0);

    const w2 = await world();
    await mini(w2, { geExpected: '>=10' }); // 实得 3 < 10
    const ap = tool(w2, ['--apply']);
    expect(ap.status, ap.stdout).toBe(5);
    expect(ap.stdout).toContain('阈值下调');
    const row = (
      (await w2.readInv('commands.sh')).split('\n').find((l) => l.startsWith('M-003\t')) ?? ''
    ).split('\t');
    expect(row[2]).toBe('>=3');
    expect(row[3]).toBe(NOW);
    expect(a7(w2).status).toBe(0);
  });

  it('md 里「值不可绑定」的引用:不硬改,列为需人工,安全部分仍写入(退出 5)', async () => {
    const w = await world();
    await mini(w);
    const md0 = await w.readInv('mini.md');
    await w.inv('mini.md', md0 + '\nbare mention [#M-002] here\n');
    await w.put('.claude/CLAUDE.md', 'abcdef\nghi\njkl\n');
    const before = await w.readInv('mini.md');
    const ap = tool(w, ['--apply']);
    expect(ap.status, ap.stdout).toBe(5);
    expect(ap.stdout).toContain('需人工核对');
    expect(ap.stdout).toContain('[#M-002]');
    const md = await w.readInv('mini.md');
    expect(md).toContain('bare mention [#M-002] here'); // 原样
    expect(md).toContain('| 行数 | 3 [#M-002] |'); // 可绑定的位置照常同步
    expect(md).not.toBe(before);
    const row = (
      (await w.readInv('commands.sh')).split('\n').find((l) => l.startsWith('M-002\t')) ?? ''
    ).split('\t');
    expect(row[2]).toBe('3');
  });

  it('文本型新值不自动写入、也不打印(命令输出可能含文件内容)', async () => {
    const w = await world();
    await mini(w);
    const cmds = await w.readInv('commands.sh');
    await w.inv(
      'commands.sh',
      cmds + tsv('M-007', 'head -1 ~/.claude/CLAUDE.md', 'old', '2020-01-01T00:00:00Z') + '\n',
    );
    await w.put('.claude/CLAUDE.md', 'qq1\nqq2\n'); // 8 字节 2 行:数值型条目不变
    const before = await w.snapshot();
    for (const args of [[], ['--apply', '--backup-dir', w.backup]]) {
      const r = tool(w, args);
      expect(r.status, r.stdout).toBe(args.length ? 5 : 1);
      expect(r.stdout + r.stderr).toContain('MANUAL M-007');
      expect(r.stdout + r.stderr).not.toContain('qq1');
      expect(r.stdout + r.stderr).not.toContain('qq2');
    }
    expect(await w.snapshot()).toEqual(before);
    expect(await exists(w.backup)).toBe(false);
  });

  it('只有 md 漂移(没有任何编号变化):dry-run 退出 5,不说「没有需要刷新」', async () => {
    const w = await world();
    await mini(w, { mdTotal: '999' });
    const r = tool(w);
    expect(r.status, r.stdout).toBe(5);
    expect(r.stdout).toContain('文档已漂移');
    expect(r.stdout).not.toContain('没有需要刷新的编号。');
  });

  it('文档已漂移(现值不等于旧期望值):不覆盖,列为需人工', async () => {
    const w = await world();
    await mini(w, { mdTotal: '999' }); // md 里写的不是旧期望值 8
    await w.put('.claude/CLAUDE.md', 'abcdef\nghi\n');
    const ap = tool(w, ['--apply']);
    expect(ap.status, ap.stdout).toBe(5);
    expect(await w.readInv('mini.md')).toContain('| 字节 | 999 [#M-001]  |');
    expect(ap.stdout).toContain('文档已漂移');
  });

  it('有命令未执行:退出 4,不写任何文件', async () => {
    const w = await world();
    await mini(w);
    await w.put('.claude/CLAUDE.md', 'changed\n');
    await safe.remove(w.ctx, path.join(w.home, '.claude/projects'));
    const before = await w.snapshot();
    const ap = tool(w, ['--apply', '--backup-dir', w.backup]);
    expect(ap.status, ap.stdout).toBe(4);
    expect(ap.stdout).toContain('NOT-RUN M-003');
    expect(await w.snapshot()).toEqual(before);
    expect(await exists(w.backup)).toBe(false);
  });

  it('命令未过只读检查:退出 3,不执行、不写', async () => {
    const w = await world();
    await mini(w);
    const cmds = await w.readInv('commands.sh');
    await w.inv(
      'commands.sh',
      cmds + tsv('M-005', 'echo hi > ~/oops', 'hi', '2020-01-01T00:00:00Z') + '\n',
    );
    const before = await w.snapshot();
    const ap = tool(w, ['--apply']);
    expect(ap.status).toBe(3);
    expect(await w.snapshot()).toEqual(before);
    expect(await exists(path.join(w.home, 'oops'))).toBe(false);
  });

  it('新输出含竖线:不写进 TSV/md,列为需人工', async () => {
    const w = await world();
    await mini(w);
    await w.put('.claude/CLAUDE.md', 'abc\ndef\n');
    const cmds = await w.readInv('commands.sh');
    await w.inv(
      'commands.sh',
      cmds + tsv('M-006', "echo 'a|b'", 'old', '2020-01-01T00:00:00Z') + '\n',
    );
    const ap = tool(w, ['--apply']);
    // 没有任何可安全写入的内容:不写、不重跑 A7,退出 5
    expect(ap.status, ap.stdout).toBe(5);
    expect(ap.stdout).toContain('MANUAL M-006');
    const row = (
      (await w.readInv('commands.sh')).split('\n').find((l) => l.startsWith('M-006\t')) ?? ''
    ).split('\t');
    expect(row[2]).toBe('old');
  });

  it('写入中途失败:按备份回滚,磁盘内容与原来逐字节相同,无临时文件残留', async () => {
    const w = await world();
    await mini(w);
    await w.put('.claude/CLAUDE.md', 'abcdef\nghi\njkl\n');
    const before = await w.snapshot();
    const ap = tool(w, ['--apply', '--backup-dir', w.backup], {
      KIT_REFRESH_TEST_FAIL_RENAME_AT: '2',
    });
    expect(ap.status).not.toBe(0);
    expect(ap.stdout + ap.stderr).toContain('回滚');
    expect(await w.snapshot()).toEqual(before);
  });

  it('inventory/ 里的符号链接:拒绝读写(退出 3),外部目标、备份目录都不动', async () => {
    const w = await world();
    await mini(w);
    await w.put('.claude/CLAUDE.md', 'abcdef\nghi\njkl\n');
    const outside = path.join(w.dir, 'outside.md');
    const mdText = await w.readInv('mini.md');
    await safe.writeFile(w.ctx, outside, mdText);
    await safe.remove(w.ctx, path.join(w.root, 'inventory', 'mini.md'));
    await safe.symlink(w.ctx, '../../outside.md', path.join(w.root, 'inventory', 'mini.md'));
    const cmdsBefore = await w.readInv('commands.sh');
    const ap = tool(w, ['--apply', '--backup-dir', w.backup]);
    expect(ap.status, ap.stdout + ap.stderr).toBe(3);
    expect(ap.stdout).toContain('普通单链接');
    expect(await readText(outside)).toBe(mdText);
    expect(await w.readInv('commands.sh')).toBe(cmdsBefore);
    expect(await exists(w.backup)).toBe(false);
  });

  it('参数:KIT_OPS_NO_REAL_HOME=1 且缺 --home => 用法错 2;--now 格式非法 => 2', () => {
    const r = runNode([TOOL, '--root', REPO_ROOT]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--home');
    const r2 = runNode([
      TOOL,
      '--root',
      REPO_ROOT,
      '--home',
      '/nonexistent-home-x',
      '--now',
      'tomorrow',
    ]);
    expect(r2.status).toBe(2);
  });
});

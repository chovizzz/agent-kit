import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readText } from '../../src/io/read-fs.js';
import { makeFixture, runMain } from './helpers.js';

interface Snap {
  paths: Record<
    string,
    {
      t: string;
      sha?: string;
      link?: string;
      names?: string[];
      expansion?: string[];
      files?: Record<string, string>;
    }
  >;
  stats: { volatile_excluded: number; recorded_paths: number };
}
interface Diff {
  added: { path: string }[];
  removed: { path: string }[];
  changed: { path: string }[];
  count: number;
}

const MANAGED = `# 注释与空行被忽略

~/.claude/CLAUDE.md
~/.claude/hooks/*.sh
~/.claude/rules/
~/.claude/skills/
~/.config/agent-kit/
`;
const VOLATILE = `~/.claude/projects/**
~/.codex/memories*
**/.DS_Store
`;

async function snap(fx: Awaited<ReturnType<typeof makeFixture>>, name: string): Promise<Snap> {
  const o = path.join(fx.out, name);
  const r = runMain([
    'snap',
    '--repo',
    fx.repo,
    '--home',
    fx.home,
    '--base-ref',
    '',
    '--out-root',
    o,
  ]);
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(await readText(path.join(o, 'snapshot.json'))) as Snap;
}

function diff(
  fx: Awaited<ReturnType<typeof makeFixture>>,
  a: string,
  b: string,
): { status: number | null; d: Diff } {
  const r = runMain([
    'diff',
    path.join(fx.out, a, 'snapshot.json'),
    path.join(fx.out, b, 'snapshot.json'),
  ]);
  return { status: r.status, d: JSON.parse(r.stdout) as Diff };
}

describe('快照语法:字面 / glob / 目录 / 注释空行', () => {
  it('每种形态各一个 fixture', async () => {
    const fx = await makeFixture(MANAGED, VOLATILE);
    await fx.put('.claude/CLAUDE.md', 'rules\n');
    await fx.put('.claude/hooks/a.sh', '#!/bin/sh\n');
    await fx.put('.claude/hooks/b.sh', '#!/bin/sh\n');
    await fx.put('.claude/hooks/a.log', 'log\n'); // glob 不匹配 *.sh
    await fx.put('.claude/skills/s1/SKILL.md', '# s1\n');
    await fx.put('.claude/skills/s1/ref.md', 'ref\n');
    await fx.put('.claude/skills/loose.md', 'loose\n');
    const s = await snap(fx, 'a');
    // 字面文件:存在 + sha256
    expect(s.paths['~/.claude/CLAUDE.md']).toMatchObject({ t: 'file' });
    expect(s.paths['~/.claude/CLAUDE.md']?.sha).toMatch(/^[0-9a-f]{64}$/);
    // 字面但不存在:也被记录为 absent
    expect(s.paths['~/.config/agent-kit']).toEqual({ t: 'absent' });
    // glob:展开结果本身被记录,且只含 *.sh
    expect(s.paths['~/.claude/hooks/*.sh']?.expansion).toEqual([
      '~/.claude/hooks/a.sh',
      '~/.claude/hooks/b.sh',
    ]);
    expect(s.paths['~/.claude/hooks/a.sh']?.t).toBe('file');
    expect(s.paths['~/.claude/hooks/a.log']).toBeUndefined();
    // 目录:顶层名字表 + 子目录里 SKILL.md 与顶层文件的哈希 + 顶层文件哈希
    expect(s.paths['~/.claude/skills']?.names).toEqual(['loose.md', 's1']);
    expect(s.paths['~/.claude/skills/s1']?.files).toBeDefined();
    expect(Object.keys(s.paths['~/.claude/skills/s1']?.files ?? {})).toEqual([
      'SKILL.md',
      'ref.md',
    ]);
    expect(s.paths['~/.claude/skills/loose.md']?.t).toBe('file');
    // 目录条目 `~/.claude/rules/` 不存在也记录
    expect(s.paths['~/.claude/rules']).toEqual({ t: 'absent' });
    // 快照里不出现真实(这里是合成)HOME 的绝对路径,也不含文件内容
    const text = await readText(path.join(fx.out, 'a', 'snapshot.json'));
    expect(text).not.toContain(fx.home);
    expect(text).not.toContain('rules\n');
  });

  it('空展开也记录;之后多出匹配会被发现', async () => {
    const fx = await makeFixture('~/.claude/hooks/*.sh\n', '');
    const s1 = await snap(fx, 'empty');
    expect(s1.paths['~/.claude/hooks/*.sh']).toEqual({ t: 'glob', expansion: [] });
    await fx.put('.claude/hooks/new.sh', 'x\n');
    await snap(fx, 'later');
    const { status, d } = diff(fx, 'empty', 'later');
    expect(status).toBe(1);
    expect(d.changed.map((c) => c.path)).toContain('~/.claude/hooks/*.sh');
    expect(d.added.map((c) => c.path)).toContain('~/.claude/hooks/new.sh');
  });

  it('`**` 跨目录;`?` 与 [..] 生效', async () => {
    const fx = await makeFixture('~/proj/**/AGENTS.md\n~/x/f?.txt\n~/x/g[ab].txt\n', '');
    await fx.put('proj/AGENTS.md', '1');
    await fx.put('proj/a/b/AGENTS.md', '2');
    await fx.put('proj/a/other.md', '3');
    await fx.put('x/f1.txt', '1');
    await fx.put('x/f22.txt', '1');
    await fx.put('x/ga.txt', '1');
    await fx.put('x/gc.txt', '1');
    const s = await snap(fx, 'g');
    expect(s.paths['~/proj/**/AGENTS.md']?.expansion).toEqual([
      '~/proj/AGENTS.md',
      '~/proj/a/b/AGENTS.md',
    ]);
    expect(s.paths['~/x/f?.txt']?.expansion).toEqual(['~/x/f1.txt']);
    expect(s.paths['~/x/g[ab].txt']?.expansion).toEqual(['~/x/ga.txt']);
  });

  it('`**` 会进入隐藏目录(检测面大于 bash 默认);`*` 仍不匹配隐藏名', async () => {
    const fx = await makeFixture('~/proj/**/AGENTS.md\n~/star/*\n', '');
    await fx.put('proj/.hidden/AGENTS.md', '1');
    await fx.put('star/.dot', '1');
    await fx.put('star/vis', '1');
    const s = await snap(fx, 'h');
    expect(s.paths['~/proj/**/AGENTS.md']?.expansion).toEqual(['~/proj/.hidden/AGENTS.md']);
    expect(s.paths['~/star/*']?.expansion).toEqual(['~/star/vis']);
  });

  it('符号链接记录 readlink 目标,并跟随到 HOME 内的目标内容(B20 ZW-3)', async () => {
    const fx = await makeFixture('~/.claude/skills/\n', '');
    await fx.put('real/SKILL.md', '# real\n');
    await fx.link('.claude/skills/alias', '../../real');
    const a = await snap(fx, 'l1');
    const rec = a.paths['~/.claude/skills/alias'];
    expect(rec?.t).toBe('symlink');
    // 指向 HOME 内的目标折成 ~/…(报告里不出现 HOME 的绝对路径)
    expect(rec?.link).toBe('~/real');
    // 目标内容变化(链接字符串不变)=> 快照有差异:通过链接写入不再是盲区
    await fx.put('real/SKILL.md', '# changed\n');
    await snap(fx, 'l2');
    expect(diff(fx, 'l1', 'l2').d.changed.map((c) => c.path)).toEqual(['~/.claude/skills/alias']);
    // 对照:目标没变 => 无差异
    await snap(fx, 'l3');
    expect(diff(fx, 'l2', 'l3').d.count).toBe(0);
  });

  it('凭据位置(~/.ssh 等)里的链接目标不读内容,按「HOME 之外」只记元数据', async () => {
    const fx = await makeFixture('~/.claude/CLAUDE.md\n', '');
    await fx.put('.ssh/notes.md', 'PRIVATE-CONTENT');
    await fx.link('.claude/CLAUDE.md', path.join(fx.home, '.ssh/notes.md'));
    const o = path.join(fx.out, 's');
    runMain(['snap', '--repo', fx.repo, '--home', fx.home, '--base-ref', '', '--out-root', o]);
    const text = await readText(path.join(o, 'snapshot.json'));
    expect(text).not.toContain('PRIVATE-CONTENT');
    const j = JSON.parse(text) as {
      outside_links: string[];
      paths: Record<string, { target?: { outside?: boolean; sha?: string } }>;
    };
    expect(j.outside_links).toEqual(['~/.claude/CLAUDE.md']);
    expect(j.paths['~/.claude/CLAUDE.md']?.target?.outside).toBe(true);
    expect(j.paths['~/.claude/CLAUDE.md']?.target?.sha).toBeUndefined();
  });
});

describe('volatile 只剔除', () => {
  it('剔除命中的路径及其子路径,并计数', async () => {
    const fx = await makeFixture('~/.claude/CLAUDE.md\n~/.codex/**\n', VOLATILE);
    await fx.put('.claude/CLAUDE.md', 'x');
    await fx.put('.codex/config.toml', 'a');
    await fx.put('.codex/memories.md', 'm');
    await fx.put('.codex/memories/note.md', 'n');
    await fx.put('.codex/.DS_Store', 'd');
    const s = await snap(fx, 'v');
    expect(s.paths['~/.codex/config.toml']).toBeDefined();
    expect(s.paths['~/.codex/memories.md']).toBeUndefined();
    expect(s.paths['~/.codex/memories']).toBeUndefined();
    expect(s.paths['~/.codex/.DS_Store']).toBeUndefined();
    expect(s.stats.volatile_excluded).toBeGreaterThan(0);
  });

  it('改 volatile 路径不产生差异(正向对照),改 managed 路径产生差异(负向)', async () => {
    const fx = await makeFixture(
      '~/.claude/CLAUDE.md\n~/.codex/AGENTS.md\n',
      '~/.claude/projects/**\n',
    );
    await fx.put('.claude/CLAUDE.md', 'x');
    await fx.put('.codex/AGENTS.md', 'y');
    await fx.put('.claude/projects/p/s.jsonl', '1');
    await snap(fx, 'b');
    await fx.put('.claude/projects/p/s.jsonl', '2');
    await fx.put('.claude/projects/p/t.jsonl', '3');
    await snap(fx, 'a1');
    expect(diff(fx, 'b', 'a1')).toMatchObject({ status: 0, d: { count: 0 } });
    await fx.put('.codex/AGENTS.md', 'changed');
    await snap(fx, 'a2');
    const r = diff(fx, 'a1', 'a2');
    expect(r.status).toBe(1);
    expect(r.d.changed.map((c) => c.path)).toEqual(['~/.codex/AGENTS.md']);
  });
});

describe('快照器对"不读真实 HOME"的护栏', () => {
  it('未给 --home 且 KIT_OPS_NO_REAL_HOME=1 时拒绝运行', async () => {
    const fx = await makeFixture('~/.claude/CLAUDE.md\n', '');
    const r = runMain(['snap', '--repo', fx.repo, '--base-ref', '']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('KIT_OPS_NO_REAL_HOME');
    expect(r.stdout).not.toContain('CLAUDE.md');
  });
});

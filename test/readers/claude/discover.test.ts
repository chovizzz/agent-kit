/** C1:会话 = 主文件;`subagents/` 侧链文件与非 UUID 文件不收。 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { symlink } from '../../../src/io/safe-fs.js';
import { createClaudeReader } from '../../../src/readers/claude/index.js';
import { fakeUuid } from '../../fixtures/sessions/common.js';
import { writeClaudeLines } from '../../fixtures/sessions/gen-claude.js';
import { newWork, userLine } from './helpers.js';

const main = (n: string) => `${fakeUuid(n)}.jsonl`;

describe('discover', () => {
  it('只收 <项目目录>/<UUID>.jsonl;子代理、tool-results、非 UUID 名字、深层、根层文件都不收', async () => {
    const w = await newWork('cl-disc-');
    const put = (cwd: string, id: string, relPath?: string) =>
      writeClaudeLines(w.io, {
        root: w.sessions,
        cwd,
        id,
        lines: [userLine('x')], // 内容合法:若被误收就会有计数
        ...(relPath !== undefined ? { relPath } : {}),
      });
    const a = await put('/work/proj-a', 'a');
    const b = await put('/work/proj-b', 'b');
    // 非会话:
    await put('/work/proj-a', 'sub1', `${fakeUuid('a')}/subagents/agent-1.jsonl`);
    await put('/work/proj-a', 'sub2', `${fakeUuid('a')}/tool-results/r.jsonl`);
    await put('/work/proj-a', 'plug', 'notes.jsonl');
    await put('/work/proj-a', 'plug2', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.jsonl.bak');
    await put('/work/proj-a', 'short', `${fakeUuid('a').slice(1)}.jsonl`);
    await put('/work/proj-a', 'txt', `${fakeUuid('a')}.txt`);
    await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/',
      id: 'rootlevel',
      lines: [userLine('x')],
      relPath: `../${main('rootlevel')}`,
    });
    const refs = await createClaudeReader().discover(w.sessions);
    expect(refs.map((r) => r.path).sort()).toEqual([a, b].sort());
    for (const r of refs) {
      expect(r.agent).toBe('claude');
      expect(r.bytes).toBeGreaterThan(0);
      expect(r.session_ref).toMatch(/^s_[0-9a-f]{16}$/);
    }
  });

  it('子代理文件即使内容全是主线行,也不会被 discover 返回(正向对照:同内容放到主位置就返回)', async () => {
    const w = await newWork('cl-disc-sub-');
    await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/p',
      id: 'p',
      lines: [userLine('x')],
      relPath: `${fakeUuid('p')}/subagents/agent-a1.jsonl`,
    });
    expect(await createClaudeReader().discover(w.sessions)).toEqual([]);
    await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/p',
      id: 'p',
      lines: [userLine('x')],
    });
    expect(await createClaudeReader().discover(w.sessions)).toHaveLength(1);
  });

  it('不跟随符号链接(文件与目录);经符号链接传入 source 时返回真实路径', async () => {
    const w = await newWork('cl-disc-link-');
    const real = await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/proj-a',
      id: 'real',
      lines: [userLine('x')],
    });
    const projDir = path.dirname(real);
    await symlink(w.io, real, path.join(projDir, main('linkfile')));
    await symlink(w.io, projDir, path.join(w.sessions, 'linkdir'));
    const refs = await createClaudeReader().discover(w.sessions);
    expect(refs.map((r) => r.path)).toEqual([real]);
    // source 本身是符号链接(符号链接形式的临时目录,如 macOS /var → /private/var)
    const viaLink = path.join(w.dir, 'sessions-link');
    await symlink(w.io, w.sessions, viaLink);
    const refs2 = await createClaudeReader().discover(viaLink);
    expect(refs2.map((r) => r.path)).toEqual([real]);
  });

  it('结果按路径排序(确定性)', async () => {
    const w = await newWork('cl-disc-sort-');
    for (const id of ['z', 'y', 'x', 'w']) {
      await writeClaudeLines(w.io, {
        root: w.sessions,
        cwd: `/work/${id}`,
        id,
        lines: [userLine('x')],
      });
    }
    const paths = (await createClaudeReader().discover(w.sessions)).map((r) => r.path);
    expect(paths).toHaveLength(4);
    expect(paths).toEqual([...paths].sort());
  });

  it('source 下没有会话:空数组,不报错', async () => {
    const w = await newWork('cl-disc-empty-');
    await writeClaudeLines(w.io, {
      root: w.sessions,
      cwd: '/work/p',
      id: 'n',
      lines: [userLine('x')],
      relPath: 'readme.txt',
    });
    expect(await createClaudeReader().discover(w.sessions)).toEqual([]);
  });
});

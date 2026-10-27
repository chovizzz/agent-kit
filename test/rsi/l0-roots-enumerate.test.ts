/**
 * R20-A2 B4a:会话根判定与列举(R20-2.7 / 2.9、R20-6.7)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chmod, mkdirp, rename, symlink, writeFile } from '../../src/io/safe-fs.js';
import { lstat } from '../../src/io/read-fs.js';
import { walkFiles } from '../../src/signals/base-reader.js';
import { SESSION_FILE_RE } from '../../src/readers/claude/schema.js';
import { ROLLOUT_NAME } from '../../src/readers/codex/reader.js';
import { SESSION_FILE } from '../../src/readers/pi/reader.js';
import { enumerateSessionFiles } from '../../src/rsi/l0/enumerate.js';
import { evaluateAgentRoot } from '../../src/rsi/l0/roots.js';
import { mkfifo, touchAt } from './proc/helper.js';
import { jl, makeL0Fx, put, rootOf, uuid } from './l0-fixture.js';

describe('evaluateAgentRoot', () => {
  it('ok / absent(根或其上级不存在);不存在不是错误', async () => {
    const f = await makeL0Fx('rt-basic-');
    expect(await evaluateAgentRoot(f.home, 'claude', false)).toEqual({ status: 'absent' });
    await mkdirp(f.fx, rootOf(f, 'claude'), 0o755);
    expect(await evaluateAgentRoot(f.home, 'claude', false)).toEqual({ status: 'ok' });
    await mkdirp(f.fx, path.join(f.home, '.codex'), 0o755);
    expect(await evaluateAgentRoot(f.home, 'codex', false)).toEqual({ status: 'absent' });
  });
  it('链上有符号链接(上级与根自身)→ root_symlink;根是文件 → root_not_dir;pi 且已设 → pi_dir_override(不看文件系统)', async () => {
    const f = await makeL0Fx('rt-bad-');
    const real = path.join(f.dir, 'elsewhere');
    await mkdirp(f.fx, path.join(real, 'projects'), 0o755);
    await symlink(f.fx, real, path.join(f.home, '.claude'));
    expect(await evaluateAgentRoot(f.home, 'claude', false)).toEqual({
      status: 'not_evaluated',
      reason: 'root_symlink',
    });
    await mkdirp(f.fx, path.join(f.home, '.codex'), 0o755);
    await symlink(f.fx, real, path.join(f.home, '.codex', 'sessions'));
    expect(await evaluateAgentRoot(f.home, 'codex', false)).toEqual({
      status: 'not_evaluated',
      reason: 'root_symlink',
    });
    await put(f, 'pi', 'x.jsonl', 'a\n'); // pi 根下建一个文件,以便下面验证「已设」不看文件系统
    expect(await evaluateAgentRoot(f.home, 'pi', true)).toEqual({
      status: 'not_evaluated',
      reason: 'pi_dir_override',
    });
    expect(await evaluateAgentRoot(f.home, 'pi', false)).toEqual({ status: 'ok' });
    const g = await makeL0Fx('rt-file-');
    await mkdirp(g.fx, path.join(g.home, '.claude'), 0o755);
    await put(g, 'codex', 'a', 'x');
    const claudeRoot = rootOf(g, 'claude');
    await writeFile(g.fx, claudeRoot, 'x');
    expect(await evaluateAgentRoot(g.home, 'claude', false)).toEqual({
      status: 'not_evaluated',
      reason: 'root_not_dir',
    });
  });
  it.skipIf(process.getuid?.() === 0)(
    '读不了的上级(EACCES)不是 absent:not_evaluated(不会把不完整的扫描认证成完整)',
    async () => {
      const f = await makeL0Fx('rt-eacces-');
      await mkdirp(f.fx, rootOf(f, 'claude'), 0o755);
      const dot = path.join(f.home, '.claude');
      await chmod(f.fx, dot, 0o000);
      try {
        const r = await evaluateAgentRoot(f.home, 'claude', false);
        expect(r.status).toBe('not_evaluated');
      } finally {
        await chmod(f.fx, dot, 0o755);
      }
    },
  );
});

const rels = (r: { files: readonly { path: string }[] }, root: string): string[] =>
  r.files.map((x) => path.relative(root, x.path)).sort();

describe('enumerateSessionFiles:形状与 reader 口径一致', () => {
  it('claude:只收 <项目目录>/<UUID>.jsonl;根下直接的、子代理目录里的、名字不对的都不收;结果集与 walkFiles + 同一正则相同', async () => {
    const f = await makeL0Fx('en-cl-');
    await put(f, 'claude', `p1/${uuid(1)}.jsonl`, 'a\n');
    await put(f, 'claude', `p2/${uuid(2)}.jsonl`, 'a\n');
    await put(f, 'claude', `${uuid(3)}.jsonl`, 'a\n');
    await put(f, 'claude', `p1/${uuid(1)}/subagents/agent-x.jsonl`, 'a\n');
    await put(f, 'claude', 'p1/notes.txt', 'a\n');
    await put(f, 'claude', 'p1/short.jsonl', 'a\n');
    const root = rootOf(f, 'claude');
    const e = await enumerateSessionFiles(f.home, f.config, false);
    expect(rels(e, root)).toEqual([`p1/${uuid(1)}.jsonl`, `p2/${uuid(2)}.jsonl`]);
    const reader = await walkFiles(root, {
      maxDepth: 1,
      match: (_a, rel) => SESSION_FILE_RE.test(rel),
    });
    expect(reader.map((p) => path.relative(root, p)).sort()).toEqual(rels(e, root));
    expect(e.complete).toBe(true);
    // 与 reader 同深度(1):<UUID>/subagents/ 以下不进入,也不计入目录项(根 3 项 + p1 4 项 + p2 1 项)
    expect(e.entriesSeen).toBe(8);
    expect(e.roots.claude).toEqual({ status: 'ok' });
  });
  it('pi:--目录--/文件.jsonl 一层;目录名形状不对、多一层嵌套都不收;与 walkFiles 一致', async () => {
    const f = await makeL0Fx('en-pi-');
    await put(f, 'pi', '--a--/s1.jsonl', 'a\n');
    await put(f, 'pi', 'plain/s2.jsonl', 'a\n');
    await put(f, 'pi', '--a--/deeper/s3.jsonl', 'a\n');
    const root = rootOf(f, 'pi');
    const e = await enumerateSessionFiles(f.home, f.config, false);
    expect(rels(e, root)).toEqual(['--a--/s1.jsonl']);
    const reader = await walkFiles(root, {
      maxDepth: 1,
      match: (_a, rel) => SESSION_FILE.test(rel),
    });
    expect(reader.map((p) => path.relative(root, p)).sort()).toEqual(rels(e, root));
  });
  it('codex:rollout-*.jsonl,深度 8 收、深度 9 不收;与 walkFiles 一致', async () => {
    const f = await makeL0Fx('en-cx-');
    const d = (n: number): string => Array.from({ length: n }, (_, i) => `d${i}`).join('/');
    await put(f, 'codex', `${d(3)}/rollout-a.jsonl`, 'a\n');
    await put(f, 'codex', `${d(8)}/rollout-b.jsonl`, 'a\n');
    await put(f, 'codex', `${d(9)}/rollout-c.jsonl`, 'a\n');
    await put(f, 'codex', `${d(2)}/other.jsonl`, 'a\n');
    const root = rootOf(f, 'codex');
    const e = await enumerateSessionFiles(f.home, f.config, false);
    expect(rels(e, root)).toEqual([`${d(3)}/rollout-a.jsonl`, `${d(8)}/rollout-b.jsonl`].sort());
    const reader = await walkFiles(root, { match: (abs) => ROLLOUT_NAME.test(path.basename(abs)) });
    expect(reader.map((p) => path.relative(root, p)).sort()).toEqual(rels(e, root));
  });
  it('符号链接文件 / FIFO(名字合规)计 notRegular 不收;符号链接目录不进入;不 realpath', async () => {
    const f = await makeL0Fx('en-nr-');
    const real = await put(f, 'claude', `p1/${uuid(1)}.jsonl`, 'a\n');
    await symlink(f.fx, real, path.join(rootOf(f, 'claude'), 'p1', `${uuid(2)}.jsonl`));
    mkfifo(path.join(rootOf(f, 'claude'), 'p1', `${uuid(3)}.jsonl`));
    const outside = path.join(f.dir, 'outside');
    await put({ home: outside, fx: f.fx }, 'claude', `x/${uuid(9)}.jsonl`, 'a\n').catch(
      () => undefined,
    );
    await symlink(
      f.fx,
      path.join(f.dir, 'outside', '.claude', 'projects', 'x'),
      path.join(rootOf(f, 'claude'), 'linkdir'),
    );
    const e = await enumerateSessionFiles(f.home, f.config, false);
    expect(e.files.map((x) => x.path)).toEqual([real]);
    expect(e.skipped.notRegular).toBe(2);
  });
  it('每个文件的 size / mtime / dev / ino 来自 lstat', async () => {
    const f = await makeL0Fx('en-stat-');
    const p = await put(f, 'pi', '--a--/s.jsonl', 'hello\n');
    const st = await lstat(p);
    const e = await enumerateSessionFiles(f.home, f.config, false);
    expect(e.files[0]).toEqual({
      agent: 'pi',
      path: p,
      size: 6,
      mtimeMs: st.mtimeMs,
      dev: st.dev,
      ino: st.ino,
    });
  });
  it('顺序:agent(claude、codex、pi)→ mtime 升序 → path 字节序(同 mtime;BMP 全角字符排在 4 字节字符之前,与 UTF-16 序相反)', async () => {
    const f = await makeL0Fx('en-ord-');
    const t0 = new Date('2026-10-01T00:00:00Z');
    const at = (s: number): Date => new Date(t0.getTime() + s * 1000);
    const pi1 = await put(f, 'pi', '--a--/a-new.jsonl', 'x\n');
    const pi2 = await put(f, 'pi', '--a--/b-old.jsonl', 'x\n');
    const cx = await put(f, 'codex', '2026/10/24/rollout-1.jsonl', 'x\n');
    const cl = await put(f, 'claude', `p/${uuid(1)}.jsonl`, 'x\n');
    touchAt(pi1, at(50));
    touchAt(pi2, at(10));
    touchAt(cx, at(99));
    touchAt(cl, at(1));
    const e = await enumerateSessionFiles(f.home, f.config, false);
    expect(e.files.map((x) => x.path)).toEqual([cl, cx, pi2, pi1]);
    const g = await makeL0Fx('en-ord2-');
    const emoji = await put(g, 'pi', '--a--/\u{1F600}.jsonl', 'x\n');
    const wide = await put(g, 'pi', '--a--/～.jsonl', 'x\n');
    touchAt(emoji, at(5));
    touchAt(wide, at(5));
    const e2 = await enumerateSessionFiles(g.home, g.config, false);
    expect(e2.files.map((x) => x.path)).toEqual([wide, emoji]);
  });
});

describe('enumerateSessionFiles:上限、根状态与竞态', () => {
  it('目录项上限:恰好 N → complete;N-1 → RSI_LIMIT_ENTRIES、complete=false、entriesSeen=N-1(第 N 项不处理)', async () => {
    const f = await makeL0Fx('en-lim-');
    for (let i = 0; i < 3; i++) await put(f, 'pi', `--a--/s${i}.jsonl`, 'x\n');
    // 条目:--a-- 目录 + 3 个文件 = 4
    const ok = await enumerateSessionFiles(f.home, f.config, false, {
      limits: { maxDirEntries: 4 },
    });
    expect(ok.complete).toBe(true);
    expect(ok.entriesSeen).toBe(4);
    expect(ok.files.length).toBe(3);
    const cut = await enumerateSessionFiles(f.home, f.config, false, {
      limits: { maxDirEntries: 3 },
    });
    expect(cut.complete).toBe(false);
    expect(cut.entriesSeen).toBe(3);
    expect([...cut.limitsHit]).toEqual(['RSI_LIMIT_ENTRIES']);
    expect(cut.files.length).toBe(2);
  });
  it('计数恰好到上限的最后一个条目是目录:不进入(不调用它的 readdir),记 RSI_LIMIT_ENTRIES、complete=false;对照:预算够时进入并完整', async () => {
    const f = await makeL0Fx('en-lastdir-');
    await put(f, 'pi', '--a--/s.jsonl', 'x\n');
    const readdirs: string[] = [];
    const beforeStep = (step: string, p: string): void => {
      if (step === 'readdir') readdirs.push(p);
    };
    const cut = await enumerateSessionFiles(f.home, f.config, false, {
      limits: { maxDirEntries: 1 },
      beforeStep,
    });
    expect(readdirs).toEqual([rootOf(f, 'pi')]);
    expect(cut.files).toEqual([]);
    expect([...cut.limitsHit]).toEqual(['RSI_LIMIT_ENTRIES']);
    expect(cut.complete).toBe(false);
    readdirs.length = 0;
    const ok = await enumerateSessionFiles(f.home, f.config, false, {
      limits: { maxDirEntries: 2 },
      beforeStep,
    });
    expect(readdirs).toEqual([rootOf(f, 'pi'), path.join(rootOf(f, 'pi'), '--a--')]);
    expect(ok.files.length).toBe(1);
    expect(ok.complete).toBe(true);
  });
  it('上限是跨 agent 共享的:先列的 claude 用完预算,后面的 codex 不再列举', async () => {
    const f = await makeL0Fx('en-shared-');
    await put(f, 'claude', `p/${uuid(1)}.jsonl`, 'x\n'); // 2 项
    await put(f, 'codex', '2026/10/24/rollout-a.jsonl', 'x\n');
    const e = await enumerateSessionFiles(f.home, f.config, false, {
      limits: { maxDirEntries: 2 },
    });
    expect(e.files.map((x) => x.agent)).toEqual(['claude']);
    expect(e.complete).toBe(false);
  });
  it('根不存在 → absent 且 complete 仍为 true;根是符号链接 → not_evaluated、不列举、complete=false;pi 已设 → 不列举', async () => {
    const f = await makeL0Fx('en-roots-');
    const e0 = await enumerateSessionFiles(f.home, f.config, false);
    expect(e0.complete).toBe(true);
    expect(e0.roots.claude).toEqual({ status: 'absent' });
    const real = path.join(f.dir, 'real-root');
    await mkdirp(f.fx, path.join(real, 'p'), 0o755);
    await put(
      { home: path.join(f.dir, 'real-root-home'), fx: f.fx },
      'claude',
      `p/${uuid(1)}.jsonl`,
      'x\n',
    );
    await mkdirp(f.fx, path.join(f.home, '.claude'), 0o755);
    await symlink(
      f.fx,
      path.join(f.dir, 'real-root-home', '.claude', 'projects'),
      rootOf(f, 'claude'),
    );
    const e1 = await enumerateSessionFiles(f.home, f.config, false);
    expect(e1.roots.claude).toEqual({ status: 'not_evaluated', reason: 'root_symlink' });
    expect(e1.files).toEqual([]);
    expect(e1.complete).toBe(false);
    await put(f, 'pi', '--a--/s.jsonl', 'x\n');
    const e2 = await enumerateSessionFiles(f.home, f.config, true);
    expect(e2.roots.pi).toEqual({ status: 'not_evaluated', reason: 'pi_dir_override' });
    expect(e2.files.filter((x) => x.agent === 'pi')).toEqual([]);
  });
  it('没配置的 agent 不列举', async () => {
    const f = await makeL0Fx('en-cfg-');
    await put(f, 'claude', `p/${uuid(1)}.jsonl`, 'x\n');
    await put(f, 'pi', '--a--/s.jsonl', 'x\n');
    const e = await enumerateSessionFiles(f.home, { ...f.config, agents: ['claude'] }, false);
    expect(e.files.map((x) => x.agent)).toEqual(['claude']);
  });
  it.skipIf(process.getuid?.() === 0)(
    '读不了的子目录(EACCES)→ complete=false;文件仍是已列出的那些',
    async () => {
      const f = await makeL0Fx('en-eacces-');
      await put(f, 'pi', '--a--/s.jsonl', 'x\n');
      const dir = path.join(rootOf(f, 'pi'), '--a--');
      await chmod(f.fx, dir, 0o000);
      try {
        const e = await enumerateSessionFiles(f.home, f.config, false);
        expect(e.complete).toBe(false);
        expect(e.files).toEqual([]);
      } finally {
        await chmod(f.fx, dir, 0o755);
      }
    },
  );
  it('列举中途根被换成符号链接(旧目录改名保留)→ 该 agent 作废(无文件、not_evaluated、complete=false);对照:不换时有文件', async () => {
    const f = await makeL0Fx('en-swap-');
    await put(f, 'claude', `p/${uuid(1)}.jsonl`, 'x\n');
    const base = await enumerateSessionFiles(f.home, f.config, false);
    expect(base.files.length).toBe(1);
    const root = rootOf(f, 'claude');
    let done = false;
    const e = await enumerateSessionFiles(f.home, f.config, false, {
      beforeStep: async (step, p) => {
        if (step === 'readdir' && p === root && !done) {
          done = true;
          await rename(f.fx, root, `${root}.moved`);
          await symlink(f.fx, `${root}.moved`, root);
        }
      },
    });
    expect(done).toBe(true);
    expect(e.files).toEqual([]);
    expect(e.roots.claude).toEqual({ status: 'not_evaluated', reason: 'root_symlink' });
    expect(e.complete).toBe(false);
  });
  it('列举中途根被换成另一个普通目录(身份变了)→ 同样作废', async () => {
    const f = await makeL0Fx('en-swap2-');
    await put(f, 'claude', `p/${uuid(1)}.jsonl`, 'x\n');
    const root = rootOf(f, 'claude');
    let done = false;
    const e = await enumerateSessionFiles(f.home, f.config, false, {
      beforeStep: async (step, p) => {
        if (step === 'readdir' && p === root && !done) {
          done = true;
          await rename(f.fx, root, `${root}.moved`);
          await put(f, 'claude', `q/${uuid(2)}.jsonl`, 'x\n');
        }
      },
    });
    expect(e.files).toEqual([]);
    expect(e.complete).toBe(false);
    void jl;
  });
});

/**
 * S4:只读快照构建器、HOME 准入、payload 位置解析,以及「真实 HOME 未被触碰」的只读比较。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOME_WRITE_TABLE } from '../../src/contracts/sync.js';
import { getRealHome } from '../../src/io/paths.js';
import { lstat, readDir, realpath } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { renderManagedBlock } from '../../src/render/managed-block.js';
import { loadPayload, resolvePayloadRoot, SyncPayloadError } from '../../src/sync/payload-load.js';
import {
  buildDiskSnapshot,
  entryDirOf,
  listResidualTxns,
  readLedger,
  resolveAllowedHome,
  sha256Of,
} from '../../src/sync/snapshot.js';
import { OWNED_DIRS } from '../../src/sync/classify.js';
import { BLOCK_ID, CODEX_MD, PI_MD, SKILL, newWorld, stdFixture, treeOf } from './world.js';

const req = (home: string, paths: string[], over: Record<string, unknown> = {}) => ({
  home,
  paths,
  blockIds: {},
  ledgerPaths: [],
  ownedDirs: OWNED_DIRS,
  ...over,
});

describe('buildDiskSnapshot(只读)', () => {
  it('各类现状:缺失 / 文件 / 目录 / 符号链接 / 中间段链接 / 硬链接 / 条目被占用;不写不建目录', async () => {
    const w = await newWorld('snap-kinds-');
    await w.put('.claude/skills/a/SKILL.md', 'A\n');
    await safe.mkdirp(w.io, path.join(w.home, '.claude/skills/dirtarget/SKILL.md'));
    await safe.mkdirp(w.io, path.join(w.dir, 'real-skills'));
    await safe.symlink(w.io, path.join(w.dir, 'real-skills'), path.join(w.home, '.agents-link'));
    await safe.mkdirp(w.io, path.join(w.home, '.agents'));
    await safe.symlink(w.io, path.join(w.dir, 'real-skills'), path.join(w.home, '.agents/skills'));
    await w.put('.pi/agent/AGENTS.md', 'pi\n');
    await safe.hardlink(w.io, path.join(w.home, PI_MD), path.join(w.dir, 'pi-hard'));
    await w.put('.codex/agents/occupied/note.md', 'x\n');
    await safe.symlink(
      w.io,
      path.join(w.home, '.claude/skills/a/SKILL.md'),
      path.join(w.home, '.claude/skills/link-leaf'),
    );
    await safe.mkdirp(w.io, path.join(w.home, '.claude/skills/link-leaf-dir'));
    await safe.symlink(
      w.io,
      path.join(w.home, '.claude/skills/a/SKILL.md'),
      path.join(w.home, '.claude/skills/link-leaf-dir/SKILL.md'),
    );
    const before = await treeOf(w.home);
    const { snapshot, texts, modes } = await buildDiskSnapshot(
      req(w.home, [
        '.claude/skills/a/SKILL.md',
        '.claude/skills/missing/SKILL.md',
        '.claude/skills/dirtarget/SKILL.md',
        '.agents/skills/x/SKILL.md',
        PI_MD,
        '.codex/agents/occupied/agent.toml',
        '.claude/skills/link-leaf-dir/SKILL.md',
        '../escape',
        '.claude/settings.json',
        '.claude/skills/.hidden/SKILL.md',
      ]),
    );
    const e = snapshot.entries;
    expect(e['.claude/skills/a/SKILL.md']).toEqual({ kind: 'file', sha256: sha256Of('A\n') });
    expect(texts.get('.claude/skills/a/SKILL.md')).toBe('A\n');
    expect(modes.get('.claude/skills/a/SKILL.md')).toBeDefined();
    expect(e['.claude/skills/missing/SKILL.md']).toEqual({ kind: 'missing' });
    expect(e['.claude/skills/dirtarget/SKILL.md']?.kind).toBe('dir');
    expect(e['.agents/skills/x/SKILL.md']).toEqual({ kind: 'missing', linkedSegment: true });
    expect(e[PI_MD]?.kind).toBe('hardlink');
    expect(e['.codex/agents/occupied/agent.toml']).toEqual({
      kind: 'missing',
      entryOccupied: true,
    });
    expect(e['.claude/skills/link-leaf-dir/SKILL.md']?.kind).toBe('symlink');
    // 表外 / 越界 / 点开头 / .json 路径一律不探测
    expect(e['../escape']).toBeUndefined();
    expect(e['.claude/settings.json']).toBeUndefined();
    expect(e['.claude/skills/.hidden/SKILL.md']).toBeUndefined();
    expect(snapshot.residualTxn).toBeNull();
    const after = await treeOf(w.home);
    expect([...after.files]).toEqual([...before.files]);
    expect([...after.dirs]).toEqual([...before.dirs]);
    expect([...after.dirMtimes]).toEqual([...before.dirMtimes]);
    expect(await w.has('.local')).toBe(false);
  });

  it('条目里已有我们自己登记的文件时,条目目录不算被占用', async () => {
    const w = await newWorld('snap-ledgerdir-');
    await w.put('.claude/skills/a/SKILL.md', 'A\n');
    const p = ['.claude/skills/a/extra.md'];
    expect((await buildDiskSnapshot(req(w.home, p))).snapshot.entries[p[0] as string]).toEqual({
      kind: 'missing',
      entryOccupied: true,
    });
    const own = await buildDiskSnapshot(
      req(w.home, p, { ledgerPaths: ['.claude/skills/a/SKILL.md'] }),
    );
    expect(own.snapshot.entries[p[0] as string]).toEqual({ kind: 'missing' });
    expect(entryDirOf('.claude/rules/agent-kit/org.md', OWNED_DIRS)).toBeUndefined();
    expect(entryDirOf('.claude/skills/a/SKILL.md', OWNED_DIRS)).toBe('.claude/skills/a');
    expect(entryDirOf(CODEX_MD, OWNED_DIRS)).toBeUndefined();
  });

  it('托管块状态:intact / drifted / block-missing / corrupt,restBlank 与整文件 sha', async () => {
    const w = await newWorld('snap-blocks-');
    const block = renderManagedBlock(BLOCK_ID, '体\n');
    await w.put(CODEX_MD, block);
    await w.put(PI_MD, `用户\n\n${block}`);
    await w.put('.kimi-code/AGENTS.md', block.replace('体', '被改'));
    await w.put(
      '.config/opencode/AGENTS.md',
      '<!-- agent-kit:begin id=agent-kit-rules sha256=zz -->\n',
    );
    await w.put('.codex/agents/none.toml', '只有用户内容\n');
    const ids = {
      [CODEX_MD]: [BLOCK_ID],
      [PI_MD]: [BLOCK_ID],
      '.kimi-code/AGENTS.md': [BLOCK_ID],
      '.config/opencode/AGENTS.md': [BLOCK_ID],
    };
    const { snapshot } = await buildDiskSnapshot(req(w.home, Object.keys(ids), { blockIds: ids }));
    const b = (p: string) => snapshot.entries[p]?.blocks?.[BLOCK_ID];
    expect(b(CODEX_MD)).toMatchObject({ state: 'intact', restBlank: true });
    expect(b(PI_MD)).toMatchObject({ state: 'intact', restBlank: false });
    expect(b('.kimi-code/AGENTS.md')?.state).toBe('drifted');
    expect(b('.config/opencode/AGENTS.md')).toEqual({ state: 'corrupt' });
    expect(snapshot.entries[CODEX_MD]?.sha256).toBe(sha256Of(block));
    const none = await buildDiskSnapshot(
      req(w.home, ['.codex/agents/none.toml'], {
        blockIds: { '.codex/agents/none.toml': [BLOCK_ID] },
      }),
    );
    expect(none.snapshot.entries['.codex/agents/none.toml']?.blocks?.[BLOCK_ID]).toEqual({
      state: 'block-missing',
    });
  });

  it('独占目录清单(递归)与残留事务探测;登记表读取区分 absent / ok / invalid / unsafe', async () => {
    const w = await newWorld('snap-state-');
    await w.put('.claude/rules/agent-kit/org.md', 'a\n');
    await w.put('.claude/rules/agent-kit/paths/p.md', 'b\n');
    const s = await buildDiskSnapshot(req(w.home, []));
    expect(s.snapshot.ownedDirListings?.['.claude/rules/agent-kit/']).toEqual([
      '.claude/rules/agent-kit/org.md',
      '.claude/rules/agent-kit/paths/p.md',
    ]);
    expect((await readLedger(w.home)).state).toBe('absent');
    await w.put('.local/state/agent-kit/sync/txn/txn-20261014T120000Z-abc123.json', '{}');
    await w.put('.local/state/agent-kit/sync/txn/not-a-txn.json', '{}');
    expect(await listResidualTxns(w.home)).toEqual(['txn-20261014T120000Z-abc123']);
    expect((await buildDiskSnapshot(req(w.home, []))).snapshot.residualTxn).toBe(
      'txn-20261014T120000Z-abc123',
    );
    await w.put('.local/state/agent-kit/sync/ledger.json', '{"x":1}');
    expect((await readLedger(w.home)).state).toBe('invalid');
    await safe.remove(w.io, path.join(w.home, '.local/state/agent-kit/sync'));
    await safe.mkdirp(w.io, path.join(w.dir, 'state-elsewhere'));
    await safe.symlink(
      w.io,
      path.join(w.dir, 'state-elsewhere'),
      path.join(w.home, '.local/state/agent-kit/sync'),
    );
    expect((await readLedger(w.home)).state).toBe('unsafe'); // 状态目录是链接:不读;命令层先用 stateDirUnsafe 拒绝
  });
});

describe('resolveAllowedHome', () => {
  it('真实 HOME(含 KIT_REAL_HOME_OVERRIDE)与 KIT_TMP 严格之内可以;其余不行', async () => {
    const w = await newWorld('snap-home-');
    const tmp = w.dir;
    const real = await realpath(w.home);
    expect(await resolveAllowedHome(w.home, tmp, {})).toBe(real);
    expect(await resolveAllowedHome(tmp, tmp, {})).toBeUndefined(); // KIT_TMP 本身不算「严格之内」
    expect(await resolveAllowedHome('/tmp', tmp, {})).toBeUndefined();
    expect(await resolveAllowedHome('relative/home', tmp, {})).toBeUndefined();
    expect(await resolveAllowedHome(path.join(w.dir, 'nope'), tmp, {})).toBeUndefined();
    expect(await resolveAllowedHome(w.home, undefined, {})).toBeUndefined(); // 没有 KIT_TMP 时假 HOME 不被接受
    // 等于 getRealHome(env) 的目录可以(即使不在 KIT_TMP 内)
    expect(await resolveAllowedHome(w.home, undefined, { KIT_REAL_HOME_OVERRIDE: w.home })).toBe(
      real,
    );
    expect(await resolveAllowedHome(w.home, tmp, { KIT_REAL_HOME_OVERRIDE: '/tmp' })).toBe(real); // 仍在 KIT_TMP 内
    // KIT_TMP 之内指向 KIT_TMP 之内的链接:按 realpath 判,仍在之内
    await safe.symlink(w.io, path.join(w.dir, 'pkg'), path.join(w.dir, 'link-to-pkg'));
    expect(await resolveAllowedHome(path.join(w.dir, 'link-to-pkg'), tmp, {})).toBeDefined();
    expect(getRealHome({ KIT_REAL_HOME_OVERRIDE: '/x' })).toBe('/x');
  });
});

describe('payload 位置与加载', () => {
  it('KIT_PAYLOAD_DIR 只在 KIT_TMP 严格之内才生效;否则用包相对路径(仓库里没构建 payload → NO_PAYLOAD)', async () => {
    const w = await newWorld('snap-payload-');
    await w.setPayload(stdFixture());
    const inside = await resolvePayloadRoot({ KIT_PAYLOAD_DIR: w.payloadRoot }, w.dir);
    expect(inside).toBe(await realpath(w.payloadRoot));
    const outside = await resolvePayloadRoot({ KIT_PAYLOAD_DIR: '/tmp' }, w.dir);
    expect(outside).not.toBe('/tmp');
    expect(await resolvePayloadRoot({ KIT_PAYLOAD_DIR: w.payloadRoot }, undefined)).not.toBe(
      inside,
    );
    const loaded = await loadPayload(inside);
    expect(loaded.manifest.files.length).toBe(stdFixture().length);
    expect(loaded.contents.size).toBe(stdFixture().length);
    expect(Object.values(loaded.payloadSha).every((s) => /^[0-9a-f]{64}$/.test(s))).toBe(true);
    await expect(loadPayload(path.join(w.dir, 'nothing'))).rejects.toMatchObject({
      code: 'SYNC_NO_PAYLOAD',
    });
    await expect(loadPayload(undefined)).rejects.toBeInstanceOf(SyncPayloadError);
  });
});

/** 真实 HOME 里所有受管路径的只读元数据快照(类型 / 权限位 / 大小 / mtime / ino;不读内容、不跟随符号链接)。 */
async function metaSnapshot(home: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(rel: string): Promise<void> {
    const abs = path.join(home, rel);
    let st;
    try {
      st = await lstat(abs);
    } catch {
      out.push(`${rel} <absent>`);
      return;
    }
    out.push(
      `${rel} ${st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'f'} ${st.mode.toString(8)} ${st.size} ${st.mtimeMs} ${st.ino}`,
    );
    if (st.isDirectory()) {
      for (const e of await readDir(abs)) await visit(`${rel}/${e.name}`);
    }
  }
  for (const e of HOME_WRITE_TABLE) await visit(e.path.replace(/\/$/, ''));
  return out;
}

describe('真实 HOME 未被触碰', () => {
  it('跑完整套命令(干跑 / 写 / 卸载 / 回滚,全部 --home 假 HOME)前后,真实 HOME 受管路径元数据快照零差异', async () => {
    const real = getRealHome();
    const before = await metaSnapshot(real);
    const w = await newWorld('snap-realhome-');
    await w.setPayload(stdFixture());
    await w.put(PI_MD, '用户\n');
    expect((await w.run([])).code).toBe(0);
    const inst = await w.run(['--write']);
    expect(inst.code).toBe(0);
    const id = /^txn (\S+)$/m.exec(inst.out)?.[1] as string;
    expect((await w.run(['--write', '--rollback', id])).code).toBe(0);
    expect((await w.run(['--write'])).code).toBe(0);
    expect((await w.run(['--write', '--uninstall'])).code).toBe(0);
    // 缺省 HOME 走 getRealHome(env):把它指到假 HOME(KIT_REAL_HOME_OVERRIDE),干跑 + 写都落在假 HOME
    const viaEnv = await w.run(['--write'], {
      noHome: true,
      env: { KIT_REAL_HOME_OVERRIDE: w.home },
    });
    expect(viaEnv.code).toBe(0);
    expect(await w.has(SKILL)).toBe(true);
    const after = await metaSnapshot(real);
    expect(after).toEqual(before);
    // 正向对照:同一个快照函数能发现假 HOME 里的变化(证明判据不是对什么都成立)
    const fakeBefore = await metaSnapshot(w.home);
    expect((await w.run(['--write', '--uninstall'])).code).toBe(0);
    expect(await metaSnapshot(w.home)).not.toEqual(fakeBefore);
    expect(before.length).toBeGreaterThan(HOME_WRITE_TABLE.length - 1); // 快照确实枚举了所有受管路径条目
  });
});

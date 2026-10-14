/**
 * S4:sync 命令端到端(全部在 KIT_TMP 内的假 HOME 上;真实 HOME 不碰)。
 * 世界 = 假 HOME + 假包根(payload/ + integrity.json 夹具)。被测命令经 createSyncCommand 直接调用。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { REPO_ROOT } from '../helpers/tmp.js';
import { lstat, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import {
  CANARY_USER,
  CODEX_MD,
  KIMI_MD,
  PI_MD,
  RULES,
  SHARED,
  sha,
  SKILL,
  STATE_PREFIX,
  isState,
  newWorld,
  stdFixture,
  treeOf,
  type World,
} from './world.js';

const LEDGER = `${STATE_PREFIX}/sync/ledger.json`;

/** 带用户既有内容的 HOME:pi 的 AGENTS.md(以单个换行结尾)、别人的技能、skills-hub 清单、claude 设置。 */
async function userHome(w: World): Promise<void> {
  await w.put(PI_MD, `用户自己的 pi 规则 ${CANARY_USER}\n`);
  await w.put('.agents/skills/other-skill/SKILL.md', `别人的技能 ${CANARY_USER}\n`);
  await w.put('.agents/.social-hub-skills.json', '{"skills":["other-skill"]}\n');
  await w.put('.claude/settings.json', '{"theme":"dark"}\n', 0o600);
  await w.put('.claude/CLAUDE.md', `# 我的 ${CANARY_USER}\n`);
}

async function ready(label: string): Promise<World> {
  const w = await newWorld(label);
  await w.setPayload(stdFixture());
  return w;
}

describe('sync:接线', () => {
  it('经 src/cli.ts 的 main 调用:命令表里的 sync 就是本实现(不再是桩 64)', async () => {
    const w = await ready('sync-wiring-');
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['sync', '--home', w.home], {
      env: { ...w.env, KIT_PAYLOAD_DIR: w.payloadRoot },
      cwd: REPO_ROOT,
      stdout: (t) => void out.push(t),
      stderr: (t) => void err.push(t),
    });
    expect(code).toBe(ExitCode.OK);
    expect(out.join('')).toContain('would create');
    expect(err.join('')).toBe('');
    expect(await w.has('.claude')).toBe(false);
  });
});

describe('sync:干跑', () => {
  it('干跑零写入:快照零差异,不建 ~/.local/state;计划行格式固定', async () => {
    const w = await ready('sync-dry-');
    await userHome(w);
    const before = await treeOf(w.home);
    const r = await w.run([]);
    const after = await treeOf(w.home);
    expect(r.code).toBe(ExitCode.OK);
    expect([...after.files]).toEqual([...before.files]);
    expect([...after.dirs]).toEqual([...before.dirs]);
    expect(await w.has('.local')).toBe(false);
    expect(r.out).toMatch(
      /^would create ~\/\.claude\/skills\/commit-checklist\/SKILL\.md sha256=[0-9a-f]{12} agents=claude$/m,
    );
    expect(r.out).toMatch(
      /would create ~\/\.agents\/skills\/commit-checklist\/SKILL\.md sha256=[0-9a-f]{12} agents=codex,pi/,
    );
    expect(r.out).toMatch(
      /would block_upsert ~\/\.codex\/AGENTS\.md sha256=[0-9a-f]{12} agents=codex block=agent-kit-rules/,
    );
    expect(r.out).toMatch(/^plan create=3 update=0 remove=0 block_upsert=2 /m);
    expect(r.out).toContain('skippedLayers personal');
  });

  it('默认只装 claude/codex/pi;kimi 要 --agent 显式指定才装', async () => {
    const w = await ready('sync-kimi-');
    const r = await w.run(['--write']);
    expect(r.code).toBe(0);
    expect(await w.has(KIMI_MD)).toBe(false);
    const k = await w.run(['--write', '--agent', 'kimi']);
    expect(k.code).toBe(0);
    expect(await w.has(KIMI_MD)).toBe(true);
    // 共用技能路径只写一次(登记表 agents 合并了 kimi)
    const ledger = JSON.parse(await w.read(LEDGER)) as {
      entries: { path: string; agents: string[] }[];
    };
    expect(ledger.entries.find((e) => e.path === SHARED)?.agents).toEqual(['codex', 'pi', 'kimi']);
  });

  it('--home 不在 KIT_TMP 之内也不是真实 HOME → 退出 2 home_not_allowed', async () => {
    const w = await ready('sync-home-');
    const r = await w.run(['--home', '/tmp'], { noHome: true });
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.err).toBe('SYNC_USAGE reason=home_not_allowed\n');
    const rel = await w.run(['--home', 'home'], { noHome: true });
    expect(rel.code).toBe(ExitCode.USAGE);
  });

  it('用法错误码', async () => {
    const w = await ready('sync-usage-');
    const reasons = async (a: string[]): Promise<string> => (await w.run(a)).err;
    expect(await reasons(['--resume', '--uninstall'])).toBe('SYNC_USAGE reason=mode_conflict\n');
    expect(await reasons(['--rollback'])).toBe('SYNC_USAGE reason=missing:--rollback\n');
    expect(await reasons(['--rollback', 'nope'])).toBe('SYNC_USAGE reason=bad_txn_id\n');
    expect(await reasons(['--agent', 'openclaw'])).toBe('SYNC_USAGE reason=bad_agent\n');
    expect(await reasons(['--overwrite-drifted'])).toBe(
      'SYNC_USAGE reason=overwrite_requires_write\n',
    );
    expect(await reasons(['--bogus'])).toBe('SYNC_USAGE reason=unknown_arg\n');
  });
});

describe('sync:往返与幂等', () => {
  it('装 → 卸载:受管路径树逐字节一致(忽略状态目录与 sync 自己建的空目录)', async () => {
    const w = await ready('sync-roundtrip-');
    await userHome(w);
    const before = await treeOf(w.home);
    const inst = await w.run(['--write']);
    expect(inst.code).toBe(0);
    expect(inst.out).toMatch(/^did create ~\/\.claude\/skills\/commit-checklist\/SKILL\.md /m);
    expect(await w.has(SKILL)).toBe(true);
    expect(await w.read(PI_MD)).toContain(CANARY_USER); // 用户内容还在
    expect(await w.read(PI_MD)).toContain('agent-kit:begin');
    expect(await w.has(CODEX_MD)).toBe(true);
    const uninst = await w.run(['--write', '--uninstall']);
    expect(uninst.code).toBe(0);
    const after = await treeOf(w.home, isState);
    // 判据:文件集合(路径 + 权限位 + 内容 sha)逐字节一致;新增的目录只能是空目录(sync 隐式创建、home-fs 不允许删的条目目录及其上级)
    expect([...after.files].sort()).toEqual([...before.files].sort());
    const extraDirs = [...after.dirs].filter((d) => !before.dirs.has(d));
    for (const d of extraDirs) {
      const prefix = `${d}/`;
      const hasFile = [...after.files.keys()].some((f) => f.startsWith(prefix));
      expect(hasFile, `新增目录 ${d} 应为空目录`).toBe(false);
    }
    // 登记表随最后一个条目一起被删
    expect(await w.has(LEDGER)).toBe(false);
    // sync 自己新建的条目目录(home-fs 允许删的那一层)已被清理
    expect(await w.has('.claude/skills/commit-checklist')).toBe(false);
    expect(await w.has('.agents/skills/commit-checklist')).toBe(false);
    expect(await w.has(CODEX_MD)).toBe(false); // created_file 且删块后只剩空白 → 文件一并删除
  });

  it('第二次 --write:零操作、零 mtime 变化、不拿锁不建事务', async () => {
    const w = await ready('sync-idem-');
    await userHome(w);
    expect((await w.run(['--write'])).code).toBe(0);
    const t1 = await treeOf(w.home);
    await new Promise((r) => setTimeout(r, 30));
    const again = await w.run(['--write']);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/^plan create=0 update=0 remove=0 block_upsert=0 block_remove=0 /m);
    expect(again.out).not.toMatch(/^(did|would) (create|update|remove|block_)/m);
    const t2 = await treeOf(w.home);
    expect([...t2.files]).toEqual([...t1.files]);
    expect([...t2.mtimes]).toEqual([...t1.mtimes]); // 含状态目录里的所有文件:零 mtime 变化
    expect([...t2.dirMtimes]).toEqual([...t1.dirMtimes]); // 目录项也没变(没拿过锁、没建过事务)
    expect([...t2.dirs]).toEqual([...t1.dirs]);
  });

  it('payload 升级后 --write 更新文件与块,块外字节不变', async () => {
    const w = await ready('sync-upgrade-');
    await userHome(w);
    await w.run(['--write']);
    const userBefore = (await w.read(PI_MD)).split('<!-- agent-kit:begin')[0];
    await w.setPayload(stdFixture('v2'));
    const r = await w.run(['--write']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^did update ~\/\.claude\/skills\/commit-checklist\/SKILL\.md /m);
    expect(await w.read(SKILL)).toContain('v2');
    expect((await w.read(PI_MD)).split('<!-- agent-kit:begin')[0]).toBe(userBefore);
    expect(await w.read(PI_MD)).toContain('规则块 v2');
    expect((await w.run(['--write'])).out).toMatch(/^plan create=0 update=0 /m);
  });
});

describe('sync:拒绝与保护', () => {
  it('漂移:用户手改过的登记文件保留、跳过、退出 1;--overwrite-drifted 才覆盖并先备份', async () => {
    const w = await ready('sync-drift-');
    await w.run(['--write']);
    await w.put(SKILL, `用户改过 ${CANARY_USER}\n`);
    await w.setPayload(stdFixture('v2'));
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toContain('SYNC_CHECK_FAILED reason=SYNC_DRIFTED');
    expect(await w.read(SKILL)).toContain(CANARY_USER);
    expect(await w.read(RULES)).toContain('v2'); // 其余条目照常处理
    const o = await w.run(['--write', '--overwrite-drifted']);
    expect(o.code).toBe(0);
    expect(await w.read(SKILL)).toContain('v2');
    const txn = /^txn (txn-\S+)$/m.exec(o.out)?.[1];
    expect(txn).toBeDefined();
    const backup = await readText(
      path.join(w.home, `${STATE_PREFIX}/sync/backups/${txn}/files/${SKILL}`),
    );
    expect(backup).toContain(CANARY_USER); // 覆盖前先备份了用户版本
  });

  it('外来文件:路径已有未登记文件(内容恰好等于 payload 也拒绝),退出 1', async () => {
    const w = await ready('sync-foreign-');
    await w.put(SKILL, `别人的 ${CANARY_USER}\n`);
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toContain('SYNC_CHECK_FAILED reason=SYNC_TARGET_FOREIGN');
    expect(await w.read(SKILL)).toContain(CANARY_USER);
    // 内容恰好等于 payload:仍拒绝(除非 --adopt)
    const w2 = await ready('sync-foreign2-');
    await w2.put(
      SKILL,
      await readText(path.join(w2.payloadRoot, `payload/files/claude/home/${SKILL}`)),
    );
    const r2 = await w2.run(['--write']);
    expect(r2.code).toBe(ExitCode.CHECK_FAILED);
    expect(r2.err).toContain('SYNC_TARGET_FOREIGN');
  });

  it('--adopt:丢了登记表时认领内容等于 payload 的文件,别的当外来', async () => {
    const w = await ready('sync-adopt-');
    await w.run(['--write']);
    await safe.remove(w.io, path.join(w.home, LEDGER));
    await w.put(RULES, `不是 payload 的内容\n`);
    const dry = await w.run(['--adopt']);
    expect(dry.out).toMatch(/^would adopt ~\/\.claude\/skills\/commit-checklist\/SKILL\.md /m);
    const r = await w.run(['--write', '--adopt']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED); // RULES 内容不符 → 外来
    expect(await w.has(LEDGER)).toBe(true);
    const ledger = JSON.parse(await w.read(LEDGER)) as { entries: { path: string }[] };
    expect(ledger.entries.map((e) => e.path)).toContain(SKILL);
    expect(ledger.entries.map((e) => e.path)).not.toContain(RULES);
    // 认领之后正常 sync 视为已安装(技能不再 create)
    const s = await w.run([]);
    expect(s.out).not.toMatch(/would create ~\/\.claude\/skills/);
  });

  it('共用路径冲突:各 agent 渲染出的内容 sha 不同 → 整次拒绝(退出 3,不写)', async () => {
    const w = await newWorld('sync-shared-');
    const files = stdFixture();
    const pi = files.find((f) => f.agent === 'pi' && f.path === SHARED);
    if (pi) pi.content = `${pi.content}差异\n`;
    await w.setPayload(files);
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('SYNC_FAIL_CLOSED reason=SYNC_SHARED_PATH_CONFLICT');
    expect(await w.has('.claude')).toBe(false);
    expect(await w.has('.local')).toBe(false);
  });

  it('符号链接中间段:整次拒绝不写(决策 ⑩A)', async () => {
    const w = await ready('sync-symlink-');
    await safe.mkdirp(w.io, path.join(w.dir, 'dotfiles'));
    await safe.symlink(w.io, path.join(w.dir, 'dotfiles'), path.join(w.home, '.claude'));
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('SYNC_FAIL_CLOSED reason=SYNC_PATH_SYMLINK');
    expect(await w.has('.agents')).toBe(false); // 预检拒绝:连不相干的目标也没写
    expect(await w.has('.local')).toBe(false);
    const lst = await lstat(path.join(w.dir, 'dotfiles'));
    expect(lst.isDirectory()).toBe(true);
  });

  it('条目目录本身是符号链接(~/.claude/skills/<name> -> ../../.agents/skills/<name>):拒绝', async () => {
    const w = await ready('sync-entrylink-');
    await safe.mkdirp(w.io, path.join(w.home, '.agents/skills/commit-checklist'));
    await safe.mkdirp(w.io, path.join(w.home, '.claude/skills'));
    await safe.symlink(
      w.io,
      path.join(w.home, '.agents/skills/commit-checklist'),
      path.join(w.home, '.claude/skills/commit-checklist'),
    );
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('SYNC_PATH_SYMLINK');
  });

  it('skills-hub 同名条目:拒绝(外来),不碰点开头条目、不碰对方清单', async () => {
    const w = await ready('sync-hub-');
    await w.put('.agents/skills/commit-checklist/SKILL.md', `hub 托管 ${CANARY_USER}\n`);
    await w.put('.agents/skills/commit-checklist/README.md', 'hub\n');
    await w.put('.agents/.social-hub-skills.json', '{"skills":["commit-checklist"]}\n');
    await w.put('.agents/skills/.geoly/x.json', '{}\n');
    const hubTree = await treeOf(w.home, (r) => !r.startsWith('.agents'));
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toContain('SYNC_TARGET_FOREIGN');
    const after = await treeOf(w.home, (r2) => !r2.startsWith('.agents'));
    expect([...after.files]).toEqual([...hubTree.files]);
    // 目录里已有别人的东西、但目标文件不在(条目被占用)也拒绝
    const w2 = await ready('sync-hub2-');
    await w2.put('.agents/skills/commit-checklist/notes.md', 'hub 的别的文件\n');
    const r2 = await w2.run(['--write']);
    expect(r2.code).toBe(ExitCode.CHECK_FAILED);
    expect(await w2.has('.agents/skills/commit-checklist/SKILL.md')).toBe(false);
  });

  it('点开头条目:payload 里的点开头路径被 schema 拒绝(SYNC_PAYLOAD_INVALID),不会写到点目录', async () => {
    const w = await newWorld('sync-dot-');
    const files = stdFixture();
    files.push({
      agent: 'claude',
      path: '.claude/skills/.hidden/SKILL.md',
      content: 'x\n',
      kind: 'skill',
    });
    // 夹具构造期就被 PayloadManifestSchema 拒绝
    await expect(w.setPayload(files)).rejects.toThrow();
  });

  it('独占目录里的非登记文件:保留并退出 1(SYNC_UNMANAGED_IN_OWNED_DIR),文件名不进输出', async () => {
    const w = await ready('sync-owned-');
    await w.run(['--write']);
    await w.put('.claude/rules/agent-kit/kit-canary-name-55.md', '用户加的\n');
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toContain('SYNC_UNMANAGED_IN_OWNED_DIR');
    expect(r.out).not.toContain('kit-canary-name-55');
    expect(await w.has('.claude/rules/agent-kit/kit-canary-name-55.md')).toBe(true);
  });

  it('损坏的托管块:整次拒绝(SYNC_BLOCK_CORRUPT),不追加', async () => {
    const w = await ready('sync-corrupt-');
    const bad = '<!-- agent-kit:begin id=agent-kit-rules sha256=abc -->\n用户\n';
    await w.put(PI_MD, bad);
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('SYNC_BLOCK_CORRUPT');
    expect(await w.read(PI_MD)).toBe(bad);
    expect(await w.has(SKILL)).toBe(false);
  });

  it('硬链接目标:整次拒绝', async () => {
    const w = await ready('sync-hardlink-');
    await w.put(PI_MD, '用户\n');
    await safe.hardlink(w.io, path.join(w.home, PI_MD), path.join(w.dir, 'pi-hard-copy'));
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toContain('SYNC_PATH_HARDLINK');
    expect(await w.has(SKILL)).toBe(false);
  });
});

describe('sync:payload', () => {
  it('找不到 payload → 退出 4 SYNC_NO_PAYLOAD', async () => {
    const w = await newWorld('sync-nopayload-');
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.NOT_RUN);
    expect(r.err).toBe('SYNC_NOT_RUN reason=SYNC_NO_PAYLOAD\n');
    expect(await w.has('.local')).toBe(false);
  });

  it('payload 被篡改一个文件 → 退出 3 SYNC_PAYLOAD_INVALID,不写', async () => {
    const w = await ready('sync-tamper-');
    await safe.writeFile(
      w.io,
      path.join(w.payloadRoot, `payload/files/claude/home/${RULES}`),
      '被篡改\n',
    );
    const r = await w.run(['--write']);
    expect(r.code).toBe(ExitCode.FAIL_CLOSED);
    expect(r.err).toBe('SYNC_FAIL_CLOSED reason=SYNC_PAYLOAD_INVALID\n');
    expect(await w.has('.claude')).toBe(false);
  });

  it('只有 integrity.json 能发现的篡改:文件与 manifest 的 sha 一并被改 / 文件缺失 / 缺 integrity.json / manifest 被改', async () => {
    const mk = async (label: string): Promise<World> => ready(label);
    // a) 改内容并同步改 manifest 里的 sha:计划器看不出,integrity 对不上
    const a = await mk('sync-tamper-a-');
    const mpath = path.join(a.payloadRoot, 'payload/manifest.json');
    const fpath = path.join(a.payloadRoot, `payload/files/claude/home/${RULES}`);
    const evil = '# 恶意规则\n';
    const oldText = await readText(fpath);
    const manifest = (await readText(mpath)).replace(sha(oldText), sha(evil));
    await safe.writeFile(a.io, fpath, evil);
    await safe.writeFile(a.io, mpath, manifest);
    const ra = await a.run(['--write']);
    expect(ra.err).toBe('SYNC_FAIL_CLOSED reason=SYNC_PAYLOAD_INVALID\n');
    expect(ra.code).toBe(ExitCode.FAIL_CLOSED);
    expect(await a.has('.claude')).toBe(false);
    // b) 文件缺失
    const b = await mk('sync-tamper-b-');
    await safe.remove(b.io, path.join(b.payloadRoot, `payload/files/claude/home/${RULES}`));
    expect((await b.run(['--write'])).err).toBe('SYNC_FAIL_CLOSED reason=SYNC_PAYLOAD_INVALID\n');
    // c) 缺 integrity.json
    const c = await mk('sync-tamper-c-');
    await safe.remove(c.io, path.join(c.payloadRoot, 'integrity.json'));
    expect((await c.run(['--write'])).err).toBe('SYNC_FAIL_CLOSED reason=SYNC_PAYLOAD_INVALID\n');
    // d) manifest 被改(多一个空格):整体哈希对不上
    const d = await mk('sync-tamper-d-');
    const dm = path.join(d.payloadRoot, 'payload/manifest.json');
    await safe.writeFile(d.io, dm, `${await readText(dm)}\n`);
    expect((await d.run(['--write'])).err).toBe('SYNC_FAIL_CLOSED reason=SYNC_PAYLOAD_INVALID\n');
    // 正向对照:同样的夹具未篡改时安装成功
    const ok = await mk('sync-tamper-ok-');
    expect((await ok.run(['--write'])).code).toBe(0);
  });

  it('payload.migrations 非空 → 退出 3 SYNC_MIGRATION_UNSUPPORTED,不写;--uninstall 不受影响', async () => {
    const w = await newWorld('sync-migr-');
    await w.setPayload(stdFixture());
    expect((await w.run(['--write'])).code).toBe(0);
    await w.setPayload(stdFixture('v2'), {
      migrations: [
        {
          kind: 'rename_block',
          path: CODEX_MD,
          from_block_id: 'old-block',
          to_block_id: 'agent-kit-rules',
          since_version: '0.2.0',
        },
      ],
    });
    const before = await treeOf(w.home);
    for (const args of [[], ['--write'], ['--adopt']]) {
      const r = await w.run(args);
      expect(r.code).toBe(ExitCode.FAIL_CLOSED);
      expect(r.err).toBe('SYNC_FAIL_CLOSED reason=SYNC_MIGRATION_UNSUPPORTED\n');
    }
    expect([...(await treeOf(w.home)).files]).toEqual([...before.files]);
    const u = await w.run(['--write', '--uninstall']);
    expect(u.code).toBe(0);
  });
});

describe('sync:输出金丝雀', () => {
  it('夹具里的 kit-canary 文本(payload / 用户文件 / 用户文件名)从不出现在 stdout / stderr', async () => {
    const w = await ready('sync-canary-');
    await userHome(w);
    await w.put('.claude/rules/agent-kit/kit-canary-FILENAME.md', `x ${CANARY_USER}\n`);
    await w.put(SHARED, `外来 ${CANARY_USER}\n`);
    const runs = [
      [],
      ['--json'],
      ['--write'],
      ['--write', '--json'],
      ['--write', '--overwrite-drifted'],
      ['--adopt'],
      ['--uninstall'],
      ['--write', '--uninstall', '--json'],
      ['--resume'],
      ['--agent', 'kimi'],
    ];
    let total = 0;
    for (const a of runs) {
      const r = await w.run(a);
      total += r.out.length + r.err.length;
      expect(`${r.out}${r.err}`, a.join(' ')).not.toContain('kit-canary');
      expect(`${r.out}${r.err}`).not.toContain(w.dir);
    }
    expect(total).toBeGreaterThan(0); // 正向对照:这些命令确实有输出(金丝雀判据不是对空输出成立)
  });
});

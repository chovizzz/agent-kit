import { describe, expect, it } from 'vitest';
import {
  BLOCK,
  P,
  TXN,
  TXN2,
  basePayload,
  blockFile,
  entry,
  brief,
  file,
  h,
  input,
  installed,
  ledgerOf,
  payloadOf,
  plan,
  snap,
} from './plan-helpers.js';

const opOf = (p: ReturnType<typeof plan>, path: string) => p.ops.find((o) => o.path === path);
const entryOf = (p: ReturnType<typeof plan>, path: string) =>
  p.ledger.next?.entries.find((e) => e.path === path);

describe('首装的登记表与操作字段', () => {
  const p = plan(input(basePayload(), null, snap({})));

  it('共享路径只写一次,agents 为请求者并集', () => {
    const shared = p.ops.filter((o) => o.path === P.sharedSkill);
    expect(shared).toHaveLength(1);
    expect(shared[0]?.agents).toEqual(['codex', 'pi']);
    expect(entryOf(p, P.sharedSkill)?.agents).toEqual(['codex', 'pi']);
  });

  it('新建文件 createdFile=true;shaBefore=null;shaAfter=payload sha', () => {
    const o = opOf(p, P.codexMd);
    expect(o).toMatchObject({
      op: 'block_upsert',
      createdFile: true,
      shaBefore: null,
      shaAfter: h('d'),
    });
    expect(entryOf(p, P.codexMd)).toMatchObject({
      kind: 'block',
      block_id: BLOCK,
      created_file: true,
      txn: TXN2,
    });
  });

  it('登记表头取 payload 的 kit_version 与 manifest sha;条目按 (path, block_id) 升序', () => {
    expect(p.ledger.action).toBe('write');
    expect(p.ledger.next).toMatchObject({
      schema_version: 1,
      kit_version: '0.2.0',
      payload_sha256: h('9'),
    });
    const paths = p.ledger.next?.entries.map((e) => e.path) ?? [];
    expect([...paths].sort()).toEqual(paths);
  });

  it('skippedLayers 带出 personal', () => {
    expect(p.skippedLayers).toEqual(['personal']);
  });

  it('宿主文件已存在、只是没有我们的块:createdFile=false', () => {
    const q = plan(input(basePayload(), null, snap({ [P.piMd]: blockFile(null) })));
    expect(opOf(q, P.piMd)).toMatchObject({ op: 'block_upsert', createdFile: false });
    expect(entryOf(q, P.piMd)?.created_file).toBe(false);
  });
});

describe('agent 集合', () => {
  it('默认集合不碰 kimi 的落点,即便 payload 里有', () => {
    const b = payloadOf([
      { agent: 'kimi', path: P.kimiMd, sha: h('d'), block: BLOCK },
      { agent: 'claude', path: P.claudeSkill, sha: h('a') },
    ]);
    expect(brief(plan(input(b, null, snap({}))))).toEqual([`create@${P.claudeSkill}`]);
    expect(brief(plan(input(b, null, snap({}), { agents: ['kimi'] })))).toEqual([
      `block_upsert@${P.kimiMd}#${BLOCK}`,
    ]);
  });

  it('只选 codex:登记在 claude 名下的条目原样保留,不被当成孤儿删除', () => {
    const i = installed();
    const p = plan(input(i, i.ledger, i.disk, { agents: ['codex'] }));
    expect(p.ops).toEqual([]);
    expect(p.empty).toBe(true);
  });

  it('仍被集合之外 agent 请求的条目:只从 agents 里去掉本次 agent,不删文件', () => {
    const i = installed();
    // pi 不再请求共享技能(payload 里 pi 的条目没了),codex 仍请求
    const b = payloadOf([
      { agent: 'claude', path: P.claudeSkill, sha: h('a') },
      { agent: 'claude', path: P.rules, sha: h('c') },
      { agent: 'codex', path: P.sharedSkill, sha: h('b') },
      { agent: 'codex', path: P.codexMd, sha: h('d'), block: BLOCK },
      { agent: 'pi', path: P.piMd, sha: h('e'), block: BLOCK },
    ]);
    const p = plan(input(b, i.ledger, i.disk));
    expect(p.ops).toEqual([]);
    expect(entryOf(p, P.sharedSkill)?.agents).toEqual(['codex']);
    expect(p.ledger.action).toBe('write');
  });

  it('卸载按集合:先卸 codex => 共享技能留给 pi,只更新登记;再卸 pi => 删', () => {
    const i = installed();
    const none = { manifest: null, sha: {} };
    const p1 = plan(input(none, i.ledger, i.disk, { uninstall: true, agents: ['codex'] }));
    expect(brief(p1)).toEqual([`block_remove@${P.codexMd}#${BLOCK}`]);
    expect(entryOf(p1, P.sharedSkill)?.agents).toEqual(['pi']);
    expect(p1.ledger.action).toBe('write');
    const p2 = plan(input(none, i.ledger, i.disk, { uninstall: true, agents: ['codex', 'pi'] }));
    expect(brief(p2)).toContain(`remove@${P.sharedSkill}`);
  });
});

describe('漂移与登记表', () => {
  it('漂移跳过时登记条目原样保留(不丢所有权、不改 sha)', () => {
    const i = installed();
    const p = plan(
      input(
        basePayload({ claudeSkill: h('1') }),
        i.ledger,
        snap({ ...i.disk.entries, [P.claudeSkill]: file(h('f')) }),
      ),
    );
    expect(p.ledger.action).toBe('none');
    expect(p.ops.map((o) => o.op)).toEqual(['skip_drifted']);
  });

  it('覆盖漂移:op 带 overwroteDrifted,shaBefore 是用户版本', () => {
    const i = installed();
    const p = plan(
      input(
        basePayload({ claudeSkill: h('1') }),
        i.ledger,
        snap({ ...i.disk.entries, [P.claudeSkill]: file(h('f')) }),
        { overwriteDrifted: true },
      ),
    );
    expect(opOf(p, P.claudeSkill)).toMatchObject({
      op: 'update',
      overwroteDrifted: true,
      shaBefore: h('f'),
      shaAfter: h('1'),
    });
    expect(entryOf(p, P.claudeSkill)).toMatchObject({ sha256: h('1'), txn: TXN2 });
  });

  it('不带 --overwrite-drifted 时,任何情形都没有 overwroteDrifted', () => {
    const i = installed();
    const p = plan(
      input(
        basePayload({ claudeSkill: h('1') }),
        i.ledger,
        snap({ ...i.disk.entries, [P.claudeSkill]: file(h('f')) }),
      ),
    );
    expect(p.ops.some((o) => o.overwroteDrifted === true)).toBe(false);
  });

  it('更新干净条目沿用 created_file,只刷 sha 与 txn', () => {
    const i = installed();
    const p = plan(input(basePayload({ codexBlock: h('2') }), i.ledger, i.disk));
    expect(entryOf(p, P.codexMd)).toMatchObject({ created_file: true, sha256: h('2'), txn: TXN2 });
    expect(entryOf(p, P.piMd)).toEqual(i.ledger.entries.find((e) => e.path === P.piMd));
  });

  it('登记表头:有跳过项时不刷新;全部干净且 payload 变了时才刷新', () => {
    const i = installed();
    const skipped = plan(
      input(
        basePayload({ claudeSkill: h('1') }),
        i.ledger,
        snap({ ...i.disk.entries, [P.claudeSkill]: file(h('f')) }),
      ),
    );
    expect(skipped.ledger.next?.payload_sha256 ?? i.ledger.payload_sha256).toBe(h('9'));
    const clean = plan(input(i, i.ledger, i.disk, {}, { payloadSha256: h('4') }));
    expect(clean.ops).toEqual([]);
    expect(clean.ledger.action).toBe('write');
    expect(clean.ledger.next?.payload_sha256).toBe(h('4'));
  });
});

describe('卸载', () => {
  const none = { manifest: null, sha: {} };
  it('created_file=true 且删块后空白才连文件删;created_file=false 绝不删文件', () => {
    const i = installed();
    const disk = snap({
      ...i.disk.entries,
      [P.codexMd]: blockFile(h('d'), { restBlank: true }),
      [P.piMd]: blockFile(h('e'), { restBlank: true }),
    });
    const p = plan(input(none, i.ledger, disk, { uninstall: true }));
    expect(opOf(p, P.codexMd)?.deleteFileIfBlank).toBe(true); // created_file: true
    expect(opOf(p, P.piMd)?.deleteFileIfBlank).toBeUndefined(); // created_file: false
  });

  it('created_file=true 但删块后还有用户内容:不删文件', () => {
    const i = installed();
    const p = plan(input(none, i.ledger, i.disk, { uninstall: true }));
    expect(opOf(p, P.codexMd)?.deleteFileIfBlank).toBeUndefined();
  });

  it('全部安全移除 => 删除登记表;有漂移保留 => 登记表保留该条', () => {
    const i = installed();
    const all = plan(input(none, i.ledger, i.disk, { uninstall: true }));
    expect(all.ledger).toEqual({ action: 'delete', next: null });
    const drift = plan(
      input(none, i.ledger, snap({ ...i.disk.entries, [P.rules]: file(h('f')) }), {
        uninstall: true,
      }),
    );
    expect(drift.ledger.action).toBe('write');
    expect(drift.ledger.next?.entries.map((e) => e.path)).toEqual([P.rules]);
  });

  it('卸载只删登记过的:磁盘上的外来文件(不在登记表)一概不碰', () => {
    const i = installed();
    const disk = snap({ ...i.disk.entries, '.claude/skills/other/SKILL.md': file(h('f')) });
    const p = plan(input(none, i.ledger, disk, { uninstall: true }));
    expect(p.ops.some((o) => o.path.includes('other'))).toBe(false);
  });

  it('卸载时链接 / 硬链接同样整次拒绝', () => {
    const i = installed();
    const p = plan(
      input(
        none,
        i.ledger,
        snap({ ...i.disk.entries, [P.rules]: { kind: 'hardlink', sha256: h('c') } }),
        {
          uninstall: true,
        },
      ),
    );
    expect(p.status).toBe('refuse-all');
    expect(p.codes).toEqual(['SYNC_PATH_HARDLINK']);
  });

  it('uninstall 与 adopt 同开是编程错误', () => {
    expect(() =>
      plan(input(basePayload(), null, snap({}), { uninstall: true, adopt: true })),
    ).toThrow(TypeError);
  });
});

describe('adopt', () => {
  it('认领当前 payload 或已知旧版本 sha;其余是外来;不创建任何文件', () => {
    const b = basePayload();
    const known = { [`${P.claudeSkill}\u0000`]: [h('0')] };
    const disk = snap({
      [P.claudeSkill]: file(h('0')),
      [P.rules]: file(h('c')),
      [P.sharedSkill]: file(h('f')),
    });
    const p = plan(input(b, null, disk, { adopt: true }, { knownSha: known }));
    expect(brief(p)).toEqual([
      `refuse_foreign@${P.sharedSkill}`,
      `adopt@${P.rules}`,
      `adopt@${P.claudeSkill}`,
    ]);
    expect(p.ops.some((o) => ['create', 'update', 'block_upsert'].includes(o.op))).toBe(false);
    expect(p.ledger.next?.entries.map((e) => e.path)).toEqual([P.rules, P.claudeSkill]);
    expect(p.ledger.next?.entries.every((e) => e.created_file === false)).toBe(true);
  });

  it('未提供旧版本 sha 时,旧版本内容不被认领', () => {
    const p = plan(
      input(basePayload(), null, snap({ [P.claudeSkill]: file(h('0')) }), { adopt: true }),
    );
    expect(brief(p)).toEqual([`refuse_foreign@${P.claudeSkill}`]);
  });

  it('已在登记表里的条目 adopt 不改动', () => {
    const i = installed();
    const p = plan(input(i, i.ledger, i.disk, { adopt: true }));
    expect(p.empty).toBe(true);
  });

  it('托管块被手改(marker drifted)不认领', () => {
    const p = plan(
      input(basePayload(), null, snap({ [P.codexMd]: blockFile(h('d'), { state: 'drifted' }) }), {
        adopt: true,
      }),
    );
    expect(brief(p)).toEqual([`refuse_foreign@${P.codexMd}#${BLOCK}`]);
  });
});

describe('预检范围与顺序', () => {
  it('没被选中的 agent 的路径上有符号链接:不影响本次', () => {
    const i = installed();
    const p = plan(
      input(i, i.ledger, snap({ ...i.disk.entries, [P.claudeSkill]: { kind: 'symlink' } }), {
        agents: ['codex', 'pi'],
      }),
    );
    expect(p.status).toBe('ok');
  });

  it('多个预检缺陷全部列出,按路径排序', () => {
    const i = installed();
    const p = plan(
      input(
        i,
        i.ledger,
        snap({
          ...i.disk.entries,
          [P.rules]: { kind: 'symlink' },
          [P.codexMd]: blockFile(null, { state: 'corrupt' }),
        }),
      ),
    );
    expect(brief(p)).toEqual([
      `refuse_link@${P.rules}`,
      `refuse_block_corrupt@${P.codexMd}#${BLOCK}`,
    ]);
    expect(p.summary.refuse_all).toBe(2);
  });

  it('corrupt 块优先于其它块的更新:同文件里别的块不会被写', () => {
    const i = installed();
    const p = plan(
      input(
        basePayload({ codexBlock: h('2') }),
        i.ledger,
        snap({ ...i.disk.entries, [P.codexMd]: blockFile(null, { state: 'corrupt' }) }),
      ),
    );
    expect(p.status).toBe('refuse-all');
    expect(p.ops.map((o) => o.op)).toEqual(['refuse_block_corrupt']);
  });

  it('接口是纯的:输入不被修改,两次调用结果深度相等', () => {
    const i = installed();
    const inp = input(basePayload({ claudeSkill: h('1') }), i.ledger, i.disk);
    const before = JSON.stringify(inp);
    const a = plan(inp);
    const b = plan(inp);
    expect(JSON.stringify(inp)).toBe(before);
    expect(a).toEqual(b);
  });
});

describe('独占目录', () => {
  it('claude 不在集合内时不报告;子目录里的多余文件也报;点开头的任何一段都忽略', () => {
    const i = installed();
    const listing = [P.rules, `${P.rulesDir}sub/x.md`, `${P.rulesDir}.hidden/y.md`];
    const withClaude = plan(
      input(i, i.ledger, snap(i.disk.entries, { ownedDirListings: { [P.rulesDir]: listing } })),
    );
    expect(brief(withClaude)).toEqual([`unmanaged_keep@${P.rulesDir}sub/x.md`]);
    const without = plan(
      input(i, i.ledger, snap(i.disk.entries, { ownedDirListings: { [P.rulesDir]: listing } }), {
        agents: ['codex', 'pi'],
      }),
    );
    expect(without.ops).toEqual([]);
  });

  it('没探测目录(无 listing)不报', () => {
    const i = installed();
    expect(plan(input(i, i.ledger, snap(i.disk.entries))).ops).toEqual([]);
  });

  it('本次新建的规则文件不会被当成多余文件', () => {
    const b = basePayload();
    const p = plan(input(b, null, snap({}, { ownedDirListings: { [P.rulesDir]: [P.rules] } })));
    expect(p.ops.some((o) => o.op === 'unmanaged_keep')).toBe(false);
  });
});

describe('登记表之外的所有权(标记只是提示)', () => {
  it('磁盘上有、内容看起来是我们的、但不在登记表 => 不覆盖', () => {
    const p = plan(input(basePayload(), ledgerOf([]), snap({ [P.rules]: file(h('c')) })));
    expect(opOf(p, P.rules)?.op).toBe('refuse_foreign');
    expect(entryOf(p, P.rules)).toBeUndefined();
  });

  it('ledger 条目 txn 字段在未改动条目上保持原值', () => {
    const i = installed();
    const p = plan(input(basePayload({ claudeSkill: h('1') }), i.ledger, i.disk));
    expect(entryOf(p, P.rules)?.txn).toBe(TXN);
  });
});

describe('评审补充(Pi GPT-6.1 Sol)', () => {
  const none = { manifest: null, sha: {} };

  it('adopt 认领旧版本:登记表记磁盘实际 sha;随后普通 sync 把它当干净条目更新', () => {
    const b = basePayload();
    const known = { [`${P.claudeSkill}\u0000`]: [h('0')] };
    const a = plan(
      input(b, null, snap({ [P.claudeSkill]: file(h('0')) }), { adopt: true }, { knownSha: known }),
    );
    expect(entryOf(a, P.claudeSkill)?.sha256).toBe(h('0'));
    const p = plan(input(b, a.ledger.next, snap({ [P.claudeSkill]: file(h('0')) })));
    expect(opOf(p, P.claudeSkill)).toMatchObject({ op: 'update', shaBefore: h('0') });
    expect(p.ops.some((o) => o.op === 'skip_drifted')).toBe(false);
    const u = plan(
      input(none, a.ledger.next, snap({ [P.claudeSkill]: file(h('0')) }), { uninstall: true }),
    );
    expect(brief(u)).toEqual([`remove@${P.claudeSkill}`]);
  });

  it('同一路径同时登记 owned 与 block:卸载 / 同步都整次拒绝', () => {
    const ledger = ledgerOf([
      entry(P.codexMd, h('a'), ['codex']),
      entry(P.codexMd, h('d'), ['codex'], { block: BLOCK }),
    ]);
    for (const o of [{ uninstall: true }, {}]) {
      const p = plan(input(o.uninstall ? none : basePayload(), ledger, snap({}), o));
      expect(p.status).toBe('refuse-all');
      expect(p.codes).toEqual(['SYNC_LEDGER_INVALID']);
    }
  });

  it('卸载不依赖 payload:畸形 manifest / 表外路径 / sha 不符都不阻断', () => {
    const i = installed();
    const bad = {
      ...i.manifest,
      schema_version: 2,
      files: [{ ...i.manifest.files[0], path: '.claude/settings.json' }],
    } as unknown as typeof i.manifest;
    const p = plan(input({ manifest: bad, sha: {} }, i.ledger, i.disk, { uninstall: true }));
    expect(p.status).toBe('ok');
    expect(p.summary.remove + p.summary.block_remove).toBe(5);
  });

  it('无关的共享路径冲突不阻断本次(只选 claude)', () => {
    const b = payloadOf([
      { agent: 'claude', path: P.claudeSkill, sha: h('a') },
      { agent: 'codex', path: P.sharedSkill, sha: h('b') },
      { agent: 'pi', path: P.sharedSkill, sha: h('c') },
    ]);
    const ledger = ledgerOf([entry(P.sharedSkill, h('b'), ['codex', 'pi'])]);
    const p = plan(
      input(b, ledger, snap({ [P.sharedSkill]: file(h('b')) }), { agents: ['claude'] }),
    );
    expect(p.status).toBe('ok');
    expect(brief(p)).toEqual([`create@${P.claudeSkill}`]);
  });

  it('畸形文档给稳定码,不抛异常', () => {
    const b = basePayload();
    for (const bad of [{ files: {} }, { files: [null, 1] }, { skippedLayers: {} }]) {
      const m = { ...b.manifest, ...bad } as unknown as typeof b.manifest;
      const p = plan(input({ manifest: m, sha: b.sha }, null, snap({})));
      expect(p.status).toBe('refuse-all');
      expect(p.codes).toEqual(['SYNC_PAYLOAD_INVALID']);
    }
    const i = installed();
    const l = { ...i.ledger, entries: [null, 'x'] } as unknown as typeof i.ledger;
    const q = plan(input(i, l, i.disk));
    expect(q.codes).toEqual(['SYNC_LEDGER_INVALID']);
  });

  it('empty 的含义:只有提示类操作(skip_drifted)的计划不算 empty', () => {
    const i = installed();
    const p = plan(input(i, i.ledger, snap({ ...i.disk.entries, [P.rules]: file(h('f')) })));
    expect(p.ops.map((o) => o.op)).toEqual(['skip_drifted']);
    expect(p.empty).toBe(false);
  });
});

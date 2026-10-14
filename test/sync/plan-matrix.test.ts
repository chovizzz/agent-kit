import { describe, expect, it } from 'vitest';
import { ALL_CONTRACT_CODES, NON_PLANNER_CODES, PLANNER_CODES } from '../../src/sync/classify.js';
import type { PlanInput } from '../../src/sync/types.js';
import {
  BLOCK,
  P,
  TXN,
  applyPlan,
  basePayload,
  blockFile,
  brief,
  entry,
  file,
  h,
  installed,
  input,
  ledgerOf,
  payloadOf,
  plan,
  snap,
} from './plan-helpers.js';

/**
 * 表驱动夹具矩阵(仿 A21):每个计划器稳定码至少有一个夹具;新增码不补夹具即红。
 * 每个夹具声明期望的 status / exit / 操作清单 / 稳定码;`covers` 之外的断言来自实际输出。
 */
interface Fixture {
  name: string;
  build: () => PlanInput;
  status: 'ok' | 'refuse-all' | 'not-run';
  exit: 0 | 1 | 3 | 4;
  ops: string[];
  codes: string[];
}

const FRESH_OPS = [
  `create@${P.sharedSkill}`,
  `create@${P.rules}`,
  `create@${P.claudeSkill}`,
  `block_upsert@${P.codexMd}#${BLOCK}`,
  `block_upsert@${P.piMd}#${BLOCK}`,
];

const byPath = (a: string, b: string): number =>
  (a.split('@')[1] as string) < (b.split('@')[1] as string) ? -1 : 1;

const fixtures: Fixture[] = [];
const add = (f: Fixture): void => {
  fixtures.push(f);
};

// ---- 基本安装 / 更新 / 幂等 ----
add({
  name: '首装:全新磁盘、无登记表',
  build: () => input(basePayload(), null, snap({})),
  status: 'ok',
  exit: 0,
  ops: FRESH_OPS,
  codes: [],
});
add({
  name: '幂等:磁盘与 payload、登记表全部一致 => 计划为空',
  build: () => {
    const i = installed();
    return input(i, i.ledger, i.disk);
  },
  status: 'ok',
  exit: 0,
  ops: [],
  codes: [],
});
add({
  name: '更新:登记 sha 与磁盘一致、payload 变了 => update / block_upsert',
  build: () => {
    const i = installed();
    const b = basePayload({ claudeSkill: h('1'), codexBlock: h('2') });
    return input(b, i.ledger, i.disk);
  },
  status: 'ok',
  exit: 0,
  ops: [`update@${P.claudeSkill}`, `block_upsert@${P.codexMd}#${BLOCK}`],
  codes: [],
});
add({
  name: '用户删了登记过的文件:重建',
  build: () => {
    const i = installed();
    const entries = { ...i.disk.entries };
    delete entries[P.claudeSkill];
    return input(i, i.ledger, snap(entries));
  },
  status: 'ok',
  exit: 0,
  ops: [`create@${P.claudeSkill}`],
  codes: [],
});

// ---- 漂移 ----
add({
  name: '漂移:磁盘 sha 不等于登记 sha、也不等于 payload => 保留并跳过',
  build: () => {
    const i = installed();
    const b = basePayload({ claudeSkill: h('1') });
    return input(b, i.ledger, snap({ ...i.disk.entries, [P.claudeSkill]: file(h('f')) }));
  },
  status: 'ok',
  exit: 1,
  ops: [`skip_drifted@${P.claudeSkill}`],
  codes: ['SYNC_DRIFTED'],
});
add({
  name: '漂移但 payload 没变:仍然报告(磁盘 sha 不等于登记 sha)',
  build: () => {
    const i = installed();
    return input(i, i.ledger, snap({ ...i.disk.entries, [P.claudeSkill]: file(h('f')) }));
  },
  status: 'ok',
  exit: 1,
  ops: [`skip_drifted@${P.claudeSkill}`],
  codes: ['SYNC_DRIFTED'],
});
add({
  name: '漂移 + --overwrite-drifted => update 且标记 overwroteDrifted',
  build: () => {
    const i = installed();
    const b = basePayload({ claudeSkill: h('1') });
    return input(b, i.ledger, snap({ ...i.disk.entries, [P.claudeSkill]: file(h('f')) }), {
      overwriteDrifted: true,
    });
  },
  status: 'ok',
  exit: 0,
  ops: [`update@${P.claudeSkill}`],
  codes: [],
});
add({
  name: '用户手改后恰好等于新 payload:已收敛,无写操作,只刷登记 sha',
  build: () => {
    const i = installed();
    const b = basePayload({ claudeSkill: h('1') });
    return input(b, i.ledger, snap({ ...i.disk.entries, [P.claudeSkill]: file(h('1')) }));
  },
  status: 'ok',
  exit: 0,
  ops: [],
  codes: [],
});
add({
  name: '托管块被手改(marker drifted) => 跳过',
  build: () => {
    const i = installed();
    return input(
      i,
      i.ledger,
      snap({ ...i.disk.entries, [P.codexMd]: blockFile(h('f'), { state: 'drifted' }) }),
    );
  },
  status: 'ok',
  exit: 1,
  ops: [`skip_drifted@${P.codexMd}#${BLOCK}`],
  codes: ['SYNC_DRIFTED'],
});

// ---- 外来 ----
add({
  name: '外来:目标文件存在但不在登记表 => refuse_foreign,其余照常',
  build: () => input(basePayload(), null, snap({ [P.claudeSkill]: file(h('f')) })),
  status: 'ok',
  exit: 1,
  ops: [
    `create@${P.sharedSkill}`,
    `create@${P.rules}`,
    `refuse_foreign@${P.claudeSkill}`,
    `block_upsert@${P.codexMd}#${BLOCK}`,
    `block_upsert@${P.piMd}#${BLOCK}`,
  ].sort(byPath),
  codes: ['SYNC_TARGET_FOREIGN'],
});
add({
  name: '外来:内容恰好等于 payload 但不在登记表,不 adopt 也拒绝',
  build: () => input(basePayload(), null, snap({ [P.sharedSkill]: file(h('b')) })),
  status: 'ok',
  exit: 1,
  ops: [
    `refuse_foreign@${P.sharedSkill}`,
    `create@${P.rules}`,
    `create@${P.claudeSkill}`,
    `block_upsert@${P.codexMd}#${BLOCK}`,
    `block_upsert@${P.piMd}#${BLOCK}`,
  ].sort(byPath),
  codes: ['SYNC_TARGET_FOREIGN'],
});
add({
  name: 'skills-hub 同名条目:条目目录被占 => refuse_foreign',
  build: () =>
    input(basePayload(), null, snap({ [P.sharedSkill]: { kind: 'missing', entryOccupied: true } })),
  status: 'ok',
  exit: 1,
  ops: [
    `refuse_foreign@${P.sharedSkill}`,
    `create@${P.rules}`,
    `create@${P.claudeSkill}`,
    `block_upsert@${P.codexMd}#${BLOCK}`,
    `block_upsert@${P.piMd}#${BLOCK}`,
  ].sort(byPath),
  codes: ['SYNC_TARGET_FOREIGN'],
});
add({
  name: '托管块宿主文件存在、块在、但不在登记表 => 外来',
  build: () => input(basePayload(), null, snap({ [P.codexMd]: blockFile(h('d')) })),
  status: 'ok',
  exit: 1,
  ops: [
    ...FRESH_OPS.filter((o) => !o.includes(P.codexMd)),
    `refuse_foreign@${P.codexMd}#${BLOCK}`,
  ].sort(byPath),
  codes: ['SYNC_TARGET_FOREIGN'],
});
add({
  name: '托管块宿主文件存在、没有我们的块、无登记 => 追加(createdFile=false),不算外来',
  build: () => input(basePayload(), null, snap({ [P.codexMd]: blockFile(null) })),
  status: 'ok',
  exit: 0,
  ops: FRESH_OPS,
  codes: [],
});

// ---- adopt ----
add({
  name: 'adopt:内容 sha 等于 payload => 认领;不等 => 外来;缺失 => 什么都不做',
  build: () =>
    input(
      basePayload(),
      null,
      snap({ [P.sharedSkill]: file(h('b')), [P.claudeSkill]: file(h('f')) }),
      { adopt: true },
    ),
  status: 'ok',
  exit: 1,
  ops: [`adopt@${P.sharedSkill}`, `refuse_foreign@${P.claudeSkill}`],
  codes: ['SYNC_TARGET_FOREIGN'],
});

// ---- 共享路径 ----
add({
  name: '共享路径:codex+pi 同 sha 的 .agents/skills 只写一次',
  build: () => input(basePayload(), null, snap({})),
  status: 'ok',
  exit: 0,
  ops: FRESH_OPS,
  codes: [],
});
add({
  name: '共享路径冲突:codex 与 pi 渲染到同一路径但 sha 不同 => 整次拒绝',
  build: () => {
    const b = payloadOf([
      { agent: 'codex', path: P.sharedSkill, sha: h('b') },
      { agent: 'pi', path: P.sharedSkill, sha: h('c') },
      { agent: 'claude', path: P.claudeSkill, sha: h('a') },
    ]);
    return input(b, null, snap({}));
  },
  status: 'refuse-all',
  exit: 3,
  ops: [`refuse_shared_conflict@${P.sharedSkill}`],
  codes: ['SYNC_SHARED_PATH_CONFLICT'],
});
add({
  name: '共享路径冲突:同一路径 owned 与 managed-block 混用',
  build: () => {
    const b = payloadOf([
      { agent: 'codex', path: P.codexMd, sha: h('b') },
      { agent: 'pi', path: P.codexMd, sha: h('b'), block: BLOCK },
    ]);
    return input(b, null, snap({}));
  },
  status: 'refuse-all',
  exit: 3,
  ops: [`refuse_shared_conflict@${P.codexMd}`],
  codes: ['SYNC_SHARED_PATH_CONFLICT'],
});
add({
  name: '共享路径冲突:本次集合之外、仍登记请求该路径的 agent 渲染不同 sha',
  build: () => {
    const b = payloadOf([
      { agent: 'codex', path: P.sharedSkill, sha: h('b') },
      { agent: 'kimi', path: P.sharedSkill, sha: h('c') },
    ]);
    const ledger = ledgerOf([entry(P.sharedSkill, h('c'), ['kimi'])]);
    return input(b, ledger, snap({ [P.sharedSkill]: file(h('c')) }), { agents: ['codex'] });
  },
  status: 'refuse-all',
  exit: 3,
  ops: [`refuse_shared_conflict@${P.sharedSkill}`],
  codes: ['SYNC_SHARED_PATH_CONFLICT'],
});
add({
  name: '集合之外的 agent 不参与冲突判定(kimi 没被选中)',
  build: () => {
    const b = payloadOf([
      { agent: 'codex', path: P.sharedSkill, sha: h('b') },
      { agent: 'kimi', path: P.sharedSkill, sha: h('c') },
    ]);
    return input(b, null, snap({}), { agents: ['codex'] });
  },
  status: 'ok',
  exit: 0,
  ops: [`create@${P.sharedSkill}`],
  codes: [],
});
add({
  name: '--agent 显式含 kimi 才启用它的落点',
  build: () => {
    const b = payloadOf([
      { agent: 'kimi', path: P.kimiMd, sha: h('d'), block: BLOCK },
      { agent: 'kimi', path: P.sharedSkill, sha: h('b') },
      { agent: 'codex', path: P.sharedSkill, sha: h('b') },
    ]);
    return input(b, null, snap({}), { agents: ['claude', 'codex', 'pi', 'kimi'] });
  },
  status: 'ok',
  exit: 0,
  ops: [`create@${P.sharedSkill}`, `block_upsert@${P.kimiMd}#${BLOCK}`],
  codes: [],
});

// ---- 预检(整次拒绝) ----
const withDefect = (path: string, defect: Parameters<typeof snap>[0][string]) => () => {
  const i = installed({ claudeSkill: h('1'), codexBlock: h('2') });
  const fresh = basePayload({ claudeSkill: h('1'), codexBlock: h('2') });
  // 同时存在会产生写操作的变更(claudeSkill/codexBlock)与一个预检缺陷
  return input(fresh, installed().ledger, snap({ ...installed().disk.entries, [path]: defect }));
  void i;
};
add({
  name: '预检:中间段符号链接 => refuse-all,同批的更新一个都不写',
  build: withDefect(P.sharedSkill, { ...file(h('b')), linkedSegment: true }),
  status: 'refuse-all',
  exit: 3,
  ops: [`refuse_link@${P.sharedSkill}`],
  codes: ['SYNC_PATH_SYMLINK'],
});
add({
  name: '预检:目标本身是符号链接',
  build: withDefect(P.rules, { kind: 'symlink' }),
  status: 'refuse-all',
  exit: 3,
  ops: [`refuse_link@${P.rules}`],
  codes: ['SYNC_PATH_SYMLINK'],
});
add({
  name: '预检:硬链接',
  build: withDefect(P.rules, { kind: 'hardlink', sha256: h('c') }),
  status: 'refuse-all',
  exit: 3,
  ops: [`refuse_link@${P.rules}`],
  codes: ['SYNC_PATH_HARDLINK'],
});
add({
  name: '预检:目标是目录 / 其它非常规文件',
  build: withDefect(P.rules, { kind: 'dir' }),
  status: 'refuse-all',
  exit: 3,
  ops: [`refuse_not_regular@${P.rules}`],
  codes: ['SYNC_PATH_NOT_REGULAR'],
});
add({
  name: '预检:托管块 corrupt',
  build: withDefect(P.piMd, blockFile(null, { state: 'corrupt' })),
  status: 'refuse-all',
  exit: 3,
  ops: [`refuse_block_corrupt@${P.piMd}#${BLOCK}`],
  codes: ['SYNC_BLOCK_CORRUPT'],
});
add({
  name: '预检优先于漂移与外来:同批的 skip_drifted / refuse_foreign 不出现',
  build: () => {
    const i = installed();
    const b = basePayload({ claudeSkill: h('1') });
    return input(
      b,
      i.ledger,
      snap({
        ...i.disk.entries,
        [P.claudeSkill]: file(h('f')),
        [P.rules]: { kind: 'symlink' },
      }),
    );
  },
  status: 'refuse-all',
  exit: 3,
  ops: [`refuse_link@${P.rules}`],
  codes: ['SYNC_PATH_SYMLINK'],
});
add({
  name: '预检:残留事务',
  build: () => {
    const i = installed();
    return input(i, i.ledger, snap(i.disk.entries, { residualTxn: TXN }));
  },
  status: 'refuse-all',
  exit: 3,
  ops: ['refuse_residual_txn@.local/state/agent-kit/sync/txn/'],
  codes: ['SYNC_TXN_INCOMPLETE'],
});
add({
  name: '预检:payload 里有点开头条目 => 写出口拒绝',
  build: () => {
    const b = payloadOf([
      { agent: 'claude', path: '.claude/skills/.hidden/SKILL.md', sha: h('a') },
    ]);
    return input(b, null, snap({}));
  },
  status: 'refuse-all',
  exit: 3,
  ops: ['refuse_denied@.claude/skills/.hidden/SKILL.md'],
  codes: ['SYNC_WRITE_DENIED'],
});
add({
  name: '预检:payload 里有 .json 文件 / 表外路径 => 写出口拒绝',
  build: () => {
    const b = payloadOf([
      { agent: 'claude', path: '.claude/skills/x/settings.json', sha: h('a') },
      { agent: 'claude', path: '.claude/settings.json', sha: h('a') },
    ]);
    return input(b, null, snap({}));
  },
  status: 'refuse-all',
  exit: 3,
  ops: ['refuse_denied@.claude/settings.json', 'refuse_denied@.claude/skills/x/settings.json'],
  codes: ['SYNC_WRITE_DENIED'],
});
add({
  name: '预检:登记表里有表外路径(如 ~/.claude/CLAUDE.md)=> 写出口拒绝,绝不删它',
  build: () => {
    const ledger = ledgerOf([entry('.claude/CLAUDE.md', h('a'), ['claude'])]);
    return input(payloadOf([]), ledger, snap({ '.claude/CLAUDE.md': file(h('a')) }), {
      uninstall: true,
    });
  },
  status: 'refuse-all',
  exit: 3,
  ops: ['refuse_denied@.claude/CLAUDE.md'],
  codes: ['SYNC_WRITE_DENIED'],
});
add({
  name: '预检:登记表非法(未排序)',
  build: () => {
    const i = installed();
    const bad = { ...i.ledger, entries: [...i.ledger.entries].reverse() };
    return input(i, bad, i.disk);
  },
  status: 'refuse-all',
  exit: 3,
  ops: ['refuse_invalid@.local/state/agent-kit/sync/ledger.json'],
  codes: ['SYNC_LEDGER_INVALID'],
});
add({
  name: '预检:登记表把 owned 文件登记在托管块宿主路径上',
  build: () => {
    const i = installed();
    const ledger = ledgerOf([
      ...i.ledger.entries.filter((e) => e.path !== P.codexMd),
      entry(P.codexMd, h('d'), ['codex']),
    ]);
    return input(i, ledger, i.disk);
  },
  status: 'refuse-all',
  exit: 3,
  ops: [`refuse_invalid@${P.codexMd}`],
  codes: ['SYNC_LEDGER_INVALID'],
});
add({
  name: '预检:payload 实际内容 sha 与 manifest 声明不符',
  build: () => {
    const b = basePayload();
    const sha = { ...b.sha, [`files/claude/home/${P.claudeSkill}`]: h('0') };
    return input({ manifest: b.manifest, sha }, null, snap({}));
  },
  status: 'refuse-all',
  exit: 3,
  ops: [`refuse_invalid@${P.claudeSkill}`],
  codes: ['SYNC_PAYLOAD_INVALID'],
});
add({
  name: '预检:payload manifest 不合 schema',
  build: () => {
    const b = basePayload();
    const bad = { ...b.manifest, schema_version: 2 } as unknown as typeof b.manifest;
    return input({ manifest: bad, sha: b.sha }, null, snap({}));
  },
  status: 'refuse-all',
  exit: 3,
  ops: ['refuse_invalid@.local/share/agent-kit/payload/manifest.json'],
  codes: ['SYNC_PAYLOAD_INVALID'],
});
add({
  name: '没有 payload:sync 退出 4',
  build: () => input({ manifest: null, sha: {} }, null, snap({})),
  status: 'not-run',
  exit: 4,
  ops: ['refuse_invalid@.local/share/agent-kit/payload/manifest.json'],
  codes: ['SYNC_NO_PAYLOAD'],
});

// ---- 删除 / 孤儿 ----
const orphanBase = () => {
  const i = installed();
  const b = payloadOf([
    { agent: 'claude', path: P.rules, sha: h('c') },
    { agent: 'codex', path: P.sharedSkill, sha: h('b') },
    { agent: 'pi', path: P.sharedSkill, sha: h('b') },
    { agent: 'codex', path: P.codexMd, sha: h('d'), block: BLOCK },
    { agent: 'pi', path: P.piMd, sha: h('e'), block: BLOCK },
  ]); // claudeSkill 从 payload 里消失
  return { i, b };
};
add({
  name: 'payload 里没了的条目:sha 一致才删',
  build: () => {
    const { i, b } = orphanBase();
    return input(b, i.ledger, i.disk);
  },
  status: 'ok',
  exit: 0,
  ops: [`remove@${P.claudeSkill}`],
  codes: [],
});
add({
  name: 'payload 里没了的条目:sha 不一致 => 孤儿保留',
  build: () => {
    const { i, b } = orphanBase();
    return input(b, i.ledger, snap({ ...i.disk.entries, [P.claudeSkill]: file(h('f')) }));
  },
  status: 'ok',
  exit: 1,
  ops: [`orphan_keep@${P.claudeSkill}`],
  codes: ['SYNC_DRIFTED'],
});
add({
  name: 'payload 里没了的条目:磁盘上也没了 => 只丢登记',
  build: () => {
    const { i, b } = orphanBase();
    const entries = { ...i.disk.entries };
    delete entries[P.claudeSkill];
    return input(b, i.ledger, snap(entries));
  },
  status: 'ok',
  exit: 0,
  ops: [],
  codes: [],
});

// ---- 卸载 ----
add({
  name: '卸载:删登记过且未漂移的,托管块 created_file 且删块后空白 => 连文件删',
  build: () => {
    const i = installed();
    const entries = { ...i.disk.entries, [P.codexMd]: blockFile(h('d'), { restBlank: true }) };
    return input({ manifest: null, sha: {} }, i.ledger, snap(entries), { uninstall: true });
  },
  status: 'ok',
  exit: 0,
  ops: [
    `remove@${P.sharedSkill}`,
    `remove@${P.rules}`,
    `remove@${P.claudeSkill}`,
    `block_remove@${P.codexMd}#${BLOCK}`,
    `block_remove@${P.piMd}#${BLOCK}`,
  ],
  codes: [],
});
add({
  name: '卸载:漂移的条目保留(skip_drifted),登记表不删',
  build: () => {
    const i = installed();
    return input(
      { manifest: null, sha: {} },
      i.ledger,
      snap({ ...i.disk.entries, [P.rules]: file(h('f')) }),
      { uninstall: true },
    );
  },
  status: 'ok',
  exit: 1,
  ops: [
    `remove@${P.sharedSkill}`,
    `skip_drifted@${P.rules}`,
    `remove@${P.claudeSkill}`,
    `block_remove@${P.codexMd}#${BLOCK}`,
    `block_remove@${P.piMd}#${BLOCK}`,
  ],
  codes: ['SYNC_DRIFTED'],
});
add({
  name: '卸载:没有登记表 => 空计划',
  build: () => input({ manifest: null, sha: {} }, null, snap({}), { uninstall: true }),
  status: 'ok',
  exit: 0,
  ops: [],
  codes: [],
});

// ---- 独占目录 ----
add({
  name: '独占目录里多出的文件 => SYNC_UNMANAGED_IN_OWNED_DIR 并保留(点开头忽略)',
  build: () => {
    const i = installed();
    return input(
      i,
      i.ledger,
      snap(i.disk.entries, {
        ownedDirListings: {
          [P.rulesDir]: [P.rules, `${P.rulesDir}mine.md`, `${P.rulesDir}.DS_Store`],
        },
      }),
    );
  },
  status: 'ok',
  exit: 1,
  ops: [`unmanaged_keep@${P.rulesDir}mine.md`],
  codes: ['SYNC_UNMANAGED_IN_OWNED_DIR'],
});

describe('夹具矩阵', () => {
  for (const f of fixtures) {
    it(f.name, () => {
      const p = plan(f.build());
      expect(p.status).toBe(f.status);
      expect(p.exit).toBe(f.exit);
      expect(brief(p)).toEqual(f.ops);
      expect([...p.codes]).toEqual([...f.codes].sort());
      if (p.status !== 'ok') {
        // refuse-all / not-run:绝无写操作、登记表不动
        expect(
          p.ops.some((o) =>
            ['create', 'update', 'remove', 'block_upsert', 'block_remove'].includes(o.op),
          ),
        ).toBe(false);
        expect(p.ledger.action).toBe('none');
      }
    });
  }

  it('稳定码清单 == 夹具覆盖清单(新增码不补夹具即红)', () => {
    const covered = new Set<string>(fixtures.flatMap((f) => f.codes));
    expect([...covered].sort()).toEqual([...PLANNER_CODES].sort());
    // 计划器码 + 非计划器码 == 契约里全部 SYNC_ 码,且两者不相交
    expect([...PLANNER_CODES, ...NON_PLANNER_CODES].sort()).toEqual([...ALL_CONTRACT_CODES].sort());
    expect(PLANNER_CODES.filter((c) => NON_PLANNER_CODES.includes(c))).toEqual([]);
  });

  it('夹具名唯一', () => {
    expect(new Set(fixtures.map((f) => f.name)).size).toBe(fixtures.length);
  });

  it('幂等:凡是 ok 的夹具,应用其计划后再规划必须为空(跳过项除外)', () => {
    let checked = 0;
    for (const f of fixtures) {
      const inp = f.build();
      const p1 = plan(inp);
      if (p1.status !== 'ok' || inp.options.adopt) continue;
      const { disk, ledger } = applyPlan(inp.disk, p1, inp.ledger);
      const p2 = plan({ ...inp, disk, ledger });
      const writes = p2.ops.filter((o) =>
        ['create', 'update', 'remove', 'block_upsert', 'block_remove'].includes(o.op),
      );
      expect(writes, f.name).toEqual([]);
      if (p1.exit === 0) {
        expect(p2.empty, f.name).toBe(true);
        expect(p2.exit, f.name).toBe(0);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(15);
  });
});

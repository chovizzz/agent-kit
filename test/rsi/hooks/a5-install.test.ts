/**
 * A5(contracts §20.15):`rsi hooks --install / --uninstall` 的安装语义矩阵。
 * 全部在假 HOME(KIT_TMP 下)里跑;写路径用「测试形状表」(证据抬到公开文档),生产形状表的拒绝见 a5-zero-write.test.ts。
 */
import { describe, expect, it } from 'vitest';
import {
  PI_EXTENSION_SOURCE_PLAIN,
  PRODUCTION_SHAPES,
  type HookShape,
  type ShapeTable,
} from '../../../src/contracts/rsi-hooks.js';
import { lstat } from '../../../src/io/read-fs.js';
import {
  AGENTS,
  SENTINEL,
  STATE_REL,
  TEST_SHAPES,
  USER_WRAPPER,
  canon,
  jsonOf,
  makeHx,
  sha,
  userSettings,
  type Hx,
  type R,
} from './a5-fixture.js';

const SS = {
  matcher: 'startup',
  hooks: [
    {
      type: 'command',
      command: 'agent-kit rsi hint --agent claude --format claude-json',
      timeout: 5,
    },
  ],
};
const SS_CANARY = {
  matcher: 'startup',
  hooks: [
    {
      type: 'command',
      command: 'agent-kit rsi hint --agent claude --format claude-json --canary',
      timeout: 5,
    },
  ],
};
const SE = {
  hooks: [{ type: 'command', command: 'agent-kit rsi poke --agent claude', timeout: 5 }],
};

const FRESH_DOC = { hooks: { SessionEnd: [SE], SessionStart: [SS] } };

const lastLine = (t: string): string => t.trimEnd().split('\n').pop() as string;
const modeOf = async (hx: Hx, rel: string): Promise<number> =>
  (await lstat(hx.abs(rel))).mode & 0o777;

async function claudeHx(prefix: string): Promise<Hx> {
  const hx = await makeHx(prefix);
  await hx.agentRoot('claude');
  return hx;
}

/** 在假 HOME 里找内容含 needle 的文件(相对路径,排序) */
async function filesContaining(hx: Hx, needle: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const n of await hx.names(rel === '' ? '.' : rel)) {
    const r = rel === '' ? n : `${rel}/${n}`;
    const st = await lstat(hx.abs(r));
    if (st.isDirectory()) out.push(...(await filesContaining(hx, needle, r)));
    else if (st.isFile() && (await hx.read(r)).includes(needle)) out.push(r);
  }
  return out.sort();
}

function happyTrace(id: string): string[] {
  return [
    'mkdir:state',
    'chmod:state',
    'fsync-dir:state',
    'fsync-dir:.local/state/agent-kit',
    'mkdir:state/txn',
    'chmod:state/txn',
    'fsync-dir:state/txn',
    'fsync-dir:state',
    `create-tmp:state/txn/${id}.json.tmp`,
    `write-tmp:state/txn/${id}.json.tmp`,
    `fsync-file:state/txn/${id}.json.tmp`,
    `rename:state/txn/${id}.json`,
    'fsync-dir:state/txn',
    'create-tmp:target/claude.tmp',
    'write-tmp:target/claude.tmp',
    'fsync-file:target/claude.tmp',
    'rename:target/claude',
    'fsync-dir:target/claude:dir',
    'create-excl:state/ledger.established',
    'fsync-file:state/ledger.established',
    'fsync-dir:state',
    'create-tmp:state/ledger.json.tmp',
    'write-tmp:state/ledger.json.tmp',
    'fsync-file:state/ledger.json.tmp',
    'rename:state/ledger.json',
    'fsync-dir:state',
    'fsync-file:state/ledger.json',
    'fsync-dir:state',
    `unlink:state/txn/${id}.json`,
    'fsync-dir:state/txn',
  ];
}

describe('安装:happy path(文件不存在 → 新建)', () => {
  it('提交整个事务:目标内容、权限、账本、标记、journal 已删;JSON 键集固定;fsync / rename 顺序逐项相等', async () => {
    const hx = await claudeHx('a5-inst-happy-');
    const r = await hx.write(['--install', '--agent', 'claude', '--json']);
    expect(r.code, r.err).toBe(0);
    const j = jsonOf(r);
    expect(Object.keys(j).sort()).toEqual(
      [
        'agent',
        'maintenance',
        'maintenance_kind',
        'mode',
        'plan',
        'result',
        'shape_version',
        'txn_id',
        'verified',
        'write_level',
      ].sort(),
    );
    expect(j).toMatchObject({
      mode: 'install',
      agent: 'claude',
      shape_version: 'claude-1',
      verified: true,
      result: 'committed',
      write_level: 'committed',
      maintenance: 'none',
      maintenance_kind: null,
    });
    const id = j['txn_id'] as string;
    expect(id).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{16}$/);
    const plan = j['plan'] as {
      kind: string;
      before_exists: boolean;
      ops: { op: string; event: string }[];
    };
    expect(plan.kind).toBe('install');
    expect(plan.before_exists).toBe(false);
    expect(plan.ops.map((o) => `${o.op}:${o.event}`)).toEqual([
      'add:SessionEnd',
      'add:SessionStart',
    ]);

    const text = await hx.read('.claude/settings.json');
    expect(JSON.parse(text)).toEqual(FRESH_DOC);
    expect(text).toBe(canon(JSON.parse(text)));
    expect(await modeOf(hx, '.claude/settings.json')).toBe(0o600);

    const ledger = (await hx.ledger()) as {
      generation: number;
      entries: { agent: string; variant: string; txn_id: string }[];
      applied_txns: { op: string; status: string; backup: string }[];
    };
    expect(ledger.generation).toBe(1);
    expect(ledger.entries).toHaveLength(2);
    expect(
      ledger.entries.every((e) => e.agent === 'claude' && e.variant === 'plain' && e.txn_id === id),
    ).toBe(true);
    expect(ledger.applied_txns).toMatchObject([
      { op: 'install', status: 'applied', backup: 'none' },
    ]);
    expect(await hx.has(`${STATE_REL}/ledger.established`)).toBe(true);
    expect(await hx.journals()).toEqual([]);
    expect(await hx.backups()).toEqual([]);
    expect(await hx.names('.claude')).toEqual(['settings.json']);
    // 私有状态区权限:目录 0700、文件 0600
    expect(await modeOf(hx, STATE_REL)).toBe(0o700);
    expect(await modeOf(hx, `${STATE_REL}/txn`)).toBe(0o700);
    expect(await modeOf(hx, `${STATE_REL}/ledger.json`)).toBe(0o600);
    expect(await modeOf(hx, `${STATE_REL}/ledger.established`)).toBe(0o600);
    // 顺序证据(可注入计数桩;真实掉电不在验收范围)
    expect(r.trace).toEqual(happyTrace(id));
    hx.assertAuditInside();
    // 审计里的 hooks.* 写尝试条数 = trace 里非 fsync 的步骤数
    expect(r.audit.filter((c) => c.op.startsWith('hooks.')).length).toBe(
      r.trace.filter((e) => !e.startsWith('fsync-')).length,
    );
  });

  it('幂等:再装一次 = unchanged,零写调用(连锁文件都不碰),账本不变', async () => {
    const hx = await claudeHx('a5-inst-idem-');
    await hx.write(['--install', '--agent', 'claude']);
    const before = await hx.tree();
    const ledger = await hx.ledger();
    const r = await hx.write(['--install', '--agent', 'claude', '--json']);
    expect(r.code).toBe(0);
    expect(jsonOf(r)).toMatchObject({
      result: 'unchanged',
      write_level: 'zero_write',
      txn_id: null,
    });
    expect(r.audit).toEqual([]);
    expect(r.trace).toEqual([]);
    expect(await hx.tree()).toEqual(before);
    expect(await hx.ledger()).toEqual(ledger);
  });

  it('干跑:零写调用、树不变;非 TTY 的 --write → 2 not_tty;EOF / 非 yes → 1 DECLINED 且零写入', async () => {
    const hx = await claudeHx('a5-inst-dry-');
    const t0 = await hx.tree();
    const dry = await hx.run(['--install', '--agent', 'claude']);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('would add event=SessionEnd');
    expect(dry.out).toContain('would add event=SessionStart');
    expect(dry.audit).toEqual([]);
    expect(await hx.tree()).toEqual(t0);

    const noTty = await hx.run(['--install', '--agent', 'claude', '--write'], { tty: false });
    expect(noTty.code).toBe(2);
    expect(noTty.err).toBe('RSI_USAGE reason=not_tty\n');
    expect(noTty.audit).toEqual([]);

    for (const line of [undefined, 'y', 'YES', 'yes ', 'no', '']) {
      const r = await hx.run(['--install', '--agent', 'claude', '--write', '--json'], {
        tty: true,
        line,
      });
      expect(r.code, String(line)).toBe(1);
      expect(lastLine(r.err)).toBe('RSI_HOOKS_DECLINED');
      expect(jsonOf(r)).toMatchObject({ result: 'declined', write_level: 'zero_write' });
      expect(r.audit).toEqual([]);
      expect(await hx.tree()).toEqual(t0);
    }
  });

  it('参数:六模式互斥、缺 --agent、坏 agent、--print 不接受 --write、未知参数、重复参数', async () => {
    const hx = await claudeHx('a5-inst-args-');
    const cases: [string[], string][] = [
      [[], 'mode_conflict'],
      [['--install', '--uninstall', '--agent', 'claude'], 'mode_conflict'],
      [['--print', '--install', '--agent', 'claude'], 'mode_conflict'],
      [['--install'], 'missing:--agent'],
      [['--install', '--agent'], 'missing:--agent'],
      [['--install', '--agent', 'kimi'], 'bad_agent'],
      [['--print', '--agent', 'claude', '--write'], 'unknown_arg'],
      [['--install', '--agent', 'claude', '--bogus'], 'unknown_arg'],
      [['--install', '--agent', 'claude', '--agent', 'codex'], 'unknown_arg'],
      [['--install', '--install', '--agent', 'claude'], 'unknown_arg'],
      [['--install', '--agent=claude'], 'unknown_arg'],
      [['--prune-backups', '--agent', 'claude'], 'unknown_arg'],
      [['--restore', '--agent', 'claude'], 'unknown_arg'],
      [['--restore', 'not-an-id', '--agent', 'claude'], 'unknown_arg'],
      [['--discard-residue', '--agent', 'claude'], 'unknown_arg'],
    ];
    for (const [argv, reason] of cases) {
      const r = await hx.run(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err, argv.join(' ')).toBe(`RSI_USAGE reason=${reason}\n`);
      expect(r.out).toBe('');
      expect(r.audit).toEqual([]);
    }
  });
});

describe('安装:已有用户配置(合并、保真、备份、权限)', () => {
  it('非 kit 节点的字节片段在新文件里与原文件逐字相同;权限沿用原文件;备份只在私有备份文件里含秘密哨兵', async () => {
    const hx = await claudeHx('a5-inst-user-');
    const original = userSettings();
    await hx.put('.claude/settings.json', original, 0o644);
    const r = await hx.write(['--install', '--agent', 'claude', '--json']);
    expect(r.code, r.err).toBe(0);
    const id = jsonOf(r)['txn_id'] as string;
    const after = await hx.read('.claude/settings.json');
    const doc = JSON.parse(after) as Record<string, unknown>;
    expect(doc['model']).toBe('opus');
    expect((doc['hooks'] as Record<string, unknown>)['PreToolUse']).toEqual([USER_WRAPPER]);
    expect((doc['hooks'] as Record<string, unknown[]>)['SessionStart']).toEqual([SS]);
    expect(after).toBe(canon(doc));
    // 逐字片段(缩进由 JSON.stringify 的 2 空格规则决定)
    const indent = (v: unknown, n: number): string =>
      JSON.stringify(v, null, 2)
        .split('\n')
        .map((l, i) => (i === 0 ? l : ' '.repeat(n) + l))
        .join('\n');
    for (const frag of [
      `  "model": "opus"`,
      `  "env": ${indent({ SOME_USER_SETTING: SENTINEL }, 2)}`,
      `      ${indent(USER_WRAPPER, 6)}`,
      `  "permissions": ${indent({ allow: ['Bash(ls:*)'] }, 2)}`,
    ]) {
      expect(original, frag).toContain(frag);
      expect(after, frag).toContain(frag);
    }
    expect(await modeOf(hx, '.claude/settings.json')).toBe(0o644);
    // 备份 = 整份原文件,权限 0600,目录 0700
    expect(await hx.backups()).toEqual([id]);
    expect(await hx.read(`${STATE_REL}/backups/${id}/claude`)).toBe(original);
    expect(await modeOf(hx, `${STATE_REL}/backups/${id}`)).toBe(0o700);
    expect(await modeOf(hx, `${STATE_REL}/backups/${id}/claude`)).toBe(0o600);
    // 隐私:哨兵只出现在目标与私有备份里(不在 stdout / stderr / 账本 / journal / 审计路径)
    expect(await filesContaining(hx, SENTINEL)).toEqual(
      ['.claude/settings.json', `${STATE_REL}/backups/${id}/claude`].sort(),
    );
    expect(r.out + r.err).not.toContain(SENTINEL);
    for (const c of hx.allAudit) expect(c.path + c.op).not.toContain(SENTINEL);
    // 顺序:journal → 备份 → 目标 → 账本 → 删 journal;权限在 rename 之前设置并再 fsync
    const at = (p: string): number => r.trace.findIndex((e) => e.startsWith(p));
    expect(at('rename:state/txn/')).toBeLessThan(at('rename:state/backups/'));
    expect(at('rename:state/backups/')).toBeLessThan(at('rename:target/claude'));
    expect(at('rename:target/claude')).toBeLessThan(at('rename:state/ledger.json'));
    expect(at('rename:state/ledger.json')).toBeLessThan(at('unlink:state/txn/'));
    const chmodAt = r.trace.indexOf('chmod:target/claude.tmp');
    expect(chmodAt).toBeGreaterThan(r.trace.indexOf('fsync-file:target/claude.tmp'));
    expect(r.trace[chmodAt + 1]).toBe('fsync-file:target/claude.tmp');
    expect(chmodAt).toBeLessThan(at('rename:target/claude'));
    expect(r.trace[at('rename:state/txn/') + 1]).toBe('fsync-dir:state/txn');
    hx.assertAuditInside();
  });

  it('无末尾换行的规范文件:安装后仍无末尾换行', async () => {
    const hx = await claudeHx('a5-inst-nonl-');
    await hx.put('.claude/settings.json', canon({ model: 'opus' }, false));
    const r = await hx.write(['--install', '--agent', 'claude']);
    expect(r.code, r.err).toBe(0);
    const after = await hx.read('.claude/settings.json');
    expect(after.endsWith('\n')).toBe(false);
    expect(JSON.parse(after)).toEqual({ model: 'opus', ...FRESH_DOC });
  });

  it('空对象 {} 也能装;卸载后留下空数组 / 空对象(精确还原归 --restore)', async () => {
    const hx = await claudeHx('a5-inst-empty-');
    await hx.put('.claude/settings.json', '{}\n');
    expect((await hx.write(['--install', '--agent', 'claude'])).code).toBe(0);
    expect(JSON.parse(await hx.read('.claude/settings.json'))).toEqual(FRESH_DOC);
    const u = await hx.write(['--uninstall', '--agent', 'claude', '--json']);
    expect(u.code, u.err).toBe(0);
    expect(JSON.parse(await hx.read('.claude/settings.json'))).toEqual({
      hooks: { SessionEnd: [], SessionStart: [] },
    });
    const ledger = (await hx.ledger()) as { entries: unknown[]; generation: number };
    expect(ledger.entries).toEqual([]);
    expect(ledger.generation).toBe(2);
  });
});

describe('安装:拒绝而不猜(文件状态矩阵;确认与拿锁之前的拒绝 = 零写调用,文件不变)', () => {
  const cases: [string, string | Buffer, string][] = [
    ['不可解析', '{ "a": ', 'config_unparsable'],
    ['重复键', '{\n  "a": 1,\n  "a": 2\n}\n', 'config_unparsable'],
    ['注释', '{\n  // c\n  "a": 1\n}\n', 'config_unparsable'],
    ['尾逗号', '{\n  "a": 1,\n}\n', 'config_unparsable'],
    ['非 UTF-8', Buffer.from([0x7b, 0xff, 0x7d]), 'config_unparsable'],
    ['BOM', '﻿{}\n', 'config_unparsable'],
    ['根是数组', '[]\n', 'config_shape_unsupported'],
    ['根是字符串', '"x"\n', 'config_shape_unsupported'],
    ['hooks 不是对象', canon({ hooks: [] }), 'config_shape_unsupported'],
    ['事件不是数组', canon({ hooks: { SessionStart: {} } }), 'config_shape_unsupported'],
    ['数组元素不是包装对象', canon({ hooks: { SessionStart: [1] } }), 'config_shape_unsupported'],
    [
      '包装对象带多余键',
      canon({ hooks: { SessionStart: [{ matcher: 'x', hooks: [], extra: 1 }] } }),
      'config_shape_unsupported',
    ],
    ['紧凑格式', '{"model":"opus"}\n', 'config_not_canonical'],
    ['4 空格缩进', JSON.stringify({ model: 'opus' }, null, 4), 'config_not_canonical'],
    ['CRLF', canon({ model: 'opus' }).replace(/\n/g, '\r\n'), 'config_not_canonical'],
    ['两个末尾换行', `${canon({ model: 'opus' })}\n`, 'config_not_canonical'],
    [
      '混合包装(kit 钩子与用户钩子在同一个包装里)',
      canon({
        hooks: {
          SessionStart: [{ matcher: 'startup', hooks: [SS.hooks[0], USER_WRAPPER.hooks[0]] }],
        },
      }),
      'foreign_kit_entry',
    ],
    [
      '同命令不同 matcher',
      canon({ hooks: { SessionStart: [{ ...SS, matcher: 'resume' }] } }),
      'foreign_kit_entry',
    ],
    [
      '用户在 kit 条目上加了字段',
      canon({
        hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ ...SS.hooks[0], async: true }] }] },
      }),
      'foreign_kit_entry',
    ],
    [
      '命令前缀是 agent-kit rsi 却不在形状表里',
      canon({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'agent-kit rsi tick --write' }] }],
        },
      }),
      'foreign_kit_entry',
    ],
    ['kit 条目放错了事件', canon({ hooks: { Stop: [SE] } }), 'foreign_kit_entry'],
    [
      '同一形状出现多处',
      canon({ hooks: { SessionStart: [SS, SS], SessionEnd: [SE] } }),
      'ambiguous_entry',
    ],
    [
      '用户手贴了另一变体(未登记的互斥形状)',
      canon({ hooks: { SessionStart: [SS_CANARY] } }),
      'conflicting_shape_unowned',
    ],
  ];
  for (const [name, content, reason] of cases) {
    it(`${name} → ${reason}`, async () => {
      const hx = await claudeHx('a5-inst-rej-');
      await hx.put('.claude/settings.json', content);
      const before = await hx.tree();
      const r = await hx.write(['--install', '--agent', 'claude', '--json']);
      expect(r.code, r.err).toBe(4);
      expect(r.err).toBe(`RSI_HOOKS_NOT_RUN reason=${reason}\n`);
      expect(jsonOf(r)).toMatchObject({ result: 'not_run', write_level: 'zero_write' });
      expect(r.audit).toEqual([]);
      expect(await hx.tree()).toEqual(before);
    });
  }

  it('未登记的互斥变体:用户贴了普通 hint,再装 canary → conflicting_shape_unowned(不删、不新增第二种)', async () => {
    const hx = await claudeHx('a5-inst-confl-');
    await hx.put(
      '.claude/settings.json',
      canon({ hooks: { SessionStart: [SS], SessionEnd: [SE] } }),
    );
    const before = await hx.tree();
    const r = await hx.write(['--install', '--agent', 'claude'], {
      deps: { variantOf: () => 'canary' },
    });
    expect(r.code).toBe(4);
    expect(r.err).toBe('RSI_HOOKS_NOT_RUN reason=conflicting_shape_unowned\n');
    expect(r.audit).toEqual([]);
    expect(await hx.tree()).toEqual(before);
  });

  it('用户已手贴同形状(无账本归属):安装幂等不写;卸载无可卸 = unchanged,文件不动', async () => {
    const hx = await claudeHx('a5-inst-pasted-');
    const text = canon({ hooks: { SessionEnd: [SE], SessionStart: [SS] } });
    await hx.put('.claude/settings.json', text);
    const i = await hx.write(['--install', '--agent', 'claude', '--json']);
    expect(i.code).toBe(0);
    expect(jsonOf(i)).toMatchObject({ result: 'unchanged' });
    expect(i.audit).toEqual([]);
    const u = await hx.write(['--uninstall', '--agent', 'claude', '--json']);
    expect(u.code).toBe(0);
    expect(jsonOf(u)).toMatchObject({ result: 'unchanged' });
    expect(await hx.read('.claude/settings.json')).toBe(text);
    expect(await hx.ledger()).toBeNull();
  });

  it('settings.local.json 里已有同形状 → duplicate_in_local(干跑也拒);读不了 / 不可解析 → duplicate_check_failed;只挡安装不挡卸载', async () => {
    const hx = await claudeHx('a5-inst-local-');
    await hx.put('.claude/settings.local.json', canon({ hooks: { SessionStart: [SS] } }));
    for (const argv of [
      ['--install', '--agent', 'claude'],
      ['--install', '--agent', 'claude', '--write'],
    ]) {
      const r = await hx.run(argv, { tty: true, line: 'yes' });
      expect(r.code).toBe(4);
      expect(r.err).toBe('RSI_HOOKS_NOT_RUN reason=duplicate_in_local\n');
      expect(r.audit).toEqual([]);
    }
    expect(await hx.has('.claude/settings.json')).toBe(false);

    await hx.put('.claude/settings.local.json', 'not json');
    const bad = await hx.write(['--install', '--agent', 'claude']);
    expect(bad.err).toBe('RSI_HOOKS_NOT_RUN reason=duplicate_check_failed\n');
    await hx.rm('.claude/settings.local.json');
    await hx.put('.claude/elsewhere.json', '{}\n');
    await hx.link('.claude/elsewhere.json', '.claude/settings.local.json');
    const lnk = await hx.write(['--install', '--agent', 'claude']);
    expect(lnk.err).toBe('RSI_HOOKS_NOT_RUN reason=duplicate_check_failed\n');
    await hx.rm('.claude/settings.local.json');

    // 先装好,再放一个冲突的 local:卸载不受影响
    expect((await hx.write(['--install', '--agent', 'claude'])).code).toBe(0);
    await hx.put('.claude/settings.local.json', canon({ hooks: { SessionStart: [SS] } }));
    const u = await hx.write(['--uninstall', '--agent', 'claude']);
    expect(u.code, u.err).toBe(0);
  });

  it('settings.local.json 的检测要严格:重复键 / 非 UTF-8 / 目标事件不是数组 → duplicate_check_failed(不当作未发现)', async () => {
    for (const bad of [
      '{ "hooks": {}, "hooks": {} }\n',
      Buffer.from([0x7b, 0xff, 0x7d]),
      canon({ hooks: { SessionStart: {} } }),
      canon({ hooks: [] }),
      '[]\n',
    ]) {
      const hx = await claudeHx('a5-inst-local-strict-');
      await hx.put('.claude/settings.local.json', bad);
      const r = await hx.write(['--install', '--agent', 'claude']);
      expect(r.code).toBe(4);
      expect(r.err).toBe('RSI_HOOKS_NOT_RUN reason=duplicate_check_failed\n');
      expect(r.audit).toEqual([]);
    }
  });

  it('不读项目 cwd、不输出冲突条目全文:拒绝信息只有稳定码', async () => {
    const hx = await claudeHx('a5-inst-leak-');
    await hx.put('.claude/settings.local.json', canon({ hooks: { SessionStart: [SS] } }));
    const r = await hx.write(['--install', '--agent', 'claude']);
    expect(r.err).toBe('RSI_HOOKS_NOT_RUN reason=duplicate_in_local\n');
    expect(r.out).toBe('');
  });
});

describe('形状核实是写能力的闸(R20-15.8–15.10)', () => {
  const withEvidence = (e: HookShape['evidence']): ShapeTable => ({
    claude: { ...PRODUCTION_SHAPES.claude, evidence: e },
    codex: { ...PRODUCTION_SHAPES.codex, evidence: e },
    pi: { ...PRODUCTION_SHAPES.pi, evidence: e },
  });

  it('生产形状表三家都是「假设」→ --install --write 退 4 shape_unverified,零写调用;干跑照常、verified=false', async () => {
    for (const agent of AGENTS) {
      expect(PRODUCTION_SHAPES[agent].evidence).toBe('假设');
      const hx = await makeHx('a5-shape-prod-');
      await hx.agentRoot(agent);
      const before = await hx.tree();
      const r = await hx.write(['--install', '--agent', agent, '--json'], {
        shapes: PRODUCTION_SHAPES,
      });
      expect(r.code, `${agent}: ${r.err}`).toBe(4);
      expect(r.err).toBe('RSI_HOOKS_NOT_RUN reason=shape_unverified\n');
      expect(jsonOf(r)).toMatchObject({
        verified: false,
        write_level: 'zero_write',
        result: 'not_run',
      });
      expect(r.audit).toEqual([]);
      expect(await hx.tree()).toEqual(before);
      const dry = await hx.run(['--install', '--agent', agent, '--json'], {
        shapes: PRODUCTION_SHAPES,
      });
      expect(dry.code).toBe(0);
      expect(jsonOf(dry)).toMatchObject({ verified: false, result: 'dry_run' });
    }
  });

  it('四种证据级别:只有「公开文档」「实测运行」开放 --write', async () => {
    for (const [evidence, ok] of [
      ['公开文档', true],
      ['实测运行', true],
      ['实测结构', false],
      ['假设', false],
    ] as const) {
      const hx = await claudeHx('a5-shape-ev-');
      const r = await hx.write(['--install', '--agent', 'claude', '--json'], {
        shapes: withEvidence(evidence),
      });
      expect(r.code, `${evidence}: ${r.err}`).toBe(ok ? 0 : 4);
      expect(jsonOf(r)['verified']).toBe(ok);
    }
  });

  it('适用的 agent 版本范围:区间内放行;区间外 / 版本未知 / 无法解析 → shape_unverified(fail closed)', async () => {
    const ranged: ShapeTable = {
      ...TEST_SHAPES,
      claude: {
        ...PRODUCTION_SHAPES.claude,
        evidence: '公开文档',
        agent_versions: { min: '1.0.0', max: '2.0.0' },
      },
    };
    for (const [version, ok] of [
      ['1.0.0', true],
      ['1.5.3', true],
      ['2.0.0', true],
      ['0.9.9', false],
      ['2.0.1', false],
      [undefined, false],
      ['garbage', false],
    ] as const) {
      const hx = await claudeHx('a5-shape-ver-');
      const r = await hx.write(['--install', '--agent', 'claude'], {
        shapes: ranged,
        deps: { agentVersion: () => version },
      });
      expect(r.code, String(version)).toBe(ok ? 0 : 4);
      if (!ok) expect(r.err).toBe('RSI_HOOKS_NOT_RUN reason=shape_unverified\n');
    }
  });

  it('卸载 / restore 不看形状核实(只动账本登记过的节点),生产形状表下也能卸掉之前装的', async () => {
    const hx = await claudeHx('a5-shape-uninst-');
    expect((await hx.write(['--install', '--agent', 'claude'])).code).toBe(0);
    const u = await hx.write(['--uninstall', '--agent', 'claude'], { shapes: PRODUCTION_SHAPES });
    expect(u.code, u.err).toBe(0);
    expect(JSON.parse(await hx.read('.claude/settings.json'))).toEqual({
      hooks: { SessionEnd: [], SessionStart: [] },
    });
  });
});

describe('卸载:只删账本登记过且指纹仍一致的最小节点', () => {
  it('用户内容不动,kit 节点移除;备份整份;账本归属清空', async () => {
    const hx = await claudeHx('a5-uninst-');
    await hx.put('.claude/settings.json', userSettings(), 0o644);
    await hx.write(['--install', '--agent', 'claude']);
    const installed = await hx.read('.claude/settings.json');
    const u = await hx.write(['--uninstall', '--agent', 'claude', '--json']);
    expect(u.code, u.err).toBe(0);
    const id = jsonOf(u)['txn_id'] as string;
    const doc = JSON.parse(await hx.read('.claude/settings.json')) as Record<string, unknown>;
    expect(doc['hooks']).toEqual({ PreToolUse: [USER_WRAPPER], SessionEnd: [], SessionStart: [] });
    expect(doc['model']).toBe('opus');
    expect(await hx.read(`${STATE_REL}/backups/${id}/claude`)).toBe(installed);
    expect(((await hx.ledger()) as { entries: unknown[] }).entries).toEqual([]);
  });

  it('按命令串删除是错的:用户把 kit 包装对象改了(加字段)→ config_changed_since_install,不删', async () => {
    const hx = await claudeHx('a5-uninst-mod-');
    await hx.write(['--install', '--agent', 'claude']);
    const doc = JSON.parse(await hx.read('.claude/settings.json')) as typeof FRESH_DOC;
    (doc.hooks.SessionStart[0] as { hooks: Record<string, unknown>[] }).hooks[0]!['async'] = true;
    await hx.put('.claude/settings.json', canon(doc));
    const before = await hx.tree();
    const u = await hx.write(['--uninstall', '--agent', 'claude']);
    expect(u.code).toBe(4);
    expect(u.err).toBe('RSI_HOOKS_NOT_RUN reason=config_changed_since_install\n');
    expect(u.audit).toEqual([]);
    expect(await hx.tree()).toEqual(before);
    // 同样的文件再装 → 命令前缀在、完整包装对不上 → foreign_kit_entry
    const i = await hx.write(['--install', '--agent', 'claude']);
    expect(i.err).toBe('RSI_HOOKS_NOT_RUN reason=foreign_kit_entry\n');
  });

  it('用户混入了自己的钩子到 kit 包装对象 → 不删包装对象(config_changed_since_install)', async () => {
    const hx = await claudeHx('a5-uninst-mixed-');
    await hx.write(['--install', '--agent', 'claude']);
    const doc = JSON.parse(await hx.read('.claude/settings.json')) as typeof FRESH_DOC;
    (doc.hooks.SessionEnd[0] as { hooks: unknown[] }).hooks.push(USER_WRAPPER.hooks[0]);
    await hx.put('.claude/settings.json', canon(doc));
    const u = await hx.write(['--uninstall', '--agent', 'claude']);
    expect(u.err).toBe('RSI_HOOKS_NOT_RUN reason=config_changed_since_install\n');
  });

  it('节点已被用户删掉:无可卸 = unchanged;账本不变', async () => {
    const hx = await claudeHx('a5-uninst-gone-');
    await hx.write(['--install', '--agent', 'claude']);
    await hx.put('.claude/settings.json', canon({ hooks: {} }));
    const ledger = await hx.ledger();
    const u = await hx.write(['--uninstall', '--agent', 'claude', '--json']);
    expect(u.code).toBe(0);
    expect(jsonOf(u)).toMatchObject({ result: 'unchanged' });
    expect(u.audit).toEqual([]);
    expect(await hx.ledger()).toEqual(ledger);
  });
});

describe('写出也守读取上限(评审采纳)', () => {
  it('追加后会超过 1 MiB → config_shape_unsupported,零写调用,文件不动;留有余量则照常安装', async () => {
    const MAX = 1024 * 1024;
    const overhead = Buffer.byteLength(canon({ pad: '' }));
    const sized = (total: number): string => canon({ pad: 'a'.repeat(total - overhead) });
    const hx = await claudeHx('a5-inst-size-');
    await hx.put('.claude/settings.json', sized(MAX - 100)); // 读得进来,但装上 kit 条目就超
    const before = await hx.tree();
    const r = await hx.write(['--install', '--agent', 'claude']);
    expect(r.code, r.err).toBe(4);
    expect(r.err).toBe('RSI_HOOKS_NOT_RUN reason=config_shape_unsupported\n');
    expect(r.audit).toEqual([]);
    expect(await hx.tree()).toEqual(before);
    await hx.put('.claude/settings.json', sized(MAX - 4000));
    const ok = await hx.write(['--install', '--agent', 'claude']);
    expect(ok.code, ok.err).toBe(0);
    // 装好之后下一次读取没有问题
    expect((await hx.write(['--install', '--agent', 'claude', '--json'])).code).toBe(0);
  });
});

describe('变体迁移(hint ↔ canary)在同一个事务里提交', () => {
  it('plain → canary:remove + add 同一事务;再迁回', async () => {
    const hx = await claudeHx('a5-variant-');
    await hx.write(['--install', '--agent', 'claude']);
    const toCanary = await hx.write(['--install', '--agent', 'claude', '--json'], {
      deps: { variantOf: () => 'canary' },
    });
    expect(toCanary.code, toCanary.err).toBe(0);
    const plan = jsonOf(toCanary)['plan'] as { ops: { op: string; event: string }[] };
    expect(plan.ops.map((o) => `${o.op}:${o.event}`)).toEqual([
      'remove:SessionStart',
      'add:SessionStart',
    ]);
    expect(JSON.parse(await hx.read('.claude/settings.json'))).toEqual({
      hooks: { SessionEnd: [SE], SessionStart: [SS_CANARY] },
    });
    const ledger = (await hx.ledger()) as {
      entries: { event: string; variant: string }[];
      generation: number;
    };
    expect(ledger.generation).toBe(2);
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries.find((e) => e.event === 'SessionStart')?.variant).toBe('canary');
    // 一个事务 = 一个 journal 周期:此后没有残留
    expect(await hx.journals()).toEqual([]);

    const back = await hx.write(['--install', '--agent', 'claude']);
    expect(back.code, back.err).toBe(0);
    expect(JSON.parse(await hx.read('.claude/settings.json'))).toEqual({
      hooks: { SessionEnd: [SE], SessionStart: [SS] },
    });
  });
});

describe('codex 与 pi', () => {
  it('codex:同一套合并写入(形状表另有命令串)', async () => {
    const hx = await makeHx('a5-codex-');
    await hx.agentRoot('codex');
    const r = await hx.write(['--install', '--agent', 'codex']);
    expect(r.code, r.err).toBe(0);
    const doc = JSON.parse(await hx.read('.codex/hooks.json')) as typeof FRESH_DOC;
    expect(doc.hooks.SessionStart[0]!.hooks[0]!.command).toBe(
      'agent-kit rsi hint --agent codex --format codex-json',
    );
    expect(doc.hooks.SessionEnd[0]!.hooks[0]!.command).toBe('agent-kit rsi poke --agent codex');
    expect(await hx.names('.codex')).toEqual(['hooks.json']);
  });

  it('pi:独立文件(不合并),extensions/ 以 0700 建在已存在的 agent 根之下;账本记整文件指纹', async () => {
    const hx = await makeHx('a5-pi-');
    await hx.agentRoot('pi');
    const r = await hx.write(['--install', '--agent', 'pi', '--json']);
    expect(r.code, r.err).toBe(0);
    const rel = '.pi/agent/extensions/agent-kit-rsi.ts';
    expect(await hx.read(rel)).toBe(PI_EXTENSION_SOURCE_PLAIN);
    expect(await modeOf(hx, rel)).toBe(0o600);
    expect(await modeOf(hx, '.pi/agent/extensions')).toBe(0o700);
    const ledger = (await hx.ledger()) as { entries: { event: string; fingerprint: string }[] };
    expect(ledger.entries).toMatchObject([
      { event: 'file', fingerprint: sha(PI_EXTENSION_SOURCE_PLAIN) },
    ]);
    // 幂等
    const again = await hx.write(['--install', '--agent', 'pi', '--json']);
    expect(jsonOf(again)).toMatchObject({ result: 'unchanged' });
    // 卸载 = 删文件(目录保留)
    const u = await hx.write(['--uninstall', '--agent', 'pi']);
    expect(u.code, u.err).toBe(0);
    expect(await hx.has(rel)).toBe(false);
    expect(await hx.has('.pi/agent/extensions')).toBe(true);
  });

  it('pi 外来文件:同名文件已存在而账本无归属 → 不覆盖(foreign_kit_entry);内容恰好相同则幂等', async () => {
    const hx = await makeHx('a5-pi-foreign-');
    await hx.agentRoot('pi');
    const rel = '.pi/agent/extensions/agent-kit-rsi.ts';
    await hx.put(rel, '// 用户自己的扩展\n');
    const r = await hx.write(['--install', '--agent', 'pi']);
    expect(r.code).toBe(4);
    expect(r.err).toBe('RSI_HOOKS_NOT_RUN reason=foreign_kit_entry\n');
    expect(r.audit).toEqual([]);
    expect(await hx.read(rel)).toBe('// 用户自己的扩展\n');
    await hx.put(rel, PI_EXTENSION_SOURCE_PLAIN);
    const same = await hx.write(['--install', '--agent', 'pi', '--json']);
    expect(jsonOf(same)).toMatchObject({ result: 'unchanged' });
    expect(same.audit).toEqual([]);
  });

  it('pi 内容漂移:有记录但被改过 → 卸载 / 重装都拒(config_changed_since_install)', async () => {
    const hx = await makeHx('a5-pi-drift-');
    await hx.agentRoot('pi');
    await hx.write(['--install', '--agent', 'pi']);
    const rel = '.pi/agent/extensions/agent-kit-rsi.ts';
    await hx.put(rel, `${PI_EXTENSION_SOURCE_PLAIN}// 用户加的\n`);
    for (const m of ['--uninstall', '--install']) {
      const r = await hx.write([m, '--agent', 'pi']);
      expect(r.err, m).toBe('RSI_HOOKS_NOT_RUN reason=config_changed_since_install\n');
    }
  });

  it('PI_CODING_AGENT_DIR 已设:pi 的 install / uninstall 不碰固定位置(暂借 agent_not_installed,缺口待定夺)', async () => {
    const hx = await makeHx('a5-pi-dir-');
    await hx.agentRoot('pi');
    const r = await hx.write(['--install', '--agent', 'pi'], {
      envExtra: { PI_CODING_AGENT_DIR: '/somewhere/else' },
    });
    expect(r.code).toBe(4);
    expect(r.err).toBe('RSI_HOOKS_NOT_RUN reason=agent_not_installed\n');
    expect(r.audit).toEqual([]);
  });

  it('agent 根不存在 → 4 agent_not_installed;kit 不替 agent 建根目录', async () => {
    for (const agent of AGENTS) {
      const hx = await makeHx('a5-noroot-');
      const t0 = await hx.tree();
      for (const mode of ['--install', '--uninstall']) {
        const r = await hx.write([mode, '--agent', agent]);
        expect(r.code, `${agent} ${mode}`).toBe(4);
        expect(r.err).toBe('RSI_HOOKS_NOT_RUN reason=agent_not_installed\n');
        expect(r.audit).toEqual([]);
      }
      expect(await hx.tree()).toEqual(t0);
    }
  });
});

describe('读取安全(R20-15.14):不安全的目标 → 3 hooks_target_unsafe,零写入', () => {
  const expectUnsafe = async (hx: Hx, r: R): Promise<void> => {
    expect(r.code, r.err).toBe(3);
    expect(r.err).toBe('RSI_FAIL_CLOSED reason=hooks_target_unsafe\n');
    expect(r.audit).toEqual([]);
    void hx;
  };

  it('目标是符号链接 / 硬链接 / 组可写 / 属主不符 / 超过 1 MiB', async () => {
    const hx = await claudeHx('a5-unsafe-target-');
    await hx.put('.claude/real.json', '{}\n');
    await hx.link('.claude/real.json', '.claude/settings.json');
    await expectUnsafe(hx, await hx.write(['--install', '--agent', 'claude']));
    await hx.rm('.claude/settings.json');

    await hx.put('.claude/settings.json', '{}\n');
    await hx.hard('.claude/settings.json', '.claude/settings.hard.json');
    await expectUnsafe(hx, await hx.write(['--install', '--agent', 'claude']));
    await hx.rm('.claude/settings.hard.json');

    await hx.chmod('.claude/settings.json', 0o664);
    await expectUnsafe(hx, await hx.write(['--install', '--agent', 'claude']));
    await hx.chmod('.claude/settings.json', 0o600);

    const uid = process.getuid?.();
    if (uid !== undefined) {
      await expectUnsafe(
        hx,
        await hx.write(['--install', '--agent', 'claude'], { deps: { uid: uid + 1 } }),
      );
    }

    await hx.put('.claude/settings.json', `{"x":"${'a'.repeat(1024 * 1024)}"}\n`);
    await expectUnsafe(hx, await hx.write(['--install', '--agent', 'claude']));
  });

  it('agent 根 / 中间段:符号链接、组可写 → 不安全', async () => {
    const hx = await makeHx('a5-unsafe-root-');
    await hx.mkdir('real-claude');
    await hx.link('real-claude', '.claude');
    await expectUnsafe(hx, await hx.write(['--install', '--agent', 'claude']));
    await hx.rm('.claude');
    await hx.mkdir('.claude', 0o775);
    await expectUnsafe(hx, await hx.write(['--install', '--agent', 'claude']));
  });

  it('文件不是普通文件(目录)→ 不安全', async () => {
    const hx = await claudeHx('a5-unsafe-dir-');
    await hx.mkdir('.claude/settings.json');
    await expectUnsafe(hx, await hx.write(['--install', '--agent', 'claude']));
  });
});

describe('哨兵:稳定码之外不回显任何配置内容', () => {
  it('各种拒绝的 stdout / stderr / JSON 都不含用户配置里的哨兵', async () => {
    const hx = await claudeHx('a5-sentinel-');
    await hx.put('.claude/settings.json', `{ "k": "${SENTINEL}", `);
    for (const argv of [
      ['--install', '--agent', 'claude', '--json'],
      ['--uninstall', '--agent', 'claude', '--json'],
    ]) {
      const r = await hx.write(argv);
      expect(r.out + r.err).not.toContain(SENTINEL);
    }
  });
});

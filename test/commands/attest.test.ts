/**
 * attest 命令(L5):合成仓库 + 合成信号(KIT_TMP 下),不碰真实信号库;零网络。
 */
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createAttestCommand, command } from '../../src/commands/attest.js';
import type { CommandContext } from '../../src/commands/types.js';
import { AttestSchema } from '../../src/contracts/attest.js';
import type { Signal } from '../../src/contracts/signal.js';
import { createIoContext } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import { readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { writeSignals } from '../../src/signals/state-store.js';
import { makeTestRepo } from '../helpers/make-repo.js';
import type { TestRepo } from '../helpers/make-repo.js';
import { snapshot } from '../judge/helpers.js';
import { REPO_ROOT } from '../helpers/tmp.js';

const hex = (n: number, len: number): string => n.toString(16).padStart(len, '0');
let seq = 0;
function mkSignal(over: Partial<Signal> = {}): Signal {
  const n = ++seq;
  return {
    sig_id: `sig_${hex(n, 16)}`,
    agent: 'claude',
    agent_version: '2.1.280',
    agent_version_source: 'session_meta',
    session_ref: `s_${hex(1, 16)}`,
    project_key: `p_${hex(1, 16)}`,
    ts: '2026-10-10T10:00:00Z',
    type: 'event',
    excerpt_redacted: 'please keep the change small',
    external_content: false,
    confidence: 1,
    loaded_rule_ids: [],
    event_kind: 'user_message',
    event_index: n,
    ...over,
  };
}
const sess = (n: number): string => `s_${hex(n, 16)}`;

const kitToml = `[kit]
name = "t"
version = "0.0.0"

[agents]
enabled = ["claude"]

[budget]
enforce = "warn"

[budget.claude]
max_lines = 100000
limit_source = "documented"

[channels.canary.members]
"@alice" = {}

[channels.stable.members]
`;

function atomMd(over: { status?: string; layer?: string; signature?: string } = {}): string {
  const sig = over.signature ?? 'signature:\n  type: phrase\n  pattern: keep the change\n';
  return `---
id: keep-small
title: 变更保持最小
layer: ${over.layer ?? 'team'}
strength: should
kind: practice
volatility: stable
status: ${over.status ?? 'advisory'}
owner: '@alice'
created: 2026-10-01
review_by: 2027-01-01
evidence:
  - type: memory
    ref: 'sha256:0b32015d12ff5746bea50b53f2f3ac499078a3644c518d8192a6673cefdf15ef'
    excerpt: 示例证据
${sig}verifier:
  type: none
---

**做**:只改必需的部分。
**为什么**:减少评审范围。
**怎么验**:diff 只涉及指定文件。
`;
}

const made: TestRepo[] = [];
afterAll(async () => {
  for (const r of made.splice(0)) await r.dispose();
});

interface World {
  repo: TestRepo;
  parent: string;
  io: IoContext;
}
async function newWorld(
  o: { atom?: string; signals?: Signal[] | null; kit?: string; rawSignalLines?: string[] } = {},
): Promise<World> {
  const repo = await makeTestRepo('attest-');
  made.push(repo);
  const parent = path.dirname(repo.dir);
  await repo.commit(
    {
      'kit.toml': o.kit ?? kitToml,
      'rules/team/keep-small.md': o.atom ?? atomMd(),
    },
    'base',
  );
  const io = createIoContext({
    cwd: REPO_ROOT,
    root: repo.dir,
    env: { KIT_TMP: parent, KIT_STATE_DIR: path.join(parent, 'state'), PATH: '/usr/bin:/bin' },
  });
  if (o.signals !== null) await writeSignals(io, 'claude', o.signals ?? [mkSignal()]);
  if (o.rawSignalLines !== undefined) {
    const dir = path.join(io.stateDir, 'signals', 'claude');
    await safe.mkdirp(io, dir, 0o700);
    await safe.writeFile(io, path.join(dir, '202610.jsonl'), `${o.rawSignalLines.join('\n')}\n`, {
      mode: 0o600,
    });
  }
  return { repo, parent, io };
}

const FIXED_NOW = new Date('2026-10-12T08:00:00Z');
const make = (): ReturnType<typeof createAttestCommand> =>
  createAttestCommand({ now: () => FIXED_NOW, randomHex: () => 'abc123' });
const RUN_ID = 'run-20261012T080000Z-abc123';

const WINDOW = ['--window-start', '2026-10-01', '--window-end', '2026-10-14'];
const ARGS = ['--rule', 'keep-small', '--member', '@alice', ...WINDOW];

async function run(
  w: World,
  argv: string[],
  cmd = make(),
  overlayPath?: string,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    argv,
    io: w.io,
    overlayPath,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  };
  const code = await cmd.run(ctx);
  return { code, out: out.join(''), err: err.join('') };
}

describe('attest:干跑与写出', () => {
  it('默认干跑:退出 0,打印计数,磁盘零变化(前后快照)', async () => {
    const w = await newWorld();
    const before = await snapshot(w.parent);
    const r = await run(w, [...ARGS, '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as Record<string, unknown>;
    expect(j).toMatchObject({
      dry: true,
      wrote: false,
      method: 'signature_proxy_v1',
      fired: 1,
      exposure_sessions: 1,
      sessions_total: 1,
      run_id: RUN_ID,
    });
    expect(await snapshot(w.parent)).toEqual(before);
  });

  it('--write:只新增 .state/attest/<run_id>/{attest.patch,report.json},权限 0700/0600;补丁可 git apply 且 JSON 过 AttestSchema、method 已写入', async () => {
    const w = await newWorld();
    const before = await snapshot(w.parent);
    const r = await run(w, [...ARGS, '--write']);
    expect(r.code).toBe(0);
    const after = await snapshot(w.parent);
    const added = Object.keys(after).filter((k) => !(k in before));
    expect(added.sort()).toEqual([
      path.join('state', 'attest', RUN_ID, 'attest.patch'),
      path.join('state', 'attest', RUN_ID, 'report.json'),
    ]);
    for (const k of Object.keys(before)) expect(after[k], k).toBe(before[k]);

    const patchFile = path.join(w.io.stateDir, 'attest', RUN_ID, 'attest.patch');
    const patch = await readText(patchFile);
    // 工作树 rules/ 与 attest/ 都没被动过
    w.repo.git(['apply', '--check', '--whitespace=error', patchFile]);
    expect(patch).toContain(`new file mode 100644`);
    const files = [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map((m) => m[1]);
    expect(files).toEqual([`attest/keep-small/alice-2026-10-14-${RUN_ID}.json`]);
    const body = patch
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join('\n');
    const a = AttestSchema.parse(JSON.parse(body));
    expect(a.method).toBe('signature_proxy_v1');
    expect(a.run_id).toBe(RUN_ID);
    expect(a.rule_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.signal_ids_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.exposure_sessions).toBe(1);
  });

  it('幂等:同输入(同注入时钟/随机源)两个独立世界产物字节相同;同世界重跑 --write 不重写、退出 0', async () => {
    const sigs = [mkSignal({ session_ref: sess(1) }), mkSignal({ session_ref: sess(2) })];
    const w1 = await newWorld({ signals: sigs });
    const w2 = await newWorld({ signals: sigs });
    expect((await run(w1, [...ARGS, '--write'])).code).toBe(0);
    expect((await run(w2, [...ARGS, '--write'])).code).toBe(0);
    const f = (w: World, n: string): Promise<string> =>
      readText(path.join(w.io.stateDir, 'attest', RUN_ID, n));
    expect(await f(w1, 'attest.patch')).toBe(await f(w2, 'attest.patch'));
    expect(await f(w1, 'report.json')).toBe(await f(w2, 'report.json'));

    const snap = await snapshot(w1.parent);
    const again = await run(w1, [...ARGS, '--write', '--json']);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({ wrote: false, existing: true });
    expect(await snapshot(w1.parent)).toEqual(snap);
  });

  it('同 run_id 目录已存在但内容不同 → 退出 3(不覆盖)', async () => {
    const w = await newWorld();
    expect((await run(w, [...ARGS, '--write'])).code).toBe(0);
    const patchFile = path.join(w.io.stateDir, 'attest', RUN_ID, 'attest.patch');
    await safe.writeFile(w.io, patchFile, 'tampered\n', { mode: 0o600 });
    const r = await run(w, [...ARGS, '--write']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('ATTEST_FAIL_CLOSED reason=run_exists\n');
    expect(await readText(patchFile)).toBe('tampered\n');
  });
});

describe('attest:D4 去重(命令级)', () => {
  const dupA = (): Signal =>
    mkSignal({ session_ref: sess(1), event_key: 'ek_dup', ts: '2026-10-10T10:00:00Z' });
  const dupB = (): Signal =>
    mkSignal({ session_ref: sess(2), event_key: 'ek_dup', ts: '2026-10-10T10:00:00Z' });

  it('跨文件重复的同一事件只计一次;去掉 event_key 则计两次(正向控制组)', async () => {
    const withKey = await newWorld({ signals: [dupA(), dupB()] });
    const r1 = JSON.parse((await run(withKey, [...ARGS, '--json'])).out) as Record<string, number>;
    expect(r1['fired']).toBe(1);
    expect(r1['exposure_sessions']).toBe(1);
    expect(r1['deduplicated']).toBe(1);

    const strip = ({ event_key: _k, ...rest }: Signal): Signal => {
      void _k;
      return rest;
    };
    const noKey = await newWorld({ signals: [strip(dupA()), strip(dupB())] });
    const r2 = JSON.parse((await run(noKey, [...ARGS, '--json'])).out) as Record<string, number>;
    expect(r2['fired']).toBe(2);
    expect(r2['exposure_sessions']).toBe(2);
  });
});

describe('attest:退出码', () => {
  it('0:advisory 与 active 都可计数;窗口里有数据但无命中也是 0(exposure=0)', async () => {
    const w = await newWorld({ atom: atomMd({ status: 'active' }) });
    expect((await run(w, ARGS)).code).toBe(0);
    const w2 = await newWorld({ signals: [mkSignal({ excerpt_redacted: 'unrelated' })] });
    const r = await run(w2, [...ARGS, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ exposure_sessions: 0, fired: 0, sessions_total: 1 });
  });

  it('1:规则状态不是 advisory/active;无签名;签名 pattern 不安全', async () => {
    for (const status of ['proposed', 'deprecated', 'retired']) {
      const w = await newWorld({ atom: atomMd({ status }) });
      const r = await run(w, ARGS);
      expect(r.code, status).toBe(1);
      expect(r.err).toBe('ATTEST_CHECK_FAILED reason=rule_not_countable\n');
    }
    // advisory 无 signature(schema 只强制 active 必须有)
    const noSig = await newWorld({ atom: atomMd({ signature: '' }) });
    const r1 = await run(noSig, ARGS);
    expect(r1.code).toBe(1);
    expect(r1.err).toBe('ATTEST_CHECK_FAILED reason=signature_missing\n');
    const unsafe = await newWorld({
      atom: atomMd({ signature: "signature:\n  type: phrase\n  pattern: '(a+)+b'\n" }),
    });
    const r2 = await run(unsafe, ARGS);
    expect(r2.code).toBe(1);
    expect(r2.err).toBe('ATTEST_CHECK_FAILED reason=signature_unsafe\n');
  });

  it('2:缺参数、成员不在成员表、窗口反了、规则不存在、personal 层、--run-llm / --allow-egress、未知参数、非法 agent/日期/渠道', async () => {
    const w = await newWorld();
    const cases: [string[], string][] = [
      [['--member', '@alice', ...WINDOW], 'missing:--rule'],
      [['--rule', 'keep-small', ...WINDOW], 'missing:--member'],
      [['--rule', 'keep-small', '--member', '@alice'], 'missing:--window-start'],
      [[...ARGS.slice(0, -2)], 'missing:--window-end'],
      [['--rule', 'keep-small', '--member', '@bob', ...WINDOW], 'member_not_in_channel'],
      [['--rule', 'keep-small', '--member', 'alice', ...WINDOW], 'bad_member'],
      [
        [
          '--rule',
          'keep-small',
          '--member',
          '@alice',
          '--window-start',
          '2026-10-14',
          '--window-end',
          '2026-10-01',
        ],
        'window_reversed',
      ],
      [['--rule', 'nope', '--member', '@alice', ...WINDOW], 'rule_not_found'],
      [[...ARGS, '--run-llm'], 'no_egress_flags'],
      [[...ARGS, '--allow-egress'], 'no_egress_flags'],
      [[...ARGS, '--bogus'], 'unknown_arg'],
      [[...ARGS, '--agent', 'nobody'], 'bad_agent'],
      [[...ARGS, '--channel', 'Bad Channel'], 'bad_channel'],
      [
        [
          '--rule',
          'keep-small',
          '--member',
          '@alice',
          '--window-start',
          '2026-13-45',
          '--window-end',
          '2026-10-14',
        ],
        'bad_window_start',
      ],
      [[...ARGS, '--channel', 'stable'], 'member_not_in_channel'], // 成员表按渠道登记
    ];
    for (const [argv, reason] of cases) {
      const r = await run(w, argv);
      expect(r.code, reason).toBe(2);
      expect(r.err, reason).toBe(`ATTEST_USAGE reason=${reason}\n`);
      expect(r.out).toBe('');
    }
    const personal = await newWorld({ atom: atomMd({ layer: 'personal' }) });
    const r = await run(personal, ARGS);
    expect(r.code).toBe(2);
    expect(r.err).toBe('ATTEST_USAGE reason=PERSONAL_LAYER_P2\n');
  });

  it('3:信号库有无法解析的行;kit.toml 缺失/损坏', async () => {
    const w = await newWorld({ signals: null, rawSignalLines: ['{not json'] });
    const r = await run(w, ARGS);
    expect(r.code).toBe(3);
    expect(r.err).toBe('ATTEST_FAIL_CLOSED reason=signal_store\n');
    const bad = await newWorld({ kit: 'this is = not [valid' });
    const r2 = await run(bad, ARGS);
    expect(r2.code).toBe(3);
    expect(r2.err).toBe('ATTEST_FAIL_CLOSED reason=config\n');
  });

  it('3:写出口拒绝(state 目录之外不可写)', async () => {
    const w = await newWorld();
    const narrow = createIoContext({
      cwd: REPO_ROOT,
      root: w.repo.dir,
      env: {
        KIT_TMP: w.parent,
        KIT_STATE_DIR: path.join(w.parent, 'state'),
        KIT_WRITE_ROOTS: path.join(w.parent, 'elsewhere'),
        PATH: '/usr/bin:/bin',
      },
    });
    const r = await run({ ...w, io: narrow }, [...ARGS, '--write']);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/^ATTEST_FAIL_CLOSED reason=\S+\n$/);
    expect(r.out).toBe('');
  });

  it('3:窗口内合法 JSON 但不符合 schema 的信号行 → 退出 3、不出报告;窗口外的坏行被忽略(正向对照)', async () => {
    const good = JSON.stringify(mkSignal());
    const badInWindow = JSON.stringify({ ts: '2026-10-10T10:00:00Z', sig_id: 'nope' });
    const w = await newWorld({ signals: null, rawSignalLines: [good, badInWindow] });
    const r = await run(w, [...ARGS, '--write']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('ATTEST_FAIL_CLOSED reason=signal_store_schema\n');
    expect(Object.keys(await snapshot(w.parent)).some((k) => k.includes('attest/'))).toBe(false);

    const badOutside = JSON.stringify({ ts: '2026-10-20T10:00:00Z', sig_id: 'nope' });
    const w2 = await newWorld({ signals: null, rawSignalLines: [good, badOutside] });
    expect((await run(w2, ARGS)).code).toBe(0);
  });

  it('3:.state/attest 被换成符号链接(指向写入根内别处)→ 退出 3,目标目录不变', async () => {
    const w = await newWorld();
    const elsewhere = path.join(w.parent, 'elsewhere');
    await safe.mkdirp(w.io, elsewhere);
    await safe.mkdirp(w.io, w.io.stateDir);
    await safe.symlink(w.io, elsewhere, path.join(w.io.stateDir, 'attest'));
    const before = await snapshot(elsewhere);
    const r = await run(w, [...ARGS, '--write']);
    expect(r.code).toBe(3);
    expect(r.err).toBe('ATTEST_FAIL_CLOSED reason=state_dir_unsafe\n');
    expect(await snapshot(elsewhere)).toEqual(before);
  });

  it('4:signature.type=path 无数据源;窗口内没有任何信号/会话数据', async () => {
    const pathAtom = await newWorld({
      atom: atomMd({ signature: "signature:\n  type: path\n  pattern: '**/*.ts'\n" }),
    });
    const r = await run(pathAtom, [...ARGS, '--write']);
    expect(r.code).toBe(4);
    expect(r.err).toBe('ATTEST_NOT_RUN reason=signature_path_unsupported\n');
    expect(r.out).toBe('');
    // 写出口没有留下任何东西
    expect(Object.keys(await snapshot(pathAtom.parent)).some((k) => k.includes('attest'))).toBe(
      false,
    );

    const empty = await newWorld({ signals: [mkSignal({ ts: '2026-08-01T00:00:00Z' })] });
    const r2 = await run(empty, ARGS);
    expect(r2.code).toBe(4);
    expect(r2.err).toBe('ATTEST_NOT_RUN reason=no_window_data\n');
    const none = await newWorld({ signals: null });
    expect((await run(none, ARGS)).code).toBe(4);
  });
});

describe('attest:输出与边界', () => {
  it('stdout / stderr / 报告都不含摘录文本(canary)', async () => {
    const canary = 'canary-zq9-keep the change';
    const w = await newWorld({ signals: [mkSignal({ excerpt_redacted: canary })] });
    const ok = await run(w, [...ARGS, '--write']);
    expect(ok.code).toBe(0);
    expect(ok.out).not.toContain('canary-zq9');
    const snap = await snapshot(path.join(w.io.stateDir, 'attest'));
    for (const [k, v] of Object.entries(snap)) expect(v, k).not.toContain('canary-zq9');
    const bad = await run(w, ['--rule', 'keep-small', '--member', '@bob', ...WINDOW]);
    expect(bad.err).not.toContain('canary-zq9');
  });

  it('--agent 过滤与 applies_to 默认:只数指定 agent', async () => {
    const w = await newWorld({ signals: [mkSignal({ agent: 'claude' })] });
    await writeSignals(w.io, 'pi', [mkSignal({ agent: 'pi', session_ref: sess(7) })]);
    const all = JSON.parse((await run(w, [...ARGS, '--json'])).out) as Record<string, number>;
    expect(all['exposure_sessions']).toBe(2);
    const onlyPi = JSON.parse((await run(w, [...ARGS, '--agent', 'pi', '--json'])).out) as Record<
      string,
      number
    >;
    expect(onlyPi['exposure_sessions']).toBe(1);
  });

  it('tool 型签名匹配 tool_call 的 tool_name', async () => {
    const atom = atomMd({ signature: 'signature:\n  type: tool\n  pattern: ^Bash$\n' });
    const w = await newWorld({
      atom,
      signals: [
        mkSignal({
          event_kind: 'tool_call',
          tool_name: 'Bash',
          excerpt_redacted: '',
          session_ref: sess(1),
        }),
        mkSignal({
          event_kind: 'tool_call',
          tool_name: 'Read',
          excerpt_redacted: '',
          session_ref: sess(2),
        }),
      ],
    });
    const j = JSON.parse((await run(w, [...ARGS, '--json'])).out) as Record<string, number>;
    expect(j['fired']).toBe(1);
    expect(j['exposure_sessions']).toBe(1);
    expect(j['sessions_total']).toBe(2);
  });

  it('覆盖层 channel 决定渠道;不可读的覆盖层 → 2', async () => {
    const stableKit = kitToml.replace(
      '[channels.stable.members]\n',
      '[channels.stable.members]\n"@alice" = {}\n',
    );
    const w = await newWorld({ kit: stableKit });
    const overlay = path.join(w.parent, 'overlay.toml');
    await safe.writeFile(w.io, overlay, 'channel = "stable"\n');
    const r = await run(w, [...ARGS, '--json'], make(), overlay);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"channel": "stable"');
    const bad = await run(w, ARGS, make(), path.join(w.parent, 'missing.toml'));
    expect(bad.code).toBe(2);
    expect(bad.err).toBe('ATTEST_USAGE reason=overlay_unreadable\n');
  });

  it('默认导出的命令未注入时钟也能跑;命令零网络:源码不 import llm-exec / backends', async () => {
    expect(command.name).toBe('attest');
    const src = [
      await readText(path.join(REPO_ROOT, 'src/commands/attest.ts')),
      await readText(path.join(REPO_ROOT, 'src/lifecycle/attest-count.ts')),
    ].join('\n');
    expect(src).not.toMatch(/from '[^']*(llm-exec|reflect\/backends)/);
    const w = await newWorld();
    const r = await run(w, ARGS, command);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/run_id=run-\d{8}T\d{6}Z-[0-9a-f]{6}/);
  });
});

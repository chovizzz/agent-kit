/**
 * L6:`retire --rule <id> --to deprecated|retired --reason <码>`(退役 T3–T6)。全合成数据,不联网、不 spawn LLM。
 * 世界 = 一个合成 git 仓库(kit.toml + team 层原子 + attest),HEAD 即被退役的状态。
 * 补丁一律用真 `git apply --check --whitespace=error` 验证,应用后在新树上跑真 `check --guards --label kit:retire`。
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRetireCommand } from '../../src/commands/retire.js';
import { run as guardsRun } from '../../src/commands/guards-cmd.js';
import { LifecycleRecordSchema } from '../../src/contracts/lifecycle.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { createIoContext } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import { exists, lstat, readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { snapshot } from '../fixtures/reflect/world.js';
import { ID, atomText, attestFile, digestOf, kitToml } from '../guards/criteria-world.js';
import type { AtomOpts, AttestOpts } from '../guards/criteria-world.js';
import { makeTestRepo } from '../helpers/make-repo.js';
import type { TestRepo } from '../helpers/make-repo.js';

const RULE = `rules/team/${ID}.md`;
const CLOCK = (): Date => new Date('2026-10-25T08:00:00Z');
const CANARY_BODY = 'CANARY-BODY-TEXT-QQ';
const BODY = `**做**:做某件具体的事 ${CANARY_BODY}。\n**为什么**:因为某个原因。\n**怎么验**:用某种方式验证。\n`;

const repos: TestRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.dispose()));
});

interface WOpts {
  status?: string;
  atom?: AtomOpts;
  attests?: AttestOpts[];
  extra?: Record<string, string | null>;
  rulePath?: string;
  /** 在 HEAD 之前的提交上打 stable-* tag(再补一个提交让 HEAD 不在 tag 上) */
  tagStable?: boolean;
}
interface World {
  repo: TestRepo;
  io: IoContext;
  parent: string;
  state: string;
  atom: string;
}

const ALICE: AttestOpts = { member: '@alice' };
const BOB: AttestOpts = { member: '@bob' };
/** 两个互不重叠的 canary 窗口、曝光 0(no_exposure 的正例) */
const QUIET: AttestOpts[] = [
  { member: '@alice', start: '2026-10-08', end: '2026-10-14', exposure: 0 },
  { member: '@alice', start: '2026-10-15', end: '2026-10-21', exposure: 0 },
];

async function world(o: WOpts = {}): Promise<World> {
  const status = o.status ?? 'active';
  const atom = atomText({ status, body: BODY, ...o.atom });
  const files: Record<string, string | null> = {
    'kit.toml': kitToml(),
    CODEOWNERS: 'rules/** @owner-handle\n',
    [o.rulePath ?? RULE]: atom,
  };
  for (const a of o.attests ?? []) {
    const [p, t] = attestFile(atom, a);
    files[p] = t;
  }
  Object.assign(files, o.extra);
  const repo = await makeTestRepo('retire-');
  repos.push(repo);
  await repo.commit(files, 'head');
  if (o.tagStable === true) {
    repo.tag('stable-2026-10-08', 'HEAD', true);
    await repo.commit({ 'NOTES.md': 'later\n' }, 'later');
  }
  const parent = path.dirname(repo.dir);
  const state = path.join(parent, 'state');
  const io = createIoContext({
    cwd: repo.dir,
    root: repo.dir,
    env: { KIT_TMP: parent, KIT_STATE_DIR: state, PATH: '/usr/bin:/bin' },
  });
  return { repo, io, parent, state, atom };
}

async function retire(w: World, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await createRetireCommand({ now: CLOCK, gitEnv: w.repo.gitEnv }).run({
    argv,
    io: w.io,
    overlayPath: undefined,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, out: out.join(''), err: err.join('') };
}

const DEP = (reason: string, ...more: string[]): string[] => [
  '--rule',
  ID,
  '--to',
  'deprecated',
  '--reason',
  reason,
  ...more,
];
const RET = (reason: string, ...more: string[]): string[] => [
  '--rule',
  ID,
  '--to',
  'retired',
  '--reason',
  reason,
  ...more,
];

async function retireDirs(w: World): Promise<string[]> {
  const root = path.join(w.state, 'retire');
  if (!(await exists(root))) return [];
  return (await readDir(root)).filter((e) => e.isDirectory).map((e) => e.name);
}

async function guards(w: World, base: string, head: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await guardsRun(
    {
      argv: [],
      io: w.io,
      overlayPath: undefined,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    },
    { guards: true, base, head, label: 'kit:retire', report: false },
  );
  return { code, out: out.join(''), err: err.join('') };
}

/** --write → git apply --check → apply → 提交 → check --guards --label kit:retire;返回 [旧 HEAD, 新 HEAD, 退役 id, 写出的目录] */
async function writeApplyGuard(
  w: World,
  argv: string[],
): Promise<{
  base: string;
  head: string;
  id: string;
  dir: string;
  g: Awaited<ReturnType<typeof guards>>;
}> {
  const r = await retire(w, [...argv, '--write', '--json']);
  expect(r.code, r.err + r.out).toBe(0);
  const id = (JSON.parse(r.out) as { retire_id: string }).retire_id;
  const dir = path.join(w.state, 'retire', id);
  const base = w.repo.git(['rev-parse', 'HEAD']).trim();
  w.repo.git(['apply', '--check', '--whitespace=error', path.join(dir, 'retire.patch')]);
  w.repo.git(['apply', '--whitespace=error', path.join(dir, 'retire.patch')]);
  const head = await w.repo.commit({}, 'apply retire');
  const g = await guards(w, base, head);
  return { base, head, id, dir, g };
}

describe('T3/T4 → deprecated(manual)', () => {
  for (const from of ['advisory', 'active'] as const) {
    it(`${from}→deprecated:--write 产物三件套(0700/0600)、补丁只改 status 并新增一条记录、应用后 check --guards --label kit:retire 绿`, async () => {
      const w = await world({ status: from });
      const { dir, g, id } = await writeApplyGuard(w, DEP('manual'));
      expect(g.code, g.out).toBe(0);
      expect(g.out).toMatch(/0 error/);
      expect((await readDir(dir)).map((e) => e.name)).toEqual([
        'pr-body.md',
        'report.json',
        'retire.patch',
      ]);
      expect((await lstat(dir)).mode & 0o777).toBe(0o700);
      for (const n of ['pr-body.md', 'report.json', 'retire.patch']) {
        expect((await lstat(path.join(dir, n))).mode & 0o777).toBe(0o600);
      }
      const patch = await readText(path.join(dir, 'retire.patch'));
      // 原子:只改 status 一行
      const atomPart = patch.slice(patch.indexOf(`diff --git a/${RULE}`));
      expect(atomPart.split('\n').filter((l) => /^[-+][^-+]/.test(l))).toEqual([
        `-status: ${from}`,
        '+status: deprecated',
      ]);
      expect(await readText(path.join(w.repo.dir, RULE))).toBe(
        w.atom.replace(`status: ${from}`, 'status: deprecated'),
      );
      // 记录:过 LifecycleRecordSchema,文件名 = <recorded_at>-<run_id>.json,墓碑目录 = 规则 id
      const recDir = path.join(w.repo.dir, 'lifecycle', ID);
      const names = (await readDir(recDir)).map((e) => e.name);
      expect(names).toHaveLength(1);
      const rec = LifecycleRecordSchema.parse(
        JSON.parse(await readText(path.join(recDir, names[0] as string))),
      );
      expect(rec).toMatchObject({
        rule_id: ID,
        reason: 'manual',
        from_status: from,
        to_status: 'deprecated',
        recorded_at: '2026-10-25',
        owner: '@owner-handle',
        attest_digests: [],
      });
      expect(names[0]).toBe(`2026-10-25-${rec.run_id}.json`);
      expect(rec.run_id).toMatch(/^run-20261025T000000Z-[0-9a-f]{6}$/);
      expect(id).toMatch(/^retire-[0-9a-f]{16}$/);
      // 再跑一次:已是目标状态
      const again = await retire(w, DEP('manual'));
      expect(again.code).toBe(0);
      expect(again.out).toMatch(/^already=1\n/);
    });
  }

  it('反例:advisory/active → retired 不能跳过 deprecated(DIRECTION_NOT_ALLOWED);proposed→deprecated 同样不允许', async () => {
    for (const status of ['advisory', 'active', 'proposed']) {
      const w = await world({ status });
      const to = status === 'proposed' ? DEP('rejected') : RET('manual');
      const r = await retire(w, to);
      expect(r.code, status).toBe(ExitCode.CHECK_FAILED);
      expect(r.err, status).toBe('RETIRE_CHECK_FAILED reason=DIRECTION_NOT_ALLOWED\n');
    }
  });
});

describe('T5 deprecated→retired(⑩A 冷却)', () => {
  it('deprecated 已出现在基线祖先 stable tag 里 → 通过,应用后 guards 绿', async () => {
    const w = await world({ status: 'deprecated', tagStable: true });
    const { g } = await writeApplyGuard(w, RET('manual'));
    expect(g.code, g.out).toBe(0);
    expect(await readText(path.join(w.repo.dir, RULE))).toContain('status: retired');
  });

  it('反例:没有任何 stable tag / tag 在 deprecated 之前 → 退出 1 COOLDOWN_NOT_MET,且不写', async () => {
    const w = await world({ status: 'deprecated' });
    const r = await retire(w, [...RET('manual'), '--write']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toBe('RETIRE_CHECK_FAILED reason=COOLDOWN_NOT_MET\n');
    expect(r.out).toContain('fail G3:COOLDOWN_NOT_MET');
    expect(await retireDirs(w)).toEqual([]);
    // tag 打在原子还是 active 的提交上:冷却仍未满足
    const w2 = await world({ status: 'active' });
    w2.repo.tag('stable-2026-10-08', 'HEAD', true);
    await w2.repo.commit(
      { [RULE]: w2.atom.replace('status: active', 'status: deprecated') },
      'dep',
    );
    const r2 = await retire(w2, RET('manual'));
    expect(r2.err).toBe('RETIRE_CHECK_FAILED reason=COOLDOWN_NOT_MET\n');
  });

  it('no_exposure / harmful 不适用于 retired(REASON_DIRECTION_MISMATCH)', async () => {
    const w = await world({ status: 'deprecated', tagStable: true, attests: QUIET });
    for (const reason of ['no_exposure', 'harmful']) {
      const r = await retire(w, RET(reason));
      expect(r.err, reason).toBe('RETIRE_CHECK_FAILED reason=REASON_DIRECTION_MISMATCH\n');
    }
  });
});

describe('T6 proposed→retired(rejected)', () => {
  it('正例:被否决的 proposed 原子退役,应用后 guards 绿', async () => {
    const w = await world({ status: 'proposed' });
    const { g } = await writeApplyGuard(w, RET('rejected'));
    expect(g.code, g.out).toBe(0);
    expect(await readText(path.join(w.repo.dir, RULE))).toContain('status: retired');
  });

  it('反例:rejected 只配 proposed→retired;proposed→retired 只配 rejected', async () => {
    for (const status of ['advisory', 'active']) {
      const w = await world({ status });
      expect((await retire(w, DEP('rejected'))).err, status).toBe(
        'RETIRE_CHECK_FAILED reason=REASON_DIRECTION_MISMATCH\n',
      );
    }
    const w = await world({ status: 'proposed' });
    for (const reason of ['manual', 'expired']) {
      expect(
        (await retire(w, RET(reason, ...(reason === 'expired' ? ['--today', '2030-01-01'] : []))))
          .err,
      ).toBe('RETIRE_CHECK_FAILED reason=REASON_DIRECTION_MISMATCH\n');
    }
  });
});

describe('六个理由码:各一正一反', () => {
  it('manual:无证据即可(正例见上);expired:review_by < today', async () => {
    const w = await world({ atom: { review_by: '2026-10-20' } });
    // 正例:CLOCK = 2026-10-25 > 2026-10-20
    const ok = await writeApplyGuard(w, DEP('expired'));
    expect(ok.g.code, ok.g.out).toBe(0);
    // 反例:--today 等于 review_by(边界,必须严格小于)与更早
    for (const today of ['2026-10-20', '2026-10-19']) {
      const w2 = await world({ atom: { review_by: '2026-10-20' } });
      const r = await retire(w2, [...DEP('expired'), '--today', today]);
      expect(r.code, today).toBe(ExitCode.CHECK_FAILED);
      expect(r.err, today).toBe('RETIRE_CHECK_FAILED reason=REASON_NOT_EXPIRED\n');
    }
    // --today 比 review_by 晚一天:通过(正向边界)
    const w3 = await world({ atom: { review_by: '2026-10-20' } });
    const edge = await retire(w3, [...DEP('expired'), '--today', '2026-10-21']);
    expect(edge.code, edge.err).toBe(0);
  });

  it('superseded:--by 存在、active、supersedes 含本 id → 通过;缺 --by 退出 2;by 不合格退出 1', async () => {
    const by = atomText({ id: 'newer-rule', status: 'active', supersedes: [ID], body: BODY });
    const w = await world({ extra: { 'rules/team/newer-rule.md': by } });
    const ok = await writeApplyGuard(w, DEP('superseded', '--by', 'newer-rule'));
    expect(ok.g.code, ok.g.out).toBe(0);
    const rec = (await readDir(path.join(w.repo.dir, 'lifecycle', ID)))[0] as { name: string };
    expect(
      JSON.parse(await readText(path.join(w.repo.dir, 'lifecycle', ID, rec.name))),
    ).toMatchObject({ reason: 'superseded', by: 'newer-rule' });

    const noBy = await world();
    const r = await retire(noBy, DEP('superseded'));
    expect(r.code).toBe(ExitCode.USAGE);
    expect(r.err).toBe('RETIRE_USAGE reason=by_required\n');
    expect((await retire(noBy, DEP('manual', '--by', 'x'))).err).toBe(
      'RETIRE_USAGE reason=by_only_superseded\n',
    );

    const bad: [string, Record<string, string | null>][] = [
      ['不存在', {}],
      [
        'status 不是 active',
        {
          'rules/team/newer-rule.md': atomText({
            id: 'newer-rule',
            status: 'advisory',
            supersedes: [ID],
            body: BODY,
          }),
        },
      ],
      [
        'supersedes 不含本 id',
        {
          'rules/team/newer-rule.md': atomText({
            id: 'newer-rule',
            status: 'active',
            supersedes: ['other'],
            body: BODY,
          }),
        },
      ],
    ];
    for (const [name, extra] of bad) {
      const w2 = await world({ extra });
      const x = await retire(w2, DEP('superseded', '--by', 'newer-rule'));
      expect(x.code, name).toBe(ExitCode.CHECK_FAILED);
      expect(x.err, name).toBe('RETIRE_CHECK_FAILED reason=REASON_BY_INVALID\n');
      expect(await retireDirs(w2), name).toEqual([]);
    }
  });

  it('no_exposure:最近 K 个互不重叠 canary 窗口曝光合计 0 → 通过并引用 attest 哈希;有曝光 / 窗口不够 → 退出 1;根本没有 attest → 退出 4', async () => {
    const w = await world({ attests: QUIET });
    const ok = await writeApplyGuard(w, DEP('no_exposure'));
    expect(ok.g.code, ok.g.out).toBe(0);
    const recName = (await readDir(path.join(w.repo.dir, 'lifecycle', ID)))[0] as { name: string };
    const rec = LifecycleRecordSchema.parse(
      JSON.parse(await readText(path.join(w.repo.dir, 'lifecycle', ID, recName.name))),
    );
    const expected = QUIET.map((q) => digestOf(attestFile(w.atom, q)[1])).sort();
    expect(rec.attest_digests).toEqual(expected);

    const exposed = await world({
      attests: [QUIET[0] as AttestOpts, { ...(QUIET[1] as AttestOpts), exposure: 3 }],
    });
    const r1 = await retire(exposed, DEP('no_exposure'));
    expect(r1.code).toBe(ExitCode.CHECK_FAILED);
    expect(r1.err).toBe('RETIRE_CHECK_FAILED reason=REASON_NO_EXPOSURE_UNMET\n');

    const one = await world({ attests: [QUIET[0] as AttestOpts] });
    expect((await retire(one, DEP('no_exposure'))).err).toBe(
      'RETIRE_CHECK_FAILED reason=REASON_NO_EXPOSURE_UNMET\n',
    );

    const none = await world();
    const r4 = await retire(none, [...DEP('no_exposure'), '--write']);
    expect(r4.code).toBe(ExitCode.NOT_RUN);
    expect(r4.err).toBe('RETIRE_NOT_RUN reason=NO_ATTEST_IN_WINDOW\n');
    expect(await retireDirs(none)).toEqual([]);
  });

  it('no_exposure:三个窗口里只有最近 K=2 个参与判据——更早的窗口有曝光不影响通过;引用的 digest 覆盖三份有效 attest', async () => {
    const old: AttestOpts = {
      member: '@alice',
      start: '2026-10-08',
      end: '2026-10-09',
      exposure: 5,
    };
    const mid: AttestOpts = {
      member: '@alice',
      start: '2026-10-10',
      end: '2026-10-15',
      exposure: 0,
    };
    const last: AttestOpts = {
      member: '@alice',
      start: '2026-10-16',
      end: '2026-10-21',
      exposure: 0,
    };
    const w = await world({ attests: [old, mid, last] });
    const r = await retire(w, [...DEP('no_exposure'), '--json']);
    expect(r.code, r.err + r.out).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ attest_files: 3 });
    // 对照:最近两个窗口之一有曝光 → 红
    const bad = await world({ attests: [old, mid, { ...last, exposure: 1 }] });
    expect((await retire(bad, DEP('no_exposure'))).err).toBe(
      'RETIRE_CHECK_FAILED reason=REASON_NO_EXPOSURE_UNMET\n',
    );
  });

  it('harmful:有效 attest 的 harmful>0 → 通过,且只引用计入口径的 attest(无效的被剔除);harmful 全 0 → 退出 1', async () => {
    const stale = { member: '@bob', hash: '0'.repeat(64) }; // 规则哈希对不上 → 不计入
    const w = await world({ attests: [{ ...ALICE, harmful: 2 }, stale] });
    const ok = await writeApplyGuard(w, DEP('harmful'));
    expect(ok.g.code, ok.g.out).toBe(0);
    const recName = (await readDir(path.join(w.repo.dir, 'lifecycle', ID)))[0] as { name: string };
    const rec = LifecycleRecordSchema.parse(
      JSON.parse(await readText(path.join(w.repo.dir, 'lifecycle', ID, recName.name))),
    );
    expect(rec.attest_digests).toEqual([digestOf(attestFile(w.atom, { ...ALICE, harmful: 2 })[1])]);

    const clean = await world({ attests: [ALICE, BOB] });
    const r = await retire(clean, DEP('harmful'));
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toBe('RETIRE_CHECK_FAILED reason=REASON_NOT_HARMFUL\n');
    // 没有任何计入口径的 attest:同样不过(harmful 不走 exit 4)
    const none = await world({ attests: [stale] });
    expect((await retire(none, DEP('harmful'))).code).toBe(ExitCode.CHECK_FAILED);
  });
});

describe('命令面:干跑 / 幂等 / 稳定码 / 不泄漏', () => {
  it('干跑:退出 0、只算不写(前后快照相同)、JSON 键集合固定、文本模式同样只写 stdout', async () => {
    const w = await world();
    const before = await snapshot(w.parent);
    const r = await retire(w, [...DEP('manual'), '--json']);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe('');
    const j = JSON.parse(r.out) as Record<string, unknown>;
    expect(Object.keys(j)).toEqual([
      'already',
      'attest_files',
      'by',
      'dry',
      'existing',
      'from',
      'out_canary_in',
      'out_canary_out',
      'out_stable_in',
      'out_stable_out',
      'patch_sha256',
      'reason',
      'record_path',
      'record_sha256',
      'retire_id',
      'rule_id',
      'rule_sha256',
      'to',
      'wrote',
    ]);
    expect(j).toMatchObject({
      already: false,
      from: 'active',
      to: 'deprecated',
      reason: 'manual',
      by: null,
      dry: true,
      wrote: false,
      existing: false,
      // active 原子退役:离开两个渠道的 out/
      out_canary_out: 1,
      out_stable_out: 1,
    });
    expect(r.out).toBe(canonicalJson(j));
    expect(await snapshot(w.parent)).toBe(before);
    const t = await retire(w, DEP('manual'));
    expect(t.code).toBe(0);
    expect(t.out).toContain('retire_id=retire-');
    expect(await snapshot(w.parent)).toBe(before);
    expect(await retireDirs(w)).toEqual([]);
  });

  it('幂等:同输入两次 --write 产物字节相同、第二次不重写、id 与干跑一致;篡改已有产物 → 退出 3 RETIRE_RUN_EXISTS', async () => {
    const w = await world();
    const a = await retire(w, [...DEP('manual'), '--write', '--json']);
    const id = (JSON.parse(a.out) as { retire_id: string }).retire_id;
    const dir = path.join(w.state, 'retire', id);
    const snap1 = await snapshot(dir);
    const b = await retire(w, [...DEP('manual'), '--write', '--json']);
    expect(b.code, b.err).toBe(0);
    expect(JSON.parse(b.out)).toMatchObject({ retire_id: id, wrote: false, existing: true });
    expect(await snapshot(dir)).toBe(snap1);
    const dry = JSON.parse((await retire(w, [...DEP('manual'), '--json'])).out) as Record<
      string,
      unknown
    >;
    expect(dry['retire_id']).toBe(id);
    // 不同输入(不同理由)→ 不同 id
    const other = JSON.parse(
      (await retire(w, [...DEP('expired'), '--today', '2030-01-01', '--json'])).out,
    ) as Record<string, unknown>;
    expect(other['retire_id']).not.toBe(id);
    await safe.writeFile(w.io, path.join(dir, 'pr-body.md'), 'tampered\n', { mode: 0o600 });
    const c = await retire(w, [...DEP('manual'), '--write']);
    expect(c.code).toBe(ExitCode.FAIL_CLOSED);
    expect(c.err).toBe('RETIRE_FAIL_CLOSED reason=RETIRE_RUN_EXISTS\n');
    expect(await readText(path.join(dir, 'pr-body.md'))).toBe('tampered\n');
  });

  it('产物目录里多出任何条目(文件 / 符号链接)→ 退出 3,不报「已存在且一致」', async () => {
    const w = await world();
    const a = await retire(w, [...DEP('manual'), '--write', '--json']);
    const dir = path.join(
      w.state,
      'retire',
      (JSON.parse(a.out) as { retire_id: string }).retire_id,
    );
    await safe.writeFile(w.io, path.join(dir, 'extra.json'), '{}\n', { mode: 0o600 });
    const b = await retire(w, [...DEP('manual'), '--write']);
    expect(b.code).toBe(ExitCode.FAIL_CLOSED);
    expect(b.err).toBe('RETIRE_FAIL_CLOSED reason=RETIRE_RUN_EXISTS\n');
  });

  it('目标原子不变但 out/ 清单随配置变了 → 新 retire_id(不撞旧产物、不报假的 RETIRE_RUN_EXISTS),record / patch 里的 run_id 不变', async () => {
    const w = await world();
    const a = JSON.parse((await retire(w, [...DEP('manual'), '--write', '--json'])).out) as {
      retire_id: string;
      record_path: string;
      patch_sha256: string;
    };
    await w.repo.commit({ 'kit.toml': kitToml().replace(', "kimi"', '') }, 'drop an agent');
    const b = await retire(w, [...DEP('manual'), '--write', '--json']);
    expect(b.code, b.err).toBe(0);
    const j = JSON.parse(b.out) as typeof a & { wrote: boolean };
    expect(j.wrote).toBe(true);
    expect(j.retire_id).not.toBe(a.retire_id);
    expect(j.record_path).toBe(a.record_path);
    expect(j.patch_sha256).toBe(a.patch_sha256);
  });

  it('已有产物权限被放宽 → 退出 3(不静默报已存在)', async () => {
    const w = await world();
    const a = await retire(w, [...DEP('manual'), '--write', '--json']);
    const dir = path.join(
      w.state,
      'retire',
      (JSON.parse(a.out) as { retire_id: string }).retire_id,
    );
    await safe.chmod(w.io, path.join(dir, 'retire.patch'), 0o644);
    const b = await retire(w, [...DEP('manual'), '--write']);
    expect(b.code).toBe(ExitCode.FAIL_CLOSED);
    expect(b.err).toBe('RETIRE_FAIL_CLOSED reason=state_perm_unsafe\n');
  });

  it('输出不泄漏正文:stdout、stderr、pr-body、report 都不含 canary(正向控制:原子里确有)', async () => {
    const w = await world();
    const r = await retire(w, [...DEP('manual'), '--write']);
    expect(r.code).toBe(0);
    const [id] = await retireDirs(w);
    const dir = path.join(w.state, 'retire', id as string);
    for (const t of [
      r.out,
      r.err,
      await readText(path.join(dir, 'pr-body.md')),
      await readText(path.join(dir, 'report.json')),
    ]) {
      expect(t).not.toContain(CANARY_BODY);
    }
    expect(w.atom).toContain(CANARY_BODY);
    const body = await readText(path.join(dir, 'pr-body.md'));
    expect(body).toContain('kit:retire');
    expect(body).toContain(ID);
    expect(body).toContain('out/ 进出清单');
  });

  it('PROMOTE_WORKTREE_DIRTY:工作树与 HEAD 不同(改动 / 删除 / 符号链接)→ 退出 1,且不写', async () => {
    const w = await world();
    const file = path.join(w.repo.dir, RULE);
    await safe.writeFile(w.io, file, `${w.atom}\n`);
    let r = await retire(w, [...DEP('manual'), '--write']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toBe('RETIRE_CHECK_FAILED reason=PROMOTE_WORKTREE_DIRTY\n');
    await safe.remove(w.io, file);
    r = await retire(w, DEP('manual'));
    expect(r.err).toBe('RETIRE_CHECK_FAILED reason=PROMOTE_WORKTREE_DIRTY\n');
    await safe.symlink(w.io, path.join(w.repo.dir, 'kit.toml'), file);
    r = await retire(w, DEP('manual'));
    expect(r.err).toBe('RETIRE_CHECK_FAILED reason=PROMOTE_WORKTREE_DIRTY\n');
    expect(await retireDirs(w)).toEqual([]);
  });

  it('层:personal / org / project → 退出 2(稳定码,与 promote 一致)', async () => {
    for (const [dir, reason] of [
      ['personal', 'PERSONAL_LAYER_P2'],
      ['org', 'ORG_LAYER_NOT_PROMOTABLE'],
      ['project', 'LAYER_NOT_PROMOTABLE'],
    ] as const) {
      const w = await world({ rulePath: `rules/${dir}/${ID}.md` });
      const r = await retire(w, DEP('manual'));
      expect(r.code, dir).toBe(ExitCode.USAGE);
      expect(r.err, dir).toBe(`RETIRE_USAGE reason=${reason}\n`);
    }
  });

  it('规则不存在 → 退出 1;用法错误 → 退出 2 且零输出到 .state', async () => {
    const w = await world();
    expect(
      (await retire(w, ['--rule', 'nope', '--to', 'deprecated', '--reason', 'manual'])).err,
    ).toBe('RETIRE_CHECK_FAILED reason=RULE_NOT_FOUND\n');
    const cases: [string[], string][] = [
      [[], 'rule_required'],
      [['--rule', ID, '--to', 'active', '--reason', 'manual'], 'bad_to'],
      [['--rule', ID, '--to', 'retired', '--reason', 'whatever'], 'bad_reason'],
      [['--rule', ID, '--to', 'retired'], 'bad_reason'],
      [[...DEP('manual'), '--today', '2026-13-40'], 'bad_today'],
      [[...DEP('manual'), '--run-llm'], 'no_egress_flags'],
      [[...DEP('manual'), '--allow-egress'], 'no_egress_flags'],
      [[...DEP('manual'), '--allow-egress=true'], 'no_egress_flags'],
      [[...DEP('manual'), '--run-llm=true'], 'no_egress_flags'],
      [[...DEP('manual'), '--bogus'], 'unknown_arg'],
      [[...DEP('superseded', '--by', ID)], 'by_is_self'],
    ];
    for (const [argv, reason] of cases) {
      const r = await retire(w, argv);
      expect(r.code, argv.join(' ')).toBe(ExitCode.USAGE);
      expect(r.err, argv.join(' ')).toBe(`RETIRE_USAGE reason=${reason}\n`);
    }
    expect(await retireDirs(w)).toEqual([]);
  });

  it('补丁结果仍是干净的:rules/ 与 lifecycle/ 在 --write 之后字节不变(只写 .state)', async () => {
    const w = await world();
    const before = await snapshot(w.repo.dir);
    const r = await retire(w, [...DEP('manual'), '--write']);
    expect(r.code).toBe(0);
    expect(await snapshot(w.repo.dir)).toBe(before);
    expect(await exists(path.join(w.repo.dir, 'lifecycle'))).toBe(false);
  });
});

describe('out/ 进出清单:被压住的原子复活', () => {
  const OVERRIDER = 'better-rule';
  const withOverrides = (text: string): string =>
    text.replace('\nverifier:', `\noverrides: [soft-rule]\nverifier:`);
  const SOFT = atomText({ id: 'soft-rule', layer: 'org', status: 'active', body: BODY });

  it('team 原子 overrides 一条 org 原子;退役它之后,被压住的 org 原子回到 out/,pr-body 列出', async () => {
    const better = withOverrides(atomText({ id: OVERRIDER, status: 'active', body: BODY }));
    expect(better).toContain('overrides: [soft-rule]');
    const w = await world({
      extra: { [`rules/team/${OVERRIDER}.md`]: better, 'rules/org/soft-rule.md': SOFT },
      status: 'proposed', // 世界里的 sample-atom 不参与本用例
    });
    const r = await retire(w, [
      '--rule',
      OVERRIDER,
      '--to',
      'deprecated',
      '--reason',
      'manual',
      '--write',
      '--json',
    ]);
    expect(r.code, r.err + r.out).toBe(0);
    const j = JSON.parse(r.out) as Record<string, number | string>;
    // 正向控制:声明者自己离开 out/(canary 与 stable 各 1),被压住的 org 原子各进入 1
    expect(j['out_canary_out']).toBe(1);
    expect(j['out_canary_in']).toBe(1);
    expect(j['out_stable_in']).toBe(1);
    const dir = path.join(w.state, 'retire', j['retire_id'] as string);
    const body = await readText(path.join(dir, 'pr-body.md'));
    expect(body).toContain('进入 out/ 的原子(含被压住而复活的):soft-rule');
    expect(body).toContain(`离开 out/ 的原子:${OVERRIDER}`);
    const report = JSON.parse(await readText(path.join(dir, 'report.json'))) as {
      out_diff: { channel: string; atomsIn: string[]; atomsOut: string[] }[];
    };
    expect(report.out_diff.find((c) => c.channel === 'stable')?.atomsIn).toEqual(['soft-rule']);
    // 对照:没有 overrides 的普通 active 原子,退役时没有任何原子复活
    const plain = await world();
    const pj = JSON.parse((await retire(plain, [...DEP('manual'), '--json'])).out) as Record<
      string,
      number
    >;
    expect(pj['out_canary_in']).toBe(0);
    expect(pj['out_stable_in']).toBe(0);
  });
});

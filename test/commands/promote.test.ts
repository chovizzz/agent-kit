/**
 * L4:`promote --rule <id> --to advisory|active`(晋升 T1/T2)。全合成数据,不联网、不 spawn LLM。
 * 世界 = 一个合成 git 仓库(kit.toml + team 层原子 + 提案 + attest),HEAD 即被晋升的状态。
 * 补丁一律用真 `git apply --check --whitespace=error` 验证,应用后在新树上跑真 `check --guards --label kit:promotion`。
 */
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPromoteCommand } from '../../src/commands/promote.js';
import { run as guardsRun } from '../../src/commands/guards-cmd.js';
import { ExitCode } from '../../src/contracts/exit-codes.js';
import { canonicalJson } from '../../src/io/canonical-json.js';
import { createIoContext } from '../../src/io/paths.js';
import type { IoContext } from '../../src/io/paths.js';
import { exists, lstat, readDir, readText } from '../../src/io/read-fs.js';
import * as safe from '../../src/io/safe-fs.js';
import { SYNTH_HEAD, nextReviewBy, overlayGit } from '../../src/lifecycle/promote-rule.js';
import type { GuardGit } from '../../src/guards/types.js';
import { gitBlobOid } from '../../src/reflect/stage.js';
import { snapshot } from '../fixtures/reflect/world.js';
import {
  ID,
  PROPOSAL_PATH,
  atomText,
  attestFile,
  kitToml,
  proposalYaml,
} from '../guards/criteria-world.js';
import type { AtomOpts, AttestOpts, ProposalOpts } from '../guards/criteria-world.js';
import { makeTestRepo } from '../helpers/make-repo.js';
import type { TestRepo } from '../helpers/make-repo.js';

const RULE = `rules/team/${ID}.md`;
const CLOCK = (): Date => new Date('2026-10-25T08:00:00Z');
const CANARY_BODY = 'CANARY-BODY-TEXT-QQ';
const CANARY_RATIONALE = 'CANARY-RATIONALE-QQ';
const BODY = `**做**:做某件具体的事 ${CANARY_BODY}。\n**为什么**:因为某个原因。\n**怎么验**:用某种方式验证。\n`;

const repos: TestRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.dispose()));
});

interface WOpts {
  status?: string;
  atom?: AtomOpts;
  proposal?: ProposalOpts;
  attests?: AttestOpts[];
  extra?: Record<string, string | null>;
  kit?: string;
  rulePath?: string;
  noProposal?: boolean;
  proposalText?: string;
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

async function world(o: WOpts = {}): Promise<World> {
  const status = o.status ?? 'proposed';
  const atom = atomText({ status, body: BODY, ...o.atom });
  const files: Record<string, string | null> = {
    'kit.toml': o.kit ?? kitToml(),
    CODEOWNERS: 'rules/** @owner-handle\n',
    [o.rulePath ?? RULE]: atom,
  };
  if (o.noProposal !== true) {
    files[PROPOSAL_PATH] =
      o.proposalText ??
      // L2 世界的 judge.provider 是厂商名;真实 judge 写的是最后一跳的槽位 id(C5 要求二者相等),这里对齐真实形态
      proposalYaml(atom, { rationale: `理由 ${CANARY_RATIONALE}`, ...o.proposal }).replace(
        'provider: openai',
        'provider: codex',
      );
  }
  for (const a of o.attests ?? []) {
    const [p, t] = attestFile(atom, a);
    files[p] = t;
  }
  Object.assign(files, o.extra);
  const repo = await makeTestRepo('promote-');
  repos.push(repo);
  await repo.commit(files, 'head');
  const parent = path.dirname(repo.dir);
  const state = path.join(parent, 'state');
  const io = createIoContext({
    cwd: repo.dir,
    root: repo.dir,
    env: { KIT_TMP: parent, KIT_STATE_DIR: state, PATH: '/usr/bin:/bin' },
  });
  return { repo, io, parent, state, atom };
}

async function promote(w: World, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await createPromoteCommand({ now: CLOCK, gitEnv: w.repo.gitEnv }).run({
    argv,
    io: w.io,
    overlayPath: undefined,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, out: out.join(''), err: err.join('') };
}

const TO_ADV = ['--rule', ID, '--to', 'advisory'];
const TO_ACT = ['--rule', ID, '--to', 'active'];
const T2_OK: Partial<WOpts> = { status: 'advisory', attests: [ALICE, BOB] };

async function promoDirs(w: World): Promise<string[]> {
  const root = path.join(w.state, 'promote');
  if (!(await exists(root))) return [];
  return (await readDir(root)).filter((e) => e.isDirectory).map((e) => e.name);
}

/** 应用 promote.patch(真 git apply)并提交,返回 [旧 HEAD, 新 HEAD] */
async function applyAndCommit(w: World, dir: string): Promise<[string, string]> {
  const before = w.repo.git(['rev-parse', 'HEAD']).trim();
  w.repo.git(['apply', '--check', '--whitespace=error', path.join(dir, 'promote.patch')]);
  w.repo.git(['apply', '--whitespace=error', path.join(dir, 'promote.patch')]);
  await w.repo.commit({}, 'apply promotion');
  return [before, w.repo.git(['rev-parse', 'HEAD']).trim()];
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
    { guards: true, base, head, label: 'kit:promotion', report: false },
  );
  return { code, out: out.join(''), err: err.join('') };
}

describe('产物目录多出条目', () => {
  it('promote --write:已有产物目录里多出文件 → 退出 3 PROMOTE_RUN_EXISTS', async () => {
    const w = await world();
    const a = await promote(w, [...TO_ADV, '--write', '--json']);
    const dir = path.join(w.state, 'promote', (JSON.parse(a.out) as { promo_id: string }).promo_id);
    await safe.writeFile(w.io, path.join(dir, 'extra.json'), '{}\n', { mode: 0o600 });
    const b = await promote(w, [...TO_ADV, '--write']);
    expect(b.code).toBe(ExitCode.FAIL_CLOSED);
    expect(b.err).toBe('PROMOTE_FAIL_CLOSED reason=PROMOTE_RUN_EXISTS\n');
  });
});

describe('墓碑参与晋升的 C7', () => {
  it('id 在 lifecycle/<id>/ 下有记录(墓碑)→ 晋升被 C7:ID_TOMBSTONED 拒,不写;无墓碑时同一世界通过', async () => {
    const ok = await world();
    expect((await promote(ok, TO_ADV)).code).toBe(0);
    const w = await world({
      extra: { [`lifecycle/${ID}/2026-10-09-run-20261009T000000Z-bbbbbb.json`]: '{}\n' },
    });
    const r = await promote(w, [...TO_ADV, '--write']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.out).toContain('fail C7:ID_TOMBSTONED');
    expect(await promoDirs(w)).toEqual([]);
  });
});

describe('T1 proposed→advisory', () => {
  it('干跑:退出 0、只算不写(前后快照相同)、JSON 键集合固定', async () => {
    const w = await world();
    const before = await snapshot(w.parent);
    const r = await promote(w, [...TO_ADV, '--json']);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe('');
    const j = JSON.parse(r.out) as Record<string, unknown>;
    expect(Object.keys(j)).toEqual([
      'already',
      'attest_files',
      'dry',
      'existing',
      'from',
      'out_canary_in',
      'out_canary_out',
      'out_stable_in',
      'out_stable_out',
      'patch_sha256',
      'promo_id',
      'review_by_new',
      'rule_id',
      'rule_sha256',
      'to',
      'wrote',
    ]);
    expect(j).toMatchObject({
      already: false,
      from: 'proposed',
      to: 'advisory',
      dry: true,
      wrote: false,
      review_by_new: null,
      out_canary_in: 1,
      out_stable_in: 0,
    });
    expect(r.out).toBe(canonicalJson(j));
    expect(await snapshot(w.parent)).toBe(before);
    // 文本模式同样只写 stdout
    const t = await promote(w, TO_ADV);
    expect(t.code).toBe(0);
    expect(t.out).toContain('promo_id=promo-');
    expect(await snapshot(w.parent)).toBe(before);
  });

  it('--write:产物三件套(0700/0600)+ git apply --check 通过 + 应用后 check --guards --label kit:promotion 绿', async () => {
    const w = await world();
    const r = await promote(w, [...TO_ADV, '--write', '--json']);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { promo_id: string; wrote: boolean };
    expect(j.wrote).toBe(true);
    const dir = path.join(w.state, 'promote', j.promo_id);
    expect((await readDir(dir)).map((e) => e.name)).toEqual([
      'pr-body.md',
      'promote.patch',
      'report.json',
    ]);
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    for (const n of ['pr-body.md', 'promote.patch', 'report.json']) {
      expect((await lstat(path.join(dir, n))).mode & 0o777).toBe(0o600);
    }
    const patch = await readText(path.join(dir, 'promote.patch'));
    // 只改 status 一行
    expect(patch.split('\n').filter((l) => /^[-+][^-+]/.test(l))).toEqual([
      '-status: proposed',
      '+status: advisory',
    ]);
    // index 行写 HEAD blob oid
    expect(patch).toContain(`index ${gitBlobOid(w.atom).slice(0, 12)}..`);
    expect(w.repo.git(['rev-parse', `HEAD:${RULE}`]).trim()).toBe(gitBlobOid(w.atom));
    const [base, head] = await applyAndCommit(w, dir);
    const g = await guards(w, base, head);
    expect(g.code, g.out).toBe(0);
    expect(g.out).toMatch(/0 error/);
    // 应用后的规则文件与原文只差 status 行
    const after = await readText(path.join(w.repo.dir, RULE));
    expect(after).toBe(w.atom.replace('status: proposed', 'status: advisory'));
    // 再跑一次:已是目标状态 → already=1,退出 0
    const again = await promote(w, TO_ADV);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/^already=1\n/);
  });

  it('幂等:同输入两次 --write 产物字节相同、第二次不重写;已有产物被改动 → 退出 3 PROMOTE_RUN_EXISTS', async () => {
    const w = await world();
    const a = await promote(w, [...TO_ADV, '--write', '--json']);
    const id = (JSON.parse(a.out) as { promo_id: string }).promo_id;
    const dir = path.join(w.state, 'promote', id);
    const snap1 = await snapshot(dir);
    const b = await promote(w, [...TO_ADV, '--write', '--json']);
    expect(b.code, b.err).toBe(0);
    expect(JSON.parse(b.out)).toMatchObject({ promo_id: id, wrote: false, existing: true });
    expect(await snapshot(dir)).toBe(snap1);
    // 干跑与写盘的 promo_id、哈希一致
    const dry = JSON.parse((await promote(w, [...TO_ADV, '--json'])).out) as Record<
      string,
      unknown
    >;
    expect(dry['promo_id']).toBe(id);
    // 篡改已有产物 → 不覆盖,退出 3
    await safe.writeFile(w.io, path.join(dir, 'pr-body.md'), 'tampered\n', { mode: 0o600 });
    const c = await promote(w, [...TO_ADV, '--write']);
    expect(c.code).toBe(ExitCode.FAIL_CLOSED);
    expect(c.err).toBe('PROMOTE_FAIL_CLOSED reason=PROMOTE_RUN_EXISTS\n');
    expect(await readText(path.join(dir, 'pr-body.md'))).toBe('tampered\n');
  });

  it('输出不泄漏正文 / 理由摘录:stdout、stderr、pr-body、report、补丁以外的产物都不含 canary', async () => {
    const w = await world();
    const r = await promote(w, [...TO_ADV, '--write']);
    expect(r.code).toBe(0);
    const [id] = await promoDirs(w);
    const dir = path.join(w.state, 'promote', id as string);
    for (const t of [
      r.out,
      r.err,
      await readText(path.join(dir, 'pr-body.md')),
      await readText(path.join(dir, 'report.json')),
    ]) {
      expect(t).not.toContain(CANARY_BODY);
      expect(t).not.toContain(CANARY_RATIONALE);
    }
    // 正向控制组:canary 确实在原子 / 提案里
    expect(w.atom).toContain(CANARY_BODY);
    const body = await readText(path.join(dir, 'pr-body.md'));
    expect(body).toContain('kit:promotion');
    expect(body).toContain(ID);
  });

  it('PROMOTE_WORKTREE_DIRTY:工作树与 HEAD 不同(改动 / 删除 / 符号链接)→ 退出 1,且不写', async () => {
    const w = await world();
    const file = path.join(w.repo.dir, RULE);
    await safe.writeFile(w.io, file, `${w.atom}\n`);
    let r = await promote(w, [...TO_ADV, '--write']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toBe('PROMOTE_CHECK_FAILED reason=PROMOTE_WORKTREE_DIRTY\n');
    await safe.remove(w.io, file);
    r = await promote(w, TO_ADV);
    expect(r.err).toBe('PROMOTE_CHECK_FAILED reason=PROMOTE_WORKTREE_DIRTY\n');
    await safe.symlink(w.io, path.join(w.repo.dir, 'kit.toml'), file);
    r = await promote(w, TO_ADV);
    expect(r.err).toBe('PROMOTE_CHECK_FAILED reason=PROMOTE_WORKTREE_DIRTY\n');
    expect(await promoDirs(w)).toEqual([]);
  });

  it('层:personal / org / project → 退出 2(稳定码);team 以外都不可晋升', async () => {
    for (const [dir, reason] of [
      ['personal', 'PERSONAL_LAYER_P2'],
      ['org', 'ORG_LAYER_NOT_PROMOTABLE'],
      ['project', 'LAYER_NOT_PROMOTABLE'],
    ] as const) {
      const w = await world({ rulePath: `rules/${dir}/${ID}.md` });
      const r = await promote(w, TO_ADV);
      expect(r.code, dir).toBe(ExitCode.USAGE);
      expect(r.err, dir).toBe(`PROMOTE_USAGE reason=${reason}\n`);
    }
  });

  it('规则不存在 / 没有 origin / 提案文件缺失 → 退出 1', async () => {
    const w = await world();
    expect((await promote(w, ['--rule', 'no-such-rule', '--to', 'advisory'])).err).toBe(
      'PROMOTE_CHECK_FAILED reason=RULE_NOT_FOUND\n',
    );
    const noOrigin = await world({ atom: { origin: null } });
    expect((await promote(noOrigin, TO_ADV)).err).toBe(
      'PROMOTE_CHECK_FAILED reason=PROPOSAL_MISSING\n',
    );
    const noFile = await world({ noProposal: true });
    expect((await promote(noFile, TO_ADV)).err).toBe(
      'PROMOTE_CHECK_FAILED reason=PROPOSAL_MISSING\n',
    );
  });

  it('方向:proposed→active、active→advisory 不在白名单 → 退出 1', async () => {
    const w = await world();
    const r = await promote(w, TO_ACT);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toBe('PROMOTE_CHECK_FAILED reason=DIRECTION_NOT_ALLOWED\n');
    const act = await world({ status: 'active' });
    expect((await promote(act, TO_ADV)).err).toBe(
      'PROMOTE_CHECK_FAILED reason=DIRECTION_NOT_ALLOWED\n',
    );
    expect((await promote(act, TO_ACT)).out).toMatch(/^already=1\n/);
  });

  it('判据红则不写:judge 缺失 / 不是 accept / 注入 / 哈希不符 / 话术 / 固定字段', async () => {
    const cases: [string, WOpts, string][] = [
      ['judge 缺失', { proposal: { noJudge: true } }, 'G3:JUDGE_MISSING'],
      ['verdict', { proposal: { verdict: 'reject' } }, 'G3:JUDGE_NOT_ACCEPT'],
      ['injection', { proposal: { injection: true } }, 'C1:JUDGE_INJECTION_SUSPECTED'],
      ['哈希不符', { proposal: { hash: 'a'.repeat(64) } }, 'G3:RULE_HASH_MISMATCH'],
      [
        '话术',
        { atom: { body: '**做**:开启 danger-full-access。\n**为什么**:a。\n**怎么验**:b。\n' } },
        'C1:DANGEROUS_PHRASE',
      ],
      ['verifier', { atom: { verifierNone: false } }, 'C3:VERIFIER_NOT_NONE'],
    ];
    for (const [name, o, code] of cases) {
      const w = await world(o);
      const before = await snapshot(w.parent);
      const r = await promote(w, [...TO_ADV, '--write']);
      expect(r.code, name).toBe(ExitCode.CHECK_FAILED);
      expect(r.out, name).toContain(`fail ${code}`);
      expect(r.err, name).toBe('PROMOTE_CHECK_FAILED reason=criteria_failed\n');
      expect(await snapshot(w.parent), name).toBe(before);
    }
  });

  it('judge 只有 judge_attempts:冷却 → 退出 4;其它挂起原因 → 退出 1', async () => {
    const atom = atomText({ status: 'proposed', body: BODY });
    const base = proposalYaml(atom, { attempts: true });
    const cool = await world({
      proposalText: base.replace('error:not_configured', 'skipped:cooldown'),
    });
    const rc = await promote(cool, TO_ADV);
    expect(rc.code).toBe(ExitCode.NOT_RUN);
    expect(rc.err).toBe('PROMOTE_NOT_RUN reason=judge_pending:cooldown\n');
    const hard = await world({ proposalText: base });
    const rh = await promote(hard, TO_ADV);
    expect(rh.code).toBe(ExitCode.CHECK_FAILED);
    expect(rh.out).toContain('fail G3:JUDGE_PENDING');
  });
});

describe('T2 advisory→active', () => {
  it('绿:补丁改 status + review_by 两行;git apply --check 通过;应用后 check --guards 绿', async () => {
    const w = await world(T2_OK);
    const r = await promote(w, [...TO_ACT, '--write', '--json']);
    expect(r.code, r.out + r.err).toBe(0);
    const j = JSON.parse(r.out) as {
      promo_id: string;
      review_by_new: string;
      attest_files: number;
    };
    expect(j.review_by_new).toBe('2027-01-23'); // 2026-10-25 + 90 天(< created+180)
    expect(j.attest_files).toBe(2);
    const dir = path.join(w.state, 'promote', j.promo_id);
    const patch = await readText(path.join(dir, 'promote.patch'));
    expect(patch.split('\n').filter((l) => /^[-+][^-+]/.test(l))).toEqual([
      '-status: advisory',
      '+status: active',
      '-review_by: 2027-01-08',
      '+review_by: 2027-01-23',
    ]);
    const [base, head] = await applyAndCommit(w, dir);
    const g = await guards(w, base, head);
    expect(g.code, g.out).toBe(0);
    const after = await readText(path.join(w.repo.dir, RULE));
    expect(after).toBe(
      w.atom
        .replace('status: advisory', 'status: active')
        .replace('review_by: 2027-01-08', 'review_by: 2027-01-23'),
    );
  });

  it('--today 缺省取注入时钟的 UTC 日期;显式给了就用显式的', async () => {
    const w = await world(T2_OK);
    const d = JSON.parse((await promote(w, [...TO_ACT, '--json'])).out) as {
      review_by_new: string;
    };
    const e = JSON.parse(
      (await promote(w, [...TO_ACT, '--today', '2026-10-25', '--json'])).out,
    ) as {
      review_by_new: string;
    };
    expect(d.review_by_new).toBe(e.review_by_new);
    const f = JSON.parse(
      (await promote(w, [...TO_ACT, '--today', '2026-11-01', '--json'])).out,
    ) as {
      review_by_new: string;
    };
    expect(f.review_by_new).toBe('2027-01-30');
  });

  it('review_by 新值上限取 lint 的 created+180:today 太晚 → REVIEW_BY_UNREACHABLE', async () => {
    const w = await world(T2_OK);
    const near = JSON.parse(
      (await promote(w, [...TO_ACT, '--today', '2027-03-01', '--json'])).out,
    ) as {
      review_by_new: string;
    };
    expect(near.review_by_new).toBe('2027-04-06'); // created 2026-10-08 + 180
    const r = await promote(w, [...TO_ACT, '--today', '2027-05-01']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toBe('PROMOTE_CHECK_FAILED reason=REVIEW_BY_UNREACHABLE\n');
  });

  it('--today 早于 created 太多 → review_by 会早于 created(lint 会拒)→ REVIEW_BY_UNREACHABLE', async () => {
    const w = await world(T2_OK);
    const r = await promote(w, [...TO_ACT, '--today', '2026-01-01']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.err).toBe('PROMOTE_CHECK_FAILED reason=REVIEW_BY_UNREACHABLE\n');
  });

  it('attest 判据红(L2 原因码):窗口不足 / 成员不足 / 曝光不足 / harmful / 成员不在名单 / 窗口早于 advisory', async () => {
    const short = { start: '2026-10-08', end: '2026-10-14' };
    const cases: [string, WOpts, string][] = [
      [
        '窗口',
        {
          attests: [
            { ...ALICE, ...short },
            { ...BOB, ...short },
          ],
        },
        'G3:THRESHOLD_WINDOW_DAYS',
      ],
      ['成员数', { attests: [{ ...ALICE, exposure: 12 }] }, 'G3:THRESHOLD_MEMBERS'],
      [
        '曝光',
        {
          attests: [
            { ...ALICE, exposure: 2 },
            { ...BOB, exposure: 2 },
          ],
        },
        'G3:THRESHOLD_EXPOSURE',
      ],
      ['harmful', { attests: [ALICE, { ...BOB, harmful: 1 }] }, 'G3:THRESHOLD_HARMFUL'],
      ['不在名单', { kit: kitToml({ members: ['@alice'] }) }, 'G3:THRESHOLD_MEMBERS'],
      [
        '早于 advisory',
        {
          attests: [
            { ...ALICE, start: '2026-09-01', end: '2026-09-15' },
            { ...BOB, start: '2026-09-01', end: '2026-09-15' },
          ],
        },
        'G3:THRESHOLD_WINDOW_DAYS',
      ],
      ['没有 attest', { attests: [] }, 'G3:THRESHOLD_WINDOW_DAYS'],
    ];
    for (const [name, o, code] of cases) {
      const w = await world({ ...T2_OK, ...o });
      const before = await snapshot(w.parent);
      const r = await promote(w, [...TO_ACT, '--write']);
      expect(r.code, name).toBe(ExitCode.CHECK_FAILED);
      expect(r.out, name).toContain(`fail ${code}`);
      expect(await snapshot(w.parent), name).toBe(before);
    }
  });

  it('无 signature 的 advisory 原子:退出 1 + 稳定码 SIGNATURE_MISSING + 两步流程提示', async () => {
    const w = await world({ ...T2_OK, atom: { signature: false } });
    const r = await promote(w, [...TO_ACT, '--write']);
    expect(r.code).toBe(ExitCode.CHECK_FAILED);
    expect(r.out).toContain('fail G3:SIGNATURE_MISSING');
    expect(r.err).toContain(
      'PROMOTE_CHECK_FAILED reason=SIGNATURE_MISSING hint=add_signature_via_content_pr_then_rerun_judge_then_open_promotion_pr\n',
    );
    expect(await promoDirs(w)).toEqual([]);
  });

  it('promo_id 含 attest 文件哈希:多一份 attest(其余同输入)→ 不同 id', async () => {
    const a = await world(T2_OK);
    const b = await world({
      ...T2_OK,
      attests: [
        ALICE,
        BOB,
        { ...ALICE, start: '2026-10-23', end: '2026-10-24', run: 'run-20261025T000000Z-bbbbbb' },
      ],
    });
    const ja = JSON.parse((await promote(a, [...TO_ACT, '--json'])).out) as { promo_id: string };
    const jb = JSON.parse((await promote(b, [...TO_ACT, '--json'])).out) as { promo_id: string };
    expect(ja.promo_id).not.toBe(jb.promo_id);
    // 同输入(新建一个一模一样的世界)→ 同 id:id 由内容决定
    const a2 = await world(T2_OK);
    const ja2 = JSON.parse((await promote(a2, [...TO_ACT, '--json'])).out) as { promo_id: string };
    expect(ja2.promo_id).toBe(ja.promo_id);
  });
});

describe('产物目录:与 L3 采纳的 id 不冲突', () => {
  it('同目录并存、各自幂等;同名但内容不同(L3 的 kind=adopt 报告)→ 退出 3 且不动', async () => {
    const w = await world();
    const l3 = path.join(w.state, 'promote', 'promo-0000000000000000');
    for (const n of ['promote.patch', 'pr-body.md', 'report.json']) {
      await safe.mkdirp(w.io, l3, 0o700);
      await safe.writeFile(w.io, path.join(l3, n), `adopt ${n}\n`, { mode: 0o600 });
    }
    const a = await promote(w, [...TO_ADV, '--write', '--json']);
    expect(a.code, a.err).toBe(0);
    const id = (JSON.parse(a.out) as { promo_id: string }).promo_id;
    expect(id).not.toBe('promo-0000000000000000');
    expect((await promoDirs(w)).sort()).toEqual([id, 'promo-0000000000000000'].sort());
    expect((await promote(w, [...TO_ADV, '--write'])).code).toBe(0);
    // 假设 L3 的目录恰好占了同一个名字:内容不同 → 拒绝覆盖
    const clash = path.join(w.state, 'promote', id);
    const report = await readText(path.join(clash, 'report.json'));
    expect(report).toContain('"kind": "promote_rule"');
    await safe.writeFile(w.io, path.join(clash, 'report.json'), '{"kind":"adopt"}\n', {
      mode: 0o600,
    });
    const c = await promote(w, [...TO_ADV, '--write']);
    expect(c.code).toBe(ExitCode.FAIL_CLOSED);
    expect(c.err).toBe('PROMOTE_FAIL_CLOSED reason=PROMOTE_RUN_EXISTS\n');
  });
});

describe('out/ 进出清单', () => {
  const OTHER = 'other-active';
  const otherAtom = atomText({
    id: OTHER,
    status: 'active',
    body: '**做**:完全无关的另一件事。\n**为什么**:另一个原因。\n**怎么验**:另一种验证。\n',
  });

  async function outOf(w: World, argv: string[]) {
    const r = await promote(w, [...argv, '--write', '--json']);
    expect(r.code, r.out + r.err).toBe(0);
    const id = (JSON.parse(r.out) as { promo_id: string }).promo_id;
    const rep = JSON.parse(await readText(path.join(w.state, 'promote', id, 'report.json'))) as {
      out_diff: {
        channel: string;
        atomsIn: string[];
        atomsOut: string[];
        filesAdded: string[];
        filesChanged: string[];
      }[];
    };
    return { rep, body: await readText(path.join(w.state, 'promote', id, 'pr-body.md')) };
  }

  it('T1:advisory 只进 canary 渠道;仓库里本来就 active 的原子不出现在清单里(base 参与计算)', async () => {
    const w = await world({ extra: { [`rules/team/${OTHER}.md`]: otherAtom } });
    const { rep, body } = await outOf(w, TO_ADV);
    const canary = rep.out_diff.find((c) => c.channel === 'canary');
    const stable = rep.out_diff.find((c) => c.channel === 'stable');
    expect(canary?.atomsIn).toEqual([ID]);
    expect(canary?.atomsOut).toEqual([]);
    expect(canary?.filesChanged.length).toBeGreaterThan(0);
    expect(stable?.atomsIn).toEqual([]);
    expect(stable?.filesAdded).toEqual([]);
    expect(stable?.filesChanged).toEqual([]);
    expect(body).toContain('### 渠道 canary');
    expect(body).toContain(`进入 out/ 的原子:${ID}`);
  });

  it('T2:advisory→active 让原子进入 stable 渠道', async () => {
    const w = await world({ ...T2_OK, extra: { [`rules/team/${OTHER}.md`]: otherAtom } });
    const { rep } = await outOf(w, TO_ACT);
    expect(rep.out_diff.find((c) => c.channel === 'stable')?.atomsIn).toEqual([ID]);
    expect(rep.out_diff.find((c) => c.channel === 'canary')?.atomsIn).toEqual([]);
  });
});

describe('内存 head 视图(overlayGit)与 review_by 算法', () => {
  const REAL = 'a'.repeat(40);
  const fake: GuardGit = {
    resolveCommit: () => REAL,
    changes: () => [],
    blobText: () => '',
    textAt: (c, p) => (c === REAL && p === 'x.txt' ? 'real' : undefined),
    stableTagCommits: () => [],
    isAncestor: (a, d) => a === REAL && d === REAL,
    listFiles: (c, dir) => (c === REAL && dir === 'rules' ? ['rules/team/a.md'] : []),
    fileHistory: (c) => (c === REAL ? [{ commit: REAL, date: '2026-10-08' }] : []),
  };

  it('虚拟头部提交读到叠加后的文本,真实提交(基线)不受影响;其余查询映射回真实 HEAD', () => {
    const g = overlayGit(
      fake,
      REAL,
      new Map([
        ['rules/team/a.md', 'NEW'],
        ['rules/team/b.md', 'ADDED'],
      ]),
    );
    expect(g.textAt(SYNTH_HEAD, 'rules/team/a.md')).toBe('NEW');
    expect(g.textAt(REAL, 'rules/team/a.md')).toBeUndefined(); // 基线侧不叠加
    expect(g.textAt(SYNTH_HEAD, 'x.txt')).toBe('real'); // 未叠加的路径回落到真实 HEAD
    expect(g.listFiles(SYNTH_HEAD, 'rules')).toEqual(['rules/team/a.md', 'rules/team/b.md']);
    expect(g.listFiles(REAL, 'rules')).toEqual(['rules/team/a.md']);
    expect(g.isAncestor(REAL, SYNTH_HEAD)).toBe(true);
    expect(g.fileHistory(SYNTH_HEAD, 'x')).toEqual([{ commit: REAL, date: '2026-10-08' }]);
    expect(() => g.changes(REAL, SYNTH_HEAD)).toThrow();
  });

  it('nextReviewBy:today+90(volatile +30)与 created+180(volatile created+30)取较早者', () => {
    expect(nextReviewBy('2026-10-08', 'stable', '2026-10-25')).toBe('2027-01-23');
    expect(nextReviewBy('2026-10-08', 'stable', '2027-03-01')).toBe('2027-04-06');
    expect(nextReviewBy('2026-10-08', 'volatile', '2026-10-09')).toBe('2026-11-07'); // created+30 先到
    expect(nextReviewBy('2026-10-08', 'volatile', '2026-10-25')).toBe('2026-11-07');
  });
});

/**
 * K4:冻结验收协议的合成世界(真 git 提交、按日期造历史,不 mock)。全部合成数据。
 *
 * 时间线(默认,均为提交者日期;提交者时间固定 12:00Z):
 *   c0 规则 proposed(+kit.toml)        2026-10-01
 *   c1 提案(reflect 产出,无 judge)     2026-10-02   → P
 *   c2 提案 + judge 冻结                2026-10-05   → F(judged_at_head = P;frozen_at 2026-10-05T10:00Z)
 *   c3 规则 → advisory                  2026-10-06   → advisorySince
 *   c4 attest 文件(默认放在 base 里)    2026-10-27
 *   base                                2026-10-28
 *   head 规则 → active(+head 里的 attest) 2026-10-29
 * D0 = max(anchor_min=2026-10-06, 冻结提交日期 + 1 = 2026-10-06) = 2026-10-06;分块 k:10-06+7k … +6。
 */
import { runSync } from '../../src/io/exec.js';
import { createGuardGit, runGuards } from '../../src/guards/index.js';
import type { GuardResult } from '../../src/guards/index.js';
import { lifecycleCriteria, normalizedRuleSha256 } from '../../src/guards/criteria.js';
import {
  acceptanceSha256,
  buildAcceptance,
  buildPrediction,
  decidePredictionStatus,
} from '../../src/judge/freeze.js';
import { acceptanceD0, tileWindow } from '../../src/lifecycle/attest-count.js';
import { makeTestRepo } from '../helpers/make-repo.js';
import type { FileMap, TestRepo } from '../helpers/make-repo.js';
import { COMMON_FILES } from '../fixtures/guards/atoms.js';
import {
  PATH,
  PROPOSAL_PATH,
  atomText,
  attestFile,
  kitToml,
  proposalYaml,
  type AtomOpts,
  type AttestOpts,
  type ProposalOpts,
} from './criteria-world.js';
import { trackRepo } from './helpers.js';

export interface Dates {
  rule: string;
  proposal: string;
  freeze: string;
  advisory: string;
  attests: string;
  base: string;
  head: string;
}
export const DEFAULT_DATES: Dates = {
  rule: '2026-10-01',
  proposal: '2026-10-02',
  freeze: '2026-10-05',
  advisory: '2026-10-06',
  attests: '2026-10-27',
  base: '2026-10-28',
  head: '2026-10-29',
};

export const GUIDANCE = {
  since: null,
  until: '2026-10-04T10:00:00Z',
  baseline: { sessions_total: 40, exposure_sessions: 10, fired: 12 },
};

export interface AttestSpec extends AttestOpts {
  /** 分块序号:自动填 window_start/end(缺省则用 start/end) */
  tile?: number;
  /** 提交日期(缺省 dates.attests) */
  commitDate?: string;
  /** false = 不写 acceptance_sha256;字符串 = 写这个值;缺省 = 冻结协议的 sha256 */
  bind?: boolean | string;
  /** 放在哪次提交里,缺省 base;early = 拓扑上早于冻结提交(提交日期仍取 commitDate) */
  in?: 'base' | 'head' | 'early';
}

export type CommitAt = (files: FileMap, date: string, message?: string) => Promise<string>;

export interface WorldOpts {
  atom?: AtomOpts;
  /** 规则文件路径,缺省 rules/general/sample-atom.md */
  rulePath?: string;
  /** c0 里额外带上的文件 */
  baseExtra?: FileMap;
  /** 对每份写入的提案 yaml 文本做后处理 */
  proposalTransform?: (y: string) => string;
  /** 不单独提交 reflect 产出的提案:提案在冻结提交里首次入库(此时没有「提案上一版」,judged_at_head 只受祖先检查约束) */
  noReflectCommit?: boolean;
  /** 不建 head 提交:仓库 HEAD 停在 base(promote 之类的命令自己合成 head) */
  stopAtBase?: boolean;
  kit?: string;
  proposal?: ProposalOpts;
  dates?: Partial<Dates>;
  frozenAt?: string;
  tileDays?: number;
  maxTiles?: number;
  /** 改冻结协议对象(在算 sha256 之前);rehash=false 时 sha256 保持改之前的值 */
  tamper?: (acc: Record<string, unknown>) => Record<string, unknown>;
  rehash?: boolean;
  /** 改 judge.prediction(在 buildPrediction 之后) */
  tamperPrediction?: (p: Record<string, unknown>) => Record<string, unknown>;
  /** 写进提案文件的 guidance(与冻结时哈希的那份不同 = 手改基线) */
  guidanceInFile?: unknown;
  /** 提案没有 judge.acceptance / prediction(旧 judge 记录) */
  noFreeze?: boolean;
  /** 冻结放进晋升 PR 的 head 提交,而不是基线历史 */
  freezeInHead?: boolean;
  /** 规则文本在 c0/c3 用这个正文(与最终文本不同);最终文本由 afterAdvisory 钩子自己提交 */
  earlierBody?: string;
  /** 晋升 PR 的目标状态:缺省 active;退役场景用 deprecated(此时 label 须为 kit:retire) */
  headStatus?: 'active' | 'deprecated';
  label?: 'kit:promotion' | 'kit:retire';
  /** 晋升/退役 PR 里额外改的文件(null = 删除) */
  headExtra?: (w: {
    advisoryAtom: string;
    attestFiles: Record<string, string>;
    proposalYaml: string;
  }) => FileMap;
  /** 在 date 再重跑一次 judge:第二份冻结协议(frozen_at 取该日 10:00Z)取代第一份 */
  refreeze?: string;
  attests?: AttestSpec[];
  /** 额外的历史步骤:在 c1(提案)之后、c2(冻结)之前执行 */
  beforeFreeze?: (w: { repo: TestRepo; commitAt: CommitAt }) => Promise<void>;
  /** 额外的历史步骤:在 c3(advisory)之后、attest 之前执行 */
  afterAdvisory?: (w: { repo: TestRepo; commitAt: CommitAt }) => Promise<void>;
}

const IDENT = [
  '-c',
  'user.name=kit-test',
  '-c',
  'user.email=kit-test@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

/** 先按普通方式提交,再用指定的提交者/作者时间 amend(make-repo 的固定时间戳不可调) */
export function makeCommitAt(repo: TestRepo): CommitAt {
  return async (files, date, message = 'c') => {
    await repo.commit(files, message);
    const iso = `${date}T12:00:00Z`;
    const r = runSync(
      repo.io,
      'git',
      [...IDENT, 'commit', '--quiet', '--amend', '--no-edit', '--allow-empty', '--date', iso],
      { cwd: repo.dir, env: { ...repo.gitEnv, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso } },
    );
    if (r.spawnError !== undefined || r.status !== 0) throw new Error(`amend 失败:${r.stderr}`);
    return repo.git(['rev-parse', 'HEAD']).trim();
  };
}

export interface World {
  repo: TestRepo;
  commitAt: CommitAt;
  dates: Dates;
  baseOid: string;
  headOid: string;
  /** 当前生效的冻结协议(已含 tamper) */
  acc: Record<string, unknown>;
  d0: string;
  /** 第 k 块窗口 */
  tile(k: number): { start: string; end: string };
  freezeOid: string;
  proposalOid: string;
  /** 全部 attest 文件(路径 → 文本) */
  attestFiles: Record<string, string>;
  advisoryAtom: string;
  /** 在 base..head 上跑守卫(默认 tag kit-base / kit-head) */
  run(extra?: { base?: string; head?: string; cwd?: string }): GuardResult & { codes: string[] };
}

/** 默认的有效 attest 集:alice、bob 各交块 0 与块 1(总曝光 4×10) */
export function twoTiles(extra: Partial<AttestSpec> = {}): AttestSpec[] {
  const out: AttestSpec[] = [];
  for (const tile of [0, 1]) {
    for (const member of ['@alice', '@bob']) out.push({ tile, member, ...extra });
  }
  return out;
}

export async function buildWorld(o: WorldOpts = {}): Promise<World> {
  const dates: Dates = { ...DEFAULT_DATES, ...o.dates };
  const repo = trackRepo(await makeTestRepo());
  const commitAt = makeCommitAt(repo);
  const tileDays = o.tileDays ?? 7;
  const specs = o.attests ?? twoTiles();
  const rulePath = o.rulePath ?? PATH;
  const tx = o.proposalTransform ?? ((y: string) => y);

  const proposedAtom = atomText({ status: 'proposed', ...o.atom });
  const advisoryAtom = atomText({ status: 'advisory', ...o.atom });
  const finalAtom = atomText({
    status: o.headStatus ?? 'active',
    review_by: '2027-02-08',
    ...o.atom,
  });
  const earlierAtom = (status: string): string =>
    o.earlierBody === undefined
      ? atomText({ status, ...o.atom })
      : atomText({ status, ...o.atom, body: o.earlierBody });
  const ruleSha = normalizedRuleSha256(proposedAtom)!;

  await commitAt(
    {
      ...COMMON_FILES,
      'kit.toml': o.kit ?? kitToml(),
      [rulePath]: earlierAtom('proposed'),
      ...o.baseExtra,
    },
    dates.rule,
    'rule',
  );
  // c1:reflect 产出的提案(带 guidance,无 judge)
  const proposalOid = o.noReflectCommit
    ? repo.git(['rev-parse', 'HEAD']).trim()
    : await commitAt(
        {
          [PROPOSAL_PATH]: tx(
            proposalYaml(proposedAtom, { ...o.proposal, noJudge: true, guidance: GUIDANCE }),
          ),
        },
        dates.proposal,
        'proposal',
      );
  await o.beforeFreeze?.({ repo, commitAt });

  // c2:judge 冻结
  const sig = { type: 'always' } as const;
  const freezeDoc = (judgedAtHead: string, now: string, tamperIt: boolean) => {
    const built = buildAcceptance({
      ruleSha256: ruleSha,
      signature: sig,
      guidance: GUIDANCE,
      headOid: judgedAtHead,
      now: new Date(now),
      tileDays,
      maxTiles: o.maxTiles ?? 4,
    });
    let acc: Record<string, unknown> = { ...built };
    if (tamperIt && o.tamper) {
      acc = o.tamper(acc);
      if (o.rehash !== false) {
        const { sha256: _old, ...rest } = acc;
        void _old;
        acc = { ...rest, sha256: acceptanceSha256(rest as never) };
      }
    }
    const predBuilt = buildPrediction(
      decidePredictionStatus(sig, GUIDANCE),
      undefined,
      acc as never,
    );
    const prediction =
      tamperIt && o.tamperPrediction ? o.tamperPrediction({ ...predBuilt }) : predBuilt;
    const yaml = tx(
      proposalYaml(proposedAtom, {
        ...o.proposal,
        guidance: o.guidanceInFile ?? GUIDANCE,
        ...(o.noFreeze ? {} : { acceptance: acc, prediction }),
      }),
    );
    return { acc, built, yaml };
  };

  // judge 在当时的 HEAD 上运行(钩子可能又加了提交)
  const judgedAtHead = repo.git(['rev-parse', 'HEAD']).trim();
  let freezeDate = dates.freeze;
  let doc = freezeDoc(judgedAtHead, o.frozenAt ?? `${dates.freeze}T10:00:00Z`, true);
  // 原始(未 tamper)协议只用来算 D0 与 attest 的分块,和 CI 在没有篡改时算出的一致
  const clean = freezeDoc(judgedAtHead, o.frozenAt ?? `${dates.freeze}T10:00:00Z`, false);
  const attestFiles: Record<string, string> = {};
  const fileFor = (s: AttestSpec, d0: string, accSha: string): [string, string] => {
    const w =
      s.tile !== undefined && s.start === undefined ? tileWindow(d0, tileDays, s.tile) : undefined;
    const bindSha = s.bind === false ? undefined : typeof s.bind === 'string' ? s.bind : accSha;
    const [p, t] = attestFile(advisoryAtom, {
      ...s,
      ...(w ? { start: w.start, end: w.end } : {}),
      ...(bindSha !== undefined ? { acceptance: bindSha } : {}),
    });
    attestFiles[p] = t;
    return [p, t];
  };

  let freezeOid = proposalOid;
  if (o.refreeze === undefined) {
    const early = specs.filter((s) => s.in === 'early');
    if (early.length > 0) {
      const d0e = acceptanceD0(clean.built, freezeDate);
      const files: Record<string, string> = {};
      for (const s of early) {
        const [p, t] = fileFor(s, d0e, doc.acc['sha256'] as string);
        files[p] = t;
      }
      await commitAt(files, early[0]!.commitDate ?? dates.attests, 'early attests');
    }
    if (!o.freezeInHead) {
      freezeOid = await commitAt({ [PROPOSAL_PATH]: doc.yaml }, freezeDate, 'freeze');
    }
  } else {
    const first = freezeDoc(judgedAtHead, `${dates.freeze}T10:00:00Z`, false);
    const oid1 = await commitAt({ [PROPOSAL_PATH]: first.yaml }, dates.freeze, 'freeze-1');
    freezeDate = o.refreeze;
    doc = freezeDoc(oid1, `${o.refreeze}T10:00:00Z`, true);
    freezeOid = await commitAt({ [PROPOSAL_PATH]: doc.yaml }, o.refreeze, 'freeze-2');
  }
  const d0 = acceptanceD0(o.refreeze === undefined ? clean.built : doc.built, freezeDate);

  // c3:晋升 advisory
  await commitAt({ [rulePath]: earlierAtom('advisory') }, dates.advisory, 'advisory');
  await o.afterAdvisory?.({ repo, commitAt });

  // c4:base 里的 attest,按提交日期分组各一次提交
  const accSha = doc.acc['sha256'] as string;
  const groups = new Map<string, FileMap>();
  for (const s of specs.filter((x) => x.in === undefined || x.in === 'base')) {
    const [p, t] = fileFor(s, d0, accSha);
    const d = s.commitDate ?? dates.attests;
    groups.set(d, { ...(groups.get(d) ?? {}), [p]: t });
  }
  for (const [d, files] of [...groups].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    await commitAt(files, d, 'attests');
  }
  const baseOid = await commitAt({}, dates.base, 'base');
  repo.tag('kit-base');

  if (o.stopAtBase) {
    return {
      repo,
      commitAt,
      dates,
      baseOid,
      headOid: baseOid,
      acc: doc.acc,
      d0,
      tile: (k) => tileWindow(d0, tileDays, k),
      freezeOid,
      proposalOid,
      attestFiles,
      advisoryAtom,
      run: () => {
        throw new Error('stopAtBase 的世界没有 head');
      },
    };
  }
  const headFiles: Record<string, string | null> = { [rulePath]: finalAtom };
  if (o.freezeInHead) headFiles[PROPOSAL_PATH] = doc.yaml;
  for (const s of specs.filter((x) => x.in === 'head')) {
    const [p, t] = fileFor(s, d0, accSha);
    headFiles[p] = t;
  }
  Object.assign(
    headFiles,
    o.headExtra?.({ advisoryAtom, attestFiles, proposalYaml: doc.yaml }) ?? {},
  );
  const headOid = await commitAt(headFiles, dates.head, 'head');
  repo.tag('kit-head');

  const run: World['run'] = (extra = {}) => {
    const result = runGuards({
      git: createGuardGit(repo.io, extra.cwd ?? repo.dir, repo.gitEnv),
      base: extra.base ?? 'kit-base',
      head: extra.head ?? 'kit-head',
      label: o.label ?? 'kit:promotion',
      criteria: lifecycleCriteria,
    });
    return { ...result, codes: [...new Set(result.diagnostics.map((d) => d.code))].sort() };
  };
  return {
    repo,
    commitAt,
    dates,
    baseOid,
    headOid,
    acc: doc.acc,
    d0,
    tile: (k) => tileWindow(d0, tileDays, k),
    freezeOid,
    proposalOid,
    attestFiles,
    advisoryAtom,
    run,
  };
}

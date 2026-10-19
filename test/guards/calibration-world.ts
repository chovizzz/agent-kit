/**
 * K5a:校准账的合成世界。在 K4 的 `buildWorld` 上叠「同行提案」(peers):每个 peer 是基线树里一个已冻结、
 * 已结算(或按配置不结算 / 损坏)的提案,带自己的 attest。全部合成数据、真 git 提交。
 *
 * 时间线(接在 buildWorld 的 advisory 提交之后):
 *   freeze1  2026-10-07   → D0₁ = 2026-10-08(块 0:10-08..10-14,块 1:10-15..10-21)
 *   freeze2  2026-10-12   → D0₂ = 2026-10-13(块 0:10-13..10-19,块 1:10-20..10-26)
 *   attests₁ 2026-10-27
 *   attests₂ 2026-10-27   (buildWorld 自己的 attest 提交在同一天,base 在 10-28)
 * 基线 exposure 比率 = GUIDANCE 的 10/40;peer 的 attest 每份 sessions_total=40,exposure=10 → r=1(命中 [0.8,1.25]),exposure=40 → r=4(失手)。
 */
import { stringify } from 'yaml';
import type { RatioGridPoint } from '../../src/contracts/proposal.js';
import {
  buildAcceptance,
  buildPrediction,
  decidePredictionStatus,
} from '../../src/judge/freeze.js';
import { tileWindow, acceptanceD0 } from '../../src/lifecycle/attest-count.js';
import { atomText, attestFile } from './criteria-world.js';
import { GUIDANCE, type CommitAt } from './frozen-world.js';
import type { TestRepo } from '../helpers/make-repo.js';

export interface PeerFreeze {
  lo?: RatioGridPoint;
  hi?: RatioGridPoint;
  conf?: 0.5 | 0.7 | 0.9;
  /** 该份预测的验收数据是否命中(决定 attest 的 exposure) */
  hit?: boolean;
  /** 冻结提交日期 */
  at: string;
  /** frozen_at 的时刻(缺省 10:00:00Z);同日重跑 judge 时要换一个,否则冻结协议逐字节相同 */
  time?: string;
  /** 交几个块的 attest(缺省 2;0 = 不交) */
  tiles?: number;
  /** attest 的 sessions_total / exposure_sessions 都写 0(有效块齐了但无法算比值) */
  zeroSessions?: boolean;
}

export interface Peer {
  n: number;
  vendor?: string;
  model?: string;
  /** 第一份冻结;缺省日期 2026-10-07 */
  first?: Partial<PeerFreeze>;
  /** 重跑 judge 产生的第二份(取代第一份) */
  second?: PeerFreeze;
  /** 缺省 predicted;baseline_insufficient 会同时给低基线 guidance */
  status?: 'predicted' | 'baseline_insufficient' | 'not_measurable';
  /** 手改 prediction.status(guidance 仍是充足的):逃避结算的伪造 */
  forceStatus?: 'baseline_insufficient' | 'not_measurable';
  /** 损坏方式 */
  corrupt?: 'hash' | 'no_prediction' | 'yaml' | 'empty_acceptance';
  /** 额外写一个 judge 块完全相同的提案文件(同一冻结协议出现在两个文件里) */
  duplicate?: boolean;
  /** 冻结之后又改了 prediction(再提交一次) */
  driftAfterFreeze?: boolean;
}

export const peerId = (n: number): string => `2026-09-01-${String(n).padStart(3, '0')}`;
export const peerPath = (n: number): string => `proposals/${peerId(n)}.yaml`;
export const peerRule = (n: number): string => `peer-rule-${n}`;
const peerSha = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
const LOW_GUIDANCE = {
  since: null,
  until: '2026-10-04T10:00:00Z',
  baseline: { sessions_total: 10, exposure_sessions: 1, fired: 2 },
};

interface Built {
  yaml: string;
  accSha: string;
  d0: string;
  freezeDate: string;
}

function build(p: Peer, f: PeerFreeze, judgedAtHead: string): Built {
  const status = p.status ?? 'predicted';
  const guidance = status === 'baseline_insufficient' ? LOW_GUIDANCE : GUIDANCE;
  const sig = { type: 'regex', pattern: 'x' } as const;
  const acc = buildAcceptance({
    ruleSha256: peerSha(p.n),
    signature: sig,
    guidance,
    headOid: judgedAtHead,
    now: new Date(`${f.at}T${f.time ?? '10:00:00'}Z`),
    tileDays: 7,
    maxTiles: 4,
  });
  const decided =
    p.forceStatus ?? (status === 'not_measurable' ? status : decidePredictionStatus(sig, guidance));
  const pred = buildPrediction(
    decided,
    decided === 'predicted'
      ? {
          direction: 'flat',
          ratio_lo: f.lo ?? 0.8,
          ratio_hi: f.hi ?? 1.25,
          confidence: f.conf ?? 0.9,
        }
      : undefined,
    acc,
  );
  let accOut: Record<string, unknown> = { ...acc };
  let predOut: Record<string, unknown> | undefined = { ...pred };
  if (p.corrupt === 'hash') accOut = { ...acc, sha256: 'f'.repeat(64) };
  if (p.corrupt === 'no_prediction') predOut = undefined;
  if (p.corrupt === 'empty_acceptance') accOut = {};
  const vendor = p.vendor ?? 'openai';
  const model = p.model ?? 'gpt-6.1-sol';
  const doc = {
    id: peerId(p.n),
    targets: [peerRule(p.n)],
    reflector: { guidance },
    judge: {
      hops: [{ hop: 'codex', vendor, model, result: 'ok' }],
      provider: 'codex',
      vendor,
      verdict: 'accept',
      rule_sha256: peerSha(p.n),
      acceptance: accOut,
      ...(predOut ? { prediction: predOut } : {}),
    },
  };
  const yaml = p.corrupt === 'yaml' ? ': : not yaml [\n' : stringify(doc);
  return {
    yaml,
    accSha: acc.sha256,
    d0: acceptanceD0(acc, f.at),
    freezeDate: f.at,
  };
}

function attestsFor(p: Peer, f: PeerFreeze, b: Built): Record<string, string> {
  const files: Record<string, string> = {};
  const tiles = f.tiles ?? 2;
  for (let k = 0; k < tiles; k++) {
    const w = tileWindow(b.d0, 7, k);
    for (const member of ['@alice', '@bob']) {
      const [path, text] = attestFile(atomText(), {
        rule_id: peerRule(p.n),
        hash: peerSha(p.n),
        member,
        start: w.start,
        end: w.end,
        exposure: f.hit === false ? 40 : 10,
        acceptance: b.accSha,
      });
      files[path] = f.zeroSessions
        ? text
            .replace('"sessions_total":40', '"sessions_total":0')
            .replace(/"exposure_sessions":\d+/, '"exposure_sessions":0')
        : text;
    }
  }
  return files;
}

export interface PeerFiles {
  /** 提案文件(冻结提交) */
  proposals: Record<string, string>;
  /** 第二次冻结的提案文件(取代第一份) */
  reproposals: Record<string, string>;
  attests1: Record<string, string>;
  attests2: Record<string, string>;
  secondDate: Map<number, string>;
}

/** 纯函数:peer 们的全部文件(`judgedAtHead` 只写进冻结协议,校准账不核它的祖先关系) */
export function peerFiles(peers: readonly Peer[], judgedAtHead: string): PeerFiles {
  const out: PeerFiles = {
    proposals: {},
    reproposals: {},
    attests1: {},
    attests2: {},
    secondDate: new Map(),
  };
  for (const p of peers) {
    const f1: PeerFreeze = { hit: true, at: '2026-10-07', ...p.first };
    const b1 = build(p, f1, judgedAtHead);
    out.proposals[peerPath(p.n)] = b1.yaml;
    Object.assign(out.attests1, attestsFor(p, f1, b1));
    if (p.duplicate) {
      out.proposals[`proposals/2026-09-02-${String(p.n).padStart(3, '0')}.yaml`] = b1.yaml.replace(
        peerId(p.n),
        `2026-09-02-${String(p.n).padStart(3, '0')}`,
      );
    }
    if (p.second) {
      const b2 = build(p, p.second, judgedAtHead);
      out.reproposals[peerPath(p.n)] = b2.yaml;
      out.secondDate.set(p.n, p.second.at);
      Object.assign(out.attests2, attestsFor(p, p.second, b2));
    }
  }
  return out;
}

/** buildWorld 的 afterAdvisory 钩子:把 peers 提交进基线历史 */
export function peerHook(
  peers: readonly Peer[],
  opts: { driftNs?: readonly number[] } = {},
): (w: { repo: TestRepo; commitAt: CommitAt }) => Promise<void> {
  return async ({ repo, commitAt }) => {
    const head = repo.git(['rev-parse', 'HEAD']).trim();
    const f = peerFiles(peers, head);
    await commitAt(f.proposals, '2026-10-07', 'peers freeze');
    // 第二次冻结:每个 peer 的日期不同时按日期分组各提交一次
    const byDate = new Map<string, Record<string, string>>();
    for (const [path, text] of Object.entries(f.reproposals)) {
      const n = Number(/(\d{3})\.yaml$/.exec(path)![1]);
      const d = f.secondDate.get(n)!;
      byDate.set(d, { ...(byDate.get(d) ?? {}), [path]: text });
    }
    for (const [d, files] of [...byDate].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      await commitAt(files, d, 'peers refreeze');
    }
    if (opts.driftNs && opts.driftNs.length > 0) {
      const files: Record<string, string> = {};
      for (const n of opts.driftNs) {
        const cur = repo.git(['show', `HEAD:${peerPath(n)}`]);
        files[peerPath(n)] = cur.replace(/ratio_lo: 0\.8/, 'ratio_lo: 0.5');
      }
      await commitAt(files, '2026-10-22', 'peers drift');
    }
    if (Object.keys(f.attests1).length > 0)
      await commitAt(f.attests1, '2026-10-27', 'peers attests 1');
    if (Object.keys(f.attests2).length > 0)
      await commitAt(f.attests2, '2026-10-27', 'peers attests 2');
  };
}

/** 一批 peers:n 个 conf=0.9 的单份预测,前 hits 个命中、其余失手 */
export function batch(
  n: number,
  hits: number,
  over: Partial<Peer> & { conf?: 0.5 | 0.7 | 0.9 } = {},
): Peer[] {
  const { conf, ...rest } = over;
  return Array.from({ length: n }, (_, i) => ({
    n: i + 1,
    ...rest,
    first: { hit: i < hits, ...(conf !== undefined ? { conf } : {}), ...rest.first },
  }));
}

/**
 * §21 V1 装配块 C1a——**增影响授权**(C v2 §8;D v4 §3.2 / §3.3 与之合一,**这是唯一一套** `GrowthPass` / `requireGrowth` / `gen`):
 * `GrowthPass`(一次性品牌值,绑两把锁 nonce、写代数 `gen` 与获准操作)、`GrowthOp` / `GrowthReq`、`GrowthVerdict`、`GrowthDeny`、`GrowthStage`、
 * `evaluateGrowth`(纯判定,所有事实经 `GrowthReaders` 当次现读)、按 op 的检查子集表 `OP_CHECK_PROFILE`、`requireGrowth` / `checkGrowthVeto`。
 * 冻结:合并后改动 = 回主代理(`c1-freeze.test.ts`)。**本块不接线**:没有任何生产调用方;D 在 D1b / D2 注入读端口并装配 `GrowthStage`。
 *
 * 安全性质(每条都有负向用例与变异锚点):
 *  - `GrowthPass` 的构造只在本模块的 `evaluateGrowth` 内(模块私有 `mint`),运行期登记表只认本模块铸造且未消费的 pass(强转造出的 pass → `StaleGrowth('not_minted')`);
 *  - 一个 pass 至多服务一次写:`requireGrowth` 无论成败都使它作废;nonce / round / `gen` / op 任一不等 → `StaleGrowth`;
 *  - `gen` 在任何持久写之后递增(`round.ts` 的写适配器 `finally`):授权写内 `requireGrowth` 看到的仍是本写之前的 `gen`,所以合法写不被自己否定,
 *    而同一 pass 不能服务第二次写;
 *  - 铸造要求 `inFlight == 0`(写进行中铸造 = `RoundInternalError`),且铸造时 `gen` 必须等于评估开始时的 `gen`(评估期间有写 = 事实已过时 = `RoundInternalError`);
 *  - 缺 stage 或 op 不在 `stage.ops` 内 → `growth_unwired`(**先于任何其它码**,零 reader 调用);
 *  - 候选来源缺失(`source` 为 null / undefined)一律拒绝(`source_unknown`),与 W9 的 `source_proposal === null → ok(不消费)` 各自独立。
 */
import { normalizeJudgeVerdict, type JudgeGrowthVerdict } from '../judge-slot.js';
import {
  PersonalLockLost,
  RoundInternalError,
  StaleGrowth,
  isRsiLockLost,
  type StaleGrowthReason,
} from './errors.js';
import { judgeBlockedOf, roundInternals, type BothRound } from './round.js';
import type { TaintCandidate } from './taint-types.js';

// ---------- 操作 / 请求 / 令牌 ----------
export const GROWTH_OPS = Object.freeze([
  'bootstrap',
  'candidate_create',
  'admission',
  'shadow_to_canary',
  'grant',
  'deploy_inject',
] as const);
export type GrowthOpName = (typeof GROWTH_OPS)[number];
export const CANDIDATE_OPS = Object.freeze(['shadow_to_canary', 'grant', 'deploy_inject'] as const);
export type CandidateOpName = (typeof CANDIDATE_OPS)[number];

/** 候选类强制带候选 `(id, content_sha256)`,省略 = 类型错误(`@ts-expect-error` 负向用例钉住) */
export type GrowthOp =
  | { readonly cap: 'bootstrap' }
  | { readonly cap: 'candidate_create' }
  | { readonly cap: 'admission' }
  | {
      readonly cap: CandidateOpName;
      readonly cand: { readonly id: string; readonly content_sha256: string };
    };
export type GrowthReq =
  | { readonly op: 'bootstrap' }
  | { readonly op: 'candidate_create' }
  | { readonly op: 'admission' }
  | { readonly op: CandidateOpName; readonly cand: TaintCandidate };
export type CandidateReq = Extract<GrowthReq, { cand: TaintCandidate }>;

// ---------- 令牌登记 ----------
interface PassRecord {
  readonly round: BothRound;
  used: boolean;
  /** `checkGrowthVeto` 成功时的 `gen`(null = 尚未现读外部否决事实);`requireGrowth` 要求它等于消费时的 `gen` */
  vetoClearAtGen: number | null;
}
const minted = new WeakMap<object, PassRecord>();

declare const passBrand: unique symbol;
/** 一次性品牌值:外部不可构造(构造点不导出;运行期登记表兜底)。字段只读 */
export interface GrowthPass {
  readonly [passBrand]: true;
  readonly rsiNonce: string;
  readonly personalNonce: string;
  readonly gen: number;
  readonly op: GrowthOp;
}

/** 拒绝码全集(冻结;顺序即测试钉住的顺序)。v1 §8 的全部旧码 + `update_busy` / `taint_conflict` / D v4 b5 的三个新码 */
export const GROWTH_DENY_CODES = Object.freeze([
  'phase',
  'growth_unwired',
  'config',
  'state_invalid',
  'paused',
  'flags',
  'safety_fault',
  'repo',
  'recovery_incomplete',
  'reconcile_incomplete',
  'store_unreadable',
  'store_full',
  'taint_pending',
  'taint_unavailable',
  'purge',
  'judge_unavailable',
  'judge_indeterminate',
  'judge_signal_pending',
  'source_unknown',
  'throttled',
  'personal_busy',
  'personal_fault',
  'unsettled',
  'admission',
  'lock_lost',
  'update_busy',
  'taint_conflict',
  'near_fp_unavailable',
  'fp_key_unavailable',
  'creation_unready',
] as const);
export type GrowthDeny = (typeof GROWTH_DENY_CODES)[number];

export type GrowthVerdict = { readonly ok: false; readonly code: GrowthDeny } | GrowthPass;

/** 唯一可构造的「拒绝」值(无 round 时的 verdict,如 `personal_busy`) */
export const growthDenied = (code: GrowthDeny): GrowthVerdict =>
  Object.freeze({ ok: false as const, code });
export const isGrowthPass = (v: GrowthVerdict): v is GrowthPass => !('code' in v) && minted.has(v);

/** D 的装配声明:缺项 → 该 op 的 `evaluateGrowth` 返回 `growth_unwired`(D3 前 `ops = {bootstrap, candidate_create}`,D2 后补全) */
export interface GrowthStage {
  readonly ops: ReadonlySet<GrowthOpName>;
}

// ---------- 读端口(纯读;每个方法必收 round)----------
export type CheckResult<C extends string> =
  { readonly ok: true } | { readonly ok: false; readonly code: C };
export interface ConfigFact {
  readonly trusted: boolean;
  readonly autoEnabled: boolean;
  readonly confirmed: boolean;
}
/** G3:`paused` = `auto_pause` 有码 ∨ B ∨ U 任一存在;`flags` = diverged ∨ owner_changed;`safetyFault` = 本轮有 S0 故障 */
export interface StateFact {
  readonly valid: boolean;
  readonly paused: boolean;
  readonly flags: boolean;
  readonly safetyFault: boolean;
}
export type BarrierDeny =
  'recovery_incomplete' | 'reconcile_incomplete' | 'store_unreadable' | 'store_full';
export interface TaintFact {
  /** 污染扫描能力已装配(`taint_scan`);bootstrap 只要求它(前置能力就绪) */
  readonly capabilityReady: boolean;
  readonly scan: 'ok' | 'unavailable' | 'pending';
  /** 本轮是否要求先做排除重扫(仅 `l0Due` 的轮) / 是否已做 */
  readonly rescanRequired: boolean;
  readonly rescanned: boolean;
  /** 逐候选(候选类 op 才读):`unknown` = 来源 / run / 标记查不实;`conflict` = 污染凭据与已有凭据冲突 */
  readonly candidate?: 'clean' | 'tainted' | 'unknown' | 'conflict';
}
export interface PurgeFact {
  /** `purge_personal_rewrite` 就绪(D);bootstrap 只要求它 */
  readonly capabilityReady: boolean;
  readonly journalPresent: boolean;
}
export interface AdmissionFact {
  /** 准入能力已装配 */
  readonly wired: boolean;
  /** 准入当前有效(W10b 前恒 false) */
  readonly effective: boolean;
  /** 已持久化且 `agent_version / shape_version` 逐项匹配 */
  readonly versionsMatch: boolean;
}
/** D 专属列允许返回的拒绝码(`CreationExtra` / `nearFpCapability` / `source_proposal` 可解析 / canary 记录一致……) */
export type ExtraDeny =
  | 'near_fp_unavailable'
  | 'fp_key_unavailable'
  | 'creation_unready'
  | 'source_unknown'
  | 'purge'
  | 'recovery_incomplete';
export type VetoFact =
  | { readonly vetoed: false }
  | {
      readonly vetoed: true;
      readonly why: 'marker' | 'auto_pause' | 'flags' | 'credential';
    };

export interface GrowthReaders {
  /** G1:能力 × 相位(`candidate_create` V1a、`transition_shadow_to_canary` / `deploy_none_to_injected` V1b) */
  capability(round: BothRound, req: GrowthReq): Promise<{ readonly ready: boolean }>;
  config(round: BothRound): Promise<ConfigFact>;
  state(round: BothRound): Promise<StateFact>;
  /** G4:`checkRepoStructure` ok ∧ 判定 ① */
  repo(round: BothRound): Promise<CheckResult<'repo'>>;
  /** G5:恢复屏障(journal / `txn/` 无遗留、终态效果无 failed / deferred、凭据可读且对账完、账可读且未满) */
  barrier(round: BothRound): Promise<CheckResult<BarrierDeny>>;
  taint(round: BothRound, req: GrowthReq): Promise<TaintFact>;
  purge(round: BothRound): Promise<PurgeFact>;
  /** G8:D 读出最新权威记录后经 `checkJudgeGrowth(slot, rec)` 取值(抛错 / 超时 / 非法值已是 `judge_indeterminate`) */
  judge(round: BothRound, req: CandidateReq): Promise<JudgeGrowthVerdict>;
  /** G9:`l0Due(prev, nowMs())`,由 P 在 S2 之后用**当前** state 现算 */
  throttle(round: BothRound): Promise<{ readonly due: boolean }>;
  /** G10:两把锁 `assertHeld`(任一丢失抛 `lock_lost` 类错误) */
  locks(round: BothRound): Promise<void>;
  admission(round: BothRound, req: GrowthReq): Promise<AdmissionFact>;
  /** D 专属列 */
  extra(round: BothRound, req: GrowthReq): Promise<CheckResult<ExtraDeny>>;
  /** 外部否决事实(B / U、`state.auto_pause` 与标志、该候选的凭据命中):`requireGrowthFresh` 在消费前现读 */
  externalVeto(round: BothRound, op: GrowthOp): Promise<VetoFact>;
}

// ---------- 按 op 的检查子集表(D v4 §3.3;冻结)----------
/** 各检查项的档位(不是布尔):见 `OP_CHECK_PROFILE` 与 `stepsOf` 对每个档位的定义 */
export type G3Mode = 'full' | 'valid_only';
export type G6Mode = 'off' | 'prereq' | 'rescan' | 'cand';
export type G7Mode = 'off' | 'prereq' | 'on';
export type G9Mode = 'off' | 'on' | 'implied';
export type G11Mode = 'off' | 'wired_only' | 'versions';
export type OnOff = 'on' | 'off';
export interface OpProfile {
  readonly G1: OnOff;
  readonly G2: OnOff;
  readonly G3: G3Mode;
  readonly G4: OnOff;
  readonly G5: OnOff;
  readonly G6: G6Mode;
  readonly G7: G7Mode;
  readonly G8: OnOff;
  readonly G9: G9Mode;
  readonly G10: OnOff;
  readonly G11: G11Mode;
  /** D 专属列是否调用 `readers.extra`(bootstrap:首次证明或合法 journal;create:`CreationExtra`;shadow / grant / deploy:near_fp + 来源 + canary 记录;admission:无) */
  readonly extra: OnOff;
}
/**
 * 逐 op 的最终内容:
 *  - `bootstrap`:G3 只要 state 合规(`valid_only`);G6 / G7 只要前置能力就绪(`prereq`);不要求 G4 / G5 / G8 / G9 / G11(解建仓启动环);
 *  - `candidate_create`:G3 **全部(含暂停)**;G6 要求本轮已做排除重扫(`rescan`);G9 由重扫要求蕴含(`implied`:只在 due 轮);G8 / G11 不检查
 *    (G11 不对创建生效,否则 W10b 前创建管线不可测);
 *  - `shadow_to_canary`:G6 含「候选非 unknown」(`cand`);G8 ✓;G11 仅要求「能力已装配」(`wired_only`);
 *  - `grant` / `deploy_inject`:全 ✓,G11 要求已持久化且版本逐项匹配(`versions`;W10b 前恒拒绝 `admission`);
 *  - `admission`:不含候选项(G4 / G6 / G8 / G11 皆无,消除自依赖)。
 * 终态转移(`shadow_no_hit` / `expired` / `rejected` 等)属减影响类,**不走 pass、不受暂停与 G9 限制**,不在本表。
 */
export const OP_CHECK_PROFILE: Readonly<Record<GrowthOpName, OpProfile>> = Object.freeze({
  bootstrap: Object.freeze({
    G1: 'on',
    G2: 'on',
    G3: 'valid_only',
    G4: 'off',
    G5: 'off',
    G6: 'prereq',
    G7: 'prereq',
    G8: 'off',
    G9: 'off',
    G10: 'on',
    G11: 'off',
    extra: 'on',
  }),
  candidate_create: Object.freeze({
    G1: 'on',
    G2: 'on',
    G3: 'full',
    G4: 'on',
    G5: 'on',
    G6: 'rescan',
    G7: 'on',
    G8: 'off',
    G9: 'implied',
    G10: 'on',
    G11: 'off',
    extra: 'on',
  }),
  shadow_to_canary: Object.freeze({
    G1: 'on',
    G2: 'on',
    G3: 'full',
    G4: 'on',
    G5: 'on',
    G6: 'cand',
    G7: 'on',
    G8: 'on',
    G9: 'on',
    G10: 'on',
    G11: 'wired_only',
    extra: 'on',
  }),
  grant: Object.freeze({
    G1: 'on',
    G2: 'on',
    G3: 'full',
    G4: 'on',
    G5: 'on',
    G6: 'cand',
    G7: 'on',
    G8: 'on',
    G9: 'on',
    G10: 'on',
    G11: 'versions',
    extra: 'on',
  }),
  deploy_inject: Object.freeze({
    G1: 'on',
    G2: 'on',
    G3: 'full',
    G4: 'on',
    G5: 'on',
    G6: 'cand',
    G7: 'on',
    G8: 'on',
    G9: 'on',
    G10: 'on',
    G11: 'versions',
    extra: 'on',
  }),
  admission: Object.freeze({
    G1: 'on',
    G2: 'on',
    G3: 'full',
    G4: 'off',
    G5: 'on',
    G6: 'off',
    G7: 'on',
    G8: 'off',
    G9: 'on',
    G10: 'on',
    G11: 'off',
    extra: 'off',
  }),
} as const);

/** 检查项的执行顺序即返回优先级(`growth_unwired` 与首次 `locks` 在最前;`unsettled` 紧随其后,见 `evaluateGrowth`) */
export const CHECK_ORDER = Object.freeze([
  'G1',
  'G2',
  'G3',
  'G4',
  'G5',
  'G6',
  'G7',
  'G8',
  'G9',
  'G11',
  'extra',
] as const);
export type CheckId = (typeof CHECK_ORDER)[number];

/** 某项的 reader 抛错(非失锁)/ 返回非法值时的 fail-closed 拒绝码(逐项固定) */
export const CHECK_FAILURE_CODE: Readonly<Record<CheckId, GrowthDeny>> = Object.freeze({
  G1: 'phase',
  G2: 'config',
  G3: 'state_invalid',
  G4: 'repo',
  G5: 'store_unreadable',
  G6: 'taint_unavailable',
  G7: 'purge',
  G8: 'judge_indeterminate',
  G9: 'throttled',
  G11: 'admission',
  extra: 'creation_unready',
});

function mint(round: BothRound, op: GrowthOp, gen: number): GrowthPass {
  const pass = Object.freeze({
    rsiNonce: round.rsiNonce,
    personalNonce: round.personalNonce,
    gen,
    op: Object.freeze(
      op.cap === 'bootstrap' || op.cap === 'candidate_create' || op.cap === 'admission'
        ? { cap: op.cap }
        : {
            cap: op.cap,
            cand: Object.freeze({ id: op.cand.id, content_sha256: op.cand.content_sha256 }),
          },
    ),
  }) as unknown as GrowthPass;
  minted.set(pass, { round, used: false, vetoClearAtGen: null });
  return pass;
}

const isCandidateOp = (op: GrowthOpName): op is CandidateOpName =>
  (CANDIDATE_OPS as readonly string[]).includes(op);

/** 把请求变成获准操作(候选类只取 `(id, content_sha256)`)。跨信任边界:畸形请求 = `RoundInternalError('bad_request')`(调用方违约,不是拒绝码) */
export function opOfReq(req: GrowthReq): GrowthOp {
  const r = req as { op?: unknown; cand?: unknown } | null;
  if (typeof r !== 'object' || r === null || typeof r.op !== 'string') {
    throw new RoundInternalError('bad_request');
  }
  if (!(GROWTH_OPS as readonly string[]).includes(r.op))
    throw new RoundInternalError('bad_request');
  const op = r.op as GrowthOpName;
  if (!isCandidateOp(op)) return { cap: op } as GrowthOp;
  const c = r.cand as Partial<TaintCandidate> | null | undefined;
  if (
    typeof c !== 'object' ||
    c === null ||
    typeof c.id !== 'string' ||
    c.id === '' ||
    typeof c.content_sha256 !== 'string' ||
    c.content_sha256 === ''
  ) {
    throw new RoundInternalError('bad_request');
  }
  return { cap: op, cand: { id: c.id, content_sha256: c.content_sha256 } };
}

/**
 * 请求快照:在首次异步边界之前复制并校验完整请求(候选身份 / 来源 / 谱系字段),profile、全部 reader 与铸造统一使用快照——
 * 调用方持有的可变别名在评估期间被改写(`req.cand` 换成别的候选)既不会让检查对象与获准对象分叉,也看不到(快照冻结)。畸形请求 = `RoundInternalError('bad_request')`。
 */
function snapshotReq(req: GrowthReq): GrowthReq {
  const op = opOfReq(req);
  if (!('cand' in op)) return Object.freeze({ op: op.cap }) as GrowthReq;
  const c = (req as CandidateReq).cand;
  const s = c.source as unknown;
  const source =
    typeof s === 'object' && s !== null
      ? Object.freeze({
          run_id: (s as { run_id: string }).run_id,
          proposal_id: (s as { proposal_id: string }).proposal_id,
        })
      : s === undefined
        ? undefined
        : null; // 非对象的来源(畸形)按「来源缺失」处理,绝不当成有来源
  return Object.freeze({
    op: op.cap,
    cand: Object.freeze({
      id: c.id,
      content_sha256: c.content_sha256,
      lifecycle: c.lifecycle,
      source,
    }),
  }) as GrowthReq;
}

export function sameOp(a: GrowthOp, b: GrowthOp): boolean {
  if (a.cap !== b.cap) return false;
  if ('cand' in a || 'cand' in b) {
    const x = 'cand' in a ? a.cand : undefined;
    const y = 'cand' in b ? b.cand : undefined;
    return (
      x !== undefined && y !== undefined && x.id === y.id && x.content_sha256 === y.content_sha256
    );
  }
  return true;
}

// ---------- evaluateGrowth ----------
type Step = { readonly id: CheckId; readonly run: () => Promise<GrowthDeny | null> };

function parseOkResult(
  v: unknown,
  allowed: ReadonlySet<string>,
  fallback: GrowthDeny,
): GrowthDeny | null {
  const o = v as { ok?: unknown; code?: unknown } | null;
  if (typeof o !== 'object' || o === null) return fallback;
  if (o.ok === true) return null;
  if (o.ok === false && typeof o.code === 'string' && allowed.has(o.code)) {
    return o.code as GrowthDeny;
  }
  return fallback;
}

const BARRIER_CODES: ReadonlySet<string> = new Set<BarrierDeny>([
  'recovery_incomplete',
  'reconcile_incomplete',
  'store_unreadable',
  'store_full',
]);
const EXTRA_CODES: ReadonlySet<string> = new Set<ExtraDeny>([
  'near_fp_unavailable',
  'fp_key_unavailable',
  'creation_unready',
  'source_unknown',
  'purge',
  'recovery_incomplete',
]);
const REPO_CODES: ReadonlySet<string> = new Set(['repo']);

/** 各项的判定(纯映射;事实由 readers 当次现读)。返回首个失败码,全过返回 null */
function stepsOf(
  round: BothRound,
  req: GrowthReq,
  readers: GrowthReaders,
  p: OpProfile,
): readonly Step[] {
  const steps: Step[] = [];
  const add = (id: CheckId, run: () => Promise<GrowthDeny | null>): void => {
    steps.push({ id, run });
  };
  if (p.G1 === 'on') {
    add('G1', async () => ((await readers.capability(round, req)).ready === true ? null : 'phase'));
  }
  if (p.G2 === 'on') {
    add('G2', async () => {
      const f = await readers.config(round);
      return f.trusted === true && f.autoEnabled === true && f.confirmed === true ? null : 'config';
    });
  }
  add('G3', async () => {
    const f = await readers.state(round);
    if (f.valid !== true) return 'state_invalid';
    if (p.G3 === 'valid_only') return null;
    if (f.paused !== false) return 'paused';
    if (f.flags !== false) return 'flags';
    if (f.safetyFault !== false) return 'safety_fault';
    return null;
  });
  if (p.G4 === 'on')
    add('G4', async () => parseOkResult(await readers.repo(round), REPO_CODES, 'repo'));
  if (p.G5 === 'on') {
    add('G5', async () =>
      parseOkResult(await readers.barrier(round), BARRIER_CODES, 'store_unreadable'),
    );
  }
  if (p.G6 !== 'off') {
    add('G6', async () => {
      // 来源缺失一律拒绝增影响:与 reader 无关的纯判定(null / undefined / 缺键),也堵 W9「无提案就绕过裁决槽」
      if (p.G6 === 'cand') {
        const c = (req as CandidateReq).cand;
        if (c.source === null || c.source === undefined) return 'source_unknown';
      }
      const f = await readers.taint(round, req);
      if (f.capabilityReady !== true) return 'taint_unavailable';
      if (p.G6 === 'prereq') return null;
      if (f.scan === 'unavailable') return 'taint_unavailable';
      if (f.scan === 'pending') return 'taint_pending';
      if (f.scan !== 'ok') return 'taint_unavailable';
      // 跨信任边界:消费的布尔字段必须就是布尔(缺键 / 非布尔 = 事实不可信 = 拒绝,不得被解释成「不要求重扫」)
      if (typeof f.rescanRequired !== 'boolean' || typeof f.rescanned !== 'boolean') {
        return 'taint_unavailable';
      }
      if (f.rescanRequired && !f.rescanned) return 'taint_pending';
      if (p.G6 === 'rescan') return null;
      switch (f.candidate) {
        case 'clean':
          return null;
        case 'tainted':
          return 'taint_pending';
        case 'conflict':
          return 'taint_conflict';
        case 'unknown':
        case undefined:
        default:
          return 'source_unknown'; // 缺省 / 非法 = 来源查不实,拒绝
      }
    });
  }
  if (p.G7 !== 'off') {
    add('G7', async () => {
      const f = await readers.purge(round);
      if (f.capabilityReady !== true) return 'purge';
      if (p.G7 === 'prereq') return null;
      return f.journalPresent === false ? null : 'purge';
    });
  }
  if (p.G8 === 'on') {
    add('G8', async () => {
      const c = (req as CandidateReq).cand;
      const latched = judgeBlockedOf(round, c.id);
      if (latched !== null) return latched; // S2 的 blocked latch 并入(单调只加严)
      const v = normalizeJudgeVerdict(await readers.judge(round, req as CandidateReq));
      if (v === null) return 'judge_indeterminate';
      return v.ok ? null : v.code;
    });
  }
  if (p.G9 !== 'off') {
    add('G9', async () => ((await readers.throttle(round)).due === true ? null : 'throttled'));
  }
  if (p.G11 !== 'off') {
    add('G11', async () => {
      const f = await readers.admission(round, req);
      if (f.wired !== true) return 'admission';
      if (p.G11 === 'wired_only') return null;
      return f.effective === true && f.versionsMatch === true ? null : 'admission';
    });
  }
  if (p.extra === 'on') {
    add('extra', async () =>
      parseOkResult(await readers.extra(round, req), EXTRA_CODES, 'creation_unready'),
    );
  }
  return steps;
}

/** reader 抛错 → 拒绝码:失锁类单独处理(个人失锁 = `lock_lost`;rsi 失锁上抛);其余 = 该项的 fail-closed 码 */
function denyFromThrown(e: unknown, id: CheckId | 'G10'): GrowthDeny {
  if (e instanceof PersonalLockLost) return 'lock_lost';
  if (e instanceof RoundInternalError) throw e;
  if (isRsiLockLost(e)) throw e;
  return id === 'G10' ? 'lock_lost' : CHECK_FAILURE_CODE[id];
}

/**
 * 纯判定:返回**首个**失败码,或铸造一个 `GrowthPass`。顺序(优先级)钉死:
 *  0. 请求校验(畸形 = 抛 `RoundInternalError`)→ `inFlight` 必须为 0(否则抛 `RoundInternalError`,不是拒绝码);
 *  1. `growth_unwired`:stage 缺失 / `ops` 不含本 op(零 reader 调用)——**先于任何其它码**;
 *  2. G10 前置:`readers.locks` 个人失锁 / 其它错误 → `lock_lost`(rsi 失锁原样上抛);
 *  3. `unsettled`(本轮不能证明已收敛);
 *  4. 按 `OP_CHECK_PROFILE[op]` 取子集,依 G1 → G2 → G3 → G4 → G5 → G6 → G7 → G8 → G9 → G11 → D 专属 的顺序;
 *  5. G10 后置:再 `assertHeld` 一次,并要求评估期间 `gen` 未变、`inFlight` 仍为 0(否则抛 `RoundInternalError`:并发写 = 事实已过时),才铸造。
 * 永不为「读失败」放行:任何 reader 抛错 / 返回非法值 → 该项的 fail-closed 码(`CHECK_FAILURE_CODE`)。
 */
export async function evaluateGrowth(
  round: BothRound,
  req: GrowthReq,
  readers: GrowthReaders,
  stage: GrowthStage | undefined,
): Promise<GrowthVerdict> {
  const snap = snapshotReq(req);
  const op = opOfReq(snap);
  const st = roundInternals(round);
  if (st.form !== 'both') throw new RoundInternalError('round_not_both');
  if (st.inFlight !== 0) throw new RoundInternalError('mint_while_write_in_flight');
  const ops = stage?.ops;
  if (!(ops instanceof Set) || !ops.has(snap.op)) return growthDenied('growth_unwired');
  const genAtStart = st.gen;
  const lockCheck = async (): Promise<GrowthDeny | null> => {
    try {
      await readers.locks(round);
      return null;
    } catch (e) {
      return denyFromThrown(e, 'G10');
    }
  };
  const profile = OP_CHECK_PROFILE[snap.op];
  const pre = profile.G10 === 'on' ? await lockCheck() : null;
  if (pre !== null) return growthDenied(pre);
  if (st.unsettled.length > 0) return growthDenied('unsettled');
  for (const s of stepsOf(round, snap, readers, profile)) {
    let code: GrowthDeny | null;
    try {
      code = await s.run();
    } catch (e) {
      code = denyFromThrown(e, s.id);
    }
    if (code !== null) return growthDenied(code);
  }
  const post = profile.G10 === 'on' ? await lockCheck() : null;
  if (post !== null) return growthDenied(post);
  if (st.inFlight !== 0) throw new RoundInternalError('mint_while_write_in_flight');
  if (st.gen !== genAtStart) throw new RoundInternalError('write_during_evaluate');
  if (st.unsettled.length > 0) return growthDenied('unsettled');
  return mint(round, op, st.gen);
}

// ---------- requireGrowth ----------
function staleReason(
  pass: GrowthPass,
  round: BothRound,
  op: GrowthOp,
  needVetoMark: boolean,
): StaleGrowthReason | null {
  const rec = minted.get(pass);
  if (rec === undefined) return 'not_minted';
  if (rec.used) return 'already_used';
  if (pass.rsiNonce !== round.rsiNonce || pass.personalNonce !== round.personalNonce) {
    return 'nonce_mismatch';
  }
  if (rec.round !== round) return 'round_mismatch';
  if (pass.gen !== round.gen()) return 'gen_changed';
  if (!sameOp(pass.op, op)) return 'op_mismatch';
  if (round.unsettled().length > 0) return 'unsettled';
  if (needVetoMark && rec.vetoClearAtGen !== round.gen()) return 'veto_not_checked';
  return null;
}

function voidPass(pass: GrowthPass): void {
  const rec = minted.get(pass);
  if (rec !== undefined) rec.used = true;
}

/**
 * 外部否决事实的**现读**(B / U 标记、`state.auto_pause` 与标志、该候选的撤销凭据命中):D v4 §3.5 第 5 步。**消费的前置**:
 * `requireGrowth` 只认「同一个 `gen` 上已经过本函数现读且无否决」的 pass(否则 `veto_not_checked`),所以同步入口绕不过现读——不存在「缺检查版」的授权入口。
 * 先做不消费的同步校验(失败 = 作废并抛);再读;读抛错 / 非法值 → `veto_unreadable`;`vetoed: true` → `vetoed`;三者都使 pass 作废。`lock_lost` 类错误原样上抛(pass 同样作废)。
 * 读与消费之间若有写,`gen` 变化 → 消费时 `gen_changed`(现读不能掩盖其后的写)。
 */
export async function checkGrowthVeto(
  pass: GrowthPass,
  round: BothRound,
  op: GrowthOp,
  readers: Pick<GrowthReaders, 'externalVeto'>,
): Promise<void> {
  const early = staleReason(pass, round, op, false);
  if (early !== null) {
    voidPass(pass);
    throw new StaleGrowth(early);
  }
  let v: VetoFact;
  try {
    v = await readers.externalVeto(round, op);
  } catch (e) {
    voidPass(pass);
    if (e instanceof PersonalLockLost || isRsiLockLost(e)) throw e;
    throw new StaleGrowth('veto_unreadable');
  }
  const o = v as { vetoed?: unknown } | null;
  if (typeof o !== 'object' || o === null || (o.vetoed !== false && o.vetoed !== true)) {
    voidPass(pass);
    throw new StaleGrowth('veto_unreadable');
  }
  if (o.vetoed === true) {
    voidPass(pass);
    throw new StaleGrowth('vetoed');
  }
  const rec = minted.get(pass);
  if (rec === undefined || rec.used) throw new StaleGrowth('already_used'); // 读期间被并发消费
  rec.vetoClearAtGen = round.gen();
}

/**
 * 一次性消费(每个不可逆写的提交边界前调;D v4 §3.5 第 6 步)。**成败都使 pass 作废**(至多服务一次写)。
 * 抛 `StaleGrowth`:非本模块铸造 / 已用过 / nonce 不等 / 非同一回合 / `gen` 已变 / op 不等(换候选或换能力)/ 回合未决 / 本 gen 上未经 `checkGrowthVeto`。
 * 同步纯检查,不做 I/O(外部否决事实的现读在 `checkGrowthVeto`,它是本函数的前置)。
 */
export function requireGrowth(pass: GrowthPass, round: BothRound, op: GrowthOp): void {
  const why = staleReason(pass, round, op, true);
  voidPass(pass);
  if (why !== null) throw new StaleGrowth(why);
}

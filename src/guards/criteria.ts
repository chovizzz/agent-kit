import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { addDays } from '../atoms/dates.js';
import { parseRestrictedYaml } from '../atoms/frontmatter.js';
import { fileStem } from '../atoms/parse.js';
import { AttestSchema, attestFileName, type Attest } from '../contracts/attest.js';
import {
  KitConfigSchema,
  STRICT_EXTRA_TILES,
  LifecycleCoreConfigSchema,
  type LifecycleCoreConfig,
} from '../contracts/config.js';
import type { Diagnostic } from '../contracts/diagnostics.js';
import { LifecycleRecordSchema, lifecycleFileName } from '../contracts/lifecycle.js';
import type { LifecycleRecord } from '../contracts/lifecycle.js';
import { ProposalSchema, type AcceptanceProtocol, type Proposal } from '../contracts/proposal.js';
import { deriveVendor, isCrossVendor } from '../contracts/vendor.js';
import { canonicalJson } from '../io/canonical-json.js';
import { acceptanceSha256, guidanceSha256, signatureSha256 } from '../judge/freeze.js';
import { acceptanceD0, classifyTile, requiredValidTiles } from '../lifecycle/attest-count.js';
import { computeCalibration } from '../lifecycle/calibration.js';
import { checkC5, ruleSha256 } from '../lifecycle/checks.js';
import { createRedactor } from '../redact/redactor.js';
import { scanDangerousPhrases } from '../reflect/validate.js';
import { hasInvisible } from '../reflect/text.js';
import { err } from './diff.js';
import { GitError } from './git.js';
import { isAtomPath } from './paths.js';
import type { CriteriaChecker, CriteriaInput, GuardGit } from './types.js';
import { statusOf, viewAtom } from './view.js';

/**
 * G3 的真判据(L2,设计 §1 状态机 T1–T6 / §3 / §4)。纯函数:只经 `CriteriaInput` 读两棵树与 git,不读盘不写盘不联网。
 * 阈值与成员表**取自基线**的 kit.toml(PR 即使改了 kit.toml 也放不宽;G3 本身也会因改了别的文件而红)。
 *
 * 诊断码(全部 GUARD_G3_ 前缀,稳定):
 *  通用:ATOM_UNREADABLE
 *  晋升共用:LAYER_NOT_TEAM PROPOSAL_MISSING PROPOSAL_INVALID JUDGE_PENDING JUDGE_MISSING JUDGE_NOT_ACCEPT JUDGE_INJECTION
 *    NOT_CROSS_VENDOR JUDGE_HOP_MISMATCH REFLECTOR_UNVERIFIABLE REFLECTOR_STUB RULE_HASH_UNCOMPUTABLE RULE_HASH_MISSING
 *    RULE_HASH_MISMATCH RESCAN_DIRTY REDACTION_RESIDUAL PROPOSAL_MISMATCH FIXED_FIELDS
 *  T2:SIGNATURE_MISSING CONFIG_UNREADABLE ADVISORY_SINCE_UNKNOWN TEXT_SINCE_UNKNOWN ATTEST_INVALID ATTEST_RUN_ID_SHAPE
 *    ATTEST_AMBIGUOUS_LATEST ATTEST_OVERLAP THRESHOLD_TILES THRESHOLD_EXPOSURE THRESHOLD_HARMFUL
 *  T2 冻结核验(K4,docs/contracts.md §18.9):ACCEPTANCE_MISSING ACCEPTANCE_HASH_MISMATCH ACCEPTANCE_CLOCK_INCONSISTENT
 *    ACCEPTANCE_CHANGED_AFTER_FREEZE PREDICTION_CHANGED_AFTER_FREEZE ACCEPTANCE_WEAKER_THAN_CORE FREEZE_COMMIT_UNKNOWN
 *  T2 校准加严(K5a,docs/contracts.md §18.10;严重度 warn = 提示,不计入失败):JUDGE_OVERCONFIDENT CALIBRATION_INSUFFICIENT
 *    CALIBRATION_UNAVAILABLE CALIBRATION_ITEM_UNREADABLE(后两者与 JUDGE_OVERCONFIDENT 一样令 THRESHOLD_TILES 多要 STRICT_EXTRA_TILES 块)
 *  退役:LIFECYCLE_RECORD_MISSING LIFECYCLE_RECORD_AMBIGUOUS LIFECYCLE_RECORD_INVALID LIFECYCLE_RECORD_MISMATCH
 *    RECORD_DIGESTS REASON_NOT_EXPIRED REASON_BY_INVALID REASON_NO_EXPOSURE_UNMET REASON_NOT_HARMFUL COOLDOWN_NOT_MET
 *  warn(不计入失败):ATTEST_NOT_COUNTED ACCEPTANCE_REFROZEN
 *
 * 🔴 已知缺口(如实记录):
 *  - 没有签名/创建者校验:attest 计数、judge 记录、lifecycle 记录都是 PR 里的普通文件,造假靠 CODEOWNERS/四眼(P1-D)。
 *  - `deprecated→retired` 的冷却依赖 stable tag,继承 GD-3:本地可写的注解 tag 可伪造(P1 CI 须改服务端受保护 tag / verify-tag)。
 *  - 窗口日期、`recorded_at`、「转为 advisory 的日期」(取提交者日期)都是作者可写的数据,不是可信时钟。
 *  - 预算("不超")不在 G3 判据里(由 `check --budget` 与 promote 的 out/ 进出清单承担)。
 */

const RUN_ID_RE = /^run-(\d{8}T\d{6}Z)-([0-9a-f]{6})$/;
const PROPOSAL_ORIGIN_RE = /^proposal\/(\d{4}-\d{2}-\d{2}-\d{3})$/;

const warn = (code: string, path: string, message: string): Diagnostic => ({
  code,
  severity: 'warn',
  path,
  message,
});
const e = (code: string, path: string, message: string): Diagnostic =>
  err(`GUARD_G3_${code}`, path, message);

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * 规则文本哈希:与 L1 的 C6(`ruleSha256`)、attest 的 `normalizedRuleSha256` 是**同一个实现**(`lifecycle/checks.ts`),
 * 三处口径不一致会让 judge 写入的哈希在 CI 重算时对不上。无法归一化时返回 undefined(调用方 fail-closed)。
 */
export function normalizedRuleSha256(source: string): string | undefined {
  try {
    return ruleSha256(source);
  } catch {
    return undefined;
  }
}

interface Lifecycle {
  cfg: LifecycleCoreConfig;
  /** canary 成员表:handle(小写)→ since */
  roster: Map<string, string | undefined>;
}

function loadLifecycle(i: CriteriaInput): Lifecycle | Diagnostic {
  const bad = (m: string): Diagnostic => e('CONFIG_UNREADABLE', 'kit.toml', m);
  const text = i.baseView('kit.toml');
  if (text === undefined) return bad('基线里没有 kit.toml,读不到阈值与 canary 成员表');
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch {
    return bad('基线 kit.toml 无法解析');
  }
  const parsed = KitConfigSchema.safeParse(raw);
  if (!parsed.success) return bad('基线 kit.toml 未通过 KitConfigSchema');
  const roster = new Map<string, string | undefined>();
  for (const [h, m] of Object.entries(parsed.data.channels.canary.members)) {
    roster.set(h.toLowerCase(), m.since);
  }
  return { cfg: parsed.data.lifecycle ?? LifecycleCoreConfigSchema.parse({}), roster };
}

/** 原子转为 advisory(或其后 active)的连续区间起点日期(提交者日期);查不出返回 undefined */
function advisorySince(i: CriteriaInput, atomPath: string): string | undefined {
  let since: string | undefined;
  for (const h of i.git.fileHistory(i.baseOid, atomPath)) {
    const text = i.git.textAt(h.commit, atomPath);
    const st = text === undefined ? undefined : statusOf(viewAtom(text, atomPath));
    if (st === 'advisory' || st === 'active') since = h.date;
    else break;
  }
  return since;
}

interface AttestItem {
  path: string;
  digest: string;
  a: Attest;
}

/** 读 head 树 attest/<id>/ 下全部文件:结构不合法 → error;同 (成员,窗口) 只留 run_id 时间戳最新的一份 */
function loadAttests(i: CriteriaInput, id: string): { items: AttestItem[]; diags: Diagnostic[] } {
  const diags: Diagnostic[] = [];
  const parsed: AttestItem[] = [];
  for (const p of i.listHead(`attest/${id}`)) {
    const text = i.headView(p);
    let json: unknown;
    try {
      json = text === undefined ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    const res = AttestSchema.safeParse(json);
    if (!res.success || text === undefined) {
      diags.push(e('ATTEST_INVALID', p, 'attest 文件不是合法 JSON 或未通过 AttestSchema'));
      continue;
    }
    const a = res.data;
    if (a.rule_id !== id || p !== `attest/${id}/${attestFileName(a)}`) {
      diags.push(e('ATTEST_INVALID', p, 'attest 的 rule_id / 文件名与内容不一致'));
      continue;
    }
    if (!RUN_ID_RE.test(a.run_id)) {
      diags.push(
        e('ATTEST_RUN_ID_SHAPE', p, 'attest 的 run_id 不是 run-<UTC 时间戳>-<6 位十六进制>'),
      );
      continue;
    }
    parsed.push({ path: p, digest: `sha256:${sha256Hex(text)}`, a });
  }
  const groups = new Map<string, AttestItem[]>();
  for (const it of parsed) {
    const k = `${it.a.member.toLowerCase()}|${it.a.window_start}|${it.a.window_end}`;
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  const items: AttestItem[] = [];
  for (const g of groups.values()) {
    const stamp = (it: AttestItem): string => RUN_ID_RE.exec(it.a.run_id)![1]!;
    const newest = g.reduce((m, it) => (stamp(it) > stamp(m) ? it : m));
    const tied = g.filter((it) => stamp(it) === stamp(newest));
    if (tied.length > 1) {
      diags.push(
        e(
          'ATTEST_AMBIGUOUS_LATEST',
          newest.path,
          '同一成员同一窗口有多份 run_id 时间戳相同的 attest,无法判定最新',
        ),
      );
      continue;
    }
    items.push(newest);
  }
  // 同一成员的不同窗口不得重叠:窗口摘要不含会话集合,重叠部分的曝光会被重复累计(把同一批会话切成多个窗口就能刷过阈值)
  const byMember = new Map<string, AttestItem[]>();
  for (const it of items) {
    const k = it.a.member.toLowerCase();
    byMember.set(k, [...(byMember.get(k) ?? []), it]);
  }
  const dropped = new Set<AttestItem>();
  for (const list of byMember.values()) {
    list.sort((x, y) =>
      x.a.window_start < y.a.window_start ? -1 : x.a.window_start > y.a.window_start ? 1 : 0,
    );
    let prevEnd: string | undefined;
    for (const it of list) {
      if (prevEnd !== undefined && it.a.window_start <= prevEnd) {
        diags.push(
          e(
            'ATTEST_OVERLAP',
            it.path,
            '同一成员有窗口互相重叠的 attest,重叠部分的曝光会被重复累计',
          ),
        );
        dropped.add(it);
      } else {
        prevEnd = it.a.window_end;
      }
    }
  }
  return { items: items.filter((it) => !dropped.has(it)), diags };
}

/** 计入口径:canary 渠道、成员在名单内(且不早于 since)、规则哈希与当前一致、声明了 method、窗口不早于转 advisory 之日 */
function countable(
  items: readonly AttestItem[],
  lc: Lifecycle,
  ruleSha: string,
  since: string,
): { kept: AttestItem[]; diags: Diagnostic[] } {
  const kept: AttestItem[] = [];
  const diags: Diagnostic[] = [];
  for (const it of items) {
    const a = it.a;
    const memberSince = lc.roster.get(a.member.toLowerCase());
    let why: string | undefined;
    if (a.channel !== 'canary') why = 'channel 不是 canary';
    else if (!lc.roster.has(a.member.toLowerCase())) why = '成员不在 canary 成员表';
    else if (memberSince !== undefined && a.window_start < memberSince)
      why = '窗口早于成员加入日期';
    else if (a.rule_sha256 !== ruleSha) why = 'rule_sha256 与当前规则文本不一致';
    else if (a.method !== 'signature_proxy_v1') why = '未声明 method=signature_proxy_v1';
    else if (a.window_start < since) why = '窗口早于原子转为 advisory 的日期';
    if (why === undefined) kept.push(it);
    else diags.push(warn('GUARD_G3_ATTEST_NOT_COUNTED', it.path, `不计入:${why}`));
  }
  return { kept, diags };
}

interface AtomCtx {
  path: string;
  id: string;
  fm: Readonly<Record<string, unknown>>;
  text: string;
  ruleSha: string | undefined;
}

// ───────────────────────── K4:冻结验收协议的核验(设计 §2.3–§2.5,docs/contracts.md §18.9) ─────────────────────────

/** git 本身失败(浅克隆缺对象、oid 不存在等)一律按「查不出」处理,由调用方 fail-closed;其他异常照常抛。 */
function tryGit<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch (x) {
    if (x instanceof GitError) return undefined;
    throw x;
  }
}

const canon = (v: unknown): string | undefined => {
  try {
    return canonicalJson(v ?? null);
  } catch {
    return undefined;
  }
};

interface JudgeParts {
  acceptance: unknown;
  prediction: unknown;
}

/** 从提案 yaml 文本里取 `judge.acceptance` / `judge.prediction` 的原始值(不经 schema,历史版本也能读) */
function judgeParts(text: string | undefined, pp: string): JudgeParts | undefined {
  if (text === undefined) return undefined;
  const y = parseRestrictedYaml(text, pp, 'GUARD_PROPOSAL_YAML');
  if (!y.ok || typeof y.value !== 'object' || y.value === null) return undefined;
  const judge = (y.value as { judge?: unknown }).judge;
  if (typeof judge !== 'object' || judge === null)
    return { acceptance: undefined, prediction: undefined };
  const j = judge as { acceptance?: unknown; prediction?: unknown };
  return { acceptance: j.acceptance, prediction: j.prediction };
}

/**
 * 当前规则文本(归一化哈希 == `ruleSha`)首次进入仓库的提交日期:从 `commitOid` 往回,取「连续等于当前哈希」的最老一个提交的日期。
 * 状态(proposed→advisory→active)不进哈希,所以只改状态的提交不会重置它;改了正文再改回来,取最近一次回到当前文本的那次。
 * 查不出(历史为空 / 最新一版就不等于当前哈希 / git 失败)→ undefined,调用方 fail-closed(`TEXT_SINCE_UNKNOWN`)。
 */
export function textSince(
  git: GuardGit,
  commitOid: string,
  atomPath: string,
  ruleSha: string,
): string | undefined {
  const hist = tryGit(() => git.fileHistory(commitOid, atomPath));
  if (hist === undefined) return undefined;
  let since: string | undefined;
  for (const h of hist) {
    const text = tryGit(() => git.textAt(h.commit, atomPath));
    const sha = text === undefined ? undefined : normalizedRuleSha256(text);
    if (sha === ruleSha) since = h.date;
    else break;
  }
  return since;
}

export interface FreezeLocation {
  /** 冻结提交:当前 `judge.acceptance` 首次(连续)出现在提案文件里的那次提交 */
  commit: string;
  /** 冻结提交的提交者日期 YYYY-MM-DD */
  date: string;
  /** 冻结提交里的 prediction 与 head 的 prediction 是否 canonical 相等 */
  predictionSame: boolean;
  /** 冻结提交之前的历史里,「同一份规则文本(acceptance.rule_sha256 相同)但 acceptance 内容不同」的版本数(重新冻结次数) */
  refrozen: number;
  /** 冻结提交之前最近一次改动提案的提交(没有 = 提案在冻结提交里首次入库) */
  prev: string | undefined;
  /** 冻结提交没有父提交:根提交,或浅克隆的边界(此时它只是「历史截断处」,不是真正引入 acceptance 的提交) */
  parentless: boolean;
}

/**
 * 定位冻结提交(attest --tile 与 G3 共用)。`commitOid` 是要看的头(G3 传 headOid,attest 传 HEAD)。
 * 从新到旧扫描 `fileHistory(commitOid, 提案路径)`:连续与 `commitOid` 版本 acceptance(canonical JSON)相等的提交构成一段,
 * 这一段里最老的就是冻结提交。找不到(提案里没有 acceptance、历史为空、git 失败)→ undefined。
 */
export function locateFreezeCommit(
  git: GuardGit,
  commitOid: string,
  proposalPath: string,
): FreezeLocation | undefined {
  const head = judgeParts(
    tryGit(() => git.textAt(commitOid, proposalPath)),
    proposalPath,
  );
  const headAcc = canon(head?.acceptance);
  if (head === undefined || head.acceptance === undefined || headAcc === undefined)
    return undefined;
  const hist = tryGit(() => git.fileHistory(commitOid, proposalPath));
  if (hist === undefined) return undefined;
  const ruleOf = (acc: unknown): unknown =>
    typeof acc === 'object' && acc !== null
      ? (acc as { rule_sha256?: unknown }).rule_sha256
      : undefined;
  let runEnd = -1;
  for (let n = 0; n < hist.length; n++) {
    const parts = judgeParts(
      tryGit(() => git.textAt(hist[n]!.commit, proposalPath)),
      proposalPath,
    );
    if (parts !== undefined && canon(parts.acceptance) === headAcc) runEnd = n;
    else break;
  }
  if (runEnd < 0) return undefined;
  const freeze = hist[runEnd]!;
  const atFreeze = judgeParts(
    tryGit(() => git.textAt(freeze.commit, proposalPath)),
    proposalPath,
  );
  let refrozen = 0;
  for (const h of hist.slice(runEnd + 1)) {
    const parts = judgeParts(
      tryGit(() => git.textAt(h.commit, proposalPath)),
      proposalPath,
    );
    if (
      parts?.acceptance !== undefined &&
      ruleOf(parts.acceptance) === ruleOf(head.acceptance) &&
      canon(parts.acceptance) !== headAcc
    ) {
      refrozen++;
    }
  }
  return {
    commit: freeze.commit,
    date: freeze.date,
    predictionSame: canon(atFreeze?.prediction) === canon(head.prediction),
    refrozen,
    prev: hist[runEnd + 1]?.commit,
    parentless: tryGit(() => git.isAncestor(`${freeze.commit}^`, freeze.commit)) !== true,
  };
}

interface Frozen {
  acc: AcceptanceProtocol;
  commit: string;
  /** D0:验收窗口锚点(UTC 日) */
  d0: string;
}

/** 冻结三层核验。失败返回全部诊断;通过返回冻结上下文。调用方保证 `pr.judge` 存在、`a.ruleSha` 可算。 */
function verifyFreeze(
  i: CriteriaInput,
  a: AtomCtx,
  pr: Proposal,
  lc: Lifecycle,
): { frozen: Frozen; diags: Diagnostic[] } | { diags: Diagnostic[] } {
  const pp = `proposals/${pr.id}.yaml`;
  const j = pr.judge!;
  const acc = j.acceptance;
  if (acc === undefined) {
    return {
      diags: [
        e(
          'ACCEPTANCE_MISSING',
          pp,
          '提案没有冻结的验收协议(judge.acceptance);请先重跑 `agent-kit judge` 补冻结,再走晋升',
        ),
      ],
    };
  }
  const diags: Diagnostic[] = [];
  const bad = (code: string, msg: string): void => {
    diags.push(e(code, pp, msg));
  };

  // 层 1:内容哈希
  if (acceptanceSha256(acc) !== acc.sha256)
    bad('ACCEPTANCE_HASH_MISMATCH', 'acceptance.sha256 与内容重算的哈希不符');
  if (j.prediction === undefined) {
    bad('ACCEPTANCE_HASH_MISMATCH', 'judge.prediction 缺失,无法绑定冻结协议');
  } else if (j.prediction.acceptance_sha256 !== acc.sha256) {
    bad('ACCEPTANCE_HASH_MISMATCH', 'prediction.acceptance_sha256 与 acceptance.sha256 不一致');
  }
  if (acc.rule_sha256 !== j.rule_sha256 || acc.rule_sha256 !== a.ruleSha) {
    bad(
      'ACCEPTANCE_HASH_MISMATCH',
      'acceptance.rule_sha256 与 judge.rule_sha256 / 当前规则文本不一致',
    );
  }
  const sig = a.fm['signature'];
  const sigArg =
    typeof sig === 'object' && sig !== null && typeof (sig as { type?: unknown }).type === 'string'
      ? {
          type: (sig as { type: string }).type,
          ...(typeof (sig as { pattern?: unknown }).pattern === 'string'
            ? { pattern: (sig as { pattern: string }).pattern }
            : {}),
        }
      : undefined;
  if (acc.signature_sha256 !== signatureSha256(sigArg)) {
    bad(
      'ACCEPTANCE_HASH_MISMATCH',
      'acceptance.signature_sha256 与当前原子签名不符(签名改了须重新提案/重新 judge)',
    );
  }
  const g = pr.reflector.guidance;
  if (acc.baseline_sha256 !== guidanceSha256(g)) {
    bad('ACCEPTANCE_HASH_MISMATCH', 'acceptance.baseline_sha256 与 reflector.guidance 的哈希不符');
  }
  if (g !== undefined) {
    if (
      g.baseline.exposure_sessions > g.baseline.sessions_total ||
      g.baseline.exposure_sessions > g.baseline.fired
    ) {
      bad(
        'ACCEPTANCE_HASH_MISMATCH',
        'reflector.guidance.baseline 不自洽(exposure_sessions 超过 sessions_total 或 fired)',
      );
    }
    if (g.until !== acc.guidance_until) {
      bad(
        'ACCEPTANCE_HASH_MISMATCH',
        'acceptance.guidance_until 与 reflector.guidance.until 不一致',
      );
    }
  }

  // 层 3:冻结值不得弱于基线 kit.toml 的现值
  if (acc.tile_days < lc.cfg.acceptance_tile_days || acc.max_tiles > lc.cfg.acceptance_max_tiles) {
    bad(
      'ACCEPTANCE_WEAKER_THAN_CORE',
      `冻结值 tile_days=${acc.tile_days}/max_tiles=${acc.max_tiles} 弱于基线 kit.toml 的 ${lc.cfg.acceptance_tile_days}/${lc.cfg.acceptance_max_tiles}`,
    );
  }

  // 层 2:git 锚点。历史一律从**基线**取(不从 head 取):PR 作者能用合并提交的父顺序操纵 head 侧的路径历史简化。
  const baseParts = judgeParts(i.baseView(pp), pp);
  const headParts = judgeParts(i.headView(pp), pp);
  if (
    baseParts?.acceptance !== undefined &&
    canon(baseParts.acceptance) !== canon(headParts?.acceptance)
  ) {
    bad('ACCEPTANCE_CHANGED_AFTER_FREEZE', '晋升 PR 改动了基线里已冻结的 judge.acceptance');
  }
  if (baseParts !== undefined && canon(baseParts.prediction) !== canon(headParts?.prediction)) {
    bad('PREDICTION_CHANGED_AFTER_FREEZE', '晋升 PR 改动了基线里的 judge.prediction');
  }
  const loc =
    baseParts?.acceptance === undefined ? undefined : locateFreezeCommit(i.git, i.baseOid, pp);
  if (loc === undefined) {
    bad('FREEZE_COMMIT_UNKNOWN', '基线历史里找不到冻结提交(提案没有冻结、历史被改写或浅克隆)');
  } else {
    if (loc.parentless) {
      bad(
        'FREEZE_COMMIT_UNKNOWN',
        '冻结提交没有父提交(根提交或浅克隆边界),无法确认 acceptance 首次入库的位置',
      );
    }
    if (tryGit(() => i.git.isAncestor(loc.commit, i.baseOid)) !== true) {
      bad('FREEZE_COMMIT_UNKNOWN', '冻结提交不是基线提交的祖先(冻结必须已合进主线)');
    }
    const judgedOk = tryGit(
      () =>
        acc.judged_at_head !== loc.commit &&
        i.git.isAncestor(acc.judged_at_head, loc.commit) &&
        // judge 运行时提案上一版若已入库,judged_at_head 不得早于它(否则填个根提交就能满足上面的祖先检查)
        (loc.prev === undefined || i.git.isAncestor(loc.prev, acc.judged_at_head)),
    );
    if (judgedOk !== true) {
      bad(
        'ACCEPTANCE_CLOCK_INCONSISTENT',
        'judged_at_head 不是冻结提交的严格祖先(或早于提案上一版、或不在本仓库历史里)',
      );
    }
    if (!loc.predictionSame) {
      bad('PREDICTION_CHANGED_AFTER_FREEZE', '冻结提交之后 judge.prediction 被改过');
    }
    const untilMs = Date.parse(acc.guidance_until);
    const frozenMs = Date.parse(acc.frozen_at);
    // fileHistory 只给提交者本地日期:容忍 1 天的时区差,仍挡住「纸面时钟晚于提交」
    const frozenDay = Number.isNaN(frozenMs) ? '' : new Date(frozenMs).toISOString().slice(0, 10);
    if (
      Number.isNaN(untilMs) ||
      Number.isNaN(frozenMs) ||
      untilMs > frozenMs ||
      frozenDay > addDays(loc.date, 1)
    ) {
      bad(
        'ACCEPTANCE_CLOCK_INCONSISTENT',
        '时钟交叉核对不过:需 guidance_until ≤ frozen_at ≤ 冻结提交日期(容忍 1 天时区差)',
      );
    }
    if (loc.refrozen > 0) {
      diags.push(
        warn(
          'GUARD_G3_ACCEPTANCE_REFROZEN',
          pp,
          `同一份规则文本此前已被冻结过 ${loc.refrozen} 次(重跑 judge);旧协议下的 attest 不计入,校准账须以第一份预测为准`,
        ),
      );
    }
  }
  if (loc === undefined || diags.some((d) => d.severity === 'error')) return { diags };
  return { frozen: { acc, commit: loc.commit, d0: acceptanceD0(acc, loc.date) }, diags };
}

type FrozenItem = AttestItem & { k: number };

/**
 * T2 的计入口径(新增,不改 `countable`):`countable` 的全部条件 + 冻结协议的分块条件。
 * 不满足的记 warn `ATTEST_NOT_COUNTED`(附原因),即以「不计入」实现 fail-closed。
 */
function frozenCountable(
  i: CriteriaInput,
  id: string,
  items: readonly AttestItem[],
  lc: Lifecycle,
  ruleSha: string,
  since: string,
  textSinceDate: string,
  fr: Frozen,
): { kept: FrozenItem[]; diags: Diagnostic[] } {
  const base = countable(items, lc, ruleSha, since);
  const baseFiles = new Set(i.listBase(`attest/${id}`));
  const diags = [...base.diags];
  const kept: FrozenItem[] = [];
  for (const it of base.kept) {
    const a = it.a;
    let why: string | undefined;
    let k = -1;
    const cls = classifyTile(
      fr.d0,
      fr.acc.tile_days,
      fr.acc.max_tiles,
      a.window_start,
      a.window_end,
    );
    if (a.acceptance_sha256 !== fr.acc.sha256) {
      why = 'acceptance_sha256 缺失或与冻结协议不符';
    } else if (!cls.ok) {
      why = cls.reason;
    } else if (a.window_start < textSinceDate) {
      why = '窗口早于当前规则文本进入仓库的日期(textSince)';
    } else {
      k = cls.k;
      const from = baseFiles.has(it.path) ? i.baseOid : i.headOid;
      const hist = tryGit(() => i.git.fileHistory(from, it.path));
      const intro = hist === undefined ? undefined : hist[hist.length - 1];
      const after =
        intro !== undefined &&
        intro.commit !== fr.commit &&
        tryGit(() => i.git.isAncestor(fr.commit, intro.commit)) === true;
      if (!after) {
        why = 'attest 的首次入库提交不晚于冻结提交(或查不出)';
      } else if (a.window_end > addDays(intro.date, 1)) {
        // 提交者日期是作者可写数据,只能挡诚实的「预先提交未来窗口」;容忍 1 天时区差
        why = 'attest 的入库日期早于窗口结束(预先提交了未来窗口)';
      }
    }
    if (why === undefined) kept.push({ ...it, k });
    else diags.push(warn('GUARD_G3_ATTEST_NOT_COUNTED', it.path, `不计入:${why}`));
  }
  return { kept, diags };
}

function loadAtom(i: CriteriaInput): AtomCtx | Diagnostic[] {
  const p = i.transition.path;
  const text = i.headView(p);
  const v = text === undefined ? undefined : viewAtom(text, p);
  if (text === undefined || v === undefined || !v.ok) {
    return [e('ATOM_UNREADABLE', p, '头部版本的原子无法读取')];
  }
  const id = v.fm['id'];
  if (typeof id !== 'string' || id !== fileStem(p)) {
    return [e('ATOM_UNREADABLE', p, '原子 id 缺失或与文件名不一致')];
  }
  return { path: p, id, fm: v.fm, text, ruleSha: normalizedRuleSha256(text) };
}

function loadProposal(
  i: CriteriaInput,
  a: AtomCtx,
): { proposal: Proposal; diags: Diagnostic[] } | { diags: Diagnostic[] } {
  const origin = a.fm['origin'];
  const m = typeof origin === 'string' ? PROPOSAL_ORIGIN_RE.exec(origin) : null;
  if (m === null) {
    return {
      diags: [e('PROPOSAL_MISSING', a.path, '原子没有 origin=proposal/<id>,找不到评审记录')],
    };
  }
  const pp = `proposals/${m[1]!}.yaml`;
  const text = i.headView(pp);
  if (text === undefined) return { diags: [e('PROPOSAL_MISSING', pp, '提案文件不在头部树里')] };
  const y = parseRestrictedYaml(text, pp, 'GUARD_PROPOSAL_YAML');
  const res = y.ok ? ProposalSchema.safeParse(y.value) : undefined;
  if (res === undefined || !res.success || res.data.id !== m[1]) {
    return {
      diags: [
        e('PROPOSAL_INVALID', pp, '提案无法解析、未通过 ProposalSchema 或 id 与文件名不一致'),
      ],
    };
  }
  const pr = res.data;
  const atomEv = Array.isArray(a.fm['evidence']) ? (a.fm['evidence'] as unknown[]) : [];
  const evOk =
    atomEv.length === pr.evidence.length &&
    pr.evidence.every((pe, n) => {
      const ae = atomEv[n];
      if (typeof ae !== 'object' || ae === null) return false;
      const x = ae as { ref?: unknown; excerpt?: unknown };
      return x.ref === pe.sig && x.excerpt === pe.excerpt;
    });
  if (!pr.targets.includes(a.id) || pr.layer !== a.fm['layer'] || !evOk) {
    return {
      diags: [
        e(
          'PROPOSAL_MISMATCH',
          pp,
          '提案与原子对不上:targets 不含本原子 id、layer 不一致,或证据(sig/摘录)与原子 evidence 不是一一对应',
        ),
      ],
    };
  }
  return { proposal: pr, diags: [] };
}

/** hasInvisible 尚未覆盖的字符(设计 C1b:变体选择符补充区、ALM、Hangul 填充);L1 的完整集合落地后可去重 */
const EXTRA_INVISIBLE_RE = /[\u{E0100}-\u{E01EF}\u061C\uFE00-\uFE0F\u3164\u115F\u1160\uFFA0]/u;
/** C8 脱敏复扫:默认配置(不含覆盖层的敏感词表);超时放宽到 2s 避免负载下误判,异常/超限一律按不干净处理 */
const redactor = createRedactor({ timeout_ms: 2000 });

/** C1 + C8:原子文本字段与提案 rationale 的本地重扫(话术表 + 不可见字符)。judge 的 injection_suspected=false 不作放行依据。 */
function rescan(a: AtomCtx, p: Proposal): Diagnostic[] {
  const v = viewAtom(a.text, a.path);
  const fields: [string, string][] = [['rationale', p.rationale]];
  if (v.ok) {
    fields.push(['body', v.body]);
    if (typeof v.fm['title'] === 'string') fields.push(['title', v.fm['title']]);
    const sig = v.fm['signature'];
    if (typeof sig === 'object' && sig !== null && 'pattern' in sig) {
      const pat = (sig as { pattern: unknown }).pattern;
      if (typeof pat === 'string') fields.push(['signature.pattern', pat]);
    }
    const ev = v.fm['evidence'];
    if (Array.isArray(ev)) {
      ev.forEach((x: unknown, n) => {
        const ex =
          typeof x === 'object' && x !== null ? (x as { excerpt?: unknown }).excerpt : undefined;
        if (typeof ex === 'string') fields.push([`evidence[${n}].excerpt`, ex]);
      });
    }
  }
  const bad = fields
    .filter(
      ([, t]) =>
        hasInvisible(t) || EXTRA_INVISIBLE_RE.test(t) || scanDangerousPhrases(t).blocked.length > 0,
    )
    .map(([n]) => n);
  const residual = fields
    .filter(([, t]) => {
      try {
        return !redactor.pass2(t).clean;
      } catch {
        return true;
      }
    })
    .map(([n]) => n);
  const out: Diagnostic[] = [];
  if (bad.length > 0) {
    out.push(e('RESCAN_DIRTY', a.path, `本地重扫命中危险话术/不可见字符的字段:${bad.join(', ')}`));
  }
  if (residual.length > 0) {
    out.push(
      e('REDACTION_RESIDUAL', a.path, `脱敏复扫残留(或扫描失败)的字段:${residual.join(', ')}`),
    );
  }
  return out;
}

const C5_EXTRA_REASONS: ReadonlySet<string> = new Set([
  'JUDGE_PROVIDER_MISMATCH',
  'JUDGE_LAST_HOP_NOT_OK',
  'JUDGE_VENDOR_UNPROVEN',
  'VENDOR_OVERRIDES_INVALID',
]);

function judgeChecks(a: AtomCtx, pr: Proposal): Diagnostic[] {
  const out: Diagnostic[] = [];
  const j = pr.judge;
  if (j === undefined) {
    out.push(
      pr.judge_attempts !== undefined
        ? e('JUDGE_PENDING', a.path, '提案只有 judge_attempts(评审未成功),不得晋升')
        : e('JUDGE_MISSING', a.path, '提案没有 judge 记录'),
    );
  } else {
    if (j.verdict !== 'accept')
      out.push(e('JUDGE_NOT_ACCEPT', a.path, `judge.verdict=${j.verdict}`));
    if (j.injection_suspected) out.push(e('JUDGE_INJECTION', a.path, 'judge 标记了疑似注入'));
    if (!isCrossVendor(pr.reflector.vendor, j.vendor)) {
      out.push(e('NOT_CROSS_VENDOR', a.path, '裁判与反思器的厂商不可证明不同'));
    }
    const last = j.hops[j.hops.length - 1];
    if (last === undefined || last.vendor !== j.vendor) {
      out.push(e('JUDGE_HOP_MISMATCH', a.path, 'judge.vendor 与最后一跳的厂商不一致'));
    }
    if (j.rule_sha256 === undefined) {
      out.push(
        e('RULE_HASH_MISSING', a.path, 'judge 记录没有 rule_sha256,无法绑定评审时的规则文本'),
      );
    } else if (a.ruleSha !== undefined && j.rule_sha256 !== a.ruleSha) {
      out.push(e('RULE_HASH_MISMATCH', a.path, '规则文本在评审之后被改过(rule_sha256 不一致)'));
    }
  }
  if (a.ruleSha === undefined) {
    out.push(e('RULE_HASH_UNCOMPUTABLE', a.path, '无法计算归一化后的规则哈希'));
  }
  // 与本地 promote 同一口径:CI 不得比本地宽。上面已覆盖的 C5 原因不重复输出,只补 C5 独有的几条:
  // judge.provider 必须等于最后一跳、最后一跳 result 必须 ok、评审厂商必须能由最后一跳模型串复算(自报 vendor 不可信)。
  const c5 = checkC5({ proposal: pr });
  for (const reason of c5.reasons) {
    if (C5_EXTRA_REASONS.has(reason)) {
      out.push(e(`C5_${reason}`, a.path, `C5 评审记录检查未过:${reason}`));
    }
  }
  const r = pr.reflector;
  if (r.stub === true) out.push(e('REFLECTOR_STUB', a.path, '假 LLM(stub)产出的提案不得晋升'));
  if (
    r.backend === undefined ||
    deriveVendor({ backend: r.backend, provider: r.provider, model: r.model }) !== r.vendor
  ) {
    out.push(
      e('REFLECTOR_UNVERIFIABLE', a.path, '反思器厂商无法由 backend/provider/model 复算一致'),
    );
  }
  return out;
}

function fixedFields(a: AtomCtx): Diagnostic[] {
  const problems: string[] = [];
  if (a.fm['strength'] !== 'should') problems.push('strength');
  const verifier = a.fm['verifier'];
  if (
    typeof verifier !== 'object' ||
    verifier === null ||
    (verifier as { type?: unknown }).type !== 'none'
  ) {
    problems.push('verifier');
  }
  for (const k of ['disables', 'overrides']) {
    const v = a.fm[k];
    if (v !== undefined && !(Array.isArray(v) && v.length === 0)) problems.push(k);
  }
  return problems.length === 0
    ? []
    : [e('FIXED_FIELDS', a.path, `反思器原子的固定字段被改动:${problems.join(', ')}`)];
}

function promotion(i: CriteriaInput): Diagnostic[] {
  const t = i.transition;
  const a = loadAtom(i);
  if (Array.isArray(a)) return a;
  const out: Diagnostic[] = [];
  if (a.fm['layer'] !== 'team')
    out.push(e('LAYER_NOT_TEAM', a.path, `只有 team 层可晋升,实际 layer=${String(a.fm['layer'])}`));
  const lp = loadProposal(i, a);
  if ('proposal' in lp) {
    out.push(...judgeChecks(a, lp.proposal), ...rescan(a, lp.proposal));
  } else {
    out.push(...lp.diags);
  }
  out.push(...fixedFields(a)); // 设计 §3.1:T2 = T1 的全部 + attest 聚合
  if (t.to === 'advisory') return out;

  // T2:advisory → active
  if (typeof a.fm['signature'] !== 'object' || a.fm['signature'] === null) {
    out.push(
      e(
        'SIGNATURE_MISSING',
        a.path,
        'status=active 的原子必须有 signature;G3 不许同 PR 补写,须先走内容 PR 补 signature(GD-6 两步)',
      ),
    );
  }
  const lc = loadLifecycle(i);
  if (!('cfg' in lc)) return [...out, lc];
  const since = advisorySince(i, a.path);
  if (since === undefined) {
    return [...out, e('ADVISORY_SINCE_UNKNOWN', a.path, '查不出原子转为 advisory 的日期')];
  }
  if (a.ruleSha === undefined) return out;
  if (!('proposal' in lp) || lp.proposal.judge === undefined) return out; // 提案/评审缺失已在上面报错,没有冻结可核
  // 历史从基线取;同时要求晋升 PR 没改规则文本(base 与 head 的归一化哈希相等),否则 head 的哈希在基线历史里根本没有「首次出现」
  const baseText = i.baseView(a.path);
  const baseSha = baseText === undefined ? undefined : normalizedRuleSha256(baseText);
  const tSince = baseSha === a.ruleSha ? textSince(i.git, i.baseOid, a.path, a.ruleSha) : undefined;
  if (tSince === undefined) {
    return [...out, e('TEXT_SINCE_UNKNOWN', a.path, '查不出当前规则文本首次进入仓库的日期')];
  }
  const fz = verifyFreeze(i, a, lp.proposal, lc);
  out.push(...fz.diags);
  if (!('frozen' in fz)) return out;
  const { frozen } = fz;
  const { items, diags } = loadAttests(i, a.id);
  out.push(...diags);
  const { kept, diags: notCounted } = frozenCountable(
    i,
    a.id,
    items,
    lc,
    a.ruleSha,
    since,
    tSince,
    frozen,
  );
  out.push(...notCounted);

  const { cfg } = lc;
  const owner = typeof a.fm['owner'] === 'string' ? a.fm['owner'].toLowerCase() : '';
  // 按块覆盖:一块有效 = 该块有 ≥min_members 名成员各交了一份计入的 attest,其中 ≥min_non_owner_members 名非 owner
  const byTile = new Map<number, Set<string>>();
  for (const it of kept) {
    const set = byTile.get(it.k) ?? new Set<string>();
    set.add(it.a.member.toLowerCase());
    byTile.set(it.k, set);
  }
  const validTiles = new Set<number>();
  for (const [k, members] of byTile) {
    const nonOwner = [...members].filter((m) => m !== owner).length;
    if (members.size >= cfg.min_members && nonOwner >= cfg.min_non_owner_members) validTiles.add(k);
  }
  // K5a:judge 校准(只读基线树)。过度自信 / 校准不可用 / 同键条目损坏 → 多要 STRICT_EXTRA_TILES 块;样本不足不加严
  const judge = lp.proposal.judge;
  const cal = computeCalibration({
    git: i.git,
    baseOid: i.baseOid,
    baseView: i.baseView,
    listBase: i.listBase,
    cfg,
    roster: lc.roster,
    excludeProposalId: lp.proposal.id,
    target: {
      vendor: judge?.vendor ?? '',
      model: judge?.hops[judge.hops.length - 1]?.model ?? '',
    },
  });
  const overconfident = cal.tiers.filter((t) => t.overconfident);
  const strict =
    cal.unavailable !== undefined || cal.unreadable.length > 0 || overconfident.length > 0;
  const pp = `proposals/${lp.proposal.id}.yaml`;
  if (cal.unavailable !== undefined) {
    out.push(
      warn(
        'GUARD_G3_CALIBRATION_UNAVAILABLE',
        pp,
        `校准账计算失败(${cal.unavailable}),按过度自信加严:有效验收块 +${STRICT_EXTRA_TILES}`,
      ),
    );
  }
  for (const u of cal.unreadable) {
    out.push(
      warn(
        'GUARD_G3_CALIBRATION_ITEM_UNREADABLE',
        u.path,
        `同厂商 judge 的校准账条目读不出或哈希不符(${u.reason}),按过度自信加严:有效验收块 +${STRICT_EXTRA_TILES}`,
      ),
    );
  }
  for (const t of overconfident) {
    out.push(
      warn(
        'GUARD_G3_JUDGE_OVERCONFIDENT',
        pp,
        `judge ${t.key} 过度自信(n=${t.n},命中 ${t.hits},置信度和 ${t.sumConf10 / 10}):有效验收块 +${STRICT_EXTRA_TILES}`,
      ),
    );
  }
  if (!strict) {
    const tier = cal.tiers.find((t) => t.insufficient);
    if (tier !== undefined) {
      out.push(
        warn(
          'GUARD_G3_CALIBRATION_INSUFFICIENT',
          pp,
          `judge 校准样本不足(${cal.tiers.map((t) => `${t.key}: n=${t.n}`).join(';')}),不加严;另有 ${cal.unsettled} 份最新预测未结算`,
        ),
      );
    }
  }
  const required = requiredValidTiles(
    cfg.canary_window_days,
    frozen.acc.tile_days,
    strict ? STRICT_EXTRA_TILES : 0,
  );
  const exposure = kept
    .filter((k) => validTiles.has(k.k))
    .reduce((sum, k) => sum + k.a.exposure_sessions, 0);
  // harmful 取全部计入的 attest(比「只在有效块」更严:无效块里的有害证据不能被静默丢弃)
  const harmful = kept.reduce((sum, k) => sum + k.a.harmful, 0);
  const need = (cond: boolean, code: string, msg: string): void => {
    if (!cond) out.push(e(code, a.path, msg));
  };
  // 所需块数超过冻结协议的 max_tiles:classifyTile 拒绝序号 ≥ max_tiles 的分块,永远凑不够;不削减 extra,提示须重跑 judge 重新冻结
  const note =
    (strict ? `;已因 judge 过度自信/校准不可用/校准条目损坏加严(+${STRICT_EXTRA_TILES} 块)` : '') +
    (required > frozen.acc.max_tiles
      ? `;冻结的 max_tiles=${frozen.acc.max_tiles} 装不下 ${required} 块,须重跑 judge 重新冻结(旧预测按校准账规则仍会结算)`
      : '');
  need(
    validTiles.size >= required,
    'THRESHOLD_TILES',
    `有效验收块 ${validTiles.size} 个(每块需 ≥${cfg.min_members} 名成员、其中 ≥${cfg.min_non_owner_members} 名非 owner),需要 ≥${required} 个(每块 ${frozen.acc.tile_days} 天,canary_window_days=${cfg.canary_window_days})${note}`,
  );
  need(
    exposure >= cfg.min_exposure_sessions,
    'THRESHOLD_EXPOSURE',
    `有效块内 exposure_sessions 合计 ${exposure},需要 ≥${cfg.min_exposure_sessions}`,
  );
  need(
    harmful <= cfg.max_harmful,
    'THRESHOLD_HARMFUL',
    `harmful 合计 ${harmful},上限 ${cfg.max_harmful}`,
  );
  return out;
}

/** 本 PR 新增的 lifecycle 记录(头部有、基线没有) */
function newRecords(
  i: CriteriaInput,
  id: string,
): { good: { path: string; r: LifecycleRecord }[]; diags: Diagnostic[] } {
  const dir = `lifecycle/${id}`;
  const base = new Set(i.listBase(dir));
  const diags: Diagnostic[] = [];
  const good: { path: string; r: LifecycleRecord }[] = [];
  for (const p of i.listHead(dir)) {
    if (base.has(p)) continue;
    let json: unknown;
    try {
      json = JSON.parse(i.headView(p) ?? '');
    } catch {
      json = undefined;
    }
    const res = LifecycleRecordSchema.safeParse(json);
    if (!res.success || res.data.rule_id !== id || p !== `${dir}/${lifecycleFileName(res.data)}`) {
      diags.push(
        e(
          'LIFECYCLE_RECORD_INVALID',
          p,
          'lifecycle 记录无法解析、未通过 schema,或 rule_id/文件名与内容不一致',
        ),
      );
      continue;
    }
    good.push({ path: p, r: res.data });
  }
  return { good, diags };
}

function retire(i: CriteriaInput): Diagnostic[] {
  const t = i.transition;
  const a = loadAtom(i);
  if (Array.isArray(a)) return a;
  const nr = newRecords(i, a.id);
  const out: Diagnostic[] = [...nr.diags];
  const match = nr.good.filter((g) => g.r.from_status === t.from && g.r.to_status === t.to);
  if (match.length === 0) {
    out.push(
      nr.good.length === 0
        ? e('LIFECYCLE_RECORD_MISSING', a.path, `本 PR 没有新增 lifecycle/${a.id}/ 下的退役记录`)
        : e(
            'LIFECYCLE_RECORD_MISMATCH',
            a.path,
            `新增的 lifecycle 记录没有一条是 ${t.from}→${t.to}`,
          ),
    );
    return out;
  }
  if (match.length > 1) {
    out.push(
      e(
        'LIFECYCLE_RECORD_AMBIGUOUS',
        a.path,
        `本 PR 为 ${t.from}→${t.to} 新增了 ${match.length} 条 lifecycle 记录`,
      ),
    );
    return out;
  }
  if (nr.good.length > match.length) {
    out.push(
      e('LIFECYCLE_RECORD_MISMATCH', a.path, 'lifecycle 目录里还新增了与本次转移不符的记录'),
    );
  }
  const { path: rp, r } = match[0]!;
  if (a.ruleSha === undefined)
    return [...out, e('RULE_HASH_UNCOMPUTABLE', a.path, '无法计算归一化后的规则哈希')];
  if (r.rule_sha256 !== a.ruleSha) {
    out.push(
      e('LIFECYCLE_RECORD_MISMATCH', rp, 'lifecycle 记录的 rule_sha256 与当前规则文本不一致'),
    );
  }

  // deprecated→retired 的冷却(⑩A):deprecated 须已出现在某个基线严格祖先的 stable tag 里。
  // 注意与 G4 不同:G4 查「retired 在 tag 里」,这里查「deprecated 在 tag 里」。
  if (t.from === 'deprecated' && t.to === 'retired') {
    const tags = i.git
      .stableTagCommits()
      .filter((c) => c !== i.baseOid && i.git.isAncestor(c, i.baseOid));
    const seen = tags.some((c) => {
      const text = i.git.textAt(c, a.path);
      return text !== undefined && statusOf(viewAtom(text, a.path)) === 'deprecated';
    });
    if (!seen) {
      out.push(
        e(
          'COOLDOWN_NOT_MET',
          a.path,
          'deprecated 状态尚未出现在任何(基线严格祖先上的)stable-* tag 里,不能退到 retired',
        ),
      );
    }
  }

  out.push(...reasonEvidence(i, a, rp, r));
  return out;
}

function reasonEvidence(
  i: CriteriaInput,
  a: AtomCtx,
  rp: string,
  r: LifecycleRecord,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const needsAttest = r.reason === 'no_exposure' || r.reason === 'harmful';
  if (!needsAttest && r.attest_digests.length > 0) {
    out.push(e('RECORD_DIGESTS', rp, `reason=${r.reason} 不应带 attest_digests`));
  }
  switch (r.reason) {
    case 'manual':
    case 'rejected':
      return out;
    case 'expired': {
      const baseText = i.baseView(a.path);
      const bv = baseText === undefined ? undefined : viewAtom(baseText, a.path);
      const due = bv?.ok === true ? bv.fm['review_by'] : undefined;
      if (typeof due !== 'string' || !(due < r.recorded_at)) {
        out.push(
          e(
            'REASON_NOT_EXPIRED',
            a.path,
            `基线 review_by(${String(due)})不早于记录日期 ${r.recorded_at}`,
          ),
        );
      }
      return out;
    }
    case 'superseded': {
      const by = r.by!;
      const hits = i.listHead('rules').filter((p) => isAtomPath(p) && fileStem(p) === by);
      const okBy =
        hits.length === 1 &&
        (() => {
          const text = i.headView(hits[0]!);
          const v = text === undefined ? undefined : viewAtom(text, hits[0]!);
          if (v === undefined || !v.ok) return false;
          const sup = v.fm['supersedes'];
          return (
            v.fm['id'] === by &&
            v.fm['status'] === 'active' &&
            Array.isArray(sup) &&
            sup.includes(a.id)
          );
        })();
      if (!okBy) {
        out.push(
          e('REASON_BY_INVALID', rp, `by=${by} 必须存在、status=active 且其 supersedes 含 ${a.id}`),
        );
      }
      return out;
    }
    case 'no_exposure':
    case 'harmful':
      return [...out, ...attestReason(i, a, rp, r)];
  }
}

function attestReason(i: CriteriaInput, a: AtomCtx, rp: string, r: LifecycleRecord): Diagnostic[] {
  const lc = loadLifecycle(i);
  if (!('cfg' in lc)) return [lc];
  const since = advisorySince(i, a.path);
  if (since === undefined)
    return [e('ADVISORY_SINCE_UNKNOWN', a.path, '查不出原子转为 advisory 的日期')];
  const { items, diags } = loadAttests(i, a.id);
  const out: Diagnostic[] = [...diags];
  if (a.ruleSha === undefined) return out;
  const { kept, diags: notCounted } = countable(items, lc, a.ruleSha, since);
  out.push(...notCounted);

  const byDigest = new Map(kept.map((k) => [k.digest, k]));
  const cited = r.attest_digests.map((d) => byDigest.get(d));
  if (r.attest_digests.length === 0 || cited.some((c) => c === undefined)) {
    out.push(
      e('RECORD_DIGESTS', rp, 'attest_digests 必须非空,且每一项都指向一份计入口径的有效 attest'),
    );
  }

  if (r.reason === 'harmful') {
    const anyHarm = kept.some((k) => k.a.harmful > 0);
    const citedHarm = cited.some((c) => c !== undefined && c.a.harmful > 0);
    if (!anyHarm || !citedHarm) {
      out.push(e('REASON_NOT_HARMFUL', rp, '没有被引用的有效 attest 记录 harmful>0'));
    }
    return out;
  }

  // no_exposure:最近 K 个互不重叠的 canary 窗口,窗口内(及之后)的 exposure_sessions 合计为 0
  const K = lc.cfg.no_exposure_windows;
  const wins = [
    ...new Map(kept.map((k) => [`${k.a.window_start}|${k.a.window_end}`, k.a])).values(),
  ].sort((x, y) => (x.window_end < y.window_end ? 1 : x.window_end > y.window_end ? -1 : 0));
  const picked: Attest[] = [];
  for (const w of wins) {
    if (picked.length === K) break;
    if (picked.every((p) => w.window_end < p.window_start)) picked.push(w);
  }
  if (picked.length < K) {
    out.push(
      e(
        'REASON_NO_EXPOSURE_UNMET',
        rp,
        `有效且互不重叠的 canary 窗口只有 ${picked.length} 个,需要 ${K} 个`,
      ),
    );
    return out;
  }
  const coveredWindows = new Set(
    cited.filter((c) => c !== undefined).map((c) => `${c.a.window_start}|${c.a.window_end}`),
  );
  if (!picked.every((w) => coveredWindows.has(`${w.window_start}|${w.window_end}`))) {
    out.push(e('RECORD_DIGESTS', rp, 'attest_digests 必须覆盖判据实际采用的每一个窗口'));
  }
  const earliest = picked.reduce(
    (m, p) => (p.window_start < m ? p.window_start : m),
    picked[0]!.window_start,
  );
  const exposure = kept
    .filter((k) => k.a.window_end >= earliest)
    .reduce((s, k) => s + k.a.exposure_sessions, 0);
  if (exposure !== 0) {
    out.push(
      e(
        'REASON_NO_EXPOSURE_UNMET',
        rp,
        `最近 ${K} 个窗口内 exposure_sessions 合计 ${exposure},不为 0`,
      ),
    );
  }
  return out;
}

/** G3 的真判据:`check --guards` 命令层注入;库层调用方(promote/retire 的内存模拟)显式传入。 */
export const lifecycleCriteria: CriteriaChecker = (i) =>
  i.transition.label === 'kit:promotion' ? promotion(i) : retire(i);

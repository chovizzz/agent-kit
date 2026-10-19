/**
 * judge 校准账(K5a,RSI 借鉴 §1.8;口径见 docs/contracts.md §18.10)。纯函数:只经注入的 git / 基线树读取,不读盘不联网。
 *
 * 账本 = **基线树**里每个 `proposals/*.yaml` 的**每一份**不同的冻结协议(`judge.acceptance.sha256`)——包括历史上被
 * 重跑 judge 取代的旧冻结(只看最新一份,作者可以先在本机偷看数据、不满意就重跑 judge 把差的预测换掉)。
 * 排除正在被判的提案(按 id,含它的全部历史版本)。只统计 `status=predicted` 的预测。
 *
 * 结算:取绑定该冻结协议的 attest(`acceptance_sha256` 相等、`rule_sha256` 相等、canary 渠道、成员在基线成员表内、method、
 * 窗口经 `classifyTile` 对齐、首次入库晚于冻结提交且不早于窗口结束 − 1 天)。一块「有效」= ≥min_members 名成员、其中 ≥min_non_owner 名非 owner。
 * 实测比值 r = (Σexposure/Σsessions_total) ÷ (基线 exposure/基线 sessions_total),只在有效块上合计;命中 ⇔ lo ≤ r ≤ hi(闭区间,hi="inf" 无上界)。
 * 比较用整数交叉相乘(网格点写成有理数),不用浮点。
 *  - 最新一份:有效块数 ≥ ceil(canary_window_days / tile_days)(不含加严的 extra)才算已结算,否则未结算、不进分母。
 *  - 被取代的旧份:取代它的提交日期 < 它的 D0(验收期还没开始,没有数据可偷看)→ 忽略;否则必须进账:有效块数 ≥1 按已有块结算,0 块按失手计。
 *
 * 校准键两档并集:vendor 与 vendor/model(model 取最后一跳,小写去空白)。只用 vendor/model 的话,改 model 串就能拆成 n<10 的新键。
 * n ≥ CALIBRATION_MIN_N 且 平均置信度 − 命中率 ≥ CALIBRATION_GAP → overconfident。置信度只有 0.5/0.7/0.9,按十分位整数算,
 * 判据 `Σconf10 − 10·hits ≥ 2·n` 与 gap ≥ 0.20 严格等价,没有浮点边界。
 *
 * fail-closed:任何异常 / git 失败 / 无法归属键 → `unavailable`(调用方按过度自信加严);同 vendor 的条目读不出、哈希不符、
 * 同一冻结协议出现在两个提案文件里 → `unreadable`(同样加严)。**损坏只会更严,绝不放宽**。
 */
import { parseRestrictedYaml } from '../atoms/frontmatter.js';
import { fileStem } from '../atoms/parse.js';
import { addDays } from '../atoms/dates.js';
import { AttestSchema, attestFileName, type Attest } from '../contracts/attest.js';
import {
  CALIBRATION_GAP,
  CALIBRATION_MIN_N,
  type LifecycleCoreConfig,
} from '../contracts/config.js';
import {
  AcceptanceProtocolSchema,
  JudgePredictionSchema,
  ReflectorGuidanceSchema,
  type AcceptanceProtocol,
  type JudgePrediction,
  type ReflectorGuidance,
} from '../contracts/proposal.js';
import {
  acceptanceSha256,
  decidePredictionStatus,
  guidanceSha256,
  signatureSha256,
} from '../judge/freeze.js';
import { isAtomPath } from '../guards/paths.js';
import type { GuardGit } from '../guards/types.js';
import { viewAtom } from '../guards/view.js';
import { acceptanceD0, classifyTile } from './attest-count.js';

/** 基线树读取:与 `CriteriaInput` 的子集同形,单测可单独构造 */
export interface CalibrationEnv {
  git: GuardGit;
  baseOid: string;
  baseView(path: string): string | undefined;
  listBase(dir: string): string[];
  /** 基线 kit.toml 的 [lifecycle] */
  cfg: LifecycleCoreConfig;
  /** canary 成员表:handle(小写)→ since */
  roster: ReadonlyMap<string, string | undefined>;
  /** 正在被判的提案 id:本身及其全部历史版本不进账 */
  excludeProposalId: string;
  /** 被判 judge 的校准键 */
  target: { vendor: string; model: string };
}

export interface KeyStat {
  key: string;
  n: number;
  hits: number;
  /** Σ 置信度 × 10(整数) */
  sumConf10: number;
  overconfident: boolean;
  insufficient: boolean;
}

export interface CalibrationOutcome {
  /** 全局计算失败(无法归属键、git 失败、异常):调用方按过度自信加严 */
  unavailable?: string;
  /** 同 vendor 条目损坏(路径 + 原因):调用方按过度自信加严 */
  unreadable: { path: string; reason: string }[];
  /** 两档:vendor、vendor/model */
  tiers: KeyStat[];
  /** 最新一份、数据不够块数而未结算的条数(披露用) */
  unsettled: number;
}

/** 校准键两档(小写、去首尾空白) */
export function calibrationKeys(
  vendor: string,
  model: string,
): { vendorKey: string; modelKey: string } {
  const v = vendor.trim().toLowerCase();
  return { vendorKey: v, modelKey: `${v}/${model.trim().toLowerCase()}` };
}

/** n、命中数、置信度十分位和 → 是否过度自信(整数运算) */
export function judgeKeyStat(key: string, n: number, hits: number, sumConf10: number): KeyStat {
  // gap = sumConf10/(10n) − hits/n ≥ CALIBRATION_GAP  ⇔  sumConf10 − 10·hits ≥ 10·GAP·n
  const gapTenths = Math.round(CALIBRATION_GAP * 10);
  return {
    key,
    n,
    hits,
    sumConf10,
    insufficient: n < CALIBRATION_MIN_N,
    overconfident: n >= CALIBRATION_MIN_N && sumConf10 - 10 * hits >= gapTenths * n,
  };
}

const RATIO_NUM_DEN: Readonly<Record<string, readonly [number, number]>> = {
  '0': [0, 1],
  '0.1': [1, 10],
  '0.25': [1, 4],
  '0.5': [1, 2],
  '0.8': [4, 5],
  '1.25': [5, 4],
  '2': [2, 1],
  '4': [4, 1],
};

/**
 * lo ≤ r ≤ hi,r = (E/S) ÷ (Eb/Sb);整数交叉相乘。调用方保证 S>0、Sb>0、Eb>0。
 * 网格点不在表里返回 undefined(调用方当损坏)。
 */
export function ratioHit(
  lo: number | string,
  hi: number | string,
  exposure: number,
  sessions: number,
  baseExposure: number,
  baseSessions: number,
): boolean | undefined {
  const l = RATIO_NUM_DEN[String(lo)];
  if (l === undefined) return undefined;
  // r = (E·Sb) / (S·Eb)
  const rNum = exposure * baseSessions;
  const rDen = sessions * baseExposure;
  if (rNum * l[1] < l[0] * rDen) return false; // r < lo
  if (hi === 'inf') return true;
  const h = RATIO_NUM_DEN[String(hi)];
  if (h === undefined) return undefined;
  return rNum * h[1] <= h[0] * rDen;
}

const PROPOSAL_FILE_RE = /^proposals\/(\d{4}-\d{2}-\d{2}-\d{3})\.yaml$/;
const STAMP_RE = /^run-(\d{8}T\d{6}Z)-[0-9a-f]{6}$/;

class Unavailable extends Error {}

interface JudgeShape {
  vendor: string;
  model: string;
  ruleSha: string | undefined;
}

interface Version {
  commit: string;
  date: string;
  targets: string[];
  judge: JudgeShape | undefined;
  /** 原始值:acceptance / prediction / guidance(不经整份 ProposalSchema:新版字段不能让整条读不出) */
  acceptance: unknown;
  prediction: unknown;
  guidance: unknown;
  hasJudge: boolean;
}

const fingerprint = (v: Version): string =>
  JSON.stringify([
    v.prediction,
    v.judge?.vendor,
    v.judge?.model,
    v.judge?.ruleSha,
    v.guidance,
    v.targets,
  ]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseVersion(
  text: string | undefined,
  commit: string,
  date: string,
  path: string,
): Version {
  if (text === undefined) throw new Unavailable(`${path}@${commit.slice(0, 8)} 读不出`);
  const y = parseRestrictedYaml(text, path, 'CALIBRATION_YAML');
  if (!y.ok || !isObj(y.value)) throw new Unavailable(`${path}@${commit.slice(0, 8)} 无法解析`);
  const doc = y.value;
  const reflector = isObj(doc['reflector']) ? doc['reflector'] : {};
  const targets = Array.isArray(doc['targets'])
    ? doc['targets'].filter((t): t is string => typeof t === 'string')
    : [];
  const j = doc['judge'];
  if (j === undefined) {
    return {
      commit,
      date,
      targets,
      judge: undefined,
      acceptance: undefined,
      prediction: undefined,
      guidance: reflector['guidance'],
      hasJudge: false,
    };
  }
  if (!isObj(j))
    throw new Unavailable(`${path}@${commit.slice(0, 8)} 的 judge 不是对象,无法归属校准键`);
  const hops = j['hops'];
  const last = Array.isArray(hops) ? hops[hops.length - 1] : undefined;
  const vendor = j['vendor'];
  const model = isObj(last) ? last['model'] : undefined;
  if (
    typeof vendor !== 'string' ||
    vendor.trim() === '' ||
    typeof model !== 'string' ||
    model.trim() === '' ||
    !isObj(last) ||
    last['vendor'] !== vendor
  ) {
    throw new Unavailable(
      `${path}@${commit.slice(0, 8)} 的 judge 读不出 vendor/model,无法归属校准键`,
    );
  }
  return {
    commit,
    date,
    targets,
    judge: {
      vendor,
      model,
      ruleSha: typeof j['rule_sha256'] === 'string' ? j['rule_sha256'] : undefined,
    },
    acceptance: j['acceptance'],
    prediction: j['prediction'],
    guidance: reflector['guidance'],
    hasJudge: true,
  };
}

interface Entry {
  path: string;
  accSha: string;
  /** 冻结提交(该协议首次出现的提交)日期 */
  freezeDate: string;
  /** 取代它的提交日期;最新一份为 undefined */
  supersededDate: string | undefined;
  version: Version;
  /** 同一冻结协议的各版本之间,prediction / judge 键 / guidance / targets 不一致(冻结之后被改) */
  drift: boolean;
  vendorKey: string;
  modelKey: string;
}

interface Settled {
  hit: boolean;
  conf10: number;
}

type Attestation = { it: Attest; path: string };

export function computeCalibration(env: CalibrationEnv): CalibrationOutcome {
  const out: CalibrationOutcome = { unreadable: [], tiers: [], unsettled: 0 };
  try {
    run(env, out);
  } catch (x) {
    out.unavailable =
      x instanceof Unavailable
        ? x.message
        : `calibration_threw:${x instanceof Error ? x.name : 'unknown'}`;
  }
  return out;
}

function run(env: CalibrationEnv, out: CalibrationOutcome): void {
  const { vendorKey, modelKey } = calibrationKeys(env.target.vendor, env.target.model);
  const stats = new Map<string, { n: number; hits: number; sum: number }>();
  const bump = (key: string, s: Settled): void => {
    const cur = stats.get(key) ?? { n: 0, hits: 0, sum: 0 };
    cur.n += 1;
    cur.hits += s.hit ? 1 : 0;
    cur.sum += s.conf10;
    stats.set(key, cur);
  };

  const files = env.listBase('proposals').filter((p) => PROPOSAL_FILE_RE.test(p));
  const entries: Entry[] = [];
  for (const path of files) {
    const id = PROPOSAL_FILE_RE.exec(path)![1]!;
    if (id === env.excludeProposalId) continue;
    const hist = env.git.fileHistory(env.baseOid, path); // 新 → 旧;git 失败直接抛(→ unavailable)
    if (hist.length === 0) throw new Unavailable(`${path} 在基线历史里没有提交`);
    // 浅克隆:`git log` 照常成功但历史在边界处被截断(边界提交像是引入了全部文件)→ 最老一条没有父提交即视为历史不完整,fail-closed
    const oldest = hist[hist.length - 1]!.commit;
    let hasParent = false;
    try {
      hasParent = env.git.isAncestor(`${oldest}^`, oldest);
    } catch {
      hasParent = false;
    }
    if (!hasParent)
      throw new Unavailable(`${path} 的历史最老一条没有父提交(根提交或浅克隆边界),历史可能被截断`);
    const versions = hist.map((h) =>
      parseVersion(env.git.textAt(h.commit, path), h.commit, h.date, path),
    );
    // 基线树里的文本必须与历史最新一版一致,否则历史不可信
    if (env.baseView(path) !== env.git.textAt(hist[0]!.commit, path)) {
      throw new Unavailable(`${path} 的基线文本与其历史最新一版不一致`);
    }
    // 按冻结协议分组:同一 acceptance.sha256 的连续版本算一份,最老的提交 = 冻结提交
    let prevSha: string | undefined;
    const groups: { sha: string; oldest: Version; all: Version[] }[] = [];
    for (let n = 0; n < versions.length; n++) {
      const v = versions[n]!;
      const sha =
        isObj(v.acceptance) && typeof v.acceptance['sha256'] === 'string'
          ? v.acceptance['sha256']
          : undefined;
      if (sha === undefined) {
        prevSha = undefined;
        continue;
      }
      if (sha === prevSha) {
        const cur = groups[groups.length - 1]!;
        cur.oldest = v;
        cur.all.push(v);
        continue;
      }
      groups.push({ sha, oldest: v, all: [v] });
      prevSha = sha;
    }
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g]!;
      const newer = groups[g - 1];
      const v = grp.oldest;
      entries.push({
        path,
        accSha: grp.sha,
        freezeDate: v.date,
        // 取代它的是更新一份的冻结提交
        supersededDate: newer?.oldest.date,
        version: v,
        drift: grp.all.some((x) => fingerprint(x) !== fingerprint(v)),
        vendorKey: calibrationKeys(v.judge!.vendor, v.judge!.model).vendorKey,
        modelKey: calibrationKeys(v.judge!.vendor, v.judge!.model).modelKey,
      });
    }
    // 有 judge 但完全没有冻结(旧记录)→ 忽略;有 acceptance 之外的残缺在 settle 时判
    for (const v of versions) {
      const accHasSha = isObj(v.acceptance) && typeof v.acceptance['sha256'] === 'string';
      // 只有「既无 acceptance 也无 prediction」才是 K1 之前的旧记录;任何一个存在而拿不到合法协议标识都是损坏
      if (v.hasJudge && !accHasSha && (v.acceptance !== undefined || v.prediction !== undefined)) {
        entries.push({
          path,
          accSha: `malformed:${v.commit}`,
          freezeDate: v.date,
          supersededDate: undefined,
          version: v,
          drift: false,
          vendorKey: calibrationKeys(v.judge!.vendor, v.judge!.model).vendorKey,
          modelKey: calibrationKeys(v.judge!.vendor, v.judge!.model).modelKey,
        });
      }
    }
  }

  // 同一冻结协议出现在 ≥2 个提案文件里:一份 judge 块被复制,命中会被算两次 → 全部算损坏
  const shaFiles = new Map<string, Set<string>>();
  for (const en of entries) {
    const s = shaFiles.get(en.accSha) ?? new Set<string>();
    s.add(en.path);
    shaFiles.set(en.accSha, s);
  }

  const unreadable = (en: Entry, reason: string): void => {
    out.unreadable.push({ path: en.path, reason });
  };
  let ruleFiles: string[] | undefined;
  const atomCache = new Map<string, Record<string, unknown> | undefined>();
  const atomOf = (id: string): Record<string, unknown> | undefined => {
    if (atomCache.has(id)) return atomCache.get(id);
    ruleFiles ??= [...env.listBase('rules'), ...env.listBase('.kit/rules')].filter(isAtomPath);
    const paths = ruleFiles.filter((p) => fileStem(p) === id);
    let fm: Record<string, unknown> | undefined;
    if (paths.length === 1) {
      const text = env.baseView(paths[0]!);
      const v = text === undefined ? undefined : viewAtom(text, paths[0]!);
      fm = v !== undefined && v.ok ? { ...v.fm } : undefined;
    }
    atomCache.set(id, fm);
    return fm;
  };

  for (const en of entries) {
    // 别家 judge 的条目既不进账也不影响本次(损坏只影响同 vendor);跳过还省掉大量 git 调用
    if (en.vendorKey !== vendorKey) continue;
    if (en.accSha.startsWith('malformed:')) {
      unreadable(en, 'acceptance 缺失或没有 sha256,而 prediction / acceptance 之一存在');
      continue;
    }
    const v = en.version;
    if (en.drift) {
      unreadable(en, '冻结之后 prediction / judge / guidance 被改过');
      continue;
    }
    if (v.prediction === undefined) {
      unreadable(en, 'acceptance 存在但 prediction 缺失');
      continue;
    }
    const acc = AcceptanceProtocolSchema.safeParse(v.acceptance);
    const pred = JudgePredictionSchema.safeParse(v.prediction);
    const guid =
      v.guidance === undefined ? undefined : ReflectorGuidanceSchema.safeParse(v.guidance);
    if (!acc.success || !pred.success || (guid !== undefined && !guid.success)) {
      unreadable(en, 'acceptance / prediction / guidance 形状不合法');
      continue;
    }
    const a: AcceptanceProtocol = acc.data;
    const p: JudgePrediction = pred.data;
    const g: ReflectorGuidance | undefined = guid?.data;
    if (
      acceptanceSha256(a) !== a.sha256 ||
      p.acceptance_sha256 !== a.sha256 ||
      a.baseline_sha256 !== guidanceSha256(g) ||
      (v.judge!.ruleSha !== undefined && a.rule_sha256 !== v.judge!.ruleSha)
    ) {
      unreadable(en, '冻结协议哈希不自洽');
      continue;
    }
    if ((shaFiles.get(en.accSha)?.size ?? 0) > 1) {
      unreadable(en, '同一冻结协议出现在多个提案文件里');
      continue;
    }
    // 状态复核:不许手改 status 逃避结算。guidance 一半总能复核;签名一半在原子可定位且签名哈希相符时复核
    let expected = decidePredictionStatus({ type: 'regex' }, g);
    let sigKnown = false;
    for (const t of v.targets) {
      const sig = atomOf(t)?.['signature'];
      if (isObj(sig) && typeof sig['type'] === 'string') {
        const s = {
          type: sig['type'],
          ...(typeof sig['pattern'] === 'string' ? { pattern: sig['pattern'] } : {}),
        };
        if (signatureSha256(s) === a.signature_sha256) {
          expected = decidePredictionStatus(s, g);
          sigKnown = true;
        }
      }
    }
    // not_measurable 在原子不可定位时无法证伪,放行;其余 status 必须与复算一致
    if (
      p.status === 'not_measurable'
        ? sigKnown && expected !== 'not_measurable'
        : p.status !== expected
    ) {
      unreadable(en, `prediction.status=${p.status} 与复算的 ${expected} 不一致`);
      continue;
    }
    if (p.status !== 'predicted') continue; // 不进分母(已复核)
    if (
      p.ratio_lo === undefined ||
      p.ratio_hi === undefined ||
      p.confidence === undefined ||
      g === undefined ||
      g.baseline.exposure_sessions <= 0 ||
      g.baseline.sessions_total <= 0
    ) {
      unreadable(en, 'predicted 的预测值或基线缺失');
      continue;
    }

    const d0 = acceptanceD0(a, en.freezeDate);
    if (en.supersededDate !== undefined && en.supersededDate < d0) continue; // 还没有数据可偷看

    // —— 结算 ——
    const settledRes = settle(env, en, a, v.targets, d0, atomOf);
    if ('unreadable' in settledRes) {
      unreadable(en, settledRes.unreadable);
      continue;
    }
    if (
      ![
        settledRes.exposure,
        settledRes.sessions,
        g.baseline.exposure_sessions,
        g.baseline.sessions_total,
      ].every((n) => n < 2 ** 24)
    ) {
      throw new Unavailable('计数超出安全整数范围,整数比较不可靠');
    }
    const required = Math.ceil(env.cfg.canary_window_days / a.tile_days);
    let hit: boolean | undefined;
    const enough = settledRes.validTiles >= (en.supersededDate === undefined ? required : 1);
    if (enough && settledRes.sessions === 0) {
      unreadable(en, '有效块齐了但 sessions_total 合计为 0,无法计算比值');
      continue;
    }
    if (enough && settledRes.sessions > 0) {
      hit = ratioHit(
        p.ratio_lo,
        p.ratio_hi,
        settledRes.exposure,
        settledRes.sessions,
        g.baseline.exposure_sessions,
        g.baseline.sessions_total,
      );
      if (hit === undefined) {
        unreadable(en, '预测区间不在比值网格上');
        continue;
      }
    } else if (en.supersededDate !== undefined) {
      hit = false; // 被取代的旧份、取代时已有验收期但没凑出有效数据:按失手计
    } else {
      out.unsettled += 1;
      continue;
    }
    const s: Settled = { hit, conf10: Math.round(p.confidence * 10) };
    bump(vendorKey, s);
    if (en.modelKey === modelKey) bump(modelKey, s);
  }

  for (const key of [vendorKey, modelKey]) {
    const s = stats.get(key) ?? { n: 0, hits: 0, sum: 0 };
    out.tiers.push(judgeKeyStat(key, s.n, s.hits, s.sum));
  }
}

function settle(
  env: CalibrationEnv,
  en: Entry,
  a: AcceptanceProtocol,
  targets: readonly string[],
  d0: string,
  atomOf: (id: string) => Record<string, unknown> | undefined,
): { validTiles: number; exposure: number; sessions: number } | { unreadable: string } {
  const items: Attestation[] = [];
  const owners = new Set<string>();
  for (const t of targets) {
    const fm = atomOf(t);
    if (typeof fm?.['owner'] === 'string') owners.add(fm['owner'].toLowerCase());
    for (const path of env.listBase(`attest/${t}`)) {
      const text = env.baseView(path);
      let json: unknown;
      try {
        json = text === undefined ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      const res = AttestSchema.safeParse(json);
      if (
        !res.success ||
        res.data.rule_id !== t ||
        path !== `attest/${t}/${attestFileName(res.data)}`
      ) {
        return { unreadable: `attest 文件 ${path} 读不出或与文件名不符` };
      }
      if (res.data.acceptance_sha256 === a.sha256) items.push({ it: res.data, path });
    }
  }
  // 同 (成员,窗口) 只留 run_id 时间戳最新的一份
  const newest = new Map<string, Attestation>();
  for (const x of items) {
    const k = `${x.it.member.toLowerCase()}|${x.it.window_start}|${x.it.window_end}`;
    const cur = newest.get(k);
    const stamp = (y: Attestation): string => STAMP_RE.exec(y.it.run_id)?.[1] ?? '';
    if (cur === undefined || stamp(x) > stamp(cur)) newest.set(k, x);
  }
  const byTile = new Map<number, { members: Set<string>; exposure: number; sessions: number }>();
  for (const x of newest.values()) {
    const at = x.it;
    const member = at.member.toLowerCase();
    const since = env.roster.get(member);
    if (
      at.channel !== 'canary' ||
      !env.roster.has(member) ||
      (since !== undefined && at.window_start < since) ||
      at.rule_sha256 !== a.rule_sha256 ||
      at.method !== 'signature_proxy_v1'
    ) {
      continue;
    }
    const cls = classifyTile(d0, a.tile_days, a.max_tiles, at.window_start, at.window_end);
    if (!cls.ok) continue;
    const hist = env.git.fileHistory(env.baseOid, x.path);
    const intro = hist[hist.length - 1];
    if (intro === undefined) throw new Unavailable(`${x.path} 在基线历史里没有提交`);
    // 首次入库严格晚于冻结提交,且不早于窗口结束 − 1 天
    const fc = en.version.commit;
    if (intro.commit === fc || !env.git.isAncestor(fc, intro.commit)) continue;
    if (at.window_end > addDays(intro.date, 1)) continue;
    const cur = byTile.get(cls.k) ?? { members: new Set<string>(), exposure: 0, sessions: 0 };
    cur.members.add(member);
    cur.exposure += at.exposure_sessions;
    cur.sessions += at.sessions_total;
    byTile.set(cls.k, cur);
  }
  let validTiles = 0;
  let exposure = 0;
  let sessions = 0;
  for (const t of byTile.values()) {
    const nonOwner = [...t.members].filter((m) => !owners.has(m)).length;
    if (t.members.size >= env.cfg.min_members && nonOwner >= env.cfg.min_non_owner_members) {
      validTiles += 1;
      exposure += t.exposure;
      sessions += t.sessions;
    }
  }
  return { validTiles, exposure, sessions };
}

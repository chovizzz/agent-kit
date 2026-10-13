import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { parseRestrictedYaml } from '../atoms/frontmatter.js';
import { fileStem } from '../atoms/parse.js';
import { AttestSchema, attestFileName, type Attest } from '../contracts/attest.js';
import {
  KitConfigSchema,
  LifecycleCoreConfigSchema,
  type LifecycleCoreConfig,
} from '../contracts/config.js';
import type { Diagnostic } from '../contracts/diagnostics.js';
import { LifecycleRecordSchema, lifecycleFileName } from '../contracts/lifecycle.js';
import type { LifecycleRecord } from '../contracts/lifecycle.js';
import { ProposalSchema, type Proposal } from '../contracts/proposal.js';
import { deriveVendor, isCrossVendor } from '../contracts/vendor.js';
import { canonicalText } from '../io/canonical-text.js';
import { createRedactor } from '../redact/redactor.js';
import { scanDangerousPhrases } from '../reflect/validate.js';
import { hasInvisible } from '../reflect/text.js';
import { err } from './diff.js';
import { isAtomPath } from './paths.js';
import type { CriteriaChecker, CriteriaInput } from './types.js';
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
 *  T2:SIGNATURE_MISSING CONFIG_UNREADABLE ADVISORY_SINCE_UNKNOWN ATTEST_INVALID ATTEST_RUN_ID_SHAPE ATTEST_AMBIGUOUS_LATEST ATTEST_OVERLAP
 *    THRESHOLD_WINDOW_DAYS THRESHOLD_MEMBERS THRESHOLD_NON_OWNER_MEMBERS THRESHOLD_EXPOSURE THRESHOLD_HARMFUL
 *  退役:LIFECYCLE_RECORD_MISSING LIFECYCLE_RECORD_AMBIGUOUS LIFECYCLE_RECORD_INVALID LIFECYCLE_RECORD_MISMATCH
 *    RECORD_DIGESTS REASON_NOT_EXPIRED REASON_BY_INVALID REASON_NO_EXPOSURE_UNMET REASON_NOT_HARMFUL COOLDOWN_NOT_MET
 *  warn(不计入失败):ATTEST_NOT_COUNTED
 *
 * 🔴 已知缺口(如实记录):
 *  - 没有签名/创建者校验:attest 计数、judge 记录、lifecycle 记录都是 PR 里的普通文件,造假靠 CODEOWNERS/四眼(P1-D)。
 *  - `deprecated→retired` 的冷却依赖 stable tag,继承 GD-3:本地可写的注解 tag 可伪造(P1 CI 须改服务端受保护 tag / verify-tag)。
 *  - 窗口日期、`recorded_at`、「转为 advisory 的日期」(取提交者日期)都是作者可写的数据,不是可信时钟。
 *  - 预算("不超")不在 G3 判据里(由 `check --budget` 与 promote 的 out/ 进出清单承担)。
 */

const ISO_DAY_MS = 86_400_000;
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

/** 'YYYY-MM-DD' → 自 1970 起的天数(输入已由 IsoDateSchema 保证是真实日期) */
const dayNum = (iso: string): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / ISO_DAY_MS);

/**
 * 规则文本哈希:`status` / `review_by` 两行先归一化成占位值,再对 canonicalText 取 sha256(hex,64 位小写)。
 * 这样晋升 PR 自己改 status/review_by 不会改变哈希;其余任何改动(正文、证据、签名…)都会。
 * 两行必须各恰好出现一次且归一后确为占位值(排除引号键、折叠标量等写法);否则返回 undefined(调用方 fail-closed)。
 */
export function normalizedRuleSha256(source: string): string | undefined {
  const lines = canonicalText(source.replace(/^﻿/, '')).split('\n');
  if (lines[0] !== '---') return undefined;
  const end = lines.indexOf('---', 1);
  if (end < 0) return undefined;
  let nStatus = 0;
  let nReview = 0;
  for (let i = 1; i < end; i++) {
    const l = lines[i]!;
    if (/^status:/.test(l)) {
      lines[i] = 'status: _';
      nStatus++;
    } else if (/^review_by:/.test(l)) {
      lines[i] = 'review_by: _';
      nReview++;
    }
  }
  if (nStatus !== 1 || nReview !== 1) return undefined;
  const text = lines.join('\n');
  const v = viewAtom(text, 'normalized');
  if (!v.ok || v.fm['status'] !== '_' || v.fm['review_by'] !== '_') return undefined;
  return sha256Hex(text);
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

function unionDays(items: readonly AttestItem[]): number {
  const iv = items
    .map((it) => [dayNum(it.a.window_start), dayNum(it.a.window_end)] as const)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curS = 0;
  let curE = -Infinity;
  for (const [s, en] of iv) {
    if (s > curE + 1) {
      if (curE !== -Infinity) total += curE - curS + 1;
      curS = s;
      curE = en;
    } else if (en > curE) {
      curE = en;
    }
  }
  if (curE !== -Infinity) total += curE - curS + 1;
  return total;
}

interface AtomCtx {
  path: string;
  id: string;
  fm: Readonly<Record<string, unknown>>;
  text: string;
  ruleSha: string | undefined;
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
  const { items, diags } = loadAttests(i, a.id);
  out.push(...diags);
  if (a.ruleSha === undefined) return out;
  const { kept, diags: notCounted } = countable(items, lc, a.ruleSha, since);
  out.push(...notCounted);

  const { cfg } = lc;
  const owner = typeof a.fm['owner'] === 'string' ? a.fm['owner'].toLowerCase() : '';
  const members = new Set(kept.map((k) => k.a.member.toLowerCase()));
  const nonOwner = [...members].filter((m) => m !== owner);
  const days = unionDays(kept);
  const exposure = kept.reduce((s, k) => s + k.a.exposure_sessions, 0);
  const harmful = kept.reduce((s, k) => s + k.a.harmful, 0);
  const need = (cond: boolean, code: string, msg: string): void => {
    if (!cond) out.push(e(code, a.path, msg));
  };
  need(
    days >= cfg.canary_window_days,
    'THRESHOLD_WINDOW_DAYS',
    `有效 attest 覆盖 ${days} 天,需要 ≥${cfg.canary_window_days}`,
  );
  need(
    members.size >= cfg.min_members,
    'THRESHOLD_MEMBERS',
    `有效 attest 的成员数 ${members.size},需要 ≥${cfg.min_members}`,
  );
  need(
    nonOwner.length >= cfg.min_non_owner_members,
    'THRESHOLD_NON_OWNER_MEMBERS',
    `非 owner 成员数 ${nonOwner.length},需要 ≥${cfg.min_non_owner_members}`,
  );
  need(
    exposure >= cfg.min_exposure_sessions,
    'THRESHOLD_EXPOSURE',
    `exposure_sessions 合计 ${exposure},需要 ≥${cfg.min_exposure_sessions}`,
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

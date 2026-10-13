/**
 * 本地检查库 C1–C9(设计稿 §2,采纳 / 晋升 / CI 判据三处共用)。
 *
 * 纯函数:不读盘、不写盘、不联网、不起子进程。一切输入(原子文本、提案对象、信号库查询函数、
 * 文件系统事实……)由调用方准备;本库只给判定。每个检查返回 `CheckResult`,聚合函数 `runChecks`
 * 返回**所有**失败项(不短路)。原因码是稳定的大写蛇形枚举,只含我方枚举与字段路径,**不回显任何被扫描的文本**。
 *
 * 保守取向:拿不准的一律按不通过;检查自身抛异常也按不通过(`CHECK_INTERNAL_ERROR`)。
 * 语义上刻意不给覆盖参数:C3 没有「放宽某字段」的入口;晋升用的是另一个名字清楚的 `checkC3Governance`。
 */
import { createHash } from 'node:crypto';
import { addDays } from '../atoms/dates.js';
import type { Atom } from '../contracts/atom.js';
import { RunIdSchema } from '../contracts/common.js';
import type { JudgeRecord, Proposal } from '../contracts/proposal.js';
import type { Redactor } from '../contracts/redact.js';
import { UNKNOWN_VENDOR, deriveVendor, isCrossVendor } from '../contracts/vendor.js';
import { isUnsafePath } from '../guards/paths.js';
import { canonicalText } from '../io/canonical-text.js';
import { findDuplicate, type DedupeTarget, type DedupeThresholds } from '../reflect/dedupe.js';
import { REVIEW_DAYS_STABLE, REVIEW_DAYS_VOLATILE } from '../reflect/merge.js';
import { patchUnsafe } from '../reflect/stage.js';
import { hasInvisible } from '../reflect/text.js';
import { scanDangerousPhrases } from '../reflect/validate.js';
import { findInvisibleRanges } from './invisible.js';

export const CHECK_CODES = ['C1', 'C1b', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

export interface CheckResult {
  code: CheckCode;
  ok: boolean;
  /** 稳定原因码(大写蛇形);通过时恒为 `OK`。多个原因时是检测顺序里的第一个 */
  reason: string;
  /** 全部原因码(检测顺序,去重);通过时为空 */
  reasons: string[];
  /** 出问题的字段路径(如 `evidence[1].excerpt`),不含内容 */
  fields: string[];
  /** 仅 C2/C4:全部原因都是「本机查不到信号」。调用方映射为退出 4(无法核对),不当通过 */
  unverifiable?: true;
  /** 附注(通过也可能有),如 `JUDGE_INJECTION_FALSE_NOT_RELIED_ON`、`LAYER_PERSONAL` */
  info?: string;
  /** 命中的规则 / 区段名(我方枚举,不含被扫描文本) */
  rules?: string[];
}

interface Hit {
  reason: string;
  field: string;
}

function mk(
  code: CheckCode,
  hits: readonly Hit[],
  extra: Partial<Pick<CheckResult, 'info' | 'rules' | 'unverifiable'>> = {},
): CheckResult {
  const reasons = [...new Set(hits.map((h) => h.reason))];
  const fields = [...new Set(hits.map((h) => h.field).filter((f) => f !== ''))];
  const base: CheckResult = {
    code,
    ok: hits.length === 0,
    reason: reasons[0] ?? 'OK',
    reasons,
    fields,
  };
  if (extra.info !== undefined) base.info = extra.info;
  if (extra.rules !== undefined && extra.rules.length > 0) base.rules = extra.rules;
  if (extra.unverifiable === true && hits.length > 0) base.unverifiable = true;
  return base;
}

const inputMissing = (code: CheckCode, what: string): CheckResult =>
  mk(code, [{ reason: 'INPUT_MISSING', field: what }]);

type AtomLike = Pick<Atom, 'fm' | 'body'>;

export interface TextField {
  path: string;
  text: string;
}

/** C1 / C1b 扫描的字段:设计稿列出的原子字段 + 提案 rationale,再加提案侧证据摘录(保守:两份摘录都得干净)。 */
export function scanFields(atom: AtomLike, proposal: Proposal): TextField[] {
  const out: TextField[] = [
    { path: 'title', text: atom.fm.title },
    { path: 'body.do', text: atom.body.do },
    { path: 'body.why', text: atom.body.why },
    { path: 'body.verify', text: atom.body.verify },
  ];
  if (atom.fm.signature?.pattern !== undefined) {
    out.push({ path: 'signature.pattern', text: atom.fm.signature.pattern });
  }
  atom.fm.evidence.forEach((e, i) => out.push({ path: `evidence[${i}].excerpt`, text: e.excerpt }));
  out.push({ path: 'proposal.rationale', text: proposal.rationale });
  proposal.evidence.forEach((e, i) =>
    out.push({ path: `proposal.evidence[${i}].excerpt`, text: e.excerpt }),
  );
  return out;
}

/** C8 扫描的字段:C1 的全部字段,外加其余会进补丁的自由文本(owner / origin / evidence.ref / cases / paths)。 */
export function redactionFields(atom: AtomLike, proposal: Proposal): TextField[] {
  const out = scanFields(atom, proposal);
  out.push({ path: 'owner', text: atom.fm.owner });
  if (atom.fm.origin !== undefined) out.push({ path: 'origin', text: atom.fm.origin });
  atom.fm.evidence.forEach((e, i) => out.push({ path: `evidence[${i}].ref`, text: e.ref }));
  atom.fm.paths?.forEach((p, i) => out.push({ path: `paths[${i}]`, text: p }));
  proposal.cases.forEach((c, i) => out.push({ path: `proposal.cases[${i}]`, text: c }));
  // 评审(GPT)指出的漏项:其余会被持久化的字符串字段同样要过复扫
  atom.fm.evidence.forEach((e, i) => out.push({ path: `evidence[${i}].type`, text: e.type }));
  if (atom.fm.verifier.ref !== undefined) {
    out.push({ path: 'verifier.ref', text: atom.fm.verifier.ref });
  }
  proposal.evidence.forEach((e, i) =>
    out.push({ path: `proposal.evidence[${i}].project_key`, text: e.project_key }),
  );
  out.push(
    { path: 'reflector.provider', text: proposal.reflector.provider },
    { path: 'reflector.vendor', text: proposal.reflector.vendor },
    { path: 'reflector.model', text: proposal.reflector.model },
    { path: 'reflector.run_id', text: proposal.reflector.run_id },
  );
  const j = proposal.judge;
  if (j !== undefined) {
    out.push(
      { path: 'judge.provider', text: j.provider },
      { path: 'judge.vendor', text: j.vendor },
    );
    j.conflicts.forEach((c, i) => out.push({ path: `judge.conflicts[${i}]`, text: c }));
    j.hops.forEach((h, i) => {
      out.push(
        { path: `judge.hops[${i}].vendor`, text: h.vendor },
        { path: `judge.hops[${i}].model`, text: h.model },
      );
    });
  }
  proposal.evidence.forEach((e, i) =>
    out.push({ path: `proposal.evidence[${i}].sig`, text: e.sig }),
  );
  return out;
}

// ---------------------------------------------------------------- C1

export interface C1Input {
  atom: AtomLike;
  proposal: Proposal;
}

/**
 * C1 本地重扫注入。judge 的 `injection_suspected=true` → 拒;`=false` 只记录(`info`),**不作放行依据**
 * (`docs/p1-backlog.md:39-40`):下面的本地扫描无论 judge 说什么都照跑。
 */
export function checkC1(input: C1Input): CheckResult {
  const hits: Hit[] = [];
  const rules = new Set<string>();
  for (const f of scanFields(input.atom, input.proposal)) {
    if (hasInvisible(f.text)) hits.push({ reason: 'HIDDEN_CHARS', field: f.path });
    const v = scanDangerousPhrases(f.text);
    if (v.blocked.length > 0) {
      hits.push({ reason: 'DANGEROUS_PHRASE', field: f.path });
      for (const b of v.blocked) rules.add(b);
    }
  }
  const judge = input.proposal.judge;
  if (judge?.injection_suspected === true) {
    hits.push({ reason: 'JUDGE_INJECTION_SUSPECTED', field: 'judge.injection_suspected' });
  }
  return mk('C1', hits, {
    ...(judge?.injection_suspected === false
      ? { info: 'JUDGE_INJECTION_FALSE_NOT_RELIED_ON' }
      : {}),
    rules: [...rules].sort(),
  });
}

// ---------------------------------------------------------------- C1b

/** C1b 不可见字符补全集(`invisible.ts`)。与 C1 的 `hasInvisible` 独立判定,两者都可能报同一字段。 */
export function checkC1b(input: C1Input): CheckResult {
  const hits: Hit[] = [];
  const rules = new Set<string>();
  for (const f of scanFields(input.atom, input.proposal)) {
    const r = findInvisibleRanges(f.text);
    if (r.length > 0) {
      hits.push({ reason: 'HIDDEN_CHARS_EXT', field: f.path });
      for (const n of r) rules.add(n);
    }
  }
  return mk('C1b', hits, { rules: [...rules].sort() });
}

// ---------------------------------------------------------------- C2

/** 本机信号库里查到的信号(只取比对要用的字段) */
export interface SignalFact {
  sig_id?: string;
  project_key: string;
  /** 采集时已脱敏的摘录,提案 / 原子里的摘录必须与它逐字节相等 */
  excerpt_redacted: string;
  session_ref?: string;
}
/** 查不到返回 undefined;信号库损坏时可以抛错(C2 按硬失败处理,不是「无法核对」) */
export type SignalLookup = (sig: string) => SignalFact | undefined;

export interface C2Input {
  atom: AtomLike;
  proposal: Proposal;
  /**
   * 本机信号库查询。`null` = CI 模式,只做后半句(原子证据 ↔ 提案证据一一对应)。
   * 必须显式传(不能省略):忘传不会悄悄退化成 CI 模式。
   */
  lookup: SignalLookup | null;
}

/**
 * C2 证据摘录机械复制。逐字节相等(`===`,不是包含):
 * 提案证据的摘录 = 信号库里的 `excerpt_redacted`,`project_key` 相等;原子 `evidence[i]` 与提案 `evidence[i]` 一一对应
 * (`ref == sig`、摘录相等)。信号库里查不到 → `SIGNAL_NOT_FOUND`,`unverifiable=true`(调用方退出 4,不当通过)。
 */
export function checkC2(input: C2Input): CheckResult {
  const { atom, proposal, lookup } = input;
  const hits: Hit[] = [];
  const ae = atom.fm.evidence;
  const pe = proposal.evidence;
  if (ae.length !== pe.length) {
    hits.push({ reason: 'EVIDENCE_COUNT_MISMATCH', field: 'evidence' });
  } else {
    pe.forEach((p, i) => {
      const a = ae[i]!;
      if (a.ref !== p.sig)
        hits.push({ reason: 'ATOM_EVIDENCE_REF_MISMATCH', field: `evidence[${i}].ref` });
      if (a.excerpt !== p.excerpt) {
        hits.push({ reason: 'ATOM_EVIDENCE_EXCERPT_MISMATCH', field: `evidence[${i}].excerpt` });
      }
    });
  }
  let notFound = 0;
  if (lookup !== null) {
    pe.forEach((p, i) => {
      let s: SignalFact | undefined;
      try {
        s = lookup(p.sig);
      } catch {
        hits.push({ reason: 'SIGNAL_LOOKUP_ERROR', field: `proposal.evidence[${i}]` });
        return;
      }
      if (s === undefined) {
        notFound++;
        hits.push({ reason: 'SIGNAL_NOT_FOUND', field: `proposal.evidence[${i}]` });
        return;
      }
      if (s.sig_id !== undefined && s.sig_id !== p.sig) {
        hits.push({ reason: 'SIGNAL_ID_MISMATCH', field: `proposal.evidence[${i}]` });
      }
      if (s.project_key !== p.project_key) {
        hits.push({ reason: 'PROJECT_KEY_MISMATCH', field: `proposal.evidence[${i}].project_key` });
      }
      if (s.excerpt_redacted !== p.excerpt) {
        hits.push({ reason: 'EXCERPT_MISMATCH', field: `proposal.evidence[${i}].excerpt` });
      }
    });
  }
  const onlyNotFound = hits.length > 0 && hits.every((h) => h.reason === 'SIGNAL_NOT_FOUND');
  return mk('C2', hits, {
    ...(onlyNotFound && notFound > 0 ? { unverifiable: true as const } : {}),
    ...(lookup === null ? { info: 'SIGNAL_LOOKUP_SKIPPED_CI_MODE' } : {}),
  });
}

// ---------------------------------------------------------------- C3

const OWNER_RE = /^@[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface C3Input {
  atom: AtomLike;
  proposal: Proposal;
}

function c3Hits(input: C3Input, lifecycleFieldsToo: boolean): Hit[] {
  const { fm } = input.atom;
  const p = input.proposal;
  const hits: Hit[] = [];
  if (lifecycleFieldsToo && fm.status !== 'proposed')
    hits.push({ reason: 'STATUS_NOT_PROPOSED', field: 'status' });
  if (fm.strength !== 'should') hits.push({ reason: 'STRENGTH_NOT_SHOULD', field: 'strength' });
  if (fm.verifier.type !== 'none')
    hits.push({ reason: 'VERIFIER_NOT_NONE', field: 'verifier.type' });
  // 反思器不写 verifier.ref(none 型不需要);带了就是被手改过,也是一条不经 C1 扫描的自由文本通道
  if (fm.verifier.ref !== undefined) {
    hits.push({ reason: 'VERIFIER_REF_PRESENT', field: 'verifier.ref' });
  }
  if (fm.disables !== undefined) hits.push({ reason: 'EDGE_FIELD_PRESENT', field: 'disables' });
  if (fm.overrides !== undefined) hits.push({ reason: 'EDGE_FIELD_PRESENT', field: 'overrides' });
  if (fm.origin !== `proposal/${p.id}`) hits.push({ reason: 'ORIGIN_MISMATCH', field: 'origin' });
  if (lifecycleFieldsToo) {
    const days = fm.volatility === 'volatile' ? REVIEW_DAYS_VOLATILE : REVIEW_DAYS_STABLE;
    if (fm.review_by !== addDays(fm.created, days)) {
      hits.push({ reason: 'REVIEW_BY_MISMATCH', field: 'review_by' });
    }
  }
  if (!OWNER_RE.test(fm.owner)) hits.push({ reason: 'OWNER_INVALID', field: 'owner' });
  // 反思器从不写这三个字段;出现即说明被手改过(保守取严,设计稿未列,见汇报)
  if (fm.escalation_level !== undefined)
    hits.push({ reason: 'UNEXPECTED_FIELD', field: 'escalation_level' });
  if (fm.supersedes !== undefined) hits.push({ reason: 'UNEXPECTED_FIELD', field: 'supersedes' });
  if (fm.merged_from !== undefined) hits.push({ reason: 'UNEXPECTED_FIELD', field: 'merged_from' });
  // 提案与原子对得上(设计稿未列,保守)
  if (p.op !== 'add') hits.push({ reason: 'PROPOSAL_OP_NOT_ADD', field: 'proposal.op' });
  if (p.targets.length !== 1 || p.targets[0] !== fm.id) {
    hits.push({ reason: 'PROPOSAL_TARGET_MISMATCH', field: 'proposal.targets' });
  }
  return hits;
}

/**
 * C3 固定字段。**没有任何覆盖参数**:`status=proposed`、`strength=should`、`verifier.type=none`、无 `disables/overrides`、
 * `origin=proposal/<id>`、`review_by=created+90/30`(按 volatility)、`owner` 形如 `@handle`。
 * 这是采纳(T0)用的严格版。
 */
export function checkC3(input: C3Input): CheckResult {
  return mk('C3', c3Hits(input, true));
}

/**
 * 晋升(T1/T2)用的版本:`status` 与 `review_by` 本来就是转移要改的两行,所以不查这两项;其余固定字段一字不松。
 * 它不是 `checkC3` 的覆盖参数,而是另一个名字清楚的函数;晋升前的 `status` 合法性由转移白名单(守卫 G3)负责。
 */
export function checkC3Governance(input: C3Input): CheckResult {
  return mk('C3', c3Hits(input, false));
}

// ---------------------------------------------------------------- C4

export interface C4Input {
  atom: AtomLike;
  proposal: Proposal;
  /** `reflect.team_project_keys` 白名单;为空 ⇒ 全部 personal */
  teamProjectKeys: readonly string[];
  /** sig → session_ref(本机信号库反查)。`null` = CI 模式,只查白名单与项目数,不查会话数 */
  sessionRefOf: ((sig: string) => string | undefined) | null;
}

/**
 * C4 层规则。`kind=preference ⇒ personal`;`team` 要求证据 ≥2 个 `project_key` 且全部在白名单、≥2 个 `session_ref`。
 * personal 层:本检查只给判定(通过,`info=LAYER_PERSONAL`);P1 对 personal 怎么处理(退出 2 `PERSONAL_LAYER_P2`)由命令层决定。
 * 聚类级门槛事后无法复算,这里只复算证据级那一半。
 */
export function checkC4(input: C4Input): CheckResult {
  const { atom, proposal } = input;
  const hits: Hit[] = [];
  const layer = atom.fm.layer;
  if (layer !== proposal.layer) hits.push({ reason: 'LAYER_MISMATCH', field: 'layer' });
  if (atom.fm.kind === 'preference' && layer !== 'personal') {
    hits.push({ reason: 'PREFERENCE_NOT_PERSONAL', field: 'layer' });
  }
  if (layer !== 'team' && layer !== 'personal') {
    hits.push({ reason: 'LAYER_UNSUPPORTED', field: 'layer' });
  }
  let missingSessions = 0;
  if (layer === 'team') {
    const white = new Set(input.teamProjectKeys);
    if (white.size === 0) hits.push({ reason: 'TEAM_WHITELIST_EMPTY', field: 'layer' });
    const keys = new Set(proposal.evidence.map((e) => e.project_key));
    if (keys.size < 2) hits.push({ reason: 'TEAM_PROJECTS_LT_2', field: 'proposal.evidence' });
    proposal.evidence.forEach((e, i) => {
      if (!white.has(e.project_key)) {
        hits.push({
          reason: 'PROJECT_NOT_WHITELISTED',
          field: `proposal.evidence[${i}].project_key`,
        });
      }
    });
    if (input.sessionRefOf !== null) {
      const sessions = new Set<string>();
      proposal.evidence.forEach((e, i) => {
        const s = input.sessionRefOf?.(e.sig);
        if (s === undefined) {
          missingSessions++;
          hits.push({ reason: 'SESSION_LOOKUP_MISSING', field: `proposal.evidence[${i}]` });
        } else sessions.add(s);
      });
      if (missingSessions === 0 && sessions.size < 2) {
        hits.push({ reason: 'TEAM_SESSIONS_LT_2', field: 'proposal.evidence' });
      }
    }
  }
  const onlyMissing = hits.length > 0 && hits.every((h) => h.reason === 'SESSION_LOOKUP_MISSING');
  return mk('C4', hits, {
    ...(onlyMissing ? { unverifiable: true as const } : {}),
    ...(layer === 'personal' && hits.length === 0 ? { info: 'LAYER_PERSONAL' } : {}),
  });
}

// ---------------------------------------------------------------- C5

const normVendor = (v: string): string => v.trim().toLowerCase();

export interface C5Input {
  proposal: Proposal;
  /** 覆盖层 `vendor_overrides`(只能追加新家族);用于复算反思器厂商 */
  vendorOverrides?: Readonly<Record<string, string>>;
}

/**
 * C5 评审记录。有 `judge`(不是 `judge_attempts`)、`verdict=accept`、反思器与裁判厂商(归一化后)**可证**不同、
 * `reflector.backend` 必填且 `deriveVendor` 复算与记录一致、`stub` 不得为 true、最后一跳 `ok`
 * 且 `judge.provider` = 最后一跳的槽位 id、最后一跳厂商 = `judge.vendor`。
 */
export function checkC5(input: C5Input): CheckResult {
  const p = input.proposal;
  const hits: Hit[] = [];
  if (p.reflector.stub === true) hits.push({ reason: 'STUB_PROPOSAL', field: 'reflector.stub' });
  if (p.reflector.backend === undefined) {
    hits.push({ reason: 'REFLECTOR_BACKEND_MISSING', field: 'reflector.backend' });
  } else {
    try {
      const derived = deriveVendor(
        { backend: p.reflector.backend, provider: p.reflector.provider, model: p.reflector.model },
        input.vendorOverrides ?? {},
      );
      if (derived === UNKNOWN_VENDOR || derived !== normVendor(p.reflector.vendor)) {
        hits.push({ reason: 'REFLECTOR_VENDOR_MISMATCH', field: 'reflector.vendor' });
      }
    } catch {
      hits.push({ reason: 'VENDOR_OVERRIDES_INVALID', field: 'reflector.vendor' });
    }
  }
  const j = p.judge;
  if (j === undefined) {
    hits.push({
      reason: p.judge_attempts !== undefined ? 'JUDGE_PENDING' : 'JUDGE_MISSING',
      field: 'judge',
    });
  } else {
    if (j.verdict !== 'accept') hits.push({ reason: 'VERDICT_NOT_ACCEPT', field: 'judge.verdict' });
    if (!isCrossVendor(normVendor(p.reflector.vendor), normVendor(j.vendor))) {
      hits.push({ reason: 'VENDOR_NOT_CROSS', field: 'judge.vendor' });
    }
    const last = j.hops[j.hops.length - 1];
    if (last === undefined || last.result !== 'ok') {
      hits.push({ reason: 'JUDGE_LAST_HOP_NOT_OK', field: 'judge.hops' });
    } else {
      if (j.provider !== last.hop) {
        hits.push({ reason: 'JUDGE_PROVIDER_MISMATCH', field: 'judge.provider' });
      }
      if (normVendor(last.vendor) !== normVendor(j.vendor)) {
        hits.push({ reason: 'JUDGE_LAST_HOP_VENDOR_MISMATCH', field: 'judge.hops' });
      }
      // 记录里的 vendor 是自报值:同时改 judge.vendor 与最后一跳 vendor 就能内部自洽。
      // 再用最后一跳的模型串按厂商表复算(只看模型族,没有 backend / provider 事实);推不出或不一致都拒。
      try {
        const derivedJudge = deriveVendor(
          { backend: 'pi', model: last.model },
          input.vendorOverrides ?? {},
        );
        if (derivedJudge === UNKNOWN_VENDOR || derivedJudge !== normVendor(j.vendor)) {
          hits.push({ reason: 'JUDGE_VENDOR_UNPROVEN', field: 'judge.hops' });
        }
      } catch {
        hits.push({ reason: 'VENDOR_OVERRIDES_INVALID', field: 'judge.vendor' });
      }
    }
  }
  return mk('C5', hits);
}

// ---------------------------------------------------------------- C6

export class RuleHashError extends Error {
  readonly code = 'RULE_TEXT_UNHASHABLE';
}

const NORMALIZED = '__NORMALIZED__';
/**
 * 顶层 `status:` / `review_by:` 行:只把**值**换成占位符,值后面的内容(行尾注释等)原样保留并参与哈希,
 * 所以评审后往这两行追加注释不会让哈希不变。值只接受简单标量(字母数字、`-`、`_`、`.`,可带引号);
 * 块标量(`|` `>`)、流式写法、带引号的键等一律不匹配 → 计数不是恰好一行 → 抛 `RuleHashError`(fail-closed)。
 */
const SCALAR_LINE_RE = /^((?:status|review_by))(\s*:\s*)(['"]?[A-Za-z0-9._-]+['"]?)((?:\s.*)?)$/;

/**
 * 规则文本哈希(C6,供 L3/L4 复用):把 frontmatter 顶层的 `status:` 与 `review_by:` 两行的值归一化后,
 * 对 `canonicalText(全文)` 取 sha256(hex)。否则晋升 PR 改这两行就会改哈希。
 * 这里的哈希**不等于** `Atom.sha256`(那是未归一化的整文件哈希),也不是契约注释里的「渲染内容哈希」(未核实,见汇报)。
 * frontmatter 缺失,或 `status` / `review_by` 不是恰好各出现一次 → 抛 `RuleHashError`(不猜)。
 */
export function ruleSha256(atomText: string): string {
  const lf = atomText.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = lf.split('\n');
  if (lines[0] !== '---') throw new RuleHashError('RULE_TEXT_UNHASHABLE: 缺 frontmatter');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new RuleHashError('RULE_TEXT_UNHASHABLE: frontmatter 未闭合');
  let status = 0;
  let review = 0;
  for (let i = 1; i < end; i++) {
    const line = lines[i] as string;
    const sm = SCALAR_LINE_RE.exec(line);
    if (sm === null) continue;
    if (sm[1] === 'status') {
      lines[i] = `${sm[1]}${sm[2]}${NORMALIZED}${sm[4]}`;
      status++;
    } else if (sm[1] === 'review_by') {
      lines[i] = `${sm[1]}${sm[2]}${NORMALIZED}${sm[4]}`;
      review++;
    }
  }
  if (status !== 1 || review !== 1) {
    throw new RuleHashError('RULE_TEXT_UNHASHABLE: status/review_by 不是恰好各一行');
  }
  return createHash('sha256')
    .update(canonicalText(lines.join('\n')), 'utf8')
    .digest('hex');
}

export interface C6Input {
  judge: JudgeRecord | undefined;
  /** 当前原子的全文(含 frontmatter) */
  atomText: string;
}

/** C6 规则文本与评审绑定:`judge.rule_sha256` 必须存在且等于 `ruleSha256(当前文本)`。 */
export function checkC6(input: C6Input): CheckResult {
  const j = input.judge;
  if (j === undefined) return mk('C6', [{ reason: 'JUDGE_MISSING', field: 'judge' }]);
  if (j.rule_sha256 === undefined) {
    return mk('C6', [{ reason: 'RULE_SHA256_MISSING', field: 'judge.rule_sha256' }]);
  }
  let now: string;
  try {
    now = ruleSha256(input.atomText);
  } catch {
    return mk('C6', [{ reason: 'RULE_TEXT_UNHASHABLE', field: 'atomText' }]);
  }
  if (j.rule_sha256 !== now) {
    return mk('C6', [{ reason: 'RULE_SHA256_MISMATCH', field: 'judge.rule_sha256' }]);
  }
  return mk('C6', []);
}

// ---------------------------------------------------------------- C7

export interface C7Input {
  atom: AtomLike;
  /**
   * `adopt` = 采纳(T0):原子还不在仓库,id 不得出现在仓库 / 暂存区 / 墓碑里;
   * `promote` = 晋升 / CI(T1/T2):原子本来就在仓库,自己的 id 不算冲突(也不与自己比相似度),墓碑照查。
   */
  mode: 'adopt' | 'promote';
  /** 仓库 `rules/*` 下所有文件的 id(文件名 stem,解析失败的文件也要在内) */
  existingIds: ReadonlySet<string>;
  /** 仓库已有原子(去重用);含 retired / deprecated,与之相似会标 resurrects */
  existingAtoms: readonly DedupeTarget[];
  /** 其它暂存运行(`.state/reflect/*`)里的原子 id */
  stagedIds: ReadonlySet<string>;
  /**
   * 其它暂存运行里的原子内容(去重用;口径同 `dedupe.ts`:已有原子 ∪ 暂存区 ∪ 同批先出现的提案)。
   * 必填:忘传就是类型错误,而不是悄悄只比仓库(GPT 评审指出的缺口)。同批其它候选也放在这里。
   */
  stagedAtoms: readonly DedupeTarget[];
  /** 退役记录(`lifecycle/<rule-id>/`)里出现过的 rule_id:墓碑,原子文件被删后 id 仍不可重用 */
  tombstoneIds: ReadonlySet<string>;
  thresholds?: DedupeThresholds;
}

/** C7 id 与去重。 */
export function checkC7(input: C7Input): CheckResult {
  const { atom, mode } = input;
  const id = atom.fm.id;
  const hits: Hit[] = [];
  if (mode === 'adopt' && input.existingIds.has(id)) {
    hits.push({ reason: 'ID_EXISTS_IN_REPO', field: 'id' });
  }
  if (mode === 'adopt' && input.stagedIds.has(id)) {
    hits.push({ reason: 'ID_EXISTS_IN_STAGING', field: 'id' });
  }
  if (input.tombstoneIds.has(id)) hits.push({ reason: 'ID_TOMBSTONED', field: 'id' });
  const draft: DedupeTarget = {
    id,
    do: atom.body.do,
    why: atom.body.why,
    status: atom.fm.status,
    signature:
      atom.fm.signature === undefined
        ? undefined
        : { type: atom.fm.signature.type, pattern: atom.fm.signature.pattern },
  };
  const pool = [...input.existingAtoms, ...input.stagedAtoms];
  const targets = mode === 'promote' ? pool.filter((t) => t.id !== id) : pool;
  const dup =
    input.thresholds === undefined
      ? findDuplicate(draft, targets)
      : findDuplicate(draft, targets, input.thresholds);
  if (dup !== undefined) {
    hits.push({
      reason: dup.resurrects ? 'NEAR_DUPLICATE_RESURRECTS_RETIRED' : 'NEAR_DUPLICATE',
      field: 'body',
    });
  }
  return mk('C7', hits, dup === undefined ? {} : { info: `DUPLICATE_OF:${dup.duplicateOf}` });
}

// ---------------------------------------------------------------- C8

export interface C8Input {
  atom: AtomLike;
  proposal: Proposal;
  redactor: Pick<Redactor, 'pass2'>;
}

/** C8 脱敏复扫。扫描抛异常按不干净处理(同 `stage.ts` 的做法)。 */
export function checkC8(input: C8Input): CheckResult {
  const hits: Hit[] = [];
  for (const f of redactionFields(input.atom, input.proposal)) {
    let clean = false;
    let threw = false;
    try {
      clean = input.redactor.pass2(f.text).clean === true;
    } catch {
      threw = true;
    }
    if (threw) hits.push({ reason: 'REDACTION_SCAN_ERROR', field: f.path });
    else if (!clean) hits.push({ reason: 'REDACTION_RESIDUAL', field: f.path });
  }
  return mk('C8', hits);
}

// ---------------------------------------------------------------- C9

/** 与 `src/reflect/stage.ts` 的 `SAFE_PATH_RE` 同值(那边未导出,临时复刻,见汇报「需要导出」)。 */
export const SAFE_PATH_RE = /^[a-z0-9][a-z0-9/._-]*$/;

/** 调用方 lstat 出来的事实;本库不碰文件系统 */
export interface FsFact {
  /** 仅作报告用的标签(相对路径),不要放绝对路径 */
  path: string;
  /** 期望:运行目录为 `dir`,其中文件为 `file`;链接 / 其它类型一律拒 */
  kind: 'file' | 'dir' | 'symlink' | 'other';
  expect: 'file' | 'dir';
  nlink: number;
}

export interface C9Input {
  runId: string;
  /** 将进补丁的文件(仓库相对路径 + 内容) */
  files: readonly { path: string; content: string }[];
  /** 运行目录与其中每个读到的文件的 lstat 事实;必须由调用方给全 */
  fsFacts: readonly FsFact[];
}

/** C9 路径与补丁安全:`SAFE_PATH_RE`、`isUnsafePath`、`patchUnsafe`、run_id 形状、目录 / 文件非符号链接且文件非硬链接。 */
export function checkC9(input: C9Input): CheckResult {
  const hits: Hit[] = [];
  if (!RunIdSchema.safeParse(input.runId).success) {
    hits.push({ reason: 'RUN_ID_INVALID', field: 'run_id' });
  }
  for (const f of input.files) {
    if (isUnsafePath(f.path) || !SAFE_PATH_RE.test(f.path)) {
      hits.push({ reason: 'PATH_UNSAFE', field: f.path });
    }
    if (patchUnsafe(f.content) !== undefined) {
      hits.push({ reason: 'PATCH_CONTENT_UNSAFE', field: f.path });
    }
  }
  for (const t of input.fsFacts) {
    if (t.kind === 'symlink') hits.push({ reason: 'FS_SYMLINK', field: t.path });
    else if (t.kind !== t.expect) hits.push({ reason: 'FS_NOT_REGULAR', field: t.path });
    else if (t.expect === 'file' && t.nlink > 1)
      hits.push({ reason: 'FS_HARDLINK', field: t.path });
  }
  return mk('C9', hits);
}

// ---------------------------------------------------------------- 聚合

export interface RunChecksInput {
  atom: AtomLike;
  /** 当前原子全文(C6 要用) */
  atomText: string;
  proposal: Proposal;
  /** `strict` = 采纳(C3 全查);`governance` = 晋升(C3 不查 status/review_by) */
  c3Mode?: 'strict' | 'governance';
  // C2
  signalLookup?: SignalLookup | null;
  // C4
  teamProjectKeys?: readonly string[];
  sessionRefOf?: ((sig: string) => string | undefined) | null;
  // C5
  vendorOverrides?: Readonly<Record<string, string>>;
  // C7
  c7?: Omit<C7Input, 'atom'>;
  // C8
  redactor?: Pick<Redactor, 'pass2'>;
  // C9
  c9?: C9Input;
}

export interface AggregateResult {
  ok: boolean;
  /** 被选中的全部检查结果(按 `CHECK_CODES` 顺序) */
  results: CheckResult[];
  /** 所有失败项(不短路) */
  failures: CheckResult[];
  /** 有失败,且每个失败都只是「本机无法核对」→ 调用方退出 4;否则按硬失败处理 */
  unverifiableOnly: boolean;
}

function runOne(code: CheckCode, i: RunChecksInput): CheckResult {
  switch (code) {
    case 'C1':
      return checkC1(i);
    case 'C1b':
      return checkC1b(i);
    case 'C2':
      return i.signalLookup === undefined
        ? inputMissing('C2', 'signalLookup')
        : checkC2({ atom: i.atom, proposal: i.proposal, lookup: i.signalLookup });
    case 'C3':
      return (i.c3Mode ?? 'strict') === 'strict' ? checkC3(i) : checkC3Governance(i);
    case 'C4':
      return i.teamProjectKeys === undefined || i.sessionRefOf === undefined
        ? inputMissing('C4', 'teamProjectKeys/sessionRefOf')
        : checkC4({
            atom: i.atom,
            proposal: i.proposal,
            teamProjectKeys: i.teamProjectKeys,
            sessionRefOf: i.sessionRefOf,
          });
    case 'C5':
      return checkC5({
        proposal: i.proposal,
        ...(i.vendorOverrides !== undefined ? { vendorOverrides: i.vendorOverrides } : {}),
      });
    case 'C6':
      return checkC6({ judge: i.proposal.judge, atomText: i.atomText });
    case 'C7':
      return i.c7 === undefined ? inputMissing('C7', 'c7') : checkC7({ atom: i.atom, ...i.c7 });
    case 'C8':
      return i.redactor === undefined
        ? inputMissing('C8', 'redactor')
        : checkC8({ atom: i.atom, proposal: i.proposal, redactor: i.redactor });
    case 'C9':
      return i.c9 === undefined ? inputMissing('C9', 'c9') : checkC9(i.c9);
  }
}

/**
 * 跑选中的检查(缺省全部)并返回所有失败项。选中的检查缺输入 → `INPUT_MISSING`(失败,不是跳过);
 * 检查自己抛异常 → `CHECK_INTERNAL_ERROR`(失败)。
 */
export function runChecks(
  input: RunChecksInput,
  which: readonly CheckCode[] = CHECK_CODES,
): AggregateResult {
  const results: CheckResult[] = [];
  for (const code of CHECK_CODES) {
    if (!which.includes(code)) continue;
    try {
      results.push(runOne(code, input));
    } catch {
      results.push(mk(code, [{ reason: 'CHECK_INTERNAL_ERROR', field: '' }]));
    }
  }
  const failures = results.filter((r) => !r.ok);
  return {
    ok: failures.length === 0,
    results,
    failures,
    unverifiableOnly: failures.length > 0 && failures.every((f) => f.unverifiable === true),
  };
}

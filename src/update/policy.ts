/**
 * 自动更新的策略核心(纯函数,不联网、不读环境、不写盘;docs/contracts.md §19.1 / §19.5)。
 *
 * 安全判断不依赖本机时钟:冷却期的「现在」取 npmjs 响应 `Date` 头,发布时间取 npmjs 的 `time[v]`;
 * 本机时钟(注入的 nowMs)只用于检查节流。任何缺失 / 不可解析 / 为负一律 fail-closed。
 * 每个拒绝都有稳定原因码(`code`)与次级细分(`detail`),不同原因不合并。
 */
import { SEMVER_RE } from '../contracts/common.js';
import {
  UPDATE_CHECK_INTERVAL_HOURS,
  UPDATE_COOLDOWN_HOURS_DEFAULT,
  UPDATE_PIN_RE,
} from '../contracts/update.js';
import type { NetErrorCode } from '../io/net.js';

// ---------------------------------------------------------------------------
// SemVer
// ---------------------------------------------------------------------------

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: readonly string[];
}

export function parseSemver(s: string): Semver | undefined {
  if (!SEMVER_RE.test(s)) return undefined;
  const dash = s.indexOf('-');
  const core = (dash === -1 ? s : s.slice(0, dash)).split('.').map(Number);
  const pre = dash === -1 ? [] : s.slice(dash + 1).split('.');
  const [major, minor, patch] = core;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  if (![major, minor, patch].every((n) => Number.isSafeInteger(n))) return undefined;
  return { major, minor, patch, pre };
}

/** SemVer 2.0 排序:返回 <0 / 0 / >0 */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      // 数字标识符无前导零(SEMVER_RE 保证),长度长者大,等长按字典序;不转 Number(超过 2^53 会舍入)
      if (x.length !== y.length) return x.length - y.length;
      if (x !== y) return x < y ? -1 : 1;
    } else if (xn) return -1;
    else if (yn) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function cmpStr(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === undefined || pb === undefined) throw new RangeError(`非法版本号:${a} / ${b}`);
  return compareSemver(pa, pb);
}

/** pin 语义:`X.Y.Z[-pre]` 精确;`~X.Y` = >=X.Y.0 <X.(Y+1).0;`~X.Y.Z` = >=X.Y.Z <X.(Y+1).0。非法 pin 恒为 false。 */
export function satisfiesPin(version: string, pin: string): boolean {
  if (!UPDATE_PIN_RE.test(pin)) return false;
  const v = parseSemver(version);
  if (v === undefined) return false;
  if (!pin.startsWith('~')) return version === pin;
  const parts = pin.slice(1).split('.').map(Number);
  const [major, minor, patch] = parts;
  if (major === undefined || minor === undefined) return false;
  const lower: Semver = { major, minor, patch: patch ?? 0, pre: [] };
  const upper: Semver = { major, minor: minor + 1, patch: 0, pre: [] };
  // 上界的预发布(如 1.3.0-rc.0)按 npm 惯例也排除在 ~1.2 之外
  const upperPre: Semver = { ...upper, pre: ['0'] };
  return compareSemver(v, lower) >= 0 && compareSemver(v, upperPre) < 0;
}

// ---------------------------------------------------------------------------
// 时间解析(fail-closed:解析不了就是 undefined)
// ---------------------------------------------------------------------------

const HTTP_DATE_RE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** RFC 9110 IMF-fixdate(`Wed, 14 Oct 2026 07:24:51 GMT`) */
export function parseHttpDate(s: string | undefined): number | undefined {
  if (s === undefined || !HTTP_DATE_RE.test(s)) return undefined;
  const ms = Date.parse(s);
  // Date.parse 会把 Feb 30 之类归一化成下个月:回写比对,不一致即不可解析
  return Number.isNaN(ms) || new Date(ms).toUTCString() !== s ? undefined : ms;
}

/** npm `time[v]` 的 UTC ISO 写法 */
export function parseIsoUtc(s: string | undefined): number | undefined {
  if (s === undefined || !ISO_UTC_RE.test(s)) return undefined;
  const ms = Date.parse(s);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== s.slice(0, 19)
    ? undefined
    : ms;
}

// ---------------------------------------------------------------------------
// 开关(gate)与节流
// ---------------------------------------------------------------------------

export const GATE_OFF_REASONS = [
  'env_off',
  'launched',
  'ci',
  'not_tty',
  'config_off',
  'command_excluded',
] as const;
export type GateOffReason = (typeof GATE_OFF_REASONS)[number];
export type Gate = { enabled: true } | { enabled: false; reason: GateOffReason };

const CI_ENV_KEYS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TF_BUILD',
  'JENKINS_URL',
];
/** 交互式启动检查不适用的命令(CI 也会用) */
export const NO_UPDATE_CHECK_COMMANDS: readonly string[] = ['check', 'build'];

function truthyEnv(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== '' && t !== '0' && t !== 'false';
}

export function autoUpdateGate(input: {
  env: Readonly<Record<string, string | undefined>>;
  isTTY: boolean;
  /** UserConfig.update.auto_install */
  autoInstall: boolean;
  command?: string;
}): Gate {
  const off = (reason: GateOffReason): Gate => ({ enabled: false, reason });
  const flag = input.env['KIT_AUTO_UPDATE']?.trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') return off('env_off');
  if (truthyEnv(input.env['KIT_LAUNCHED'])) return off('launched');
  if (CI_ENV_KEYS.some((k) => truthyEnv(input.env[k]))) return off('ci');
  if (!input.isTTY) return off('not_tty');
  if (!input.autoInstall) return off('config_off');
  if (input.command !== undefined && NO_UPDATE_CHECK_COMMANDS.includes(input.command)) {
    return off('command_excluded');
  }
  return { enabled: true };
}

export type ThrottleReason = 'never' | 'unparseable' | 'clock_back' | 'elapsed' | 'throttled';
export interface Throttle {
  due: boolean;
  reason: ThrottleReason;
}

/** 24h 节流。时钟往回走(now < last)视为该检查了;只决定检查频率,不参与任何安全判断。 */
export function checkDue(
  lastCheckAt: string | undefined,
  nowMs: number,
  intervalHours: number = UPDATE_CHECK_INTERVAL_HOURS,
): Throttle {
  if (lastCheckAt === undefined) return { due: true, reason: 'never' };
  const last = Date.parse(lastCheckAt);
  if (Number.isNaN(last)) return { due: true, reason: 'unparseable' };
  if (nowMs < last) return { due: true, reason: 'clock_back' };
  if (nowMs - last >= intervalHours * 3_600_000) return { due: true, reason: 'elapsed' };
  return { due: false, reason: 'throttled' };
}

// ---------------------------------------------------------------------------
// packument 视图
// ---------------------------------------------------------------------------

export interface VersionDist {
  hasIntegrity: boolean;
  hasTarball: boolean;
  integrity?: string;
  tarball?: string;
}
export interface PackumentView {
  distTags: Readonly<Record<string, string>>;
  versions: Readonly<Record<string, VersionDist>>;
  time: Readonly<Record<string, string>>;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** 从 JSON 收窄出 packument 视图;形状不对返回 undefined(调用方记 `parse`)。 */
export function readPackument(raw: unknown): PackumentView | undefined {
  if (!isRecord(raw)) return undefined;
  const tags = raw['dist-tags'];
  const versions = raw['versions'];
  if (!isRecord(tags) || !isRecord(versions)) return undefined;
  const distTags: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) if (typeof v === 'string') distTags[k] = v;
  const outVersions: Record<string, VersionDist> = {};
  for (const [k, v] of Object.entries(versions)) {
    const dist = isRecord(v) && isRecord(v['dist']) ? v['dist'] : {};
    const integrity = typeof dist['integrity'] === 'string' ? dist['integrity'] : undefined;
    const tarball = typeof dist['tarball'] === 'string' ? dist['tarball'] : undefined;
    outVersions[k] = {
      hasIntegrity: integrity !== undefined && integrity !== '',
      hasTarball: tarball !== undefined && tarball !== '',
      ...(integrity !== undefined ? { integrity } : {}),
      ...(tarball !== undefined ? { tarball } : {}),
    };
  }
  const time: Record<string, string> = {};
  if (isRecord(raw['time'])) {
    for (const [k, v] of Object.entries(raw['time'])) if (typeof v === 'string') time[k] = v;
  }
  return { distTags, versions: outVersions, time };
}

// ---------------------------------------------------------------------------
// 决策
// ---------------------------------------------------------------------------

export const DECISION_CODES = [
  'ok',
  'up_to_date',
  'pinned',
  'cooldown',
  'major_available',
  'downgrade_refused',
  'not_ready',
  'verify_failed',
  'attestations_unreachable',
  'parse',
] as const;
export type DecisionCode = (typeof DECISION_CODES)[number];

/** 同一 code 下的细分(每个都有夹具) */
export const DECISION_DETAILS = [
  'dist_tag_missing',
  'dist_tag_invalid',
  'prerelease_on_latest',
  'bad_version',
  'no_version_in_pin',
  'version_missing',
  'dist_incomplete',
  'mirror_lacks_version',
  'mirror_dist_incomplete',
  'date_header_missing',
  'date_header_unparseable',
  'time_missing',
  'time_unparseable',
  'negative_age',
  'not_elapsed',
  'npmjs_packument_unreachable',
  'host_denied',
] as const;
export type DecisionDetail = (typeof DECISION_DETAILS)[number];

export interface Decision {
  code: DecisionCode;
  detail?: DecisionDetail;
  /** 目标版本(ok / 被拒时尽量给出) */
  version?: string;
  /** 底层原因(如 npmjs 取不到时的网络码) */
  cause?: string;
  publishedAt?: string;
  ageMs?: number;
}

export type NpmjsFacts =
  | { kind: 'ok'; view: PackumentView; dateHeader: string | undefined }
  | { kind: 'unreachable'; cause: string };

export interface DecideInput {
  installed: string;
  /** 只增不减的最高版本(state.max_seen_version) */
  maxSeen?: string | undefined;
  badVersions: readonly string[];
  channel: 'latest' | 'rc';
  pin?: string | undefined;
  /** `update --major --write` 才为 true */
  allowMajor: boolean;
  cooldownHours?: number;
  /** `--now`:跳过冷却期,其余照旧 */
  skipCooldown?: boolean;
  /** 配置的 registry 是否非 npmjs */
  mirror: boolean;
  /** 配置的 registry 的 packument(非镜像时与 npmjs 同一份) */
  primary: PackumentView;
  /** npmjs 的事实:冷却期的时间来源与候选版本的权威;镜像取不到时按 attestations_unreachable */
  npmjs: NpmjsFacts;
}

export function decideUpdate(input: DecideInput): Decision {
  const installed = parseSemver(input.installed);
  if (installed === undefined) throw new RangeError(`已安装版本号非法:${input.installed}`);
  const cooldownHours = input.cooldownHours ?? UPDATE_COOLDOWN_HOURS_DEFAULT;

  if (input.npmjs.kind === 'unreachable') {
    // 镜像下取不到 npmjs:契约要求记 attestations_unreachable;原始网络码留在 cause
    return {
      code: 'attestations_unreachable',
      detail: 'npmjs_packument_unreachable',
      cause: input.npmjs.cause,
    };
  }
  const authority = input.npmjs.view;
  const floor =
    input.maxSeen !== undefined &&
    parseSemver(input.maxSeen) !== undefined &&
    cmpStr(input.maxSeen, input.installed) > 0
      ? input.maxSeen
      : input.installed;

  const tag = authority.distTags[input.channel];
  if (tag === undefined) return { code: 'not_ready', detail: 'dist_tag_missing' };
  if (parseSemver(tag) === undefined) return { code: 'parse', detail: 'dist_tag_invalid' };

  // 预发布只进 rc 通道,或用户精确钉了一个预发布版本
  const pinIsPre = input.pin !== undefined && !input.pin.startsWith('~') && input.pin.includes('-');
  const allowPre = input.channel === 'rc' || pinIsPre;
  const bad = new Set(input.badVersions);

  // 目标:无 pin → dist-tag;有 pin 且 dist-tag 在范围内 → dist-tag;否则取范围内可升级的最高版本
  let target = tag;
  let pinBlocked = false;
  if (input.pin !== undefined && !satisfiesPin(tag, input.pin)) {
    let best: string | undefined;
    for (const v of Object.keys(authority.versions)) {
      const sv = parseSemver(v);
      if (sv === undefined || !satisfiesPin(v, input.pin) || bad.has(v)) continue;
      if (sv.pre.length > 0 && !allowPre) continue;
      if (best === undefined || cmpStr(v, best) > 0) best = v;
    }
    if (best !== undefined && cmpStr(best, input.installed) > 0) target = best;
    else pinBlocked = cmpStr(tag, input.installed) > 0;
  }

  // 防降级:低于「已安装与见过的最高」一律拒
  if (cmpStr(target, floor) < 0) {
    return { code: 'downgrade_refused', version: target };
  }
  if (cmpStr(target, input.installed) === 0) return { code: 'up_to_date', version: target };
  if (pinBlocked) return { code: 'pinned', detail: 'no_version_in_pin', version: tag };
  if (bad.has(target)) return { code: 'verify_failed', detail: 'bad_version', version: target };

  const tsv = parseSemver(target);
  if (tsv === undefined) return { code: 'parse', detail: 'dist_tag_invalid' };
  if (tsv.pre.length > 0 && !allowPre) {
    return { code: 'not_ready', detail: 'prerelease_on_latest', version: target };
  }
  if (tsv.major !== installed.major && !input.allowMajor) {
    return { code: 'major_available', version: target };
  }

  // 半可见期:权威侧(与镜像侧)必须已有该版本及完整 dist
  const auth = authority.versions[target];
  if (auth === undefined) return { code: 'not_ready', detail: 'version_missing', version: target };
  if (!auth.hasIntegrity || !auth.hasTarball) {
    return { code: 'not_ready', detail: 'dist_incomplete', version: target };
  }
  if (input.mirror) {
    const m = input.primary.versions[target];
    if (m === undefined)
      return { code: 'not_ready', detail: 'mirror_lacks_version', version: target };
    if (!m.hasTarball)
      return { code: 'not_ready', detail: 'mirror_dist_incomplete', version: target };
  }

  // 冷却期:age = npmjs Date 头 − npmjs time[v];缺失 / 不可解析 / 为负 → 未满
  const publishedAt = authority.time[target];
  let ageMs: number | undefined;
  if (input.skipCooldown !== true) {
    const rawDate = input.npmjs.dateHeader;
    if (rawDate === undefined)
      return { code: 'cooldown', detail: 'date_header_missing', version: target };
    const nowMs = parseHttpDate(rawDate);
    if (nowMs === undefined)
      return { code: 'cooldown', detail: 'date_header_unparseable', version: target };
    if (publishedAt === undefined)
      return { code: 'cooldown', detail: 'time_missing', version: target };
    const pubMs = parseIsoUtc(publishedAt);
    if (pubMs === undefined)
      return { code: 'cooldown', detail: 'time_unparseable', version: target };
    ageMs = nowMs - pubMs;
    if (ageMs < 0)
      return { code: 'cooldown', detail: 'negative_age', version: target, publishedAt, ageMs };
    if (!(ageMs >= cooldownHours * 3_600_000)) {
      return { code: 'cooldown', detail: 'not_elapsed', version: target, publishedAt, ageMs };
    }
  }
  return {
    code: 'ok',
    version: target,
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(ageMs !== undefined ? { ageMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// 网络失败 → 结果码(不合并)
// ---------------------------------------------------------------------------

export interface MappedFailure {
  /** UpdateResult 取值:网络码原样;host_denied → verify_failed(契约无专码,细分保留) */
  code: string;
  detail?: DecisionDetail;
}

export function mapNetFailure(code: NetErrorCode): MappedFailure {
  if (code === 'host_denied') return { code: 'verify_failed', detail: 'host_denied' };
  return { code };
}

// ---------------------------------------------------------------------------
// tarball 与 npmjs attestation 的绑定(决策 ⑭B)
// ---------------------------------------------------------------------------

export const SLSA_PREDICATE = 'https://slsa.dev/provenance/v1';

export interface AttestationSubject {
  name: string;
  sha512: string;
}
/** 一条 attestation(DSSE statement):subject 与 predicateType 保持关联,不可跨条拼接 */
export interface AttestationStatement {
  /** 外层 predicateType(registry 响应里的) */
  predicateType: string;
  /** payload 内 statement 自带的 predicateType;与外层不一致说明被拼接 / 改动 */
  innerPredicateType: string | undefined;
  subjects: AttestationSubject[];
}
export interface ParsedAttestations {
  statements: AttestationStatement[];
}

/**
 * 从 npmjs attestations 响应取出各 statement(只解码 DSSE payload)。
 * ⚠️ 这里**不验签**:签名 / 证书链 / 仓库身份由 S7 的 provenance.ts 负责,且 S7 必须验证的就是
 * 这里参与绑定的那条 SLSA statement;未验签的摘要不得单独当作信任依据。
 */
export function parseAttestations(json: unknown): ParsedAttestations | undefined {
  if (!isRecord(json) || !Array.isArray(json['attestations'])) return undefined;
  const statements: AttestationStatement[] = [];
  for (const a of json['attestations'] as unknown[]) {
    if (!isRecord(a) || typeof a['predicateType'] !== 'string') return undefined;
    const bundle = a['bundle'];
    const env = isRecord(bundle) ? bundle['dsseEnvelope'] : undefined;
    const payload = isRecord(env) ? env['payload'] : undefined;
    if (typeof payload !== 'string') return undefined;
    let stmt: unknown;
    try {
      stmt = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    } catch {
      return undefined;
    }
    if (!isRecord(stmt) || !Array.isArray(stmt['subject'])) return undefined;
    const subjects: AttestationSubject[] = [];
    for (const sj of stmt['subject'] as unknown[]) {
      if (!isRecord(sj) || typeof sj['name'] !== 'string' || !isRecord(sj['digest']))
        return undefined;
      const d = sj['digest']['sha512'];
      if (typeof d !== 'string') return undefined;
      subjects.push({ name: sj['name'], sha512: d.toLowerCase() });
    }
    statements.push({
      predicateType: a['predicateType'],
      innerPredicateType:
        typeof stmt['predicateType'] === 'string' ? stmt['predicateType'] : undefined,
      subjects,
    });
  }
  return { statements };
}

export type AttestationFetch =
  { kind: 'ok'; json: unknown } | { kind: 'absent' } | { kind: 'unreachable'; cause: string };

export type BindingResult =
  | { ok: true }
  | {
      ok: false;
      code: 'verify_failed' | 'attestations_unreachable';
      reason: 'integrity' | 'provenance_missing' | 'bundle' | 'attestations_unreachable';
      cause?: string;
    };

export function expectedSubjectName(name: string, version: string): string {
  return `pkg:npm/${name.replace('@', '%40')}@${version}`;
}

/**
 * 镜像规则(⑭B):tarball 的 sha512 必须等于 **npmjs** attestation 的 subject 摘要;
 * 镜像给的 dist.integrity 只作提示(镜像模式不比对)。非镜像时 dist.integrity 也必须一致。
 * 取不到 attestation → attestations_unreachable(不装);npmjs 明确 404 → provenance_missing。
 */
export function verifyTarballBinding(input: {
  name: string;
  version: string;
  tarballSha512Hex: string;
  /** 取 tarball 的 registry 在 packument 里给的 `sha512-<base64>` */
  distIntegrity: string | undefined;
  tarballIntegrity: string;
  mirror: boolean;
  attestations: AttestationFetch;
}): BindingResult {
  const att = input.attestations;
  if (att.kind === 'unreachable') {
    return {
      ok: false,
      code: 'attestations_unreachable',
      reason: 'attestations_unreachable',
      cause: att.cause,
    };
  }
  if (att.kind === 'absent') {
    return { ok: false, code: 'verify_failed', reason: 'provenance_missing' };
  }
  const parsed = parseAttestations(att.json);
  if (parsed === undefined) return { ok: false, code: 'verify_failed', reason: 'bundle' };
  const want = expectedSubjectName(input.name, input.version);
  const sha = input.tarballSha512Hex.toLowerCase();
  // 任何 statement 里点名本包本版本的 subject,摘要都必须等于 tarball
  const named = parsed.statements.flatMap((st) => st.subjects.filter((x) => x.name === want));
  if (named.length === 0) return { ok: false, code: 'verify_failed', reason: 'bundle' };
  if (!named.every((x) => x.sha512 === sha)) {
    return { ok: false, code: 'verify_failed', reason: 'integrity' };
  }
  // 必须有一条 SLSA provenance **本身**点名本包本版本(外层与 payload 内 predicateType 一致),不得与别的条拼接
  const slsa = parsed.statements.filter(
    (st) => st.predicateType === SLSA_PREDICATE && st.innerPredicateType === SLSA_PREDICATE,
  );
  if (slsa.length === 0) return { ok: false, code: 'verify_failed', reason: 'provenance_missing' };
  if (!slsa.some((st) => st.subjects.some((x) => x.name === want))) {
    return { ok: false, code: 'verify_failed', reason: 'provenance_missing' };
  }
  if (!input.mirror && input.distIntegrity !== input.tarballIntegrity) {
    return { ok: false, code: 'verify_failed', reason: 'integrity' };
  }
  return { ok: true };
}

/**
 * S5:doctor 的 16 个检查(D01–D16,docs/contracts.md §19.3),每个是纯函数:输入是调用方探测好的只读快照 / 状态,
 * 输出是 CheckResult。本文件不读盘、不写盘、不联网、不读环境;所有字符串输出都经 types.ts 的过滤器。
 *
 * D05 / D06 / D07 / D08 复用 S3 的分类(`src/sync/classify.ts` 的 preflightEntry / currentOf 与 `planSync` 的计划),
 * 不另写第二套漂移判定。
 */
import { isHomeWritePath } from '../contracts/sync.js';
import type { SyncLedgerEntry } from '../contracts/sync.js';
import type { LastAutoSync, UpdateState } from '../contracts/update.js';
import { NPMJS_REGISTRY } from '../contracts/update.js';
import { CODE, currentOf, preflightEntry } from '../sync/classify.js';
import type { DiskEntry, SyncPlan } from '../sync/types.js';
import { compareSemver, parseSemver } from '../update/policy.js';
import type { Gate } from '../update/policy.js';
import { en, iso, result, sha12, showPath, ver } from './types.js';
import type { CheckResult } from './types.js';

const managed = (p: string): boolean => isHomeWritePath(p);

export const MIN_NODE_MAJOR = 22;

// ---------------------------------------------------------------------------
// D01 运行时
// ---------------------------------------------------------------------------

export interface D01Input {
  /** `process.versions.node` */
  nodeVersion: string;
  /** 本进程所属包的版本(bootstrap 版本) */
  bootstrapVersion: string | undefined;
  /** `~/.local/share/agent-kit/current` 的现状 */
  currentLink: 'absent' | 'symlink' | 'other';
  /** state.json 的 installed.version */
  installedVersion: string | undefined;
  /** KIT_LAUNCHED 已设 = 本次由启动器拉起,即正在用 current */
  launched: boolean;
}

/** result:ok | node_too_old | launcher_broken | current_unrecorded。启动器未安装(S7c 之前)不算问题。 */
export function checkD01(i: D01Input): CheckResult {
  const major = Number.parseInt(i.nodeVersion.split('.')[0] ?? '', 10);
  const launcher =
    i.currentLink === 'absent' && i.installedVersion === undefined
      ? 'not_installed'
      : i.currentLink === 'symlink' && i.installedVersion !== undefined
        ? 'installed'
        : i.currentLink === 'other'
          ? 'broken'
          : 'unrecorded';
  const facts = {
    node_major: Number.isInteger(major) ? major : null,
    bootstrap_version: ver(i.bootstrapVersion),
    current_version: ver(i.installedVersion),
    launcher,
    using_current: i.launched,
  };
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    return result('D01', 'fail', 'node_too_old', { facts });
  }
  if (launcher === 'broken') return result('D01', 'warn', 'launcher_broken', { facts });
  if (launcher === 'unrecorded') return result('D01', 'warn', 'current_unrecorded', { facts });
  return result('D01', 'ok', 'ok', { facts });
}

// ---------------------------------------------------------------------------
// D02 安装完整性
// ---------------------------------------------------------------------------

export interface D02Input {
  /** absent = 没有 current(启动器未装 / 未启用);unsafe = current 不在 versions/ 之内、或不是目录 */
  current: 'absent' | 'unsafe' | 'present';
  integrity: 'missing' | 'invalid' | 'ok';
  files: { checked: number; mismatch: number; missing: number; extra: number };
  /** integrity.json 自身的 sha256 */
  integritySha256: string | undefined;
  /** state.json 里 installed.anchor(外部锚点) */
  anchor: string | undefined;
}

/**
 * result:n_a(无 current)| ok | current_unsafe | integrity_missing | integrity_invalid | file_mismatch |
 * anchor_missing | anchor_mismatch。integrity.json 与 current 逐文件自洽还不够:自身 sha 必须等于安装时记下的外部锚点。
 */
export function checkD02(i: D02Input): CheckResult {
  if (i.current === 'absent') return result('D02', 'n_a', 'no_current');
  const counts = { ...i.files };
  const anchorMatch =
    i.anchor === undefined || i.integritySha256 === undefined
      ? null
      : i.anchor === i.integritySha256;
  const facts = {
    integrity_sha12: sha12(i.integritySha256),
    anchor_sha12: sha12(i.anchor),
    anchor_match: anchorMatch,
  };
  const fail = (r: string): CheckResult => result('D02', 'fail', r, { counts, facts });
  if (i.current === 'unsafe') return fail('current_unsafe');
  if (i.integrity === 'missing') return fail('integrity_missing');
  if (i.integrity === 'invalid') return fail('integrity_invalid');
  if (i.files.mismatch > 0 || i.files.missing > 0) return fail('file_mismatch');
  if (i.anchor === undefined) return fail('anchor_missing');
  if (anchorMatch !== true) return fail('anchor_mismatch');
  return result(
    'D02',
    i.files.extra > 0 ? 'warn' : 'ok',
    i.files.extra > 0 ? 'extra_files' : 'ok',
    {
      counts,
      facts,
    },
  );
}

// ---------------------------------------------------------------------------
// D03 payload
// ---------------------------------------------------------------------------

export interface D03Input {
  state: 'absent' | 'invalid' | 'ok';
  /** SyncPayloadError.detail(固定枚举串) */
  reason: string | undefined;
  kitVersion: string | undefined;
  files: number;
  /** manifest 声明的 sha 与文件实际 sha 不一致的个数 */
  mismatch: number;
}

/** result:no_payload(n_a)| ok | payload_invalid */
export function checkD03(i: D03Input): CheckResult {
  if (i.state === 'absent') return result('D03', 'n_a', 'no_payload');
  if (i.state === 'invalid') {
    return result('D03', 'fail', 'payload_invalid', { facts: { reason: en(i.reason) } });
  }
  const facts = { kit_version: ver(i.kitVersion) };
  const counts = { files: i.files, mismatch: i.mismatch };
  return i.mismatch > 0
    ? result('D03', 'fail', 'payload_invalid', {
        counts,
        facts: { ...facts, reason: 'sha_mismatch' },
      })
    : result('D03', 'ok', 'ok', { counts, facts });
}

// ---------------------------------------------------------------------------
// D04 登记表
// ---------------------------------------------------------------------------

export interface D04Input {
  ledger: 'absent' | 'invalid' | 'ok';
  entries: number;
  kitVersion: string | undefined;
  residualTxns: readonly string[];
}

/** result:not_installed(warn)| ok | ledger_invalid | txn_residual */
export function checkD04(i: D04Input): CheckResult {
  const counts = { entries: i.entries, residual_txn: i.residualTxns.length };
  const facts = { ledger_kit_version: ver(i.kitVersion) };
  if (i.ledger === 'invalid') return result('D04', 'fail', 'ledger_invalid', { counts, facts });
  if (i.residualTxns.length > 0) {
    return result('D04', 'fail', 'txn_residual', { counts, facts, items: i.residualTxns });
  }
  if (i.ledger === 'absent') return result('D04', 'warn', 'not_installed', { counts, facts });
  return result('D04', 'ok', 'ok', { counts, facts });
}

// ---------------------------------------------------------------------------
// D05 登记条目
// ---------------------------------------------------------------------------

export interface D05Entry {
  entry: SyncLedgerEntry;
  disk: DiskEntry;
}

export type D05State =
  'ok' | 'drifted' | 'missing' | 'path_symlinked' | 'hardlinked' | 'not_regular' | 'block_corrupt';

/** 单条登记条目的分类:与 S3 计划器同源(preflightEntry / currentOf)。 */
export function classifyEntry(e: SyncLedgerEntry, disk: DiskEntry): D05State {
  const hit = preflightEntry(disk, e.block_id);
  if (hit !== null) {
    if (hit.code === CODE.PATH_SYMLINK) return 'path_symlinked';
    if (hit.code === CODE.PATH_HARDLINK) return 'hardlinked';
    if (hit.code === CODE.BLOCK_CORRUPT) return 'block_corrupt';
    return 'not_regular';
  }
  const cur = currentOf(disk, e.block_id);
  if (!cur.present) return 'missing';
  return cur.markerDrifted || cur.sha !== e.sha256 ? 'drifted' : 'ok';
}

const D05_KEYS: readonly D05State[] = [
  'ok',
  'drifted',
  'missing',
  'path_symlinked',
  'hardlinked',
  'not_regular',
  'block_corrupt',
];

/** result:no_ledger(n_a)| ok | issues。drifted / 链接 / 非常规 / 块损坏 → fail;只有 missing → warn。 */
export function checkD05(entries: readonly D05Entry[] | null): CheckResult {
  if (entries === null) return result('D05', 'n_a', 'no_ledger');
  const counts: Record<string, number> = Object.fromEntries(D05_KEYS.map((k) => [k, 0]));
  const items: string[] = [];
  for (const { entry, disk } of entries) {
    const s = classifyEntry(entry, disk);
    counts[s] = (counts[s] ?? 0) + 1;
    if (s !== 'ok') items.push(`${s}:${showPath(entry.path, entry.block_id, managed)}`);
  }
  const bad = D05_KEYS.filter((k) => k !== 'ok' && k !== 'missing').some(
    (k) => (counts[k] ?? 0) > 0,
  );
  if (bad) return result('D05', 'fail', 'issues', { counts, items });
  if ((counts['missing'] ?? 0) > 0) return result('D05', 'warn', 'issues', { counts, items });
  return result('D05', 'ok', 'ok', { counts, items });
}

// ---------------------------------------------------------------------------
// D06 托管块
// ---------------------------------------------------------------------------

export interface D06Target {
  path: string;
  blockId: string;
  disk: DiskEntry;
  /** 登记表里有这个块(没有 = payload 将要装的目标:只有 corrupt 才算问题) */
  inLedger: boolean;
}

/** result:no_blocks(n_a)| ok | issues。drifted / corrupt → fail;missing → warn。 */
export function checkD06(targets: readonly D06Target[]): CheckResult {
  const counts = { intact: 0, drifted: 0, corrupt: 0, missing: 0 };
  const items: string[] = [];
  let seen = 0;
  for (const t of targets) {
    const d = t.disk;
    if (d.kind !== 'file' && !(d.kind === 'missing' && d.linkedSegment !== true)) continue;
    const st =
      d.kind === 'file' ? (d.blocks?.[t.blockId]?.state ?? 'block-missing') : 'block-missing';
    if (!t.inLedger && st !== 'corrupt') continue;
    seen += 1;
    const key = st === 'block-missing' ? 'missing' : st;
    counts[key] += 1;
    if (key !== 'intact') items.push(`${key}:${showPath(t.path, t.blockId, managed)}`);
  }
  if (seen === 0) return result('D06', 'n_a', 'no_blocks', { counts });
  if (counts.drifted > 0 || counts.corrupt > 0) {
    return result('D06', 'fail', 'issues', { counts, items });
  }
  if (counts.missing > 0) return result('D06', 'warn', 'issues', { counts, items });
  return result('D06', 'ok', 'ok', { counts, items });
}

// ---------------------------------------------------------------------------
// D07 / D08 来自 S3 计划
// ---------------------------------------------------------------------------

export interface PlanInfo {
  /** null = 没有可用 payload(无 / 损坏) */
  plan: SyncPlan | null;
}

const STABLE_CODE_RE = /^SYNC_[A-Z_]+$/;

/** result:no_payload(n_a)| in_sync | pending(warn)| blocked(fail:整次被拒) */
export function checkD07(i: PlanInfo): CheckResult {
  const plan = i.plan;
  if (plan === null || plan.status === 'not-run') return result('D07', 'n_a', 'no_payload');
  if (plan.status === 'refuse-all') {
    return result('D07', 'fail', 'blocked', {
      counts: { refusals: plan.ops.length },
      items: plan.codes.filter((c) => STABLE_CODE_RE.test(c)),
    });
  }
  let add = 0;
  let update = 0;
  let remove = 0;
  for (const o of plan.ops) {
    if (o.op === 'create' || (o.op === 'block_upsert' && (o.shaBefore ?? null) === null)) add += 1;
    else if (o.op === 'update' || o.op === 'block_upsert') update += 1;
    else if (o.op === 'remove' || o.op === 'block_remove') remove += 1;
  }
  const counts = {
    add,
    update,
    remove,
    skipped_drifted: plan.summary.skip_drifted + plan.summary.orphan_keep,
  };
  return add + update + remove > 0
    ? result('D07', 'warn', 'pending', { counts })
    : result('D07', 'ok', 'in_sync', { counts });
}

/** result:not_evaluated(n_a)| ok | foreign(fail)| unmanaged_only(warn) */
export function checkD08(i: PlanInfo): CheckResult {
  const plan = i.plan;
  if (plan === null || plan.status !== 'ok') return result('D08', 'n_a', 'not_evaluated');
  const items = plan.ops
    .filter((o) => o.op === 'refuse_foreign')
    .map((o) => `foreign:${showPath(o.path, o.blockId, managed)}`);
  const unmanaged = plan.ops.filter((o) => o.op === 'unmanaged_keep').length;
  const counts = { foreign: items.length, unmanaged_in_owned_dir: unmanaged };
  if (items.length > 0) return result('D08', 'fail', 'foreign', { counts, items });
  if (unmanaged > 0) return result('D08', 'warn', 'unmanaged_only', { counts });
  return result('D08', 'ok', 'ok', { counts });
}

// ---------------------------------------------------------------------------
// D09 遮蔽
// ---------------------------------------------------------------------------

export interface D09Input {
  /** `~/.codex/AGENTS.override.md`:非空才遮蔽 codex 的 AGENTS.md */
  codexOverride: 'absent' | 'empty' | 'nonempty';
  /** `~/.pi/agent/AGENTS.override.md` 存在 */
  piOverride: boolean;
  /** 环境变量 PI_CODING_AGENT_DIR 已设 */
  piAgentDirEnv: boolean;
  /** 计划 / 登记表里有 `.claude/rules/agent-kit/` 下的文件(其是否被 claude 加载仍是 P-Q1 assumed) */
  claudeRulesUsed: boolean;
}

/** result:shadowed(warn)| assumed(warn)| ok */
export function checkD09(i: D09Input): CheckResult {
  const counts = {
    codex_override_nonempty: i.codexOverride === 'nonempty' ? 1 : 0,
    pi_override_present: i.piOverride ? 1 : 0,
    pi_agent_dir_env_set: i.piAgentDirEnv ? 1 : 0,
  };
  const facts = { claude_user_rules_loaded: i.claudeRulesUsed ? 'assumed' : 'not_applicable' };
  const items: string[] = [];
  if (i.codexOverride === 'nonempty') items.push('shadowed:codex_agents_override');
  if (i.piOverride) items.push('shadowed:pi_agents_override');
  if (i.piAgentDirEnv) items.push('shadowed:pi_coding_agent_dir');
  if (items.length > 0) return result('D09', 'warn', 'shadowed', { counts, facts, items });
  if (i.claudeRulesUsed) return result('D09', 'warn', 'assumed', { counts, facts, items });
  return result('D09', 'ok', 'ok', { counts, facts });
}

// ---------------------------------------------------------------------------
// D10 预算
// ---------------------------------------------------------------------------

export interface D10Target {
  agent: string;
  /** 落盘后整个文件的字节数;null = 不可测(链接 / 非常规 / 文件不存在且无 payload 块) */
  bytes: number | null;
  maxBytes?: number | undefined;
  hardLimit?: number | 'unknown' | undefined;
}

export interface D10Input {
  targets: readonly D10Target[];
  thresholdPercent: number;
  /** kit_toml = 仓库的 kit.toml;builtin = 包内写死的兜底(只有 codex 硬上限) */
  limitsSource: 'kit_toml' | 'builtin';
}

/** result:nothing_measured(n_a)| ok | warn | over。只有超过数字型 hard_limit 才是 over(fail);超 max_bytes 或接近阈值是 warn。 */
export function checkD10(i: D10Input): CheckResult {
  const counts: Record<string, number> = {};
  const facts: Record<string, string | number | boolean | null> = {
    limits_source: i.limitsSource,
  };
  let measured = 0;
  let over = 0;
  let warn = 0;
  for (const t of i.targets) {
    if (t.bytes === null) {
      facts[t.agent] = 'unmeasured';
      continue;
    }
    measured += 1;
    counts[`${t.agent}_bytes`] = t.bytes;
    if (t.maxBytes !== undefined) counts[`${t.agent}_max_bytes`] = t.maxBytes;
    if (typeof t.hardLimit === 'number') counts[`${t.agent}_hard_limit`] = t.hardLimit;
    let level = 'ok';
    if (typeof t.hardLimit === 'number' && t.bytes > t.hardLimit) {
      level = 'over_hard_limit';
      over += 1;
    } else if (t.maxBytes !== undefined && t.bytes > t.maxBytes) {
      level = 'over_max_bytes';
      warn += 1;
    } else if (
      (t.maxBytes !== undefined && t.bytes * 100 >= t.maxBytes * i.thresholdPercent) ||
      (typeof t.hardLimit === 'number' && t.bytes * 100 >= t.hardLimit * i.thresholdPercent)
    ) {
      level = 'near';
      warn += 1;
    }
    facts[t.agent] = level;
  }
  if (measured === 0) return result('D10', 'n_a', 'nothing_measured', { facts });
  if (over > 0) return result('D10', 'fail', 'over', { counts, facts });
  if (warn > 0) return result('D10', 'warn', 'warn', { counts, facts });
  return result('D10', 'ok', 'ok', { counts, facts });
}

// ---------------------------------------------------------------------------
// D11 探针
// ---------------------------------------------------------------------------

export interface D11Input {
  /** payload 里带 `conditional`(待探针验证)的文件个数;没有 payload = null */
  pendingProbes: number | null;
  /** 各 adapter 的 tested_versions 个数 */
  testedVersions: Readonly<Record<string, number>>;
  /** 实际在用的 agent(默认同步集合 ∪ 登记表里出现过的) */
  inUse: readonly string[];
}

/** result:ok | untested(warn:在用的 agent 的 tested_versions 为空)| pending_probes(warn) */
export function checkD11(i: D11Input): CheckResult {
  const untested = Object.keys(i.testedVersions)
    .filter((a) => i.testedVersions[a] === 0)
    .sort();
  const untestedInUse = untested.filter((a) => i.inUse.includes(a));
  const counts: Record<string, number> = {
    pending_probes: i.pendingProbes ?? 0,
    agents_untested: untested.length,
    agents_untested_in_use: untestedInUse.length,
  };
  const facts = { payload: i.pendingProbes === null ? 'absent' : 'present' };
  const items = untested.map((a) => `untested:${a}`);
  if (untestedInUse.length > 0) return result('D11', 'warn', 'untested', { counts, facts, items });
  if ((i.pendingProbes ?? 0) > 0)
    return result('D11', 'warn', 'pending_probes', { counts, facts, items });
  return result('D11', 'ok', 'ok', { counts, facts, items });
}

// ---------------------------------------------------------------------------
// D12 更新
// ---------------------------------------------------------------------------

export interface D12Input {
  /** 未联网(--online 的占位:本块不实现联网) */
  online: boolean;
  /** absent = 没有 state.json;ok = 已解析 */
  state: UpdateState | undefined;
  config: {
    status: 'absent' | 'invalid' | 'ok';
    autoInstall: boolean;
    autoSync: string;
    pin: string | undefined;
    registry: string;
  };
  gate: Gate;
  /** 环境变量 KIT_UPDATE_PIN(已校验过格式;不合法传 'invalid') */
  envPin: string | undefined;
  autoSyncEnvOff: boolean;
  lockPresent: boolean;
  stagingCount: number;
  /** 本进程所属包的版本,用来比较 latest_seen */
  ownVersion: string | undefined;
}

const FAILED_RESULTS = new Set([
  'verify_failed',
  'downgrade_refused',
  'attestations_unreachable',
  'timeout',
  'dns',
  'connect',
  'tls',
  'too_large',
  'parse',
  'proxy',
  'not_ready',
]);

/** result:online_unavailable(n_a)| no_state(n_a)| ok | last_check_failed | staging_residue | update_available(均 warn) */
export function checkD12(i: D12Input): CheckResult {
  if (i.online) return result('D12', 'n_a', 'online_unavailable');
  const s = i.state;
  const effectivePin = i.envPin ?? i.config.pin;
  const mirror = i.config.registry !== NPMJS_REGISTRY;
  const facts: Record<string, string | number | boolean | null> = {
    auto_update: i.gate.enabled ? 'on' : i.gate.reason,
    auto_sync: i.autoSyncEnvOff ? 'off_env' : i.config.autoSync === 'off' ? 'off' : 'safe',
    config: i.config.status,
    pin:
      effectivePin === undefined
        ? null
        : i.envPin === 'invalid'
          ? 'invalid'
          : (ver(effectivePin) ??
            (/^~\d+\.\d+(\.\d+)?$/.test(effectivePin) ? effectivePin : 'invalid')),
    registry_mirror: mirror,
    lock_present: i.lockPresent,
    last_check_at: iso(s?.last_check_at),
    last_result:
      s?.last_result === undefined
        ? null
        : (en(s.last_result) ?? (/^http_[1-5]\d\d$/.test(s.last_result) ? s.last_result : null)),
    latest_seen: ver(s?.latest_seen),
    max_seen_version: ver(s?.max_seen_version),
    installed_version: ver(s?.installed?.version),
  };
  const counts = {
    staging: i.stagingCount,
    bad_versions: s?.bad_versions.length ?? 0,
  };
  if (s === undefined) return result('D12', 'n_a', 'no_state', { counts, facts });
  if (
    s.last_result !== undefined &&
    (FAILED_RESULTS.has(s.last_result) || /^http_[45]\d\d$/.test(s.last_result))
  ) {
    return result('D12', 'warn', 'last_check_failed', { counts, facts });
  }
  if (i.stagingCount > 0) return result('D12', 'warn', 'staging_residue', { counts, facts });
  const base = s.installed?.version ?? i.ownVersion;
  const a = base === undefined ? undefined : parseSemver(base);
  const b = s.latest_seen === undefined ? undefined : parseSemver(s.latest_seen);
  if (a !== undefined && b !== undefined && compareSemver(b, a) > 0) {
    return result('D12', 'warn', 'update_available', { counts, facts });
  }
  return result('D12', 'ok', 'ok', { counts, facts });
}

// ---------------------------------------------------------------------------
// D13 hook
// ---------------------------------------------------------------------------

/** 套件目前不渲染 hook,恒 n_a */
export function checkD13(): CheckResult {
  return result('D13', 'n_a', 'no_hook_rendered');
}

// ---------------------------------------------------------------------------
// D14 状态目录权限
// ---------------------------------------------------------------------------

export interface D14Input {
  /** absent | ok | unsafe(任一段是符号链接或不是目录) */
  dir: 'absent' | 'ok' | 'unsafe';
  /** 权限位 & 0o777 */
  mode: number | undefined;
  ownedByCurrentUser: boolean | undefined;
}

/** result:absent(n_a)| ok | mode_not_0700 | foreign_owner | link_or_not_dir(不安全 → 命令层 fail-closed 退出 3) */
export function checkD14(i: D14Input): CheckResult {
  if (i.dir === 'absent') return result('D14', 'n_a', 'absent');
  if (i.dir === 'unsafe') return result('D14', 'fail', 'link_or_not_dir');
  const facts = {
    mode: i.mode === undefined ? null : (i.mode & 0o777).toString(8).padStart(4, '0'),
  };
  if (i.ownedByCurrentUser !== true) return result('D14', 'fail', 'foreign_owner', { facts });
  if (i.mode !== 0o700) return result('D14', 'fail', 'mode_not_0700', { facts });
  return result('D14', 'ok', 'ok', { facts });
}

// ---------------------------------------------------------------------------
// D15 LLM 门
// ---------------------------------------------------------------------------

export interface D15Input {
  /** none = 没给 --overlay;invalid = 读不了 / 不合 schema */
  overlay: 'none' | 'invalid' | 'ok';
  egress: boolean | undefined;
  unverifiedSlots: number;
  /** 今日冷却标记(槽位 id,固定枚举)。目录不存在 = 空 */
  cooldownToday: readonly string[];
  cooldownDir: 'absent' | 'present';
}

/** result:n_a(没有覆盖层且没有冷却目录)| ok | egress_on | allow_unverified | overlay_invalid(均 warn) */
export function checkD15(i: D15Input): CheckResult {
  const counts = {
    allow_unverified_slots: i.unverifiedSlots,
    cooldown_today: i.cooldownToday.length,
  };
  const facts = { overlay: i.overlay, egress: i.overlay === 'ok' ? (i.egress ?? false) : null };
  const items = i.cooldownToday.map((s) => `cooldown:${s}`);
  if (i.overlay === 'none' && i.cooldownDir === 'absent') {
    return result('D15', 'n_a', 'no_overlay', { counts, facts });
  }
  if (i.overlay === 'invalid')
    return result('D15', 'warn', 'overlay_invalid', { counts, facts, items });
  if (i.egress === true) return result('D15', 'warn', 'egress_on', { counts, facts, items });
  if (i.unverifiedSlots > 0) {
    return result('D15', 'warn', 'allow_unverified', { counts, facts, items });
  }
  return result('D15', 'ok', 'ok', { counts, facts, items });
}

// ---------------------------------------------------------------------------
// D16 最近一次自动同步
// ---------------------------------------------------------------------------

/** result:none(n_a)| applied(ok)| declined(warn)| failed(warn) */
export function checkD16(last: LastAutoSync | undefined): CheckResult {
  if (last === undefined) return result('D16', 'n_a', 'none');
  const counts = { add: last.add, update: last.update, remove: last.remove };
  const facts = { at: iso(last.at), txn_id: last.txn_id ?? null };
  const items = last.reasons.map((r) => `reason:${r}`);
  return result('D16', last.outcome === 'applied' ? 'ok' : 'warn', last.outcome, {
    counts,
    facts,
    items,
  });
}

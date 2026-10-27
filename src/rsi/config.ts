/**
 * `[rsi]` 用户级配置的分层解析(docs/contracts.md §20.2,R20-2.1 / 2.2 / 2.3 / 2.4 / 2.6 / 2.7;R20-A2 B2)。
 *
 * 只读、永不写、不建目录:唯一入口 `<真实 HOME>/.config/agent-kit/config.toml`(`getRealHome()`,测试经 `KIT_REAL_HOME_OVERRIDE`)。
 * 错误优先级按 R20-2.6 的层序,先命中先报:
 *   L-file(逐段校验 + 读取)→ L-toml → L-base(`RsiBaseSchema`)→ L-enabled → L-repo → L-overlay → L-policy
 * 结果只有两类:
 *  - `off`:配置问题让 rsi 不启用(原因码见 R20-2.7);
 *  - `on`:`[rsi] enabled = true` 且 repo 合规。L-overlay / L-policy 失败时状态照算,只是 `block` 非空 = 「停止采集」(R20-2.8)。
 * 它**不**判断「是否拿锁」或「暂存区隐私闸怎么办」——那是 `gate.ts` 里两个互相独立的闸的事(同一个 `off` 对两者含义不同)。
 * L-session(P1)与 v3.1 的 L-auto / L-cap / L-contrib 不在 B2。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { OverlaySchema } from '../contracts/config.js';
import { KIT_VERSION } from '../contracts/meta.js';
import {
  RsiBaseSchema,
  RsiPolicySchema,
  type RsiAgentId,
  type RsiFailClosedReason,
  type RsiPolicy,
} from '../contracts/rsi.js';
import { canonicalJson } from '../io/canonical-json.js';
import { getRealHome } from '../io/paths.js';
import {
  lstat,
  readFileSafe,
  realpath,
  statDirSafe,
  type OwnerPolicy,
  type SafeUnsafeWhy,
} from '../io/read-fs.js';
import { canonical } from '../signals/exclude.js';

/** 用户配置文件的字节上限(R20-2.2) */
export const RSI_CONFIG_MAX_BYTES = 64 * 1024;
/** overlay 的读取上限(契约未写;取 1MiB,超出按 `overlay_invalid`) */
export const RSI_OVERLAY_MAX_BYTES = 1024 * 1024;
/** `mode & 0o022 == 0`(组 / 其他人不可写)等价于权限位不得超出 0o755;属主缺省当前 uid */
const ownerPolicy = (uid?: number): OwnerPolicy => ({
  maxPerm: 0o755,
  ...(uid !== undefined ? { uid } : {}),
});

const DEFAULT_AGENTS: readonly RsiAgentId[] = ['claude', 'codex', 'pi'];

export type CfgFileReason = Extract<
  RsiFailClosedReason,
  'cfg_symlink' | 'cfg_owner' | 'cfg_perm' | 'cfg_not_regular' | 'cfg_too_large' | 'cfg_unreadable'
>;
export type RsiOffReason =
  | 'absent'
  | 'no_section'
  | CfgFileReason
  | 'cfg_parse'
  | 'cfg_schema'
  | 'disabled'
  | 'repo_invalid';
/** 停止采集的两种原因(R20-2.8);状态照算 */
export type RsiBlockReason = 'overlay_invalid' | 'exclude_invalid';

export interface RsiConfigOff {
  status: 'off';
  reason: RsiOffReason;
}
export interface RsiConfigOn {
  status: 'on';
  /** 已校验:绝对路径且 `realpath(repo) === repo` */
  repo: string;
  /** overlay 的路径与内容 sha256;没给 overlay = null;给了但不合规 = 路径在、sha 为 null */
  overlayPath: string | null;
  overlaySha256: string | null;
  /** 去重、升序 */
  agents: RsiAgentId[];
  /** `[rsi]` 与 overlay 的并集,去重(原样字符串,未 canonical) */
  excludeDirs: string[];
  excludeNames: string[];
  block: RsiBlockReason | null;
  /** `rsi status` 的 `warnings`:`overlay_absent`(没给 overlay) */
  warnings: string[];
}
export type RsiConfig = RsiConfigOff | RsiConfigOn;

const FILE_REASON: Partial<Record<SafeUnsafeWhy, CfgFileReason>> = {
  link: 'cfg_symlink',
  owner: 'cfg_owner',
  perm: 'cfg_perm',
  not_regular: 'cfg_not_regular',
  hardlink: 'cfg_not_regular',
  too_large: 'cfg_too_large',
  io: 'cfg_unreadable',
};
const fileReason = (why: SafeUnsafeWhy): CfgFileReason => FILE_REASON[why] ?? 'cfg_unreadable';

/**
 * 目录段的失败原因。`statDirSafe` 以 `O_DIRECTORY | O_NOFOLLOW` 打开:符号链接在不同平台上报 `ELOOP`(`link`)或 `ENOTDIR`(`not_regular`),
 * 所以 `not_regular` 要再 `lstat` 一次区分「是符号链接」(`cfg_symlink`)与「真的不是目录」(`cfg_not_regular`)。
 */
async function dirReason(dir: string, why: SafeUnsafeWhy): Promise<CfgFileReason> {
  if (why === 'not_regular') {
    try {
      if ((await lstat(dir)).isSymbolicLink()) return 'cfg_symlink';
    } catch {
      // 无法确认:按 not_regular
    }
  }
  return fileReason(why);
}

export interface LoadRsiConfigOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** 直接指定 HOME(测试);缺省 `getRealHome(env)` */
  home?: string;
  /** 期望的属主 uid(测试用来演练 `cfg_owner` / `repo_invalid` / `overlay_invalid` 的属主分支);缺省当前进程 uid */
  uid?: number;
}

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;

function dirItemOk(d: string): boolean {
  return d.startsWith('/') && Buffer.byteLength(d, 'utf8') <= 4096 && !CONTROL_RE.test(d);
}
function nameItemOk(n: string): boolean {
  const bytes = Buffer.byteLength(n, 'utf8');
  return (
    bytes >= 1 && bytes <= 255 && !n.includes('/') && n !== '.' && n !== '..' && !CONTROL_RE.test(n)
  );
}

async function repoOk(repo: string, owner: OwnerPolicy): Promise<boolean> {
  if (!repo.startsWith('/') || repo.includes('\0')) return false;
  try {
    if ((await realpath(repo)) !== repo) return false;
    const d = await statDirSafe(repo, { owner });
    if (d.kind !== 'ok') return false;
    return (await lstat(path.join(repo, 'kit.toml'))).isFile();
  } catch {
    return false;
  }
}

/** overlay:绝对路径、链上无符号链接、普通文件、属主当前 uid、不被组 / 其他人写、过 `OverlaySchema`(R20-2.4) */
async function readOverlay(
  p: string,
  owner: OwnerPolicy,
): Promise<{ sha256: string; excludeDirs: string[] } | undefined> {
  if (!p.startsWith('/') || p.includes('\0')) return undefined;
  try {
    if ((await realpath(p)) !== p) return undefined;
    const r = await readFileSafe(p, { maxBytes: RSI_OVERLAY_MAX_BYTES, owner });
    if (r.kind !== 'ok') return undefined;
    const parsed = OverlaySchema.safeParse(parseToml(r.bytes.toString('utf8')));
    if (!parsed.success) return undefined;
    return {
      sha256: createHash('sha256').update(r.bytes).digest('hex'),
      excludeDirs: parsed.data.exclude_dirs ?? [],
    };
  } catch {
    return undefined;
  }
}

const uniq = (a: readonly string[]): string[] => [...new Set(a)];

/**
 * 逐段校验 `.config`、`.config/agent-kit`、`config.toml`(R20-2.2),再读取并分层解析。
 * 任一段不存在 = `absent`;其它失败见 {@link CfgFileReason}。
 */
export async function loadRsiConfig(opts: LoadRsiConfigOptions = {}): Promise<RsiConfig> {
  const home = opts.home ?? getRealHome(opts.env);
  const owner = ownerPolicy(opts.uid);
  const dotConfig = path.join(home, '.config');
  const kitDir = path.join(dotConfig, 'agent-kit');
  for (const dir of [dotConfig, kitDir]) {
    const d = await statDirSafe(dir, { owner });
    if (d.kind === 'missing') return { status: 'off', reason: 'absent' };
    if (d.kind === 'unsafe') return { status: 'off', reason: await dirReason(dir, d.why) };
  }
  const file = await readFileSafe(path.join(kitDir, 'config.toml'), {
    maxBytes: RSI_CONFIG_MAX_BYTES,
    owner,
  });
  if (file.kind === 'missing') return { status: 'off', reason: 'absent' };
  if (file.kind === 'unsafe') return { status: 'off', reason: fileReason(file.why) };

  // L-toml
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(file.bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { status: 'off', reason: 'cfg_parse' };
  }
  if (!Object.hasOwn(doc, 'rsi')) return { status: 'off', reason: 'no_section' };

  // L-base
  const base = RsiBaseSchema.safeParse(doc['rsi']);
  if (!base.success) return { status: 'off', reason: 'cfg_schema' };
  const cfg = base.data;

  // L-enabled
  if (cfg.enabled !== true) return { status: 'off', reason: 'disabled' };

  // L-repo
  if (cfg.repo === undefined || !(await repoOk(cfg.repo, owner))) {
    return { status: 'off', reason: 'repo_invalid' };
  }

  // L-overlay(给了才查)
  let block: RsiBlockReason | null = null;
  let overlaySha256: string | null = null;
  let overlayDirs: string[] = [];
  if (cfg.overlay !== undefined) {
    const ov = await readOverlay(cfg.overlay, owner);
    if (ov === undefined) block = 'overlay_invalid';
    else {
      overlaySha256 = ov.sha256;
      overlayDirs = ov.excludeDirs;
    }
  }

  // L-policy(overlay 先报)
  const dirs = cfg.exclude_dirs ?? [];
  const names = cfg.exclude_names ?? [];
  // [rsi] 与 overlay 的排除目录并集都要过 L-policy(overlay 的 `exclude_dirs` 在 OverlaySchema 里只要求非空串)
  if (block === null && !([...dirs, ...overlayDirs].every(dirItemOk) && names.every(nameItemOk))) {
    block = 'exclude_invalid';
  }

  return {
    status: 'on',
    repo: cfg.repo,
    overlayPath: cfg.overlay ?? null,
    overlaySha256,
    agents: uniq(cfg.agents ?? DEFAULT_AGENTS).sort() as RsiAgentId[],
    excludeDirs: uniq([...dirs, ...overlayDirs]),
    excludeNames: uniq(names),
    block,
    warnings: cfg.overlay === undefined ? ['overlay_absent'] : [],
  };
}

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const fold = (s: string): string => s.toLowerCase();

/** kit 主版本(`KIT_VERSION` 的第一段;R20-1.5 ⑤ 的比较对象) */
export function kitMajor(version: string = KIT_VERSION): number {
  return Number.parseInt(version.split('.')[0] ?? '0', 10);
}

/**
 * 归一化策略(R20-1.5 / R20-6.9):排除项经 `canonical()`(最长已存在前缀的 realpath)+ 折叠大小写后取哈希,不存路径原文;
 * 目录与名字用不同前缀,互不冲突。`block` 非空(排除项或 overlay 不可用)时由调用方决定要不要用——策略本身只描述配置,但不会静默丢弃任何排除项。
 */
export async function buildRsiPolicy(
  cfg: RsiConfigOn,
  major: number = kitMajor(),
): Promise<RsiPolicy> {
  const hashes = new Set<string>();
  for (const d of cfg.excludeDirs) {
    // 不合规项(相对路径,block=exclude_invalid)不 canonical、也不被丢弃:按原样折叠后参与哈希,策略不会因此悄悄少一项
    hashes.add(sha256Hex(`dir\0${fold(d.startsWith('/') ? await canonical(d) : d)}`));
  }
  for (const n of cfg.excludeNames) hashes.add(sha256Hex(`name\0${fold(n)}`));
  return RsiPolicySchema.parse({
    schema_version: 1,
    agents: [...cfg.agents].sort(),
    exclude_hashes: [...hashes].sort(),
    overlay_sha256: cfg.overlaySha256,
    kit_major: major,
  });
}

/** `policy_fp` = sha256(canonicalJson(policy))(R20-6.9) */
export function policyFingerprint(policy: RsiPolicy): string {
  return sha256Hex(canonicalJson(policy));
}

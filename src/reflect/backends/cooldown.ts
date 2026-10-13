/**
 * 限流冷却标记(R3,contracts §16):`<state>/llm-cooldown/<slot>-<YYYYMMDD>`。
 * - 日期按 `reflect.reset_tz` 换算(默认 UTC);时区非法回落 UTC 并记一条 warning;
 * - 读取时顺手删掉日期早于「今天」的标记;晚于今天的(时钟回拨/伪造)既不删也不算冷却;
 * - 只经 safe-fs 写(目录 0700、文件 0600);槽位 id 只能是固定枚举,标记文件名不含用户输入;
 * - **不读**用户的任何私人配置/钩子文件(例如 `~/.claude/hooks/.codex-limited-*`)。
 * 标记只是「今天别再试这一跳」的提示:伪造它的最坏结果是跳过该跳,不会放大权限。
 */
import * as path from 'node:path';
import { JUDGE_HOP_CHAIN } from '../../contracts/proposal.js';
import type { IoContext } from '../../io/paths.js';
import { readDir } from '../../io/read-fs.js';
import { chmod, mkdirp, remove, writeFile } from '../../io/safe-fs.js';

export const COOLDOWN_DIR_NAME = 'llm-cooldown';
const MARKER_RE = new RegExp(`^(${JUDGE_HOP_CHAIN.join('|')})-(\\d{8})$`);

export interface CooldownDeps {
  readonly ctx: IoContext;
  /** 已经过 `normalizeResetTz` 的 IANA 时区 */
  readonly resetTz: string;
}

export function cooldownDir(ctx: IoContext): string {
  return path.join(ctx.stateDir, COOLDOWN_DIR_NAME);
}

function isKnownSlot(slot: string): boolean {
  return (JUDGE_HOP_CHAIN as readonly string[]).includes(slot);
}

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 时区非法(或空)→ 回落 UTC,并通过 `warn` 记一条;合法则原样返回。 */
export function normalizeResetTz(tz: string | undefined, warn?: (message: string) => void): string {
  if (tz === undefined) return 'UTC';
  if (tz.length > 0 && tz.length <= 64 && validTz(tz)) return tz;
  warn?.(`reflect.reset_tz 不是有效的 IANA 时区,回落 UTC`);
  return 'UTC';
}

/** `YYYYMMDD`,按给定时区的日历日。 */
export function dayKey(now: Date, tz: string): string {
  const zone = validTz(tz) ? tz : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US-u-nu-latn', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const key = `${get('year').padStart(4, '0')}${get('month')}${get('day')}`;
  if (!/^\d{8}$/.test(key)) throw new Error('dayKey: 无法得到 8 位日期');
  return key;
}

async function realDirExists(ctx: IoContext): Promise<boolean> {
  const top = await readDir(ctx.stateDir);
  const e = top.find((x) => x.name === COOLDOWN_DIR_NAME);
  return e !== undefined && e.isDirectory && !e.isSymbolicLink;
}

/** 当前是否处于冷却。顺手删除日期早于今天的标记(只删常规文件;符号链接/目录不动)。 */
export async function isCoolingDown(deps: CooldownDeps, slot: string, now: Date): Promise<boolean> {
  if (!isKnownSlot(slot)) return false;
  const today = dayKey(now, deps.resetTz);
  const dir = cooldownDir(deps.ctx);
  let entries;
  try {
    // 目录本身必须是真实目录(不是符号链接):readDir 会跟着链接走,可能读/删到写入根内的别处
    if (!(await realDirExists(deps.ctx))) return false;
    entries = await readDir(dir);
  } catch {
    return false;
  }
  let cooling = false;
  for (const e of entries) {
    const m = MARKER_RE.exec(e.name);
    if (m === null || !e.isFile) continue;
    if ((m[2] as string) < today) {
      try {
        await remove(deps.ctx, path.join(dir, e.name));
      } catch {
        // 删不掉不影响判定(它本来就不等于今天)
      }
      continue;
    }
    // 日期晚于今天的标记(时钟回拨/伪造)不删也不算冷却
    if (m[2] === today && m[1] === slot) cooling = true;
  }
  return cooling;
}

/** 写今天的冷却标记。写入被拒/失败时返回 false(调用方仍应把本次结果报为 rate_limited)。 */
export async function markCooldown(deps: CooldownDeps, slot: string, now: Date): Promise<boolean> {
  if (!isKnownSlot(slot)) return false;
  const dir = cooldownDir(deps.ctx);
  try {
    // 路径已被占(文件/符号链接)→ 拒绝,不往链接里写
    const top = await readDir(deps.ctx.stateDir).catch(() => []);
    const taken = top.find((x) => x.name === COOLDOWN_DIR_NAME);
    if (taken !== undefined && (!taken.isDirectory || taken.isSymbolicLink)) return false;
    await mkdirp(deps.ctx, dir, 0o700);
    await chmod(deps.ctx, dir, 0o700);
    await writeFile(deps.ctx, path.join(dir, `${slot}-${dayKey(now, deps.resetTz)}`), '1\n', {
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 会话授权 `[rsi.session]` 的两阶段判定与授权策略指纹(docs/contracts.md §20.16-1,R20-16.1 ~ R20-16.4;R20-A4)。
 *
 * - 第一阶段 = 静态校验(`RsiSessionSchema`,strictObject):布尔 / 枚举 / 日历日期 / 未知字段;L-base 的 `RsiBaseSchema.session` 仍是「表或缺省」的占位。
 * - 第二阶段 = 动态判定(本文件):`agents ⊆ [rsi] agents`、`今天 < expires ≤ 今天 + 90 天`(「今天」由调用方取一次 UTC 日并全程沿用)、声明的 `--agent` 在 `agents` 里。
 * - 现读现判,**不缓存**:每次 digest / ingest 调用都从 {@link RsiConfigOn} 重新判。L-session 失败只让会话授权不可用,不影响 L0 / worker / 其它命令(它们不调用本文件)。
 * 本文件只读、不碰文件系统,可被只读入口 import。
 */
import { createHash } from 'node:crypto';
import {
  RSI_SESSION_MAX_DAYS,
  RsiSessionSchema,
  type RsiAgentId,
  type RsiSession,
  type RsiSessionReason,
} from '../contracts/rsi.js';
import { canonicalJson } from '../io/canonical-json.js';
import { buildRsiPolicy, type RsiConfigOn } from './config.js';

export type SessionJudgement =
  { kind: 'ok'; session: RsiSession } | { kind: 'denied'; reason: RsiSessionReason };

/** 取 UTC 今天(`YYYY-MM-DD`);一次调用只取一次(R20-16.3) */
export function utcToday(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` 加 n 天(UTC;入参已是合法日期) */
function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * R20-16.3:按顺序取第一个命中——①表缺失或 `enabled` 恰为 `false` → `off`;②过不了 `RsiSessionSchema` → `invalid`;③`agents ⊄ [rsi] agents` → `invalid`;
 * ④不满足「今天 < expires ≤ 今天 + 90 天」→ `expired`;⑤`--agent` 不在 `agents` → `agent_not_authorized`;⑥`ok`。
 */
export function judgeSession(
  config: RsiConfigOn,
  agent: RsiAgentId,
  today: string,
): SessionJudgement {
  const raw = config.session;
  if (raw === undefined || raw === null) return { kind: 'denied', reason: 'off' };
  if (raw['enabled'] === false) return { kind: 'denied', reason: 'off' };
  const parsed = RsiSessionSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'denied', reason: 'invalid' };
  const s = parsed.data;
  if (!s.agents.every((a) => config.agents.includes(a)))
    return { kind: 'denied', reason: 'invalid' };
  if (!(today < s.expires && s.expires <= addDays(today, RSI_SESSION_MAX_DAYS))) {
    return { kind: 'denied', reason: 'expired' };
  }
  if (!s.agents.includes(agent)) return { kind: 'denied', reason: 'agent_not_authorized' };
  return { kind: 'ok', session: s };
}

/**
 * R20-16.4 `session_policy_fp` = sha256(canonical JSON:`[rsi.session]` 规范化后的值、`[rsi] agents`、排除项集合的哈希、overlay 有无与内容 sha256、
 * `[rsi] repo` 的 `(dev, ino)`)。会话授权不是 `ok` 时没有「规范化后的值」:此时规范化值取 `null`(调用方本来也不会走到发 digest)。
 * 排除项哈希 / overlay sha256 / agents 复用 `buildRsiPolicy`(同一份归一化,不另写一套)。
 */
export async function sessionPolicyFp(
  config: RsiConfigOn,
  session: RsiSession | null,
  repoDevIno: { dev: number; ino: number },
): Promise<string> {
  const policy = await buildRsiPolicy(config);
  const doc = {
    session:
      session === null
        ? null
        : {
            enabled: session.enabled,
            agents: [...session.agents].sort(),
            expires: session.expires,
            auto: session.auto,
          },
    rsi_agents: policy.agents,
    exclude_hashes: policy.exclude_hashes,
    overlay: policy.overlay_sha256,
    repo: repoDevIno,
  };
  return createHash('sha256').update(canonicalJson(doc)).digest('hex');
}

/** `[rsi.session]` 过 `RsiSessionSchema` 时的规范化值,否则 `null`(用于策略指纹:非法 / 缺失的表不带值) */
export function normalizedSession(config: RsiConfigOn): RsiSession | null {
  const raw = config.session;
  if (raw === undefined || raw === null) return null;
  const p = RsiSessionSchema.safeParse(raw);
  return p.success ? p.data : null;
}

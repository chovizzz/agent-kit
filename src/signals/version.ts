/**
 * agent_version 兜底(docs/reader-counting-spec.md §3)。
 * 一次运行内每个 agent 只取一次 CLI 版本;取到 → collector_fallback;连 CLI 版本都没有 →
 * 字面量 "unknown" + source=unknown(D2 落地,P1)。
 * P0 不起子进程(src/io/exec.ts 白名单只有 git),版本由 `--cli-version` 显式传入;
 * 自动执行 `<cli> --version` 需要扩白名单,列为待主代理接线。
 */

const VERSION_RE = /[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?/;

export const UNKNOWN_VERSION = 'unknown';

/** 取 `--version` 输出里第一个 X.Y.Z[-pre] 片段;`2.1.294 (Claude Code)` → `2.1.294`。 */
export function parseCliVersion(output: string): string | undefined {
  const m = VERSION_RE.exec(output);
  return m?.[0];
}

export interface ResolvedVersion {
  version: string;
  source: 'session_meta' | 'collector_fallback' | 'unknown';
}

export function resolveAgentVersion(
  fromSession: string | null,
  fallback: string | undefined,
): ResolvedVersion {
  if (fromSession !== null && fromSession !== '') {
    return { version: fromSession, source: 'session_meta' };
  }
  if (fallback === undefined || fallback === '') {
    return { version: UNKNOWN_VERSION, source: 'unknown' };
  }
  return { version: fallback, source: 'collector_fallback' };
}

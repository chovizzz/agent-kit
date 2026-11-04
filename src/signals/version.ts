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

/** 逐段数值比较的 X.Y.Z 元组;形状不对返回 null(不接受预发布后缀以外的东西)。 */
function parseTriple(v: string | undefined): [number, number, number] | null {
  // 严格 X.Y.Z:带预发布 / 构建 / 非数字后缀的一律当取不到(调用方按旧版处理,保守)
  const m = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(v ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * codex 会话版本是否「不能证明 tool_failures 可见」:版本未知或 < 0.149.0 → true。
 * 逐段数值比较:JS 的数组 `<` 会把数组转成字符串按字典序比(0.80.0 会被当成 >= 0.149.0),不能用。
 */
export function isCodexPre0149(version: string | undefined): boolean {
  const t = parseTriple(version);
  if (t === null) return true;
  const min = [0, 149, 0] as const;
  for (let i = 0; i < 3; i++) {
    const a = t[i] as number;
    const b = min[i] as number;
    if (a !== b) return a < b;
  }
  return false;
}

/**
 * 确定性分类(非 LLM)。只看结构字段与用户消息摘录,不看 Signal.type(P0 恒为 event)。
 *
 *  - explicit_lesson:用户消息里含明确的「以后/记住/不要再…」祈使句式,且不是疑问句。
 *  - tool_fail_retry:同一会话内,某工具的失败结果之后不久(≤ RETRY_WINDOW_EVENTS 个事件)又调用了同名工具。
 *  - user_correction:**保持关闭**(没有标注集前误判率未知,设计 §6.1)。
 *
 * 召回/误判取舍:句式表偏窄(宁可漏,不可把闲聊当教训);漏掉的由「显式教训」的下一次出现补上。
 * 误判的主要来源:引用他人话术、代码注释里的 `always`/`never`、带祈使词的任务描述——所以英文裸 always/never 不算,
 * 只认带动作搭配的短语;提问句(以问号结尾)一律排除。
 */
import type { LoadedSignal } from './types.js';

/** 用户纠正类分类依赖 ≥200 条标注集(设计 §6.1),建好之前保持关闭;测试钉死它是 false。 */
export const USER_CORRECTION_ENABLED = false as boolean;

/** 失败结果之后多少个事件内出现同名工具调用算「重试」。事件序号含不产生信号的事件,所以取宽一点。 */
export const RETRY_WINDOW_EVENTS = 8;

export interface LessonPattern {
  id: string;
  /** strong:单条命中即可入选;weak:只有在 ≥2 个会话里成簇才入选(见 cluster.ts) */
  tier: 'strong' | 'weak';
  re: RegExp;
}

export const LESSON_PATTERNS: readonly LessonPattern[] = [
  {
    id: 'zh-from-now-on',
    tier: 'strong',
    re: /(以后|今后|往后|下次).{0,12}(都|就|要|请|别|不要|不许|必须|记得|每次|先|务必)/u,
  },
  { id: 'zh-never-again', tier: 'strong', re: /(不要再|别再|永远(不要|别)|禁止再)/u },
  { id: 'en-from-now-on', tier: 'strong', re: /\b(from now on|going forward|next time)\b/iu },
  { id: 'en-stop', tier: 'strong', re: /\bstop (doing|using|running|adding|committing)\b/iu },
  { id: 'zh-remember', tier: 'weak', re: /(记住|记得要|务必|切记|千万(别|不要)|一定要)/u },
  { id: 'zh-every-time', tier: 'weak', re: /每次(都)?(要|需要|请|必须|先)/u },
  {
    id: 'en-remember',
    tier: 'weak',
    re: /\b(remember (to|that)|make sure (to|you)|be sure to)\b/iu,
  },
  {
    id: 'en-never-again',
    tier: 'weak',
    re: /\b(do not|don'?t|never)\s+(ever\s+)?(again|do|use|run|commit|push|edit|delete|forget|skip|change)\b/iu,
  },
];

/** 否定前缀:「不用记住」「no need to remember」不是教训。 */
const NEGATED_RE = /(不用|不必|无需|没必要|不需要)(记住|务必|切记|一定要)|\bno need to\b/iu;

const QUESTION_END_RE = /[?？]\s*$|(吗|呢)\s*$/u;

/** 返回命中的最强档;未命中 undefined。 */
export function lessonTier(excerpt: string): 'strong' | 'weak' | undefined {
  const text = excerpt.normalize('NFKC').trim();
  if (text === '' || QUESTION_END_RE.test(text) || NEGATED_RE.test(text)) return undefined;
  const hits = LESSON_PATTERNS.filter((p) => p.re.test(text));
  if (hits.length === 0) return undefined;
  return hits.some((p) => p.tier === 'strong') ? 'strong' : 'weak';
}

export function isExplicitLesson(excerpt: string): boolean {
  return lessonTier(excerpt) !== undefined;
}

export interface ToolRetryPair {
  failure: LoadedSignal;
  retry: LoadedSignal;
}

export interface Classification {
  /** 命中 explicit_lesson 的用户消息 */
  lessons: LoadedSignal[];
  /** 其中只命中弱标记的 sig_id(需跨会话成簇才入选) */
  weakLessonIds: Set<string>;
  /** 失败后重试的 (失败结果, 重试调用) 对 */
  retryPairs: ToolRetryPair[];
}

export function classifySignals(
  signals: readonly LoadedSignal[],
  opts: { retryWindow?: number } = {},
): Classification {
  const window = opts.retryWindow ?? RETRY_WINDOW_EVENTS;
  const lessons: LoadedSignal[] = [];
  const weakLessonIds = new Set<string>();
  const bySession = new Map<string, LoadedSignal[]>();
  for (const s of signals) {
    if (s.event_kind === 'user_message' && !s.external_content) {
      const tier = lessonTier(s.excerpt_redacted);
      if (tier !== undefined) {
        lessons.push(s);
        if (tier === 'weak') weakLessonIds.add(s.sig_id);
      }
    }
    const list = bySession.get(s.session_ref) ?? [];
    list.push(s);
    bySession.set(s.session_ref, list);
  }
  const retryPairs: ToolRetryPair[] = [];
  for (const list of bySession.values()) {
    const ordered = [...list].sort((a, b) => a.event_index - b.event_index);
    for (const f of ordered) {
      if (f.event_kind !== 'tool_result_failed' || f.tool_name === undefined) continue;
      // 窗口在下一条用户消息处截断:用户插话之后的同名调用不算「失败后的重试」
      const cut = ordered.find(
        (c) => c.event_kind === 'user_message' && c.event_index > f.event_index,
      );
      const limit = Math.min(f.event_index + window, cut?.event_index ?? Infinity);
      const retry = ordered.find(
        (c) =>
          c.event_kind === 'tool_call' &&
          c.tool_name === f.tool_name &&
          c.event_index > f.event_index &&
          c.event_index <= limit,
      );
      if (retry !== undefined) retryPairs.push({ failure: f, retry });
    }
  }
  return { lessons, weakLessonIds, retryPairs };
}

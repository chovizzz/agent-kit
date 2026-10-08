/**
 * core(`rules/` `agents/`)内不得出现具体模型名,只能写档位(judge / implement / readonly);
 * 档位到模型名的映射只在覆盖层。这里是「已知模型名」清单,不是穷举——漏网由评审兜。
 * 裸词(opus/sonnet/haiku/fable)也算:它们在 core 文本里几乎只会是模型档位名。
 */
const PATTERNS: readonly RegExp[] = [
  /\bclaude-(?:opus|sonnet|haiku|fable)[\w.-]*/gi,
  /\bgpt-?\d[\w.-]*/gi,
  /\bgpt-oss[\w.-]*/gi,
  /\bgemini-?\d[\w.-]*/gi,
  /\bdeepseek-?(?:v\d|r\d|chat|coder|reasoner|flash|pro)[\w.-]*/gi,
  /\bkimi-[\w.-]+/gi,
  /\bglm-\d[\w.-]*/gi,
  /\bqwen[\w.-]*/gi,
  /\bmistral-[\w.-]+/gi,
  /\bllama-?\d[\w.-]*/gi,
  /\bgrok-?\d[\w.-]*/gi,
  /\bo[134]-(?:mini|pro|preview)\b/gi,
  /\b(?:opus|sonnet|haiku|fable)\b/gi,
];

/** 返回命中的模型名(去重、按出现顺序,小写)。 */
export function findModelNames(text: string): string[] {
  const hits: { at: number; end: number; name: string }[] = [];
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) {
      hits.push({ at: m.index, end: m.index + m[0].length, name: m[0].toLowerCase() });
    }
  }
  // 起点升序、同起点长者在前;被前一个命中完全覆盖的(如 claude-sonnet-5 里的裸词 sonnet)丢弃
  hits.sort((a, b) => a.at - b.at || b.end - a.end);
  const kept: string[] = [];
  let coveredUntil = -1;
  for (const h of hits) {
    if (h.at < coveredUntil) continue;
    kept.push(h.name);
    coveredUntil = h.end;
  }
  return [...new Set(kept)];
}

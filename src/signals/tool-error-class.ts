/**
 * 工具失败文本 → 错误类枚举(R21-18 第 20 条,V1;`docs/reader-counting-spec.md` §12.1)。
 *
 * 固定映射表:**有序,首个命中即用**(顺序就是优先级,重叠文本归到靠前的类)。只产出枚举,不保留、不回显任何文本。
 * 契约只给了枚举名,表里的正则是 W4 的实现决定(见汇报「问题」);表只增不改——要改口径就新增版本。
 *
 * - 没有失败文本(`undefined` / 空白串 / 超长行已丢 text)→ 返回 `undefined`,调用方**不写**字段;`other` 只表示「有文本但没命中」。
 * - 只扫文本前 {@link TOOL_ERROR_SCAN_CHARS} 个码元(与管线的文本窗口同口径)。
 */
import type { ToolErrorClass } from '../contracts/signal.js';

export const TOOL_ERROR_SCAN_CHARS = 4096;

/** 有序映射表。`other` 不在表里,是未命中的兜底。 */
export const TOOL_ERROR_CLASS_TABLE: readonly (readonly [
  Exclude<ToolErrorClass, 'other'>,
  RegExp,
])[] = [
  [
    'permission',
    /permission denied|\bEACCES\b|\bEPERM\b|operation not permitted|access (?:is )?denied|\bforbidden\b|\bunauthori[sz]ed\b|\bHTTP 40[13]\b/i,
  ],
  ['timeout', /timed? ?out|\btimeout\b|\bETIMEDOUT\b|deadline exceeded/i],
  [
    'network',
    /\bECONN(?:REFUSED|RESET|ABORTED)\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bEHOSTUNREACH\b|\bENETUNREACH\b|network is unreachable|connection (?:refused|reset|closed|failed)|could not resolve host|\bgetaddrinfo\b|socket hang up/i,
  ],
  [
    'not_found',
    /\bENOENT\b|no such (?:file|directory|command)|command not found|\bnot found\b|does not exist|cannot find|\bHTTP 404\b/i,
  ],
  [
    'conflict',
    /\bconflict\b|already exists|\bEEXIST\b|\bEBUSY\b|resource busy|has been modified since|index\.lock|\bHTTP 409\b/i,
  ],
  [
    'syntax',
    /syntax ?error|parse error|unexpected token|unexpected end of|unterminated|invalid (?:json|syntax)|malformed/i,
  ],
];

export function classifyToolError(text: string | undefined): ToolErrorClass | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const window = text.length > TOOL_ERROR_SCAN_CHARS ? text.slice(0, TOOL_ERROR_SCAN_CHARS) : text;
  for (const [cls, re] of TOOL_ERROR_CLASS_TABLE) if (re.test(window)) return cls;
  return 'other';
}

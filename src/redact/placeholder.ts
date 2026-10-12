/**
 * 占位符标记的预处理与识别(P1-A.3)。
 *
 * 背景:原文里形如 `[[REDACTED:xxx]]` 的串,会被两遍扫描当成合法占位符先剥掉再扫,等于给伪造者开了后门。
 * 所以进脱敏前先把原文里的标记拆开(`[[REDACTED:` -> `[[ REDACTED:`),让它当普通文本被扫描——合法占位符只由第一遍产生。
 * `signals collect` 与 `redact --stdin` 必须走**同一个**函数(`neutralizePlaceholderMarkers`),否则同一段输入在两条路径上
 * 的判定会不一样。
 *
 * 拆开后的形态(中性化标记)在引擎里按「与合法占位符同样的方式」处理(视图里剥掉、紧邻判定一致),
 * 但只认 **类型位属于封闭集合** 且 **原文逐字节如此** 的写法,所以既不会因为多了一个空格而让紧贴的真值漏出,
 * 也不会给「类型位夹带数据」开新通道。
 */

export const PLACEHOLDER_OPEN = '[[REDACTED:';
export const PLACEHOLDER_NEUTRALIZED = '[[ REDACTED:';

/** 拆开原文里的占位符标记。幂等:结果里不再含 `[[REDACTED:`。 */
export function neutralizePlaceholderMarkers(text: string): string {
  return text.replaceAll(PLACEHOLDER_OPEN, PLACEHOLDER_NEUTRALIZED);
}

/**
 * 规则实际产出的占位符类型(封闭集合)。与 `buildRules` 里各规则的 type 一致,由测试对账
 * (`test/redact/p1a3.test.ts`),新增规则类型时测试会红。
 */
export const KNOWN_PLACEHOLDER_TYPES = [
  'api_key',
  'credential',
  'domain',
  'email',
  'feishu_id',
  'high_entropy',
  'ip',
  'jwt',
  'private_key',
  'sensitive',
  'token',
  'url',
  'webhook',
] as const;

/** 中性化标记的正则源:空格恰好一个,类型位只允许封闭集合。 */
export const NEUTRAL_MARKER_SOURCE = String.raw`\[\[ REDACTED:(?:${KNOWN_PLACEHOLDER_TYPES.join('|')})\]\]`;

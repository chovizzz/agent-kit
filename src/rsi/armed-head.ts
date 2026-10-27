/**
 * armed 头部读取的唯一入口(R20-1.4,R20-A2 B3a):对一个会话文件做**一次**偏移 0、≤ 64KiB 的物理读取,
 * 只把首行(第一个 `\n` 之前的字节)交给调用方给的解析器;首行之后的字节读进缓冲后即被丢弃,从不出现在任何返回值或回调参数里。
 * 不调用 reader 的 `read()`、不调用 `Redactor`、不读盐。解析器是调用方的(例如各 agent 的轻量 cwd 头部解析器,B4 提供)。
 */
import { readHead, type ReadHeadHooks, type SafeUnsafeWhy } from '../io/read-fs.js';

/** 契约常量 `RSI_ARMED_HEAD_BYTES`(R20-1.4);待主代理并入 `src/contracts/rsi.ts`(本块不改已冻结的契约文件) */
export const RSI_ARMED_HEAD_BYTES = 64 * 1024;

export type ArmedHeadResult<T> =
  | { kind: 'parsed'; value: T }
  /** 窗口里没有 `\n`:首行取不到,按归属不明处理 */
  | { kind: 'no_line' }
  | { kind: 'missing' }
  | { kind: 'unsafe'; why: SafeUnsafeWhy };

export async function readArmedHead<T>(
  file: string,
  parseFirstLine: (firstLine: Buffer) => T,
  hooks: ReadHeadHooks = {},
): Promise<ArmedHeadResult<T>> {
  const r = await readHead(file, RSI_ARMED_HEAD_BYTES, hooks);
  if (r.kind !== 'ok') return r;
  if (r.firstLine === null) return { kind: 'no_line' };
  return { kind: 'parsed', value: parseFirstLine(r.firstLine) };
}

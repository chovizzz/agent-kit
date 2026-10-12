/**
 * 会话文件的唯一打开入口(plan M-5)。B11–B14 的 reader 必须经此读取,不得自行打开文件
 * (eslint 也禁止它们 import node:fs)。
 *
 * 只读保证分三层:
 *  1. 本文件只依赖 src/io/read-fs.ts 的读 API,不 import 任何写 API;
 *  2. 观察者垫片:测试可挂 `setOpenObserver` 记录每次打开(路径 + 声明的 flags);
 *  3. 测试另用 vi.mock('node:fs') 在 fs 层记录真实 flags(test/signals/readonly.test.ts)。
 */
import { readLines, readText, stat } from '../io/read-fs.js';
import type { Stats } from '../io/read-fs.js';

export interface OpenEvent {
  path: string;
  /** 本入口只会声明只读 */
  flags: 'O_RDONLY';
  purpose: 'lines' | 'stat' | 'text';
}

type Observer = (e: OpenEvent) => void;
let observer: Observer | undefined;

/** 测试用:挂/摘观察者。返回之前的观察者。 */
export function setOpenObserver(fn: Observer | undefined): Observer | undefined {
  const prev = observer;
  observer = fn;
  return prev;
}

/**
 * 逐行流式读取(去 `\n` / `\r\n`,保留空行)。大文件不会被整体读入内存。
 * 行分隔符只认 `\n`(口径 C2):底层是 read-fs.readLines 的按字节读取,**不用 node:readline**,
 * 所以行内裸 `\r`、U+2028/U+2029 都不会把一行切开;单行超过 MAX_LINE_BYTES(64MiB)时产出 TOO_LONG_LINE 占位。
 */
export function openReadonlyLines(path: string): AsyncGenerator<string, void, undefined> {
  observer?.({ path, flags: 'O_RDONLY', purpose: 'lines' });
  return readLines(path);
}

export async function statReadonly(path: string): Promise<Stats> {
  observer?.({ path, flags: 'O_RDONLY', purpose: 'stat' });
  return stat(path);
}

/** 伴随小文件(如 Kimi 同级的 state.json)的只读文本读取;超过 maxBytes 或不存在返回 undefined。 */
export async function readCompanionText(
  path: string,
  maxBytes = 1024 * 1024,
): Promise<string | undefined> {
  observer?.({ path, flags: 'O_RDONLY', purpose: 'text' });
  try {
    if ((await stat(path)).size > maxBytes) return undefined;
    return await readText(path);
  } catch {
    return undefined;
  }
}

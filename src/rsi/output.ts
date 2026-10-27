/**
 * 只读命令的统一出口(R20-3.5.6 泄漏闸,R20-A2 B3a):先**完整构造**输出行,过闸,再一次性写 stdout;
 * 过不了闸 → stdout 一个字节都不写,stderr `RSI_FAIL_CLOSED reason=output_leak`,退出 3。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import { getRealHome, pickProcessEnv } from '../io/paths.js';
import { realpath } from '../io/read-fs.js';
import { guardOutput, renderLine, type OutLine } from './sanitize.js';

export interface OutputSink {
  stdout(text: string): void;
  stderr(text: string): void;
}

/**
 * 禁止出现在 stdout 的绝对路径:HOME、`KIT_TMP`、状态目录、仓库根(R20-3.5.6),以及它们的 realpath(取不到 realpath 时仍检查原值)。
 * 空串与长度 ≤ 1 的值由闸忽略。
 */
export async function forbiddenPaths(
  env: Readonly<Record<string, string | undefined>> | undefined,
  extra: readonly (string | undefined)[],
): Promise<string[]> {
  // 没注入 env 时和配置 / 上下文一致地取真实进程环境里的 KIT_TMP
  const tmp = (env ?? pickProcessEnv(/^KIT_TMP$/))['KIT_TMP'];
  const raw = [getRealHome(env), tmp, ...extra].filter(
    (v): v is string => typeof v === 'string' && v !== '',
  );
  const out = new Set(raw);
  for (const v of raw) {
    try {
      out.add(await realpath(v));
    } catch {
      // 取不到 realpath:原值已在集合里
    }
  }
  return [...out];
}

/** 过闸并输出。返回退出码(成功 0)。 */
export function emitLines(
  sink: OutputSink,
  lines: readonly OutLine[],
  forbidden: readonly string[],
): number {
  if (!guardOutput(lines, forbidden).ok) {
    sink.stderr('RSI_FAIL_CLOSED reason=output_leak\n');
    return ExitCode.FAIL_CLOSED;
  }
  sink.stdout(lines.map((l) => `${renderLine(l)}\n`).join(''));
  return ExitCode.OK;
}

/** 把一份 canonical JSON 文本拆成 head 行(JSON 里没有任何豁免字段) */
export function jsonLines(text: string): OutLine[] {
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((head) => ({ head }));
}

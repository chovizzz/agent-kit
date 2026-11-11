/** W4 测试共用:标记块夹具、经管线读一个会话文件、朴素参考实现。 */
import { createRedactor } from '../../src/redact/index.js';
import type { SessionRef, TraceReader } from '../../src/contracts/reader.js';
import { RSI_AUTO_LABEL, RSI_MARK_PREFIX } from '../../src/contracts/rsi.js';
import { processSession } from '../../src/signals/pipeline.js';
import type { ExcludePolicy } from '../../src/signals/exclude.js';
import type { PipelineDeps, SessionResult } from '../../src/signals/pipeline.js';

export const W4_SALT = 'a'.repeat(32);
export const MARKER_A = 'rsm_0123456789abcdef';
export const MARKER_B = 'rsm_fedcba9876543210';

/** 不含 15 / 16 字边界用例里会用到的相邻字符(甲、乙)。 */
export const BODY =
  '跨文件重名的函数必须先查全部调用方再改名,禁止直接全局替换;改完立刻跑受影响目录的测试。';

/** treat 组形状:标记行 + 标签行 + 哈希行 + 正文。 */
export function treatBlock(marker: string = MARKER_A, body: string = BODY): string {
  return [`${RSI_MARK_PREFIX} ${marker}`, RSI_AUTO_LABEL, 'h:0123456789ab', body].join('\n');
}
/** control 组形状:只有标记行。 */
export const controlBlock = (marker: string = MARKER_A): string => `${RSI_MARK_PREFIX} ${marker}`;

export const okPolicy: ExcludePolicy = {
  decide: async () => ({ action: 'process', projectRoot: '/work/proj-a' }),
};

export const depsOf = (over: Partial<PipelineDeps> = {}): PipelineDeps => ({
  redactor: createRedactor({ timeout_ms: 5000 }),
  policy: okPolicy,
  salt: W4_SALT,
  fallbackVersion: undefined,
  maxEventBytes: undefined,
  ...over,
});

export async function runFile(
  reader: TraceReader,
  file: string,
  over: Partial<PipelineDeps> = {},
): Promise<SessionResult> {
  const refs: SessionRef[] = await reader.discover(file);
  if (refs.length !== 1) throw new Error(`期望 1 个会话文件,实得 ${refs.length}`);
  return processSession(reader, refs[0] as SessionRef, depsOf(over));
}

/** 朴素 O(n·m) 最长公共子串(按码点)——对拍 `InjectionTracker.isRecital`,不共享其实现。 */
export function longestCommonRun(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let best = 0;
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = (prev[j - 1] as number) + 1;
        if ((cur[j] as number) > best) best = cur[j] as number;
      }
    }
    prev = cur;
  }
  return best;
}

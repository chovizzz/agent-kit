/**
 * `rsi auto pause`(contracts R21-12.2、§21.24 W0-21 / W0-22 第 1 条):独占创建用户暂停文件 U(`{at, by:"user"}`),**不拿锁、不要 TTY**,只碰 U、从不碰 B;
 * U 已存在 = 已暂停,**不覆盖**,输出「已暂停(已存在)」,退 0。`[rsi]` 合法关闭 / 找不到仓库 → 退 4 `RSI_NOT_RUN reason=off`。写失败由入口映射为退 3 `write_denied`。
 * 它是「全部端口未接线则零写入」的唯一例外:只依赖本段自带的用户标记端口(方向安全:只会多停注入)。**本文件不 import 任何锁模块**(闭包审计)。
 */
import { parseFlags } from '../../args.js';
import type { RsiEarlyContext } from '../../types.js';
import { notRun, precheck, say, usage } from './common.js';
import { REQUIRED_PORTS, type WritePorts, type WritePortsGetter } from './ports.js';

export async function runPause(
  ctx: RsiEarlyContext,
  rest: readonly string[],
  getPorts: WritePortsGetter,
): Promise<number> {
  if (!parseFlags(rest, []).ok) return usage(ctx, 'unknown_arg');
  const p = await getPorts();
  const bad = precheck(ctx, p, REQUIRED_PORTS['auto pause']);
  if (bad !== null) return bad;
  if (!(await (p.config as NonNullable<WritePorts['config']>)()).rsiOn) return notRun(ctx, 'off');
  const marker = await (p.userMarker as NonNullable<WritePorts['userMarker']>)();
  const r = await marker.ensureUser();
  return say(ctx, p, [
    r === 'created' ? 'auto_pause=created 已暂停' : 'auto_pause=exists 已暂停(已存在)',
  ]);
}

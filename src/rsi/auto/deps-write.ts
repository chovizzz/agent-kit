/**
 * 写命令的生产组装(W8b;SOLID 的 D:业务依赖 `write/ports.ts` 的端口,具体实现在这里注入)。**未接线的一律缺失(`undefined`)→ 预检 fail-closed 退 3、零写入**:
 *   - 本段能真实实现的:`config`(`[rsi]` 是否可用)、`userMarker`(用户暂停文件 U 的真实端口 `makeUserMarkerPort`;惰性打开——打开会建 `.state/rsi`,只有 `rsi auto pause` 真要写时才发生)、`outputForbidden`;
 *   - 其余(锁、`PauseStatePort`、`HoldFacts`、`EntryMarks`、`RollbackDeps` / `ClearDeps` 全套、黑名单落地与解除、git 分类与 `head.json` 写入)归后面的「装配」块;它们保持未接线,
 *     所以除 `rsi auto pause` 外的写命令在生产里恒在任何写入之前退 3(`pause` 只写 U 一个文件)。
 * 配置不可信(`cfg_*` / `repo_invalid`)在任何写入与输出之前 fail-closed 退 3(与 W8a 的 `deps.ts` 同一判定;`auto clear --write` 也一样,见状态文件「问题」)。
 */
import { getRealHome } from '../../io/paths.js';
import { makeUserMarkerPort } from '../canary/pause-marker.js';
import { loadRsiConfig } from '../config.js';
import { rsiDir } from '../rsi-dir.js';
import { openRsiIo } from '../services/open.js';
import { RsiFailClosedError, type RsiEarlyContext } from '../types.js';
import { LEGIT_OFF, PERSONAL_GIT_DIR_REL, forbiddenExtra, untrustedReason } from './deps.js';
import { AutoUsageError } from './read/ports.js';
import type { WritePorts } from './write/ports.js';
import * as path from 'node:path';

export async function productionWritePorts(
  ctx: RsiEarlyContext,
  opts: { now?: () => Date } = {},
): Promise<WritePorts> {
  const env = ctx.env;
  const cfg = await loadRsiConfig({ ...(env !== undefined ? { env } : {}) });
  if (cfg.status === 'off' && !LEGIT_OFF.has(cfg.reason)) {
    throw new RsiFailClosedError(untrustedReason(cfg.reason));
  }
  const open = cfg.status === 'on' ? await openRsiIo(ctx) : null;
  if (open !== null && open.kind === 'usage') throw new AutoUsageError(open.reason);
  if (cfg.status === 'on' && (open === null || open.kind !== 'ready')) {
    throw new RsiFailClosedError('internal');
  }
  const io = open !== null && open.kind === 'ready' ? open.ctx.io : null;
  const now = opts.now ?? ((): Date => new Date());
  const gitDir = path.join(getRealHome(env), ...PERSONAL_GIT_DIR_REL.split('/'));
  return {
    config: async () => ({ rsiOn: cfg.status === 'on' }),
    userMarker: async () => {
      // `[rsi]` 关闭时没有仓库 `.state`:调用方先判 `rsiOn`,这里不会被走到;走到就 fail-closed
      if (io === null) throw new RsiFailClosedError('internal');
      return makeUserMarkerPort(io, await rsiDir(io), now);
    },
    outputForbidden: forbiddenExtra(ctx, io, cfg.status === 'on' ? cfg.repo : null, gitDir),
  };
}

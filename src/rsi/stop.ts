/**
 * `agent-kit rsi stop`(契约 R20-3.7;R20-A2 B3a)。
 *
 * 独占创建 `.state/rsi/STOP`(内容 `{at, by: "user"}`,0600);位置上已有任何对象(`lstat` 不跟随链接)则不改、不读、退出 0,竞态下的 `EEXIST` 同样退 0。**不拿 `rsi/lock`**:持锁 worker 运行期间也要能写入;
 * 不恢复快照、不读会话、不需要 TTY。配置不可用时找不到仓库 → 退出 0,stdout `stop noop reason=<码>`。
 * `rsi/` 目录不存在时先经 `rsiDir()` 建好(0700)再放标记——从未运行过的仓库里 `rsi stop` 也必须有效(否则 poke 随后照跑);这是本命令唯一的额外写入。
 * 目录已存在则直接使用,**不** mkdirp、不 chmod;不合规(链接 / 属主 / 权限宽于 0700)→ `state_dir_unsafe`,不自动收紧(R20-7.2)。
 * (契约订正见汇报:「stop 除 STOP 标记外零写入」应表述为「除 STOP 标记与缺失的 `.state/`、`.state/rsi/` 目录外」。)
 * 本文件的 import 闭包含 safe-fs(要写),但**不含** lock.ts / snapshot.ts / with-lock.ts:不拿锁、不恢复快照由静态审计保证。
 * 时间只经注入(`deps.now`)。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import { RSI_FILE_MODE } from '../contracts/rsi.js';
import { canonicalJson } from '../io/canonical-json.js';
import { lstat } from '../io/read-fs.js';
import { createExclusive } from '../io/safe-fs.js';
import * as path from 'node:path';
import { parseFlags } from './args.js';
import { failExit } from './exit.js';
import { rsiDirReadonly } from './lock-read.js';
import { rsiDir } from './rsi-dir.js';
import { openRsiIo, type OpenRsiIoDeps } from './services/open.js';
import { RsiFailClosedError, type RsiEarlyContext, type RsiSubcommand } from './types.js';

export interface RsiStopDeps {
  now?: () => Date;
  open?: OpenRsiIoDeps;
}

/** 不跟随链接的存在性检查:`lstat` 成功即在场;ENOENT 才是不在;其它错误(无法确认)按在场处理(宁可当成已停止) */
async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export async function runStop(ctx: RsiEarlyContext, deps: RsiStopDeps = {}): Promise<number> {
  if (!parseFlags(ctx.argv, []).ok) {
    ctx.stderr('RSI_USAGE reason=unknown_arg\n');
    return ExitCode.USAGE;
  }
  try {
    const open = await openRsiIo(ctx, deps.open);
    if (open.kind === 'usage') {
      ctx.stderr(`${open.code} reason=${open.reason}\n`);
      return ExitCode.USAGE;
    }
    if (open.kind === 'off') {
      ctx.stdout(`stop noop reason=${open.reason}\n`);
      return ExitCode.OK;
    }
    const { io } = open.ctx;
    // 目录:已存在且合规 → 直接用(不 mkdirp、不 chmod);不合规(符号链接 / 属主 / 权限宽于 0700)→ state_dir_unsafe,不自动收紧;
    // 缺失 → 经 rsiDir() 建好(0700)。stop 唯一允许新建的是缺失的 `.state/` 与 `.state/rsi/`
    const probe = await rsiDirReadonly(io);
    if (probe.kind === 'unsafe') throw new RsiFailClosedError('state_dir_unsafe');
    const dir = probe.kind === 'ok' ? probe.dir : await rsiDir(io);
    const stopFile = path.join(dir, 'STOP');
    // STOP 位置上已有任何对象(含目录、符号链接、硬链接、悬空链接):已停止,不改、不读、不跟随,退出 0
    if (await exists(stopFile)) {
      ctx.stdout('stop ok already\n');
      return ExitCode.OK;
    }
    const at = (deps.now ?? ((): Date => new Date()))().toISOString();
    try {
      await createExclusive(io, stopFile, canonicalJson({ at, by: 'user' }), RSI_FILE_MODE);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        ctx.stdout('stop ok already\n');
        return ExitCode.OK;
      }
      throw e;
    }
    ctx.stdout('stop ok\n');
    return ExitCode.OK;
  } catch (e) {
    return failExit(ctx.stderr, e);
  }
}

export const subcommand: RsiSubcommand = {
  name: 'stop',
  owner: 'B3a',
  run: (ctx) => runStop(ctx),
};

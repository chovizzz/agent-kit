/**
 * 后台 worker(S7c-B;docs/contracts.md §19.4 / §19.5):内部入口 `agent-kit __update --background`,**不属于公开命令面**
 * (不在 COMMANDS 里、不进 --help;由 `src/cli.ts` 单独识别)。由启动器的 {@link scheduleBackground} 以 detached、stdio 丢弃的方式拉起,
 * 所以本身不输出任何东西;结果只以稳定码写进 `update/log`(一行,最近一次)与 `state.json`(经 update 命令的正常路径)。
 *
 * 流程:再次核对开关(KIT_AUTO_UPDATE / CI / config.auto_install;注意 worker 自己带着 `KIT_LAUNCHED=1`,判开关时要摘掉它)
 * → 24h 节流 → 复用 `update --write` 的完整流程(锁内重读状态与 packument、重新决策、验签、冒烟、切换);
 * 在**同一把 update 锁内**通过 `afterInstall` 调自动同步评估。节流在拿到锁后还会再查一次(`proceedInLock`),
 * 排队的两个 worker 不会重复检查。拿不到锁:静默结束,日志记 `skipped_locked`(不无锁写 state.json)。
 */
import { parse as parseToml } from 'smol-toml';
import { ExitCode } from '../contracts/exit-codes.js';
import { UserConfigSchema } from '../contracts/update.js';
import { createUpdateCommand, type UpdateCommandDeps } from '../commands/update.js';
import type { CommandContext, CommandDef } from '../commands/types.js';
import { RUN_SELF_ENV_PICK_RE } from '../io/exec.js';
import { getRealHome, pickProcessEnv } from '../io/paths.js';
import { probePath, resolveAllowedHome } from '../sync/snapshot.js';
import type { ApplyDeps, ApplyEnv } from '../sync/apply.js';
import { autoSyncEnabled, runAutoSync, type AutoSyncDeps } from './autosync.js';
import { SHARE_REL, readUpdateState, writeWorkerLog, type InstallEnv } from './install.js';
import { smokeCandidate } from './launcher.js';
import { autoUpdateGate, checkDue } from './policy.js';

export interface WorkerDeps extends UpdateCommandDeps {
  /** 传给自动同步(sync 锁 / 事务)的注入口 */
  sync?: ApplyDeps;
  autoSync?: AutoSyncDeps;
  /** 测试注入:替换冒烟实现(缺省真执行 `--version`) */
  noSmoke?: boolean;
}

/** worker 结果 → 日志稳定码 */
export type WorkerOutcome =
  'ok' | 'skipped_gate' | 'skipped_throttled' | 'skipped_locked' | 'failed' | 'usage';

export function createBackgroundCommand(deps: WorkerDeps = {}): CommandDef {
  return {
    name: '__update',
    summary: '(内部)后台自动更新 worker',
    phase: 'P2',
    ownerBlock: 'S7c',
    async run(ctx: CommandContext): Promise<number> {
      const outcome = await runWorker(ctx, deps);
      return outcome === 'usage' ? ExitCode.USAGE : ExitCode.OK;
    },
  };
}

async function runWorker(ctx: CommandContext, deps: WorkerDeps): Promise<WorkerOutcome> {
  if (ctx.argv.length !== 1 || ctx.argv[0] !== '--background') return 'usage';
  // 真实 CLI 入口 main(argv) 不注入 env:从进程环境里取收窄的具名键(KIT_UPDATE_* / KIT_AUTO_* / CI / 代理 …)
  const env = ctx.env ?? pickProcessEnv(RUN_SELF_ENV_PICK_RE);
  const homeReal = await resolveAllowedHome(getRealHome(env), ctx.io.tmpDir, env);
  if (homeReal === undefined) return 'failed';
  const ienv: InstallEnv = {
    home: homeReal,
    tmpDir: ctx.io.tmpDir,
    env,
    deps,
    ...(ctx.io.writeAudit !== undefined ? { writeAudit: ctx.io.writeAudit } : {}),
  };
  const now = (): Date => (deps.now ?? ((): Date => new Date()))();
  const finish = async (o: WorkerOutcome): Promise<WorkerOutcome> => {
    await writeWorkerLog(ienv, o);
    return o;
  };

  // 开关:worker 带 KIT_LAUNCHED=1(runSelf 强制),判开关时摘掉;TTY 由前台判过
  const gateEnv: Record<string, string | undefined> = { ...env, KIT_LAUNCHED: undefined };
  let autoInstall = true;
  const cfgProbe = await probePath(homeReal, '.config/agent-kit/config.toml');
  if (cfgProbe.entry.kind !== 'missing') {
    try {
      if (cfgProbe.text === undefined) return await finish('failed');
      autoInstall = UserConfigSchema.parse(parseToml(cfgProbe.text)).update.auto_install;
    } catch {
      return await finish('failed');
    }
  }
  if (!autoUpdateGate({ env: gateEnv, isTTY: true, autoInstall }).enabled) {
    return await finish('skipped_gate');
  }

  const st = await readUpdateState(homeReal);
  if (st.kind === 'unsafe' || st.kind === 'unreadable') return await finish('failed');
  const due = (last: string | undefined): boolean => checkDue(last, now().getTime()).due;
  if (!due(st.kind === 'ok' ? st.state.last_check_at : undefined)) {
    return await finish('skipped_throttled');
  }

  let stderrText = '';
  const cmd = createUpdateCommand({
    ...deps,
    ...(deps.noSmoke === true || deps.smoke !== undefined
      ? {}
      : { smoke: (c) => smokeCandidate(c) }),
    proceedInLock: (s) => due(s.last_check_at) && (deps.proceedInLock?.(s) ?? true),
    afterInstall: async (info) => {
      if (!autoSyncEnabled(info.autoSync, env)) return undefined;
      const aenv: ApplyEnv = {
        home: info.ienv.home,
        homeReal: info.ienv.home,
        tmpDir: info.ienv.tmpDir,
        env: info.ienv.env,
        deps: deps.sync ?? {},
        ...(info.ienv.writeAudit !== undefined ? { writeAudit: info.ienv.writeAudit } : {}),
      };
      return runAutoSync(
        aenv,
        {
          versionRoot: `${info.ienv.home}/${SHARE_REL}/versions/${info.version}`,
          version: info.version,
          anchor: info.anchor,
        },
        deps.autoSync,
      );
    },
  });
  const inner: CommandContext = {
    ...ctx,
    env,
    argv: ['--write'],
    stdout: () => undefined,
    stderr: (t: string) => {
      stderrText += t;
    },
  };
  const code = await cmd.run(inner);
  if (code === ExitCode.NOT_RUN && /reason=locked/.test(stderrText)) {
    return await finish('skipped_locked');
  }
  return await finish(code === ExitCode.OK ? 'ok' : 'failed');
}

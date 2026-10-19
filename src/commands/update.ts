/**
 * `agent-kit update [--write] [--now] [--major] [--rollback] [--json] [--home <dir>]`(S7c-A,docs/contracts.md §19.4 / §19.5)。
 *
 * - **默认干跑**:只读 registry(一次只读网络请求,夹具时读 file://),打印会装哪个版本、被哪条策略挡住;不写任何文件
 *   (不建状态目录、不记 last_check)。`--write` 才安装 / 回滚 / 记录检查结果。
 * - 策略全部来自 `src/update/policy.ts` 的 `decideUpdate`;拿到锁之后会**重读状态与 packument、重新决定一次**
 *   (防降级、pin、bad_versions、major、冷却期、该版本仍存在且未 deprecate),再交给 `src/update/install.ts`。
 * - 配置:`~/.config/agent-kit/config.toml`(只读)与环境 `KIT_UPDATE_REGISTRY` / `KIT_UPDATE_PIN`,优先级 环境 > 配置 > 默认。
 *   `KIT_UPDATE_REGISTRY=file://<KIT_TMP 内目录>` 是假 registry 夹具(其它位置 → `registry_fixture_outside_tmp`)。
 * - `--home <dir>`:同 sync / doctor,只接受真实 HOME 或 KIT_TMP 之内的目录(config / state / 安装目录都在该 HOME 下)。
 * - stdout 只含版本号、枚举、哈希前缀;stderr 只含稳定码 `UPDATE_<USAGE|CHECK_FAILED|VERIFY_FAILED|…> reason=<码>`,
 *   不回显异常消息、文件内容、绝对路径。
 * - 退出码:0 已最新 / 计划已打印 / 已安装 / 被策略挡住(cooldown、pinned、major_available、deprecated);
 *   1 校验失败(`UPDATE_VERIFY_FAILED`)、防降级(`UPDATE_DOWNGRADE_REFUSED`);2 用法错误;
 *   3 fail-closed(状态目录不安全、状态 / 配置损坏、写出口拒绝、current 损坏);
 *   4 未执行(网络不可用、not_ready、attestations / TUF / 信任根取不到、锁被占、没有可回滚的版本)。
 */
import { parse as parseToml } from 'smol-toml';
import { ExitCode } from '../contracts/exit-codes.js';
import { KIT_VERSION } from '../contracts/meta.js';
import {
  UPDATE_PIN_RE,
  UserConfigSchema,
  type UpdateConfig,
  type UpdateState,
} from '../contracts/update.js';
import { canonicalJson } from '../io/canonical-json.js';
import { NetError, type FetchLike } from '../io/net.js';
import { getRealHome } from '../io/paths.js';
import { resolveAllowedHome, probePath } from '../sync/snapshot.js';
import {
  UpdateLockError,
  acquireUpdateLock,
  installVersion,
  readUpdateState,
  rollbackInstalled,
  writeUpdateState,
  type InstallDeps,
  type InstallEnv,
  type InstallFailure,
  type UpdateLock,
} from '../update/install.js';
import {
  decideUpdate,
  parseHttpDate,
  parseIsoUtc,
  readPackument,
  type Decision,
  type NpmjsFacts,
  type PackumentView,
} from '../update/policy.js';
import { isDeprecated, openRegistrySource, type RegistrySource } from '../update/registry.js';
import { emptyState, markBad, recordCheck } from '../update/state.js';
import type { EnvCommandContext } from './reflect.js';
import type { CommandContext, CommandDef } from './types.js';

export interface UpdateCommandDeps extends InstallDeps {
  /** 测试注入:直接给 RegistrySource(跳过 KIT_UPDATE_REGISTRY / 配置的解析) */
  source?: RegistrySource;
  /** 测试注入:真实 registry 的 fetch */
  fetch?: FetchLike;
}

interface Parsed {
  write: boolean;
  now: boolean;
  major: boolean;
  rollback: boolean;
  json: boolean;
  home: string | undefined;
  error: string | undefined;
}

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = {
    write: false,
    now: false,
    major: false,
    rollback: false,
    json: false,
    home: undefined,
    error: undefined,
  };
  let unknown = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--write') out.write = true;
    else if (a === '--now') out.now = true;
    else if (a === '--major') out.major = true;
    else if (a === '--rollback') out.rollback = true;
    else if (a === '--json') out.json = true;
    else if (a === '--home' || a.startsWith('--home=')) {
      if (a === '--home') {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) unknown = true;
        else {
          out.home = v;
          i++;
        }
      } else out.home = a.slice('--home='.length);
    } else unknown = true;
  }
  if (unknown) out.error = 'unknown_arg';
  else if (out.rollback && (out.now || out.major)) out.error = 'mode_conflict';
  else if (out.major && !out.write) out.error = 'major_requires_write';
  else if (out.rollback && !out.write) out.error = 'rollback_requires_write';
  return out;
}

class Exit extends Error {
  constructor(
    readonly code: number,
    readonly tag: 'USAGE' | 'CHECK_FAILED' | 'VERIFY_FAILED' | 'NOT_RUN' | 'FAIL_CLOSED',
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** 过不了校验但不是「该版本的问题」:不进 bad_versions、退出 4 */
const NOT_VERSION_FAULT = new Set([
  'attestations_unreachable',
  'trust_root_stale',
  'tuf_unreachable',
]);

type Outcome = Decision['code'] | 'deprecated';

interface Plan {
  outcome: Outcome;
  detail?: string;
  version?: string;
  publishedAt?: string;
  ageMs?: number;
  cause?: string;
}

interface Settings {
  cfg: UpdateConfig;
  pin: string | undefined;
  registry: string;
}

async function loadSettings(
  home: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
): Promise<Settings> {
  let cfg: UpdateConfig = UserConfigSchema.parse({}).update;
  const probe = await probePath(home, '.config/agent-kit/config.toml');
  if (probe.entry.kind !== 'missing') {
    if (probe.entry.kind !== 'file' || probe.text === undefined) {
      throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'config_invalid');
    }
    try {
      cfg = UserConfigSchema.parse(parseToml(probe.text)).update;
    } catch {
      throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'config_invalid');
    }
  }
  const envPin = env?.['KIT_UPDATE_PIN'];
  if (envPin !== undefined && envPin !== '' && !UPDATE_PIN_RE.test(envPin)) {
    throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'bad_pin');
  }
  const envRegistry = env?.['KIT_UPDATE_REGISTRY'];
  return {
    cfg,
    pin: envPin !== undefined && envPin !== '' ? envPin : cfg.pin,
    registry: envRegistry !== undefined && envRegistry !== '' ? envRegistry : cfg.registry,
  };
}

function isoOrUndefined(s: string | undefined): string | undefined {
  const ms = parseIsoUtc(s);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

export function createUpdateCommand(deps: UpdateCommandDeps = {}): CommandDef {
  const def: CommandDef = {
    name: 'update',
    summary: '检查并安装新版本(默认干跑;自动更新只换 CLI 本体)',
    phase: 'P2',
    ownerBlock: 'S7c',
    flags: [
      { name: '--write', description: '真正安装 / 回滚(缺省只打印会做什么)' },
      { name: '--now', description: '本次忽略冷却期(其余校验照旧)' },
      { name: '--major', description: '允许跨 major 升级(需要 --write)' },
      { name: '--rollback', description: '把 current 切回上一个保留版本(需要 --write)' },
      { name: '--json', description: '以 canonical JSON 输出' },
      { name: '--home <dir>', description: '只接受真实 HOME 或 KIT_TMP 之内的目录' },
    ],
    async run(ctx: CommandContext): Promise<number> {
      const args = parseArgs(ctx.argv);
      const env = (ctx as EnvCommandContext).env;
      try {
        if (args.error !== undefined) throw new Exit(ExitCode.USAGE, 'USAGE', args.error);
        const homeReal = await resolveAllowedHome(
          args.home ?? getRealHome(env),
          ctx.io.tmpDir,
          env,
        );
        if (homeReal === undefined) throw new Exit(ExitCode.USAGE, 'USAGE', 'home_not_allowed');
        const ienv: InstallEnv = { home: homeReal, tmpDir: ctx.io.tmpDir, env, deps };
        return args.rollback ? await runRollback(ctx, ienv) : await runUpdate(ctx, args, ienv);
      } catch (e) {
        const x = e instanceof Exit ? e : new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'internal');
        ctx.stderr(`UPDATE_${x.tag} reason=${x.reason}\n`);
        return x.code;
      }
    },
  };

  // -------------------------------------------------------------------------

  async function readState(ienv: InstallEnv): Promise<UpdateState> {
    const r = await readUpdateState(ienv.home);
    if (r.kind === 'unsafe')
      throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'state_dir_unsafe');
    if (r.kind === 'unreadable')
      throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'state_unreadable');
    return r.kind === 'ok' ? r.state : emptyState();
  }

  async function openSource(
    ctx: CommandContext,
    ienv: InstallEnv,
    settings: Settings,
  ): Promise<RegistrySource> {
    if (deps.source !== undefined) return deps.source;
    const r = await openRegistrySource(settings.registry, ctx.io.tmpDir, {
      env: ienv.env ?? {},
      ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
    });
    if (!r.ok) throw new Exit(ExitCode.USAGE, 'USAGE', r.reason);
    return r.source;
  }

  interface Fetched {
    primary: PackumentView;
    npmjs: NpmjsFacts;
    npmjsRaw: unknown;
  }

  async function fetchFacts(source: RegistrySource): Promise<Fetched> {
    let prim;
    try {
      prim = await source.packument();
    } catch (e) {
      const code = e instanceof NetError ? e.code : 'connect';
      throw new Exit(
        ExitCode.NOT_RUN,
        'CHECK_FAILED',
        code === 'host_denied' ? 'host_denied' : code,
      );
    }
    const primary = readPackument(prim.json);
    if (primary === undefined) throw new Exit(ExitCode.NOT_RUN, 'CHECK_FAILED', 'parse');
    if (!source.mirror) {
      return {
        primary,
        npmjs: { kind: 'ok', view: primary, dateHeader: prim.dateHeader },
        npmjsRaw: prim.json,
      };
    }
    const n = await source.npmjsPackument();
    if (n.kind === 'unreachable') {
      return { primary, npmjs: { kind: 'unreachable', cause: n.cause }, npmjsRaw: undefined };
    }
    const view = readPackument(n.json);
    if (view === undefined) {
      return { primary, npmjs: { kind: 'unreachable', cause: 'parse' }, npmjsRaw: undefined };
    }
    return { primary, npmjs: { kind: 'ok', view, dateHeader: n.dateHeader }, npmjsRaw: n.json };
  }

  function decide(
    facts: Fetched,
    state: UpdateState,
    settings: Settings,
    args: Parsed,
    mirror: boolean,
  ): Plan {
    let d: Decision;
    try {
      d = decideUpdate({
        installed: state.installed?.version ?? KIT_VERSION,
        maxSeen: state.max_seen_version,
        badVersions: state.bad_versions,
        channel: settings.cfg.channel,
        pin: settings.pin,
        allowMajor: args.major,
        cooldownHours: settings.cfg.cooldown_hours,
        skipCooldown: args.now,
        mirror,
        primary: facts.primary,
        npmjs: facts.npmjs,
      });
    } catch {
      throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'installed_version_invalid');
    }
    const plan: Plan = {
      outcome: d.code,
      ...(d.detail !== undefined ? { detail: d.detail } : {}),
      ...(d.version !== undefined ? { version: d.version } : {}),
      ...(d.publishedAt !== undefined ? { publishedAt: d.publishedAt } : {}),
      ...(d.ageMs !== undefined ? { ageMs: d.ageMs } : {}),
      ...(d.cause !== undefined ? { cause: d.cause } : {}),
    };
    if (
      plan.outcome === 'ok' &&
      plan.version !== undefined &&
      facts.npmjsRaw !== undefined &&
      isDeprecated(facts.npmjsRaw, plan.version)
    ) {
      plan.outcome = 'deprecated';
    }
    return plan;
  }

  /** 策略结果 → (stderr 稳定码, 退出码) */
  function verdict(plan: Plan): { code: number; stderr?: string } {
    switch (plan.outcome) {
      case 'ok':
      case 'up_to_date':
      case 'pinned':
      case 'cooldown':
        return { code: ExitCode.OK };
      case 'major_available':
        return { code: ExitCode.OK, stderr: 'UPDATE_MAJOR_AVAILABLE' };
      case 'deprecated':
        return { code: ExitCode.OK, stderr: 'UPDATE_NOT_RUN reason=deprecated' };
      case 'downgrade_refused':
        return { code: ExitCode.CHECK_FAILED, stderr: 'UPDATE_DOWNGRADE_REFUSED' };
      case 'verify_failed':
        return {
          code: ExitCode.CHECK_FAILED,
          stderr: `UPDATE_VERIFY_FAILED reason=${plan.detail ?? 'bad_version'}`,
        };
      case 'not_ready':
        return {
          code: ExitCode.NOT_RUN,
          stderr: `UPDATE_NOT_READY reason=${plan.detail ?? 'unknown'}`,
        };
      case 'attestations_unreachable':
        return {
          code: ExitCode.NOT_RUN,
          stderr: 'UPDATE_VERIFY_FAILED reason=attestations_unreachable',
        };
      case 'parse':
        return { code: ExitCode.NOT_RUN, stderr: 'UPDATE_CHECK_FAILED reason=parse' };
      default:
        return { code: ExitCode.NOT_RUN };
    }
  }

  function remainingHours(plan: Plan, settings: Settings): number | undefined {
    if (plan.outcome !== 'cooldown' || plan.ageMs === undefined || plan.ageMs < 0) return undefined;
    return Math.max(
      0,
      Math.ceil((settings.cfg.cooldown_hours * 3_600_000 - plan.ageMs) / 3_600_000),
    );
  }

  function emitPlan(
    ctx: CommandContext,
    args: Parsed,
    settings: Settings,
    state: UpdateState,
    plan: Plan,
    wrote: boolean,
    extra: Record<string, string | number | boolean | null> = {},
  ): void {
    const current = state.installed?.version ?? KIT_VERSION;
    const remaining = remainingHours(plan, settings);
    if (args.json) {
      ctx.stdout(
        canonicalJson({
          mode: 'update',
          dry: !wrote,
          channel: settings.cfg.channel,
          current,
          target: plan.version ?? null,
          decision: plan.outcome,
          detail: plan.detail ?? null,
          cooldown_remaining_hours: remaining ?? null,
          ...extra,
        }),
      );
      return;
    }
    const lines = [
      `current ${current}`,
      `channel ${settings.cfg.channel}`,
      `target ${plan.version ?? '-'}`,
      `decision ${plan.outcome}${plan.detail !== undefined ? ` detail=${plan.detail}` : ''}${remaining !== undefined ? ` remaining_hours=${remaining}` : ''}`,
    ];
    if (plan.outcome === 'ok' && plan.version !== undefined && !wrote) {
      lines.push(`would install ${plan.version}`);
    }
    for (const [k, v] of Object.entries(extra)) lines.push(`${k} ${v === null ? '-' : String(v)}`);
    ctx.stdout(`${lines.join('\n')}\n`);
  }

  /** 拿锁;被占 → UPDATE_NOT_RUN reason=locked(退出 4) */
  async function lockOrExit(ienv: InstallEnv): Promise<UpdateLock> {
    try {
      return await acquireUpdateLock(ienv);
    } catch (e) {
      if (e instanceof UpdateLockError) {
        if (e.detail === 'unsafe')
          throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'lock_unsafe');
        throw new Exit(
          ExitCode.NOT_RUN,
          'NOT_RUN',
          e.detail === 'held_over_ttl' ? 'locked_over_ttl' : 'locked',
        );
      }
      throw e;
    }
  }

  /**
   * 非安装的结果:在锁内重读状态,只记录这次检查。锁被占就不记(返回 true,不影响本次结果);
   * 其它写入失败(授权拒绝、状态损坏、IO 错误)返回 false,调用方按 fail-closed 退出 3。
   */
  async function recordOnly(
    ctx: CommandContext,
    ienv: InstallEnv,
    result: string,
    plan: Plan,
  ): Promise<boolean> {
    let lock: UpdateLock;
    try {
      lock = await acquireUpdateLock(ienv);
    } catch (e) {
      if (e instanceof UpdateLockError) return true;
      ctx.stderr('UPDATE_FAIL_CLOSED reason=state_write_failed\n');
      return false;
    }
    try {
      const state = await readState(ienv);
      const seen = plan.version;
      const pub = isoOrUndefined(plan.publishedAt);
      await lock.assertHeld();
      await writeUpdateState(
        ienv,
        recordCheck(state, {
          nowMs: (ienv.deps.now ?? ((): Date => new Date()))().getTime(),
          result,
          ...(seen !== undefined ? { latestSeen: seen } : {}),
          ...(pub !== undefined ? { latestSeenPublishedAt: pub } : {}),
        }),
      );
      return true;
    } catch (e) {
      ctx.stderr(
        e instanceof Exit
          ? `UPDATE_${e.tag} reason=${e.reason}\n`
          : 'UPDATE_FAIL_CLOSED reason=state_write_failed\n',
      );
      return false;
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  function resultOf(plan: Plan): string {
    if (plan.outcome === 'verify_failed') return 'verify_failed';
    return plan.outcome;
  }

  async function runUpdate(ctx: CommandContext, args: Parsed, ienv: InstallEnv): Promise<number> {
    const settings = await loadSettings(ienv.home, ienv.env);
    const state = await readState(ienv);
    const source = await openSource(ctx, ienv, settings);

    let facts: Fetched;
    try {
      facts = await fetchFacts(source);
    } catch (e) {
      if (e instanceof Exit && args.write && !(await recordOnly(ctx, ienv, e.reason, {} as Plan))) {
        throw new Exit(ExitCode.FAIL_CLOSED, 'FAIL_CLOSED', 'state_write_failed');
      }
      throw e;
    }
    const plan = decide(facts, state, settings, args, source.mirror);
    const v = verdict(plan);
    if (plan.outcome !== 'ok' || !args.write) {
      emitPlan(ctx, args, settings, state, plan, false);
      if (v.stderr !== undefined) ctx.stderr(`${v.stderr}\n`);
      if (args.write && !(await recordOnly(ctx, ienv, resultOf(plan), plan))) {
        return ExitCode.FAIL_CLOSED;
      }
      return v.code;
    }

    // --write 且策略放行:拿锁 → 重读状态 / packument → 重新决定 → 安装
    const lock = await lockOrExit(ienv);
    try {
      const state2 = await readState(ienv);
      let facts2: Fetched;
      try {
        facts2 = await fetchFacts(source);
      } catch (e) {
        if (e instanceof Exit) {
          ctx.stderr(`UPDATE_${e.tag} reason=${e.reason}\n`);
          return e.code;
        }
        throw e;
      }
      const plan2 = decide(facts2, state2, settings, args, source.mirror);
      if (plan2.outcome !== 'ok' || plan2.version === undefined) {
        const v2 = verdict(plan2);
        emitPlan(ctx, args, settings, state2, plan2, true);
        if (v2.stderr !== undefined) ctx.stderr(`${v2.stderr}\n`);
        try {
          await lock.assertHeld();
          await writeUpdateState(
            ienv,
            recordCheck(state2, {
              nowMs: (ienv.deps.now ?? ((): Date => new Date()))().getTime(),
              result: resultOf(plan2),
              ...(plan2.version !== undefined ? { latestSeen: plan2.version } : {}),
            }),
          );
        } catch (e) {
          ctx.stderr(
            e instanceof UpdateLockError
              ? 'UPDATE_FAIL_CLOSED reason=lock_lost\n'
              : 'UPDATE_FAIL_CLOSED reason=state_write_failed\n',
          );
          return ExitCode.FAIL_CLOSED;
        }
        return v2.code;
      }
      const version = plan2.version;
      const dist = facts2.npmjs.kind === 'ok' ? facts2.npmjs.view.versions[version] : undefined;
      const prim = facts2.primary.versions[version];
      const tarballUrl = (source.mirror ? prim : dist)?.tarball;
      if (tarballUrl === undefined) {
        ctx.stderr('UPDATE_NOT_READY reason=dist_incomplete\n');
        return ExitCode.NOT_RUN;
      }
      const nowMs = facts2.npmjs.kind === 'ok' ? parseHttpDate(facts2.npmjs.dateHeader) : undefined;
      const publishedMs =
        facts2.npmjs.kind === 'ok' ? parseIsoUtc(facts2.npmjs.view.time[version]) : undefined;
      const res = await installVersion(ienv, {
        version,
        distTarball: tarballUrl,
        distIntegrity: dist?.integrity,
        source,
        mirror: source.mirror,
        lock,
        state: state2,
        cooldown: {
          skip: args.now,
          hours: settings.cfg.cooldown_hours,
          nowMs,
          publishedMs,
        },
      });
      if (res.ok) {
        emitPlan(ctx, args, settings, state2, { ...plan2, outcome: 'ok' }, true, {
          installed: res.version,
          anchor: res.anchor.slice(0, 12),
          gc_removed: res.gc.removed.length,
          gc_failed: res.gc.failed,
        });
        return ExitCode.OK;
      }
      return await failInstall(ctx, args, settings, ienv, state2, plan2, res.failure, lock);
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  async function failInstall(
    ctx: CommandContext,
    args: Parsed,
    settings: Settings,
    ienv: InstallEnv,
    state: UpdateState,
    plan: Plan,
    f: InstallFailure,
    lock: UpdateLock,
  ): Promise<number> {
    const nowMs = (ienv.deps.now ?? ((): Date => new Date()))().getTime();
    // 失败路径的状态写入同样受锁所有权约束:丢锁后不得把安装开始时的旧快照写回(会盖掉新持锁者的结果)
    const persist = async (next: UpdateState): Promise<boolean> => {
      try {
        await lock.assertHeld();
        await writeUpdateState(ienv, next);
        return true;
      } catch (e) {
        ctx.stderr(
          e instanceof UpdateLockError
            ? 'UPDATE_FAIL_CLOSED reason=lock_lost\n'
            : 'UPDATE_FAIL_CLOSED reason=state_write_failed\n',
        );
        return false;
      }
    };
    const seen = plan.version !== undefined ? { latestSeen: plan.version } : {};
    switch (f.kind) {
      case 'verify_failed': {
        const base = f.bad && plan.version !== undefined ? markBad(state, plan.version) : state;
        const result = NOT_VERSION_FAULT.has(f.reason) ? f.reason : 'verify_failed';
        if (!(await persist(recordCheck(base, { nowMs, result, ...seen }))))
          return ExitCode.FAIL_CLOSED;
        emitPlan(
          ctx,
          args,
          settings,
          state,
          { ...plan, outcome: 'verify_failed', detail: f.reason },
          true,
        );
        ctx.stderr(`UPDATE_VERIFY_FAILED reason=${f.reason}\n`);
        return NOT_VERSION_FAULT.has(f.reason) || f.reason === 'host_denied'
          ? ExitCode.NOT_RUN
          : ExitCode.CHECK_FAILED;
      }
      case 'not_ready':
        if (!(await persist(recordCheck(state, { nowMs, result: 'not_ready', ...seen }))))
          return ExitCode.FAIL_CLOSED;
        emitPlan(
          ctx,
          args,
          settings,
          state,
          { ...plan, outcome: 'not_ready', detail: f.detail },
          true,
        );
        ctx.stderr(`UPDATE_NOT_READY reason=${f.detail}\n`);
        return ExitCode.NOT_RUN;
      case 'cooldown':
        if (!(await persist(recordCheck(state, { nowMs, result: 'cooldown', ...seen }))))
          return ExitCode.FAIL_CLOSED;
        emitPlan(
          ctx,
          args,
          settings,
          state,
          { ...plan, outcome: 'cooldown', detail: f.detail },
          true,
        );
        return ExitCode.OK;
      case 'net':
        if (!(await persist(recordCheck(state, { nowMs, result: f.code }))))
          return ExitCode.FAIL_CLOSED;
        ctx.stderr(`UPDATE_CHECK_FAILED reason=${f.code}\n`);
        return ExitCode.NOT_RUN;
      case 'fail_closed':
        if (f.reason === 'current_broken') ctx.stderr('UPDATE_CURRENT_BROKEN\n');
        ctx.stderr(`UPDATE_FAIL_CLOSED reason=${f.reason}\n`);
        return ExitCode.FAIL_CLOSED;
    }
  }

  async function runRollback(ctx: CommandContext, ienv: InstallEnv): Promise<number> {
    await readState(ienv); // 状态目录不安全 / 状态损坏时先于取锁报 fail-closed
    const lock = await lockOrExit(ienv);
    try {
      const state = await readState(ienv);
      const r = await rollbackInstalled(ienv, { state, lock });
      if (!r.ok) {
        if (r.reason === 'no_previous') {
          ctx.stderr('UPDATE_NOT_RUN reason=no_previous\n');
          return ExitCode.NOT_RUN;
        }
        if (r.reason === 'previous_missing') {
          ctx.stderr('UPDATE_NOT_RUN reason=previous_missing\n');
          return ExitCode.NOT_RUN;
        }
        if (r.reason === 'previous_invalid' || r.reason === 'current_broken') {
          ctx.stderr('UPDATE_CURRENT_BROKEN\n');
        }
        ctx.stderr(`UPDATE_FAIL_CLOSED reason=${r.reason}\n`);
        return ExitCode.FAIL_CLOSED;
      }
      const from = r.from ?? '-';
      ctx.stdout(
        ctx.argv.includes('--json')
          ? canonicalJson({ mode: 'rollback', dry: false, from: r.from ?? null, to: r.to })
          : `did rollback from=${from} to=${r.to}\n`,
      );
      return ExitCode.OK;
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  return def;
}

export const command: CommandDef = createUpdateCommand();

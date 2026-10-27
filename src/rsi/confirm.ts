/**
 * `agent-kit rsi confirm`(契约 R20-3.6;R20-A2 B5b 实装,方案 §5、§0.5 R2 / R11)。
 *
 * 唯一写 `state.json` 的 `confirm` 记录的路径(不经 `carryConfirm`:那是 L0 用来防止 mutator 改写确认记录的)。
 *
 * 流程(每一步的拒绝都是零写入,只有「拿锁之后」的拒绝才会留下锁文件与 `rsi/` 目录的创建 / 删除,D2 豁免):
 *  1. `parseFlags` → TTY(`resolveIsTty`,先于任何读;TTY 只是尽力区分人与脚本,不是安全边界,R20-3.6.4)→ `openRsiIo`(off → 4)。
 *  2. 观测(`observeRsi`,直读):off → 4;`state.json` 不合规 → 3 `state_invalid`;已是 confirmed → 0 `confirm already`;
 *     停止采集(`collect_blocked`,Q-H)→ 3 `RSI_FAIL_CLOSED reason=<overlay_invalid|exclude_invalid>`;STOP 无法确认身份 → 3 `state_dir_unsafe`(见下)。
 *     **不用 `readRsiState`(快照协议)做锁前读**(偏离方案 §5.1 的写法,订正待并入):「state 已写、commit 之前」崩溃后,重跑会被 `RSI_SNAPSHOT_BUSY` 卡住,
 *     而 stopped 下没有别的写入方会 recover;confirm 只依赖 `state.json`(tmp + rename 原子替换)、配置与 STOP,直读足够,未完成的提交由锁内 `recoverUnderLock` 处理。
 *  3. 做一次 armed 列举(不读正文)、再观测一次(列举期间改配置 → STALE),打印清单 + 汇总 + 固定说明;列举不完整(Q-I)加 `armed_list=incomplete` 与固定提示。
 *  4. 读一行:精确等于 `yes`(只去行尾 `\r`;EOF 算拒绝)才继续,否则 1 `RSI_CONFIRM_DECLINED`,零写入。
 *  5. D2 锁前廉价复检(不拿锁):指纹变 → 1 `RSI_CONFIRM_STALE`;每个观测点的判定序固定为 off → stateInvalid → confirmed(0 `confirm already`,各点一致)→ 停止采集 → STOP 假身份 → 指纹比较。
 *  6. 拿锁(拿不到 → 4 locked)。锁内**先于 recover** 无副作用复检(指纹变 → STALE;已 confirmed → 0 already);再 `recoverUnderLock` → `resumeTaintWith` →
 *     `taintNewlyExcludedWith(exclude)`(有改动 → `refreshStagedUnderLock`)→ 写 state(confirm 记录 `baseline_pending:true`、清熔断、清 `armed_listing`,
 *     `projects_ack_generation` / `last_tick` / `attempt` 保持原值)→ `commitUnderLockWith` → **最后**才删 STOP。
 *     崩溃时一律停在 stopped(STOP 还在)或已完整提交,是安全一侧;「state 已写、STOP 删失败」后重跑 confirm 幂等(此时状态是 stopped,confirm 有效)。
 *  7. 删 STOP 的身份核对(方案伪码漏的一条):`rsi stop` 不拿锁,可在 复检 → 删除 的窗口里写入新标记。只有「复检时 STOP 在场、且删除前重新观测的身份
 *     (dev, ino, size, mtime, ctime, 内容 sha256)与复检时逐项相同」才删;复检时不在场而现在在场则一律不删;不同则保留(最终状态 stopped),退 4 `RSI_NOT_RUN reason=stopped`,
 *     stdout `confirm recorded` / `stop=kept`(记录已写、采集仍停止,需要重跑 confirm)。观测与 `remove` 之间的窗口消不掉,登记为残余。
 *
 * STOP 假身份(B5a 评审的特别约束):`observeRsi` 在 STOP 非普通文件 / 过大 / 读失败时给出 `sha256: null`(lstat 失败时更是全零身份)并当作在场。
 * 两次这样的观测会得到**相同**的展示指纹,不能作为「STOP 没变」的证据。所以任何一次观测出现 `stop !== 'absent' && sha256 === null` 一律 fail-closed
 * 3 `state_dir_unsafe`(零写入),指纹相等永远不会在这种情形下放行。
 *
 * 不 import llm-exec / reflect 后端 / net / 更新启动器(R20-1.1,由 `import-closure.test.ts` 钉住)。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import type { RsiConfirm } from '../contracts/rsi.js';
import type { Redactor } from '../contracts/redact.js';
import { canonicalJson } from '../io/canonical-json.js';
import { lstat } from '../io/read-fs.js';
import { remove } from '../io/safe-fs.js';
import * as path from 'node:path';
import { resolveIsTty, resolveReadLine } from '../commands/types.js';
import { parseFlags } from './args.js';
import { policyFingerprint, type RsiConfigOn } from './config.js';
import { failExit } from './exit.js';
import type { IoContext } from '../io/paths.js';
import { listArmed } from './l0/armed-listing.js';
import { makeGate } from './l0/commit.js';
import { buildRedactor } from './l0/run.js';
import { clearArmedListing } from './l0/state-mutate.js';
import type { ArmedListing, BeforeWrite, L0Deps } from './l0/types.js';
import { rsiDirReadonly, type RsiLockDeps, type RsiLockHandle } from './lock.js';
import type { LockGateOptions } from './gate.js';
import { emitLines, forbiddenPaths } from './output.js';
import { cleanName, type OutLine } from './sanitize.js';
import { commitUnderLockWith, recoverUnderLock } from './services/commit.js';
import { hooksFromGate, readStateForWrite, writeStateFile } from './services/fixed-write.js';
import {
  displayFingerprint,
  observeRsi,
  type RsiObservation,
  type StopMarkId,
} from './services/observe.js';
import { openRsiIo, piDirIsSet, type OpenRsiIoDeps } from './services/open.js';
import { refreshStagedUnderLock } from './services/projections.js';
import { Writer, type ServiceHooks } from './services/staging.js';
import { resumeTaintWith, taintNewlyExcludedWith } from './services/taint.js';
import { defaultState } from './services/tick-state.js';
import type { RsiIdentity } from './state.js';
import {
  RsiFailClosedError,
  type RsiEarlyContext,
  type RsiServiceCtx,
  type RsiSubcommand,
} from './types.js';
import { withRsiLockIfGated } from './with-lock.js';

export interface RsiConfirmDeps {
  /** 注入时钟(`confirmed_at`、日志 `at`) */
  now?: () => Date;
  open?: OpenRsiIoDeps;
  gate?: LockGateOptions;
  lock?: RsiLockDeps;
  /** 每个写点之前(测试的故障注入 / 失锁演练);与 `assertHeld` 同一个入口 */
  beforeWrite?: BeforeWrite;
  /** 锁内、复检之前(演练「拿锁之后改配置」) */
  afterLock?: () => Promise<void> | void;
  /** armed 列举(缺省 `listArmed`;测试用来造「列举不完整」与「列举期间改配置」) */
  listArmed?: (io: IoContext, config: RsiConfigOn) => Promise<ArmedListing>;
  /** armed 列举的 L0 测试缝(`piDirSet` 缺省取命令边界的 env) */
  l0?: L0Deps;
  /** taint 之后重算 `counts.staged` 用的脱敏器(缺省按 overlay 现建) */
  redactor?: Pick<Redactor, 'pass2'>;
}

/** 固定说明(R20-3.6.2):不含路径、目录名、key */
const NOTE_LINES: readonly string[] = [
  '确认后,agent-kit 将读取上面列出的项目的会话全文,脱敏后存入本机信号库。',
  '要排除某个项目,在 config.toml 的 [rsi] 段里写 exclude_dirs;已排除项目已采集的数据用 rsi purge 删除。',
  '随时可以用 rsi stop 停止采集。',
];
const INCOMPLETE_LINES: readonly string[] = [
  'armed_list=incomplete',
  '提示:上面的清单不完整,未列出的项目同样会被读取。',
];
const PROMPT_LINE = '输入 yes 确认,其它任何输入都会取消:';

/** 一次观测的分流:`off` / `already` / `proceed`;不合规直接抛(stateInvalid、停止采集、STOP 无法确认身份) */
type Gate = 'off' | 'already' | 'proceed';

async function classify(io: IoContext, o: RsiObservation): Promise<Gate> {
  if (o.state.state === 'off') return 'off';
  if (o.state.stateInvalid) throw new RsiFailClosedError('state_invalid');
  if (o.state.state === 'confirmed') return 'already';
  // Q-H:停止采集(overlay / 排除项不合规)时确认记录会绑定一份不可用的策略
  if (o.state.collectBlocked !== null) throw new RsiFailClosedError(o.state.collectBlocked);
  // STOP 假身份:无法确认的身份不能当作「没变」的证据(见头注释)
  if (o.stop !== 'absent' && o.stop.sha256 === null)
    throw new RsiFailClosedError('state_dir_unsafe');
  // 身份可算但形状不对的 STOP(硬链接 / 异属主):删除处一定会拒,所以在这里就拒(零写入),免得 commit 之后才失败、重试又循环
  if (o.stop !== 'absent') {
    const d = await rsiDirReadonly(io);
    if (d.kind !== 'ok') throw new RsiFailClosedError('state_dir_unsafe');
    const st = await lstat(path.join(d.dir, 'STOP'));
    const uid = process.getuid?.();
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.nlink !== 1 ||
      (uid !== undefined && st.uid !== uid)
    ) {
      throw new RsiFailClosedError('state_dir_unsafe');
    }
  }
  // config 为 on 时 observeRsi 必算出 identity(off 已在前面返回):此分支只可能是编程错误
  if (o.identity === null) throw new RsiFailClosedError('internal');
  return 'proceed';
}

const cmpName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 与 `rsi projects` 首次 armed 同样的行(`key=- name=… sessions=… status=pending|excluded`)与汇总行;测试钉住逐字节相等 */
function listingLines(l: ArmedListing): OutLine[] {
  const rows = l.rows
    .map((r) => ({ name: cleanName(r.name), sessions: r.sessions, excluded: r.excluded }))
    .sort((a, b) => cmpName(a.name, b.name));
  const out: OutLine[] = rows.map((r) => ({
    head: `key=- name=${r.name} sessions=${r.sessions} status=${r.excluded ? 'excluded' : 'pending'}`,
  }));
  const excluded = rows.filter((r) => r.excluded).length;
  out.push({
    head: `projects collecting=${rows.length - excluded} excluded=${excluded} new=0 unknown_signals=0 unknown_sessions=${l.unknownSessions}`,
  });
  return out;
}

function confirmRecord(identity: RsiIdentity, at: Date): RsiConfirm {
  // 不在这里单独解析 confirm:确认记录的 schema 只许 contracts/rsi.ts 与 state.ts 引用;`writeStateFile` 里整份 state 的 parse 会校验它
  return {
    confirmed_at: at.toISOString(),
    kit_major: identity.policy.kit_major,
    agents: [...identity.policy.agents],
    exclude_hashes: [...identity.policy.exclude_hashes],
    repo_sha256: identity.repoSha256,
    repo_dev_ino: { dev: identity.repoDevIno.dev, ino: identity.repoDevIno.ino },
    overlay_sha256: identity.policy.overlay_sha256,
    policy_fp: policyFingerprint(identity.policy),
    baseline_pending: true,
  };
}

type StopOutcome = 'none' | 'removed' | 'kept';

/**
 * commit 之后的最后一步:删 STOP。只有「复检(obs3)时在场、重新观测的身份与它逐项相同」才删(见头注释第 7 条)。
 * 普通文件 + 单链接 + 属主是自己才删(不删奇怪的对象:此时 state 已提交,停在 stopped,安全)。
 */
async function removeStopIfSame(
  sctx: RsiServiceCtx,
  lock: RsiLockHandle,
  hooks: ServiceHooks,
  env: RsiEarlyContext['env'],
  seen: StopMarkId,
): Promise<StopOutcome> {
  const now = await observeRsi(sctx.io, env);
  if (now.stop === 'absent') return 'none';
  // 复检时不在场(seen === 'absent')而现在在场 = 窗口内有人 rsi stop:一律不删;身份不同同样不删
  if (seen === 'absent' || canonicalJson(now.stop) !== canonicalJson(seen)) return 'kept';
  const d = await rsiDirReadonly(sctx.io);
  if (d.kind !== 'ok') throw new RsiFailClosedError('state_dir_unsafe');
  const file = path.join(d.dir, 'STOP');
  const st = await lstat(file);
  const uid = process.getuid?.();
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    (uid !== undefined && st.uid !== uid)
  ) {
    throw new RsiFailClosedError('state_dir_unsafe');
  }
  // lstat 与刚才观测的身份再核一次(把窗口缩到 lstat → remove)
  if (st.dev !== seen.dev || st.ino !== seen.ino || st.size !== seen.size) return 'kept';
  await new Writer(sctx.io, lock, hooks).op('stop-remove', () => remove(sctx.io, file));
  return 'removed';
}

type Locked =
  { kind: 'off' } | { kind: 'already' } | { kind: 'stale' } | { kind: 'done'; stop: StopOutcome };

export async function runConfirm(ctx: RsiEarlyContext, deps: RsiConfirmDeps = {}): Promise<number> {
  if (!parseFlags(ctx.argv, []).ok) {
    ctx.stderr('RSI_USAGE reason=unknown_arg\n');
    return ExitCode.USAGE;
  }
  // TTY 先于任何读;非 TTY 不调 readLine
  if (!resolveIsTty(ctx)) {
    ctx.stderr('RSI_USAGE reason=not_tty\n');
    return ExitCode.USAGE;
  }
  const notRun = (reason: string): number => {
    ctx.stderr(`RSI_NOT_RUN reason=${reason}\n`);
    return ExitCode.NOT_RUN;
  };
  const stale = (): number => {
    ctx.stderr('RSI_CONFIRM_STALE\n');
    return ExitCode.CHECK_FAILED;
  };
  const already = (): number => {
    ctx.stdout('confirm already\n');
    return ExitCode.OK;
  };
  try {
    const open = await openRsiIo(ctx, deps.open);
    if (open.kind === 'usage') {
      ctx.stderr(`${open.code} reason=${open.reason}\n`);
      return ExitCode.USAGE;
    }
    if (open.kind === 'off') return notRun('off');
    const sctx: RsiServiceCtx = {
      ...open.ctx,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    };
    const { io, config } = sctx;
    const now = deps.now ?? ((): Date => new Date());

    // ① 观测 + 展示指纹
    const obs0 = await observeRsi(io, ctx.env);
    const g0 = await classify(io, obs0);
    if (g0 === 'off') return notRun('off');
    if (g0 === 'already') return already();
    const fp0 = displayFingerprint(obs0);

    // ② armed 列举(不读正文),再观测:列举期间配置被改 → STALE
    const l0: L0Deps = { ...(deps.l0 ?? {}), piDirSet: deps.l0?.piDirSet ?? piDirIsSet(ctx.env) };
    const listing = await (deps.listArmed ?? ((i, c) => listArmed(i, c, l0)))(io, config);
    const obs1 = await observeRsi(io, ctx.env);
    const g1 = await classify(io, obs1);
    if (g1 === 'off') return notRun('off');
    if (g1 === 'already') return already();
    if (displayFingerprint(obs1) !== fp0) return stale();

    // ③ 展示(整份先构造、过泄漏闸再一次性输出)
    const lines: OutLine[] = [
      ...listingLines(listing),
      ...NOTE_LINES.map((head) => ({ head })),
      ...(listing.complete === false ? INCOMPLETE_LINES.map((head) => ({ head })) : []),
      { head: PROMPT_LINE },
    ];
    const shown = emitLines(
      ctx,
      lines,
      await forbiddenPaths(ctx.env, [io.stateDir, io.repoRoot, config.repo]),
    );
    if (shown !== ExitCode.OK) return shown;

    // ④ 输入:精确 `yes`(只去行尾 \r);EOF 算拒绝
    const raw = await resolveReadLine(ctx)();
    if (raw === undefined || raw.replace(/\r$/, '') !== 'yes') {
      ctx.stderr('RSI_CONFIRM_DECLINED\n');
      return ExitCode.CHECK_FAILED;
    }

    // ⑤ D2 锁前廉价复检:不拿锁,真正零写入
    const obs2 = await observeRsi(io, ctx.env);
    const g2 = await classify(io, obs2);
    if (g2 === 'off') return notRun('off');
    if (g2 === 'already') return already();
    if (displayFingerprint(obs2) !== fp0) return stale();

    // ⑥ 拿锁(只在 yes 之后)
    const locked = await withRsiLockIfGated(
      sctx,
      async (lock): Promise<Locked> => {
        if (lock === null) throw new RsiFailClosedError('internal');
        await deps.afterLock?.();
        // 无副作用复检,先于 recover(D2:拒绝时除锁文件与 rsi/ 之外零写入)
        const obs3 = await observeRsi(io, ctx.env);
        const g3 = await classify(io, obs3);
        if (g3 === 'off') return { kind: 'off' };
        if (g3 === 'already') return { kind: 'already' };
        if (displayFingerprint(obs3) !== fp0) return { kind: 'stale' };
        const identity = obs3.identity;
        const cfg3 = obs3.config;
        if (identity === null || cfg3.status !== 'on') throw new RsiFailClosedError('internal');

        const hooks = hooksFromGate(makeGate(lock, deps.beforeWrite));
        await recoverUnderLock(sctx, lock, hooks);
        await resumeTaintWith(sctx, lock, hooks);
        // 刚写下的排除立即生效:新命中的暂存 run / promote 先 taint,counts.staged 同锁内校正(盐缺失则跳过)
        const t = await taintNewlyExcludedWith(sctx, lock, { source: 'exclude' }, hooks);
        if (t.runsMarked + t.promotesMarked > 0) {
          await refreshStagedUnderLock(
            sctx,
            lock,
            deps.redactor ?? (await buildRedactor(cfg3)),
            hooks,
          );
        }
        // 坏 confirm 被新记录覆盖(不透传);projects_ack_generation / last_tick / attempt 保持原值
        const st = await readStateForWrite(io);
        const next = clearArmedListing({
          ...(st.prev ?? defaultState()),
          confirm: confirmRecord(identity, now()),
          breaker: null,
          consecutive_failures: 0,
        });
        await writeStateFile(sctx, lock, next, undefined, hooks);
        await commitUnderLockWith(
          sctx,
          lock,
          { trigger: 'confirm', log: { action: 'confirmed', code: 'ok' } },
          hooks,
        );
        // 最后一步:删 STOP(崩溃停在 stopped 的一侧)
        // commit 之后的任何失败(删 STOP 失败、再观测失败)都要让用户知道记录已写入
        try {
          return {
            kind: 'done',
            stop: await removeStopIfSame(sctx, lock, hooks, ctx.env, obs3.stop),
          };
        } catch (e) {
          ctx.stdout('confirm recorded\n');
          throw e;
        }
      },
      {
        ...(deps.gate !== undefined ? { gate: deps.gate } : {}),
        ...(deps.lock !== undefined ? { lock: deps.lock } : {}),
      },
    );
    if (locked.kind === 'off') return notRun('off');
    if (locked.kind === 'already') return already();
    if (locked.kind === 'stale') return stale();
    if (locked.stop === 'kept') {
      // 记录已写入且已提交,但 STOP 在窗口内被换成了别的标记:保留它,最终状态是 stopped
      ctx.stdout('confirm recorded\nstop=kept\n');
      return notRun('stopped');
    }
    ctx.stdout('confirm ok\n');
    return ExitCode.OK;
  } catch (e) {
    return failExit(ctx.stderr, e);
  }
}

export const subcommand: RsiSubcommand = {
  name: 'confirm',
  owner: 'B5',
  run: (ctx) => runConfirm(ctx),
};

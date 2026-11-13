/**
 * 命令面的生产组装(W8a:只读端口;SOLID 的 D:业务依赖端口,具体实现在这里注入)。**未接线的一律 fail-closed**:
 *   - 受限只读 git 适配器:只有显式给了 `gitPath`(git 的绝对路径)才装配;否则 `unwiredRecordedRead`(`unreadable(not_wired)` → 命令退 3,绝不假装成功);
 *     spawn 出口 = `io/exec.ts` 的 `runGitClosed`(eslint 限域:`src/rsi/**` 内只有本文件可引用);
 *   - 裁决读取(N4-2):未接线 → `unavailable`(只影响 `rsi show` 的该段);
 *   - 写命令的端口(`PauseStatePort` / `RollbackDeps` 等)归 W8b,本文件不含任何写出口。
 * `[rsi]` 关闭时没有仓库 `.state`:state / view / audit 读为缺失、标记为不存在(`auto status` 照常给出 `enabled=false`)。
 */
import * as path from 'node:path';
import {
  RSI_FAIL_CLOSED_REASONS,
  RsiAutoSchema,
  type RsiFailClosedReason,
} from '../../contracts/rsi.js';
import { runGitClosed } from '../../io/exec.js';
import { getRealHome } from '../../io/paths.js';
import { lstat, readFileSafe } from '../../io/read-fs.js';
import { CANARY_FILES } from '../canary/files.js';
import { loadRsiConfig, type RsiOffReason } from '../config.js';
import { RSI_FILE_OWNER, rsiDirReadonly } from '../lock-read.js';
import { makeGitReadonly } from '../personal/read/git-readonly.js';
import { makeHomeReadPort } from '../personal/read/home-reads.js';
import { unwiredRecordedRead } from '../personal/read/recorded-port.js';
import { openRsiIo } from '../services/open.js';
import { parseRsiStateDoc } from '../state.js';
import { RsiFailClosedError, type RsiEarlyContext } from '../types.js';
import {
  AutoUsageError,
  type AutoReadPorts,
  type MarkerRead,
  type RawRead,
  type StateRead,
} from './read/ports.js';
import { interpretView } from './read/view-read.js';

/** 私有仓库 git 目录(HOME 相对;与 `home-state.ts` 的 `PERSONAL_REPO_REL` + `.git` 相同) */
export const PERSONAL_GIT_DIR_REL = '.local/share/agent-kit/personal/.git';

/** 合法关闭 / 确实没有配置:没有仓库与状态目录可泄漏(其余 off 原因 = 配置不可信) */
const LEGIT_OFF: ReadonlySet<RsiOffReason> = new Set<RsiOffReason>([
  'absent',
  'no_section',
  'disabled',
]);

/** 不可信配置的 off 原因 → 码表里同名的 fail-closed reason(`cfg_*` / `repo_invalid` 都在 `RSI_FAIL_CLOSED_REASONS`);对不上码表则 internal */
function untrustedReason(r: RsiOffReason): RsiFailClosedReason {
  return (RSI_FAIL_CLOSED_REASONS as readonly string[]).includes(r)
    ? (r as RsiFailClosedReason)
    : 'internal';
}

/**
 * 输出泄漏闸的额外禁止值:状态目录、仓库根、`[rsi] repo`、私有仓库目录,以及显式 `--root`(按 `createRsiIoContext` 同样的方式解析;合法关闭时它也是已知路径)。
 * **不静默丢项**:配置 on 时仓库根 / 状态目录必须取得,缺一项 = 抛错(fail-closed);只有 `explicitRoot` 是可选来源。
 */
export function forbiddenExtra(
  ctx: Pick<RsiEarlyContext, 'explicitRoot' | 'cwd'>,
  io: { stateDir: string; repoRoot: string } | null,
  repo: string | null,
  gitDir: string,
): string[] {
  const out: string[] = [gitDir];
  if (repo !== null) {
    if (io === null || !io.stateDir || !io.repoRoot || !repo)
      throw new RsiFailClosedError('internal');
    out.push(io.stateDir, io.repoRoot, repo);
  }
  if (ctx.explicitRoot !== undefined) {
    out.push(
      ctx.cwd === undefined
        ? path.resolve(ctx.explicitRoot)
        : path.resolve(ctx.cwd, ctx.explicitRoot),
    );
  }
  return out;
}

export interface ProductionPortsOptions {
  /** git 可执行文件的绝对路径(装配传入;缺省 = 未装配) */
  gitPath?: string;
  now?: () => Date;
}

export async function productionAutoPorts(
  ctx: RsiEarlyContext,
  opts: ProductionPortsOptions = {},
): Promise<AutoReadPorts> {
  const env = ctx.env;
  const cfg = await loadRsiConfig({ ...(env !== undefined ? { env } : {}) });
  // 配置无法可信读取(不是「确实没有配置 / 合法关闭」)→ 在任何读取与输出之前 fail-closed:此时拿不到仓库根 / 状态目录,泄漏闸的禁止集合不完整
  if (cfg.status === 'off' && !LEGIT_OFF.has(cfg.reason)) {
    throw new RsiFailClosedError(untrustedReason(cfg.reason));
  }
  const home = getRealHome(env);
  const open = cfg.status === 'on' ? await openRsiIo(ctx) : null;
  if (open !== null && open.kind === 'usage') throw new AutoUsageError(open.reason);
  // 配置 on 却没拿到 ready(两次加载之间配置变了):同样 fail-closed,不带着缺项的禁止集合继续
  if (cfg.status === 'on' && (open === null || open.kind !== 'ready')) {
    throw new RsiFailClosedError('internal');
  }
  const io = open !== null && open.kind === 'ready' ? open.ctx.io : null;

  /**
   * `.state/rsi/<name>` 的句柄级安全读取(只读;缺失 = `null`;元数据不合规 → fail-closed `state_dir_unsafe`)。
   * 自己实现、不经 `services/attribution.ts`:后者的闭包带 `lock.ts`(写侧),读侧入口闭包不得含它。
   */
  const readFixed = async (name: string): Promise<Buffer | null> => {
    if (io === null) return null;
    const d = await rsiDirReadonly(io);
    if (d.kind === 'missing') return null;
    if (d.kind === 'unsafe') throw new RsiFailClosedError('state_dir_unsafe');
    const r = await readFileSafe(path.join(d.dir, name), {
      maxBytes: 64 * 1024 * 1024,
      owner: RSI_FILE_OWNER,
    });
    if (r.kind === 'ok') return r.bytes;
    if (r.kind === 'missing') return null;
    throw new RsiFailClosedError('state_dir_unsafe');
  };

  const fixed = async (name: string): Promise<RawRead> => {
    try {
      const b = await readFixed(name);
      return b === null ? { kind: 'absent' } : { kind: 'ok', text: b.toString('utf8') };
    } catch {
      return { kind: 'unreadable' };
    }
  };

  const state = async (): Promise<StateRead> => {
    const doc = parseRsiStateDoc(await readFixed('state.json'));
    if (doc.kind === 'absent') return { kind: 'absent' };
    if (doc.kind === 'invalid') return { kind: 'invalid' };
    const ap = doc.state.auto_pause;
    return {
      kind: 'ok',
      autoPause:
        ap === undefined
          ? null
          : { reasons: ap.reasons, diverged: ap.diverged, ownerChanged: ap.owner_changed },
    };
  };

  const markers = async (): Promise<MarkerRead> => {
    if (io === null) return { user: 'absent', breaker: 'absent' };
    const d = await rsiDirReadonly(io);
    if (d.kind === 'missing') return { user: 'absent', breaker: 'absent' };
    if (d.kind === 'unsafe') return { user: 'present', breaker: 'present' };
    const one = async (name: string): Promise<'absent' | 'present'> => {
      try {
        await lstat(path.join(d.dir, name));
        return 'present';
      } catch (e) {
        // lstat 失败且不是 ENOENT 也按存在处理(fail-closed,与 hint 一致)
        return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'present';
      }
    };
    return { user: await one(CANARY_FILES.pause), breaker: await one(CANARY_FILES.pauseBreaker) };
  };

  const now = opts.now ?? ((): Date => new Date());
  const parsedAuto = cfg.status === 'on' ? RsiAutoSchema.safeParse(cfg.auto ?? {}) : null;
  const autoCfg = parsedAuto !== null && parsedAuto.success ? parsedAuto.data : null;
  const gitDir = path.join(home, ...PERSONAL_GIT_DIR_REL.split('/'));

  return {
    now,
    async config() {
      return {
        rsiOn: cfg.status === 'on',
        enabled: autoCfg?.enabled === true,
        profile: autoCfg?.profile ?? 'medium',
      };
    },
    state,
    view: () => fixed('auto-view.json'),
    markers,
    audit: () => fixed('audit.jsonl'),
    async priorActivity() {
      const ledger = await fixed(CANARY_FILES.ledger);
      if (ledger.kind === 'unreadable' || (ledger.kind === 'ok' && ledger.text !== '')) return true;
      const v = interpretView(await fixed('auto-view.json'), now());
      if (v.state === 'corrupt') return true;
      if (v.state === 'missing') return false;
      const n = Object.values(v.view.pipeline.states).reduce((a, b) => a + b, 0);
      const t = v.view.pipeline.last30d;
      return n + t.rejected + t.rolled_back + t.expired + t.retired > 0;
    },
    home: makeHomeReadPort(home),
    recorded:
      opts.gitPath === undefined
        ? unwiredRecordedRead
        : makeGitReadonly({
            gitPath: opts.gitPath,
            gitDir,
            spawn: (file, argv, o) => runGitClosed(file, argv, o),
          }),
    judge: { verdictFor: async () => ({ kind: 'unavailable' }) },
    // 与 status / digest / tick 同一来源:状态目录、仓库根、`[rsi] repo`;另加私有仓库目录(HOME 相对,realpath 由 forbiddenPaths 补)
    outputForbidden: forbiddenExtra(ctx, io, cfg.status === 'on' ? cfg.repo : null, gitDir),
  };
}

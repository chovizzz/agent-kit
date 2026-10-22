/**
 * 三个 CLI 适配器共用的调用流程。这是 `runLlm` 的唯一调用点。
 * 顺序(前面任何一步失败都**不 spawn、不消耗预算**):
 *  厂商 unknown → 绑定不完整 → 环境(HOME/XDG/TMPDIR/PATH)→ 未允许 egress → 参数集未核实 → 请求形状
 *  → [串行化 → 跨进程锁 → 上述门禁复核 → 冷却 → 二进制 → 清单复核] → runLlm。
 * `CliBackend` 是 backends/ 内部类型:本目录之外只能经 `index.ts` 的 `buildBackends` 拿到后端
 * (no-leak 测试扫描 src/ 里 backends/ 之外对本文件的 import)。
 */
import * as path from 'node:path';
import type {
  LlmBackend,
  LlmBackendCli,
  LlmCompleteRequest,
  LlmCompleteResult,
} from '../backend-iface.js';
import { UNKNOWN_VENDOR } from '../../contracts/vendor.js';
import { deriveBackendVendor } from '../backend-identity.js';
import {
  LLM_MAX_TIMEOUT_MS,
  LLM_STDIN_MAX_BYTES,
  LlmExecDeniedError,
  LlmSpawnBudget,
  runLlm,
} from '../../io/llm-exec.js';
import type { LlmResult } from '../../io/llm-exec.js';
import type { IoContext } from '../../io/paths.js';
import { existsSync, realpathSync, statSync } from '../../io/read-fs.js';
import { isCoolingDown, markCooldown } from './cooldown.js';
import { serialized } from './gate.js';
import { LOCK_STALE_MS, withLlmLock } from './lock.js';
import type { BackendDeps, CliArgSet } from './types.js';

/** `--provider`/`--model` 进 argv 的字符集(与契约 ARG_ID_RE 同形):不得以 `-` 开头。 */
const ARG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
/** 限流:429 或 rate limit。只在**退出码非 0 且不是被信号杀掉**时才看(退出 0 的 stdout 是模型文本,不可信)。 */
const RATE_LIMIT_RE = /\b429\b|rate[\s_-]?limit/i;
const HTTP_AUTH_RE = /\b(40[23])\b/;
const CONNECTION_RE =
  /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|connection (error|refused|reset)|fetch failed/i;

type FailReason = Extract<LlmCompleteResult, { ok: false }>['reason'];
const fail = (reason: FailReason, detail: string): LlmCompleteResult => ({
  ok: false,
  reason,
  detail,
});

/** 默认的二进制解析:只看 PATH 里的绝对项(与 runLlm 同一规则),返回可执行常规文件的绝对路径。 */
export function defaultWhich(name: string, pathEnv: string): string | undefined {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue;
    const c = path.join(dir, name);
    try {
      const st = statSync(c);
      if (st.isFile() && (st.mode & 0o111) !== 0) return c;
    } catch {
      // 继续找下一项
    }
  }
  return undefined;
}

function realOrResolved(p: string): string {
  const abs = path.resolve(p);
  try {
    return existsSync(abs) ? realpathSync(abs) : abs;
  } catch {
    return abs;
  }
}

function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** macOS 默认大小写不敏感:判「是否在仓库内」时统一折叠大小写与 Unicode 形式,宁可多拒。 */
const fold = (p: string): string => p.normalize('NFC').toLowerCase();
const withinFold = (parent: string, child: string): boolean => within(fold(parent), fold(child));

const DIR_VARS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'TMPDIR',
];

type EnvSnapshot =
  | { readonly ok: true; readonly env: Readonly<Record<string, string | undefined>> }
  | { readonly ok: false; readonly detail: string };

/**
 * 取一份环境快照并检查:HOME、XDG_* 与 TMPDIR 必须是绝对路径,且不得指进仓库(`KIT_TMP` 内除外;
 * 但 KIT_TMP 若包含整个仓库则不给任何豁免);PATH 里指进仓库的项被剔除(CLI 自己再起子进程时不会用到仓库里的程序)。
 */
function snapshotEnv(
  ctx: IoContext,
  source: Readonly<Record<string, string | undefined>>,
): EnvSnapshot {
  const repo = realOrResolved(ctx.repoRoot);
  const tmp = ctx.tmpDir === undefined ? undefined : realOrResolved(ctx.tmpDir);
  const tmpUsable = tmp !== undefined && !within(tmp, repo);
  const exempt = (real: string): boolean => tmpUsable && within(tmp, real);
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) if (typeof v === 'string') env[k] = v;
  for (const name of DIR_VARS) {
    const v = env[name];
    if (v === undefined || v === '') continue;
    if (!path.isAbsolute(v)) return { ok: false, detail: 'env_relative_path' };
    const real = realOrResolved(v);
    if (withinFold(repo, real) && !exempt(real)) return { ok: false, detail: 'env_in_repo' };
  }
  if (env['PATH'] !== undefined) {
    env['PATH'] = env['PATH']
      .split(path.delimiter)
      .filter((dir) => {
        if (dir === '' || !path.isAbsolute(dir)) return false;
        const real = realOrResolved(dir);
        return !(withinFold(repo, real) && !exempt(real));
      })
      .join(path.delimiter);
  }
  return { ok: true, env: Object.freeze(env) };
}

export interface CliBackendInit {
  readonly slot: string;
  /** 内部类型。生产路径只经 `buildBackends` 按 cli 选内置的冻结参数集 */
  readonly args: CliArgSet;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly vendorOverrides: Readonly<Record<string, string>>;
  readonly resetTz: string;
  readonly deps: BackendDeps;
}

export class CliBackend implements LlmBackend {
  readonly #slot: string;
  readonly #vendor: string;
  readonly #model: string;
  readonly #args: CliArgSet;
  readonly #provider: string | undefined;
  readonly #rawModel: string | undefined;
  readonly #resetTz: string;
  readonly #deps: BackendDeps;
  /** 绑定本身不合法时的固定拒绝原因(构造时算好) */
  readonly #bindingProblem: string | undefined;

  constructor(init: CliBackendInit) {
    this.#slot = init.slot;
    this.#args = init.args;
    this.#provider = init.provider;
    this.#rawModel = init.model;
    this.#resetTz = init.resetTz;
    this.#deps = Object.freeze({ ...init.deps });
    // 厂商只在这里推导一次,与 argv 用的是同一份 provider/model
    this.#vendor = deriveBackendVendor(
      init.args.cli,
      init.provider,
      init.model,
      init.vendorOverrides,
    );
    this.#model = init.model ?? 'unconfigured';
    this.#bindingProblem = checkBinding(init);
  }

  get slot(): string {
    return this.#slot;
  }
  get vendor(): string {
    return this.#vendor;
  }
  get model(): string {
    return this.#model;
  }
  get cli(): LlmBackendCli {
    return this.#args.cli;
  }
  get provider(): string | undefined {
    return this.#provider;
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
    try {
      return await this.#complete(req);
    } catch {
      // 任何意外(注入的 which/now 抛错、非法日期…)都按失败结果返回,不让异常穿过兜底链
      return fail('error', 'internal');
    }
  }

  /** 不 spawn 的静态门禁;进入时与拿到锁之后各跑一次。返回非 undefined = 拒绝。 */
  #gate(env: EnvSnapshot): LlmCompleteResult | undefined {
    const deps = this.#deps;
    // 厂商必须可证明(unknown 不 spawn;无法证明就不放行)
    if (this.#vendor === UNKNOWN_VENDOR) return fail('not_configured', 'unknown_vendor');
    if (this.#bindingProblem !== undefined) return fail('not_configured', this.#bindingProblem);
    if (!(deps.budget instanceof LlmSpawnBudget)) return fail('error', 'bad_budget');
    if (!env.ok) return fail('not_configured', env.detail);
    // 出口开关:命令层没有拿到用户的 --run-llm --allow-egress 同意就不外发
    if (deps.allowEgress !== true) return fail('not_configured', 'egress_not_allowed');
    // 参数集未核实 → 拒绝真跑(只有代码注入的二进制清单能放行)
    if (!this.#args.verified && (deps.allowUnverified ?? []).length === 0) {
      return fail('not_configured', 'unverified_cli_flags');
    }
    return undefined;
  }

  async #complete(req: LlmCompleteRequest): Promise<LlmCompleteResult> {
    const deps = this.#deps;
    const env = snapshotEnv(deps.ctx, deps.envSource);
    const refused = this.#gate(env);
    if (refused !== undefined) return refused;
    if (!env.ok) return fail('not_configured', env.detail); // 类型收窄用,上面已返回
    // 请求形状
    const input = `${req.system}\n\n${req.user}\n`;
    if (
      !Number.isInteger(req.timeoutMs) ||
      req.timeoutMs < 1 ||
      req.timeoutMs > LLM_MAX_TIMEOUT_MS ||
      !Number.isInteger(req.maxOutputBytes) ||
      req.maxOutputBytes < 1
    ) {
      return fail('error', 'bad_request');
    }
    if (input.includes('\0') || Buffer.byteLength(input, 'utf8') > LLM_STDIN_MAX_BYTES) {
      return fail('error', 'input_too_large');
    }
    // 同一 state 目录下的调用排成一条链(runLlm 的 cwd 是共享的固定目录),再加跨进程锁;
    // 冷却检查也在锁内,这样并发的第二个调用能看到第一个刚写下的标记
    return serialized(deps.ctx.stateDir, async () => {
      const locked = await withLlmLock(deps.ctx, deps.lockStaleMs ?? LOCK_STALE_MS, () =>
        this.#run(req, input),
      );
      if (locked.status === 'ok') return locked.value;
      return fail('error', locked.status === 'busy' ? 'busy' : 'lock_failed');
    });
  }

  async #run(req: LlmCompleteRequest, input: string): Promise<LlmCompleteResult> {
    const deps = this.#deps;
    const args = this.#args;
    const cd = { ctx: deps.ctx, resetTz: this.#resetTz };
    // 排队期间环境可能变了:拿到锁后重新取快照并复核门禁
    const env = snapshotEnv(deps.ctx, deps.envSource);
    const refused = this.#gate(env);
    if (refused !== undefined) return refused;
    if (!env.ok) return fail('not_configured', env.detail);

    if (await isCoolingDown(cd, this.#slot, deps.now())) return fail('rate_limited', 'cooldown');

    const which = deps.which ?? defaultWhich;
    const bin = which(args.cli, env.env['PATH'] ?? '');
    if (bin === undefined || !path.isAbsolute(bin))
      return fail('not_installed', 'binary_not_found');
    // 放行未核实参数集时,只允许清单里的二进制(按 realpath 比较)
    if (!args.verified) {
      const real = realOrResolved(bin);
      if (!(deps.allowUnverified ?? []).some((a) => realOrResolved(a) === real)) {
        return fail('not_configured', 'unverified_cli_flags');
      }
    }

    let res: LlmResult;
    try {
      res = await runLlm(deps.ctx, {
        allowEgress: true,
        file: bin,
        args: args.build({ provider: this.#provider, model: this.#rawModel ?? '' }),
        input,
        envSource: env.env,
        passEnv: [],
        timeoutMs: req.timeoutMs,
        budget: deps.budget,
      });
    } catch (e) {
      if (e instanceof LlmExecDeniedError) {
        if (e.code === 'IO_LLM_BINARY_DENIED') return fail('not_installed', 'binary_denied');
        if (e.code === 'IO_LLM_SPAWN_LIMIT') return fail('error', 'spawn_limit');
        return fail('error', e.code.toLowerCase());
      }
      return fail('error', 'exec_failed');
    }

    if (res.spawnError !== undefined) {
      return /ENOENT|EACCES/.test(res.spawnError)
        ? fail('not_installed', 'spawn_failed')
        : fail('error', 'spawn_failed');
    }
    if (res.timedOut) return fail('timeout', 'timeout');
    if (res.stdoutTruncated || Buffer.byteLength(res.stdout, 'utf8') > req.maxOutputBytes) {
      return fail('error', 'output_too_large');
    }
    if (res.status === null) return fail('error', `signal_${res.signal ?? 'unknown'}`);
    if (res.status !== 0) {
      const text = `${res.stderr}\n${res.stdout}`;
      if (RATE_LIMIT_RE.test(text)) {
        const wrote = await markCooldown(cd, this.#slot, deps.now());
        return fail('rate_limited', wrote ? 'rate_limit_marked' : 'cooldown_write_failed');
      }
      const http = HTTP_AUTH_RE.exec(text);
      if (http !== null) return fail('error', `http_${http[1]}`);
      if (CONNECTION_RE.test(text)) return fail('error', 'connection_error');
      return fail('error', `exit_${res.status}`);
    }
    if (res.stdout.trim() === '') return fail('error', 'empty_output');
    return { ok: true, text: res.stdout };
  }
}

function checkBinding(init: CliBackendInit): string | undefined {
  const { args, provider, model } = init;
  if (model === undefined) return 'model_required';
  if (typeof model !== 'string' || !ARG_ID_RE.test(model)) return 'bad_model';
  if (provider !== undefined && (typeof provider !== 'string' || !ARG_ID_RE.test(provider))) {
    return 'bad_provider';
  }
  if (args.provider === 'forbidden' && provider !== undefined) return 'provider_not_applicable';
  if (args.provider === 'required' && provider === undefined) return 'provider_required';
  return undefined;
}

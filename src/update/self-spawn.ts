/**
 * 自动 RSI 的零网络 `runSelf` 桥接(R20-A0;docs/contracts.md §20.1 R20-1.1、§20.9 第 3 条 ①②)。
 *
 * 为什么单独一个文件:`launcher.ts` 经 `install.ts` 传递引入 `io/net.ts`(还有 registry / provenance / sigstore),
 * 而 poke / hint / `__rsi --background` / 各前台 rsi 命令从入口起算的 import 传递闭包**不得**含网络出口(R20-1.1)。
 * rsi 要起 worker 就只能走这里:本文件只引用 `io/exec.ts`(`runSelf`)与类型,**不得**引用 `install.ts` / `registry.ts` /
 * `provenance.ts` / `launcher.ts` / `net.ts` / `home-fs.ts`(eslint 对本文件的授权块只放行 `runSelf`,不放行这些;
 * `test/update/self-spawn.test.ts` 另从多个入口起算断言闭包里没有它们)。
 *
 * 不做的事(契约 Q25-A):不定位、不校验 `current`,也不转发到 `current`——钩子触发时跑的就是被调用的这份包
 * (`target: self`,信任不高于当前进程自己)。所以这里没有「完整性校验」:`verifyInstalledTree` 留在 `install.ts`。
 *
 * 其余约束都在 `runSelf` 里:不经 shell、不继承 NODE_OPTIONS、环境走具名白名单;
 * `cwd` 固定为调用方给的仓库根(须为绝对、规范、真实目录);`PI_CODING_AGENT_DIR` 只传「已设置」这一事实(`KIT_RSI_PI_DIR_SET=1`)。
 */
import {
  RunSelfDeniedError,
  runSelf,
  type RunSelfRefusal,
  type RunSelfResult,
} from '../io/exec.js';

type Env = Readonly<Record<string, string | undefined>>;

/** worker 的参数是固定的单一形状;`__rsi` 只接受它(别的参数退出 2,§20.3) */
export const RSI_WORKER_ARGS: readonly string[] = ['__rsi', '--background'];

export interface RsiWorkerInput {
  /** 已校验的真实 HOME(runSelf 据此推出安装目录并强制子进程 HOME) */
  home: string;
  /** `realpath([rsi] repo)`:worker 的固定 cwd。是否等于配置值由调用方(`src/rsi/config.ts`)保证 */
  repo: string;
  /** 调用方环境(只取 `RUN_SELF_ENV_KEYS` 里的具名键;`PI_CODING_AGENT_DIR` 只折成存在性标志) */
  env: Env;
}

export interface RsiWorkerDeps {
  /** 测试注入:替换 runSelf(记录调用参数 / 模拟拒绝) */
  runSelf?: typeof runSelf;
  nodeVersion?: string;
}

export type RsiWorkerResult =
  | { spawned: true }
  | { spawned: false; why: RunSelfRefusal | 'denied' | 'threw' };

/**
 * 以 detached、stdio 丢弃的方式起一个 `__rsi --background` worker,不等待。**从不抛错、不写任何文件**:
 * 失败只返回 `spawned: false`,调用方(poke / 顺带调度)据此静默放弃,不改变用户命令的退出码。
 */
export function spawnRsiWorker(input: RsiWorkerInput, deps: RsiWorkerDeps = {}): RsiWorkerResult {
  let r: RunSelfResult;
  try {
    r = (deps.runSelf ?? runSelf)({
      home: input.home,
      target: { kind: 'self' },
      args: RSI_WORKER_ARGS,
      env: input.env,
      background: true,
      cwd: input.repo,
      ...(deps.nodeVersion !== undefined ? { nodeVersion: deps.nodeVersion } : {}),
    });
  } catch (e) {
    return { spawned: false, why: e instanceof RunSelfDeniedError ? 'denied' : 'threw' };
  }
  return r.spawned ? { spawned: true } : { spawned: false, why: r.reason };
}

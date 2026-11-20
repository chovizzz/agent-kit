/**
 * 增影响汇点登记表 `GROWTH_SINKS` 与运行期 pass 存在性检查 `hasSinkPass`(§21 V1 D1b-2;W0-30;W0-29 第 9 条 T5)。
 *
 * **登记表是架构门的输入**(`test/rsi/d1b2/growth-sinks-arch.test.ts` 用 AST 逐项校验;清单外出现同名导出、或 `src/rsi/**` 里有登记之外的增影响写出口 = 红)。三种形态:
 *  - `pass_param`:函数自己持有 `pass: GrowthPass` 形参(**最后一个、非可选**),函数体**第一条语句**(任何 `await`、锁断言、读写之前)是 `hasSinkPass(pass)` 检查,缺 / 伪 = 拒绝;
 *  - `port_claim`:函数不带 pass,经注入的 `GrowthClaimPort`(`candidate-ports.ts`,结构类型,零 stage 依赖)取钩子;端口缺 / 拒 = 拒绝,先于任何持久副作用
 *    (理由:`candidate-apply.ts` / `candidate-step.ts` / `commit.ts` 在 worker 类型闭包与严格入口闭包里,`GrowthPass` 等 stage 类型进不来;owner 2026-11-17 Q1);
 *  - `auth_port`:建仓边界,经 `BootstrapAuth.authorize` 取授权,先于 `mkdir` / `git init` / `mktree`。
 * **D1b-2 只验存在与品牌**(`minted` 登记);pass 的真实性、op 绑定、一次性与最终事实由 D2 的 `requireGrowth` 落实(C v2 §8)。
 * 本文件在 `canary/` 下(不在 `stage/`):不改 `growth.ts`(`c1-freeze` 钉其导出)、不改 stage 冻结清单;它是增影响汇点的同侧模块,**不得**进入 worker 的运行时闭包。
 */
import { isGrowthPass, type GrowthPass, type GrowthVerdict } from '../personal/stage/growth.js';

export type GrowthSinkMode = 'pass_param' | 'port_claim' | 'auth_port';

export interface GrowthSink {
  /** 仓库相对路径 */
  readonly file: string;
  /** 函数名 */
  readonly fn: string;
  readonly mode: GrowthSinkMode;
}

export const GROWTH_SINKS: readonly GrowthSink[] = Object.freeze([
  { file: 'src/rsi/canary/canary-writer.ts', fn: 'grantCanary', mode: 'pass_param' },
  { file: 'src/rsi/canary/admission-write.ts', fn: 'stepAdmission', mode: 'pass_param' },
  { file: 'src/rsi/personal/candidate-apply.ts', fn: 'applyEvent', mode: 'port_claim' },
  { file: 'src/rsi/personal/candidate-step.ts', fn: 'runPersonalStep', mode: 'port_claim' },
  { file: 'src/rsi/personal/commit-journal.ts', fn: 'continueBootstrap', mode: 'auth_port' },
]);

/**
 * 跨信任边界的 pass 存在性检查:非对象 / `null` / 缺品牌登记(强转造出的对象、拒绝值 `{ok:false}`)一律 `false`。
 * 先判 `typeof` / `null`(`isGrowthPass` 对非对象会抛:`'code' in null`);**不消费** pass(消费 = `requireGrowth`,D2)。
 */
export function hasSinkPass(x: unknown): x is GrowthPass {
  return typeof x === 'object' && x !== null && isGrowthPass(x as GrowthVerdict);
}

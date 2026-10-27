/**
 * 排除匹配的**唯一**实现(B3c-11 / R20-4.3;B4-0 冻结签名,B4a 从 `attribution.ts` 抽出、纯重构)。归属判定(`attribution.ts`)与采集策略(`l0/collect-policy.ts`)都调它。
 * 抽出来的 matcher **无条件**加载 `exclude_dirs`:`createAttributor` 只在索引非空时才加载(空索引下所有 key 本来就是 U),但判 cwd 不能这样——否则首次 L0 会漏掉全部目录排除。
 * 比较口径与 `signals/exclude.ts` 一致:最长已存在前缀的 realpath、`path.resolve` 折叠 `..`、去尾斜杠、不区分大小写、`(dev,ino)` 祖先匹配。
 * 规划侧闭包内:不得 import safe-fs / state-store / lock / snapshot。
 */
import type { RsiConfigOn } from './config.js';
import type { AttributionProbe } from './attribution.js';

export interface ExcludeMatcher {
  /** 项目根(绝对路径)是否落在任一 `exclude_dirs` 之内(含相等),或其目录名命中 `exclude_names` */
  matchesRoot(projectRoot: string): Promise<boolean>;
}

export async function createExcludeMatcher(
  config: RsiConfigOn,
  probe?: AttributionProbe,
): Promise<ExcludeMatcher> {
  void [config, probe];
  throw new Error('not implemented');
}

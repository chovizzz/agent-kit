/**
 * 采集策略(R20-4.4;B4-0 冻结签名,B4a 实现):自我排除(`withSelfExclusion`,stateDir = `<repo>/.state`)先于用户排除;用户排除用 `exclude-match.ts` 的 matcher
 * (无条件加载 `exclude_dirs`,索引为空也生效)。策略收紧由检查点比对运行绑定发现(`skipped_binding_changed`)。
 */
import type { ExcludePolicy } from '../../signals/exclude.js';
import type { AttributionProbe } from '../attribution.js';
import type { RsiConfigOn } from '../config.js';

export async function createRsiCollectPolicy(
  config: RsiConfigOn,
  stateDir: string,
  probe?: AttributionProbe,
): Promise<ExcludePolicy> {
  void [config, stateDir, probe];
  throw new Error('not implemented');
}

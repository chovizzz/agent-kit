/**
 * 采集策略(R20-4.4;B4-0 冻结签名,B4a 实现):自我排除(`withSelfExclusion`,stateDir = `<repo>/.state`)先于用户排除;用户排除用 `exclude-match.ts` 的 matcher
 * (无条件加载 `exclude_dirs`,索引为空也生效)。策略收紧由检查点比对运行绑定发现(`skipped_binding_changed`)。
 * cwd 为 null / 空 / 相对路径 → `unknown_project`(trace 自报的相对路径不能按采集器的 cwd 解释)。命中排除 → `excluded`;其余 `process`,`projectRoot` = `canonical(cwd)`。
 */
import * as path from 'node:path';
import { canonical, withSelfExclusion, type ExcludePolicy } from '../../signals/exclude.js';
import type { AttributionProbe } from '../attribution.js';
import type { RsiConfigOn } from '../config.js';
import { createExcludeMatcher } from '../exclude-match.js';

export async function createRsiCollectPolicy(
  config: RsiConfigOn,
  stateDir: string,
  probe?: AttributionProbe,
): Promise<ExcludePolicy> {
  const matcher = await createExcludeMatcher(config, probe);
  const inner: ExcludePolicy = {
    async decide(cwdHint) {
      if (cwdHint === null || cwdHint === '' || !path.isAbsolute(cwdHint)) {
        return { action: 'skip', reason: 'unknown_project' };
      }
      const root = await canonical(cwdHint);
      if (await matcher.matchesRoot(root)) return { action: 'skip', reason: 'excluded' };
      return { action: 'process', projectRoot: root };
    },
  };
  return withSelfExclusion(inner, stateDir);
}

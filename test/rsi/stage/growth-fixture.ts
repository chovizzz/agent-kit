/**
 * D1b-2 夹具:**造真 `GrowthPass`**——走真 `evaluateGrowth`(全绿读端口 + 真回合 `openBoth`),不伪造 `minted` 登记。
 * 增影响汇点(`grantCanary` / `stepAdmission`)的既有用例经它取 pass;强转对象 / `null` / 拒绝值只出现在负向用例里。
 */
import {
  evaluateGrowth,
  isGrowthPass,
  type GrowthPass,
  type GrowthReq,
} from '../../../src/rsi/personal/stage/growth.js';
import { STAGE_ALL, cand, openBoth, readers } from './c1-fixture.js';

/** 一个由真 `evaluateGrowth` 铸造的 pass(op 缺省 `grant`;候选类 op 带夹具候选) */
export async function mintTestPass(op: GrowthReq['op'] = 'grant'): Promise<GrowthPass> {
  const w = await openBoth();
  const req: GrowthReq =
    op === 'shadow_to_canary' || op === 'grant' || op === 'deploy_inject'
      ? { op, cand: cand() }
      : ({ op } as GrowthReq);
  const v = await evaluateGrowth(w.round, req, readers(), STAGE_ALL);
  if (!isGrowthPass(v))
    throw new Error(`fixture: expected a minted pass, got ${JSON.stringify(v)}`);
  return v;
}

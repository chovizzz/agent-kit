/**
 * judge 写 `rule_sha256`(⑨A):评审结论绑定评审时的规则文本。
 * 之前只有 promote 的端到端用例间接覆盖这条;这里直接断言 judge 的落盘记录(A24 的 L3 变异靠它变红)。
 */
import * as path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ProposalSchema } from '../../src/contracts/proposal.js';
import { readText } from '../../src/io/read-fs.js';
import { runJudge } from '../../src/judge/run.js';
import { ruleSha256 } from '../../src/lifecycle/checks.js';
import { RUN_ID, makeStubs, newWork, redactor, writeProposal } from './helpers.js';

describe('judge 记录里的 rule_sha256', () => {
  it('judge 成功后记录带 rule_sha256,且等于规则文件当前的 ruleSha256(正向对照:改一个字就对不上)', async () => {
    const w = await newWork();
    const file = await writeProposal(w, { layer: 'team' });
    const s = makeStubs();
    await runJudge(
      { io: w.io, redactor, backends: s.backends },
      { runId: RUN_ID, dry: false, maxCalls: 5 },
    );
    const y = ProposalSchema.parse(parse(await readText(file)));
    const ruleText = await readText(path.join(w.runDir, 'rules', 'team', 'new-rule-a.md'));
    expect(y.judge?.rule_sha256).toBe(ruleSha256(ruleText));
    expect(y.judge?.rule_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ruleSha256(ruleText.replace('CANARY_DO_ok1', 'CANARY_DO_ok1 多一句'))).not.toBe(
      y.judge?.rule_sha256,
    );
  });
});

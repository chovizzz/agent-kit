/**
 * R20-A4(R20-16.18):LLM 路径(kit 经 backends 调用)从 A4 起显式写 `reflector.provenance: spawned`;
 * `stub` 与真调用都一样。字段缺失的旧提案按原规则判(见 test/guards/a4-provenance.test.ts)。
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ProposalSchema } from '../../src/contracts/proposal.js';
import { readText } from '../../src/io/read-fs.js';
import { runReflect } from '../../src/reflect/run.js';
import { setupEnv } from '../fixtures/reflect/world.js';

describe('R20-16.18 LLM 路径显式写 provenance: spawned', () => {
  it('暂存的提案 yaml 与返回的合并结果里都有 provenance=spawned,且不是 session_declared', async () => {
    const env = await setupEnv();
    const r = await runReflect(env.deps, env.opts);
    expect(r.report.outcome).toBe('staged');
    const id = r.staged?.proposalIds[0] as string;
    const text = await readText(
      path.join(env.w.state, 'reflect', 'run-test-1', 'proposals', `${id}.yaml`),
    );
    const p = ProposalSchema.parse(parseYaml(text));
    expect(p.reflector.provenance).toBe('spawned');
    expect(p.reflector.prompt_id).toBeDefined(); // LLM 路径仍有 prompt 身份(ingest 路径没有)
    expect(text).toContain('provenance: spawned');
  });
});

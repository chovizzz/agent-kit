import { classifySignals } from '../../../src/reflect/classify.js';
import { buildClusters } from '../../../src/reflect/cluster.js';
import { buildEvidencePack } from '../../../src/reflect/evidence.js';
import { loadSignals } from '../../../src/reflect/load.js';
import type { Signal } from '../../../src/contracts/signal.js';
import type { ReflectorProposalDraft } from '../../../src/contracts/reflect.js';
import { ReflectorOutputSchema } from '../../../src/contracts/reflect.js';
import type { MergeInput } from '../../../src/reflect/merge.js';
import { PROMPT_TEMPLATE_SHA256 } from '../../../src/reflect/prompt/v1.js';
import {
  allTeamKeys,
  atomInfo,
  draft,
  newWork,
  putSignals,
  testRedactor,
  worldSignals,
} from './world.js';

export async function worldPlan(signals: Signal[] = worldSignals()) {
  const w = await newWork('rl-plan-');
  await putSignals(w.io, signals);
  const { signals: loaded } = await loadSignals(w.io, testRedactor());
  const clusters = buildClusters(classifySignals(loaded));
  const pack = buildEvidencePack(clusters, [atomInfo()]);
  return { w, loaded, clusters, pack };
}

export function aliasFor(
  pack: { items: { alias: string; signal: Signal }[] },
  text: string,
): string {
  const it = pack.items.find((i) => i.signal.excerpt_redacted === text);
  if (!it) throw new Error(`没有证据 ${text}`);
  return it.alias;
}

export function parsedDraft(over: Record<string, unknown> = {}): ReflectorProposalDraft {
  return ReflectorOutputSchema.parse({ proposals: [draft(over)] })
    .proposals[0] as ReflectorProposalDraft;
}

export function mergeInput(
  plan: Awaited<ReturnType<typeof worldPlan>>,
  drafts: ReflectorProposalDraft[],
  over: Partial<MergeInput> = {},
): MergeInput {
  return {
    drafts,
    items: plan.pack.items,
    clusters: plan.clusters,
    owner: '@tester',
    now: new Date('2026-10-12T08:00:00Z'),
    reflector: {
      provider: 'glm',
      vendor: 'zhipu',
      model: 'stub-model',
      run_id: 'run-test-1',
      prompt_id: 'reflect-v1',
      prompt_sha256: PROMPT_TEMPLATE_SHA256,
      input_digest: `sha256:${'0'.repeat(64)}`,
      stub: true,
    },
    usedProposalIds: new Set(),
    teamProjectKeys: allTeamKeys(plan.loaded),
    ...over,
  };
}

import type { Adapter, OutFile, RenderInput, RenderOutput } from '../../src/contracts/render.js';
import type { ResolvedAtom } from '../../src/contracts/merge.js';
import type { Layer } from '../../src/contracts/atom.js';
import type { RenderAgentId } from '../../src/contracts/common.js';
import { emptyReport } from '../../src/render/report.js';
import { renderManagedBlock } from '../../src/render/managed-block.js';

const SHA = '0'.repeat(64);

export function resolved(id: string, layer: Layer = 'org', coreEligible = true): ResolvedAtom {
  return {
    atom: {
      fm: {
        id,
        title: `title ${id}`,
        layer,
        strength: 'should',
        kind: 'practice',
        volatility: 'stable',
        status: 'advisory',
        owner: '@o',
        created: '2026-10-01',
        review_by: '2027-01-01',
        evidence: [{ type: 'memory', ref: 'r', excerpt: 'e' }],
        verifier: { type: 'none' },
      },
      body: { do: `做 ${id}`, why: '因为', verify: '看' },
      bodyBytes: 10,
      sha256: SHA,
      sourcePath: `atoms/${id}.md`,
    },
    layer,
    coreEligible,
    replaced: [],
  } as ResolvedAtom;
}

export function inputOf(...atoms: ResolvedAtom[]): RenderInput {
  return { resolved: atoms, skills: [], agents: [], kitVersion: '1.2.3', channel: 'canary' };
}

export function owned(
  agent: RenderAgentId,
  relPath: string,
  content: string,
  ids: string[] = [],
): OutFile {
  return {
    agent,
    target: 'home',
    relPath,
    content,
    mode: 'owned',
    atomIds: ids,
    atomBytes: Object.fromEntries(ids.map((i) => [i, 3])),
    confidence: 'assumed',
  };
}

export function block(
  agent: RenderAgentId,
  relPath: string,
  blockId: string,
  body: string,
  ids: string[] = [],
): OutFile {
  return {
    agent,
    target: 'project',
    relPath,
    content: renderManagedBlock(blockId, body),
    mode: 'managed-block',
    atomIds: ids,
    atomBytes: Object.fromEntries(ids.map((i) => [i, 3])),
    confidence: 'documented',
  };
}

export function out(files: OutFile[]): RenderOutput {
  return { files, report: emptyReport() };
}

export function fakeAdapter(agent: RenderAgentId, files: (i: RenderInput) => OutFile[]): Adapter {
  return { agent, testedVersions: [], renderRules: (i) => out(files(i)) };
}

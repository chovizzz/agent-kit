import type { Atom, Layer } from '../../src/contracts/atom.js';

const SHA = '0'.repeat(64);

export interface AtomOpts {
  strength?: 'must' | 'should';
  overrides?: string[];
  disables?: string[];
  path?: string;
  status?: Atom['fm']['status'];
}

/** 合成原子(不经文件系统);must 自带 verifier,满足 schema 的 must 约束。 */
export function atom(id: string, layer: Layer, opts: AtomOpts = {}): Atom {
  const strength = opts.strength ?? 'should';
  return {
    fm: {
      id,
      title: `title ${id}`,
      layer,
      strength,
      kind: 'practice',
      volatility: 'stable',
      status: opts.status ?? 'advisory',
      owner: '@o',
      created: '2026-10-01',
      review_by: '2027-01-01',
      evidence: [{ type: 'memory', ref: 'r', excerpt: 'e' }],
      verifier: strength === 'must' ? { type: 'replay', ref: 'cases/x/' } : { type: 'none' },
      ...(opts.overrides ? { overrides: opts.overrides } : {}),
      ...(opts.disables ? { disables: opts.disables } : {}),
    },
    body: { do: `做 ${id}`, why: '因为', verify: '看' },
    bodyBytes: 20,
    sha256: SHA,
    sourcePath: opts.path ?? `rules/${layer}/${id}.md`,
  } as Atom;
}

export function ids(result: { atoms: { atom: Atom }[] }): string[] {
  return result.atoms.map((a) => a.atom.fm.id);
}

export function codes(result: { diagnostics: { code: string }[] }): string[] {
  return result.diagnostics.map((d) => d.code);
}

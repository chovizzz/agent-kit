import { BudgetConfigSchema } from '../../src/contracts/config.js';
import type { BudgetConfig } from '../../src/contracts/config.js';
import type { RenderAgentId } from '../../src/contracts/common.js';
import type { OutFile } from '../../src/contracts/render.js';

export interface FileOpts {
  /** 原子 id → 该原子正文在本文件里的字节数 */
  atoms?: Record<string, number>;
  target?: 'home' | 'project';
  mode?: 'owned' | 'managed-block';
  conditional?: string;
  sourceRefs?: string[];
}

/** 合成输出文件(预算只看 content / atomBytes / conditional / sourceRefs / target)。 */
export function out(
  agent: RenderAgentId,
  relPath: string,
  content: string,
  opts: FileOpts = {},
): OutFile {
  const atoms = opts.atoms ?? {};
  return {
    agent,
    target: opts.target ?? 'home',
    relPath,
    content,
    mode: opts.mode ?? 'owned',
    atomIds: Object.keys(atoms),
    atomBytes: atoms,
    confidence: 'documented',
    ...(opts.conditional ? { conditional: opts.conditional } : {}),
    ...(opts.sourceRefs ? { sourceRefs: opts.sourceRefs } : {}),
  };
}

/** 恰好 n 字节的 ASCII 文本(单行、无换行)。 */
export const ascii = (n: number): string => 'a'.repeat(n);

export function cfg(partial: Record<string, unknown>): BudgetConfig {
  return BudgetConfigSchema.parse(partial);
}

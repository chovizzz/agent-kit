/**
 * 规则原子的挑选与格式化(kimi 渲染器内部使用)。
 *
 * 注意:adapters/codex/atoms.ts 有一份相同的实现(B07)。各渲染器自包含(块边界不允许共享目录),
 * 由 test/golden/kimi/kimi.test.ts 里的"无 paths 时同输入同字节"断言防止两份漂移。
 */
import { LAYER_RANK } from '../../src/contracts/atom.js';
import type { Layer } from '../../src/contracts/atom.js';
import type { RenderInput } from '../../src/contracts/render.js';

export const AGENT = 'kimi' as const;

export interface PickedAtom {
  id: string;
  layer: Layer;
  strength: 'must' | 'should';
  title: string;
  /** 有值 = 带路径作用域的原子 */
  paths: readonly string[] | undefined;
  /** advisory 原子(只在 canary 渠道渲染),标题带〔试行〕前缀(设计 §5.3) */
  trial: boolean;
  do: string;
  why: string;
  verify: string;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 挑出本渲染器要渲染的原子,并排成稳定顺序(层序 → must 先 → id 字节序)。
 * - coreEligible=false(P0:personal 层)一律跳过;
 * - applies_to 缺省视为 [all];
 * - 状态:active 全渠道;advisory 只在 canary 渠道;proposed/deprecated/retired 不渲染
 *   (proposed 是否渲染设计未明说,按生命周期推定为不渲染,见汇报「新发现的歧义」)。
 */
export function pickAtoms(input: RenderInput): PickedAtom[] {
  const picked: PickedAtom[] = [];
  for (const r of input.resolved) {
    if (!r.coreEligible || r.layer === 'personal') continue;
    const fm = r.atom.fm;
    const applies = fm.applies_to ?? ['all'];
    if (!applies.includes('all') && !applies.includes(AGENT)) continue;
    let trial = false;
    if (fm.status === 'advisory' && input.channel === 'canary') trial = true;
    else if (fm.status !== 'active') continue;
    picked.push({
      id: fm.id,
      layer: r.layer,
      strength: fm.strength,
      title: fm.title,
      paths: fm.paths,
      trial,
      do: r.atom.body.do,
      why: r.atom.body.why,
      verify: r.atom.body.verify,
    });
  }
  return picked.sort(
    (a, b) =>
      LAYER_RANK[a.layer] - LAYER_RANK[b.layer] ||
      (a.strength === b.strength ? 0 : a.strength === 'must' ? -1 : 1) ||
      cmp(a.id, b.id),
  );
}

/** 适用于本 agent、但因状态/渠道没有渲染的原子(报告用):advisory 在 stable、proposed/deprecated/retired。 */
export function skippedByStatus(input: RenderInput): { id: string; reason: string }[] {
  const out: { id: string; reason: string }[] = [];
  for (const r of input.resolved) {
    if (!r.coreEligible || r.layer === 'personal') continue;
    const fm = r.atom.fm;
    const applies = fm.applies_to ?? ['all'];
    if (!applies.includes('all') && !applies.includes(AGENT)) continue;
    if (fm.status === 'active') continue;
    if (fm.status === 'advisory' && input.channel === 'canary') continue;
    out.push({
      id: fm.id,
      reason: `状态 ${fm.status} 在 ${input.channel} 渠道不渲染(advisory 只到 canary;proposed/deprecated/retired 不渲染)`,
    });
  }
  return out.sort((a, b) => cmp(a.id, b.id));
}

/** 行内代码:反引号数量取比内容里最长连续反引号多一个。 */
export function codeSpan(s: string): string {
  const longest = Math.max(0, ...Array.from(s.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

/**
 * paths 原子的降级前缀:kimi 的 AGENTS.md 没有路径作用域机制,只能把作用范围写成正文第一行文字。
 * 这是文字约束(靠模型遵守),不是机制;是否有效待探针(kimi-paths-prefix-effect)。
 */
export function pathsPrefix(paths: readonly string[]): string {
  return `仅在处理 ${paths.map(codeSpan).join('、')} 时适用。`;
}

/** 一个原子在文件里的段落(不含末尾换行);带 paths 的原子在标题后加降级前缀。 */
export function formatAtom(a: PickedAtom): string {
  const heading = `### [${a.strength}] ${a.trial ? '〔试行〕' : ''}${a.title}`;
  const prefix = a.paths !== undefined ? [pathsPrefix(a.paths)] : [];
  return [
    heading,
    ...prefix,
    `**做**: ${a.do}`,
    `**为什么**: ${a.why}`,
    `**怎么验**: ${a.verify}`,
  ].join('\n\n');
}

export interface Section {
  text: string;
  /** 该段落的 UTF-8 字节数(预算按原子 id 去重用) */
  bytes: number;
}

export function sectionOf(a: PickedAtom): Section {
  const text = formatAtom(a);
  return { text, bytes: Buffer.byteLength(text, 'utf8') };
}

export interface LayerBody {
  /** 文件/块体正文 */
  body: string;
  atomIds: string[];
  atomBytes: Record<string, number>;
}

/** 把同一层的若干原子拼成 `## agent-kit 规则(<layer> 层)` 开头的正文;没有原子时 body 为空串。 */
export function layerBody(layer: Layer, atoms: readonly PickedAtom[]): LayerBody {
  if (atoms.length === 0) return { body: '', atomIds: [], atomBytes: {} };
  const atomBytes: Record<string, number> = {};
  const parts: string[] = [`## agent-kit 规则(${layer} 层)`];
  for (const a of atoms) {
    const s = sectionOf(a);
    atomBytes[a.id] = s.bytes;
    parts.push(s.text);
  }
  return { body: parts.join('\n\n'), atomIds: atoms.map((a) => a.id), atomBytes };
}

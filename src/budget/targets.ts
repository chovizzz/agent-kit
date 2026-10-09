/**
 * 预算的度量部分:字节/行数口径、哪些输出文件算「某目标的常驻产物」、按原子 id 去重。
 * 口径定在 docs/contracts.md 第 6 节;这里只实现,不改口径。
 */
import type { OutFile } from '../contracts/render.js';

/** 字节 = UTF-8 编码后的字节数(中文 3 字节)。含托管块标记行(agent 实际读到整个文件)。 */
export function countBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 行数 = `\n` 的个数;末尾无换行时再 +1;空串为 0。CRLF 的 `\r` 不额外计行。 */
export function countLines(text: string): number {
  if (text === '') return 0;
  let n = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return text.endsWith('\n') ? n : n + 1;
}

/**
 * 是否计入预算:`conditional` 非空的文件不计(待探针验证,不得当事实);
 * 纯技能/子代理文件(有 sourceRefs 且不含规则原子)按需加载、不常驻,同样不计。
 */
export function countsTowardBudget(f: OutFile): boolean {
  if (f.conditional !== undefined) return false;
  if ((f.sourceRefs?.length ?? 0) > 0 && f.atomIds.length === 0) return false;
  return true;
}

export interface Measured {
  bytes: number;
  lines: number;
  /** 参与求和的来源名(输出文件 relPath;项目链为 `projectChain#i`) */
  files: string[];
  /** 出现在多个来源里、只计一次的原子 id(已排序) */
  dedupedAtomIds: string[];
  /** 每个原子 id 的计入字节(取各处最大值,保守) */
  atomBytes: Map<string, number>;
}

const byteCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 度量一组文件:字节 = Σ 文件字节 − Σ_{原子 id 出现 k>1 次}(各处 atomBytes 之和 − 其中最大值);
 * 行数不去重(OutFile 没有 atomLines,保守多算)。`chain` 是 Codex 项目链各层 AGENTS.md 的文本。
 */
export function measure(files: readonly OutFile[], chain: readonly string[] = []): Measured {
  let bytes = 0;
  let lines = 0;
  const names: string[] = [];
  const seen = new Map<string, number[]>();
  for (const f of files) {
    bytes += countBytes(f.content);
    lines += countLines(f.content);
    names.push(f.relPath);
    for (const id of f.atomIds) {
      seen.set(id, [...(seen.get(id) ?? []), f.atomBytes[id] ?? 0]);
    }
  }
  chain.forEach((text, i) => {
    bytes += countBytes(text);
    lines += countLines(text);
    names.push(`projectChain#${i}`);
  });
  const deduped: string[] = [];
  const atomBytes = new Map<string, number>();
  for (const [id, sizes] of seen) {
    const max = Math.max(...sizes);
    atomBytes.set(id, max);
    if (sizes.length > 1) {
      deduped.push(id);
      bytes -= sizes.reduce((s, x) => s + x, 0) - max;
    }
  }
  return { bytes, lines, files: names, dedupedAtomIds: deduped.sort(byteCmp), atomBytes };
}

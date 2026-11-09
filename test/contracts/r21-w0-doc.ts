/**
 * §21.24 W0 订正的文档解析器(`r21-w0.test.ts` 与 `r21-clause-coverage.test.ts` 共用)。
 * 防「静默变空」:每个解析器在拿到 0 条时抛错,不返回空表;解析器自身的反向对照在 `r21-w0.test.ts`。
 */
import { readText } from '../../src/io/read-fs.js';

export const CONTRACTS_PATH = new URL('../../docs/contracts.md', import.meta.url).pathname;
export const FULL = await readText(CONTRACTS_PATH);
export const SEC24 = FULL.slice(FULL.indexOf('### 21.24 '));

/** 标记注释之后的第一张表的数据行(去掉表头与分隔行),每行按 `|` 切成去空白的单元格 */
export function tableAfter(md: string, marker: string): string[][] {
  const at = md.indexOf(marker);
  if (at < 0) throw new Error(`找不到标记 ${marker}`);
  if (md.indexOf(marker, at + marker.length) >= 0) throw new Error(`标记出现多次 ${marker}`);
  const lines = md.slice(at + marker.length).split('\n');
  const rows: string[][] = [];
  let started = false;
  for (const l of lines) {
    if (l.startsWith('|')) {
      started = true;
      rows.push(
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    } else if (started) break;
  }
  const data = rows.slice(2); // 表头 + 分隔行
  if (data.length === 0) throw new Error(`标记 ${marker} 之后的表是空的`);
  return data;
}

/** 单元格里所有反引号 token */
export const ticks = (cell: string): string[] =>
  [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);

/** 条款分配表:条款号 → 首期(重复 / 空表都抛错) */
export function clausePhaseMap(md: string = SEC24): Map<string, string> {
  const out = new Map<string, string>();
  for (const [cell, phase] of tableAfter(md, '<!-- W0-CLAUSE-PHASE -->')) {
    for (const id of (cell ?? '')
      .split('、')
      .map((x) => x.trim())
      .filter((x) => x !== '')) {
      if (!/^R21-\d+\.\d+a?$/.test(id)) throw new Error(`条款号格式不对:${id}`);
      if (out.has(id)) throw new Error(`条款 ${id} 重复分配`);
      out.set(id, phase as string);
    }
  }
  return out;
}

/** 契约正文里形如 `- R21-x.y `[Vn]`` 的条款行:条款号 → 期标签(R21-1 … R21-17 之内;不含表格里的提及) */
export function clauseTags(md: string = FULL): Map<string, string> {
  const out = new Map<string, string>();
  const start = md.indexOf('## 21. 自主 RSI 契约');
  const body = md.slice(start, md.indexOf('### 21.24 '));
  for (const m of body.matchAll(/^- (R21-\d+\.\d+a?) `\[([^\]]+)\]`/gm)) {
    if (out.has(m[1] as string)) throw new Error(`条款 ${m[1]} 出现多次`);
    out.set(m[1] as string, m[2] as string);
  }
  if (out.size === 0) throw new Error('没有解析到任何条款');
  return out;
}

/**
 * 托管块:写入「不归本套件独占」的文件时,只改 begin/end 两行标记之间的内容。
 *
 *   <!-- agent-kit:begin id=<kebab> sha256=<64 位十六进制> -->
 *   <块体:canonicalText 规范化,空体合法>
 *   <!-- agent-kit:end -->
 *
 * 口径(B06 定,B07/B08/P2 sync 共用):
 * - sha256 只覆盖「块体」(两行标记之间的原文,不含标记行)。块体被手改而标记行没动 ⇒ drifted。
 *   这是「防意外、不防恶意」:有人改了块体并同步重算 sha 时无法发现(内容指纹方案的固有边界)。
 * - 标记行必须严格匹配;凡是「形似标记行」(整行以 `<!-- agent-kit:begin|end` 开头,允许缩进)
 *   但不严格匹配的,一律视为 corrupt 并拒绝写入——误判的代价是「拒绝并让人修」,
 *   漏判的代价是「再追加一个重复块」。CRLF 行尾的标记行同理按 corrupt 处理。
 * - end 标记不带 id,按出现顺序与最近的 begin 配对。同文件可有多个不同 id 的块;
 *   其它 id 的块对本次操作而言是「块外内容」,原样保留。
 * - 开头的 BOM 视为块外内容:解析时剥掉、写回时原样放回。
 * - corrupt(只有 begin、只有 end、嵌套 begin、同 id 重复、标记形似但不严格)时一律拒绝,**绝不追加**。
 * - 块外内容(含换行风格)逐字节保持不变;只有「无标记」时才在末尾追加,且追加前不改动原文。
 */
import { createHash } from 'node:crypto';
import { canonicalText } from '../io/canonical-text.js';
import { KEBAB_RE } from '../contracts/common.js';

export const BEGIN_PREFIX = '<!-- agent-kit:begin';
export const END_MARKER = '<!-- agent-kit:end -->';
const BEGIN_RE = /^<!-- agent-kit:begin id=([a-z0-9]+(?:-[a-z0-9]+)*) sha256=([0-9a-f]{64}) -->$/;
const MARKER_LIKE_RE = /^\s*<!--\s*agent-kit:(?:begin|end)\b/;
const BOM = '\uFEFF';

export type ManagedBlockErrorCode =
  | 'INVALID_ID'
  | 'BODY_CONTAINS_MARKER'
  | 'MARKER_MALFORMED'
  | 'BEGIN_WITHOUT_END'
  | 'END_WITHOUT_BEGIN'
  | 'BEGIN_NESTED'
  | 'DUPLICATE_ID'
  | 'DRIFTED';

export class ManagedBlockError extends Error {
  constructor(
    readonly code: ManagedBlockErrorCode,
    message: string,
    /** 1 起始的行号(corrupt / drifted 时给出) */
    readonly line?: number,
  ) {
    super(message);
    this.name = 'ManagedBlockError';
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function assertId(id: string): void {
  if (!KEBAB_RE.test(id)) {
    throw new ManagedBlockError('INVALID_ID', `托管块 id 必须是 kebab-case:${JSON.stringify(id)}`);
  }
}

/** 块体经 canonicalText 规范化(LF、末尾恰一个换行;空体保持空)。 */
export function canonicalBody(body: string): string {
  return canonicalText(body);
}

/** 生成一个完整的托管块文本(以换行结尾)。块体里出现标记行会抛错。 */
export function renderManagedBlock(id: string, body: string): string {
  assertId(id);
  const canon = canonicalBody(body);
  if (canon !== '') {
    for (const line of canon.split('\n')) {
      if (MARKER_LIKE_RE.test(line)) {
        throw new ManagedBlockError('BODY_CONTAINS_MARKER', '块体不得包含托管块标记行');
      }
    }
  }
  return `${BEGIN_PREFIX} id=${id} sha256=${sha256Hex(canon)} -->\n${canon}${END_MARKER}\n`;
}

export interface ParsedBlock {
  id: string;
  storedSha: string;
  actualSha: string;
  body: string;
  /** begin 行首在(去 BOM 后)文本中的偏移 */
  start: number;
  /** end 行末(含其换行,若有)的偏移 */
  end: number;
  /** begin 行的 1 起始行号 */
  line: number;
}

export type ParseResult =
  | { ok: true; blocks: ParsedBlock[] }
  | { ok: false; code: ManagedBlockErrorCode; line: number; message: string };

interface Line {
  text: string;
  start: number;
  /** 含换行的行末偏移 */
  end: number;
}

function* splitLines(text: string): Generator<Line> {
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const stop = nl === -1 ? text.length : nl;
    const end = nl === -1 ? text.length : nl + 1;
    yield { text: text.slice(pos, stop), start: pos, end };
    pos = end;
  }
}

/** 解析(已去 BOM 的)文本里的全部托管块;结构不合法时返回 ok:false。 */
export function parseManagedBlocks(text: string): ParseResult {
  const blocks: ParsedBlock[] = [];
  const seen = new Set<string>();
  let open: { id: string; sha: string; start: number; bodyStart: number; line: number } | undefined;
  let lineNo = 0;
  for (const ln of splitLines(text)) {
    lineNo += 1;
    const begin = BEGIN_RE.exec(ln.text);
    if (begin) {
      if (open) {
        return {
          ok: false,
          code: 'BEGIN_NESTED',
          line: lineNo,
          message: `第 ${lineNo} 行:begin 出现在第 ${open.line} 行的 begin 之后、end 之前`,
        };
      }
      const id = begin[1] as string;
      if (seen.has(id)) {
        return {
          ok: false,
          code: 'DUPLICATE_ID',
          line: lineNo,
          message: `第 ${lineNo} 行:托管块 id 重复:${id}`,
        };
      }
      seen.add(id);
      open = {
        id,
        sha: begin[2] as string,
        start: ln.start,
        bodyStart: ln.end,
        line: lineNo,
      };
      continue;
    }
    if (ln.text === END_MARKER) {
      if (!open) {
        return {
          ok: false,
          code: 'END_WITHOUT_BEGIN',
          line: lineNo,
          message: `第 ${lineNo} 行:end 标记前没有对应的 begin`,
        };
      }
      const body = text.slice(open.bodyStart, ln.start);
      blocks.push({
        id: open.id,
        storedSha: open.sha,
        actualSha: sha256Hex(body),
        body,
        start: open.start,
        end: ln.end,
        line: open.line,
      });
      open = undefined;
      continue;
    }
    if (MARKER_LIKE_RE.test(ln.text)) {
      return {
        ok: false,
        code: 'MARKER_MALFORMED',
        line: lineNo,
        message: `第 ${lineNo} 行:形似托管块标记但格式不严格(缩进、CRLF、sha256 非 64 位十六进制等)`,
      };
    }
  }
  if (open) {
    return {
      ok: false,
      code: 'BEGIN_WITHOUT_END',
      line: open.line,
      message: `第 ${open.line} 行:begin 之后没有 end`,
    };
  }
  return { ok: true, blocks };
}

export type InspectResult =
  | { state: 'file-missing' }
  /** 文件存在但没有该 id 的块(含「完全没有标记」与「只有其它 id 的块」) */
  | { state: 'block-missing'; foreignIds: string[] }
  | { state: 'intact' | 'drifted'; block: ParsedBlock; before: string; after: string; bom: boolean }
  | { state: 'corrupt'; code: ManagedBlockErrorCode; line: number; message: string };

function stripBom(text: string): { text: string; bom: boolean } {
  return text.startsWith(BOM) ? { text: text.slice(1), bom: true } : { text, bom: false };
}

/** 判断 existing(undefined = 文件不存在)里 id 对应托管块的状态。 */
export function inspectManagedBlock(existing: string | undefined, id: string): InspectResult {
  assertId(id);
  if (existing === undefined) return { state: 'file-missing' };
  const { text, bom } = stripBom(existing);
  const parsed = parseManagedBlocks(text);
  if (!parsed.ok) {
    return { state: 'corrupt', code: parsed.code, line: parsed.line, message: parsed.message };
  }
  const block = parsed.blocks.find((b) => b.id === id);
  if (!block) {
    return { state: 'block-missing', foreignIds: parsed.blocks.map((b) => b.id) };
  }
  return {
    state: block.storedSha === block.actualSha ? 'intact' : 'drifted',
    block,
    before: text.slice(0, block.start),
    after: text.slice(block.end),
    bom,
  };
}

export interface ApplyOptions {
  /**
   * 块体已被手改(drifted)时怎么办。**必填**:'refuse' 抛 DRIFTED;'overwrite' 覆盖。
   * 写 out/ 时不会遇到(out/ 是整树重建,不走 apply);P2 sync 写真实文件时由调用方显式选择。
   */
  onDrift: 'refuse' | 'overwrite';
}

export type ApplyAction = 'created' | 'appended' | 'replaced' | 'unchanged';

export interface ApplyResult {
  content: string;
  changed: boolean;
  action: ApplyAction;
  /** 覆盖了被手改的块体(仅 onDrift='overwrite' 且确实 drifted 时为 true) */
  overwroteDrift: boolean;
}

/**
 * 把 body 写进 existing 的托管块里,返回新文件内容(不落盘)。
 * - 文件不存在 ⇒ 只含这个块。
 * - 文件存在、没有该 id 的块 ⇒ 原文逐字节保留,末尾追加(空行隔开)一个块。
 * - 有 intact 块 ⇒ 仅替换 begin..end 两行(含);块外字节不变;幂等。
 * - drifted ⇒ 按 onDrift;corrupt ⇒ 一律抛错,不追加。
 */
export function applyManagedBlock(
  existing: string | undefined,
  id: string,
  body: string,
  opts: ApplyOptions,
): ApplyResult {
  const block = renderManagedBlock(id, body);
  const info = inspectManagedBlock(existing, id);
  switch (info.state) {
    case 'file-missing':
      return { content: block, changed: true, action: 'created', overwroteDrift: false };
    case 'corrupt':
      throw new ManagedBlockError(info.code, info.message, info.line);
    case 'block-missing': {
      const current = existing as string;
      if (current === '' || current === BOM) {
        return {
          content: current + block,
          changed: true,
          action: 'appended',
          overwroteDrift: false,
        };
      }
      const sep = current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
      return {
        content: `${current}${sep}${block}`,
        changed: true,
        action: 'appended',
        overwroteDrift: false,
      };
    }
    case 'drifted':
    case 'intact': {
      if (info.state === 'drifted' && opts.onDrift === 'refuse') {
        throw new ManagedBlockError(
          'DRIFTED',
          `第 ${info.block.line} 行起的托管块 ${id} 块体被手改过(sha256 与块体不符)`,
          info.block.line,
        );
      }
      const content = `${info.bom ? BOM : ''}${info.before}${block}${info.after}`;
      const changed = content !== existing;
      return {
        content,
        changed,
        action: changed ? 'replaced' : 'unchanged',
        overwroteDrift: info.state === 'drifted',
      };
    }
  }
}

/** 取出所有托管块之外的内容(去 BOM);corrupt 时抛错。供「块外内容不被覆盖」的断言用。 */
export function outsideContent(existing: string): string {
  const { text } = stripBom(existing);
  const parsed = parseManagedBlocks(text);
  if (!parsed.ok) throw new ManagedBlockError(parsed.code, parsed.message, parsed.line);
  let out = '';
  let pos = 0;
  for (const b of parsed.blocks) {
    out += text.slice(pos, b.start);
    pos = b.end;
  }
  return out + text.slice(pos);
}

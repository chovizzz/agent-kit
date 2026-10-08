/**
 * 独占文件头(设计 §4.1):本套件独占的文件整体写入,头一行写「生成文件,勿手改;源:agent-kit-core@<版本>」。
 * 注释语法按扩展名选;.json 没有注释语法,不加头(由调用方在报告里说明)。
 * Markdown 若以 frontmatter 开头,头放在 frontmatter 之后(frontmatter 必须是文件第一行)。
 * 幂等:已有本头(任何版本)就原位换成当前版本,不重复追加。
 */
const BOM = '\uFEFF';
export const OWNED_HEADER_TEXT = '生成文件,勿手改;源:agent-kit-core@';
const VERSION_RE = /^[0-9A-Za-z._+-]+$/;

const MD_EXT = new Set(['md', 'mdx', 'markdown']);
const HASH_EXT = new Set(['yml', 'yaml', 'toml', 'jsonc']);

type Syntax = 'html' | 'hash';

function extOf(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** 该路径用哪种注释语法;undefined = 不能加头。 */
export function headerSyntax(relPath: string): Syntax | undefined {
  const ext = extOf(relPath);
  if (MD_EXT.has(ext)) return 'html';
  if (HASH_EXT.has(ext)) return 'hash';
  return undefined;
}

function wrap(syntax: Syntax, version: string): string {
  const text = `${OWNED_HEADER_TEXT}${version}`;
  return syntax === 'html' ? `<!-- ${text} -->` : `# ${text}`;
}

const OLD_HEADER_RE: Record<Syntax, RegExp> = {
  html: new RegExp(`^<!-- ${OWNED_HEADER_TEXT}[0-9A-Za-z._+-]+ -->$`),
  hash: new RegExp(`^# ${OWNED_HEADER_TEXT}[0-9A-Za-z._+-]+$`),
};

/** frontmatter 结束后的偏移(含其换行);没有闭合的 frontmatter 视为没有 frontmatter。 */
function frontmatterEnd(text: string): number {
  if (!text.startsWith('---\n')) return 0;
  let pos = 4;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const stop = nl === -1 ? text.length : nl;
    if (text.slice(pos, stop) === '---') return nl === -1 ? text.length : nl + 1;
    if (nl === -1) break;
    pos = nl + 1;
  }
  return 0;
}

export interface HeaderResult {
  content: string;
  /** false = 该路径不支持头(.json 等),content 原样返回 */
  applied: boolean;
}

/** content 应已是 canonicalText。返回加头后的内容(仍满足 canonical:末尾恰一个换行)。 */
export function applyOwnedHeader(
  content: string,
  relPath: string,
  kitVersion: string,
): HeaderResult {
  if (!VERSION_RE.test(kitVersion)) {
    throw new Error(`kitVersion 含不允许的字符:${JSON.stringify(kitVersion)}`);
  }
  const syntax = headerSyntax(relPath);
  if (syntax === undefined) return { content, applied: false };
  const bom = content.startsWith(BOM) ? BOM : '';
  const text = bom ? content.slice(1) : content;
  const at = syntax === 'html' ? frontmatterEnd(text) : 0;
  const line = wrap(syntax, kitVersion);
  const rest = text.slice(at);
  const nl0 = rest.indexOf('\n');
  const firstLine = nl0 === -1 ? rest : rest.slice(0, nl0);
  if (OLD_HEADER_RE[syntax].test(firstLine)) {
    const nl = rest.indexOf('\n');
    const tail = nl === -1 ? '' : rest.slice(nl + 1);
    return { content: `${bom}${text.slice(0, at)}${line}\n${tail}`, applied: true };
  }
  return { content: `${bom}${text.slice(0, at)}${line}\n${rest}`, applied: true };
}

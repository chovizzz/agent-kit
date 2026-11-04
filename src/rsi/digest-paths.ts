/**
 * digest 摘录的路径中和与单条证据闸(docs/contracts.md §20.16,A4 订正 #8 / R20-16.11-a)。
 *
 * - {@link neutralizePaths}:纯函数。把文本里的受保护根目录(HOME、仓库根、状态目录、`KIT_TMP`)的绝对路径前缀换成固定占位。
 *   匹配按**路径段边界**:前一个字符不能是路径段字符,后一个字符必须是结尾、`/` 或非路径段字符;所以 `/h/ab2/x` 不会被当成 `/h/ab` 改写(仍留在文本里,由闸拦下)。
 *   多个根重叠(仓库在 HOME 下)时取最长的那个。
 * - {@link resolveLabeledRoots}:把「标签 + 路径」展开成含 realpath 的根集合(取不到 realpath 时只用原值)。
 * - {@link screenEvidence}:对一条已中和的摘录再过泄漏闸;命中 → 调用方丢弃这一条证据(整份输出的闸仍在 digest.ts 保留作兜底)。
 */
import { ExitCode } from '../contracts/exit-codes.js';
import {
  RSI_DIGEST_PATH_PLACEHOLDERS,
  RSI_EXCERPT_MARK_CLOSE,
  RSI_EXCERPT_MARK_OPEN,
  type RsiDigestPathLabel,
} from '../contracts/rsi.js';
import { getRealHome, pickProcessEnv } from '../io/paths.js';
import { realpath } from '../io/read-fs.js';
import { emitLines, jsonLines } from './output.js';

export interface LabeledRoot {
  label: RsiDigestPathLabel;
  path: string;
}

/** 路径段字符:字母、数字、`_ . - + @ % ~`(不含 `/`) */
const SEG_CHAR = /[\p{L}\p{N}_.\-+@%~]/u;

const stripTrailingSlashes = (p: string): string => p.replace(/\/+$/, '');

/** 在 `text` 里把每个根(按最长优先)的绝对路径前缀换成占位;长度 ≤ 1 的根(如 `/`)与空串忽略 */
export function neutralizePaths(text: string, roots: readonly LabeledRoot[]): string {
  const rs = roots
    .map((r) => ({ label: r.label, path: stripTrailingSlashes(r.path) }))
    .filter((r) => r.path.length > 1 && r.path.startsWith('/'))
    .sort((a, b) => b.path.length - a.path.length);
  if (rs.length === 0) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    let hit: (typeof rs)[number] | undefined;
    // 前一个字符(原文里的)不能是路径段字符
    const prev = i === 0 ? '' : (text[i - 1] as string);
    if (text[i] === '/' && !(prev !== '' && SEG_CHAR.test(prev))) {
      for (const r of rs) {
        if (!text.startsWith(r.path, i)) continue;
        const next = text[i + r.path.length];
        if (next === undefined || next === '/' || !SEG_CHAR.test(next)) {
          hit = r;
          break;
        }
      }
    }
    if (hit === undefined) {
      out += text[i] as string;
      i++;
    } else {
      out += RSI_DIGEST_PATH_PLACEHOLDERS[hit.label];
      i += hit.path.length;
    }
  }
  return out;
}

/** 受保护根的标签集合,含各自的 realpath;顺序无关(中和时按长度排序) */
export async function resolveLabeledRoots(
  env: Readonly<Record<string, string | undefined>> | undefined,
  o: { stateDir: string; repoRoots: readonly (string | undefined)[] },
): Promise<LabeledRoot[]> {
  const tmp = (env ?? pickProcessEnv(/^KIT_TMP$/))['KIT_TMP'];
  const raw: LabeledRoot[] = [
    { label: 'home' as const, path: getRealHome(env) },
    ...(typeof tmp === 'string' ? [{ label: 'kit_tmp' as const, path: tmp }] : []),
    { label: 'state' as const, path: o.stateDir },
    ...o.repoRoots.flatMap((p) =>
      typeof p === 'string' ? [{ label: 'repo' as const, path: p }] : [],
    ),
  ].filter((r) => r.path !== '');
  const out = new Map<string, LabeledRoot>();
  for (const r of raw) {
    out.set(`${r.label}\0${r.path}`, r);
    try {
      const rp = await realpath(r.path);
      out.set(`${r.label}\0${rp}`, { label: r.label, path: rp });
    } catch {
      // 取不到 realpath:原值已在集合里
    }
  }
  return [...out.values()];
}

/**
 * 单条证据闸:这条摘录(已中和、包上不可信标记、按它在输出里的 JSON 形态)是否仍会被路径泄漏闸拦下。`true` = 可用。
 * 判据与整份输出的闸同一个实现({@link emitLines}),只是范围缩到这一条。
 */
export function evidencePassesLeakGate(excerpt: string, forbidden: readonly string[]): boolean {
  const wrapped = `${RSI_EXCERPT_MARK_OPEN}${excerpt}${RSI_EXCERPT_MARK_CLOSE}`;
  const sink = { stdout: () => undefined, stderr: () => undefined };
  return emitLines(sink, jsonLines(JSON.stringify(wrapped)), forbidden) === ExitCode.OK;
}

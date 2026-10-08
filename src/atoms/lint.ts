import * as path from 'node:path';
import type { Atom, Layer } from '../contracts/atom.js';
import type { NeutralAgent } from '../contracts/agent-def.js';
import { sortDiagnostics, type Diagnostic } from '../contracts/diagnostics.js';
import type { Redactor } from '../contracts/redact.js';
import type { Skill } from '../contracts/skill.js';
import { exists, lstat, readDir, readText, realpath, stat } from '../io/read-fs.js';
import type { DirEntry } from '../io/read-fs.js';
import { parseAgent } from './agentdef.js';
import { parseCodeowners } from './codeowners.js';
import { addDays, daysBetween } from './dates.js';
import { findModelNames } from './model-names.js';
import { fileStem, parseAtom } from './parse.js';
import { loadSkill } from './skill.js';

/** 与 `KitConfigSchema.budget` 的默认值同值(lint 缺 kit.toml 时的回退;改默认值时两处一起改)。 */
export const DEFAULT_LINT_BUDGET = { enforce: 'warn', atom_max_bytes: 600 } as const;

export interface LintOptions {
  /** 脱敏第二遍扫描(B09 的 Redactor.pass2),由调用方注入;缺省则 evidence 不扫描并给 warn */
  redactor?: Pick<Redactor, 'pass2'>;
  budget?: { enforce: 'warn' | 'block'; atom_max_bytes: number };
}

export interface LintResult {
  diagnostics: Diagnostic[];
  atoms: Atom[];
  skills: Skill[];
  agents: NeutralAgent[];
  /** 脱敏扫描自身抛错的次数(fail-closed,调用方应退出 3) */
  scanErrors: number;
}

export const MAX_VOLATILE_REVIEW_DAYS = 30;
export const MAX_REVIEW_DAYS = 180;

const diag = (
  code: string,
  severity: 'error' | 'warn',
  p: string,
  message: string,
): Diagnostic => ({ code, severity, path: p, message });

const CORE_LAYER_DIRS: readonly string[] = ['org', 'team', 'personal'];

interface RuleFile {
  rel: string;
  /** 该位置允许的 layer;空数组 = 此位置不允许任何 layer */
  allowedLayers: readonly Layer[];
  /** 是否属于 core(rules/):要做具体模型名扫描 */
  core: boolean;
}

async function entriesOf(abs: string): Promise<DirEntry[]> {
  return (await exists(abs)) ? readDir(abs) : [];
}

/** `rules` / `skills` / `agents` / `.kit` 本身是符号链接 → error(否则整套规则可以从仓库外读入)。 */
async function rootDirSymlinks(root: string, out: Diagnostic[]): Promise<Set<string>> {
  const bad = new Set<string>();
  const roots: [string, string][] = [
    ['rules', 'ATOM_SYMLINK_NOT_ALLOWED'],
    ['.kit', 'ATOM_SYMLINK_NOT_ALLOWED'],
    ['.kit/rules', 'ATOM_SYMLINK_NOT_ALLOWED'],
    ['skills', 'SKILL_SYMLINK_NOT_ALLOWED'],
    ['agents', 'AGENT_SYMLINK_NOT_ALLOWED'],
  ];
  for (const [rel, code] of roots) {
    try {
      if ((await lstat(path.join(root, rel))).isSymbolicLink()) {
        bad.add(rel);
        out.push(diag(code, 'error', rel, `${rel} 本身不允许是符号链接`));
      }
    } catch {
      // 不存在:正常
    }
  }
  return bad;
}

const isHidden = (name: string): boolean => name.startsWith('.');

/** 枚举 `rules/<dir>/<id>.md`(深度恰为 2)与 `.kit/rules/**.md`。 */
async function collectRuleFiles(
  root: string,
  out: Diagnostic[],
  badRoots: ReadonlySet<string>,
): Promise<RuleFile[]> {
  const files: RuleFile[] = [];
  for (const top of badRoots.has('rules') ? [] : await entriesOf(path.join(root, 'rules'))) {
    if (isHidden(top.name)) continue;
    const topRel = `rules/${top.name}`;
    if (top.isSymbolicLink) {
      out.push(diag('ATOM_SYMLINK_NOT_ALLOWED', 'error', topRel, '规则目录内不允许符号链接'));
      continue;
    }
    if (!top.isDirectory) {
      out.push(
        diag(
          'ATOM_PATH_LAYOUT',
          'error',
          topRel,
          '规则文件必须放在 rules/<目录>/<id>.md,不能直接放在 rules/ 下',
        ),
      );
      continue;
    }
    const allowed: readonly Layer[] = CORE_LAYER_DIRS.includes(top.name)
      ? [top.name as Layer]
      : top.name === 'project'
        ? []
        : ['org', 'team'];
    for (const f of await readDir(path.join(root, topRel))) {
      if (isHidden(f.name)) continue;
      const rel = `${topRel}/${f.name}`;
      if (f.isSymbolicLink) {
        out.push(diag('ATOM_SYMLINK_NOT_ALLOWED', 'error', rel, '规则目录内不允许符号链接'));
      } else if (f.isDirectory) {
        out.push(diag('ATOM_PATH_LAYOUT', 'error', rel, '规则目录不允许再嵌套子目录(深度恰为 2)'));
      } else if (f.name.endsWith('.md')) {
        files.push({ rel, allowedLayers: allowed, core: true });
      } else {
        out.push(diag('ATOM_UNKNOWN_FILE', 'warn', rel, '规则目录内的非 .md 文件被忽略'));
      }
    }
  }
  const walkProject = async (rel: string): Promise<void> => {
    for (const f of await entriesOf(path.join(root, rel))) {
      if (isHidden(f.name)) continue;
      const r = `${rel}/${f.name}`;
      if (f.isSymbolicLink) {
        out.push(diag('ATOM_SYMLINK_NOT_ALLOWED', 'error', r, '规则目录内不允许符号链接'));
      } else if (f.isDirectory) {
        await walkProject(r);
      } else if (f.name.endsWith('.md')) {
        files.push({ rel: r, allowedLayers: ['project'], core: false });
      } else {
        out.push(diag('ATOM_UNKNOWN_FILE', 'warn', r, '规则目录内的非 .md 文件被忽略'));
      }
    }
  };
  if (!badRoots.has('.kit') && !badRoots.has('.kit/rules')) await walkProject('.kit/rules');
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** verifier.ref:相对仓库根、不含 `..`、解析 symlink 后仍在仓库内;以 `/` 结尾必须是目录。 */
async function checkVerifierRef(
  root: string,
  realRoot: string,
  ref: string,
  at: string,
): Promise<Diagnostic | undefined> {
  const segments = ref.split('/');
  if (path.isAbsolute(ref) || ref.includes('\\') || segments.includes('..')) {
    return diag(
      'ATOM_VERIFIER_REF_INVALID',
      'error',
      at,
      'verifier.ref 必须是仓库内的相对路径(不含 `..`)',
    );
  }
  const target = path.join(root, ref);
  try {
    const real = await realpath(target);
    const rel = path.relative(realRoot, real);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return diag(
        'ATOM_VERIFIER_REF_INVALID',
        'error',
        at,
        'verifier.ref 解析后落在仓库之外,或指向仓库根本身',
      );
    }
    const st = await stat(target);
    if (ref.endsWith('/') && !st.isDirectory()) {
      return diag(
        'ATOM_VERIFIER_REF_MISSING',
        'error',
        at,
        'verifier.ref 以 `/` 结尾,但指向的不是目录',
      );
    }
    return undefined;
  } catch {
    return diag('ATOM_VERIFIER_REF_MISSING', 'error', at, 'verifier.ref 指向的路径不存在');
  }
}

async function loadCodeowners(root: string): Promise<Set<string> | undefined> {
  for (const rel of ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']) {
    if (await exists(path.join(root, rel)))
      return parseCodeowners(await readText(path.join(root, rel)));
  }
  return undefined;
}

/** 原子文本(frontmatter 去掉 evidence,加正文)里的具体模型名;evidence 是对历史的引用,不在此限。 */
function atomModelNames(atom: Atom): string[] {
  const rest: Record<string, unknown> = { ...atom.fm };
  delete rest['evidence'];
  return findModelNames(JSON.stringify(rest) + '\n' + JSON.stringify(atom.body));
}

export async function lintRepo(root: string, opts: LintOptions = {}): Promise<LintResult> {
  const budget = opts.budget ?? DEFAULT_LINT_BUDGET;
  const out: Diagnostic[] = [];
  const atoms: Atom[] = [];
  const realRoot = await realpath(root);
  const badRoots = await rootDirSymlinks(root, out);
  const ruleFiles = await collectRuleFiles(root, out, badRoots);
  let scanErrors = 0;
  let evidenceUnscanned = false;

  const codeowners = ruleFiles.length > 0 ? await loadCodeowners(root) : undefined;
  if (ruleFiles.length > 0 && codeowners === undefined) {
    out.push(
      diag(
        'ATOM_CODEOWNERS_MISSING',
        'error',
        'CODEOWNERS',
        '找不到 CODEOWNERS(CODEOWNERS / .github/CODEOWNERS / docs/CODEOWNERS),无法核对 owner',
      ),
    );
  }

  const seenIds = new Map<string, string>();
  const parsed: { file: RuleFile; atom: Atom }[] = [];

  for (const file of ruleFiles) {
    let text: string;
    try {
      text = await readText(path.join(root, file.rel));
    } catch (e) {
      out.push(diag('IO_READ_FAILED', 'error', file.rel, `无法读取:${(e as Error).message}`));
      continue;
    }
    const res = parseAtom(text, file.rel);
    out.push(...res.diagnostics);
    if (res.atom === undefined) {
      if (file.core) {
        for (const n of findModelNames(text)) {
          out.push(
            diag('ATOM_MODEL_NAME_IN_CORE', 'error', file.rel, `core 内不得出现具体模型名:${n}`),
          );
        }
      }
      continue;
    }
    parsed.push({ file, atom: res.atom });
  }

  // 引用目标:所有规则文件的文件名 ∪ 成功解析的 id(被引用方自己 schema 不合法时不连坐)
  const knownIds = new Set<string>([
    ...ruleFiles.map((f) => fileStem(f.rel)),
    ...parsed.map((x) => x.atom.fm.id),
  ]);

  for (const { file, atom } of parsed) {
    const { fm } = atom;
    const p = file.rel;
    atoms.push(atom);

    // 1. id 与文件名;全局唯一
    if (fm.id !== fileStem(p)) {
      out.push(
        diag(
          'ATOM_ID_FILENAME_MISMATCH',
          'error',
          `${p}#/id`,
          `id「${fm.id}」必须等于文件名「${fileStem(p)}」`,
        ),
      );
    }
    const first = seenIds.get(fm.id);
    if (first !== undefined) {
      out.push(diag('ATOM_ID_DUPLICATE', 'error', `${p}#/id`, `id「${fm.id}」已被 ${first} 使用`));
    } else {
      seenIds.set(fm.id, p);
    }

    // 2. layer 与目录
    if (!file.allowedLayers.includes(fm.layer)) {
      const want =
        file.allowedLayers.length === 0
          ? '(此目录不允许任何 layer)'
          : file.allowedLayers.join(' | ');
      out.push(
        diag(
          'ATOM_LAYER_DIR_MISMATCH',
          'error',
          `${p}#/layer`,
          `layer「${fm.layer}」与所在目录不一致,应为 ${want}`,
        ),
      );
    }

    // 3. 日期(UTC 整数天)
    const gap = daysBetween(fm.created, fm.review_by);
    if (gap < 0) {
      out.push(
        diag(
          'ATOM_REVIEW_BEFORE_CREATED',
          'error',
          `${p}#/review_by`,
          'review_by 不得早于 created',
        ),
      );
    }
    if (fm.volatility === 'volatile' && gap > MAX_VOLATILE_REVIEW_DAYS) {
      out.push(
        diag(
          'ATOM_VOLATILE_REVIEW_TOO_FAR',
          'error',
          `${p}#/review_by`,
          `volatile 原子的 review_by 不得晚于 created+${MAX_VOLATILE_REVIEW_DAYS} 天(${addDays(fm.created, MAX_VOLATILE_REVIEW_DAYS)})`,
        ),
      );
    }
    if (gap > MAX_REVIEW_DAYS) {
      out.push(
        diag(
          'ATOM_REVIEW_TOO_FAR',
          'error',
          `${p}#/review_by`,
          `review_by 不得晚于 created+${MAX_REVIEW_DAYS} 天(${addDays(fm.created, MAX_REVIEW_DAYS)})`,
        ),
      );
    }

    // 4. evidence 脱敏第二遍
    if (opts.redactor === undefined) {
      evidenceUnscanned = true;
    } else {
      for (const [i, ev] of fm.evidence.entries()) {
        const at = `${p}#/evidence/${i}/excerpt`;
        try {
          const r = opts.redactor.pass2(ev.excerpt);
          if (!r.clean) {
            const rules = [...new Set(r.hits.map((h) => `${h.type}/${h.rule}`))].join(',');
            out.push(
              diag(
                'ATOM_EVIDENCE_REDACTION_RESIDUAL',
                'error',
                at,
                `证据摘录未通过脱敏复扫(命中类型:${rules || '未知'});命中文本不在诊断中展示`,
              ),
            );
          }
        } catch (e) {
          scanErrors += 1;
          out.push(
            diag(
              'ATOM_EVIDENCE_SCAN_ERROR',
              'error',
              at,
              `脱敏复扫抛错,按 fail-closed 处理:${(e as Error).name}`,
            ),
          );
        }
      }
    }

    // 5. verifier.ref
    if (fm.verifier.ref !== undefined) {
      const d = await checkVerifierRef(root, realRoot, fm.verifier.ref, `${p}#/verifier/ref`);
      if (d) out.push(d);
    }

    // 6. owner
    if (codeowners !== undefined && !codeowners.has(fm.owner.toLowerCase())) {
      out.push(
        diag(
          'ATOM_OWNER_NOT_IN_CODEOWNERS',
          'error',
          `${p}#/owner`,
          `owner「${fm.owner}」不在 CODEOWNERS 中`,
        ),
      );
    }

    // 7. 引用:supersedes / merged_from 必须存在;四个引用字段都不得指向自己
    for (const field of ['supersedes', 'merged_from'] as const) {
      for (const [i, id] of (fm[field] ?? []).entries()) {
        if (id !== fm.id && !knownIds.has(id)) {
          out.push(
            diag(
              'ATOM_REF_ID_NOT_FOUND',
              'error',
              `${p}#/${field}/${i}`,
              `${field} 引用的原子「${id}」不存在`,
            ),
          );
        }
      }
    }
    for (const field of ['supersedes', 'merged_from', 'overrides', 'disables'] as const) {
      for (const [i, id] of (fm[field] ?? []).entries()) {
        if (id === fm.id) {
          out.push(diag('ATOM_REF_SELF', 'error', `${p}#/${field}/${i}`, `${field} 不得指向自己`));
        }
      }
    }

    // 8. 正文体积(严重度跟 budget.enforce:P0 真实仓库 warn)
    if (atom.bodyBytes > budget.atom_max_bytes) {
      out.push(
        diag(
          'ATOM_BODY_TOO_LARGE',
          budget.enforce === 'block' ? 'error' : 'warn',
          p,
          `正文 ${atom.bodyBytes} 字节,超过单原子上限 ${budget.atom_max_bytes}`,
        ),
      );
    }

    // 9. core 内具体模型名
    if (file.core) {
      for (const n of atomModelNames(atom)) {
        out.push(diag('ATOM_MODEL_NAME_IN_CORE', 'error', p, `core 内不得出现具体模型名:${n}`));
      }
    }
  }

  if (evidenceUnscanned) {
    out.push(
      diag(
        'ATOM_EVIDENCE_NOT_SCANNED',
        'warn',
        'rules',
        '未注入 Redactor,证据摘录没有做脱敏复扫(B19 接线真实 Redactor 后应消失)',
      ),
    );
  }

  // 技能
  const skills: Skill[] = [];
  for (const e of badRoots.has('skills') ? [] : await entriesOf(path.join(root, 'skills'))) {
    if (isHidden(e.name)) continue;
    const rel = `skills/${e.name}`;
    if (e.isSymbolicLink) {
      out.push(diag('SKILL_SYMLINK_NOT_ALLOWED', 'error', rel, 'skills/ 下不允许符号链接'));
    } else if (!e.isDirectory) {
      out.push(diag('SKILL_UNKNOWN_FILE', 'warn', rel, 'skills/ 下只应有技能目录,该文件被忽略'));
    } else {
      const r = await loadSkill(root, e.name);
      out.push(...r.diagnostics);
      if (r.skill) skills.push(r.skill);
    }
  }

  // 子代理
  const agents: NeutralAgent[] = [];
  for (const e of badRoots.has('agents') ? [] : await entriesOf(path.join(root, 'agents'))) {
    if (isHidden(e.name)) continue;
    const rel = `agents/${e.name}`;
    if (e.isSymbolicLink) {
      out.push(diag('AGENT_SYMLINK_NOT_ALLOWED', 'error', rel, 'agents/ 下不允许符号链接'));
      continue;
    }
    if (!e.isFile || !e.name.endsWith('.yaml')) {
      out.push(
        diag('AGENT_UNKNOWN_FILE', 'warn', rel, 'agents/ 下只应有 <name>.yaml,该条目被忽略'),
      );
      continue;
    }
    let text: string;
    try {
      text = await readText(path.join(root, rel));
    } catch (err) {
      out.push(diag('IO_READ_FAILED', 'error', rel, `无法读取:${(err as Error).message}`));
      continue;
    }
    for (const n of findModelNames(text)) {
      out.push(
        diag(
          'AGENT_MODEL_NAME_IN_CORE',
          'error',
          rel,
          `core 内不得出现具体模型名:${n}(只写 model_tier 档位)`,
        ),
      );
    }
    const r = parseAgent(text, rel, e.name.slice(0, -'.yaml'.length));
    out.push(...r.diagnostics);
    if (r.agent) agents.push(r.agent);
  }

  return {
    diagnostics: sortDiagnostics(out),
    atoms: atoms.sort((a, b) => (a.sourcePath < b.sourcePath ? -1 : 1)),
    skills,
    agents,
    scanErrors,
  };
}

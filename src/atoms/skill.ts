import { createHash } from 'node:crypto';
import { SkillFrontmatterSchema, type Skill } from '../contracts/skill.js';
import { zodIssuesToDiagnostics, type Diagnostic } from '../contracts/diagnostics.js';
import { lstat, readBytes, readDir, readText } from '../io/read-fs.js';
import { parseRestrictedYaml, splitFrontmatter } from './frontmatter.js';

const err = (code: string, path: string, message: string): Diagnostic => ({
  code,
  severity: 'error',
  path,
  message,
});

export interface SkillLoad {
  skill: Skill | undefined;
  diagnostics: Diagnostic[];
}

interface FileEntry {
  relPath: string;
  bytes: number;
  sha256: string;
}

async function listFiles(
  absDir: string,
  prefix: string,
  repoRel: string,
  out: FileEntry[],
  diagnostics: Diagnostic[],
): Promise<void> {
  for (const e of await readDir(absDir)) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
    const abs = `${absDir}/${e.name}`;
    if (e.isSymbolicLink) {
      diagnostics.push(
        err('SKILL_SYMLINK_NOT_ALLOWED', `${repoRel}/${rel}`, '技能目录内不允许符号链接'),
      );
    } else if (e.isDirectory) {
      await listFiles(abs, rel, repoRel, out, diagnostics);
    } else if (e.isFile) {
      const buf = await readBytes(abs);
      out.push({
        relPath: rel,
        bytes: buf.byteLength,
        sha256: createHash('sha256').update(buf).digest('hex'),
      });
    }
  }
}

/**
 * 加载并检查 `skills/<name>/`。
 * - SKILL.md 必须存在,frontmatter 过 SkillFrontmatterSchema(name 的 kebab 格式、description ≤1024 由 schema 管,
 *   失败为 SCHEMA_INVALID);`name` 必须等于目录名(SKILL_NAME_DIR_MISMATCH)。
 * - `files` 递归列出全部文件,按 relPath 字节序(readDir 已按码元序排好,递归保持字典序)。
 */
export async function loadSkill(repoRoot: string, name: string): Promise<SkillLoad> {
  const sourceDir = `skills/${name}`;
  const skillMd = `${sourceDir}/SKILL.md`;
  const diagnostics: Diagnostic[] = [];
  const absDir = `${repoRoot}/${sourceDir}`;

  let text: string | undefined;
  try {
    const st = await lstat(`${repoRoot}/${skillMd}`);
    if (st.isSymbolicLink()) {
      diagnostics.push(err('SKILL_SYMLINK_NOT_ALLOWED', skillMd, 'SKILL.md 不允许是符号链接'));
      return { skill: undefined, diagnostics };
    }
    text = await readText(`${repoRoot}/${skillMd}`);
  } catch {
    diagnostics.push(err('SKILL_FILE_MISSING', skillMd, `技能目录缺少 SKILL.md`));
    return { skill: undefined, diagnostics };
  }

  const { yamlText, body } = splitFrontmatter(text);
  if (yamlText === undefined) {
    diagnostics.push(
      err(
        'SKILL_FRONTMATTER_SYNTAX',
        skillMd,
        'SKILL.md 必须以 `---` 开头的 YAML frontmatter 起始',
      ),
    );
    return { skill: undefined, diagnostics };
  }
  const y = parseRestrictedYaml(yamlText, skillMd, 'SKILL_FRONTMATTER_SYNTAX');
  if (!y.ok) return { skill: undefined, diagnostics: [...diagnostics, ...y.diagnostics] };

  const fmRes = SkillFrontmatterSchema.safeParse(y.value);
  if (!fmRes.success) {
    diagnostics.push(...zodIssuesToDiagnostics(fmRes.error, skillMd));
    return { skill: undefined, diagnostics };
  }
  if (fmRes.data.name !== name) {
    diagnostics.push(
      err(
        'SKILL_NAME_DIR_MISMATCH',
        `${skillMd}#/name`,
        `name「${fmRes.data.name}」必须等于目录名「${name}」`,
      ),
    );
  }

  const files: FileEntry[] = [];
  await listFiles(absDir, '', sourceDir, files, diagnostics);
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return {
    skill: { fm: fmRes.data, body, sourceDir, files },
    diagnostics,
  };
}

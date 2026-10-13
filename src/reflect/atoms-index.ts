/**
 * 只读索引:已有原子(rules/)、暂存区里的原子(.state/reflect/<run>/rules/)与已占用的提案编号。
 * 全部经 read-fs;给 runReflect 的 deps 用(库本身不自己去读仓库)。
 */
import * as path from 'node:path';
import { parseAtom } from '../atoms/parse.js';
import type { IoContext } from '../io/paths.js';
import { exists, readDir, readText } from '../io/read-fs.js';
import type { ExistingAtomInfo } from './types.js';

/** 有效的暂存运行:目录、非保留名、非临时目录,并且 report.json 已写出(半成品目录不算)。 */
async function validRun(
  root: string,
  run: { name: string; isDirectory: boolean },
): Promise<boolean> {
  if (!run.isDirectory || run.name.startsWith('.') || run.name.toLowerCase() === 'cwd')
    return false;
  return exists(path.join(root, run.name, 'report.json'));
}

async function atomsIn(dir: string, rel: (name: string) => string): Promise<ExistingAtomInfo[]> {
  const out: ExistingAtomInfo[] = [];
  if (!(await exists(dir))) return out;
  for (const f of await readDir(dir)) {
    if (!f.isFile || !f.name.endsWith('.md')) continue;
    const res = parseAtom(await readText(path.join(dir, f.name)), rel(f.name));
    if (res.atom === undefined) continue;
    const { fm, body } = res.atom;
    out.push({
      id: fm.id,
      title: fm.title,
      layer: fm.layer,
      status: fm.status,
      signatureType: fm.signature?.type,
      signaturePattern: fm.signature?.pattern,
      do: body.do,
      why: body.why,
    });
  }
  return out;
}

export async function loadExistingAtoms(io: IoContext): Promise<ExistingAtomInfo[]> {
  const out: ExistingAtomInfo[] = [];
  const root = path.join(io.repoRoot, 'rules');
  if (!(await exists(root))) return out;
  for (const d of await readDir(root)) {
    if (!d.isDirectory || d.name.startsWith('.')) continue;
    out.push(...(await atomsIn(path.join(root, d.name), (n) => `rules/${d.name}/${n}`)));
  }
  return out;
}

/** 暂存区(所有历史运行)里的原子;跳过 llm-exec 的固定 cwd 目录 `cwd`。 */
export async function loadStagedAtoms(io: IoContext): Promise<ExistingAtomInfo[]> {
  const out: ExistingAtomInfo[] = [];
  const root = path.join(io.stateDir, 'reflect');
  if (!(await exists(root))) return out;
  for (const run of await readDir(root)) {
    if (!(await validRun(root, run))) continue;
    const rules = path.join(root, run.name, 'rules');
    if (!(await exists(rules))) continue;
    for (const d of await readDir(rules)) {
      if (!d.isDirectory) continue;
      out.push(...(await atomsIn(path.join(rules, d.name), (n) => `rules/${d.name}/${n}`)));
    }
  }
  return out;
}

/** 已占用的提案编号:仓库 proposals/ 与全部暂存区的 proposals/。 */
export async function loadUsedProposalIds(io: IoContext): Promise<Set<string>> {
  const ids = new Set<string>();
  const scan = async (dir: string): Promise<void> => {
    if (!(await exists(dir))) return;
    for (const f of await readDir(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2}-\d{3})\.yaml$/.exec(f.name);
      if (f.isFile && m?.[1] !== undefined) ids.add(m[1]);
    }
  };
  await scan(path.join(io.repoRoot, 'proposals'));
  const root = path.join(io.stateDir, 'reflect');
  if (await exists(root)) {
    for (const run of await readDir(root)) {
      if (await validRun(root, run)) await scan(path.join(root, run.name, 'proposals'));
    }
  }
  return ids;
}

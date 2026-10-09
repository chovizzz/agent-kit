import { renderManagedBlock } from '../../src/render/managed-block.js';
import type { Layer } from '../../src/contracts/atom.js';
import type { OutFile, RenderInput, RenderOutput } from '../../src/contracts/render.js';
import { layerBody, pickAtoms, skippedByStatus } from './atoms.js';
import type { PickedAtom } from './atoms.js';
import { BLOCK_ID, PERSONAL_SKIP, PROBE_NOT_RUN, keyOf, newReport } from './common.js';

const HOME_SHADOW =
  '~/.codex/AGENTS.override.md 存在且非空时 Codex 该层只读它,本文件被整体遮蔽(A §2.2-1;P0 不检查真实文件)';
const PROJECT_SHADOW =
  '项目各级 AGENTS.override.md、project_doc_fallback_filenames 设置可使本文件被遮蔽或改序(A §2.2-1;P0 不检查真实文件)';

function managedFile(
  target: 'home' | 'project',
  relPath: string,
  layers: readonly Layer[],
  atoms: readonly PickedAtom[],
): OutFile {
  const bodies = layers.map((l) =>
    layerBody(
      l,
      atoms.filter((a) => a.layer === l),
    ),
  );
  const nonEmpty = bodies.filter((b) => b.body !== '');
  const atomBytes: Record<string, number> = {};
  for (const b of nonEmpty) Object.assign(atomBytes, b.atomBytes);
  return {
    agent: 'codex',
    target,
    relPath,
    content: renderManagedBlock(BLOCK_ID, nonEmpty.map((b) => b.body).join('\n\n')),
    mode: 'managed-block',
    atomIds: Object.keys(atomBytes),
    atomBytes,
    confidence: 'documented',
  };
}

export function renderRules(input: RenderInput): RenderOutput {
  const atoms = pickAtoms(input);
  const report = newReport();
  if (input.resolved.some((r) => r.layer === 'personal')) {
    report.skippedLayers.push({ ...PERSONAL_SKIP });
  }
  for (const x of skippedByStatus(input)) {
    report.dropped.push({ field: 'status', reason: `原子 ${x.id}:${x.reason}` });
  }

  // 全局:~/.codex/AGENTS.md。P0 按"文件为空"状态渲染,不读真实文件。
  const home = managedFile('home', '.codex/AGENTS.md', ['org', 'team'], atoms);
  const project = managedFile('project', 'AGENTS.md', ['project'], atoms);
  // 没有可渲染的原子时不产出文件(清理已撤掉的规则是 P2 sync 按锁文件做的事)。
  const files = [home, project].filter((f) => f.atomIds.length > 0);

  for (const f of files) {
    const k = keyOf(f);
    const layers = f === home ? ['org', 'team'] : ['project'];
    for (const a of atoms.filter((x) => layers.includes(x.layer) && x.paths !== undefined)) {
      report.dropped.push({
        field: 'paths',
        file: k,
        reason: `原子 ${a.id}:Codex 的 AGENTS.md 没有路径作用域机制(只按目录链加载),paths 无法保留,已降级为正文前缀「仅在处理 <glob> 时适用」`,
      });
    }
    report.shadowChecks.push(`${k}: ${f === home ? HOME_SHADOW : PROJECT_SHADOW}`);
    if (f !== home)
      report.shadowChecks.push(
        `${k}: 整条项目链合并后达到 project_doc_max_bytes(默认 32 KiB)即停止加入,更深层的 AGENTS.md 会被静默丢弃(预算检查须计入整条链)`,
      );
  }
  if (files.length > 0) {
    report.sideEffects.push(
      'codex: ~/.codex/AGENTS.md 在 P0 按"文件为空"状态渲染(不读真实文件);P2 写入前须由 sync 读取真实文件,非空时只改托管块',
    );
    report.pendingProbes.push({
      id: 'P-Q3',
      description: 'Codex:~/.codex/AGENTS.md 与项目链的拼接顺序;实际截断点',
    });
  }
  if (report.dropped.length > 0) {
    report.sideEffects.push('codex: paths 原子降级为正文前缀,这是靠模型遵守的文字约束,不是机制');
    report.pendingProbes.push({
      id: 'codex-paths-prefix-effect',
      description: 'paths 降级成正文前缀后,Codex 是否真的只在处理匹配路径时才遵守该条(未验证)',
    });
  }
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files, report };
}

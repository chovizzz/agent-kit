import { renderManagedBlock } from '../../src/render/managed-block.js';
import type { Layer } from '../../src/contracts/atom.js';
import type { OutFile, RenderInput, RenderOutput } from '../../src/contracts/render.js';
import { layerBody, pickAtoms, skippedByStatus } from './atoms.js';
import type { PickedAtom } from './atoms.js';
import {
  BLOCK_ID,
  NO_ENFORCEMENT_NOTE,
  PERSONAL_SKIP,
  PROBE_NOT_RUN,
  keyOf,
  newReport,
} from './common.js';

/** 全局落点(Pi docs/configuration.md:`<agent-dir>/AGENTS.md`,agent-dir 默认 ~/.pi/agent)。 */
export const HOME_REL_PATH = '.pi/agent/AGENTS.md';
export const PROJECT_REL_PATH = 'AGENTS.md';

/** 遮蔽文件清单(设计 §4.6)。测试按全文断言,防止漏项。P0 只列出,不检查真实文件。 */
export const HOME_SHADOWS: readonly string[] = [
  '~/.pi/agent/AGENTS.override.md 存在时替换同目录的 AGENTS.md / CLAUDE.md,本文件被遮蔽(documented:Pi docs/configuration.md;P0 不检查真实文件)',
  '~/.pi/agent/SYSTEM.md 替换 Pi 的默认系统提示;它对上下文文件(含本文件)是否仍注入的影响文档未说明(assumed;P0 不检查真实文件)',
  '启动参数 --system-prompt 与 SYSTEM.md 同族,同样替换默认系统提示;对上下文文件(含本文件)是否仍注入的影响文档未说明(assumed;P0 不检查)',
  '设置 PI_CODING_AGENT_DIR 会改变 agent-dir,~/.pi/agent/AGENTS.md 就不再是全局文件(documented;P0 不检查环境)',
  '启动参数 --no-context-files / -nc 会关闭 AGENTS.md 与 CLAUDE.md 的发现与加载(documented:Pi docs/cli.md;P0 不检查)',
];
export const PROJECT_SHADOWS: readonly string[] = [
  '项目各级 AGENTS.override.md 替换同目录的 AGENTS.md / CLAUDE.md,本文件被遮蔽(documented:Pi docs/configuration.md;P0 不检查真实文件)',
  '启动参数 --no-context-files / -nc 会关闭 AGENTS.md 与 CLAUDE.md 的发现与加载(documented:Pi docs/cli.md;P0 不检查)',
];

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
    agent: 'pi',
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

  const home = managedFile('home', HOME_REL_PATH, ['org', 'team'], atoms);
  const project = managedFile('project', PROJECT_REL_PATH, ['project'], atoms);
  // 没有可渲染的原子时不产出文件(清理已撤掉的规则是 P2 sync 按锁文件做的事)。
  const files = [home, project].filter((f) => f.atomIds.length > 0);

  for (const f of files) {
    const k = keyOf(f);
    const isHome = f === home;
    const layers = isHome ? ['org', 'team'] : ['project'];
    for (const a of atoms.filter((x) => layers.includes(x.layer) && x.paths !== undefined)) {
      report.dropped.push({
        field: 'paths',
        file: k,
        reason: `原子 ${a.id}:Pi 的 AGENTS.md 没有路径作用域机制(按目录链加载),paths 无法保留,已降级为正文前缀「仅在处理 <glob> 时适用」`,
      });
    }
    for (const s of isHome ? HOME_SHADOWS : PROJECT_SHADOWS) report.shadowChecks.push(`${k}: ${s}`);
    if (isHome) {
      report.sideEffects.push(
        `${k}: P0 按"文件不存在"状态渲染(不读真实文件,本机调研时 ~/.pi/agent/ 下没有 AGENTS.md);新建后 Pi 第一次读到全局规则,属行为变化;P2 写入前须由 sync 读取真实文件,非空时只改托管块`,
      );
    } else {
      report.sideEffects.push(
        `${k}: 与 codex / kimi / opencode 共用仓库根 AGENTS.md(同一托管块 id),P2 须合并成一个块而不是叠加;Pi 会遍历 cwd 的所有上级目录,~/AGENTS.md、~/workspace/AGENTS.md 等他方文件会随本块一起注入(调研 A §5.1 实测,P0 只列出,不读也不改真实文件)`,
      );
    }
    report.sideEffects.push(`${k}: ${NO_ENFORCEMENT_NOTE}`);
  }
  if (files.length > 0) {
    report.pendingProbes.push({
      id: 'P-Q4',
      description:
        'Pi:~/.pi/agent/AGENTS.md 是否加载;向上遍历的终点;体积上限(文档未给上限,预算 limit_source=assumed)',
    });
  }
  if (report.dropped.some((d) => d.field === 'paths')) {
    report.sideEffects.push('pi: paths 原子降级为正文前缀,这是靠模型遵守的文字约束,不是机制');
    report.pendingProbes.push({
      id: 'pi-paths-prefix-effect',
      description: 'paths 降级成正文前缀后,Pi 是否真的只在处理匹配路径时才遵守该条(未验证)',
    });
  }
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files, report };
}

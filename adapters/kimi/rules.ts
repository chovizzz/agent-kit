import { renderManagedBlock } from '../../src/render/managed-block.js';
import type { Layer } from '../../src/contracts/atom.js';
import type { OutFile, RenderInput, RenderOutput } from '../../src/contracts/render.js';
import { layerBody, pickAtoms, skippedByStatus } from './atoms.js';
import type { PickedAtom } from './atoms.js';
import { BLOCK_ID, PERSONAL_SKIP, PROBE_NOT_RUN, keyOf, newReport } from './common.js';

/**
 * 全局落点 `$KIMI_CODE_HOME/AGENTS.md`,默认 ~/.kimi-code/AGENTS.md(documented:configuration/data-locations.md、
 * customization/agents.md "Instruction Files")。**不**渲染 ~/.agents/AGENTS.md:Kimi 两处都读,写两处会重复加载(设计 §4.2)。
 */
export const HOME_REL_PATH = '.kimi-code/AGENTS.md';
export const PROJECT_REL_PATH = 'AGENTS.md';

/** 遮蔽文件清单(设计 §4.6)。测试按全文断言,防止漏项。P0 只列出,不检查真实文件。 */
export const HOME_SHADOWS: readonly string[] = [
  '$KIMI_CODE_HOME/SYSTEM.md(默认 ~/.kimi-code/SYSTEM.md)非空时整体替换主 agent 的默认系统提示(documented);它只有含 ${agents_md} 变量才会注入 AGENTS.md 内容——这一推论文档未直接说明(assumed;P0 不检查真实文件)',
  '带 override: true 的 agent 文件(如项目 agent.md)会整体替换主 agent 的系统提示,AGENTS.md 是否仍注入取决于其正文是否引用 ${agents_md} / ${base_prompt}(推论,assumed;P0 不检查真实文件)',
  '设置 KIMI_CODE_HOME 会移动数据根,~/.kimi-code/AGENTS.md 就不再是全局文件(documented;P0 不检查环境)',
];
export const PROJECT_SHADOWS: readonly string[] = [
  '项目根 AGENTS.md 与 .kimi-code/AGENTS.md 并存时的加载与顺序文档未说明(assumed;P0 不检查真实文件)',
  'Kimi 只向上找到 git 根(调研 A §5.2 本机 wire.jsonl 实测 agentsMdPaths;非 git 目录或 git 根之上的 AGENTS.md 不会加载,P0 不检查)',
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
    agent: 'kimi',
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
        reason: `原子 ${a.id}:Kimi 的 AGENTS.md 没有路径作用域机制(文档未提供),paths 无法保留,已降级为正文前缀「仅在处理 <glob> 时适用」`,
      });
    }
    for (const s of isHome ? HOME_SHADOWS : PROJECT_SHADOWS) report.shadowChecks.push(`${k}: ${s}`);
    if (isHome) {
      report.sideEffects.push(
        `${k}: P0 按"文件为空"状态渲染(不读真实文件);本机现有的 ~/.kimi-code/AGENTS.md 是 Claude CLAUDE.md 的一次性陈旧拷贝(调研 A §2.4-10⑦),P2 写入将替换它,须人批;不渲染 ~/.agents/AGENTS.md(Kimi 两处都读,写两处会重复加载)`,
      );
    } else {
      report.sideEffects.push(
        `${k}: 与 codex / pi / opencode 共用仓库根 AGENTS.md(同一托管块 id),P2 须合并成一个块而不是叠加;Kimi 不读 CLAUDE.md(调研 A §5.2)`,
      );
    }
  }
  if (files.length > 0) {
    report.pendingProbes.push({
      id: 'P-Q5',
      description:
        'Kimi:AGENTS.md 截断上限数值(文档只提到截断警告,预算 limit_source=assumed);~/.kimi-code/agents/ 是否加载;未信任目录下 kimi -p 的行为(2.1.0 更新日志:项目本地配置仅在工作区被信任后生效,可能影响项目级 AGENTS.md / agents / skills 的加载)',
    });
  }
  if (report.dropped.some((d) => d.field === 'paths')) {
    report.sideEffects.push('kimi: paths 原子降级为正文前缀,这是靠模型遵守的文字约束,不是机制');
    report.pendingProbes.push({
      id: 'kimi-paths-prefix-effect',
      description: 'paths 降级成正文前缀后,Kimi 是否真的只在处理匹配路径时才遵守该条(未验证)',
    });
  }
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files, report };
}

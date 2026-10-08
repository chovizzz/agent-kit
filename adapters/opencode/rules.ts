import { renderManagedBlock } from '../../src/render/managed-block.js';
import type { Layer } from '../../src/contracts/atom.js';
import type { OutFile, RenderInput, RenderOutput } from '../../src/contracts/render.js';
import { layerBody, pickAtoms, skippedByStatus } from './atoms.js';
import type { PickedAtom } from './atoms.js';
import { BLOCK_ID, PERSONAL_SKIP, PROBE_NOT_RUN, keyOf, newReport } from './common.js';

/** 全局落点(OpenCode 文档 rules:`~/.config/opencode/AGENTS.md`)。 */
export const HOME_REL_PATH = '.config/opencode/AGENTS.md';
export const PROJECT_REL_PATH = 'AGENTS.md';

/**
 * 置信度:文档写了这些路径,但文档是无版本号的线上快照,本机 1.1.19 又远落后于它,
 * 所以对"当前要用的版本"这些行为没有依据 ⇒ 整体 assumed(拿不准的不当事实)。
 */
export const RULES_CONFIDENCE = 'assumed' as const;

/** 遮蔽文件清单(设计 §4.6)。测试按全文断言,防止漏项。P0 只列出,不检查真实文件。 */
export const HOME_SHADOWS: readonly string[] = [
  'OPENCODE_DISABLE_CLAUDE_CODE / _PROMPT / _SKILLS 环境变量用于关闭 Claude 兼容层(~/.claude/CLAUDE.md、.claude/skills)(documented 于线上文档);推论:它们不影响本文件,且设了 _PROMPT 后"不再回退读 ~/.claude/CLAUDE.md"这一副作用就不存在(推论,assumed;P0 不检查环境)',
  '环境变量 OPENCODE_CONFIG_DIR 指定自定义配置目录(documented 于线上文档);它是否移动 ~/.config/opencode/AGENTS.md 这个全局落点文档未说明(assumed;P0 不检查环境)',
  '托管配置 / MDM(macOS:/Library/Application Support/opencode/)优先级最高,可改写配置;它对 AGENTS.md 加载的影响文档未说明(assumed;P0 不检查真实文件)',
];
export const PROJECT_SHADOWS: readonly string[] = [
  '"每类第一个匹配胜出":向上遍历时若 cwd 链上更近处另有 AGENTS.md,"first" 是否指离 cwd 最近的那个文档未明说,仓库根的本文件可能被更近的同名文件取代(assumed;P0 不检查真实文件)',
  '项目里存在 AGENTS.md 时 CLAUDE.md 不再被读(documented 于线上文档);opencode.json 的 instructions 字段是合并而非遮蔽(documented;P0 不检查真实文件)',
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
    agent: 'opencode',
    target,
    relPath,
    content: renderManagedBlock(BLOCK_ID, nonEmpty.map((b) => b.body).join('\n\n')),
    mode: 'managed-block',
    atomIds: Object.keys(atomBytes),
    atomBytes,
    confidence: RULES_CONFIDENCE,
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
        reason: `原子 ${a.id}:OpenCode 的 AGENTS.md 没有路径作用域机制(文档未提供),paths 无法保留,已降级为正文前缀「仅在处理 <glob> 时适用」`,
      });
    }
    for (const s of isHome ? HOME_SHADOWS : PROJECT_SHADOWS) report.shadowChecks.push(`${k}: ${s}`);
    if (isHome) {
      report.sideEffects.push(
        `${k}: 一旦存在,OpenCode 不再回退读 ~/.claude/CLAUDE.md(文档 Precedence:~/.config/opencode/AGENTS.md 优先于 ~/.claude/CLAUDE.md;本机 1.1.19 的行为未验证);用户目前靠回退读到的 Claude 全局规则会因此消失。反过来,本文件不存在时 OpenCode 会读 ~/.claude/CLAUDE.md;按设计 §4.2 Claude 渲染器不写该文件(规则渲染到 ~/.claude/rules/),所以与本文件之间没有双重注入。P0 按"文件不存在"状态渲染(不读真实文件),P2 写入须人批`,
      );
    } else {
      report.sideEffects.push(
        `${k}: 与 codex / pi / kimi 共用仓库根 AGENTS.md(同一托管块 id),P2 须合并成一个块而不是叠加;仓库里已有 AGENTS.md 时 OpenCode 不读 CLAUDE.md`,
      );
    }
  }
  if (files.length > 0) {
    report.pendingProbes.push({
      id: 'P-Q6',
      description:
        'OpenCode 1.1.19:~/.config/opencode/AGENTS.md 是否加载、是否真的使 ~/.claude/CLAUDE.md 不再被读;与线上文档的版本差异;体积上限(预算 limit_source=assumed)',
    });
  }
  if (report.dropped.some((d) => d.field === 'paths')) {
    report.sideEffects.push('opencode: paths 原子降级为正文前缀,这是靠模型遵守的文字约束,不是机制');
    report.pendingProbes.push({
      id: 'opencode-paths-prefix-effect',
      description: 'paths 降级成正文前缀后,OpenCode 是否真的只在处理匹配路径时才遵守该条(未验证)',
    });
  }
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files, report };
}

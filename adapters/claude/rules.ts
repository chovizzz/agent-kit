import { stringify as yamlStringify } from 'yaml';
import { renderManagedBlock } from '../../src/render/managed-block.js';
import type { OutFile, RenderInput, RenderOutput } from '../../src/contracts/render.js';
import { layerBody, pickAtoms, sectionOf, skippedByStatus } from './atoms.js';
import type { PickedAtom } from './atoms.js';
import { BLOCK_ID, PERSONAL_SKIP, PROBE_NOT_RUN, RULES_DIR, keyOf, newReport } from './common.js';

/** P-Q1 条件标记:有它的文件不计预算,也不得当作事实(plan-P0 Q-N6)。 */
export const CONDITIONAL_PQ1 = 'P-Q1';

const SETTING_SHADOW =
  '设置 Project instructions 取非默认值(如 managed-only)时本文件可被整体跳过(A §2.1-1b、§2.1-10;P0 不检查真实设置)';
const CLAUDE_MD_SHADOW =
  '目录链上存在 CLAUDE.md / .claude/CLAUDE.md / CLAUDE.local.md 时 Claude 不读 AGENTS.md(A §2.1-1b;P0 不检查真实文件)';

/** 带 paths frontmatter 的规则文件:frontmatter 必须是文件第一行(核心会把独占头放在它之后)。 */
function pathsRuleContent(a: PickedAtom): { content: string; bytes: number } {
  const fm = yamlStringify({ paths: [...(a.paths ?? [])] }, { lineWidth: 0 });
  const s = sectionOf(a);
  return { content: `---\n${fm}---\n\n${s.text}\n`, bytes: s.bytes };
}

function ownedFile(
  target: 'home' | 'project',
  relPath: string,
  content: string,
  atomBytes: Record<string, number>,
  confidence: OutFile['confidence'],
  conditional?: string,
): OutFile {
  return {
    agent: 'claude',
    target,
    relPath,
    content,
    mode: 'owned',
    atomIds: Object.keys(atomBytes),
    atomBytes,
    confidence,
    ...(conditional !== undefined ? { conditional } : {}),
  };
}

export function renderRules(input: RenderInput): RenderOutput {
  const atoms = pickAtoms(input);
  const files: OutFile[] = [];
  const report = newReport();
  if (input.resolved.some((r) => r.layer === 'personal')) {
    report.skippedLayers.push({ ...PERSONAL_SKIP });
  }
  for (const x of skippedByStatus(input)) {
    report.dropped.push({ field: 'status', reason: `原子 ${x.id}:${x.reason}` });
  }

  // 1) 用户级(org / team):~/.claude/rules/agent-kit/。
  //    子目录在用户级是否被加载,官方文档只对项目级明说"递归发现"→ assumed,待 P-Q1。
  for (const layer of ['org', 'team'] as const) {
    const plain = atoms.filter((a) => a.layer === layer && a.paths === undefined);
    const lb = layerBody(layer, plain);
    if (plain.length > 0) {
      files.push(
        ownedFile('home', `${RULES_DIR}/${layer}.md`, `${lb.body}\n`, lb.atomBytes, 'assumed'),
      );
    }
    for (const a of atoms.filter((x) => x.layer === layer && x.paths !== undefined)) {
      const p = pathsRuleContent(a);
      files.push(
        ownedFile(
          'home',
          `${RULES_DIR}/paths/${a.id}.md`,
          p.content,
          { [a.id]: p.bytes },
          'assumed',
        ),
      );
    }
  }

  // 2) 项目级:AGENTS.md 托管块(不含 paths 原子:它们进带 paths 的规则文件,否则会丢掉作用域)。
  const projectAtoms = atoms.filter((a) => a.layer === 'project');
  const projectPlain = projectAtoms.filter((a) => a.paths === undefined);
  const pb = layerBody('project', projectPlain);
  // 没有可渲染的原子时不产出文件(清理已撤掉的规则是 P2 sync 按锁文件做的事)。
  if (projectPlain.length > 0) {
    files.push({
      agent: 'claude',
      target: 'project',
      relPath: 'AGENTS.md',
      content: renderManagedBlock(BLOCK_ID, pb.body),
      mode: 'managed-block',
      atomIds: pb.atomIds,
      atomBytes: pb.atomBytes,
      confidence: 'documented',
    });
  }
  // 同内容的项目规则文件:conditional=P-Q1(不计预算,待探针验证子目录加载与重复加载)。
  if (projectPlain.length > 0) {
    files.push(
      ownedFile(
        'project',
        `${RULES_DIR}/project.md`,
        `${pb.body}\n`,
        pb.atomBytes,
        'documented',
        CONDITIONAL_PQ1,
      ),
    );
  }
  for (const a of projectAtoms.filter((x) => x.paths !== undefined)) {
    const p = pathsRuleContent(a);
    files.push(
      ownedFile(
        'project',
        `${RULES_DIR}/paths/${a.id}.md`,
        p.content,
        { [a.id]: p.bytes },
        'documented',
        CONDITIONAL_PQ1,
      ),
    );
  }

  // 3) 报告
  for (const f of files) {
    const k = keyOf(f);
    report.shadowChecks.push(`${k}: ${SETTING_SHADOW}`);
    if (f.relPath === 'AGENTS.md') report.shadowChecks.push(`${k}: ${CLAUDE_MD_SHADOW}`);
  }
  const has = (pred: (f: OutFile) => boolean): boolean => files.some(pred);
  report.sideEffects.push(
    'claude: 不改 ~/.claude/CLAUDE.md,不生成 personal.md(personal 层 P0 渲染为空,预算里 personal 份额为 0)',
  );
  if (has((f) => f.relPath === 'AGENTS.md')) {
    report.sideEffects.push(
      'claude/project/AGENTS.md: 仓库已有 CLAUDE.md 而其中没有 @AGENTS.md 时 Claude 读不到该文件,建议由仓库所有者在 CLAUDE.md 加 @AGENTS.md(本渲染器不改 CLAUDE.md)',
      'claude/project: AGENTS.md 托管块与 .claude/rules/agent-kit/project.md 内容相同;两者并存时是否重复加载未实测(P-Q1),预算按原子 id 去重只计一份',
    );
    report.pendingProbes.push({
      id: 'P-Q2',
      description:
        '仓库没有 CLAUDE.md 时 Claude 是否原生读 AGENTS.md(文档称 ≥2.1.277,本机 2.1.294 未实测)',
    });
  }
  if (has((f) => f.relPath.startsWith('.claude/rules/'))) {
    report.sideEffects.push(
      'claude: 带 paths 的原子只渲染进带 paths frontmatter 的独立规则文件,不进 AGENTS.md(进了就丢掉路径作用域)',
    );
    report.pendingProbes.push({
      id: 'P-Q1',
      description:
        '用户级 ~/.claude/rules/agent-kit/ 子目录是否加载(官方文档只对项目级明说递归);与 AGENTS.md 并存时相同内容是否被去重(文档规定两者都加载,未知的是去重)',
    });
  }
  report.pendingProbes.push({ ...PROBE_NOT_RUN });
  return { files, report };
}
